import { describe, expect, it } from "vitest";
import { byColumn } from "./order";
import type { Status, Task } from "./contracts";

function task(key: string, status: Status, position: number, patch: Partial<Task> = {}): Task {
  return {
    id: `t_${key}`,
    projectId: "p",
    key,
    title: key,
    description: "",
    status,
    priority: "none",
    parentTaskId: null,
    position,
    labelIds: [],
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    ...patch,
  };
}

const at = (iso: string) => iso;

describe("column order", () => {
  it("lists the most recently completed Done card first", () => {
    const tasks = [task("ABC-1", "done", 0), task("ABC-2", "done", 1), task("ABC-3", "done", 2)];
    const times = new Map([
      ["t_ABC-1", at("2026-11-01T10:00:00.000Z")],
      ["t_ABC-2", at("2026-11-05T10:00:00.000Z")],
      ["t_ABC-3", at("2026-11-03T10:00:00.000Z")],
    ]);
    expect(byColumn(tasks, times).done.map((item) => item.key)).toEqual(["ABC-2", "ABC-3", "ABC-1"]);
  });

  it("lists the most recently canceled Canceled card first", () => {
    const tasks = [task("ABC-1", "canceled", 0), task("ABC-2", "canceled", 1)];
    const times = new Map([
      ["t_ABC-1", at("2026-11-04T10:00:00.000Z")],
      ["t_ABC-2", at("2026-11-02T10:00:00.000Z")],
    ]);
    expect(byColumn(tasks, times).canceled.map((item) => item.key)).toEqual(["ABC-1", "ABC-2"]);
  });

  it("keeps the existing order for open columns", () => {
    const tasks = [
      task("ABC-1", "todo", 0, { updatedAt: "2026-11-01T10:00:00.000Z" }),
      task("ABC-2", "todo", 1, { updatedAt: "2026-11-05T10:00:00.000Z" }),
      task("ABC-3", "in_progress", 0, { updatedAt: "2026-11-01T10:00:00.000Z" }),
      task("ABC-4", "in_progress", 1, { updatedAt: "2026-11-05T10:00:00.000Z" }),
      task("ABC-5", "in_review", 0, { updatedAt: "2026-11-01T10:00:00.000Z" }),
      task("ABC-6", "in_review", 1, { updatedAt: "2026-11-05T10:00:00.000Z" }),
    ];
    const times = new Map([
      ["t_ABC-1", at("2026-11-09T10:00:00.000Z")],
      ["t_ABC-2", at("2026-11-01T10:00:00.000Z")],
    ]);
    const groups = byColumn(tasks, times);
    expect(groups.todo.map((item) => item.key)).toEqual(["ABC-1", "ABC-2"]);
    expect(groups.in_progress.map((item) => item.key)).toEqual(["ABC-3", "ABC-4"]);
    expect(groups.in_review.map((item) => item.key)).toEqual(["ABC-5", "ABC-6"]);
  });

  it("falls back to updatedAt when a closed card has no completion time", () => {
    const tasks = [
      task("ABC-1", "done", 0, { updatedAt: "2026-11-02T10:00:00.000Z" }),
      task("ABC-2", "done", 1, { updatedAt: "2026-11-06T10:00:00.000Z" }),
      task("ABC-3", "done", 2),
    ];
    const times = new Map([["t_ABC-3", at("2026-11-04T10:00:00.000Z")]]);
    expect(byColumn(tasks, times).done.map((item) => item.key)).toEqual(["ABC-2", "ABC-3", "ABC-1"]);
  });

  it("keeps position order when completion times match", () => {
    const tasks = [task("ABC-2", "done", 1), task("ABC-1", "done", 0)];
    const same = at("2026-11-04T10:00:00.000Z");
    const times = new Map([
      ["t_ABC-1", same],
      ["t_ABC-2", same],
    ]);
    expect(byColumn(tasks, times).done.map((item) => item.key)).toEqual(["ABC-1", "ABC-2"]);
  });
});
