import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoatApi } from "../lib/api.ts";
import { createBoatBackend } from "../lib/backend.ts";
import {
  CODEX_PATCH,
  CODEX_TOOL_TIMEOUT_SECONDS,
  codexTimeoutScript,
  createBoatDesktop,
  isBoatStreamUrl,
  withoutViewerOverlay,
  pauseScript,
  resumeScript,
} from "../lib/desktop.ts";
import type { BoatSettings } from "../lib/settings.ts";
import { FakeBoat, TEST_KEY } from "./fake-boat.ts";

const HOST = { hostId: "host_boat", machineProviderId: "boat-sandbox", phase: "active" };

function resource(sandboxId: string | null) {
  return {
    v: 1,
    providerId: "boat-sandbox",
    key: "k",
    name: "bb-boat-k",
    state: "running",
    sandboxId,
    snapshotId: null,
    snapshotSandboxId: null,
    staleSnapshotIds: [],
    unverifiedSnapshotOps: [],
    init: "systemd",
    meta: {},
  };
}

function setup() {
  const boat = new FakeBoat();
  const sandbox = boat.add({ name: "bb-boat-k", labels: { "app.getbb.boat-sandbox": "1", "app.getbb.boat-sandbox.name": "bb-boat-k" } });
  const api = createBoatApi({ apiKey: async () => TEST_KEY, fetch: boat.fetch as typeof fetch, baseUrl: "https://boat.test/api/v1" });
  let stored: unknown = resource(sandbox.id);
  const clock = { t: 1_000_000 };
  const desktop = createBoatDesktop({
    api,
    resource: async () => stored,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
  });
  return { boat, sandbox, desktop, clock, setResource: (value: unknown) => (stored = value) };
}

const signal = () => AbortSignal.timeout(10_000);

describe("viewer overlay", () => {
  test("adds overlay=0 to the query and keeps the token fragment", () => {
    expect(withoutViewerOverlay("https://bx.on.boat.dev/stream.html?hostId=1&appId=2#token=a?b&c")).toBe(
      "https://bx.on.boat.dev/stream.html?hostId=1&appId=2&overlay=0#token=a?b&c",
    );
    expect(withoutViewerOverlay("https://bx.on.boat.dev/stream.html#token=t")).toBe("https://bx.on.boat.dev/stream.html?overlay=0#token=t");
    expect(withoutViewerOverlay("https://bx.on.boat.dev/stream.html?overlay=1&theme=dark")).toBe("https://bx.on.boat.dev/stream.html?theme=dark&overlay=0");
  });
});

describe("desktop view", () => {
  test("returns boat's desktop URL with a deadline inside its 10 minutes", async () => {
    const t = setup();
    const view = await t.desktop.view(HOST, { theme: "dark", signal: signal() });
    expect(view.url).toBe("https://bx-test.on.boat.dev/stream.html?hostId=1&appId=2&theme=dark&overlay=0#token=secretdesktoptoken");
    expect(view.expiresAt).toBe(1_000_000 + 570_000);
    const call = t.boat.calls("POST", `/sandboxes/${t.sandbox.id}/desktop`)[0]!;
    expect(call.search.get("theme")).toBe("dark");
    expect(call.search.get("vnc")).toBeNull();
  });

  test("polls while boat prepares the desktop", async () => {
    const t = setup();
    t.boat.desktopProvisioning = 2;
    const view = await t.desktop.view(HOST, { theme: null, signal: signal() });
    expect(view.url).toStartWith("https://");
    expect(t.boat.calls("POST", `/sandboxes/${t.sandbox.id}/desktop`)).toHaveLength(3);
    expect(t.boat.calls("POST", `/sandboxes/${t.sandbox.id}/desktop`)[0]!.search.has("theme")).toBe(false);
  });

  test("retries desktop_not_ready and gives up on other errors without leaking a token", async () => {
    const t = setup();
    t.boat.fail("POST /sandboxes/:id/desktop", { status: 409, code: "desktop_not_ready", times: 2 });
    await t.desktop.view(HOST, { theme: null, signal: signal() });
    expect(t.boat.calls("POST", `/sandboxes/${t.sandbox.id}/desktop`)).toHaveLength(3);

    const other = setup();
    other.boat.fail("POST /sandboxes/:id/desktop", { status: 400, code: "machine_not_running", message: "see https://x.example/stream.html#token=leaky123" });
    const attempt = other.desktop.view(HOST, { theme: null, signal: signal() });
    await expect(attempt).rejects.toThrow("machine_not_running");
    await expect(attempt).rejects.not.toThrow("leaky123");
  });

  test("only frames https addresses on boat's stream domain", async () => {
    const t = setup();
    t.boat.desktopUrl = "http://bx-test.on.boat.dev/stream.html#token=x";
    await expect(t.desktop.view(HOST, { theme: null, signal: signal() })).rejects.toThrow("on.boat.dev");
    t.boat.desktopUrl = "https://evil.example/stream.html#token=x";
    await expect(t.desktop.view(HOST, { theme: null, signal: signal() })).rejects.toThrow("on.boat.dev");
    t.boat.desktopUrl = "https://on.boat.dev.evil.example/stream.html#token=x";
    await expect(t.desktop.view(HOST, { theme: null, signal: signal() })).rejects.toThrow("on.boat.dev");
    expect(isBoatStreamUrl("https://bx-1.on.boat.dev/stream.html#token=x")).toBe(true);
    expect(isBoatStreamUrl(withoutViewerOverlay("https://bx-1.on.boat.dev/stream.html#token=x"))).toBe(true);
    expect(isBoatStreamUrl("https://on.boat.dev/stream.html")).toBe(false);
  });

  test("needs a recorded sandbox", async () => {
    const t = setup();
    t.setResource(resource(null));
    await expect(t.desktop.view(HOST, { theme: null, signal: signal() })).rejects.toThrow("no running boat sandbox");
    t.setResource(null);
    await expect(t.desktop.view(HOST, { theme: null, signal: signal() })).rejects.toThrow("no recorded boat sandbox");
  });
});

describe("desktop probe", () => {
  test("maps boat's states", async () => {
    const t = setup();
    expect(await t.desktop.probe(HOST, signal())).toEqual({ state: "ready", message: null });
    t.sandbox.state = "provisioning";
    t.sandbox.pollsUntilReady = 5;
    expect((await t.desktop.probe(HOST, signal())).state).toBe("starting");
    t.sandbox.state = "archived";
    expect((await t.desktop.probe(HOST, signal())).state).toBe("stopped");
    t.sandbox.state = "error";
    expect((await t.desktop.probe(HOST, signal())).state).toBe("unavailable");
    t.boat.sandboxes.delete(t.sandbox.id);
    expect((await t.desktop.probe(HOST, signal())).state).toBe("unavailable");
  });
});

describe("pausing the agent's computer tools", () => {
  test("freezes cua-driver behind a VM-side release timer and thaws it on release", async () => {
    const t = setup();
    expect(await t.desktop.pauseAgent!(HOST, { leaseMs: 120_000, signal: signal() })).toBe(true);
    await t.desktop.resumeAgent!(HOST, signal());
    const [pause, resume] = t.boat.commands.map((entry) => entry.command);
    expect(pause).toContain("systemctl --user freeze cua-driver.service");
    expect(pause).toContain("--on-active=150s");
    expect(pause).toContain("AccuracySec=1s");
    expect(pause).toContain("SIGSTOP");
    expect(pause).toMatch(/\|\| \{ systemctl --user thaw cua-driver\.service[^}]*SIGCONT[^}]*exit 3; \}/);
    expect(resume).toContain("systemctl --user thaw cua-driver.service");
    expect(resume).toContain("SIGCONT");
    expect(resume).toContain("stop bb-desktop-release.timer");
  });

  test("says when there's no computer-use daemon to pause", async () => {
    const t = setup();
    t.boat.commandScript = () => [{ type: "started" }, { type: "stdout", data: "absent\n" }, { type: "exit", exitCode: 0, timedOut: false }];
    expect(await t.desktop.pauseAgent!(HOST, { leaseMs: 120_000, signal: signal() })).toBe(false);
  });

  test("reports a failed pause", async () => {
    const t = setup();
    t.boat.commandScript = () => [{ type: "started" }, { type: "stderr", data: "Failed to freeze unit\n" }, { type: "exit", exitCode: 4, timedOut: false }];
    await expect(t.desktop.pauseAgent!(HOST, { leaseMs: 120_000, signal: signal() })).rejects.toThrow("exit 4: Failed to freeze unit");
  });

  test("scripts are plain bash", () => {
    for (const script of [pauseScript(120_000), resumeScript(), codexTimeoutScript()]) {
      const checked = spawnSync("bash", ["-n"], { input: script });
      expect(checked.status).toBe(0);
    }
  });
});

describe("Codex tool timeout", () => {
  const BLOCK = `model = "x"

# >>> ascii computer use (managed by the agent server) >>>
[mcp_servers.computer]
command = "/usr/bin/python3"
args = ["/home/user/.config/ascii/computer-mcp.py"]
# <<< ascii computer use (managed by the agent server) <<<

[mcp_servers.other]
command = "other"
tool_timeout_sec = 5
`;

  function patch(config: string | null): string | null {
    const home = mkdtempSync(join(tmpdir(), "bb-boat-codex-"));
    try {
      if (config !== null) {
        mkdirSync(join(home, ".codex"));
        writeFileSync(join(home, ".codex", "config.toml"), config);
      }
      const script = join(home, "patch.sh");
      writeFileSync(script, CODEX_PATCH);
      const run = spawnSync("sh", [script], { env: { ...process.env, HOME: home } });
      expect(run.status).toBe(0);
      return config === null ? null : readFileSync(join(home, ".codex", "config.toml"), "utf8");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("adds the timeout to the computer server only, once", () => {
    const once = patch(BLOCK)!;
    expect(once).toContain(`[mcp_servers.computer]\ntool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECONDS}\ncommand`);
    expect(once).toContain("[mcp_servers.other]\ncommand = \"other\"\ntool_timeout_sec = 5");
    expect(patch(once)).toBe(once);
  });

  test("replaces a timeout boat or the user already set", () => {
    const patched = patch(BLOCK.replace('command = "/usr/bin/python3"', 'command = "/usr/bin/python3"\ntool_timeout_sec = 60'))!;
    expect(patched.match(/tool_timeout_sec/g)).toHaveLength(2);
    expect(patched).not.toContain("tool_timeout_sec = 60");
  });

  test("leaves a config without the computer server and a missing config alone", () => {
    const plain = 'model = "x"\n';
    expect(patch(plain)).toBe(plain);
    expect(patch(null)).toBeNull();
  });

  test("installs a path unit that re-applies it whenever boat rewrites the config", () => {
    const script = codexTimeoutScript();
    expect(script).toContain("PathChanged=%h/.codex/config.toml");
    expect(script).toContain("enable --now bb-codex-computer-timeout.path");
  });
});

describe("backend preparation hook", () => {
  const settings: BoatSettings = {
    apiKey: TEST_KEY,
    size: "small",
    environment: "",
    idleMinutes: 15,
    ttlHours: 2,
    maxConcurrent: 2,
    monthlyCapUsd: 30,
    keepStoppedDays: 12,
  };

  function backendWith(afterReady: (sandboxId: string) => Promise<void>) {
    const boat = new FakeBoat();
    const logs: string[] = [];
    const api = createBoatApi({ apiKey: async () => TEST_KEY, fetch: boat.fetch as typeof fetch, baseUrl: "https://boat.test/api/v1" });
    const backend = createBoatBackend({
      api,
      settings: async () => settings,
      sleep: async () => undefined,
      pollMs: 1,
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      afterReady: (sandboxId) => afterReady(sandboxId),
    });
    const report = { step: () => undefined, log: (m: string) => logs.push(m) };
    return { boat, backend, logs, report };
  }

  test("runs after create and after resume", async () => {
    const prepared: string[] = [];
    const t = backendWith(async (id) => {
      prepared.push(id);
    });
    const handle = await t.backend.create({ key: "k", name: "bb-boat-k", inputs: undefined, ttlMs: 3_600_000, signal: signal(), report: t.report });
    t.boat.sandboxes.get(handle.id)!.state = "archived";
    await t.backend.resume({ name: "bb-boat-k", sandboxId: handle.id, snapshotId: null, meta: {}, ttlMs: 3_600_000, signal: signal(), report: t.report });
    expect(prepared).toEqual([handle.id, handle.id]);
  });

  test("never fails create when preparation fails", async () => {
    const t = backendWith(async () => {
      throw new Error("no systemd");
    });
    const handle = await t.backend.create({ key: "k", name: "bb-boat-k", inputs: undefined, ttlMs: 3_600_000, signal: signal(), report: t.report });
    expect(handle.running).toBe(true);
    expect(t.logs.some((line) => line.includes("couldn't prepare the desktop tools") && line.includes("no systemd"))).toBe(true);
  });
});
