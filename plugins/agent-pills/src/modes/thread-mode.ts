import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useRealtime, useRpc, type PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { agentPillsRpcContract } from "../rpc";
import type { ModeRef } from "./model";
import type { ThreadModeState } from "./rpc";
import { MODE_CHANNEL } from "./channel";
import { createDraftWriter } from "./draft-writer";

type Rpc = PluginRpcClient<typeof agentPillsRpcContract>;

export interface ThreadWorkspace {
  projectId: string | null;
  environmentId: string | null;
  providerId: string | null;
}

export interface ThreadModeData {
  state: ThreadModeState;
  workspace: ThreadWorkspace;
}

interface Snapshot {
  data: ThreadModeData | null;
  hydrated: boolean;
  desired: { mode: ModeRef | null } | null;
}

const THREAD_STORE_PREFIX = "bb-plugin-agent-pills.thread-mode.v1:";

function cachedThreadMode(threadId: string): ThreadModeData | null {
  try {
    const raw = localStorage.getItem(THREAD_STORE_PREFIX + threadId);
    const parsed = raw ? (JSON.parse(raw) as ThreadModeData) : null;
    return parsed && typeof parsed.state === "object" && typeof parsed.workspace === "object" ? { ...parsed, state: { ...parsed.state, notice: null } } : null;
  } catch {
    return null;
  }
}

function persistThreadMode(threadId: string, data: ThreadModeData): void {
  try {
    localStorage.setItem(THREAD_STORE_PREFIX + threadId, JSON.stringify(data));
  } catch {
    return;
  }
}

class ThreadModeStore {
  private snapshot: Snapshot;
  private readonly listeners = new Set<() => void>();
  private rpc: Rpc | null = null;
  private request = 0;
  private readonly writer: ReturnType<typeof createDraftWriter>;

  constructor(private readonly threadId: string) {
    this.snapshot = { data: cachedThreadMode(threadId), hydrated: false, desired: null };
    this.writer = createDraftWriter({
      write: (mode, rev) => this.requireRpc().call("setThreadMode", { threadId, mode, rev }),
      settled: (state) => {
        const workspace = this.snapshot.data?.workspace;
        this.set({ desired: null });
        if (workspace) this.accept({ state, workspace });
      },
      failed: () => {
        this.set({ desired: null });
        this.refresh();
      },
    });
  }

  private requireRpc(): Rpc {
    if (this.rpc === null) throw new Error("not attached");
    return this.rpc;
  }

  private set(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private accept(data: ThreadModeData): void {
    persistThreadMode(this.threadId, data);
    this.set({ data, hydrated: true });
  }

  getSnapshot = (): Snapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0 && this.rpc !== null) {
      this.set({ hydrated: false });
      this.refresh();
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  attach(rpc: Rpc): void {
    const first = this.rpc === null;
    this.rpc = rpc;
    if (first) this.refresh();
  }

  refresh = (): void => {
    if (this.rpc === null) return;
    const id = ++this.request;
    this.rpc
      .call("threadMode", { threadId: this.threadId })
      .then((result) => {
        if (id !== this.request) return;
        this.writer.know(result.state);
        this.accept({
          state: result.state,
          workspace: { projectId: result.projectId, environmentId: result.environmentId, providerId: result.providerId },
        });
      })
      .catch(() => undefined);
  };

  setDraft = (mode: ModeRef | null): boolean => {
    if (this.rpc === null || !this.snapshot.hydrated) return false;
    this.set({ desired: { mode } });
    void this.writer.choose(mode);
    return true;
  };

  clearNotice = (): void => {
    const data = this.snapshot.data;
    if (data) this.set({ data: { ...data, state: { ...data.state, notice: null } } });
    this.rpc?.call("clearModeNotice", { threadId: this.threadId }).catch(() => undefined);
  };
}

const stores = new Map<string, ThreadModeStore>();

function storeFor(threadId: string): ThreadModeStore {
  let store = stores.get(threadId);
  if (!store) {
    store = new ThreadModeStore(threadId);
    stores.set(threadId, store);
  }
  return store;
}

const EMPTY_SNAPSHOT: Snapshot = { data: null, hydrated: false, desired: null };
const noopSubscribe = () => () => undefined;

export function useThreadMode(threadId: string | null) {
  const rpc = useRpc<typeof agentPillsRpcContract>();
  const store = threadId === null ? null : storeFor(threadId);
  useEffect(() => {
    store?.attach(rpc);
  }, [rpc, store]);
  const snapshot = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : () => EMPTY_SNAPSHOT,
    store ? store.getSnapshot : () => EMPTY_SNAPSHOT,
  );
  useRealtime(MODE_CHANNEL, (payload) => {
    if (store && (payload as { threadId?: unknown } | null)?.threadId === threadId) store.refresh();
  });
  const setDraft = useCallback((mode: ModeRef | null) => store?.setDraft(mode) ?? false, [store]);
  const clearNotice = useCallback(() => store?.clearNotice(), [store]);
  const refresh = useCallback(() => store?.refresh(), [store]);
  const data = useMemo<ThreadModeData | null>(
    () =>
      snapshot.data && snapshot.desired
        ? { ...snapshot.data, state: { ...snapshot.data.state, draft: snapshot.desired.mode } }
        : snapshot.data,
    [snapshot.data, snapshot.desired],
  );
  return useMemo(
    () => ({ data, hydrated: snapshot.hydrated, writing: snapshot.desired !== null, setDraft, clearNotice, refresh }),
    [clearNotice, data, refresh, setDraft, snapshot.desired, snapshot.hydrated],
  );
}

type NewThreadListener = () => void;
const NEW_THREAD_PREFIX = "bb-plugin-agent-pills.new-thread-mode.v1:";
const newThreadModes = new Map<string, ModeRef | null>();
const newThreadListeners = new Map<string, Set<NewThreadListener>>();

function readNewThread(key: string): ModeRef | null {
  if (newThreadModes.has(key)) return newThreadModes.get(key) ?? null;
  let mode: ModeRef | null = null;
  try {
    const raw = sessionStorage.getItem(NEW_THREAD_PREFIX + key);
    const parsed = raw ? (JSON.parse(raw) as Partial<ModeRef> | null) : null;
    mode = parsed && typeof parsed.skillId === "string" && typeof parsed.label === "string" ? { skillId: parsed.skillId, label: parsed.label } : null;
  } catch {
    mode = null;
  }
  newThreadModes.set(key, mode);
  return mode;
}

export function setNewThreadMode(key: string, mode: ModeRef | null): void {
  newThreadModes.set(key, mode);
  try {
    if (mode === null) sessionStorage.removeItem(NEW_THREAD_PREFIX + key);
    else sessionStorage.setItem(NEW_THREAD_PREFIX + key, JSON.stringify(mode));
  } catch {
    return;
  } finally {
    for (const listener of newThreadListeners.get(key) ?? []) listener();
  }
}

export function useNewThreadMode(key: string): ModeRef | null {
  return useSyncExternalStore(
    (listener) => {
      const set = newThreadListeners.get(key) ?? new Set<NewThreadListener>();
      set.add(listener);
      newThreadListeners.set(key, set);
      return () => {
        set.delete(listener);
      };
    },
    () => readNewThread(key),
    () => readNewThread(key),
  );
}
