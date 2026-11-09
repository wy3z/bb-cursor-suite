import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoatApi } from "../lib/api.ts";
import { createBoatBackend } from "../lib/backend.ts";
import {
  BUSY_AWK,
  LOGIN_PROBE,
  LOGIN_VARIABLES,
  STALE_FN,
  createBoatLoginCheck,
  environmentNote,
  parseLogins,
  sandboxEnvironmentNote,
  shareLogins,
  shareLoginsScript,
} from "../lib/logins.ts";
import type { BoatSettings } from "../lib/settings.ts";
import { FakeBoat, TEST_KEY } from "./fake-boat.ts";

const SECRET = "sk-ant-oat01-thisisnotarealtokenbutlookslikeone0123456789";

function env(overrides: Record<string, unknown> = {}) {
  return {
    id: "8f1c2d3e-0000-4000-8000-000000000001",
    name: "bb",
    isDefault: false,
    latestVersionNumber: 2,
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

function flags(overrides: Record<string, unknown> = {}) {
  return {
    name: "bb",
    isDefault: false,
    latestVersionNumber: 2,
    safeForThirdParties: false,
    passGithub: false,
    passSecrets: false,
    passSandboxCredentials: false,
    passAgentsCredentials: true,
    ...overrides,
  };
}

function resource(sandboxId: string | null) {
  return { v: 1, providerId: "boat-sandbox", key: "k", name: "bb-boat-k", state: "running", sandboxId, snapshotId: null, snapshotSandboxId: null, staleSnapshotIds: [], unverifiedSnapshotOps: [], init: "systemd", meta: {} };
}

function context(host: Record<string, unknown> | null, providerId = "claude-code") {
  return { host, environmentIntent: null, requestedExecution: { providerId } } as never;
}

const ACTIVE = { id: "host_boat", name: "bb-boat-k", machineProviderId: "boat-sandbox", lifecycle: { phase: "active" } };
const SUSPENDED = { ...ACTIVE, lifecycle: { phase: "suspended" } };

function setup(environment = "bb") {
  const boat = new FakeBoat();
  const sandbox = boat.add({
    name: "bb-boat-k",
    labels: { "app.getbb.boat-sandbox": "1", "app.getbb.boat-sandbox.name": "bb-boat-k" },
    environment: "bb",
    environmentVersion: 2,
  });
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
  test("reports the logins the VM itself has and caches each one for the provider that needs it", async () => {
    const t = setup("");
    t.boat.commandScript = answer("login:claude\n");
    expect(await t.check(context(ACTIVE), signal())).toEqual({ logins: ["claude"], note: null });
    expect(await t.check(context(ACTIVE), signal())).toEqual({ logins: ["claude"], note: null });
    expect(t.boat.commands).toHaveLength(1);
    expect(t.boat.commands[0]!.command).toContain("pgrep");
    expect(t.boat.commands[0]!.command).not.toContain(SECRET);
    const codex = await t.check(context(ACTIVE, "codex"), signal());
    expect(codex.logins).toEqual(["claude"]);
    expect(codex.note).toContain("bb-boat-k has only a claude login from boat");
    expect(t.boat.commands).toHaveLength(2);
    t.clock.t += 5 * 60_000;
    await t.check(context(ACTIVE), signal());
    expect(t.boat.commands).toHaveLength(3);
    expect(t.boat.calls("GET", "/environments")).toHaveLength(0);
  });

  test("tells the user to suspend and resume, not just upgrade, and re-checks until the login is there", async () => {
    const t = setup();
    t.boat.commandScript = answer("");
    const none = await t.check(context(ACTIVE), signal());
    expect(none.logins).toEqual([]);
    expect(none.note).toContain("bb-boat-k has no agent login from boat");
    expect(none.note).toContain('make sure "bb" passes Agents credentials');
    expect(none.note).toContain("then suspend and resume bb-boat-k");
    t.boat.commandScript = answer("login:claude\n");
    expect(await t.check(context(ACTIVE), signal())).toEqual({ logins: ["claude"], note: null });
    expect(t.boat.commands).toHaveLength(2);
  });

  test("tells the user to delete a VM that was made without an environment", async () => {
    const t = setup();
    t.sandbox.environment = null;
    t.boat.commandScript = answer("");
    expect((await t.check(context(ACTIVE), signal())).note).toContain("it was created without a boat environment. Delete it");
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

describe("boat login check on a suspended VM", () => {
  test("goes by the environment the VM itself was created in, not the setting", async () => {
    const t = setup("");
    t.boat.environmentList = [env()];
    expect(await t.check(context(SUSPENDED), signal())).toEqual({ logins: ["claude", "codex"], note: null });
    expect(t.boat.commands).toHaveLength(0);
  });

  test("blocks a VM made without an environment, or one whose switches can't be read", async () => {
    const t = setup();
    t.boat.environmentList = [env()];
    t.sandbox.environment = null;
    t.sandbox.environmentVersion = null;
    expect((await t.check(context(SUSPENDED), signal())).note).toContain("was created without a boat environment");
    t.sandbox.environment = "bb";
    t.sandbox.environmentVersion = 1;
    const old = await t.check(context(SUSPENDED), signal());
    expect(old.logins).toEqual([]);
    expect(old.note).toContain('is on version 1 of boat environment "bb" (latest 2)');
    expect(old.note).toContain("boat env upgrade bb");
    t.sandbox.environment = "gone";
    expect((await t.check(context(SUSPENDED), signal())).note).toContain('"gone", which no longer exists');
  });

  test("lets an unreadable VM throw so the guard blocks", async () => {
    const t = setup();
    t.boat.fail("GET /sandboxes/:id", { status: 500, code: "boom", message: `bad ${TEST_KEY}` });
    const failure = await t.check(context(SUSPENDED), signal()).catch((error: Error) => error.message);
    expect(failure).toContain("boom");
    expect(failure).not.toContain(TEST_KEY);
  });
});

describe("boat login check before the VM exists", () => {
  test("trusts a just-me environment that passes Agents credentials, reading flags only", async () => {
    const t = setup();
    t.boat.environmentList = [env({ name: "base", isDefault: true, passAgentsCredentials: false }), env()];
    expect(await t.check(context(null), signal())).toEqual({ logins: ["claude", "codex"], note: null });
    expect(await t.check(context(null), signal())).toEqual({ logins: ["claude", "codex"], note: null });
    expect(t.boat.calls("GET", "/environments")).toHaveLength(1);
    expect(t.boat.commands).toHaveLength(0);
  });

  test("explains each way an environment withholds logins, proxy mode included", async () => {
    const t = setup();
    t.boat.environmentList = [env({ passAgentsCredentials: false })];
    expect((await t.check(context(null), signal())).note).toContain('"bb" has Agents credentials off');
    expect(environmentNote("bb", null)).toContain('boat has no environment named "bb"');
    expect(environmentNote("bb", flags({ safeForThirdParties: true }))).toContain("Safe for third parties");
    expect(environmentNote("bb", { ...flags({ safeForThirdParties: true }), proxyAiCredentials: true } as never)).toContain("Safe for third parties");
    expect(sandboxEnvironmentNote("vm", { environment: "bb", environmentVersion: 2 }, flags())).toBeNull();
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
    expect(failure).toContain("couldn't read boat's environments");
    expect(failure).not.toContain(TEST_KEY);
  });
});

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

  test("the script moves a fixed list of variables by name and restarts only an idle, stale daemon on a fresh boot", () => {
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
    expect(fresh).toContain("systemctl --user is-system-running --wait");
    expect(fresh).toContain('systemctl --user restart "$u"');
    expect(fresh.indexOf("awk -v root")).toBeLessThan(fresh.indexOf('systemctl --user restart "$u"'));
    for (const script of [fresh, live]) {
      expect(script).toContain(STALE_FN);
      expect(script).toContain('[ -n "$(stale_for "$p")" ] || continue');
      expect(script).not.toMatch(/echo[^\n]*\$\{!n|printf[^\n]*\$dv/);
    }
    expect(live).not.toContain("systemctl --user restart");
    expect(live).not.toContain("is-system-running");
    expect(spawnSync("sh", ["-n"], { input: LOGIN_PROBE }).status).toBe(0);
  });

  test("the stale check compares values on the VM and prints only a verdict", async () => {
    const other = "sk-ant-oat01-rotatedtokenthatdiffersfromtheold000000000";
    const daemon = spawn("sleep", ["30"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_CODE_OAUTH_TOKEN: SECRET, CHATGPT_ACCOUNT_ID: "acct" }, stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const check = (have: string, gone: string, value: string | null) => {
        const result = spawnSync("bash", ["-c", `set -u\nhave="${have}"\ngone="${gone}"\n${STALE_FN}\nstale_for ${daemon.pid}`], {
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(value === null ? {} : { CLAUDE_CODE_OAUTH_TOKEN: value }), CHATGPT_ACCOUNT_ID: "acct" },
          encoding: "utf8",
        });
        expect(result.stdout + result.stderr).not.toContain(SECRET);
        expect(result.stdout + result.stderr).not.toContain(other);
        return result.stdout.trim();
      };
      expect(check(" CLAUDE_CODE_OAUTH_TOKEN CHATGPT_ACCOUNT_ID", " OPENAI_API_KEY", SECRET)).toBe("");
      expect(check(" CLAUDE_CODE_OAUTH_TOKEN", " OPENAI_API_KEY", other)).toBe("stale");
      expect(check(" CLAUDE_CODE_OAUTH_TOKEN", " CHATGPT_ACCOUNT_ID", SECRET)).toBe("stale");
      expect(check(" ANTHROPIC_API_KEY", "", null)).toBe("stale");
    } finally {
      daemon.kill();
    }
  });

  test("the busy check sees an agent CLI anywhere under the daemon, and nothing else", () => {
    const busy = (ps: string, root: string) => spawnSync("awk", ["-v", `root=${root}`, BUSY_AWK], { input: ps, encoding: "utf8" }).stdout.trim();
    const tree = ["1 0 systemd", "100 1 node", "110 100 node", "120 110 claude", "200 1 bash", "210 200 codex", "300 100 git"].join("\n");
    expect(busy(tree, "100")).toBe("busy");
    expect(busy(tree.replace("120 110 claude", "120 110 rg"), "100")).toBe("");
    expect(busy(tree, "200")).toBe("busy");
    expect(busy(tree, "300")).toBe("");
  });

  test("reports only known names and unit names, never text the VM made up", async () => {
    const boat = new FakeBoat();
    const sandbox = boat.add({ name: "bb-boat-k", labels: {} });
    const api = createBoatApi({ apiKey: async () => TEST_KEY, fetch: boat.fetch as typeof fetch, baseUrl: "https://boat.test/api/v1" });
    boat.commandScript = answer(`noise\nlogins: CLAUDE_CODE_OAUTH_TOKEN ${SECRET} EVIL\nrestarted: bb-host-daemon-x.service ${SECRET}\nkept:\n`);
    expect(await shareLogins(api, sandbox.id, true, signal())).toEqual({
      message: "Boat Sandbox: agent logins from boat for BB's daemon: CLAUDE_CODE_OAUTH_TOKEN; restarted bb-host-daemon-x.service to pick them up",
      variables: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });
    expect(boat.commands[0]!.command).toContain("import-environment");
    boat.commandScript = answer("logins:\nrestarted:\nkept: bb-host-daemon-x.service\n");
    expect((await shareLogins(api, sandbox.id, false, signal())).message).toBe(
      "Boat Sandbox: agent logins from boat for BB's daemon: none; bb-host-daemon-x.service keeps its old logins until it is suspended and resumed",
    );
    expect(boat.commands[1]!.command).not.toContain("systemctl --user restart");
    boat.commandScript = answer("logins: no systemd user manager\n");
    expect(await shareLogins(api, sandbox.id, true, signal())).toEqual({ message: expect.stringContaining("no systemd user manager"), variables: [] });
    boat.commandScript = answer("nothing\n");
    await expect(shareLogins(api, sandbox.id, true, signal())).rejects.toThrow("printed nothing");
  });

  function backendWith(share: (id: string, restart: boolean) => Promise<{ message: string; variables: string[] }>, environment = "bb") {
    const boat = new FakeBoat();
    const logs: string[] = [];
    const warnings: string[] = [];
    const order: string[] = [];
    const api = createBoatApi({ apiKey: async () => TEST_KEY, fetch: boat.fetch as typeof fetch, baseUrl: "https://boat.test/api/v1" });
    const backend = createBoatBackend({
      api,
      settings: async () => ({ ...settings, environment }),
      sleep: async () => undefined,
      pollMs: 1,
      log: { info: (m) => logs.push(m), warn: (m) => warnings.push(m) },
      shareLogins: async (id, restart) => {
        order.push(`logins ${id} ${restart ? "boot" : "live"}`);
        return share(id, restart);
      },
      afterReady: async (id) => {
        order.push(`desktop ${id}`);
      },
    });
    const report = { step: () => undefined, log: (m: string) => logs.push(m) };
    return { boat, backend, logs, warnings, order, report };
  }

  test("runs before the desktop step on create and resume, restarting only after a boot, and never fails either", async () => {
    let fail = false;
    const t = backendWith(async () => {
      if (fail) throw new Error("no user manager");
      return { message: "Boat Sandbox: agent logins from boat for BB's daemon: CLAUDE_CODE_OAUTH_TOKEN", variables: ["CLAUDE_CODE_OAUTH_TOKEN"] };
    });
    t.boat.environmentList = [env()];
    const handle = await t.backend.create({ key: "k", name: "bb-boat-k", inputs: undefined, ttlMs: 3_600_000, signal: signal(), report: t.report });
    expect(t.logs).toContain("Boat Sandbox: agent logins from boat for BB's daemon: CLAUDE_CODE_OAUTH_TOKEN");
    expect(t.warnings).toEqual([]);
    t.boat.sandboxes.get(handle.id)!.state = "archived";
    fail = true;
    const resumed = await t.backend.resume({ name: "bb-boat-k", sandboxId: handle.id, snapshotId: null, meta: {}, ttlMs: 3_600_000, signal: signal(), report: t.report });
    expect(resumed.running).toBe(true);
    t.boat.sandboxes.get(handle.id)!.state = "running";
    await t.backend.resume({ name: "bb-boat-k", sandboxId: handle.id, snapshotId: null, meta: {}, ttlMs: 3_600_000, signal: signal(), report: t.report });
    expect(t.order).toEqual([
      `logins ${handle.id} boot`,
      `desktop ${handle.id}`,
      `logins ${handle.id} boot`,
      `desktop ${handle.id}`,
      `logins ${handle.id} live`,
      `desktop ${handle.id}`,
    ]);
    expect(t.warnings.some((line) => line.includes("couldn't hand boat's agent logins to BB's daemon") && line.includes("no user manager"))).toBe(true);
  });

  test("warns when a VM in a named environment gets no login, and stays quiet without one", async () => {
    const t = backendWith(async () => ({ message: "Boat Sandbox: agent logins from boat for BB's daemon: none", variables: [] }));
    t.boat.environmentList = [env()];
    await t.backend.create({ key: "k", name: "bb-boat-k", inputs: undefined, ttlMs: 3_600_000, signal: signal(), report: t.report });
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain('runs boat environment "bb" but boat gave it no agent login');
    expect(t.logs).toContain(t.warnings[0]!);
    const quiet = backendWith(async () => ({ message: "none", variables: [] }), "");
    await quiet.backend.create({ key: "k", name: "bb-boat-k", inputs: undefined, ttlMs: 3_600_000, signal: signal(), report: quiet.report });
    expect(quiet.warnings).toEqual([]);
    expect(quiet.boat.calls("GET", "/environments")).toHaveLength(0);
  });

  test("warns on create for each extra switch the environment has on", async () => {
    const ok = { message: "logins", variables: ["CLAUDE_CODE_OAUTH_TOKEN"] };
    const t = backendWith(async () => ok);
    t.boat.environmentList = [env({ passGithub: true, passSecrets: true, passSandboxCredentials: true })];
    await t.backend.create({ key: "k", name: "bb-boat-k", inputs: undefined, ttlMs: 3_600_000, signal: signal(), report: t.report });
    expect(t.warnings).toHaveLength(3);
    expect(t.warnings[0]).toContain('boat environment "bb" passes GitHub');
    expect(t.warnings[1]).toContain("passes Secrets");
    expect(t.warnings[2]).toContain("passes boat credentials");
    for (const line of t.warnings) expect(t.logs).toContain(line);
    expect(JSON.stringify(t.logs)).not.toContain(SECRET);
    const clean = backendWith(async () => ok);
    clean.boat.environmentList = [env()];
    await clean.backend.create({ key: "k", name: "bb-boat-k", inputs: undefined, ttlMs: 3_600_000, signal: signal(), report: clean.report });
    expect(clean.warnings).toEqual([]);
    const unreadable = backendWith(async () => ok);
    unreadable.boat.fail("GET /environments", { status: 403, code: "api_key_action_forbidden" });
    const handle = await unreadable.backend.create({ key: "k", name: "bb-boat-k", inputs: undefined, ttlMs: 3_600_000, signal: signal(), report: unreadable.report });
    expect(handle.running).toBe(true);
    expect(unreadable.warnings[0]).toContain("couldn't read boat environment \"bb\" to check what it passes");
  });
});
