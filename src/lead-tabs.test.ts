import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { currentShownThread, hostStore, registerTabHost, tabStore, viewStore, type ThreadNavigate, type ThreadNode } from "@wy3z/bb-suite/thread-tabs";
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

let unregister: () => void = () => undefined;

beforeEach(() => {
  tabStore.set({});
  viewStore.set({});
  hostStore.set(0);
  unregister = registerTabHost();
});

afterEach(() => unregister());

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

  test("switches back to the lead's tab when its row is clicked while a worker tab shows", () => {
    click(WORKER, LEAD, { split: false });
    assert.deepEqual(click(LEAD, LEAD, { split: false }), []);
    assert.deepEqual(viewStore.get(), {});
    assert.deepEqual(tabStore.get()[LEAD], [WORKER]);
  });

  test("routes to the lead with its own tab selected from another thread", () => {
    viewStore.set({ [LEAD]: WORKER });
    assert.deepEqual(click(LEAD, OTHER, { split: false }), [[LEAD]]);
    assert.deepEqual(viewStore.get(), {});
  });

  test("keeps Ctrl-click on the lead as a split", () => {
    viewStore.set({ [LEAD]: WORKER });
    assert.deepEqual(click(LEAD, OTHER, { split: true }), [[LEAD, { split: true }]]);
    assert.deepEqual(viewStore.get(), { [LEAD]: WORKER });
  });

  test("leaves other top-level threads on plain navigation", () => {
    viewStore.set({ [LEAD]: WORKER });
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

describe("the highlighted row", () => {
  const leadIds = new Set([LEAD]);
  const shown = (current: string | null) => currentShownThread(current, leadIds, (id) => byId.has(id));

  test("follows the worker tab while it shows, then the lead once its tab is clicked", () => {
    assert.equal(shown(LEAD), LEAD);
    click(NESTED, LEAD, { split: false });
    assert.equal(shown(LEAD), NESTED);
    click(WORKER, LEAD, { split: false });
    assert.equal(shown(LEAD), WORKER);
    click(LEAD, LEAD, { split: false });
    assert.equal(shown(LEAD), LEAD);
  });

  test("leaves the board row active only while the lead's own tab shows", () => {
    const boardActive = () => shown(LEAD) === LEAD;
    assert.equal(boardActive(), true);
    click(WORKER, LEAD, { split: false });
    assert.equal(boardActive(), false);
    click(LEAD, LEAD, { split: false });
    assert.equal(boardActive(), true);
  });

  test("stays on the lead when Projects has no tab host to show the worker", () => {
    click(WORKER, LEAD, { split: false });
    unregister();
    assert.equal(shown(LEAD), LEAD);
  });

  test("stays on the routed thread away from a lead", () => {
    click(WORKER, LEAD, { split: false });
    assert.equal(shown(OTHER), OTHER);
    assert.equal(shown(null), null);
  });
});

describe("without a Projects tab host", () => {
  beforeEach(() => unregister());

  test("opens a worker on its own route, as an older Projects build expects", () => {
    assert.deepEqual(click(WORKER, LEAD, { split: false }), [[WORKER, { split: false }]]);
    assert.deepEqual(tabStore.get(), {});
    assert.deepEqual(viewStore.get(), {});
  });

  test("opens the lead plainly and leaves its views alone", () => {
    viewStore.set({ [LEAD]: WORKER });
    assert.deepEqual(click(LEAD, OTHER, { split: false }), [[LEAD, { split: false }]]);
    assert.deepEqual(viewStore.get(), { [LEAD]: WORKER });
  });
});
