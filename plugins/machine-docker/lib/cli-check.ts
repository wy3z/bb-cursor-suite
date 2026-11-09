import type { MessageDispatchHookContext, MessageDispatchHookDecision, PluginBbSdk } from "@get-bb/plugin-sdk";
import { redactSecrets } from "@wy3z/bb-suite/machine-backend";

export interface ProviderCliCheckApi {
  readonly log: { info(message: string): void; warn(message: string): void };
  readonly sdk: { readonly hosts: Pick<PluginBbSdk["hosts"], "providerCliStatus" | "installProviderCli"> };
  readonly experimental_hooks: { recheck(hook: "message.dispatch"): Promise<void> };
}

export interface ProviderCliCheckOptions {
  statusTimeoutMs?: number;
  retryAfterMs?: number;
  now?: () => number;
}

type Job = { state: "running" } | { state: "done" } | { state: "failed"; message: string };

const PROCEED: MessageDispatchHookDecision = { action: "proceed" };

function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export function createProviderCliCheck(
  bb: ProviderCliCheckApi,
  machineProviderId: string,
  options: ProviderCliCheckOptions = {},
): (context: MessageDispatchHookContext) => Promise<MessageDispatchHookDecision> {
  const statusTimeoutMs = options.statusTimeoutMs ?? 4_000;
  const retryAfterMs = options.retryAfterMs ?? 60_000;
  const now = options.now ?? Date.now;
  const jobs = new Map<string, Job>();

  function failure(displayName: string, machine: string, hostId: string, provider: string, reason: string): string {
    return `Docker Sandbox: ${displayName} isn't installed on ${machine} and installing it failed${reason ? ` (${reason})` : ""}. Run \`bb machine provider-cli install ${hostId} ${provider}\` and send again.`;
  }

  async function install(key: string, hostId: string, provider: string, displayName: string, machine: string): Promise<void> {
    bb.log.info(`Docker Sandbox: installing ${displayName} on ${machine} before its turn starts`);
    let job: Job;
    try {
      const events = await bb.sdk.hosts.installProviderCli({ hostId, provider, actionKind: "install" });
      const done = events.find((event) => event.type === "completed");
      const failed = events.find((event) => event.type === "error");
      const output = events.flatMap((event) => (event.type === "output" ? [event.text] : [])).join("");
      const reason =
        failed?.type === "error" ? redactSecrets(failed.message) : redactSecrets(output.trim().split("\n").slice(-3).join(" ").slice(0, 400));
      job = done?.type === "completed" && done.success ? { state: "done" } : { state: "failed", message: failure(displayName, machine, hostId, provider, reason) };
    } catch (error) {
      job = { state: "failed", message: failure(displayName, machine, hostId, provider, errorText(error)) };
    }
    jobs.set(key, job);
    await bb.experimental_hooks.recheck("message.dispatch").catch((error: unknown) => {
      bb.log.warn(`Docker Sandbox: recheck after installing ${displayName} failed: ${errorText(error)}`);
    });
  }

  return async (context) => {
    const host = context.host;
    if (context.attempt === "join-turn" || host === null || host.machineProviderId !== machineProviderId) return PROCEED;
    if (host.lifecycle.phase !== "active") return PROCEED;
    const provider = context.requestedExecution.providerId;
    const key = `${host.id}:${provider}`;
    const machine = host.name ?? host.id;
    const job = jobs.get(key);
    if (job?.state === "running") {
      return { action: "wait", reason: `Installing the ${provider} CLI on ${machine}…`, sendAt: now() + retryAfterMs };
    }
    if (job !== undefined) {
      jobs.delete(key);
      return job.state === "failed" ? { action: "reject", message: job.message } : PROCEED;
    }
    let entry;
    try {
      entry = (await bb.sdk.hosts.providerCliStatus({ hostId: host.id, signal: AbortSignal.timeout(statusTimeoutMs) }))[provider];
    } catch (error) {
      bb.log.warn(`Docker Sandbox: could not read provider CLI status for ${host.id}: ${errorText(error)}`);
      return PROCEED;
    }
    if (entry === undefined || entry.installed) return PROCEED;
    if (entry.installAction === null) {
      return {
        action: "reject",
        message: `Docker Sandbox: ${entry.displayName} isn't installed on ${machine} and BB has no installer for it. Use an image that includes \`${entry.executableName}\`.`,
      };
    }
    jobs.set(key, { state: "running" });
    void install(key, host.id, provider, entry.displayName, machine);
    return { action: "wait", reason: `Installing ${entry.displayName} on ${machine}…`, sendAt: now() + retryAfterMs };
  };
}

export function chainDispatchChecks(
  checks: Array<(context: MessageDispatchHookContext) => Promise<MessageDispatchHookDecision>>,
): (context: MessageDispatchHookContext) => Promise<MessageDispatchHookDecision> {
  return async (context) => {
    for (const check of checks) {
      const decision = await check(context);
      if (decision.action !== "proceed") return decision;
    }
    return PROCEED;
  };
}
