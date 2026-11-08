import { describe, expect, it } from "vitest";
import { anchorsFor, loadState } from "./moves";
import type { Status } from "./contracts";

const card = (id: string, status: Status) => ({ id, status });

describe("anchorsFor", () => {
  const queued = [card("a", "todo"), card("b", "backlog"), card("c", "backlog"), card("d", "todo"), card("e", "backlog")];

  it("anchors only on neighbours whose stored status is the target, so Tasks accepts the move", () => {
    expect(anchorsFor(queued, "x", 2, "todo")).toEqual({ beforeTaskId: "a", afterTaskId: "d" });
    expect(anchorsFor(queued, "x", 0, "todo")).toEqual({ beforeTaskId: null, afterTaskId: "a" });
    expect(anchorsFor(queued, "x", 5, "todo")).toEqual({ beforeTaskId: "d", afterTaskId: null });
  });

  it("moves without anchors when no neighbour has the target status", () => {
    const backlogOnly = [card("b", "backlog"), card("c", "backlog")];
    expect(anchorsFor(backlogOnly, "x", 1, "todo")).toEqual({ beforeTaskId: null, afterTaskId: null });
  });

  it("ignores the dragged card itself", () => {
    expect(anchorsFor(queued, "d", 1, "todo")).toEqual({ beforeTaskId: "a", afterTaskId: null });
    expect(anchorsFor([card("p", "in_progress"), card("q", "in_progress")], "p", 1, "in_progress")).toEqual({ beforeTaskId: "q", afterTaskId: null });
  });
});

describe("loadState", () => {
  it("tells loading, error, empty and loaded apart", () => {
    expect(loadState({ data: undefined, error: null, isLoading: true })).toEqual({ kind: "loading" });
    expect(loadState({ data: undefined, error: { message: "tasks is reloading" }, isLoading: false })).toEqual({ kind: "error", message: "tasks is reloading" });
    expect(loadState({ data: { items: [] }, error: null, isLoading: false })).toEqual({ kind: "empty" });
    expect(loadState({ data: { items: [1] }, error: { message: "stale" }, isLoading: false })).toEqual({ kind: "ready", items: [1] });
  });
});
