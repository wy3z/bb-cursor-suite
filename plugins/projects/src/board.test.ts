import { afterEach, describe, expect, it } from "vitest";
import { setSystemTime } from "bun:test";
import plugin from "../server";
import { fakeBb } from "../test/fake-bb";

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const at = (iso: string) => new Date(iso);

function boot() {
  const fake = fakeBb();
  plugin(fake.bb as never);
  return fake;
}

async function tickDrift(fake: ReturnType<typeof fakeBb>) {
  const controller = new AbortController();
  const running = Promise.resolve(fake.services.get("board-drift")!.start(controller.signal));
  await settle(60);
  controller.abort();
  await running;
}

function seed(fake: ReturnType<typeof fakeBb>) {
  const recent = new Date(Date.now() - 30 * 60_000).toISOString();
  fake.addTask({ key: "PIXEL-1", status: "in_progress", updatedAt: recent });
  fake.taskThreads.set("task_pixel_1", [{ threadId: "thr_w1", presetName: "Opus", title: "Worker", liveStatus: "idle", attachedAt: recent, updatedAt: recent }]);
  fake.taskPrs.set("task_pixel_1", [{ url: "https://github.com/o/r/pull/3", number: 3, title: "PR", state: "merged", updatedAt: recent, threadIds: ["thr_w1"] }]);
  fake.addTask({ key: "PIXEL-2", status: "todo", updatedAt: recent });
  fake.taskThreads.set("task_pixel_2", [{ threadId: "thr_w2", presetName: "Opus", title: "Worker 2", liveStatus: "working", attachedAt: recent, updatedAt: recent }]);
  fake.addTask({ key: "PIXEL-3", status: "backlog", updatedAt: recent });
  fake.addTask({ key: "PIXEL-4", status: "done", updatedAt: recent });
}

afterEach(() => setSystemTime());

describe("pinned lead instructions", () => {
  it("contribute the lead block only to the project's lead thread", async () => {
    const fake = boot();
    fake.addThread("thr_lead1");
    expect(fake.instructions("thr_lead1")).toBeNull();
    await fake.run(["lead", "PIXEL"], "thr_lead1");
    await settle();
    const block = fake.instructions("thr_lead1")!;
    expect(block).toContain('<project_lead_instructions project="PIXEL">');
    expect(block).toContain("For Review (in_review), In Progress (in_progress), Queued (todo), Done (done), Canceled (canceled)");
    expect(block).toContain("Needs <user>:");
    expect(block).toContain("gh pr merge --merge");
    expect(fake.instructions("thr_other")).toBeNull();
    await fake.run(["lead", "PIXEL", "--thread", "thr_lead2"]);
    await settle();
    expect(fake.instructions("thr_lead1")).toBeNull();
    expect(fake.instructions("thr_lead2")).toContain('project="PIXEL"');
  });

  it("restores lead threads from storage on start", async () => {
    const kv = new Map<string, unknown>([["meta:proj_other", { leadThreadId: "thr_old" }]]);
    const fake = fakeBb({ kv });
    plugin(fake.bb as never);
    await settle();
    expect(fake.instructions("thr_old")).toContain('project="OTHER"');
  });
});

describe("bb projects reconcile", () => {
  it("lists drift with suggested moves and applies only the moves that aren't Done", async () => {
    const fake = boot();
    seed(fake);
    const listed = await fake.run(["reconcile", "PIXEL"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("PIXEL-1 In Progress → Done: PR #3 merged [yours to write]");
    expect(listed.stdout).toContain("PIXEL-2 Queued → In Progress: an agent is running");
    expect(listed.stdout).not.toContain("PIXEL-3");
    expect(fake.updates).toEqual([]);

    const applied = (await fake.run(["reconcile", "PIXEL", "--apply", "--json"])).json();
    expect(applied.applied).toEqual({ moved: ["PIXEL-2"], failed: [] });
    expect(fake.updates).toEqual([{ taskId: "task_pixel_2", status: "in_progress" }]);
    expect(fake.tasks.get("task_pixel_1")!.status).toBe("in_progress");
  });

  it("says so when the board is clean", async () => {
    const fake = boot();
    fake.addTask({ key: "PIXEL-9", status: "todo" });
    expect((await fake.run(["reconcile", "PIXEL"])).stdout).toBe("PIXEL: every card matches its evidence.\n");
  });
});

describe("bb projects queue-backlog", () => {
  it("lists Backlog cards and moves them to todo only with --apply", async () => {
    const fake = boot();
    seed(fake);
    const dry = await fake.run(["queue-backlog", "PIXEL"]);
    expect(dry.stdout).toContain("1 Backlog card would move to Queued:\n- PIXEL-3");
    expect(fake.updates).toEqual([]);
    const done = (await fake.run(["queue-backlog", "PIXEL", "--apply", "--json"])).json();
    expect(done).toEqual({ project: "PIXEL", backlog: ["PIXEL-3"], moved: ["PIXEL-3"], failed: [] });
    expect(fake.updates).toEqual([{ taskId: "task_pixel_3", status: "todo" }]);
  });
});

describe("bb projects status", () => {
  it("counts Cursor's five statuses, folds backlog into Queued and includes sub-tasks", async () => {
    const fake = boot();
    seed(fake);
    fake.addTask({ key: "PIXEL-5", status: "in_progress", parentTaskId: "task_pixel_4", updatedAt: new Date().toISOString() });
    const out = (await fake.run(["status", "PIXEL", "--json"])).json();
    expect(out.counts).toEqual({ in_review: 0, in_progress: 2, todo: 2, done: 1, canceled: 0 });
    expect(out.inFlight.find((item: { key: string }) => item.key === "PIXEL-5").parent).toBe("PIXEL-4");
    expect(out.behind).toBe(2);
  });
});

describe("drift pings", () => {
  it("are off by default and switch per project", async () => {
    const fake = boot();
    expect((await fake.run(["loop", "PIXEL"])).stdout).toContain("Drift pings: off");
    expect((await fake.run(["loop", "PIXEL", "--drift", "on", "--json"])).json().driftPings).toBe(true);
    expect((await fake.run(["loop", "OTHER", "--json"])).json().driftPings).toBe(false);
    expect((await fake.run(["loop", "PIXEL", "--drift", "maybe"])).exitCode).not.toBe(0);
  });

  it("ping an idle lead once drift outlives the grace period, then stay quiet", async () => {
    const fake = boot();
    fake.addThread("thr_lead1");
    await fake.run(["lead", "PIXEL"], "thr_lead1");
    await fake.run(["loop", "PIXEL", "--drift", "on", "--any-hours"]);
    setSystemTime(at("2026-11-10T10:00:00.000Z"));
    seed(fake);

    await tickDrift(fake);
    expect(fake.sent).toEqual([]);

    setSystemTime(at("2026-11-10T10:11:00.000Z"));
    await tickDrift(fake);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.threadId).toBe("thr_lead1");
    expect(fake.sent[0]!.text.split("\n")[0]).toBe("[Board drift] PIXEL");
    expect(fake.sent[0]!.text).toContain("PIXEL-1 In Progress → Done");

    setSystemTime(at("2026-11-10T10:30:00.000Z"));
    await tickDrift(fake);
    expect(fake.sent).toHaveLength(1);
  });

  it("never ping when the board is clean or the setting is off", async () => {
    const clean = boot();
    clean.addThread("thr_lead1");
    await clean.run(["lead", "PIXEL"], "thr_lead1");
    await clean.run(["loop", "PIXEL", "--drift", "on", "--any-hours"]);
    clean.addTask({ key: "PIXEL-9", status: "todo" });
    setSystemTime(at("2026-11-10T10:00:00.000Z"));
    await tickDrift(clean);
    setSystemTime(at("2026-11-10T11:00:00.000Z"));
    await tickDrift(clean);
    expect(clean.sent).toEqual([]);

    const off = boot();
    off.addThread("thr_lead1");
    await off.run(["lead", "PIXEL"], "thr_lead1");
    seed(off);
    setSystemTime(at("2026-11-10T10:00:00.000Z"));
    await tickDrift(off);
    setSystemTime(at("2026-11-10T11:00:00.000Z"));
    await tickDrift(off);
    expect(off.sent).toEqual([]);
  });

  it("hold the ping while the lead is busy and deliver it once it is idle", async () => {
    const fake = boot();
    fake.addThread("thr_lead1", { runtime: { displayStatus: "active" } });
    await fake.run(["lead", "PIXEL"], "thr_lead1");
    await fake.run(["loop", "PIXEL", "--drift", "on", "--any-hours"]);
    setSystemTime(at("2026-11-10T10:00:00.000Z"));
    seed(fake);
    await tickDrift(fake);
    setSystemTime(at("2026-11-10T10:11:00.000Z"));
    await tickDrift(fake);
    expect(fake.sent).toEqual([]);
    fake.threads.get("thr_lead1")!.runtime.displayStatus = "idle";
    setSystemTime(at("2026-11-10T10:17:00.000Z"));
    await tickDrift(fake);
    expect(fake.sent).toHaveLength(1);
  });
});
