import { useSyncExternalStore } from "react";

const STORE_KEY = "bb-projects:tabs";
const HEADER_SELECTOR = "header:has([data-thread-header-workflow-actions])";

type TabStore = Record<string, string[]>;

export interface ThreadNode {
  id: string;
  parentThreadId: string | null;
}

export interface ThreadNavigate {
  toThread(threadId: string, options?: { split?: boolean }): void;
}

export type OpenPlan =
  | { kind: "navigate"; threadId: string; split: boolean }
  | { kind: "tab"; leadId: string; view: string | null; navigate: boolean };

function readStore(): TabStore {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as TabStore;
  } catch {
    return {};
  }
}

function createStore<T>(initial: T, persist?: (value: T) => void) {
  const listeners = new Set<() => void>();
  let value = initial;
  return {
    get: () => value,
    set(next: T) {
      value = next;
      persist?.(next);
      for (const listener of listeners) listener();
    },
    use(): T {
      return useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => value,
      );
    },
  };
}

export const tabStore = createStore<TabStore>(readStore(), (next) => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    void 0;
  }
});

export const viewStore = createStore<Record<string, string>>({});

export function setView(leadId: string, id: string | null) {
  const next = { ...viewStore.get() };
  if (id) next[leadId] = id;
  else delete next[leadId];
  viewStore.set(next);
}

export function addTab(leadId: string, id: string) {
  if (id === leadId) return;
  const open = tabStore.get()[leadId] ?? [];
  if (!open.includes(id)) tabStore.set({ ...tabStore.get(), [leadId]: [...open, id] });
}

export function findLead(threadId: string | null, byId: ReadonlyMap<string, ThreadNode>, leadIds: ReadonlySet<string>): string | null {
  let cursor = threadId ? byId.get(threadId) : undefined;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    if (leadIds.has(cursor.id)) return cursor.id;
    seen.add(cursor.id);
    cursor = cursor.parentThreadId ? byId.get(cursor.parentThreadId) : undefined;
  }
  return null;
}

export function planThreadOpen({
  target,
  current,
  leadId,
  split,
  conversationHidden,
}: {
  target: string;
  current: string | null;
  leadId: string | null;
  split: boolean;
  conversationHidden: boolean;
}): OpenPlan {
  if (split || !leadId) return { kind: "navigate", threadId: target, split };
  return { kind: "tab", leadId, view: target === leadId ? null : target, navigate: current !== leadId || conversationHidden };
}

export function applyOpenPlan(plan: OpenPlan, navigate: ThreadNavigate) {
  if (plan.kind === "navigate") {
    navigate.toThread(plan.threadId, plan.split ? { split: true } : undefined);
    return;
  }
  if (plan.view) addTab(plan.leadId, plan.view);
  setView(plan.leadId, plan.view);
  if (plan.navigate) navigate.toThread(plan.leadId);
}

export function findHeader(): HTMLElement | null {
  const headers = [...document.querySelectorAll<HTMLElement>(HEADER_SELECTOR)];
  if (headers.length === 1) return headers[0]!;
  return headers.find((header) => header.querySelector("[data-pane-header-focus-tab]") || header.querySelector(".bbp-tabs-host")) ?? null;
}

export function locateThreadWindow(): HTMLElement | null {
  const header = findHeader();
  const pane = header?.closest<HTMLElement>("[data-split-pane-id]") ?? document;
  return pane.querySelector<HTMLElement>("[data-thread-window]");
}

export function conversationHidden(): boolean {
  const chat = locateThreadWindow();
  return !chat || chat.getBoundingClientRect().width === 0;
}
