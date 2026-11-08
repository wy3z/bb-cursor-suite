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
  fake.addTask({ key: "ABC-1", status: "in_progress", updatedAt: recent });
  fake.taskThreads.set("task_abc_1", [{ threadId: "thr_w1", presetName: "Opus", title: "Worker", liveStatus: "idle", attachedAt: recent, updatedAt: recent }]);
  fake.taskPrs.set("task_abc_1", [{ url: "https://github.com/o/r/pull/3", number: 3, title: "PR", state: "merged", updatedAt: recent, threadIds: ["thr_w1"] }]);
  fake.addTask({ key: "ABC-2", status: "todo", updatedAt: recent });
  fake.taskThreads.set("task_abc_2", [{ threadId: "thr_w2", presetName: "Opus", title: "Worker 2", liveStatus: "working", attachedAt: recent, updatedAt: recent }]);
  fake.addTask({ key: "ABC-3", status: "backlog", updatedAt: recent });
  fake.addTask({ key: "ABC-4", status: "done", updatedAt: recent });
  fake.addTask({ key: "ABC-6", status: "in_progress", updatedAt: new Date(Date.now() - 6 * 3_600_000).toISOString() });
}

afterEach(() => setSystemTime());

describe("pinned lead instructions", () => {
  it("contribute the lead block only to the project's lead thread", async () => {
    const fake = boot();
    fake.addThread("thr_lead1");
    expect(fake.instructions("thr_lead1")).toBeNull();
    await fake.run(["lead", "ABC"], "thr_lead1");
    await settle();
    const block = fake.instructions("thr_lead1")!;
    expect(block).toContain('<project_lead_instructions project="ABC">');
    expect(block).toContain("For Review (in_review), In Progress (in_progress), Queued (todo), Done (done), Canceled (canceled)");
    expect(block).toContain("Needs <user>:");
    expect(block).toContain("bb projects notes ABC");
    expect(block).not.toMatch(/gh pr merge|squash|never merge/i);
    expect(block).toContain('"Holding: <reason>"');
    expect(fake.instructions("thr_other")).toBeNull();
    await fake.run(["lead", "ABC", "--thread", "thr_lead2"]);
    await settle();
    expect(fake.instructions("thr_lead1")).toBeNull();
    expect(fake.instructions("thr_lead2")).toContain('project="ABC"');
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
    const listed = await fake.run(["reconcile", "ABC"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("ABC-1 In Progress → Done: PR #3 merged [yours to write]");
    expect(listed.stdout).toContain("ABC-2 Queued → In Progress: an agent is running [yours to write]");
    expect(listed.stdout).toContain("ABC-6 In Progress → Queued: nothing running for 6h\n");
    expect(listed.stdout).not.toContain("ABC-3");
    expect(fake.updates).toEqual([]);

    const applied = (await fake.run(["reconcile", "ABC", "--apply", "--json"])).json();
    expect(applied.applied).toEqual({ moved: ["ABC-6"], failed: [] });
    expect(fake.updates).toEqual([{ taskId: "task_abc_6", status: "todo" }]);
    expect(fake.tasks.get("task_abc_1")!.status).toBe("in_progress");
    expect(fake.tasks.get("task_abc_2")!.status).toBe("todo");
  });

  it("says so when the board is clean", async () => {
    const fake = boot();
    fake.addTask({ key: "ABC-9", status: "todo" });
    expect((await fake.run(["reconcile", "ABC"])).stdout).toBe("ABC: every card matches its evidence.\n");
  });
});

describe("lead decisions", () => {
  it("hold a drift only after a Holding comment, until the evidence changes", async () => {
    const fake = boot();
    fake.addThread("thr_lead1");
    await fake.run(["lead", "ABC"], "thr_lead1");
    setSystemTime(at("2026-11-10T10:00:00.000Z"));
    seed(fake);
    expect((await fake.run(["reconcile", "ABC", "--json"])).json().drifts.map((drift: { key: string }) => drift.key)).toContain("ABC-1");

    setSystemTime(at("2026-11-10T10:04:00.000Z"));
    fake.comments.set("task_abc_1", [{ id: "c0", kind: "agent", authorName: "agent (thr_lead1)", body: "PR #3 merged and checked", createdAt: new Date().toISOString(), threadId: "thr_lead1" }]);
    setSystemTime(at("2026-11-10T10:04:30.000Z"));
    expect((await fake.run(["reconcile", "ABC", "--json"])).json().drifts.map((drift: { key: string }) => drift.key)).toContain("ABC-1");

    setSystemTime(at("2026-11-10T10:05:00.000Z"));
    fake.comments.get("task_abc_1")!.push({ id: "c1", kind: "agent", authorName: "agent (thr_lead1)", body: "Holding: PR #3 was only the first half", createdAt: new Date().toISOString(), threadId: "thr_lead1" });
    setSystemTime(at("2026-11-10T10:06:00.000Z"));
    const held = (await fake.run(["reconcile", "ABC", "--json"])).json();
    expect(held.drifts.map((drift: { key: string }) => drift.key)).not.toContain("ABC-1");
    expect(held.held.map((drift: { key: string }) => drift.key)).toEqual(["ABC-1"]);
    expect((await fake.run(["reconcile", "ABC"])).stdout).toContain("Held by a later decision until the evidence changes:\n- ABC-1");

    setSystemTime(at("2026-11-10T10:07:00.000Z"));
    fake.taskPrs.get("task_abc_1")!.push({ url: "https://github.com/o/r/pull/4", number: 4, title: "PR 2", state: "merged", updatedAt: new Date().toISOString(), threadIds: ["thr_w1"] });
    const again = (await fake.run(["reconcile", "ABC", "--json"])).json();
    expect(again.drifts.map((drift: { key: string }) => drift.key)).toContain("ABC-1");
  });
});

describe("pinned block recovery", () => {
  it("registers the lead on the next tick when Tasks wasn't ready at start", async () => {
    const kv = new Map<string, unknown>([["meta:proj_other", { leadThreadId: "thr_old" }]]);
    const fake = fakeBb({ kv });
    fake.faults.listProjects = 3;
    plugin(fake.bb as never);
    await settle();
    expect(fake.instructions("thr_old")).toBeNull();
    fake.faults.listProjects = 0;
    await tickDrift(fake);
    expect(fake.instructions("thr_old")).toContain('project="OTHER"');
  });
});

describe("bb projects queue-backlog", () => {
  it("lists Backlog cards and moves them to todo only with --apply", async () => {
    const fake = boot();
    seed(fake);
    const dry = await fake.run(["queue-backlog", "ABC"]);
    expect(dry.stdout).toContain("1 Backlog card would move to Queued:\n- ABC-3");
    expect(fake.updates).toEqual([]);
    const done = (await fake.run(["queue-backlog", "ABC", "--apply", "--json"])).json();
    expect(done).toEqual({ project: "ABC", backlog: ["ABC-3"], moved: ["ABC-3"], failed: [] });
    expect(fake.updates).toEqual([{ taskId: "task_abc_3", status: "todo" }]);
  });
});

describe("bb projects status", () => {
  it("counts Cursor's five statuses, folds backlog into Queued and includes sub-tasks", async () => {
    const fake = boot();
    seed(fake);
    fake.addTask({ key: "ABC-5", status: "in_progress", parentTaskId: "task_abc_4", updatedAt: new Date().toISOString() });
    const out = (await fake.run(["status", "ABC", "--json"])).json();
    expect(out.counts).toEqual({ in_review: 0, in_progress: 3, todo: 2, done: 1, canceled: 0 });
    expect(out.inFlight.find((item: { key: string }) => item.key === "ABC-5").parent).toBe("ABC-4");
    expect(out.behind).toBe(3);
  });
});

describe("drift pings", () => {
  it("are off by default and switch per project", async () => {
    const fake = boot();
    expect((await fake.run(["loop", "ABC"])).stdout).toContain("Drift pings: off");
    expect((await fake.run(["loop", "ABC", "--drift", "on", "--json"])).json().driftPings).toBe(true);
    expect((await fake.run(["loop", "OTHER", "--json"])).json().driftPings).toBe(false);
    expect((await fake.run(["loop", "ABC", "--drift", "maybe"])).exitCode).not.toBe(0);
  });

  it("ping an idle lead once drift outlives the grace period, then stay quiet", async () => {
    const fake = boot();
    fake.addThread("thr_lead1");
    await fake.run(["lead", "ABC"], "thr_lead1");
    await fake.run(["loop", "ABC", "--drift", "on", "--any-hours"]);
    setSystemTime(at("2026-11-10T10:00:00.000Z"));
    seed(fake);

    await tickDrift(fake);
    expect(fake.sent).toEqual([]);

    setSystemTime(at("2026-11-10T10:11:00.000Z"));
    await tickDrift(fake);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.threadId).toBe("thr_lead1");
    expect(fake.sent[0]!.text.split("\n")[0]).toBe("[Board drift] ABC");
    expect(fake.sent[0]!.text).toContain("ABC-1 In Progress → Done");

    setSystemTime(at("2026-11-10T10:30:00.000Z"));
    await tickDrift(fake);
    expect(fake.sent).toHaveLength(1);
  });

  it("never ping when the board is clean or the setting is off", async () => {
    const clean = boot();
    clean.addThread("thr_lead1");
    await clean.run(["lead", "ABC"], "thr_lead1");
    await clean.run(["loop", "ABC", "--drift", "on", "--any-hours"]);
    clean.addTask({ key: "ABC-9", status: "todo" });
    setSystemTime(at("2026-11-10T10:00:00.000Z"));
    await tickDrift(clean);
    setSystemTime(at("2026-11-10T11:00:00.000Z"));
    await tickDrift(clean);
    expect(clean.sent).toEqual([]);

    const off = boot();
    off.addThread("thr_lead1");
    await off.run(["lead", "ABC"], "thr_lead1");
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
    await fake.run(["lead", "ABC"], "thr_lead1");
    await fake.run(["loop", "ABC", "--drift", "on", "--any-hours"]);
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
