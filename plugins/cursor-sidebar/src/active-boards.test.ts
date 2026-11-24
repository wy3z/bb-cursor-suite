import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { activeProjectBoards } from "./active-boards";
import { familyRootId } from "./standalone-groups";
import type { SidebarView } from "./server";
import { DEFAULT_SIDEBAR_VIEW, filterOrdinaryThreads } from "./sidebar-view";

function thread(id: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id, projectId: "proj_web", title: id, titleFallback: null, displayTitle: id,
    parentThreadId: null, lifecycleOwnerThreadId: null, parentNotifications: "auto",
    sourceThreadId: null, sectionId: null, originKind: null, originPluginId: null,
    providerId: "codex", status: "idle", runtimeStatus: "idle", queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
    indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false,
    pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null,
    href: `/threads/${id}`, isHidden: false, environment: null, host: null,
    createdAt: 0, updatedAt: 0, lastReadAt: null, latestAttentionAt: 0,
    ...overrides,
  };
}

const boards = [
  { id: "WEB", leadThreadId: "web-lead" },
  { id: "API", leadThreadId: "api-lead" },
  { id: "OPS", leadThreadId: null },
];

function rootOfIn(threads: readonly PluginSidebarThread[]) {
  const byId = new Map(threads.map((entry) => [entry.id, entry]));
  return (id: string) => familyRootId((current) => byId.get(current)?.parentThreadId ?? null, id);
}

function activeIds(threads: readonly PluginSidebarThread[], view: SidebarView = DEFAULT_SIDEBAR_VIEW, bypass: (entry: PluginSidebarThread) => boolean = () => false) {
  const shown = filterOrdinaryThreads(threads, view, { now: 0, bypass });
  return activeProjectBoards(boards, shown, rootOfIn(threads)).map((board) => board.id);
}

test("a board is active when its lead passes the filters", () => {
  assert.deepEqual(activeIds([thread("web-lead"), thread("api-lead")]), ["WEB", "API"]);
});

test("a board with no shown thread is inactive and keeps the others' order", () => {
  assert.deepEqual(activeIds([thread("api-lead"), thread("loose")]), ["API"]);
});

test("a board whose lead is filtered out stays active through any matching child", () => {
  const threads = [
    thread("web-lead"),
    thread("web-worker", { parentThreadId: "web-lead" }),
    thread("web-nested", { parentThreadId: "web-worker", hasPendingInteraction: true }),
    thread("api-lead"),
  ];
  const inputOnly: SidebarView = { ...DEFAULT_SIDEBAR_VIEW, statusFilter: ["input"] };
  assert.deepEqual(activeIds(threads, inputOnly), ["WEB"]);
});

test("every board goes inactive when the filters hide all of their threads", () => {
  const threads = [
    thread("web-lead"),
    thread("web-worker", { parentThreadId: "web-lead" }),
    thread("api-lead"),
  ];
  const failedOnly: SidebarView = { ...DEFAULT_SIDEBAR_VIEW, statusFilter: ["failed"] };
  assert.deepEqual(activeIds(threads, failedOnly), []);
});

test("a project filter hides boards from other projects", () => {
  const threads = [thread("web-lead"), thread("api-lead", { projectId: "proj_api" })];
  const apiOnly: SidebarView = { ...DEFAULT_SIDEBAR_VIEW, projectFilter: ["proj_api"] };
  assert.deepEqual(activeIds(threads, apiOnly), ["API"]);
});

test("archived threads never make a board active", () => {
  const shown = [
    thread("web-lead", { isArchived: true }),
    thread("web-worker", { parentThreadId: "web-lead", isArchived: true }),
  ];
  assert.deepEqual(activeProjectBoards(boards, shown, rootOfIn(shown)), []);
});

test("the open family bypasses the filters and keeps its board", () => {
  const threads = [thread("web-lead"), thread("api-lead")];
  const failedOnly: SidebarView = { ...DEFAULT_SIDEBAR_VIEW, statusFilter: ["failed"] };
  assert.deepEqual(activeIds(threads, failedOnly, (entry) => entry.id === "api-lead"), ["API"]);
});

test("a board without a lead is never active", () => {
  assert.deepEqual(activeProjectBoards([{ id: "OPS", leadThreadId: null }], [thread("loose")], (id) => id), []);
});
