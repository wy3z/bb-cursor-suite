import { createHash } from "node:crypto";
import type { SandboxAvailability, SandboxBackend, SandboxHandle, SandboxProgress } from "@wy3z/bb-suite/machine-backend/server";
import { formatUsd, sandboxNameForKey, usageMonth } from "@wy3z/bb-suite/machine-backend/server";
import { BoatApiError, LIVE_STATES, MAX_TTL_SECONDS, READY_STATES, isNotFound, type BoatApi, type BoatLimits, type BoatSandbox } from "./api.ts";
import { execInSandbox } from "./exec.ts";
import type { BoatSettings } from "./settings.ts";

export const PROVIDER_ID = "boat-sandbox";
export const DISPLAY_NAME = "Boat Sandbox";
export const LABEL_MANAGED = "app.getbb.boat-sandbox";
export const LABEL_NAME = "app.getbb.boat-sandbox.name";
export const TRIAL_TTL_SECONDS = 7_200;
export const LISTED_STATES = "init,provisioning,provisioned,cloning,ready,idle,running,archiving,archived,error";
const DAY_MS = 86_400_000;
const CACHE_MS = 60_000;

export interface BoatBackendOptions {
  api: BoatApi;
  settings: () => Promise<BoatSettings>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  log?: { info(message: string): void; warn(message: string): void };
}

export interface VendorSpend {
  month: string;
  usd: number;
  deletedUsd: number | null;
  sandboxes: number;
  running: number;
}

export interface KeepResult {
  name: string;
  sandboxId: string;
  outcome: "saved" | "current" | "failed";
  message?: string;
}

export interface BoatBackend extends SandboxBackend {
  limits(signal?: AbortSignal): Promise<BoatLimits>;
  spend(signal?: AbortSignal): Promise<VendorSpend>;
  spendRefusal(): Promise<string | null>;
  sandbox(id: string, signal?: AbortSignal): Promise<BoatSandbox | null>;
  keepStopped(): Promise<KeepResult[]>;
}

export function boatSandboxName(key: string): string {
  return sandboxNameForKey(key, "bb-boat");
}

export function ttlSecondsFor(ttlMs: number): number | null {
  const seconds = Math.round(ttlMs / 1000);
  return seconds > MAX_TTL_SECONDS ? null : Math.max(60, seconds);
}

export function ownedBy(sandbox: Pick<BoatSandbox, "labels">, name: string): boolean {
  return sandbox.labels[LABEL_MANAGED] === "1" && sandbox.labels[LABEL_NAME] === name;
}

function handleOf(sandbox: BoatSandbox): SandboxHandle {
  const expires = sandbox.archiveAfter === null ? null : Date.parse(sandbox.archiveAfter);
  return {
    id: sandbox.id,
    running: LIVE_STATES.has(sandbox.state),
    expiresAt: expires === null || Number.isNaN(expires) ? null : expires,
    meta: sandbox.type === null ? {} : { size: sandbox.type },
  };
}

function idempotencyKey(name: string, body: unknown): string {
  return `${name}-${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBoatBackend(options: BoatBackendOptions): BoatBackend {
  const { api } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 2_000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 6 * 60_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 10 * 60_000;
  let limitsCache: { at: number; value: BoatLimits } | null = null;
  let spendCache: { at: number; value: VendorSpend } | null = null;

  async function withTtlCap<T>(ttlSeconds: number | null, run: (ttl: number | null) => Promise<T>): Promise<T> {
    try {
      return await run(ttlSeconds);
    } catch (error) {
      if (!(error instanceof BoatApiError) || error.code !== "trial_auto_stop_required") throw error;
      if (ttlSeconds !== null && ttlSeconds <= TRIAL_TTL_SECONDS) throw error;
      options.log?.info(`${DISPLAY_NAME}: boat.dev caps auto-stop on this plan; using ${TRIAL_TTL_SECONDS / 3600} hours`);
      return run(TRIAL_TTL_SECONDS);
    }
  }

  function createBody(settings: BoatSettings, name: string, ttlSeconds: number | null, from?: string): Record<string, unknown> {
    return {
      name,
      type: settings.size,
      ttlSeconds,
      labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: name },
      monitoring: false,
      ...(settings.environment === "" ? { noEnv: true } : { environment: settings.environment }),
      ...(from === undefined ? {} : { from }),
    };
  }

  async function waitFor(
    id: string,
    signal: AbortSignal,
    report: SandboxProgress,
    done: (sandbox: BoatSandbox) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<BoatSandbox | null> {
    const deadline = now() + timeoutMs;
    let lastState = "";
    let lastStopError: string | null = null;
    for (;;) {
      signal.throwIfAborted();
      let sandbox: BoatSandbox;
      try {
        sandbox = await api.getSandbox(id, signal);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      if (sandbox.state !== lastState) {
        lastState = sandbox.state;
        report.log(`boat sandbox ${id} is ${sandbox.state}`);
      }
      if (sandbox.stop?.status === "failing" && sandbox.stop.error !== lastStopError) {
        lastStopError = sandbox.stop.error;
        report.log(`boat.dev is retrying the stop of ${id}: ${sandbox.stop.error ?? "unknown error"}`);
      }
      if (done(sandbox)) return sandbox;
      if (sandbox.state === "cancelled" || (sandbox.state === "error" && what === "ready")) {
        throw new Error(`${DISPLAY_NAME}: boat sandbox ${id} is ${sandbox.state}${sandbox.error ? ` (${sandbox.error})` : ""}.`);
      }
      if (now() >= deadline) {
        throw new Error(`${DISPLAY_NAME}: boat sandbox ${id} is still ${sandbox.state} after ${Math.round(timeoutMs / 60_000)} minutes waiting for ${what}.`);
      }
      await sleep(pollMs);
    }
  }

  async function waitReady(id: string, signal: AbortSignal, report: SandboxProgress): Promise<BoatSandbox> {
    const ready = await waitFor(id, signal, report, (sandbox) => READY_STATES.has(sandbox.state), readyTimeoutMs, "ready");
    if (ready === null) throw new Error(`${DISPLAY_NAME}: boat sandbox ${id} disappeared while starting.`);
    return ready;
  }

  async function settings(): Promise<BoatSettings> {
    return options.settings();
  }

  async function limits(signal?: AbortSignal): Promise<BoatLimits> {
    if (limitsCache !== null && now() - limitsCache.at < CACHE_MS) return limitsCache.value;
    const value = await api.limits(signal);
    limitsCache = { at: now(), value };
    return value;
  }

  async function spend(signal?: AbortSignal): Promise<VendorSpend> {
    if (spendCache !== null && now() - spendCache.at < CACHE_MS && spendCache.value.month === usageMonth(now())) return spendCache.value;
    const { sandboxes, deletedCostUsd } = await api.listSandboxes(
      [
        ["label", `${LABEL_MANAGED}=1`],
        ["include", "cost,deletedCost"],
      ],
      signal,
    );
    const owned = sandboxes.filter((sandbox) => sandbox.labels[LABEL_MANAGED] === "1");
    const live = owned.reduce((sum, sandbox) => sum + (sandbox.costUsd ?? 0), 0);
    const value: VendorSpend = {
      month: usageMonth(now()),
      usd: live + (deletedCostUsd ?? 0),
      deletedUsd: deletedCostUsd,
      sandboxes: owned.length,
      running: owned.filter((sandbox) => LIVE_STATES.has(sandbox.state)).length,
    };
    spendCache = { at: now(), value };
    return value;
  }

  async function spendRefusal(): Promise<string | null> {
    const current = await settings();
    if (current.monthlyCapUsd === 0 || current.apiKey.trim() === "") return null;
    let reading: VendorSpend;
    try {
      reading = await spend(AbortSignal.timeout(15_000));
    } catch (error) {
      options.log?.warn(`${DISPLAY_NAME}: couldn't read this month's spend from boat.dev: ${message(error)}`);
      return null;
    }
    if (reading.usd < current.monthlyCapUsd) return null;
    return `${DISPLAY_NAME}: the monthly cap of ${formatUsd(current.monthlyCapUsd)} is reached (${formatUsd(reading.usd)} of boat.dev machine time in ${reading.month} at list price). Raise the cap in the plugin settings or wait for next month.`;
  }

  async function listByName(name: string, signal: AbortSignal): Promise<SandboxHandle[]> {
    const { sandboxes } = await api.listSandboxes(
      [
        ["label", `${LABEL_NAME}=${name}`],
        ["state", LISTED_STATES],
      ],
      signal,
    );
    return sandboxes.filter((sandbox) => sandbox.state !== "cancelled" && ownedBy(sandbox, name)).map(handleOf);
  }

  async function createFrom(settings_: BoatSettings, name: string, ttlMs: number, signal: AbortSignal, report: SandboxProgress, from?: string) {
    const created = await withTtlCap(ttlSecondsFor(ttlMs), (ttl) => {
      const body = createBody(settings_, name, ttl, from);
      return api.createSandbox(body, idempotencyKey(name, body), signal);
    });
    report.log(`boat sandbox ${created.id} (${settings_.size}${from === undefined ? "" : `, from saved snapshot ${from}`})`);
    return waitReady(created.id, signal, report);
  }

  async function restoreFromKeep(name: string, staleId: string | null, why: string, ttlMs: number, signal: AbortSignal, report: SandboxProgress) {
    const saved = await api.savedSnapshot(name, signal);
    if (saved === null || saved.status !== "ready") {
      throw new Error(
        `${DISPLAY_NAME}: ${why}, and there is no saved snapshot named ${name} to restore from. Remove the machine to clean up.`,
      );
    }
    report.step(`Restoring the ${DISPLAY_NAME} from its saved snapshot…`);
    const ready = await createFrom(await settings(), name, ttlMs, signal, report, name);
    if (staleId !== null) await api.deleteSandbox(staleId, signal).catch((error: unknown) => report.log(`Couldn't delete the expired sandbox ${staleId}: ${message(error)}`));
    return handleOf(ready);
  }

  async function dropKeep(name: string, signal: AbortSignal, report: SandboxProgress) {
    try {
      await api.deleteSavedSnapshot(name, signal);
      report.log(`Removed the saved snapshot ${name}; the sandbox is running again`);
    } catch (error) {
      if (!isNotFound(error)) report.log(`Couldn't remove the saved snapshot ${name}: ${message(error)}`);
    }
  }

  return {
    id: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    description: "A boat.dev cloud VM (Ubuntu, root, Docker, systemd, Chrome) that runs BB's daemon. Billed per second by boat.dev.",
    environmentDescription: "Create a project checkout in a new boat.dev cloud VM.",
    icon: "./icon.svg",
    ephemeral: true,
    nameFor: boatSandboxName,

    limits,
    spend,
    spendRefusal,

    async sandbox(id, signal) {
      try {
        return await api.getSandbox(id, signal);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async availability(): Promise<SandboxAvailability> {
      const current = await settings();
      if (current.apiKey.trim() === "") {
        return { status: "setup-required", message: `${DISPLAY_NAME}: add a boat.dev API key under Settings → Plugins → ${DISPLAY_NAME}.` };
      }
      let reading: BoatLimits | null = null;
      try {
        reading = await limits(AbortSignal.timeout(10_000));
      } catch (error) {
        if (error instanceof BoatApiError && error.status === 401) {
          return { status: "setup-required", message: `${DISPLAY_NAME}: boat.dev rejected the API key. Create a new one and save it in the plugin settings.` };
        }
        if (!(error instanceof BoatApiError && error.status === 403)) {
          return { status: "setup-required", message: `${DISPLAY_NAME}: couldn't reach boat.dev (${message(error)}).` };
        }
      }
      if (reading !== null) {
        if (reading.checkoutRequired) {
          return { status: "setup-required", message: `${DISPLAY_NAME}: the boat.dev account has no plan yet. Start the trial or a plan on boat.dev first.` };
        }
        if (!reading.canStart) {
          return { status: "unavailable", message: `${DISPLAY_NAME}: boat.dev won't start sandboxes right now${reading.blockedReason ? ` (${reading.blockedReason})` : ""}.` };
        }
        const size = reading.machineTypes.find((entry) => entry.type === current.size);
        if (size !== undefined && !size.available) {
          return {
            status: "setup-required",
            message: `${DISPLAY_NAME}: the ${current.size} size isn't available on this boat.dev plan${size.reason ? ` (${size.reason})` : ""}. Choose another size in the plugin settings.`,
          };
        }
      }
      const refusal = await spendRefusal();
      return refusal === null ? { status: "available" } : { status: "unavailable", message: refusal };
    },

    async validate() {
      const refusal = await spendRefusal();
      return refusal === null ? { action: "accept" } : { action: "refuse", message: refusal };
    },

    async create({ name, ttlMs, signal, report }) {
      const refusal = await spendRefusal();
      if (refusal !== null) throw new Error(refusal);
      const ready = await createFrom(await settings(), name, ttlMs, signal, report);
      return handleOf(ready);
    },

    async exec(sandboxId, request) {
      return execInSandbox({ api, sleep }, sandboxId, request);
    },

    async snapshot() {
      return { snapshotId: null };
    },

    async stop({ sandboxId, signal, report }) {
      try {
        await api.stopSandbox(sandboxId, signal);
      } catch (error) {
        if (isNotFound(error)) return { sandboxId: null };
        throw error;
      }
      const stopped = await waitFor(sandboxId, signal, report, (sandbox) => sandbox.state === "archived", stopTimeoutMs, "the stop to finish");
      return { sandboxId: stopped === null ? null : sandboxId };
    },

    async resume({ name, sandboxId, ttlMs, signal, report }) {
      const refusal = await spendRefusal();
      if (refusal !== null) throw new Error(refusal);
      const current = await settings();
      let id = sandboxId;
      if (id === null) id = (await listByName(name, signal))[0]?.id ?? null;
      if (id === null) return restoreFromKeep(name, null, `no boat sandbox named ${name} is left`, ttlMs, signal, report);
      let sandbox: BoatSandbox;
      try {
        sandbox = await api.getSandbox(id, signal);
      } catch (error) {
        if (isNotFound(error)) return restoreFromKeep(name, null, `boat sandbox ${id} is gone`, ttlMs, signal, report);
        throw error;
      }
      if (!ownedBy(sandbox, name)) {
        throw new Error(`${DISPLAY_NAME}: boat sandbox ${id} isn't labelled as ${name}; refusing to resume a sandbox this plugin didn't create.`);
      }
      if (sandbox.dataExpiredAt !== null) {
        return restoreFromKeep(name, id, `boat.dev cleaned up the disk of ${id}`, ttlMs, signal, report);
      }
      if (!LIVE_STATES.has(sandbox.state) || sandbox.state === "archiving") {
        for (let attempt = 1; ; attempt += 1) {
          try {
            await withTtlCap(ttlSecondsFor(ttlMs), (ttl) =>
              api.resumeSandbox(id, { ttlSeconds: ttl, ...(sandbox.type !== null && sandbox.type !== current.size ? { type: current.size } : {}) }, signal),
            );
            break;
          } catch (error) {
            if (error instanceof BoatApiError && error.code === "snapshot_data_expired") {
              return restoreFromKeep(name, id, `boat.dev cleaned up the disk of ${id}`, ttlMs, signal, report);
            }
            if (error instanceof BoatApiError && error.code === "sandbox_stopping" && attempt < 6) {
              await sleep(error.retryAfterMs ?? 5_000);
              continue;
            }
            throw error;
          }
        }
      } else {
        await withTtlCap(ttlSecondsFor(ttlMs), (ttl) => api.updateSandbox(id, { ttlSeconds: ttl }, signal));
      }
      const ready = await waitReady(id, signal, report);
      if (current.keepStoppedDays > 0) await dropKeep(name, signal, report);
      return handleOf(ready);
    },

    async remove({ name, sandboxIds, snapshotIds, signal, report }) {
      const listed = (await listByName(name, signal)).map((handle) => handle.id);
      const ids = [...new Set([...sandboxIds, ...listed])];
      for (const id of ids) {
        try {
          await api.deleteSandbox(id, signal);
          report.log(`Deleted boat sandbox ${id} and its snapshots`);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      for (const snapshotId of snapshotIds) {
        try {
          await api.deleteSnapshot(snapshotId, signal);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      try {
        await api.deleteSavedSnapshot(name, signal);
        report.log(`Deleted the saved snapshot ${name}`);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },

    listByName,

    async extendTtl({ sandboxId, ttlMs, signal }) {
      try {
        const updated = await withTtlCap(ttlSecondsFor(ttlMs), (ttl) => api.updateSandbox(sandboxId, { ttlSeconds: ttl }, signal));
        return { expiresAt: handleOf(updated).expiresAt };
      } catch (error) {
        if (isNotFound(error)) return { expiresAt: null };
        throw error;
      }
    },

    async keepStopped() {
      const current = await settings();
      if (current.keepStoppedDays === 0 || current.apiKey.trim() === "") return [];
      const signal = AbortSignal.timeout(5 * 60_000);
      const { sandboxes } = await api.listSandboxes(
        [
          ["label", `${LABEL_MANAGED}=1`],
          ["state", "archived"],
          ["stoppedBefore", new Date(now() - current.keepStoppedDays * DAY_MS).toISOString()],
          ["dataExpired", "false"],
        ],
        signal,
      );
      const results: KeepResult[] = [];
      for (const sandbox of sandboxes) {
        const name = sandbox.labels[LABEL_NAME];
        if (name === undefined || !ownedBy(sandbox, name) || sandbox.state !== "archived") continue;
        try {
          const saved = await api.savedSnapshot(name, signal);
          const stoppedAt = sandbox.stoppedAt === null ? 0 : Date.parse(sandbox.stoppedAt);
          const savedAt = saved?.createdAt ? Date.parse(saved.createdAt) : 0;
          if (saved !== null && saved.status !== "failed" && saved.sourceSandboxId === sandbox.id && savedAt >= stoppedAt) {
            results.push({ name, sandboxId: sandbox.id, outcome: "current" });
            continue;
          }
          await api.saveSnapshot(sandbox.id, name, signal);
          options.log?.info(`${DISPLAY_NAME}: saved ${name} as a saved snapshot so it survives boat.dev's 14-day cleanup`);
          results.push({ name, sandboxId: sandbox.id, outcome: "saved" });
        } catch (error) {
          options.log?.warn(`${DISPLAY_NAME}: couldn't keep ${name} past boat.dev's 14-day cleanup: ${message(error)}`);
          results.push({ name, sandboxId: sandbox.id, outcome: "failed", message: message(error) });
        }
      }
      return results;
    },
  };
}
