import { describe, expect, it } from "bun:test";
import { browserRequestRefusal, desktopProviderFor, desktopRouteUrl, isViewUrl } from "../src/desktop.ts";
import { AGENT_NOTE, registerDesktopProvider, type DesktopHost, type DesktopVendor } from "../src/desktop-server.ts";

type Route = (context: unknown) => Promise<Response>;

const APP_HEADERS: Record<string, string> = {
  origin: "http://127.0.0.1:38886",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "content-type": "application/json",
};

function setup(options: { phase?: string; provider?: string; leaseMs?: number; maxHoldMs?: number; pauseFails?: boolean; paused?: boolean; threadStatus?: string } = {}) {
  const calls: string[] = [];
  const activity: string[] = [];
  const sent: unknown[] = [];
  const listed: string[] = [];
  const warnings: string[] = [];
  const routes = new Map<string, Route>();
  let service: { start(signal: AbortSignal): void | Promise<void> } | null = null;
  const host = { id: "host_1", machineProviderId: options.provider ?? "fake-sandbox", lifecycle: { phase: options.phase ?? "active" } };
  const clock = { t: 1_000_000 };
  let probeFails = false;
  const vendor: DesktopVendor = {
    providerId: "fake-sandbox",
    displayName: "Fake Sandbox",
    interactive: true,
    probe: async (target: DesktopHost) => {
      calls.push(`probe ${target.hostId}`);
      if (probeFails) throw new Error("boat is down");
      return { state: "ready", message: null };
    },
    view: async (_target, { touch }) => {
      calls.push(touch ? "view touch" : "view");
      return { url: "https://desktop.example/stream.html?hostId=1#token=fake", expiresAt: clock.t + 570_000 };
    },
    pauseAgent: async (_target, { leaseMs }) => {
      calls.push(`pause ${leaseMs}`);
      if (options.pauseFails) throw new Error("freeze failed ?token=leak");
      return options.paused ?? true;
    },
    resumeAgent: async () => {
      calls.push("resume");
    },
  };
  const bb = {
    log: { warn: (message: string) => warnings.push(message) },
    http: {
      route: (method: string, path: string, handler: Route) => {
        routes.set(`${method} ${path}`, handler);
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
          return { environmentId: threadId === "thr_local" ? null : "env_1", runtime: { displayStatus: options.threadStatus ?? "active" } };
        },
        list: async ({ hostId }: { hostId: string }) => {
          listed.push(hostId);
          return [
            { id: "thr_1", runtime: { displayStatus: options.threadStatus ?? "active" } },
            { id: "thr_2", runtime: { displayStatus: "active" } },
            { id: "thr_3", runtime: { displayStatus: "idle" } },
          ];
        },
        send: async (args: unknown) => {
          sent.push(args);
          return { ok: true, delivery: "sent" };
        },
      },
      environments: { get: async () => ({ hostId: "host_1" }) },
      hosts: { get: async () => host },
    },
  };
  const registration = registerDesktopProvider(bb as never, vendor, {
    now: () => clock.t,
    leaseMs: options.leaseMs ?? 120_000,
    maxHoldMs: options.maxHoldMs ?? 30 * 60_000,
    redact: (text) => text.replace(/token=[^\s&]+/g, "token=[redacted]"),
    onActivity: (hostId) => {
      activity.push(hostId);
    },
  });

  async function call(path: string, body: unknown, headers: Record<string, string> = APP_HEADERS) {
    const handler = routes.get(`POST ${path}`);
    if (handler === undefined) throw new Error(`no route ${path}`);
    const response = await handler({
      req: {
        header: (name: string) => headers[name.toLowerCase()],
        json: async () => body,
      },
    });
    return { status: response.status, body: (await response.json()) as { ok: boolean; result?: any; error?: { code: string; message: string } } };
  }

  const status = (threadId = "thr_1", clientId = "client_aaaa") => call("/desktop/status", { threadId, clientId });
  const control = (action: "take" | "renew" | "release", clientId = "client_aaaa", threadId = "thr_1") =>
    call("/desktop/control", { threadId, clientId, action });
  const view = (threadId = "thr_1") => call("/desktop/view", { threadId, theme: "dark" });
  return {
    calls,
    activity,
    sent,
    warnings,
    routes,
    service: () => service,
    host,
    clock,
    registration,
    call,
    status,
    control,
    view,
    failProbe: () => {
      probeFails = true;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("desktop registry", () => {
  it("maps a machine provider to its desktop plugin and nothing else", () => {
    expect(desktopProviderFor("boat-sandbox")?.pluginId).toBe("machine-boat");
    expect(desktopProviderFor("modal-sandbox")).toBeNull();
    expect(desktopProviderFor(null)).toBeNull();
    expect(desktopProviderFor(" ")).toBeNull();
    expect(desktopRouteUrl("machine-boat", "view")).toBe("/api/v1/plugins/machine-boat/http/desktop/view");
  });

  it("only accepts https view URLs without credentials", () => {
    expect(isViewUrl("https://desktop.example/stream.html#token=x")).toBe(true);
    expect(isViewUrl("http://desktop.example/")).toBe(false);
    expect(isViewUrl("javascript:alert(1)")).toBe(false);
    expect(isViewUrl("https://user:pass@desktop.example/")).toBe(false);
  });
});

describe("browserRequestRefusal", () => {
  const from = (headers: Record<string, string>) => browserRequestRefusal((name) => headers[name]);
  it("lets the BB app's own fetches through", () => {
    expect(from(APP_HEADERS)).toBeNull();
    expect(from({ ...APP_HEADERS, "x-bb-gate-auth": "session" })).toBeNull();
  });

  it("allows only a signed-in session through the Connect gate", () => {
    expect(from({ ...APP_HEADERS, "x-bb-gate-auth": "machine" })).toContain("machine credentials");
    expect(from({ ...APP_HEADERS, "x-bb-gate-auth": "oauth" })).toContain("connected apps");
    expect(from({ ...APP_HEADERS, "x-bb-gate-auth": "public" })).toContain("signed-in BB app session");
    expect(from({ ...APP_HEADERS, "x-bb-gate-auth": "service" })).toContain("signed-in BB app session");
  });

  it("refuses requests without the browser's same-origin fetch metadata, like the bb CLI's", () => {
    expect(from({ "content-type": "application/json" })).toContain("only the BB app");
    expect(from({ ...APP_HEADERS, "sec-fetch-site": "cross-site" })).toContain("only the BB app");
    expect(from({ ...APP_HEADERS, "sec-fetch-mode": "navigate" })).toContain("only the BB app");
    const { origin: _origin, ...noOrigin } = APP_HEADERS;
    expect(from(noOrigin)).toContain("only the BB app");
  });
});

describe("registerDesktopProvider", () => {
  it("serves three HTTP routes and nothing over RPC", () => {
    const t = setup();
    expect([...t.routes.keys()].sort()).toEqual(["POST /desktop/control", "POST /desktop/status", "POST /desktop/view"]);
  });

  it("refuses every route to callers that aren't the BB app", async () => {
    const t = setup();
    const cli = { "content-type": "application/json" };
    for (const [path, body] of [
      ["/desktop/status", { threadId: "thr_1", clientId: "client_aaaa" }],
      ["/desktop/view", { threadId: "thr_1" }],
      ["/desktop/control", { threadId: "thr_1", clientId: "client_aaaa", action: "take" }],
    ] as const) {
      const answer = await t.call(path, body, cli);
      expect(answer.status).toBe(403);
      const machine = await t.call(path, body, { ...APP_HEADERS, "x-bb-gate-auth": "machine" });
      expect(machine.status).toBe(403);
    }
    expect(t.calls).toEqual([]);
  });

  it("validates the body against the contract", async () => {
    const t = setup();
    expect((await t.call("/desktop/control", { threadId: "thr_1", clientId: "x", action: "take" })).status).toBe(400);
    expect((await t.call("/desktop/status", { threadId: "thr_1" })).status).toBe(400);
  });

  it("reports a ready desktop with the agent in control, and never another window's id", async () => {
    const t = setup();
    const answer = await t.status();
    expect(answer.body.result).toEqual({
      providerId: "fake-sandbox",
      state: "ready",
      message: null,
      interactive: true,
      pausesAgent: true,
      control: { holder: "agent", mine: false, agentPaused: false, since: null, expiresAt: null },
    });
    await t.control("take");
    const mine = await t.status("thr_1", "client_aaaa");
    const theirs = await t.status("thr_1", "client_bbbb");
    expect(mine.body.result.control).toMatchObject({ holder: "user", mine: true, agentPaused: true });
    expect(theirs.body.result.control).toMatchObject({ holder: "user", mine: false });
    expect(JSON.stringify(theirs.body)).not.toContain("client_aaaa");
  });

  it("caches the vendor probe for a short while, but not failures", async () => {
    const t = setup();
    await t.status();
    await t.status();
    expect(t.calls.filter((call) => call.startsWith("probe"))).toHaveLength(1);
    t.clock.t += 16_000;
    await t.status();
    expect(t.calls.filter((call) => call.startsWith("probe"))).toHaveLength(2);
  });

  it("refuses threads on another provider's machine and threads without a machine", async () => {
    const other = setup({ provider: "modal-sandbox" });
    const refused = await other.view();
    expect(refused.status).toBe(403);
    expect(refused.body.error?.message).toContain("doesn't run on a Fake Sandbox machine");
    const t = setup();
    expect((await t.status("thr_local")).body.error?.message).toContain("has no machine");
    expect((await t.status("thr_missing")).body.error?.message).toContain("wasn't found");
    expect(other.calls).toEqual([]);
  });

  it("opens the view for the app and won't for a paused machine", async () => {
    const t = setup();
    const opened = await t.view();
    expect(opened.body.result.url).toStartWith("https://desktop.example/");
    const paused = setup({ phase: "suspended" });
    expect((await paused.view()).status).toBe(409);
    expect((await paused.status()).body.result.state).toBe("stopped");
    expect(paused.calls).toEqual([]);
  });

  it("tells the vendor whether the viewer is on a touch screen", async () => {
    const t = setup();
    await t.view();
    await t.call("/desktop/view", { threadId: "thr_1", theme: "dark", touch: true });
    await t.call("/desktop/view", { threadId: "thr_1", theme: "dark", touch: false });
    expect(t.calls.filter((call) => call.startsWith("view"))).toEqual(["view", "view touch", "view"]);
    expect((await t.call("/desktop/view", { threadId: "thr_1", touch: "yes" })).status).toBe(400);
  });

  it("pauses the agent while a user holds control and hands it back on release", async () => {
    const t = setup();
    const take = await t.control("take");
    expect(take.body.result).toEqual({ holder: "user", mine: true, agentPaused: true, since: 1_000_000, expiresAt: 1_120_000 });
    expect(t.calls).toEqual(["pause 120000"]);

    t.clock.t += 30_000;
    const renewed = await t.control("renew");
    expect(renewed.body.result).toMatchObject({ since: 1_000_000, expiresAt: 1_150_000 });

    expect((await t.control("release", "client_bbbb")).body.result).toMatchObject({ holder: "user", mine: false });
    expect((await t.control("renew", "client_bbbb")).body.result).toMatchObject({ holder: "user", mine: false });

    const released = await t.control("release");
    expect(released.body.result).toEqual({ holder: "agent", mine: false, agentPaused: false, since: null, expiresAt: null });
    expect(t.calls).toEqual(["pause 120000", "pause 120000", "resume"]);
  });

  it("counts taking and renewing control as machine activity, nothing else", async () => {
    const t = setup();
    await t.status();
    await t.view();
    await t.control("take");
    await t.control("renew");
    await t.control("renew", "client_bbbb");
    await t.control("release");
    await settle();
    expect(t.activity).toEqual(["host_1", "host_1"]);
  });

  it("ends a hold after the maximum, resumes the agent and refuses the renew", async () => {
    const t = setup({ maxHoldMs: 60_000 });
    await t.control("take");
    t.clock.t += 30_000;
    expect((await t.control("renew")).body.result.expiresAt).toBe(1_060_000);
    t.clock.t += 31_000;
    const refused = await t.control("renew");
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toContain("went back to the agent");
    expect(t.calls.at(-1)).toBe("resume");
    expect(t.registration.control("host_1").holder).toBe("agent");
    expect((await t.control("take")).body.result).toMatchObject({ holder: "user", since: 1_061_000 });
  });

  it("tells every running agent on the machine that control came back, only when it was paused", async () => {
    const t = setup();
    await t.control("take");
    await t.control("release");
    await settle();
    await settle();
    const note = { mode: "steer", input: [{ type: "text", text: AGENT_NOTE, mentions: [], visibility: "agent-only" }] };
    expect(t.sent).toEqual([
      { threadId: "thr_1", ...note },
      { threadId: "thr_2", ...note },
    ]);

    const idle = setup({ threadStatus: "idle" });
    await idle.control("take");
    await idle.control("release");
    await settle();
    await settle();
    expect(idle.sent).toEqual([{ threadId: "thr_2", ...note }]);

    const unpaused = setup({ paused: false });
    const taken = await unpaused.control("take");
    expect(taken.body.result.agentPaused).toBe(false);
    await unpaused.control("release");
    await settle();
    expect(unpaused.sent).toEqual([]);
  });

  it("lets another window take over control", async () => {
    const t = setup();
    await t.control("take");
    t.clock.t += 5_000;
    expect((await t.control("take", "client_bbbb")).body.result).toMatchObject({ holder: "user", mine: true, since: 1_005_000 });
    expect((await t.status("thr_1", "client_aaaa")).body.result.control.mine).toBe(false);
  });

  it("refuses control when the agent can't be paused, without leaking a token", async () => {
    const t = setup({ pauseFails: true });
    const attempt = await t.control("take");
    expect(attempt.status).toBe(409);
    expect(attempt.body.error?.message).toContain("couldn't pause the agent's computer tools");
    expect(attempt.body.error?.message).not.toContain("leak");
    expect(t.registration.control("host_1").holder).toBe("agent");
  });

  it("hands control back when the lease runs out", async () => {
    const t = setup({ leaseMs: 20 });
    await t.control("take");
    t.clock.t += 1_000;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(t.calls).toEqual(["pause 20", "resume"]);
    expect(t.registration.control("host_1").holder).toBe("agent");
  });

  it("keeps the lease through a failed probe and drops it once the machine is paused", async () => {
    const t = setup();
    await t.control("take");
    t.failProbe();
    t.clock.t += 16_000;
    const flaky = await t.status();
    expect(flaky.body.result.state).toBe("unavailable");
    expect(t.registration.control("host_1").holder).toBe("user");
    t.host.lifecycle.phase = "suspended";
    expect((await t.status()).body.result.control.holder).toBe("agent");
    expect(t.registration.control("host_1").holder).toBe("agent");
    expect((await t.control("take")).status).toBe(409);
  });

  it("hands every desktop back when the plugin stops", async () => {
    const t = setup();
    await t.control("take");
    const controller = new AbortController();
    const running = t.service()!.start(controller.signal);
    controller.abort();
    await running;
    expect(t.calls).toEqual(["pause 120000", "resume"]);
    expect(t.registration.control("host_1").holder).toBe("agent");
  });
});
