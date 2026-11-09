import type { BbPluginApi, PluginBbSdk } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import {
  AGENT_CONTROL,
  DESKTOP_LEASE_MS,
  DESKTOP_MAX_HOLD_MS,
  DESKTOP_ROUTES,
  browserRequestRefusal,
  type DesktopControl,
  type DesktopRoute,
  type DesktopState,
  type DesktopStatus,
  type DesktopView,
} from "./desktop";

export * from "./desktop";

export interface DesktopHost {
  hostId: string;
  machineProviderId: string;
  phase: string;
}

export interface DesktopProbe {
  state: DesktopState;
  message: string | null;
}

export interface DesktopVendor {
  providerId: string;
  displayName: string;
  interactive: boolean;
  probe(host: DesktopHost, signal: AbortSignal): Promise<DesktopProbe>;
  view(host: DesktopHost, request: { theme: "light" | "dark" | null; signal: AbortSignal }): Promise<DesktopView>;
  pauseAgent?(host: DesktopHost, request: { leaseMs: number; signal: AbortSignal }): Promise<boolean>;
  resumeAgent?(host: DesktopHost, signal: AbortSignal): Promise<void>;
}

export interface DesktopPluginApi {
  readonly log: Pick<BbPluginApi["log"], "warn">;
  readonly http: Pick<BbPluginApi["http"], "route">;
  readonly background: Pick<BbPluginApi["background"], "service">;
  readonly sdk: {
    readonly threads: Pick<PluginBbSdk["threads"], "get" | "send">;
    readonly environments: Pick<PluginBbSdk["environments"], "get">;
    readonly hosts: Pick<PluginBbSdk["hosts"], "get">;
  };
}

export interface DesktopOptions {
  now?: () => number;
  leaseMs?: number;
  maxHoldMs?: number;
  probeCacheMs?: number;
  vendorTimeoutMs?: number;
  redact?: (text: string) => string;
  onActivity?: (hostId: string) => void | Promise<void>;
}

export interface DesktopRegistration {
  control(hostId: string, clientId?: string | null): DesktopControl;
  releaseAll(): Promise<void>;
}

interface Lease {
  host: DesktopHost;
  threadId: string;
  clientId: string;
  since: number;
  expiresAt: number;
  agentPaused: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export class DesktopRefusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DesktopRefusal";
    this.status = status;
  }
}

function refuse(status: number, message: string): never {
  throw new DesktopRefusal(status, message);
}

export const AGENT_NOTE =
  "The user took control of this machine's desktop and has now handed it back. The screen may have changed while they had it, and any computer action you started meanwhile ran only after they released control. Take a fresh screenshot before your next computer action.";

interface RouteContext {
  req: { header(name: string): string | undefined; json(): Promise<unknown> };
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function registerDesktopProvider(bb: DesktopPluginApi, vendor: DesktopVendor, options: DesktopOptions = {}): DesktopRegistration {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? DESKTOP_LEASE_MS;
  const maxHoldMs = options.maxHoldMs ?? DESKTOP_MAX_HOLD_MS;
  const probeCacheMs = options.probeCacheMs ?? 15_000;
  const vendorTimeoutMs = options.vendorTimeoutMs ?? 60_000;
  const redact = options.redact ?? ((text: string) => text);
  const leases = new Map<string, Lease>();
  const probes = new Map<string, { at: number; value: DesktopProbe }>();
  const queues = new Map<string, Promise<unknown>>();
  const pauses = vendor.pauseAgent !== undefined && vendor.resumeAgent !== undefined;

  const text = (error: unknown) => redact(error instanceof Error ? error.message : String(error));

  function active(hostId: string): void {
    if (options.onActivity === undefined) return;
    void Promise.resolve()
      .then(() => options.onActivity?.(hostId))
      .catch(() => undefined);
  }

  function serial<T>(hostId: string, run: () => Promise<T>): Promise<T> {
    const previous = queues.get(hostId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const settled = next.catch(() => undefined);
    queues.set(hostId, settled);
    void settled.then(() => {
      if (queues.get(hostId) === settled) queues.delete(hostId);
    });
    return next;
  }

  function controlOf(hostId: string, clientId: string | null = null): DesktopControl {
    const lease = leases.get(hostId);
    if (lease === undefined) return AGENT_CONTROL;
    return {
      holder: "user",
      mine: clientId !== null && lease.clientId === clientId,
      agentPaused: lease.agentPaused,
      since: lease.since,
      expiresAt: lease.expiresAt,
    };
  }

  function drop(hostId: string): Lease | undefined {
    const lease = leases.get(hostId);
    if (lease === undefined) return undefined;
    clearTimeout(lease.timer);
    leases.delete(hostId);
    return lease;
  }

  async function tellAgent(lease: Lease): Promise<void> {
    if (!lease.agentPaused) return;
    try {
      const thread = await bb.sdk.threads.get({ threadId: lease.threadId });
      if (thread.runtime.displayStatus !== "active") return;
      await bb.sdk.threads.send({
        threadId: lease.threadId,
        mode: "steer",
        input: [{ type: "text", text: AGENT_NOTE, mentions: [], visibility: "agent-only" }],
      });
    } catch {
      return;
    }
  }

  async function resume(host: DesktopHost, why: string): Promise<void> {
    if (vendor.resumeAgent === undefined) return;
    try {
      await vendor.resumeAgent(host, AbortSignal.timeout(vendorTimeoutMs));
    } catch (error) {
      bb.log.warn(`${vendor.displayName}: couldn't hand the desktop of ${host.hostId} back to the agent (${why}): ${text(error)}`);
      throw error;
    }
  }

  async function end(lease: Lease, why: string): Promise<void> {
    await resume(lease.host, why);
    void tellAgent(lease);
  }

  function arm(host: DesktopHost, threadId: string, clientId: string, since: number, agentPaused: boolean): DesktopControl {
    drop(host.hostId);
    const expiresAt = Math.min(now() + leaseMs, since + maxHoldMs);
    const timer = setTimeout(
      () => {
        void serial(host.hostId, async () => {
          const lease = leases.get(host.hostId);
          if (lease === undefined || lease.expiresAt > now()) return;
          drop(host.hostId);
          await end(lease, "the control lease ran out").catch(() => undefined);
        });
      },
      Math.max(0, expiresAt - now()) + 250,
    );
    const handle = timer as { unref?: () => void };
    handle.unref?.();
    leases.set(host.hostId, { host, threadId, clientId, since, expiresAt, agentPaused, timer });
    return controlOf(host.hostId, clientId);
  }

  async function hostOf(threadId: string): Promise<DesktopHost> {
    let environmentId: string | null;
    try {
      environmentId = (await bb.sdk.threads.get({ threadId })).environmentId;
    } catch {
      refuse(404, `${vendor.displayName}: thread ${threadId} wasn't found.`);
    }
    if (environmentId === null) refuse(404, `${vendor.displayName}: thread ${threadId} has no machine.`);
    let host: Awaited<ReturnType<PluginBbSdk["hosts"]["get"]>>;
    try {
      const environment = await bb.sdk.environments.get({ environmentId });
      host = await bb.sdk.hosts.get({ hostId: environment.hostId });
    } catch {
      refuse(404, `${vendor.displayName}: the machine of thread ${threadId} wasn't found.`);
    }
    if (host.machineProviderId !== vendor.providerId) {
      refuse(403, `${vendor.displayName}: thread ${threadId} doesn't run on a ${vendor.displayName} machine.`);
    }
    return { hostId: host.id, machineProviderId: host.machineProviderId, phase: host.lifecycle.phase };
  }

  async function probe(host: DesktopHost): Promise<DesktopProbe> {
    const cached = probes.get(host.hostId);
    if (cached !== undefined && now() - cached.at < probeCacheMs) return cached.value;
    try {
      const value = await vendor.probe(host, AbortSignal.timeout(20_000));
      probes.set(host.hostId, { at: now(), value });
      return value;
    } catch (error) {
      return { state: "unavailable", message: `${vendor.displayName}: couldn't read the desktop (${text(error)}).` };
    }
  }

  async function forget(hostId: string): Promise<void> {
    await serial(hostId, async () => {
      drop(hostId);
    });
  }

  async function status(threadId: string, clientId: string): Promise<DesktopStatus> {
    const host = await hostOf(threadId);
    const base = { providerId: vendor.providerId, interactive: vendor.interactive, pausesAgent: pauses };
    if (host.phase !== "active") {
      probes.delete(host.hostId);
      await forget(host.hostId);
      const starting = host.phase === "resuming";
      return {
        ...base,
        state: starting ? "starting" : "stopped",
        message: starting ? "The machine is resuming." : "The machine is paused. Resume it to see its desktop.",
        control: AGENT_CONTROL,
      };
    }
    const probed = await probe(host);
    if (probed.state === "stopped") await forget(host.hostId);
    return { ...base, state: probed.state, message: probed.message, control: controlOf(host.hostId, clientId) };
  }

  async function view(threadId: string, theme: "light" | "dark" | null): Promise<DesktopView> {
    const host = await hostOf(threadId);
    if (host.phase !== "active") refuse(409, `${vendor.displayName}: the machine is paused. Resume it to see its desktop.`);
    try {
      return await vendor.view(host, { theme, signal: AbortSignal.timeout(vendorTimeoutMs) });
    } catch (error) {
      probes.delete(host.hostId);
      if (error instanceof DesktopRefusal) throw error;
      refuse(409, `${vendor.displayName}: couldn't open the desktop: ${text(error)}`);
    }
  }

  async function control(threadId: string, clientId: string, action: "take" | "renew" | "release"): Promise<DesktopControl> {
    const host = await hostOf(threadId);
    return serial(host.hostId, async () => {
      const lease = leases.get(host.hostId);
      if (action === "release") {
        if (lease !== undefined && lease.clientId !== clientId) return controlOf(host.hostId, clientId);
        drop(host.hostId);
        if (host.phase === "active") {
          try {
            if (lease !== undefined) await end(lease, "released");
            else await resume(host, "released");
          } catch (error) {
            refuse(409, `${vendor.displayName}: couldn't hand control back to the agent: ${text(error)}`);
          }
        }
        return AGENT_CONTROL;
      }
      if (host.phase !== "active") {
        drop(host.hostId);
        refuse(409, `${vendor.displayName}: the machine is paused. Resume it to take control.`);
      }
      if (action === "renew") {
        if (lease === undefined || lease.clientId !== clientId) return controlOf(host.hostId, clientId);
        if (now() >= lease.since + maxHoldMs) {
          drop(host.hostId);
          await end(lease, "the hold limit ran out").catch(() => undefined);
          refuse(
            409,
            `${vendor.displayName}: you had control for ${Math.round(maxHoldMs / 60_000)} minutes, so it went back to the agent. Take control again to carry on.`,
          );
        }
      }
      let agentPaused = false;
      if (vendor.pauseAgent !== undefined) {
        try {
          agentPaused = await vendor.pauseAgent(host, { leaseMs, signal: AbortSignal.timeout(vendorTimeoutMs) });
        } catch (error) {
          if (action === "renew" && lease !== undefined) {
            drop(host.hostId);
            await end(lease, "the pause couldn't be renewed").catch(() => undefined);
          }
          refuse(409, `${vendor.displayName}: couldn't pause the agent's computer tools: ${text(error)}`);
        }
      }
      if (action === "take") {
        active(host.hostId);
        return arm(host, threadId, clientId, now(), agentPaused);
      }
      return arm(host, threadId, clientId, lease!.since, agentPaused);
    });
  }

  async function releaseAll(): Promise<void> {
    const held = [...leases.values()];
    for (const lease of held) drop(lease.host.hostId);
    await Promise.all(held.map((lease) => resume(lease.host, "the plugin stopped").catch(() => undefined)));
  }

  function route<R extends DesktopRoute>(name: R, run: (input: z.output<(typeof DESKTOP_ROUTES)[R]["input"]>) => Promise<unknown>): void {
    const spec = DESKTOP_ROUTES[name];
    bb.http.route("POST", spec.path, async (context) => {
      const request = context as unknown as RouteContext;
      const refusal = browserRequestRefusal((header) => request.req.header(header));
      if (refusal !== null) return respond(403, { ok: false, error: { code: "forbidden", message: `${vendor.displayName}: ${refusal}.` } });
      let body: unknown;
      try {
        body = await request.req.json();
      } catch {
        return respond(400, { ok: false, error: { code: "invalid_json", message: "The request body must be JSON." } });
      }
      const parsed = spec.input.safeParse(body);
      if (!parsed.success) {
        return respond(400, { ok: false, error: { code: "invalid_input", message: "The request doesn't match the desktop contract." } });
      }
      try {
        const result = await run(parsed.data as z.output<(typeof DESKTOP_ROUTES)[R]["input"]>);
        return respond(200, { ok: true, result: spec.output.parse(result) });
      } catch (error) {
        if (error instanceof DesktopRefusal) return respond(error.status, { ok: false, error: { code: "refused", message: error.message } });
        bb.log.warn(`${vendor.displayName}: the desktop ${name} request failed: ${text(error)}`);
        return respond(500, { ok: false, error: { code: "failed", message: `${vendor.displayName}: the desktop ${name} request failed.` } });
      }
    });
  }

  route("status", ({ threadId, clientId }) => status(threadId, clientId));
  route("view", ({ threadId, theme }) => view(threadId, theme ?? null));
  route("control", ({ threadId, clientId, action }) => control(threadId, clientId, action));

  bb.background.service(`${vendor.providerId}-desktop-control`, {
    start: (signal) =>
      new Promise<void>((resolve) => {
        const stop = () => {
          void releaseAll().finally(resolve);
        };
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      }),
  });

  return { control: controlOf, releaseAll };
}
