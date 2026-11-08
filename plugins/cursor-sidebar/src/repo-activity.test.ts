import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { buildSections } from "./forest";
import { hasHiddenWork, renderedRowIds, repoActivityMembers } from "./repo-activity";
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

function section(threads: PluginSidebarThread[]) {
  return buildSections(threads, [{ id: "repo", name: "Repo" }], () => "active", () => ({ compare: () => 0 }))[0]!;
}

test("the corner spinner shows only when a working thread's row is hidden", () => {
  const threads = [
    thread("parent", "repo"),
    thread("child", "repo", { parentThreadId: "parent", ...working }),
    thread("top", "repo"),
  ];
  const home = section(threads);
  const all = new Set(threads.map((item) => item.id));

  const expanded = renderedRowIds(home, { open: true, expandedParents: new Set(["parent"]), keepIds: all, childLimit: 10 });
  assert.equal(expanded.has("child"), true);
  assert.equal(hasHiddenWork(threads, expanded), false);

  const folded = renderedRowIds(home, { open: true, expandedParents: new Set(), keepIds: all, childLimit: 10 });
  assert.equal(folded.has("child"), false);
  assert.equal(hasHiddenWork(threads, folded), true);

  const collapsed = renderedRowIds(home, { open: false, expandedParents: new Set(["parent"]), keepIds: new Set(), childLimit: 10 });
  assert.equal(collapsed.size, 0);
  assert.equal(hasHiddenWork(threads, collapsed), true);
});

test("a collapsed repo showing the selected working thread draws no spinner", () => {
  const threads = [thread("parent", "repo"), thread("child", "repo", { parentThreadId: "parent", ...working })];
  const path = new Set(["parent", "child"]);
  const rendered = renderedRowIds(section(threads), { open: false, expandedParents: new Set(), keepIds: path, expandIds: path, childLimit: 10 });
  assert.deepEqual([...rendered].sort(), ["child", "parent"]);
  assert.equal(hasHiddenWork(threads, rendered), false);
});

test("work past the show-more page or filtered out of the list counts as hidden", () => {
  const threads = [thread("a", "repo"), thread("b", "repo", working)];
  const rendered = renderedRowIds(section(threads), { open: true, expandedParents: new Set(), keepIds: new Set(["a"]), childLimit: 10 });
  assert.deepEqual([...rendered], ["a"]);
  assert.equal(hasHiddenWork(threads, rendered), true);
  assert.equal(hasHiddenWork([thread("gone", "repo", { ...working, isArchived: true })], new Set()), false);
});
