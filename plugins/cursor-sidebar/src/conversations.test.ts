import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { pageLeadChildren } from "./conversations";

function row(id: string, depth: number, overrides: Partial<PluginSidebarThread> = {}) {
  const thread = {
    id, isPinned: false, hasPendingInteraction: false, indicator: "none", isUnread: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
    ...overrides,
  } as PluginSidebarThread;
  return { row: { thread, depth, guides: [] } };
}

test("a lead's children page by Threads per group, keeping active ones and whole subtrees", () => {
  const items = [
    row("working", 1, { indicator: "runtime" }),
    row("a", 1),
    row("a-child", 2),
    row("b", 1),
    row("c", 1),
    row("selected", 1),
  ];
  const ids = (limit: number) =>
    pageLeadChildren(items, { activeThreadId: "selected", limit });
  assert.deepEqual(ids(1).shown.map((item) => item.row.thread.id), ["working", "a", "a-child", "selected"]);
  assert.equal(ids(1).hiddenConversations, 2);
  assert.deepEqual(ids(Number.POSITIVE_INFINITY).shown.length, 6);
  assert.equal(ids(Number.POSITIVE_INFINITY).hiddenConversations, 0);
});
