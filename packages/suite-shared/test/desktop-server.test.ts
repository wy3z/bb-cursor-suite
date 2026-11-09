import { describe, expect, it } from "bun:test";
import { desktopProviderFor, isViewUrl, viewOrigin } from "../src/desktop.ts";
import { registerDesktopProvider, type DesktopHost, type DesktopVendor } from "../src/desktop-server.ts";

type Handler = (input: Record<string, unknown>, context?: { experimental_caller: { kind: "client" } | { kind: "plugin"; pluginId: string } }) => Promise<unknown>;

const client = { experimental_caller: { kind: "client" as const } };
const plugin = { experimental_caller: { kind: "plugin" as const, pluginId: "other" } };

function setup(options: { phase?: string; provider?: string; leaseMs?: number; pauseFails?: boolean } = {}) {
  const calls: string[] = [];
  const activity: string[] = [];
  const warnings: string[] = [];
  let handlers: Record<string, Handler> = {};
  let registerOptions: unknown = null;
  let service: { start(signal: AbortSignal): void | Promise<void> } | null = null;
  const host = { id: "host_1", machineProviderId: options.provider ?? "fake-sandbox", lifecycle: { phase: options.phase ?? "active" } };
  const clock = { t: 1_000_000 };
  const vendor: DesktopVendor = {
    providerId: "fake-sandbox",
    displayName: "Fake Sandbox",
    interactive: true,
    probe: async (target: DesktopHost) => {
      calls.push(`probe ${target.hostId}`);
      return { state: "ready", message: null };
    },
    view: async () => {
      calls.push("view");
      return { url: "https://desktop.example/stream.html?hostId=1#token=fake", expiresAt: clock.t + 570_000 };
    },
    pauseAgent: async (_target, { leaseMs }) => {
      calls.push(`pause ${leaseMs}`);
      if (options.pauseFails) throw new Error("freeze failed ?token=leak");
    },
    resumeAgent: async () => {
      calls.push("resume");
    },
  };
  const bb = {
    log: { warn: (message: string) => warnings.push(message) },
    rpc: {
      register: (_contract: unknown, map: Record<string, Handler>, opts: unknown) => {
        handlers = map;
        registerOptions = opts;
      },
    },
    background: {
      service: (_name: string, value: { start(signal: AbortSignal): void | Promise<void> }) => {
        service = value;
      },
    },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId === "thr_missing") throw new Error("not found");
          return { environmentId: threadId === "thr_local" ? null : "env_1" };
        },
      },
      environments: { get: async () => ({ hostId: "host_1" }) },
      hosts: { get: async () => host },
    },
  };
  const registration = registerDesktopProvider(bb as never, vendor, {
    now: () => clock.t,
    leaseMs: options.leaseMs ?? 120_000,
    redact: (text) => text.replace(/token=[^\s&]+/g, "token=[redacted]"),
    onActivity: (hostId) => {
      activity.push(hostId);
    },
  });
  return { calls, activity, warnings, handlers: () => handlers, registerOptions: () => registerOptions, service: () => service, host, clock, registration };
}

describe("desktop registry", () => {
  it("maps a machine provider to its desktop plugin and nothing else", () => {
    expect(desktopProviderFor("boat-sandbox")?.pluginId).toBe("machine-boat");
    expect(desktopProviderFor("modal-sandbox")).toBeNull();
    expect(desktopProviderFor(null)).toBeNull();
    expect(desktopProviderFor(" ")).toBeNull();
  });

  it("only accepts https view URLs without credentials", () => {
    expect(isViewUrl("https://desktop.example/stream.html#token=x")).toBe(true);
    expect(isViewUrl("http://desktop.example/")).toBe(false);
    expect(isViewUrl("javascript:alert(1)")).toBe(false);
    expect(isViewUrl("https://user:pass@desktop.example/")).toBe(false);
    expect(viewOrigin("https://desktop.example/stream.html#token=x")).toBe("https://desktop.example");
  });
});

describe("registerDesktopProvider", () => {
  it("registers the methods as not discoverable", () => {
    const t = setup();
    expect(Object.keys(t.handlers()).sort()).toEqual(["desktop.control", "desktop.status", "desktop.view"]);
    expect(t.registerOptions()).toEqual({ experimental_discoverable: false });
  });

  it("reports a ready desktop with the agent in control", async () => {
    const t = setup();
    const status = await t.handlers()["desktop.status"]!({ threadId: "thr_1" }, client);
    expect(status).toEqual({
      providerId: "fake-sandbox",
      hostId: "host_1",
      state: "ready",
      message: null,
      interactive: true,
      pausesAgent: true,
      control: { holder: "agent", clientId: null, since: null, expiresAt: null },
    });
  });

  it("caches the vendor probe for a short while", async () => {
    const t = setup();
    await t.handlers()["desktop.status"]!({ threadId: "thr_1" }, client);
    await t.handlers()["desktop.status"]!({ threadId: "thr_1" }, client);
    expect(t.calls.filter((call) => call.startsWith("probe"))).toHaveLength(1);
    t.clock.t += 16_000;
    await t.handlers()["desktop.status"]!({ threadId: "thr_1" }, client);
    expect(t.calls.filter((call) => call.startsWith("probe"))).toHaveLength(2);
  });

  it("refuses threads on another provider's machine and threads without a machine", async () => {
    const other = setup({ provider: "modal-sandbox" });
    await expect(other.handlers()["desktop.view"]!({ threadId: "thr_1" }, client)).rejects.toThrow("doesn't run on a Fake Sandbox machine");
    await expect(other.handlers()["desktop.status"]!({ threadId: "thr_1" }, client)).rejects.toThrow("doesn't run on a Fake Sandbox machine");
    const t = setup();
    await expect(t.handlers()["desktop.status"]!({ threadId: "thr_local" }, client)).rejects.toThrow("has no machine");
    await expect(t.handlers()["desktop.status"]!({ threadId: "thr_missing" }, client)).rejects.toThrow("wasn't found");
    expect(other.calls).toEqual([]);
  });

  it("serves the view URL only to the app", async () => {
    const t = setup();
    await expect(t.handlers()["desktop.view"]!({ threadId: "thr_1" }, plugin)).rejects.toThrow("only served to the BB app");
    await expect(t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_aaaa", action: "take" }, plugin)).rejects.toThrow(
      "only served to the BB app",
    );
    expect(t.calls).toEqual([]);
    const view = (await t.handlers()["desktop.view"]!({ threadId: "thr_1", theme: "dark" }, client)) as { url: string };
    expect(view.url).toStartWith("https://desktop.example/");
  });

  it("won't open the view of a paused machine", async () => {
    const t = setup({ phase: "suspended" });
    await expect(t.handlers()["desktop.view"]!({ threadId: "thr_1" }, client)).rejects.toThrow("paused");
    const status = (await t.handlers()["desktop.status"]!({ threadId: "thr_1" }, client)) as { state: string };
    expect(status.state).toBe("stopped");
    expect(t.calls).toEqual([]);
  });

  it("pauses the agent while a user holds control and hands it back on release", async () => {
    const t = setup();
    const take = await t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_aaaa", action: "take" }, client);
    expect(take).toEqual({ holder: "user", clientId: "client_aaaa", since: 1_000_000, expiresAt: 1_120_000 });
    expect(t.calls).toEqual(["pause 120000"]);
    expect(t.registration.control("host_1").holder).toBe("user");

    t.clock.t += 30_000;
    const renewed = (await t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_aaaa", action: "renew" }, client)) as {
      since: number;
      expiresAt: number;
    };
    expect(renewed.since).toBe(1_000_000);
    expect(renewed.expiresAt).toBe(1_150_000);

    const stranger = await t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_bbbb", action: "release" }, client);
    expect(stranger).toMatchObject({ holder: "user", clientId: "client_aaaa" });
    const strangerRenew = await t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_bbbb", action: "renew" }, client);
    expect(strangerRenew).toMatchObject({ holder: "user", clientId: "client_aaaa" });

    const released = await t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_aaaa", action: "release" }, client);
    expect(released).toEqual({ holder: "agent", clientId: null, since: null, expiresAt: null });
    expect(t.calls).toEqual(["pause 120000", "pause 120000", "resume"]);
  });

  it("counts opening the view and holding control as machine activity", async () => {
    const t = setup();
    await t.handlers()["desktop.status"]!({ threadId: "thr_1" }, client);
    expect(t.activity).toEqual([]);
    await t.handlers()["desktop.view"]!({ threadId: "thr_1" }, client);
    await t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_aaaa", action: "take" }, client);
    await t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_aaaa", action: "renew" }, client);
    await t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_bbbb", action: "renew" }, client);
    await t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_aaaa", action: "release" }, client);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.activity).toEqual(["host_1", "host_1", "host_1"]);
  });

  it("lets another window take over control", async () => {
    const t = setup();
    await t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_aaaa", action: "take" }, client);
    t.clock.t += 5_000;
    const taken = await t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_bbbb", action: "take" }, client);
    expect(taken).toMatchObject({ holder: "user", clientId: "client_bbbb", since: 1_005_000 });
  });

  it("refuses control when the agent can't be paused, without logging a token", async () => {
    const t = setup({ pauseFails: true });
    const attempt = t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_aaaa", action: "take" }, client);
    await expect(attempt).rejects.toThrow("couldn't pause the agent's computer tools");
    await expect(attempt).rejects.not.toThrow("leak");
    expect(t.registration.control("host_1").holder).toBe("agent");
  });

  it("hands control back when the lease runs out", async () => {
    const t = setup({ leaseMs: 20 });
    await t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_aaaa", action: "take" }, client);
    t.clock.t += 1_000;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(t.calls).toEqual(["pause 20", "resume"]);
    expect(t.registration.control("host_1").holder).toBe("agent");
  });

  it("drops control when the machine is paused", async () => {
    const t = setup();
    await t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_aaaa", action: "take" }, client);
    t.host.lifecycle.phase = "suspended";
    const status = (await t.handlers()["desktop.status"]!({ threadId: "thr_1" }, client)) as { control: { holder: string } };
    expect(status.control.holder).toBe("agent");
    await expect(t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_aaaa", action: "take" }, client)).rejects.toThrow("paused");
  });

  it("hands every desktop back when the plugin stops", async () => {
    const t = setup();
    await t.handlers()["desktop.control"]!({ threadId: "thr_1", clientId: "client_aaaa", action: "take" }, client);
    const controller = new AbortController();
    const running = t.service()!.start(controller.signal);
    controller.abort();
    await running;
    expect(t.calls).toEqual(["pause 120000", "resume"]);
    expect(t.registration.control("host_1").holder).toBe("agent");
  });
});
