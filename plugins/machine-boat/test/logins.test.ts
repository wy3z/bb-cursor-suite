import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoatApi } from "../lib/api.ts";
import { createBoatBackend } from "../lib/backend.ts";
import { LOGIN_PROBE, LOGIN_VARIABLES, createBoatLoginCheck, environmentNote, parseLogins, shareLogins, shareLoginsScript } from "../lib/logins.ts";
import type { BoatSettings } from "../lib/settings.ts";
import { FakeBoat, TEST_KEY } from "./fake-boat.ts";

const SECRET = "sk-ant-oat01-thisisnotarealtokenbutlookslikeone0123456789";

function env(overrides: Record<string, unknown> = {}) {
  return {
    id: "8f1c2d3e-0000-4000-8000-000000000001",
    name: "bb",
    isDefault: false,
    safeForThirdParties: false,
    passGithub: false,
    passSecrets: false,
    passSandboxCredentials: false,
    passAgentsCredentials: true,
    proxyAiCredentials: false,
    envContents: `OPENAI_API_KEY=${SECRET}\n`,
    secretFiles: [],
    versions: [],
    ...overrides,
  };
}

function resource(sandboxId: string | null) {
  return { v: 1, providerId: "boat-sandbox", key: "k", name: "bb-boat-k", state: "running", sandboxId, snapshotId: null, snapshotSandboxId: null, staleSnapshotIds: [], unverifiedSnapshotOps: [], init: "systemd", meta: {} };
}

function context(host: Record<string, unknown> | null) {
  return { host, environmentIntent: null } as never;
}

const ACTIVE = { id: "host_boat", name: "bb-boat-k", machineProviderId: "boat-sandbox", lifecycle: { phase: "active" } };

function setup(environment = "bb") {
  const boat = new FakeBoat();
  const sandbox = boat.add({ name: "bb-boat-k", labels: { "app.getbb.boat-sandbox": "1", "app.getbb.boat-sandbox.name": "bb-boat-k" } });
  const api = createBoatApi({ apiKey: async () => TEST_KEY, fetch: boat.fetch as typeof fetch, baseUrl: "https://boat.test/api/v1" });
  const clock = { t: 1_000_000 };
  const settings = { environment };
  const check = createBoatLoginCheck({ api, settings: async () => settings, resource: async () => resource(sandbox.id), now: () => clock.t });
  return { boat, sandbox, check, clock, settings };
}

function answer(stdout: string) {
  return () => [{ type: "started" }, { type: "stdout", data: stdout }, { type: "exit", exitCode: 0, timedOut: false }];
}

const signal = () => AbortSignal.timeout(10_000);

describe("boat login check on a running VM", () => {
  test("reports the logins the VM itself has, and caches a found login", async () => {
    const t = setup("");
    t.boat.commandScript = answer("login:claude\nlogin:codex\n");
    expect(await t.check(context(ACTIVE), signal())).toEqual({ logins: ["claude", "codex"], note: null });
    expect(await t.check(context(ACTIVE), signal())).toEqual({ logins: ["claude", "codex"], note: null });
    expect(t.boat.commands).toHaveLength(1);
    expect(t.boat.commands[0]!.command).toContain("pgrep");
    expect(t.boat.commands[0]!.command).not.toContain(SECRET);
    t.clock.t += 5 * 60_000;
    await t.check(context(ACTIVE), signal());
    expect(t.boat.commands).toHaveLength(2);
    expect(t.boat.calls("GET", "/environments")).toHaveLength(0);
  });

  test("names what is missing on the VM and re-checks until every login is there", async () => {
    const t = setup();
    t.boat.commandScript = answer("login:claude\n");
    const partial = await t.check(context(ACTIVE), signal());
    expect(partial.logins).toEqual(["claude"]);
    expect(partial.note).toContain("bb-boat-k has only a claude login from boat");
    t.boat.commandScript = answer("");
    const none = await t.check(context(ACTIVE), signal());
    expect(none).toEqual({ logins: [], note: expect.stringContaining("has no agent login from boat") });
    expect(none.note).toContain("boat env upgrade");
    t.boat.commandScript = answer("login:codex\nlogin:claude\n");
    expect(await t.check(context(ACTIVE), signal())).toEqual({ logins: ["claude", "codex"], note: null });
    expect(t.boat.commands).toHaveLength(3);
  });

  test("ignores anything but known login lines", () => {
    expect(parseLogins(`login:claude\nlogin:gemini\n${SECRET}\nlogin:codex extra\n login:codex \n`)).toEqual(["claude", "codex"]);
  });

  test("fails loudly when the probe can't run", async () => {
    const t = setup();
    t.boat.commandScript = () => [{ type: "started" }, { type: "exit", exitCode: 2, timedOut: false }];
    await expect(t.check(context(ACTIVE), signal())).rejects.toThrow("exited with 2");
  });
});

describe("boat login check before the VM exists", () => {
  test("trusts a just-me environment that passes Agents credentials, reading flags only", async () => {
    const t = setup();
    t.boat.environmentList = [env({ name: "base", isDefault: true, passAgentsCredentials: false }), env()];
    expect(await t.check(context(null), signal())).toEqual({ logins: ["claude", "codex"], note: null });
    expect(await t.check(context({ ...ACTIVE, lifecycle: { phase: "suspended" } }), signal())).toEqual({ logins: ["claude", "codex"], note: null });
    expect(t.boat.calls("GET", "/environments")).toHaveLength(1);
    expect(t.boat.commands).toHaveLength(0);
  });

  test("explains each way an environment withholds logins", async () => {
    const t = setup();
    t.boat.environmentList = [env({ passAgentsCredentials: false })];
    expect((await t.check(context(null), signal())).note).toContain('"bb" has Agents credentials off');
    expect(environmentNote("bb", null)).toContain('boat has no environment named "bb"');
    expect(environmentNote("bb", { ...envFlags(), safeForThirdParties: true })).toContain("Safe for third parties");
    expect(environmentNote("bb", { ...envFlags(), safeForThirdParties: true, proxyAiCredentials: true })).toBeNull();
    t.settings.environment = "";
    const empty = await t.check(context(null), signal());
    expect(empty.logins).toEqual([]);
    expect(empty.note).toContain("boat environment setting is empty");
  });

  test("keeps the environment's secret contents out of every answer and error", async () => {
    const t = setup();
    t.boat.environmentList = [env()];
    const report = await t.check(context(null), signal());
    expect(JSON.stringify(report)).not.toContain(SECRET);
    t.clock.t += 61_000;
    t.boat.fail("GET /environments", { status: 500, code: "boom", message: `bad ${TEST_KEY}` });
    const failure = await t.check(context(null), signal()).catch((error: Error) => error.message);
    expect(failure).toContain('couldn\'t read boat environment "bb"');
    expect(failure).not.toContain(TEST_KEY);
  });
});

function envFlags() {
  return {
    name: "bb",
    isDefault: false,
    safeForThirdParties: false,
    passGithub: false,
    passSecrets: false,
    passSandboxCredentials: false,
    passAgentsCredentials: true,
    proxyAiCredentials: false,
  };
}

describe("the probe script", () => {
  function run(home: string) {
    const result = spawnSync("sh", ["-c", LOGIN_PROBE], { env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout };
  }

  test("finds credential files without printing them", () => {
    const home = mkdtempSync(join(tmpdir(), "bb-login-probe-"));
    try {
      expect(run(home)).toEqual({ status: 0, stdout: "" });
      mkdirSync(join(home, ".claude"));
      mkdirSync(join(home, ".codex"));
      writeFileSync(join(home, ".claude", ".credentials.json"), `{"token":"${SECRET}"}`);
      writeFileSync(join(home, ".codex", "auth.json"), "");
      expect(run(home)).toEqual({ status: 0, stdout: "login:claude\n" });
      writeFileSync(join(home, ".codex", "auth.json"), `{"token":"${SECRET}"}`);
      expect(run(home)).toEqual({ status: 0, stdout: "login:claude\nlogin:codex\n" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reads the BB daemon's environment by name, not the probe's own shell", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-login-probe-"));
    const daemon = spawn("bash", ["-c", `exec -a ${home}/.bb-machines/srv/daemon sleep 30`], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_CODE_OAUTH_TOKEN: SECRET },
      stdio: "ignore",
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const shell = spawnSync("sh", ["-c", LOGIN_PROBE], {
        env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_CODE_OAUTH_TOKEN: SECRET },
        encoding: "utf8",
      });
      expect(shell.stdout).toBe("login:claude\n");
      expect(shell.stdout + shell.stderr).not.toContain(SECRET);
      daemon.kill();
      await new Promise((resolve) => daemon.once("exit", resolve));
      const alone = spawnSync("sh", ["-c", LOGIN_PROBE], {
        env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_CODE_OAUTH_TOKEN: SECRET },
        encoding: "utf8",
      });
      expect(alone.stdout).toBe("");
    } finally {
      daemon.kill();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("handing boat's logins to BB's daemon", () => {
  const settings: BoatSettings = {
    apiKey: TEST_KEY,
    size: "small",
    environment: "bb",
    idleMinutes: 15,
    ttlHours: 2,
    maxConcurrent: 2,
    monthlyCapUsd: 30,
    keepStoppedDays: 12,
  };

  test("the script moves a fixed list of variables by name and restarts a stale daemon only on a fresh boot", () => {
    const fresh = shareLoginsScript(true);
    const live = shareLoginsScript(false);
    expect(LOGIN_VARIABLES).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CHATGPT_ACCOUNT_ID"]);
    for (const script of [fresh, live]) {
      expect(script).toContain("for n in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY CHATGPT_ACCOUNT_ID; do");
      expect(script).toContain("systemctl --user import-environment $have");
      expect(script).toContain("systemctl --user unset-environment $gone");
      expect(script).toContain("--state=active 'bb-host-daemon-*.service'");
      expect(script).not.toMatch(/>\s*"?\$HOME|tee |\.config\/environment\.d/);
      expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
    }
    expect(fresh).toContain('if [ -n "$stale" ]; then systemctl --user restart "$u"');
    expect(live).not.toContain("systemctl --user restart");
    expect(live).toContain('if [ -n "$stale" ]; then kept="$kept $u"; fi');
    expect(spawnSync("sh", ["-n"], { input: LOGIN_PROBE }).status).toBe(0);
  });

  test("reports only known names and unit names, never text the VM made up", async () => {
    const boat = new FakeBoat();
    const sandbox = boat.add({ name: "bb-boat-k", labels: {} });
    const api = createBoatApi({ apiKey: async () => TEST_KEY, fetch: boat.fetch as typeof fetch, baseUrl: "https://boat.test/api/v1" });
    boat.commandScript = answer(`noise\nlogins: CLAUDE_CODE_OAUTH_TOKEN ${SECRET} EVIL\nrestarted: bb-host-daemon-x.service ${SECRET}\nkept:\n`);
    const line = await shareLogins(api, sandbox.id, true, signal());
    expect(line).toBe("Boat Sandbox: agent logins from boat for BB's daemon: CLAUDE_CODE_OAUTH_TOKEN; restarted bb-host-daemon-x.service to pick them up");
    expect(boat.commands[0]!.command).toContain("import-environment");
    expect(boat.commands[0]!.command).toContain("systemctl --user restart");
    boat.commandScript = answer("logins:\nrestarted:\nkept: bb-host-daemon-x.service\n");
    expect(await shareLogins(api, sandbox.id, false, signal())).toBe(
      "Boat Sandbox: agent logins from boat for BB's daemon: none; bb-host-daemon-x.service keeps its old logins until the next resume",
    );
    expect(boat.commands[1]!.command).not.toContain("systemctl --user restart");
    boat.commandScript = answer("logins: no systemd user manager\n");
    expect(await shareLogins(api, sandbox.id, true, signal())).toContain("no systemd user manager");
    boat.commandScript = answer("nothing\n");
    await expect(shareLogins(api, sandbox.id, true, signal())).rejects.toThrow("printed nothing");
  });

  test("runs before the desktop step on create and resume, and never fails either", async () => {
    const boat = new FakeBoat();
    const logs: string[] = [];
    const order: string[] = [];
    const api = createBoatApi({ apiKey: async () => TEST_KEY, fetch: boat.fetch as typeof fetch, baseUrl: "https://boat.test/api/v1" });
    let fail = false;
    const backend = createBoatBackend({
      api,
      settings: async () => settings,
      sleep: async () => undefined,
      pollMs: 1,
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      shareLogins: async (id, restart) => {
        order.push(`logins ${id} ${restart ? "boot" : "live"}`);
        if (fail) throw new Error("no user manager");
        return "Boat Sandbox: logins from boat: CLAUDE_CODE_OAUTH_TOKEN";
      },
      afterReady: async (id) => {
        order.push(`desktop ${id}`);
      },
    });
    const report = { step: () => undefined, log: (m: string) => logs.push(m) };
    const handle = await backend.create({ key: "k", name: "bb-boat-k", inputs: undefined, ttlMs: 3_600_000, signal: signal(), report });
    expect(logs).toContain("Boat Sandbox: logins from boat: CLAUDE_CODE_OAUTH_TOKEN");
    boat.sandboxes.get(handle.id)!.state = "archived";
    fail = true;
    const resumed = await backend.resume({ name: "bb-boat-k", sandboxId: handle.id, snapshotId: null, meta: {}, ttlMs: 3_600_000, signal: signal(), report });
    expect(resumed.running).toBe(true);
    boat.sandboxes.get(handle.id)!.state = "running";
    await backend.resume({ name: "bb-boat-k", sandboxId: handle.id, snapshotId: null, meta: {}, ttlMs: 3_600_000, signal: signal(), report });
    expect(order).toEqual([
      `logins ${handle.id} boot`,
      `desktop ${handle.id}`,
      `logins ${handle.id} boot`,
      `desktop ${handle.id}`,
      `logins ${handle.id} live`,
      `desktop ${handle.id}`,
    ]);
    expect(logs.some((line) => line.includes("couldn't hand boat's agent logins to BB's daemon") && line.includes("no user manager"))).toBe(true);
  });
});
