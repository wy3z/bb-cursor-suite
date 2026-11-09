import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoatApi, redactBoat } from "../lib/api.ts";
import { LABEL_MANAGED, LABEL_NAME, boatSandboxName, createBoatBackend, ttlSecondsFor } from "../lib/backend.ts";
import { commandLine, commandSeconds } from "../lib/exec.ts";
import { policyFrom, readBoatSettings, type BoatSettings } from "../lib/settings.ts";
import { FakeBoat, TEST_KEY } from "./fake-boat.ts";

const BASE: BoatSettings = {
  apiKey: TEST_KEY,
  size: "small",
  environment: "",
  idleMinutes: 15,
  ttlHours: 2,
  maxConcurrent: 2,
  monthlyCapUsd: 30,
  keepStoppedDays: 12,
};

function setup(over: Partial<BoatSettings> = {}, clock = { t: Date.parse("2026-11-09T12:00:00Z") }) {
  const boat = new FakeBoat();
  const settings = { ...BASE, ...over };
  const logs: string[] = [];
  const api = createBoatApi({ apiKey: async () => settings.apiKey, fetch: boat.fetch as typeof fetch, baseUrl: "https://boat.test/api/v1" });
  const backend = createBoatBackend({
    api,
    settings: async () => settings,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    pollMs: 10,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  const reports: string[] = [];
  const report = { step: (m: string) => reports.push(m), log: (m: string) => reports.push(m) };
  return { boat, backend, settings, logs, reports, report, clock, api };
}

const signal = () => AbortSignal.timeout(5_000);
const NAME = boatSandboxName("machine-key-1");

describe("settings", () => {
  test("map to the shared policy with the size's hourly rate and 0 meaning off", () => {
    expect(policyFrom(BASE)).toEqual({ idleMinutes: 15, ttlMinutes: 120, maxConcurrent: 2, monthlyCapUsd: 30, hourlyRateUsd: 0.018 });
    const off = policyFrom({ ...BASE, idleMinutes: 0, ttlHours: 0, maxConcurrent: 0, monthlyCapUsd: 0, size: "default" });
    expect(off).toMatchObject({ idleMinutes: null, maxConcurrent: null, monthlyCapUsd: null, hourlyRateUsd: 0.036 });
    expect(off.ttlMinutes).toBeGreaterThan(30 * 24 * 60);
  });

  test("refuse an environment name that could be read as a flag or path", () => {
    expect(() => readBoatSettings({ environment: "--all" })).toThrow(/valid name/);
    expect(() => readBoatSettings({ environment: "../x" })).toThrow(/valid name/);
    expect(readBoatSettings({ environment: "customer-demos", size: "nope" as never }).size).toBe("small");
  });

  test("a TTL past boat's 30-day maximum becomes no auto-stop", () => {
    expect(ttlSecondsFor(2 * 3_600_000)).toBe(7200);
    expect(ttlSecondsFor(525_600 * 60_000)).toBeNull();
  });
});

describe("api", () => {
  test("redacts the key, boat keys and URL tokens from messages", () => {
    expect(redactBoat(`bad ${TEST_KEY} x`, TEST_KEY)).toBe("bad [redacted] x");
    expect(redactBoat("see https://d.example/s?token=abc123&x=1")).toContain("token=[redacted]");
    expect(redactBoat("key boat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123")).not.toContain("boat_ABC");
  });

  test("an error that echoes the Authorization header never surfaces the key", async () => {
    const { backend, boat, report } = setup({ ttlHours: 0 });
    boat.trialTtlCap = 60;
    const failure = await backend.create({ key: "k", name: NAME, inputs: undefined as never, ttlMs: 525_600 * 60_000, signal: signal(), report }).catch((error: Error) => error);
    expect(String(failure)).not.toContain(TEST_KEY);
    expect(String(failure)).toContain("trial_auto_stop_required");
  });

  test("the key travels only in the Authorization header", async () => {
    const { backend, boat, report } = setup();
    await backend.create({ key: "k", name: NAME, inputs: undefined as never, ttlMs: 7_200_000, signal: signal(), report });
    for (const request of boat.requests) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
      expect(request.path + request.search.toString()).not.toContain(TEST_KEY);
      expect(JSON.stringify(request.body ?? {})).not.toContain(TEST_KEY);
    }
  });
});

describe("create", () => {
  test("labels the sandbox, keeps account secrets out, turns monitoring off and waits until ready", async () => {
    const { backend, boat, report } = setup();
    const handle = await backend.create({ key: "k", name: NAME, inputs: undefined as never, ttlMs: 7_200_000, signal: signal(), report });
    const [post] = boat.calls("POST", "/sandboxes");
    expect(post!.body).toMatchObject({
      name: NAME,
      type: "small",
      ttlSeconds: 7200,
      monitoring: false,
      noEnv: true,
      labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: NAME },
    });
    expect(post!.body).not.toHaveProperty("environment");
    expect(post!.headers.get("idempotency-key")).toStartWith(`${NAME}-`);
    expect(handle).toMatchObject({ running: true, meta: { size: "small" } });
    expect(boat.sandboxes.get(handle.id)!.state).toBe("ready");
  });

  test("a named boat environment replaces noEnv", async () => {
    const { backend, boat, report } = setup({ environment: "base" });
    await backend.create({ key: "k", name: NAME, inputs: undefined as never, ttlMs: 7_200_000, signal: signal(), report });
    expect(boat.calls("POST", "/sandboxes")[0]!.body).toMatchObject({ environment: "base" });
    expect(boat.calls("POST", "/sandboxes")[0]!.body).not.toHaveProperty("noEnv");
  });

  test("falls back to the trial's 2-hour auto-stop when boat refuses a longer one", async () => {
    const { backend, boat, report } = setup({ ttlHours: 0 });
    const handle = await backend.create({ key: "k", name: NAME, inputs: undefined as never, ttlMs: 525_600 * 60_000, signal: signal(), report });
    const bodies = boat.calls("POST", "/sandboxes").map((call) => call.body!.ttlSeconds);
    expect(bodies).toEqual([null, 7200]);
    expect(boat.sandboxes.get(handle.id)!.ttlSeconds).toBe(7200);
  });

  test("refuses before calling boat when this month's spend reached the cap", async () => {
    const { backend, boat, report } = setup({ monthlyCapUsd: 1 });
    boat.add({ name: "old", state: "archived", labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: "old" }, costUsd: 0.6 });
    boat.deletedCostUsd = 0.5;
    await expect(backend.create({ key: "k", name: NAME, inputs: undefined as never, ttlMs: 7_200_000, signal: signal(), report })).rejects.toThrow(
      /monthly cap of \$1\.00 is reached \(\$1\.10/,
    );
    expect(boat.calls("POST", "/sandboxes")).toHaveLength(0);
    expect(await backend.validate!(undefined as never)).toMatchObject({ action: "refuse" });
  });

  test("ignores sandboxes without the plugin's label when adding up spend", async () => {
    const { backend, boat } = setup({ monthlyCapUsd: 1 });
    boat.add({ name: "mine-elsewhere", costUsd: 50 });
    expect((await backend.spend()).usd).toBe(0);
  });
});

describe("listByName", () => {
  test("finds only sandboxes carrying both labels for that name, in every state", async () => {
    const { backend, boat } = setup();
    const mine = boat.add({ name: NAME, state: "archived", labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: NAME } });
    boat.add({ name: NAME, labels: { [LABEL_NAME]: NAME } });
    boat.add({ name: "other", labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: "other" } });
    const found = await backend.listByName(NAME, signal());
    expect(found.map((handle) => handle.id)).toEqual([mine.id]);
    expect(found[0]!.running).toBe(false);
    expect(boat.calls("GET", "/sandboxes")[0]!.search.get("state")).toContain("archived");
  });
});

describe("exec", () => {
  test("quotes argv for bash -lc so every argument arrives intact, and clamps the timeout to boat's 600 s", () => {
    const home = mkdtempSync(join(tmpdir(), "boat-exec-"));
    const argv = ["printf", "[%s]", "a b", "it's", "$HOME", "`id`", "--flag"];
    const run = spawnSync("sh", ["-c", commandLine(argv, null)], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }, encoding: "utf8" });
    rmSync(home, { recursive: true, force: true });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("[a b][it's][$HOME][`id`][--flag]");
    expect(commandSeconds(15_000)).toBe(15);
    expect(commandSeconds(600_000)).toBe(600);
    expect(commandSeconds(3_600_000)).toBe(600);
  });

  test("passes stdin through a temporary file, never in the command, and streams output", async () => {
    const { backend, boat } = setup();
    const sandbox = boat.add({ name: NAME });
    let seen: string | null = null;
    boat.commandScript = (_command, stdin) => {
      seen = stdin;
      return [{ type: "started" }, { type: "stdout", data: "hello\n" }, { type: "exit", exitCode: 3, timedOut: false }];
    };
    const output: string[] = [];
    const secret = JSON.stringify({ token: "enrolment-secret-value" });
    const result = await backend.exec(sandbox.id, {
      command: ["sh", "-c", "cat", "bb-machine-install", "https://bb.example/install.sh"],
      stdin: secret,
      timeoutMs: 600_000,
      signal: signal(),
      onOutput: (chunk) => output.push(chunk),
    });
    expect(result).toEqual({ exitCode: 3 });
    expect(output.join("")).toBe("hello\n");
    expect(seen).toBe(secret);
    expect(boat.commands[0]!.command).not.toContain("enrolment-secret-value");
    expect(boat.commands[0]!.command).toMatch(/rm -f .*\/tmp\/\.bb-boat-stdin-/);
    expect(boat.commands[0]!.timeoutSeconds).toBe(600);
    expect([...boat.files.keys()]).toHaveLength(0);
  });

  test("retries a command that never ran while the disk restores, and removes the stdin file if it never runs", async () => {
    const { backend, boat } = setup();
    const sandbox = boat.add({ name: NAME });
    let calls = 0;
    boat.commandScript = () => {
      calls += 1;
      return calls === 1
        ? [{ type: "started" }, { type: "error", error: "sandbox_direct_failed", message: "sandbox_restoring", retryable: true }]
        : [{ type: "started" }, { type: "exit", exitCode: 0, timedOut: false }];
    };
    const request = { command: ["true"], stdin: "x", timeoutMs: 10_000, signal: signal(), onOutput: () => undefined };
    expect(await backend.exec(sandbox.id, request)).toEqual({ exitCode: 0 });
    expect(calls).toBe(2);
    boat.commandScript = () => [{ type: "error", error: "boom", message: "agent unavailable", retryable: false }];
    await expect(backend.exec(sandbox.id, request)).rejects.toThrow(/agent unavailable/);
    expect([...boat.files.keys()]).toHaveLength(0);
  });

  test("a timed-out command reports 124", async () => {
    const { backend, boat } = setup();
    const sandbox = boat.add({ name: NAME });
    boat.commandScript = () => [{ type: "started" }, { type: "exit", exitCode: null, timedOut: true }];
    expect(await backend.exec(sandbox.id, { command: ["sleep", "999"], stdin: "", timeoutMs: 1000, signal: signal(), onOutput: () => undefined })).toEqual({
      exitCode: 124,
    });
  });
});

describe("suspend and resume", () => {
  test("stop waits until boat has archived the disk and keeps the sandbox id", async () => {
    const { backend, boat, report } = setup();
    const sandbox = boat.add({ name: NAME, labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: NAME }, pollsUntilArchived: 2 });
    expect(await backend.snapshot({ sandboxId: sandbox.id, name: NAME, operationKey: "op", signal: signal(), report })).toEqual({ snapshotId: null });
    expect(await backend.stop({ sandboxId: sandbox.id, name: NAME, signal: signal(), report })).toEqual({ sandboxId: sandbox.id });
    expect(sandbox.state).toBe("archived");
  });

  test("resume restarts the same sandbox, applies the TTL and a changed size, and drops a stale keep snapshot", async () => {
    const { backend, boat, report } = setup({ size: "default" });
    const sandbox = boat.add({ name: NAME, state: "archived", labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: NAME } });
    boat.saved.set(NAME, { name: NAME, status: "ready", sourceSandboxId: sandbox.id, createdAt: "2026-11-01T00:00:00Z" });
    const handle = await backend.resume({ name: NAME, sandboxId: sandbox.id, snapshotId: null, meta: {}, ttlMs: 7_200_000, signal: signal(), report });
    expect(handle.id).toBe(sandbox.id);
    expect(boat.calls("POST", `/sandboxes/${sandbox.id}/resume`)[0]!.body).toEqual({ ttlSeconds: 7200, type: "default" });
    expect(sandbox.state).toBe("ready");
    expect(boat.saved.has(NAME)).toBe(false);
  });

  test("resume waits out a stop that is still finishing", async () => {
    const { backend, boat, report } = setup();
    const sandbox = boat.add({ name: NAME, state: "archived", labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: NAME } });
    boat.fail("POST /sandboxes/:id/resume", { status: 409, code: "sandbox_stopping", retryAfter: 3, times: 1 });
    await backend.resume({ name: NAME, sandboxId: sandbox.id, snapshotId: null, meta: {}, ttlMs: 7_200_000, signal: signal(), report });
    expect(boat.calls("POST", `/sandboxes/${sandbox.id}/resume`)).toHaveLength(2);
  });

  test("resume restores from the keep snapshot once boat has cleaned up the disk", async () => {
    const { backend, boat, report } = setup();
    const old = boat.add({ name: NAME, state: "archived", labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: NAME }, dataExpiredAt: "2026-11-08T00:00:00Z" });
    boat.saved.set(NAME, { name: NAME, status: "ready", sourceSandboxId: old.id, createdAt: "2026-11-01T00:00:00Z" });
    const handle = await backend.resume({ name: NAME, sandboxId: old.id, snapshotId: null, meta: {}, ttlMs: 7_200_000, signal: signal(), report });
    expect(handle.id).not.toBe(old.id);
    expect(boat.calls("POST", "/sandboxes")[0]!.body).toMatchObject({ from: NAME, labels: { [LABEL_NAME]: NAME } });
    expect(boat.sandboxes.has(old.id)).toBe(false);
  });

  test("resume fails clearly when the disk is gone and nothing was kept", async () => {
    const { backend, boat, report } = setup();
    const old = boat.add({ name: NAME, state: "archived", labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: NAME } });
    boat.fail("POST /sandboxes/:id/resume", { status: 409, code: "snapshot_data_expired" });
    await expect(
      backend.resume({ name: NAME, sandboxId: old.id, snapshotId: null, meta: {}, ttlMs: 7_200_000, signal: signal(), report }),
    ).rejects.toThrow(/no saved snapshot named/);
  });

  test("resume refuses a sandbox that lacks the plugin's labels", async () => {
    const { backend, boat, report } = setup();
    const foreign = boat.add({ name: NAME, state: "archived", labels: {} });
    await expect(
      backend.resume({ name: NAME, sandboxId: foreign.id, snapshotId: null, meta: {}, ttlMs: 7_200_000, signal: signal(), report }),
    ).rejects.toThrow(/didn't create/);
    expect(boat.calls("POST", `/sandboxes/${foreign.id}/resume`)).toHaveLength(0);
  });

  test("extendTtl sets a fresh deadline and caps it on the trial", async () => {
    const { backend, boat } = setup();
    const sandbox = boat.add({ name: NAME });
    const { expiresAt } = await backend.extendTtl!({ sandboxId: sandbox.id, name: NAME, ttlMs: 525_600 * 60_000, signal: signal() });
    expect(expiresAt).toBe(Date.parse("2026-11-09T16:00:00.000Z"));
    expect(boat.calls("PATCH", `/sandboxes/${sandbox.id}`).map((call) => call.body!.ttlSeconds)).toEqual([null, 7200]);
  });
});

describe("remove", () => {
  test("deletes every labelled sandbox, given snapshots and the keep snapshot, and tolerates ones already gone", async () => {
    const { backend, boat, report } = setup();
    const a = boat.add({ name: NAME, labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: NAME } });
    const b = boat.add({ name: NAME, state: "archived", labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: NAME } });
    const bystander = boat.add({ name: "keep me" });
    boat.saved.set(NAME, { name: NAME, status: "ready", sourceSandboxId: b.id, createdAt: "x" });
    await backend.remove({ name: NAME, sandboxIds: [a.id, "bx_gone0000"], snapshotIds: ["snap_1"], signal: signal(), report });
    expect(boat.sandboxes.has(a.id)).toBe(false);
    expect(boat.sandboxes.has(b.id)).toBe(false);
    expect(boat.sandboxes.has(bystander.id)).toBe(true);
    expect(boat.saved.size).toBe(0);
    expect(boat.calls("DELETE", "/snapshots/snap_1")).toHaveLength(1);
    expect(await backend.listByName(NAME, signal())).toEqual([]);
  });
});

describe("availability", () => {
  test("asks for a key, reports a rejected key, a locked size, a missing plan and a reached cap", async () => {
    expect(await setup({ apiKey: "" }).backend.availability!()).toMatchObject({ status: "setup-required", message: expect.stringContaining("API key") });
    expect(await setup({ apiKey: "boat_wrong_key_wrong_key_wrong_key" }).backend.availability!()).toMatchObject({
      status: "setup-required",
      message: expect.stringContaining("rejected"),
    });
    expect(await setup({ size: "large" }).backend.availability!()).toMatchObject({ status: "setup-required", message: expect.stringContaining("not during the free trial") });
    const plan = setup();
    plan.boat.limits.checkoutRequired = true;
    expect(await plan.backend.availability!()).toMatchObject({ status: "setup-required", message: expect.stringContaining("no plan") });
    const capped = setup({ monthlyCapUsd: 0.5 });
    capped.boat.deletedCostUsd = 0.5;
    expect(await capped.backend.availability!()).toMatchObject({ status: "unavailable", message: expect.stringContaining("monthly cap") });
    expect(await setup().backend.availability!()).toEqual({ status: "available" });
  });

  test("a key without account.read still works", async () => {
    const { backend, boat } = setup();
    boat.fail("GET /limits", { status: 403, code: "forbidden" });
    expect(await backend.availability!()).toEqual({ status: "available" });
  });
});

describe("keepStopped", () => {
  test("saves a snapshot for sandboxes stopped longer than the setting, once per stop", async () => {
    const { backend, boat, clock } = setup();
    clock.t = Date.parse("2026-11-20T00:00:00Z");
    const old = boat.add({ name: NAME, state: "archived", stoppedAt: "2026-11-05T00:00:00Z", labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: NAME } });
    boat.add({ name: "recent", state: "archived", stoppedAt: "2026-11-19T00:00:00Z", labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: "recent" } });
    boat.add({ name: "foreign", state: "archived", stoppedAt: "2026-11-01T00:00:00Z" });
    boat.nowIso = "2026-11-20T00:00:00Z";
    expect(await backend.keepStopped()).toEqual([{ name: NAME, sandboxId: old.id, outcome: "saved" }]);
    expect(await backend.keepStopped()).toEqual([{ name: NAME, sandboxId: old.id, outcome: "current" }]);
    expect([...boat.saved.keys()]).toEqual([NAME]);
  });

  test("reports a failed save (trial, empty wallet) without throwing, and does nothing when off", async () => {
    const { backend, boat, clock, logs } = setup();
    clock.t = Date.parse("2026-11-20T00:00:00Z");
    boat.add({ name: NAME, state: "archived", stoppedAt: "2026-11-01T00:00:00Z", labels: { [LABEL_MANAGED]: "1", [LABEL_NAME]: NAME } });
    boat.fail("POST /saved-snapshots", { status: 402, code: "credit_required", message: "wallet empty" });
    expect((await backend.keepStopped())[0]).toMatchObject({ outcome: "failed" });
    expect(logs.join("\n")).toContain("credit_required");
    expect(await setup({ keepStoppedDays: 0 }).backend.keepStopped()).toEqual([]);
  });
});
