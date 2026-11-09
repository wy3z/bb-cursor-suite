import { describe, expect, it } from "vitest";
import plugin from "../server";
import { fakeBb } from "../test/fake-bb";
import { enteredStatusAt, mapLimited } from "./completion";
import type { CommentSignal } from "./reconcile";

function comment(body: string, createdAt: string, kind: CommentSignal["kind"] = "system"): CommentSignal {
  return { kind, body, createdAt, threadId: null, authorName: "You" };
}

describe("enteredStatusAt", () => {
  it("takes the latest system comment that moved the card into its current status", () => {
    const task = { status: "done" as const, updatedAt: "2026-11-09T12:00:00.000Z" };
    const comments = [
      comment("Status changed to Done by You", "2026-11-05T09:00:00.000Z"),
      comment("Status changed to In Progress by You", "2026-11-06T09:00:00.000Z"),
      comment("Status changed to Done by Codex", "2026-11-08T09:00:00.000Z"),
      comment("Status changed to Canceled by You", "2026-11-08T10:00:00.000Z"),
      comment("Status changed to Done by You", "2026-11-08T11:00:00.000Z", "user"),
    ];
    expect(enteredStatusAt(task, comments)).toBe("2026-11-08T09:00:00.000Z");
  });

  it("matches Canceled cards to the Canceled status comment", () => {
    const task = { status: "canceled" as const, updatedAt: "2026-11-09T12:00:00.000Z" };
    const comments = [
      comment("Status changed to Done by You", "2026-11-07T09:00:00.000Z"),
      comment("Status changed to Canceled by You", "2026-11-08T09:00:00.000Z"),
    ];
    expect(enteredStatusAt(task, comments)).toBe("2026-11-08T09:00:00.000Z");
  });

  it("falls back to updatedAt when no status comment exists", () => {
    const task = { status: "done" as const, updatedAt: "2026-11-09T12:00:00.000Z" };
    expect(enteredStatusAt(task, [comment("Shipped", "2026-11-10T09:00:00.000Z", "agent")])).toBe("2026-11-09T12:00:00.000Z");
  });
});

describe("mapLimited", () => {
  it("keeps the input order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const result = await mapLimited([1, 2, 3, 4, 5], 2, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return value * 2;
    });
    expect(result).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});

describe("completionTimes", () => {
  it("returns the status-change time for Done and Canceled cards only", async () => {
    const fake = fakeBb();
    plugin(fake.bb as never);
    const done = fake.addTask({ key: "ABC-1", status: "done", updatedAt: "2026-11-09T12:00:00.000Z" });
    fake.comments.set(done.id, [
      { id: "c1", kind: "system", authorName: "You", body: "Status changed to Done by You", createdAt: "2026-11-07T09:00:00.000Z", threadId: null },
      { id: "c2", kind: "user", authorName: "You", body: "Looks good", createdAt: "2026-11-10T09:00:00.000Z", threadId: null },
    ]);
    const canceled = fake.addTask({ key: "ABC-2", status: "canceled", updatedAt: "2026-11-08T12:00:00.000Z" });
    fake.comments.set(canceled.id, [
      { id: "c3", kind: "system", authorName: "You", body: "Status changed to Canceled by You", createdAt: "2026-11-08T12:00:00.000Z", threadId: null },
    ]);
    const open = fake.addTask({ key: "ABC-3", status: "todo" });

    const result = (await fake.rpc().completionTimes!({ projectId: "proj_abc" })) as { times: Record<string, string> };

    expect(result.times[done.id]).toBe("2026-11-07T09:00:00.000Z");
    expect(result.times[canceled.id]).toBe("2026-11-08T12:00:00.000Z");
    expect(result.times[open.id]).toBeUndefined();
  });
});
