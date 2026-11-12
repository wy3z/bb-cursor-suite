import type {
  ActiveGoal,
  ActivePlan,
  ActiveWorkflow,
  BackgroundTask,
  MachineState,
  ModelFallback,
  PendingTodos,
  QueuedMessage,
  ThreadState,
} from "./rpc";

export interface ActivityResponse {
  tasks: BackgroundTask[];
  models: Array<{ threadId: string; model: string | null }>;
  workflows: ActiveWorkflow[];
  plan: ActivePlan | null;
  goal: ActiveGoal | null;
  todos: PendingTodos | null;
  modelFallback: ModelFallback | null;
  queue: QueuedMessage[];
  thread: ThreadState;
  machine: MachineState | null;
}

export const IDLE_THREAD: ThreadState = {
  archived: false,
  workspaceGone: false,
  environmentId: null,
};

export const EMPTY_RESPONSE: ActivityResponse = {
  tasks: [],
  models: [],
  workflows: [],
  plan: null,
  goal: null,
  todos: null,
  modelFallback: null,
  queue: [],
  thread: IDLE_THREAD,
  machine: null,
};

type FetchActivity = () => Promise<ActivityResponse>;
type Listener = () => void;

interface Entry {
  response: ActivityResponse | null;
  listeners: Set<Listener>;
  fetch: FetchActivity;
  inFlight: boolean;
  refreshQueued: boolean;
  scheduled: boolean;
}

const entries = new Map<string, Entry>();

function publish(entry: Entry, response: ActivityResponse): void {
  entry.response = response;
  for (const listener of entry.listeners) listener();
}

function startRequest(key: string, entry: Entry): void {
  entry.inFlight = true;
  entry.refreshQueued = false;
  void entry
    .fetch()
    .catch(() => EMPTY_RESPONSE)
    .then((response) => {
      entry.inFlight = false;
      if (entries.get(key) !== entry) return;
      publish(entry, response);
      if (entry.refreshQueued) {
        entry.refreshQueued = false;
        startRequest(key, entry);
      }
    });
}

export function subscribeActivity(
  key: string,
  fetch: FetchActivity,
  listener: Listener,
): () => void {
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      response: null,
      listeners: new Set(),
      fetch,
      inFlight: false,
      refreshQueued: false,
      scheduled: false,
    };
    entries.set(key, entry);
    startRequest(key, entry);
  }
  const current = entry;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0 && entries.get(key) === current) {
      entries.delete(key);
    }
  };
}

export function readActivity(key: string): ActivityResponse | null {
  return entries.get(key)?.response ?? null;
}

export function refreshActivity(key: string): void {
  const entry = entries.get(key);
  if (!entry || entry.scheduled) return;
  entry.scheduled = true;
  queueMicrotask(() => {
    entry.scheduled = false;
    if (entries.get(key) !== entry) return;
    if (entry.inFlight) {
      entry.refreshQueued = true;
      return;
    }
    startRequest(key, entry);
  });
}
