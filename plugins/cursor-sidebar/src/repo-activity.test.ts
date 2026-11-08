import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { buildSections, flattenShelf } from "./forest";
import { hasHiddenWork, renderedIdsOf, repoActivityMembers, sameIds } from "./repo-activity";
import { aggregateSectionStatus } from "./status";

function thread(id: string, projectId: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id, projectId, title: id, titleFallback: null, displayTitle: id,
    parentThreadId: null, lifecycleOwnerThreadId: null, parentNotifications: "auto",
    sourceThreadId: null, sectionId: null, originKind: null, originPluginId: null,
    providerId: "codex", status: "idle", runtimeStatus: "idle", queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
    indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false,
    pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null,
    href: `/threads/${id}`, isHidden: false, environment: null, host: null,
    createdAt: 0, updatedAt: 1, lastReadAt: null, latestAttentionAt: 0,
    ...overrides,
  };
}

const working = { indicator: "runtime" } as const;

function rootOf(threads: readonly PluginSidebarThread[]) {
  const byId = new Map(threads.map((item) => [item.id, item]));
  return (id: string) => {
    let cursor = byId.get(id);
    while (cursor?.parentThreadId && byId.has(cursor.parentThreadId)) cursor = byId.get(cursor.parentThreadId);
    return cursor?.id ?? id;
  };
}

test("a board's working threads light the board row, not their repo row", () => {
  const threads = [
    thread("lead", "repo"),
    thread("worker", "repo", { parentThreadId: "lead", ...working }),
    thread("plain", "repo"),
    thread("elsewhere", "other", working),
  ];
  const members = repoActivityMembers(threads, "repo", rootOf(threads), new Set(), new Set(["lead"]));
  assert.deepEqual(members.map((item) => item.id), ["plain"]);
  assert.equal(aggregateSectionStatus(members).working, false);

  const boardless = repoActivityMembers(threads, "repo", rootOf(threads), new Set(), new Set());
  assert.equal(aggregateSectionStatus(boardless).working, true);
});

test("a repo still shows work from threads that belong to no board", () => {
  const threads = [thread("lead", "repo"), thread("solo", "repo", working)];
  const members = repoActivityMembers(threads, "repo", rootOf(threads), new Set(), new Set(["lead"]));
  assert.equal(aggregateSectionStatus(members).working, true);
});

test("pinned families stay out of the repo row's activity", () => {
  const threads = [thread("pinned", "repo", { isPinned: true, ...working })];
  assert.deepEqual(repoActivityMembers(threads, "repo", rootOf(threads), new Set(["pinned"]), new Set()), []);
});

function rows(threads: PluginSidebarThread[]) {
  const home = buildSections(threads, [{ id: "repo", name: "Repo" }], () => "active", () => ({ compare: () => 0 }))[0]!;
  return flattenShelf(home, "active");
}

test("rendered ids come from the blocks ShelfList draws: closed folders and paged-out rows are hidden", () => {
  const threads = [thread("open-row", "repo"), thread("folder-row", "repo", working), thread("paged-out", "repo", working)];
  const all = rows(threads);
  const byId = (id: string) => all.filter((row) => row.thread.id === id);
  const rendered = renderedIdsOf([
    { open: true, rows: byId("open-row") },
    { open: false, rows: byId("folder-row") },
  ]);
  assert.deepEqual([...rendered], ["open-row"]);
  assert.equal(hasHiddenWork(threads, rendered), true);
  assert.equal(hasHiddenWork(threads, renderedIdsOf([{ open: true, rows: all }])), false);
});

test("a revealed nested child counts as on screen once ShelfList renders it", () => {
  const threads = [thread("parent", "repo"), thread("child", "repo", { parentThreadId: "parent", ...working })];
  const all = rows(threads);
  assert.equal(hasHiddenWork(threads, renderedIdsOf([{ open: true, rows: all.filter((row) => row.thread.id === "parent") }])), true);
  assert.equal(hasHiddenWork(threads, renderedIdsOf([{ open: true, rows: all }])), false);
});

test("a collapsed repo with nothing rendered shows hidden work", () => {
  const threads = [thread("solo", "repo", working)];
  assert.equal(hasHiddenWork(threads, new Set()), true);
  assert.equal(hasHiddenWork([thread("gone", "repo", { ...working, isArchived: true })], new Set()), false);
});

test("rendered id sets compare by content", () => {
  assert.equal(sameIds(new Set(["a", "b"]), new Set(["b", "a"])), true);
  assert.equal(sameIds(new Set(["a"]), new Set(["a", "b"])), false);
});
