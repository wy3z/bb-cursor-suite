import { experimental_PluginRpcRefusal, type BbPluginApi, type ExperimentalPluginRpcHandlerContext, type PluginBbSdk } from "@get-bb/plugin-sdk";
import {
  AGENT_CONTROL,
  DESKTOP_LEASE_MS,
  desktopRpcContract,
  type DesktopControl,
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
  pauseAgent?(host: DesktopHost, request: { leaseMs: number; signal: AbortSignal }): Promise<void>;
  resumeAgent?(host: DesktopHost, signal: AbortSignal): Promise<void>;
}

export interface DesktopPluginApi {
  readonly log: Pick<BbPluginApi["log"], "warn">;
  readonly rpc: Pick<BbPluginApi["rpc"], "register">;
  readonly background: Pick<BbPluginApi["background"], "service">;
  readonly sdk: {
    readonly threads: Pick<PluginBbSdk["threads"], "get">;
    readonly environments: Pick<PluginBbSdk["environments"], "get">;
    readonly hosts: Pick<PluginBbSdk["hosts"], "get">;
  };
}

export interface DesktopOptions {
  now?: () => number;
  leaseMs?: number;
  probeCacheMs?: number;
  vendorTimeoutMs?: number;
  redact?: (text: string) => string;
  onActivity?: (hostId: string) => void | Promise<void>;
}

export interface DesktopRegistration {
  control(hostId: string): DesktopControl;
  releaseAll(): Promise<void>;
}

interface Lease {
  host: DesktopHost;
  clientId: string;
  since: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

type Caller = Pick<ExperimentalPluginRpcHandlerContext, "experimental_caller">;

function refuse(code: "conflict" | "forbidden" | "invalid" | "not_found", message: string): never {
  throw new experimental_PluginRpcRefusal({ code, message });
}

export function registerDesktopProvider(bb: DesktopPluginApi, vendor: DesktopVendor, options: DesktopOptions = {}): DesktopRegistration {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? DESKTOP_LEASE_MS;
  const probeCacheMs = options.probeCacheMs ?? 15_000;
  const vendorTimeoutMs = options.vendorTimeoutMs ?? 60_000;
  const redact = options.redact ?? ((text: string) => text);
  const leases = new Map<string, Lease>();
  const probes = new Map<string, { at: number; value: DesktopProbe }>();
  const queues = new Map<string, Promise<unknown>>();

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

  function controlOf(hostId: string): DesktopControl {
    const lease = leases.get(hostId);
    if (lease === undefined) return AGENT_CONTROL;
    return { holder: "user", clientId: lease.clientId, since: lease.since, expiresAt: lease.expiresAt };
  }

  function drop(hostId: string): Lease | undefined {
    const lease = leases.get(hostId);
    if (lease === undefined) return undefined;
    clearTimeout(lease.timer);
    leases.delete(hostId);
    return lease;
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

  function arm(host: DesktopHost, clientId: string, since: number): DesktopControl {
    drop(host.hostId);
    const expiresAt = now() + leaseMs;
    const timer = setTimeout(() => {
      void serial(host.hostId, async () => {
        const lease = leases.get(host.hostId);
        if (lease === undefined || lease.expiresAt > now()) return;
        drop(host.hostId);
        await resume(host, "the control lease ran out").catch(() => undefined);
      });
    }, leaseMs + 250);
    const handle = timer as { unref?: () => void };
    handle.unref?.();
    leases.set(host.hostId, { host, clientId, since, expiresAt, timer });
    return controlOf(host.hostId);
  }

  async function hostOf(threadId: string): Promise<DesktopHost> {
    let environmentId: string | null;
    try {
      environmentId = (await bb.sdk.threads.get({ threadId })).environmentId;
    } catch {
      refuse("not_found", `${vendor.displayName}: thread ${threadId} wasn't found.`);
    }
    if (environmentId === null) refuse("not_found", `${vendor.displayName}: thread ${threadId} has no machine.`);
    let host: Awaited<ReturnType<PluginBbSdk["hosts"]["get"]>>;
    try {
      const environment = await bb.sdk.environments.get({ environmentId });
      host = await bb.sdk.hosts.get({ hostId: environment.hostId });
    } catch {
      refuse("not_found", `${vendor.displayName}: the machine of thread ${threadId} wasn't found.`);
    }
    if (host.machineProviderId !== vendor.providerId) {
      refuse("forbidden", `${vendor.displayName}: thread ${threadId} doesn't run on a ${vendor.displayName} machine.`);
    }
    return { hostId: host.id, machineProviderId: host.machineProviderId, phase: host.lifecycle.phase };
  }

  function clientOnly(context: Caller | undefined, what: string): void {
    if (context?.experimental_caller.kind !== "client") {
      refuse("forbidden", `${vendor.displayName}: ${what} is only served to the BB app.`);
    }
  }

  async function probe(host: DesktopHost): Promise<DesktopProbe> {
    const cached = probes.get(host.hostId);
    if (cached !== undefined && now() - cached.at < probeCacheMs) return cached.value;
    let value: DesktopProbe;
    try {
      value = await vendor.probe(host, AbortSignal.timeout(20_000));
    } catch (error) {
      value = { state: "unavailable", message: `${vendor.displayName}: couldn't read the desktop (${text(error)}).` };
    }
    probes.set(host.hostId, { at: now(), value });
    return value;
  }

  async function status(threadId: string): Promise<DesktopStatus> {
    const host = await hostOf(threadId);
    const base = {
      providerId: vendor.providerId,
      hostId: host.hostId,
      interactive: vendor.interactive,
      pausesAgent: vendor.pauseAgent !== undefined && vendor.resumeAgent !== undefined,
    };
    if (host.phase !== "active") {
      drop(host.hostId);
      probes.delete(host.hostId);
      const starting = host.phase === "resuming";
      return {
        ...base,
        state: starting ? "starting" : "stopped",
        message: starting ? "The machine is resuming." : "The machine is paused. Resume it to see its desktop.",
        control: AGENT_CONTROL,
      };
    }
    const probed = await probe(host);
    if (probed.state !== "ready") drop(host.hostId);
    return { ...base, state: probed.state, message: probed.message, control: controlOf(host.hostId) };
  }

  async function view(threadId: string, theme: "light" | "dark" | null): Promise<DesktopView> {
    const host = await hostOf(threadId);
    if (host.phase !== "active") refuse("conflict", `${vendor.displayName}: the machine is paused. Resume it to see its desktop.`);
    try {
      const opened = await vendor.view(host, { theme, signal: AbortSignal.timeout(vendorTimeoutMs) });
      active(host.hostId);
      return opened;
    } catch (error) {
      probes.delete(host.hostId);
      if (error instanceof experimental_PluginRpcRefusal) throw error;
      refuse("conflict", `${vendor.displayName}: couldn't open the desktop: ${text(error)}`);
    }
  }

  async function control(threadId: string, clientId: string, action: "take" | "renew" | "release"): Promise<DesktopControl> {
    const host = await hostOf(threadId);
    return serial(host.hostId, async () => {
      const lease = leases.get(host.hostId);
      if (action === "release") {
        if (lease !== undefined && lease.clientId !== clientId) return controlOf(host.hostId);
        drop(host.hostId);
        if (host.phase === "active") {
          try {
            await resume(host, "released");
          } catch (error) {
            refuse("conflict", `${vendor.displayName}: couldn't hand control back to the agent: ${text(error)}`);
          }
        }
        return AGENT_CONTROL;
      }
      if (host.phase !== "active") {
        drop(host.hostId);
        refuse("conflict", `${vendor.displayName}: the machine is paused. Resume it to take control.`);
      }
      if (action === "renew" && (lease === undefined || lease.clientId !== clientId)) return controlOf(host.hostId);
      if (vendor.pauseAgent !== undefined) {
        try {
          await vendor.pauseAgent(host, { leaseMs, signal: AbortSignal.timeout(vendorTimeoutMs) });
        } catch (error) {
          if (action === "renew") {
            drop(host.hostId);
            await resume(host, "the pause couldn't be renewed").catch(() => undefined);
          }
          refuse("conflict", `${vendor.displayName}: couldn't pause the agent's computer tools: ${text(error)}`);
        }
      }
      const since = lease !== undefined && lease.clientId === clientId ? lease.since : now();
      active(host.hostId);
      return arm(host, clientId, since);
    });
  }

  async function releaseAll(): Promise<void> {
    const held = [...leases.values()];
    for (const lease of held) drop(lease.host.hostId);
    await Promise.all(held.map((lease) => resume(lease.host, "the plugin stopped").catch(() => undefined)));
  }

  bb.rpc.register(
    desktopRpcContract,
    {
      "desktop.status": ({ threadId }) => status(threadId),
      "desktop.view": async ({ threadId, theme }, context) => {
        clientOnly(context, "the desktop view");
        return view(threadId, theme ?? null);
      },
      "desktop.control": async ({ threadId, clientId, action }, context) => {
        clientOnly(context, "desktop control");
        return control(threadId, clientId, action);
      },
    },
    { experimental_discoverable: false },
  );

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
