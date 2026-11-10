import { afterEach, describe, expect, it } from "vitest";
import { setSystemTime } from "bun:test";
import plugin from "../server";
import { fakeBb } from "../test/fake-bb";
import { askBoundary, composeDone, composeReview, departed, needsNote, RESCAN_BATCH, RESCAN_MS, statusFromComment, transitionsOf, type NoticeBook } from "./notices";
import type { Task } from "./contracts";

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const old = "2026-11-01T09:00:00.000Z";
let clock = Date.now() - 3_600_000;
const later = () => new Date((clock += 1_000)).toISOString();
const LABEL: Record<Task["status"], string> = { backlog: "Backlog", todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done", canceled: "Canceled" };

type Fake = ReturnType<typeof fakeBb>;

afterEach(() => setSystemTime());

function boot(opts: Parameters<typeof fakeBb>[0] = {}) {
  const fake = fakeBb(opts);
  plugin(fake.bb as never);
  return fake;
}

async function tick(fake: Fake) {
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

async function reboot(fake: Fake) {
  const again = fakeBb({ kv: fake.kv });
  plugin(again.bb as never);
  for (const [id, thread] of fake.threads) again.threads.set(id, structuredClone(thread));
  for (const [id, task] of fake.tasks) again.tasks.set(id, structuredClone(task));
  for (const [id, list] of fake.comments) again.comments.set(id, structuredClone(list));
  for (const [id, list] of fake.taskThreads) again.taskThreads.set(id, structuredClone(list));
  for (const [id, level] of fake.push.levels) again.push.levels.set(id, level);
  await settle();
  return again;
}

const link = (threadId: string, liveStatus: "working" | "idle" = "working") => ({ threadId, presetName: "Opus", title: "Worker", liveStatus, attachedAt: old, updatedAt: old });
const task = (fake: Fake, key: string) => [...fake.tasks.values()].find((item) => item.key === key)!;
const note = (fake: Fake, key: string, body: string, createdAt = later()) => {
  const id = task(fake, key).id;
  fake.comments.set(id, [...(fake.comments.get(id) ?? []), { id: `c_${clock}`, kind: "agent", authorName: "Lead", body, createdAt, threadId: "thr_lead1" }]);
};
const move = (fake: Fake, key: string, status: Task["status"], at = later()) => {
  const card = task(fake, key);
  card.status = status;
  card.updatedAt = at;
  fake.comments.set(card.id, [...(fake.comments.get(card.id) ?? []), { id: `s_${clock}`, kind: "system", authorName: "Tasks", body: `Status changed to ${LABEL[status]} by Lead`, createdAt: at, threadId: null }]);
};

describe("muting workers on attach", () => {
  it("mutes active workers on cards and sub-tasks once, and never the lead", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    fake.addTask({ key: "ABC-2", status: "in_progress", parentTaskId: "task_abc_1" });
    fake.taskThreads.set("task_abc_1", [link("thr_w1"), link("thr_lead1")]);
    fake.taskThreads.set("task_abc_2", [link("thr_w2", "idle")]);
    await tick(fake);
    await tick(fake);
    expect(fake.push.levels.get("thr_w1")).toBe("muted");
    expect(fake.push.levels.get("thr_w2")).toBe("muted");
    expect(fake.push.levels.get("thr_lead1")).toBe("input-only");
    expect(fake.push.sets.filter((set) => set.level === "muted")).toEqual([
      { threadId: "thr_w1", level: "muted" },
      { threadId: "thr_w2", level: "muted" },
    ]);
    expect(fake.kv.get("mute:thr_w1")).toMatchObject({ owner: "projects", previous: "inherit" });
  });

  it("keeps a level the user set, and a reset stays reset on every board", async () => {
    const fake = await withLead();
    fake.addThread("thr_lead2");
    await fake.run(["lead", "OTHER"], "thr_lead2");
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    fake.addTask({ key: "ABC-2", status: "in_progress" });
    fake.taskThreads.set("task_abc_1", [link("thr_w1")]);
    fake.taskThreads.set("task_abc_2", [link("thr_w2")]);
    fake.push.levels.set("thr_w1", "all");
    await tick(fake);
    expect(fake.push.levels.get("thr_w1")).toBe("all");
    expect(fake.kv.get("mute:thr_w1")).toMatchObject({ owner: "user", level: "all" });
    expect(fake.push.levels.get("thr_w2")).toBe("muted");
    fake.push.levels.delete("thr_w2");
    fake.addTask({ key: "OTHER-1", projectId: "proj_other", status: "in_progress" });
    fake.taskThreads.set("task_other_1", [link("thr_w2")]);
    const again = await reboot(fake);
    await tick(again);
    expect(again.push.levels.has("thr_w2")).toBe(false);
    expect(again.push.sets.filter((set) => set.level === "muted")).toEqual([]);
  });

  it("retries a mute whose write failed, and records only the success", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    fake.taskThreads.set("task_abc_1", [link("thr_w1")]);
    fake.push.failSet = 1;
    await tick(fake);
    expect(fake.push.levels.has("thr_w1")).toBe(false);
    expect(fake.kv.has("mute:thr_w1")).toBe(false);
    await tick(fake);
    expect(fake.push.levels.get("thr_w1")).toBe("muted");
    expect(fake.kv.get("mute:thr_w1")).toMatchObject({ owner: "projects" });
  });

  it("restores a worker it muted when that worker becomes the lead, but not one the user changed", async () => {
    const fake = await withLead();
    fake.addThread("thr_w1");
    fake.addThread("thr_w2");
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    fake.taskThreads.set("task_abc_1", [link("thr_w1"), link("thr_w2")]);
    await tick(fake);
    expect(fake.push.levels.get("thr_w1")).toBe("muted");
    await fake.run(["lead", "ABC"], "thr_w1");
    await settle();
    expect(fake.push.levels.get("thr_w1")).toBe("input-only");
    expect(fake.kv.has("mute:thr_w1")).toBe(false);
    await tick(fake);
    expect(fake.push.levels.get("thr_w1")).toBe("input-only");

    fake.push.levels.set("thr_w2", "all");
    await fake.run(["lead", "ABC"], "thr_w2");
    await settle();
    expect(fake.push.levels.get("thr_w2")).toBe("all");
    expect(fake.kv.get("mute:thr_w2")).toMatchObject({ owner: "user", level: "all" });
  });

  it("restores an owned mute on a lead set before the plugin saw the change", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    fake.taskThreads.set("task_abc_1", [link("thr_w1")]);
    await tick(fake);
    const meta = fake.kv.get("meta:proj_abc") as Record<string, unknown>;
    fake.kv.set("meta:proj_abc", { ...meta, leadThreadId: "thr_w1" });
    const again = await reboot(fake);
    await tick(again);
    expect(again.push.levels.get("thr_w1")).toBe("input-only");
  });

  it("does nothing on a board without a lead", async () => {
    const fake = await withLead();
    fake.addTask({ key: "OTHER-1", projectId: "proj_other", status: "in_progress" });
    fake.taskThreads.set("task_other_1", [link("thr_w9")]);
    await tick(fake);
    move(fake, "OTHER-1", "done");
    await tick(fake);
    expect(fake.push.levels.has("thr_w9")).toBe(false);
    expect(fake.push.sent).toEqual([]);
  });

  it("finds idle workers on top-level cards with a bounded sweep", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    fake.taskThreads.set("task_abc_1", [link("thr_idle", "idle")]);
    await tick(fake);
    expect(fake.push.levels.get("thr_idle")).toBe("muted");
  });

  it("resumes the sweep after a restart instead of starting over", async () => {
    let fake = await withLead();
    for (let index = 1; index <= 3 * RESCAN_BATCH + 1; index++) fake.addTask({ key: `ABC-${index}`, status: "in_progress", updatedAt: new Date(Date.parse(old) + index * 1_000).toISOString() });
    fake.taskThreads.set("task_abc_1", [link("thr_tail", "idle")]);
    for (let restart = 0; restart < 4; restart++) {
      fake = await reboot(fake);
      await tick(fake);
    }
    expect(fake.push.levels.get("thr_tail")).toBe("muted");
  });

  it("keeps the RPC count per pass bounded, and two board reads once the sweep has covered the board", async () => {
    const fake = await withLead();
    for (let index = 1; index <= 200; index++) fake.addTask({ key: `ABC-${index}`, status: index % 3 ? "in_progress" : "done" });
    for (let index = 1; index <= 20; index++) fake.addTask({ key: `ABC-S${index}`, status: "in_progress", parentTaskId: "task_abc_1" });
    for (let index = 1; index <= 30; index++) fake.taskThreads.set(`task_abc_${index}`, [link(`thr_w${index}`, index % 2 ? "idle" : "working")]);
    const count = (name: string) => fake.calls.filter((call) => call === name).length;
    const open = [...fake.tasks.values()].filter((item) => item.status !== "done").length;
    for (let pass = 0; pass < Math.ceil(open / RESCAN_BATCH); pass++) {
      fake.calls.length = 0;
      await tick(fake);
      expect(count("tasks.listTaskThreads")).toBeLessThanOrEqual(RESCAN_BATCH);
    }
    for (let index = 1; index <= 30; index++) {
      const openCard = index % 3 !== 0;
      const working = index % 2 === 0;
      expect(fake.push.levels.get(`thr_w${index}`)).toBe(openCard || working ? "muted" : undefined);
    }
    fake.calls.length = 0;
    await tick(fake);
    expect(count("tasks.listAllTasks")).toBe(1);
    expect(count("tasks.listTaskCardMeta")).toBe(1);
    expect(count("tasks.listTaskThreads")).toBe(0);
    expect(count("tasks.listComments")).toBe(0);
    expect(fake.calls.filter((call) => call.startsWith("push-notifications."))).toEqual([]);
    setSystemTime(new Date(Date.now() + RESCAN_MS + 1_000));
    fake.calls.length = 0;
    await tick(fake);
    expect(count("tasks.listTaskThreads")).toBe(RESCAN_BATCH);
    setSystemTime();
  });
});

describe("Done and For Review notices", () => {
  it("primes silently, then sends one Done per transition across re-sweeps and restarts", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress", title: "Ship the board" });
    fake.addTask({ key: "ABC-9", status: "done", title: "Already shipped" });
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
    move(fake, "ABC-1", "done");
    await tick(fake);
    await tick(fake);
    expect(fake.push.sent).toEqual([{ title: "Done: ABC-1 Ship the board", body: "", threadId: "thr_lead1" }]);
    const again = await reboot(fake);
    await tick(again);
    expect(again.push.sent).toEqual([]);
  });

  it("keeps a missed Done pending until Push Notifications delivers it", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress", title: "One" });
    fake.addTask({ key: "ABC-2", status: "in_progress", title: "Two" });
    await tick(fake);
    fake.plugins.find((entry) => entry.id === "push-notifications")!.enabled = false;
    move(fake, "ABC-1", "done");
    await tick(fake);
    expect(fake.kv.get("notices:proj_abc")).toMatchObject({ pending: { done: [{ key: "ABC-1" }] } });
    fake.plugins.find((entry) => entry.id === "push-notifications")!.enabled = true;
    fake.push.channels = [];
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
    fake.push.channels = ["mobile"];
    move(fake, "ABC-2", "done");
    await tick(fake);
    await tick(fake);
    expect(fake.push.sent.map((sent) => sent.title)).toEqual(["2 done: ABC-1, ABC-2"]);
  });

  it("delivers once after a restart between saving and sending", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress", title: "One" });
    await tick(fake);
    move(fake, "ABC-1", "done");
    fake.push.failSend = 1;
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
    const again = await reboot(fake);
    await tick(again);
    await tick(again);
    expect(again.push.sent.map((sent) => sent.title)).toEqual(["Done: ABC-1 One"]);
  });

  it("drops a pending notice whose card has moved on", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    await tick(fake);
    move(fake, "ABC-1", "done");
    fake.push.failSend = 1;
    await tick(fake);
    move(fake, "ABC-1", "in_progress");
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
  });

  it("notices a card that moved away and back between two passes, across a restart", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress", title: "Icon" });
    fake.addTask({ key: "ABC-2", status: "in_progress", title: "Docs" });
    await tick(fake);
    move(fake, "ABC-1", "in_review");
    note(fake, "ABC-1", "Needs James: pick an icon");
    move(fake, "ABC-2", "done");
    await tick(fake);
    expect(fake.push.sent).toHaveLength(2);

    move(fake, "ABC-1", "in_progress");
    move(fake, "ABC-1", "in_review");
    note(fake, "ABC-1", "Needs James: pick again");
    move(fake, "ABC-2", "in_progress");
    move(fake, "ABC-2", "done");
    const again = await reboot(fake);
    await tick(again);
    expect(again.push.sent).toEqual([
      { title: "Needs you: ABC-1 Icon", body: "Needs James: pick again", threadId: "thr_lead1" },
      { title: "Done: ABC-2 Docs", body: "", threadId: "thr_lead1" },
    ]);

    task(again, "ABC-2").updatedAt = later();
    await tick(again);
    expect(again.push.sent).toHaveLength(2);
  });

  it("retries a round trip whose history read failed", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "done", title: "Shipped" });
    await tick(fake);
    move(fake, "ABC-1", "in_progress");
    move(fake, "ABC-1", "done");
    fake.faults.listComments = 1;
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
    await tick(fake);
    expect(fake.push.sent.map((sent) => sent.title)).toEqual(["Done: ABC-1 Shipped"]);
  });

  it("applies the notify setting to a pending backlog", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    fake.addTask({ key: "ABC-2", status: "in_progress" });
    await tick(fake);
    move(fake, "ABC-1", "done");
    fake.push.failSend = 1;
    await tick(fake);
    fake.settings.notify = "review-only";
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
    move(fake, "ABC-2", "in_review");
    note(fake, "ABC-2", "Needs James: merge");
    await tick(fake);
    expect(fake.push.sent.map((sent) => [sent.title, sent.body])).toEqual([["Needs you: ABC-2 ABC-2", "Needs James: merge"]]);
  });

  it("holds back a pending For Review once the lead is asking", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    await tick(fake);
    move(fake, "ABC-1", "in_review");
    note(fake, "ABC-1", "Needs James: pick");
    fake.push.failSend = 1;
    await tick(fake);
    fake.threads.get("thr_lead1")!.hasPendingInteraction = true;
    await tick(fake);
    fake.threads.get("thr_lead1")!.hasPendingInteraction = false;
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
  });

  it("does not reuse the ask from an earlier review when the card returns to For Review", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress", title: "Icon" });
    await tick(fake);
    move(fake, "ABC-1", "in_review");
    note(fake, "ABC-1", "Needs James: first ask");
    await tick(fake);
    expect(fake.push.sent.map((sent) => sent.body)).toEqual(["Needs James: first ask"]);
    move(fake, "ABC-1", "in_progress", new Date(Date.now() - 2_000).toISOString());
    move(fake, "ABC-1", "in_review", new Date().toISOString());
    await tick(fake);
    expect(fake.push.sent).toHaveLength(1);
    note(fake, "ABC-1", "Needs James: second ask", new Date(Date.now() + 1_000).toISOString());
    await tick(fake);
    expect(fake.push.sent.map((sent) => sent.body)).toEqual(["Needs James: first ask", "Needs James: second ask"]);
  });

  it("keeps every card in a large backlog and counts the overflow", async () => {
    const fake = await withLead();
    for (let index = 1; index <= 60; index++) fake.addTask({ key: `ABC-${index}`, status: "in_progress" });
    await tick(fake);
    for (let index = 1; index <= 60; index++) move(fake, `ABC-${index}`, "done");
    fake.push.failSend = 1;
    await tick(fake);
    expect((fake.kv.get("notices:proj_abc") as NoticeBook).pending.done).toHaveLength(60);
    await tick(fake);
    expect(fake.push.sent).toHaveLength(1);
    const title = fake.push.sent[0]!.title;
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).toMatch(/^60 done: ABC-1, ABC-2, .*, and \d+ more$/);
    const shown = title.slice("60 done: ".length).split(", and ")[0]!.split(", ").length;
    expect(title.endsWith(`and ${60 - shown} more`)).toBe(true);
  });

  it("sends one notice per entry into For Review, dropping a queued ask the card has moved past", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress", title: "Icon" });
    await tick(fake);
    move(fake, "ABC-1", "in_review");
    note(fake, "ABC-1", "Needs James: choose the old icon");
    fake.push.failSend = 1;
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
    move(fake, "ABC-1", "in_progress", new Date(Date.now() - 2_000).toISOString());
    move(fake, "ABC-1", "in_review", new Date().toISOString());
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
    note(fake, "ABC-1", "Needs James: approve the replacement", new Date(Date.now() + 1_000).toISOString());
    await tick(fake);
    await tick(fake);
    expect(fake.push.sent.map((sent) => sent.body)).toEqual(["Needs James: approve the replacement"]);
  });

  it("holds a queued ask while its card's history can't be read, then sends only the replacement", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress", title: "Icon" });
    await tick(fake);
    move(fake, "ABC-1", "in_review");
    note(fake, "ABC-1", "Needs James: choose the obsolete icon");
    fake.push.failSend = 1;
    await tick(fake);
    move(fake, "ABC-1", "in_progress");
    move(fake, "ABC-1", "in_review");
    note(fake, "ABC-1", "Needs James: approve the replacement");
    fake.faults.listComments = 1;
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
    expect((fake.kv.get("notices:proj_abc") as NoticeBook).pending.review.map((item) => item.note)).toEqual(["Needs James: choose the obsolete icon"]);
    await tick(fake);
    await tick(fake);
    expect(fake.push.sent.map((sent) => sent.body)).toEqual(["Needs James: approve the replacement"]);
  });

  it("still delivers a valid queued ask after an ordinary edit whose history read failed", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress", title: "Icon" });
    fake.addTask({ key: "ABC-2", status: "in_progress", title: "Ship" });
    await tick(fake);
    move(fake, "ABC-1", "in_review");
    note(fake, "ABC-1", "Needs James: pick an icon");
    fake.push.failSend = 1;
    await tick(fake);
    task(fake, "ABC-1").updatedAt = later();
    move(fake, "ABC-2", "done");
    fake.faults.listComments = 1;
    await tick(fake);
    expect(fake.push.sent.map((sent) => sent.title)).toEqual(["Done: ABC-2 Ship"]);
    await tick(fake);
    await tick(fake);
    expect(fake.push.sent.map((sent) => [sent.title, sent.body])).toEqual([
      ["Done: ABC-2 Ship", ""],
      ["Needs you: ABC-1 Icon", "Needs James: pick an icon"],
    ]);
  });

  it("sends Needs you and Done separately so a long ask cannot hide a Done", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress", title: "Ask" });
    fake.addTask({ key: "ABC-2", status: "in_progress", title: "Ship" });
    await tick(fake);
    move(fake, "ABC-1", "in_review");
    note(fake, "ABC-1", `Needs James: ${"a very long question ".repeat(20)}`);
    move(fake, "ABC-2", "done");
    await tick(fake);
    expect(fake.push.sent.map((sent) => sent.title)).toEqual(["Needs you: ABC-1 Ask", "Done: ABC-2 Ship"]);
    expect(fake.push.sent[0]!.body!.length).toBeLessThanOrEqual(180);
  });

  it("keeps the Done pending when only the Needs you send got through", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress", title: "Ask" });
    fake.addTask({ key: "ABC-2", status: "in_progress", title: "Ship" });
    await tick(fake);
    move(fake, "ABC-1", "in_review");
    note(fake, "ABC-1", "Needs James: merge");
    move(fake, "ABC-2", "done");
    const send = fake.bb.sdk.plugins.callRpc;
    let sends = 0;
    fake.bb.sdk.plugins.callRpc = async (args) => {
      if (args.method === "notifications.send" && ++sends === 2) throw new Error("send failed");
      return send(args);
    };
    await tick(fake);
    fake.bb.sdk.plugins.callRpc = send;
    await tick(fake);
    expect(fake.push.sent.map((sent) => sent.title)).toEqual(["Needs you: ABC-1 Ask", "Done: ABC-2 Ship"]);
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

  it("coalesces a pass into one notification per kind", async () => {
    const fake = await withLead();
    for (const key of ["ABC-1", "ABC-2", "ABC-3", "ABC-4"]) fake.addTask({ key, status: "in_progress", title: `Card ${key}` });
    await tick(fake);
    for (const key of ["ABC-1", "ABC-2", "ABC-3"]) move(fake, key, "done");
    move(fake, "ABC-4", "in_review");
    note(fake, "ABC-4", "Needs James: pick the icon");
    await tick(fake);
    expect(fake.push.sent).toEqual([
      { title: "Needs you: ABC-4 Card ABC-4", body: "Needs James: pick the icon", threadId: "thr_lead1" },
      { title: "3 done: ABC-1, ABC-2, ABC-3", body: "ABC-1 Card ABC-1; ABC-2 Card ABC-2; ABC-3 Card ABC-3", threadId: "thr_lead1" },
    ]);
  });

  it("waits briefly for a fresh Needs comment and ignores an old one", async () => {
    const fake = await withLead();
    fake.addTask({ key: "ABC-1", status: "in_progress", title: "Icon" });
    note(fake, "ABC-1", "Needs James: an old ask", old);
    await tick(fake);
    move(fake, "ABC-1", "in_review", new Date().toISOString());
    await tick(fake);
    expect(fake.push.sent).toEqual([]);
    note(fake, "ABC-1", "Needs James:   approve the new\nicon", new Date(Date.now() + 1_000).toISOString());
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
    note(fake, "ABC-1", "Needs James: choose a plan");
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
    note(fake, "ABC-2", "Needs James: merge");
    await tick(fake);
    expect(fake.push.sent.map((sent) => sent.title)).toEqual(["Needs you: ABC-2 ABC-2"]);

    fake.settings.notify = "off";
    move(fake, "ABC-3", "done");
    await tick(fake);
    fake.settings.notify = "done-and-review";
    await tick(fake);
    expect(fake.push.sent).toHaveLength(1);
  });

  it("logs once while Push Notifications is away, then recovers", async () => {
    const fake = await withLead();
    fake.plugins.find((entry) => entry.id === "push-notifications")!.enabled = false;
    fake.addTask({ key: "ABC-1", status: "in_progress" });
    fake.addTask({ key: "ABC-2", status: "in_progress" });
    fake.taskThreads.set("task_abc_1", [link("thr_w1")]);
    await tick(fake);
    move(fake, "ABC-2", "done");
    await tick(fake);
    await tick(fake);
    expect(fake.logs.filter((line) => line.includes("Projects notifications wait"))).toHaveLength(1);
    fake.plugins.find((entry) => entry.id === "push-notifications")!.enabled = true;
    await tick(fake);
    expect(fake.push.levels.get("thr_w1")).toBe("muted");
    expect(fake.push.sent.map((sent) => sent.title)).toEqual(["Done: ABC-2 ABC-2"]);
  });
});

describe("planning", () => {
  const card = (key: string, status: Task["status"], parentTaskId: string | null = null, position = 0): Task => ({
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
  const book = (statuses: Record<string, Task["status"]>): NoticeBook => ({
    primedAt: "2026-11-05T00:00:00.000Z",
    cards: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status, updatedAt: old }])),
    pending: { review: [], done: [] },
  });

  it("folds through grandparents but keeps a sub-task moving to a different column on its own", () => {
    const moves = transitionsOf(
      [card("A", "done", null, 0), card("B", "done", "A", 1), card("C", "done", "B", 2), card("D", "in_review", "A", 3)],
      book({ A: "in_progress", B: "in_progress", C: "in_progress", D: "in_progress" }),
    );
    expect(moves.map((item) => [item.task.key, item.to, item.folded.map((folded) => folded.key)])).toEqual([
      ["A", "done", ["B", "C"]],
      ["D", "in_review", []],
    ]);
  });

  it("counts a card created after priming, but not an unseen older one", () => {
    const fresh = { ...card("N", "done"), createdAt: "2026-11-06T00:00:00.000Z" };
    expect(transitionsOf([fresh, card("O", "done")], book({})).map((item) => item.task.key)).toEqual(["N"]);
  });

  it("reads departures from Tasks' status comments after the stored update only", () => {
    const stored = { status: "done" as const, updatedAt: "2026-11-02T00:00:00.000Z" };
    const system = (body: string, createdAt: string) => ({ kind: "system", body, createdAt });
    expect(statusFromComment(system("Status changed to In Review by Lead", old))).toBe("in_review");
    expect(statusFromComment(system("Status changed to In Progress · dispatched to Opus", old))).toBe("in_progress");
    expect(statusFromComment({ kind: "agent", body: "Status changed to Done by me", createdAt: old })).toBeNull();
    expect(departed({ status: "done" }, stored, [system("Status changed to In Progress by Lead", "2026-11-01T00:00:00.000Z")])).toBe(false);
    expect(departed({ status: "done" }, stored, [system("Status changed to Done by Lead", "2026-11-03T00:00:00.000Z")])).toBe(false);
    expect(departed({ status: "done" }, stored, [system("Status changed to In Progress by Lead", "2026-11-03T00:00:00.000Z")])).toBe(true);
  });

  it("bounds the ask by the change before the latest entry to For Review", () => {
    const system = (status: string, createdAt: string) => ({ kind: "system", body: `Status changed to ${status} by Lead`, createdAt });
    const history = [system("In Review", "2026-11-02T00:00:00.000Z"), system("In Progress", "2026-11-03T00:00:00.000Z"), system("In Review", "2026-11-04T00:00:00.000Z")];
    expect(askBoundary(history, null)).toBe("2026-11-03T00:00:00.000Z");
    expect(askBoundary([system("In Review", "2026-11-02T00:00:00.000Z")], "2026-11-01T00:00:00.000Z")).toBe("2026-11-01T00:00:00.000Z");
    expect(askBoundary([], "2026-11-01T00:00:00.000Z")).toBe("2026-11-01T00:00:00.000Z");
  });

  it("truncates long key lists and titles", () => {
    const done = Array.from({ length: 20 }, (_, index) => ({ key: `BCS-${100 + index}`, title: "x", folded: [] }));
    const notice = composeDone(done)!;
    expect(notice.title.length).toBeLessThanOrEqual(80);
    expect(notice.title.startsWith("20 done: BCS-100, BCS-101")).toBe(true);
    expect(notice.title).toMatch(/, and \d+ more$/);
    const shown = notice.title.slice("20 done: ".length).split(", and ")[0]!.split(", ").length;
    expect(notice.title.endsWith(`and ${20 - shown} more`)).toBe(true);
    expect(composeReview([{ key: "A-1", title: "y".repeat(200), note: "z".repeat(400) }])!.body.length).toBeLessThanOrEqual(180);
    expect(composeReview([])).toBeNull();
    expect(composeDone([])).toBeNull();
  });

  it("only takes comments that start with Needs <name>:", () => {
    expect(needsNote([{ body: "Holding: waiting", createdAt: old }, { body: "needs review", createdAt: old }])).toBeNull();
    expect(needsNote([{ body: "Needs Sam: approve", createdAt: old }])).toBe("Needs Sam: approve");
    expect(needsNote([{ body: "Needs Sam: approve", createdAt: old }], old)).toBeNull();
  });
});
