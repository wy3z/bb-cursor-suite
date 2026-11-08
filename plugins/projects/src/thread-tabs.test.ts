import { beforeEach, describe, expect, it } from "vitest";
import { applyOpenPlan, findLead, planThreadOpen, tabStore, viewStore, type ThreadNavigate, type ThreadNode } from "./thread-tabs";

const LEAD = "thr_lead";
const WORKER = "thr_worker";
const NESTED = "thr_nested";
const OTHER = "thr_other";

const nodes: ThreadNode[] = [
  { id: LEAD, parentThreadId: null },
  { id: WORKER, parentThreadId: LEAD },
  { id: NESTED, parentThreadId: WORKER },
  { id: OTHER, parentThreadId: null },
];
const byId = new Map(nodes.map((node) => [node.id, node]));
const leads = new Set([LEAD]);

function recorder() {
  const calls: { threadId: string; options?: { split?: boolean } }[] = [];
  const navigate: ThreadNavigate = { toThread: (threadId, options) => calls.push(options ? { threadId, options } : { threadId }) };
  return { calls, navigate };
}

function open(target: string, current: string | null, options: { split?: boolean; hidden?: boolean } = {}) {
  const { calls, navigate } = recorder();
  const plan = planThreadOpen({
    target,
    current,
    leadId: findLead(target, byId, leads),
    split: options.split ?? false,
    conversationHidden: options.hidden ?? false,
  });
  applyOpenPlan(plan, navigate);
  return { plan, calls };
}

beforeEach(() => {
  tabStore.set({});
  viewStore.set({});
});

describe("findLead", () => {
  it("walks up to the lead from a worker and a nested worker", () => {
    expect(findLead(LEAD, byId, leads)).toBe(LEAD);
    expect(findLead(WORKER, byId, leads)).toBe(LEAD);
    expect(findLead(NESTED, byId, leads)).toBe(LEAD);
  });

  it("returns null outside a project or for unknown threads and cycles", () => {
    expect(findLead(OTHER, byId, leads)).toBeNull();
    expect(findLead("thr_missing", byId, leads)).toBeNull();
    expect(findLead(null, byId, leads)).toBeNull();
    const loop = new Map<string, ThreadNode>([
      ["a", { id: "a", parentThreadId: "b" }],
      ["b", { id: "b", parentThreadId: "a" }],
    ]);
    expect(findLead("a", loop, leads)).toBeNull();
  });
});

describe("opening a thread from the board", () => {
  it("shows a worker as a lead tab without leaving the lead, so the lead's side panel stays", () => {
    const { plan, calls } = open(WORKER, LEAD);
    expect(plan).toEqual({ kind: "tab", leadId: LEAD, view: WORKER, navigate: false });
    expect(calls).toEqual([]);
    expect(tabStore.get()[LEAD]).toEqual([WORKER]);
    expect(viewStore.get()[LEAD]).toBe(WORKER);
  });

  it("goes to the lead, not the worker's own route, when opened from elsewhere", () => {
    for (const current of [WORKER, OTHER, null]) {
      tabStore.set({});
      viewStore.set({});
      const { calls } = open(NESTED, current);
      expect(calls).toEqual([{ threadId: LEAD }]);
      expect(tabStore.get()[LEAD]).toEqual([NESTED]);
      expect(viewStore.get()[LEAD]).toBe(NESTED);
    }
  });

  it("brings the conversation back when the lead's panel is maximized", () => {
    const { calls } = open(WORKER, LEAD, { hidden: true });
    expect(calls).toEqual([{ threadId: LEAD }]);
    expect(viewStore.get()[LEAD]).toBe(WORKER);
  });

  it("keeps one tab per worker when opened twice", () => {
    open(WORKER, LEAD);
    open(NESTED, LEAD);
    open(WORKER, LEAD);
    expect(tabStore.get()[LEAD]).toEqual([WORKER, NESTED]);
    expect(viewStore.get()[LEAD]).toBe(WORKER);
  });

  it("opening the lead itself clears the worker view", () => {
    open(WORKER, LEAD);
    const { plan, calls } = open(LEAD, LEAD);
    expect(plan).toEqual({ kind: "tab", leadId: LEAD, view: null, navigate: false });
    expect(calls).toEqual([]);
    expect(viewStore.get()[LEAD]).toBeUndefined();
    expect(tabStore.get()[LEAD]).toEqual([WORKER]);
  });

  it("still opens a real split on Ctrl-click and leaves the lead's tabs alone", () => {
    const { calls } = open(WORKER, LEAD, { split: true });
    expect(calls).toEqual([{ threadId: WORKER, options: { split: true } }]);
    expect(tabStore.get()).toEqual({});
    expect(viewStore.get()).toEqual({});
  });

  it("navigates plainly to threads that have no lead", () => {
    const { calls } = open(OTHER, LEAD);
    expect(calls).toEqual([{ threadId: OTHER }]);
    expect(tabStore.get()).toEqual({});
  });
});
