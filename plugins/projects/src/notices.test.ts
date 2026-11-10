import { describe, expect, it } from "vitest";
import plugin from "../server";
import { fakeBb } from "../test/fake-bb";
import { composeNotice, needsNote, transitionsOf, type NoticeBook } from "./notices";
import type { Task } from "./contracts";

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const old = "2026-11-01T09:00:00.000Z";

function boot(opts: Parameters<typeof fakeBb>[0] = {}) {
  const fake = fakeBb(opts);
  plugin(fake.bb as never);
  return fake;
}

async function tick(fake: ReturnType<typeof fakeBb>) {
  const controller = new AbortController();
  const running = Promise.resolve(fake.services.get("board-notices")!.start(controller.signal));
  await settle();
  controller.abort();
  await running;
}

async function withLead(opts: Parameters<typeof fakeBb>[0] = {}) {
  const fake = boot(opts);
  fake.addThread("thr_lead1");
  await fake.run(["lead", "ABC"], "thr_lead1");
  await settle();
  return fake;
}

const link = (threadId: string) => ({ threadId, presetName: "Opus", title: "Worker", liveStatus: "working" as const, attachedAt: old, updatedAt: old });
const move = (fake: ReturnType<typeof fakeBb>, key: string, status: Task["status"], updatedAt = old) => {
  const task = [...fake.tasks.values()].find((item) => item.key === key)!;
  task.status = status;
  task.updatedAt = updatedAt;
};
const comment = (body: string, createdAt = old) => ({ id: `c_${Math.random()}`, kind: "agent" as const, authorName: "Lead", body, createdAt, threadId: "thr_lead1" });

describe("muting workers on attach", () => {
  it("mutes a thread attached to a card on a board with a lead, and never the lead", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    fake.taskThreads.set("task_abc_1", [link("thr_w1"), link("thr_lead1")]);
    await tick(fake);
    expect(fake.push.levels.get("thr_w1")).toBe("muted");
    expect(fake.push.levels.get("thr_lead1")).toBe("input-only");
    await tick(fake);
    expect(fake.push.sets.filter((set) => set.threadId === "thr_w1")).toHaveLength(1);
  });

  it("leaves a level the user set on the worker, and does not re-mute one they reset", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    fake.addTask({ key: "ABC-2", status: "in_progress" });
    fake.taskThreads.set("task_abc_1", [link("thr_w1")]);
    fake.taskThreads.set("task_abc_2", [link("thr_w2")]);
    fake.push.levels.set("thr_w1", "all");
    await tick(fake);
    expect(fake.push.levels.get("thr_w1")).toBe("all");
    expect(fake.push.levels.get("thr_w2")).toBe("muted");
    fake.push.levels.delete("thr_w2");
    await tick(fake);
    expect(fake.push.levels.has("thr_w2")).toBe(false);
    expect(fake.push.sets.filter((set) => set.threadId !== "thr_lead1")).toEqual([{ threadId: "thr_w2", level: "muted" }]);
  });

  it("does nothing on a board without a lead", async () => {
    const fake = await withLead();
    fake.addTask({ key: "OTHER-1", projectId: "proj_other", status: "in_progress" });
    fake.taskThreads.set("task_other_1", [link("thr_w9")]);
    await tick(fake);
    await tick(fake);
    move(fake, "OTHER-1", "done");
    await tick(fake);
    expect(fake.push.levels.has("thr_w9")).toBe(false);
    expect(fake.push.sent).toEqual([]);
  });
});

describe("Done and For Review notices", () => {
  it("primes silently, then sends one Done per transition across re-sweeps and restarts", async () => {
    const kv = new Map<string, unknown>();
    const fake = await withLead({ kv });
    fake.addTask({ key: "ABC-1", status: "in_progress", title: "Ship the board" });
    fake.addTask({ key: "ABC-9", status: "done", title: "Already shipped" });
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
    move(fake, "ABC-1", "done");
    await tick(fake);
    await tick(fake);
    expect(fake.push.sent).toEqual([{ title: "Done: ABC-1 Ship the board", body: "", threadId: "thr_lead1" }]);

    const again = fakeBb({ kv });
    plugin(again.bb as never);
    again.addThread("thr_lead1");
    for (const task of fake.tasks.values()) again.tasks.set(task.id, structuredClone(task));
    await settle();
    await tick(again);
    expect(again.push.sent).toEqual([]);
  });

  it("folds sub-tasks into a parent that rolls up to Done in the same pass", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress", title: "Parent" });
    fake.addTask({ key: "ABC-2", status: "in_progress", parentTaskId: "task_abc_1" });
    fake.addTask({ key: "ABC-3", status: "in_progress", parentTaskId: "task_abc_1" });
    await tick(fake);
    move(fake, "ABC-2", "done");
    await tick(fake);
    move(fake, "ABC-3", "done");
    move(fake, "ABC-1", "done");
    await tick(fake);
    expect(fake.push.sent.map((sent) => [sent.title, sent.body])).toEqual([
      ["Done: ABC-2 ABC-2", ""],
      ["Done: ABC-1 Parent", "With ABC-3"],
    ]);
  });

  it("coalesces several transitions in one pass into one notification", async () => {
    const fake = await withLead();
    for (const key of ["ABC-1", "ABC-2", "ABC-3", "ABC-4"]) fake.addTask({ key, status: "in_progress", title: `Card ${key}` });
    await tick(fake);
    for (const key of ["ABC-1", "ABC-2", "ABC-3"]) move(fake, key, "done");
    move(fake, "ABC-4", "in_review");
    fake.comments.set("task_abc_4", [comment("Needs James: pick the icon")]);
    await tick(fake);
    expect(fake.push.sent).toEqual([{ title: "Needs you: ABC-4 Card ABC-4", body: "Needs James: pick the icon · 3 done: ABC-1, ABC-2, ABC-3", threadId: "thr_lead1" }]);
  });

  it("uses the latest Needs comment for For Review and waits briefly for one", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress", title: "Icon" });
    await tick(fake);
    move(fake, "ABC-1", "in_review", new Date().toISOString());
    fake.comments.set("task_abc_1", []);
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
    fake.comments.set("task_abc_1", [comment("Needs James: an old ask", "2026-11-01T09:00:00.000Z"), comment("Needs James:   approve the new\nicon", "2026-11-02T09:00:00.000Z")]);
    await tick(fake);
    await tick(fake);
    expect(fake.push.sent).toEqual([{ title: "Needs you: ABC-1 Icon", body: "Needs James: approve the new icon", threadId: "thr_lead1" }]);
  });

  it("skips the For Review notice while the lead is already asking the user", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    await tick(fake);
    fake.threads.get("thr_lead1")!.hasPendingInteraction = true;
    move(fake, "ABC-1", "in_review");
    fake.comments.set("task_abc_1", [comment("Needs James: choose a plan")]);
    await tick(fake);
    fake.threads.get("thr_lead1")!.hasPendingInteraction = false;
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
  });

  it("follows the notify setting", async () => {
    const fake = await withLead({ settings: { notify: "review-only" } });
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    fake.addTask({ key: "ABC-2", status: "in_progress" });
    fake.addTask({ key: "ABC-3", status: "in_progress" });
    await tick(fake);
    move(fake, "ABC-1", "done");
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
    move(fake, "ABC-2", "in_review");
    fake.comments.set("task_abc_2", [comment("Needs James: merge")]);
    await tick(fake);
    expect(fake.push.sent.map((sent) => sent.title)).toEqual(["Needs you: ABC-2 ABC-2"]);

    fake.settings.notify = "off";
    move(fake, "ABC-3", "done");
    await tick(fake);
    fake.settings.notify = "done-and-review";
    await tick(fake);
    expect(fake.push.sent).toHaveLength(1);
  });

  it("degrades quietly when Push Notifications is not running", async () => {
    const fake = await withLead();
    fake.plugins.find((entry) => entry.id === "push-notifications")!.enabled = false;
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    fake.addTask({ key: "ABC-2", status: "in_progress" });
    fake.taskThreads.set("task_abc_1", [link("thr_w1")]);
    await tick(fake);
    move(fake, "ABC-2", "done");
    await tick(fake);
    await tick(fake);
    const warnings = fake.logs.filter((line) => line.includes("Projects notifications stay off"));
    expect(warnings).toHaveLength(1);
    fake.plugins.find((entry) => entry.id === "push-notifications")!.enabled = true;
    await tick(fake);
    expect(fake.push.levels.get("thr_w1")).toBe("muted");
  });
});

describe("planning", () => {
  const task = (key: string, status: Task["status"], parentTaskId: string | null = null, position = 0): Task => ({
    id: key,
    projectId: "p",
    key,
    title: key,
    description: "",
    status,
    priority: "none",
    parentTaskId,
    position,
    labelIds: [],
    createdAt: old,
    updatedAt: old,
  });
  const book = (statuses: Record<string, Task["status"]>): NoticeBook => ({ primedAt: "2026-11-05T00:00:00.000Z", statuses });

  it("folds through grandparents but keeps a sub-task moving to a different column on its own", () => {
    const moves = transitionsOf(
      [task("A", "done", null, 0), task("B", "done", "A", 1), task("C", "done", "B", 2), task("D", "in_review", "A", 3)],
      book({ A: "in_progress", B: "in_progress", C: "in_progress", D: "in_progress" }),
    );
    expect(moves.map((item) => [item.task.key, item.to, item.folded.map((folded) => folded.key)])).toEqual([
      ["A", "done", ["B", "C"]],
      ["D", "in_review", []],
    ]);
  });

  it("counts a card created after priming, but not an unseen older one", () => {
    const fresh = { ...task("N", "done"), createdAt: "2026-11-06T00:00:00.000Z" };
    expect(transitionsOf([fresh, task("O", "done")], book({})).map((item) => item.task.key)).toEqual(["N"]);
  });

  it("truncates long key lists and titles", () => {
    const done = Array.from({ length: 20 }, (_, index) => ({ key: `BCS-${100 + index}`, title: "x", folded: [] }));
    const notice = composeNotice([], done)!;
    expect(notice.title.length).toBeLessThanOrEqual(80);
    expect(notice.title.startsWith("20 done: BCS-100, BCS-101")).toBe(true);
    expect(notice.title.endsWith(", ...")).toBe(true);
    expect(composeNotice([{ key: "A-1", title: "y".repeat(200), note: "z".repeat(400) }], [])!.body.length).toBeLessThanOrEqual(180);
    expect(composeNotice([], [])).toBeNull();
  });

  it("only takes comments that start with Needs <name>:", () => {
    expect(needsNote([{ body: "Holding: waiting", createdAt: old }, { body: "needs review", createdAt: old }])).toBeNull();
    expect(needsNote([{ body: "Needs Sam: approve", createdAt: old }])).toBe("Needs Sam: approve");
  });
});
