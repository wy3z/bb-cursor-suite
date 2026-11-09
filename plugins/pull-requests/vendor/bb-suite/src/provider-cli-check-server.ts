import type { MessageDispatchHookContext, MessageDispatchHookDecision, PluginBbSdk } from "@get-bb/plugin-sdk";
import { redactSecrets } from "./machine-backend";

export interface ProviderCliCheckApi {
  readonly log: { info(message: string): void; warn(message: string): void };
  readonly sdk: { readonly hosts: Pick<PluginBbSdk["hosts"], "providerCliStatus" | "installProviderCli"> };
  readonly experimental_hooks: { recheck(hook: "message.dispatch"): Promise<void> };
}

export interface ProviderCliCheckOptions {
  label?: string;
  statusTimeoutMs?: number;
  retryAfterMs?: number;
  installTimeoutMs?: number;
  installedCacheMs?: number;
  now?: () => number;
}

export type DispatchCheck = (context: MessageDispatchHookContext) => Promise<MessageDispatchHookDecision>;

type Job = { state: "running"; startedAt: number; id: number } | { state: "done" } | { state: "failed"; message: string };

const PROCEED: MessageDispatchHookDecision = { action: "proceed" };

function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export function createProviderCliCheck(
  bb: ProviderCliCheckApi,
  machineProviderId: string,
  options: ProviderCliCheckOptions = {},
): DispatchCheck {
  const label = options.label ?? machineProviderId;
  const statusTimeoutMs = options.statusTimeoutMs ?? 4_000;
  const retryAfterMs = options.retryAfterMs ?? 60_000;
  const installTimeoutMs = options.installTimeoutMs ?? 10 * 60_000;
  const installedCacheMs = options.installedCacheMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  const jobs = new Map<string, Job>();
  const installedUntil = new Map<string, number>();
  let nextJob = 0;

  function failure(displayName: string, machine: string, hostId: string, provider: string, reason: string): string {
    return `${label}: ${displayName} isn't installed on ${machine} and installing it failed${reason ? ` (${reason})` : ""}. Run \`bb machine provider-cli install ${hostId} ${provider}\` and send again.`;
  }

  async function install(id: number, key: string, hostId: string, provider: string, displayName: string, machine: string): Promise<void> {
    bb.log.info(`${label}: installing ${displayName} on ${machine} before its turn starts`);
    let job: Job;
    try {
      const events = await bb.sdk.hosts.installProviderCli({ hostId, provider, actionKind: "install" });
      const done = events.find((event) => event.type === "completed");
      const failed = events.find((event) => event.type === "error");
      const output = events.flatMap((event) => (event.type === "output" ? [event.text] : [])).join("");
      const reason =
        failed?.type === "error"
          ? redactSecrets(failed.message)
          : redactSecrets(output.trim().split("\n").slice(-3).join(" ").slice(0, 400));
      job =
        done?.type === "completed" && done.success
          ? { state: "done" }
          : { state: "failed", message: failure(displayName, machine, hostId, provider, reason) };
    } catch (error) {
      job = { state: "failed", message: failure(displayName, machine, hostId, provider, errorText(error)) };
    }
    if (job.state === "done") installedUntil.set(key, now() + installedCacheMs);
    const current = jobs.get(key);
    if (current?.state !== "running" || current.id !== id) return;
    jobs.set(key, job);
    await bb.experimental_hooks.recheck("message.dispatch").catch((error: unknown) => {
      bb.log.warn(`${label}: recheck after installing ${displayName} failed: ${errorText(error)}`);
    });
  }

  return async (context) => {
    const host = context.host;
    if (context.attempt === "join-turn" || host === null || host.machineProviderId !== machineProviderId) return PROCEED;
    if (host.lifecycle?.phase !== "active") return PROCEED;
    const provider = context.requestedExecution.providerId;
    const key = `${host.id}:${provider}`;
    const machine = host.name ?? host.id;
    const job = jobs.get(key);
    if (job?.state === "running" && now() - job.startedAt >= installTimeoutMs) {
      jobs.delete(key);
      bb.log.warn(`${label}: installing the ${provider} CLI on ${machine} didn't finish within ${Math.round(installTimeoutMs / 60_000)} minutes`);
      return {
        action: "reject",
        message: `${label}: installing the ${provider} CLI on ${machine} didn't finish within ${Math.round(installTimeoutMs / 60_000)} minutes. Run \`bb machine provider-cli install ${host.id} ${provider}\` and send again.`,
      };
    }
    if (job?.state === "running") {
      return { action: "wait", reason: `Installing the ${provider} CLI on ${machine}…`, sendAt: now() + retryAfterMs };
    }
    if (job !== undefined) {
      jobs.delete(key);
      return job.state === "failed" ? { action: "reject", message: job.message } : PROCEED;
    }
    if ((installedUntil.get(key) ?? 0) > now()) return PROCEED;
    let entry;
    try {
      entry = (await bb.sdk.hosts.providerCliStatus({ hostId: host.id, signal: AbortSignal.timeout(statusTimeoutMs) }))[provider];
    } catch (error) {
      bb.log.warn(`${label}: could not read provider CLI status for ${host.id}: ${errorText(error)}`);
      return PROCEED;
    }
    if (entry === undefined) return PROCEED;
    if (entry.installed) {
      installedUntil.set(key, now() + installedCacheMs);
      return PROCEED;
    }
    if (entry.installAction === null) {
      return {
        action: "reject",
        message: `${label}: ${entry.displayName} isn't installed on ${machine} and BB has no installer for it. Install \`${entry.executableName}\` on the machine.`,
      };
    }
    nextJob += 1;
    jobs.set(key, { state: "running", startedAt: now(), id: nextJob });
    void install(nextJob, key, host.id, provider, entry.displayName, machine);
    return { action: "wait", reason: `Installing ${entry.displayName} on ${machine}…`, sendAt: now() + retryAfterMs };
  };
}

export function chainDispatchChecks(checks: readonly DispatchCheck[]): DispatchCheck {
  return async (context) => {
    for (const check of checks) {
      const decision = await check(context);
      if (decision.action !== "proceed") return decision;
    }
    return PROCEED;
  };
}
