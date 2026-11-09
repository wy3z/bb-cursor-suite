import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { tabStore, viewStore, type ThreadNavigate, type ThreadNode } from "@wy3z/bb-suite/thread-tabs";
import { openSidebarThread, type ThreadRouting } from "./lead-tabs";

const LEAD = "thr_lead";
const WORKER = "thr_worker";
const NESTED = "thr_nested";
const LOOSE_PARENT = "thr_loose_parent";
const LOOSE_CHILD = "thr_loose_child";
const OTHER = "thr_other";

const nodes: ThreadNode[] = [
  { id: LEAD, parentThreadId: null },
  { id: WORKER, parentThreadId: LEAD },
  { id: NESTED, parentThreadId: WORKER },
  { id: LOOSE_PARENT, parentThreadId: null },
  { id: LOOSE_CHILD, parentThreadId: LOOSE_PARENT },
  { id: OTHER, parentThreadId: null },
];
const byId = new Map(nodes.map((node) => [node.id, node]));

function routing(current: string | null): ThreadRouting {
  return { current, byId, leadIds: new Set([LEAD]) };
}

function click(target: string, current: string | null, options?: { split?: boolean }, hidden = false) {
  const calls: unknown[][] = [];
  const navigate: ThreadNavigate = { toThread: (...args) => calls.push(args) };
  openSidebarThread(target, options, routing(current), navigate, () => hidden);
  return calls;
}

beforeEach(() => {
  tabStore.set({});
  viewStore.set({});
});

describe("opening a thread from the sidebar", () => {
  test("opens a worker as a tab of its lead from another thread", () => {
    assert.deepEqual(click(WORKER, OTHER, { split: false }), [[LEAD]]);
    assert.deepEqual(tabStore.get()[LEAD], [WORKER]);
    assert.equal(viewStore.get()[LEAD], WORKER);
  });

  test("switches tabs in place when the lead is already showing, so its side panel stays", () => {
    assert.deepEqual(click(NESTED, LEAD, { split: false }), []);
    assert.deepEqual(tabStore.get()[LEAD], [NESTED]);
    assert.equal(viewStore.get()[LEAD], NESTED);
  });

  test("brings the conversation back when the lead's panel is maximized", () => {
    assert.deepEqual(click(WORKER, LEAD, { split: false }, true), [[LEAD]]);
    assert.equal(viewStore.get()[LEAD], WORKER);
  });

  test("keeps Ctrl-click as a split of the worker itself", () => {
    assert.deepEqual(click(WORKER, LEAD, { split: true }), [[WORKER, { split: true }]]);
    assert.deepEqual(tabStore.get(), {});
    assert.deepEqual(viewStore.get(), {});
  });

  test("leaves top-level threads, including the lead, on plain navigation", () => {
    viewStore.set({ [LEAD]: WORKER });
    assert.deepEqual(click(LEAD, OTHER, { split: false }), [[LEAD, { split: false }]]);
    assert.deepEqual(click(OTHER, LEAD, undefined), [[OTHER, undefined]]);
    assert.deepEqual(viewStore.get(), { [LEAD]: WORKER });
    assert.deepEqual(tabStore.get(), {});
  });

  test("navigates plainly to children with no project lead above them", () => {
    assert.deepEqual(click(LOOSE_CHILD, OTHER, { split: false }), [[LOOSE_CHILD, undefined]]);
    assert.deepEqual(tabStore.get(), {});
  });

  test("navigates plainly outside the sidebar tree, where no routing is provided", () => {
    const calls: unknown[][] = [];
    openSidebarThread(WORKER, undefined, null, { toThread: (...args) => calls.push(args) });
    assert.deepEqual(calls, [[WORKER, undefined]]);
    assert.deepEqual(viewStore.get(), {});
  });
});
