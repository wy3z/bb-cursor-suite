/**
 * One row's worth of activity: active child threads from BB's live sidebar
 * feed, plus everything the backend folds out of the thread timeline.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_useSidebarThreads,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { AGENT_PILLS_CHANNEL } from "./channels";
import {
  agentPillsRpcContract,
  type ActiveGoal,
  type ActivePlan,
  type ActiveWorkflow,
  type BackgroundTask,
  type MachineState,
  type ModelFallback,
  type PendingTodos,
  type QueuedMessage,
  type ThreadState,
} from "./rpc";
import { readDismissedFallback, useFallbackDismissal } from "./pill-preferences";

export type PillGroup =
  | "subagents"
  | "background"
  | "workflow"
  | "plan"
  | "goal"
  | "todos"
  | "fallback"
  | "queue"
  | "thread"
  | "machine";

export type PillState = "running" | "needs-input" | "error" | "done" | "done-unread";

export interface SubagentItem {
  threadId: string;
  title: string;
  state: PillState;
  model: string | null;
  createdAt: number;
}

export interface TaskItem {
  id: string;
  kind: "agent" | "command";
  title: string;
  state: PillState;
  model: string | null;
  startedAt: number;
}

export interface Activity {
  subagents: SubagentItem[];
  background: TaskItem[];
  workflows: ActiveWorkflow[];
  plan: ActivePlan | null;
  goal: ActiveGoal | null;
  todos: PendingTodos | null;
  modelFallback: ModelFallback | null;
  queue: QueuedMessage[];
  thread: ThreadState;
  machine: MachineState | null;
}

export interface ActivityState {
  activity: Activity;
  /** Re-read the backend after an action changed something. */
  refresh: () => void;
  /** Hide this thread's model-fallback pill for this thread, this browser. */
  dismissFallback: () => void;
}

/**
 * BB calls a task an agent only for these two task types; every other type,
 * workflows included, draws the command icon (`isBackgroundAgentTaskType`).
 */
function isAgentTask(taskType: string): boolean {
  return taskType === "local_agent" || taskType === "local_subagent";
}

/** BB's own "active child threads" predicate, copied from its ThreadScreen. */
const ACTIVE_RUNTIME_STATUSES = new Set([
  "active",
  "provisioning",
  "starting",
  "waiting-for-host",
]);

type SidebarThread = ReturnType<typeof experimental_useSidebarThreads>["threads"][number];

/** Paseo's bucket order: what needs you first, then work in flight, then results. */
export const STATE_ORDER: Record<PillState, number> = {
  "needs-input": 0,
  running: 1,
  error: 2,
  "done-unread": 3,
  done: 4,
};

/**
 * A child's pill state, or null when it has nothing to report: still working,
 * waiting on you, or finished with a result you have not read yet.
 */
function childState(thread: SidebarThread): PillState | null {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") {
    return "needs-input";
  }
  if (ACTIVE_RUNTIME_STATUSES.has(thread.runtimeStatus)) return "running";
  if (thread.indicator === "unread-error") return "error";
  if (thread.indicator === "unread-success") return "done-unread";
  return null;
}

const IDLE_THREAD: ThreadState = {
  archived: false,
  workspaceGone: false,
  environmentId: null,
};

const EMPTY: Activity = {
  subagents: [],
  background: [],
  workflows: [],
  plan: null,
  goal: null,
  todos: null,
  modelFallback: null,
  queue: [],
  thread: IDLE_THREAD,
  machine: null,
};

interface ActivityResponse {
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

const EMPTY_RESPONSE: ActivityResponse = {
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

export function useActivity(threadId: string): ActivityState {
  const { threads } = experimental_useSidebarThreads();
  const currentThread = threads.find((thread) => thread.id === threadId);

  const children = useMemo(
    () =>
      threads
        .filter(
          (thread) =>
            thread.parentThreadId === threadId &&
            thread.originKind === null &&
            !thread.isArchived &&
            !thread.isHidden &&
            childState(thread) !== null,
        )
        .sort((left, right) => {
          const rank =
            STATE_ORDER[childState(left)!] - STATE_ORDER[childState(right)!];
          return rank !== 0 ? rank : right.latestAttentionAt - left.latestAttentionAt;
        }),
    [threadId, threads],
  );

  const childIds = useMemo(
    () => children.map((thread) => thread.id),
    [children],
  );
  const childKey = childIds.join("|");

  const rpc = useRpc<typeof agentPillsRpcContract>();
  const [response, setResponse] = useState<ActivityResponse | null>(null);
  const request = useRef(0);

  const refresh = useCallback(() => {
    const id = ++request.current;
    void rpc
      .call("threadActivity", {
        threadId,
        childThreadIds: childIds,
      })
      .then((result) => {
        if (id === request.current) setResponse(result);
      })
      .catch(() => {
        if (id === request.current) setResponse(EMPTY_RESPONSE);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childKey, rpc, threadId]);

  useEffect(() => {
    setResponse(null);
    refresh();
  }, [refresh]);

  useRealtime(AGENT_PILLS_CHANNEL, (payload) => {
    const updated = (payload as { threadId?: unknown } | null)?.threadId;
    if (updated === threadId) refresh();
  });

  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    // A reconnect can drop the ephemeral signals sent while offline.
    if (previousConnection.current !== "connected" && connection === "connected") {
      refresh();
    }
    previousConnection.current = connection;
  }, [connection, refresh]);

  const [dismissedSeq, dismissFallback] = useFallbackDismissal(threadId);

  const activity = useMemo<Activity>(() => {
    if (!currentThread) return EMPTY;
    const models = new Map(
      (response?.models ?? []).map((row) => [row.threadId, row.model]),
    );
    const fallback = response?.modelFallback ?? null;
    return {
      subagents: children.map((thread) => ({
        threadId: thread.id,
        title: thread.displayTitle,
        state: childState(thread)!,
        model: models.get(thread.id) ?? null,
        createdAt: thread.createdAt,
      })),
      background: (response?.tasks ?? []).map((task) => ({
        id: task.id,
        kind: isAgentTask(task.taskType) ? ("agent" as const) : ("command" as const),
        title: task.description,
        state:
          task.status === "error"
            ? ("error" as const)
            : task.taskStatus === "completed"
              ? ("done" as const)
              : ("running" as const),
        model: task.model,
        startedAt: task.startedAt,
      })),
      workflows: response?.workflows ?? [],
      plan: response?.plan ?? null,
      goal: response?.goal ?? null,
      todos: response?.todos ?? null,
      // Dismissing only hides the row for this sequence, so a later fallback
      // on the same thread comes back.
      modelFallback:
        fallback !== null &&
        dismissedSeq !== null &&
        fallback.sourceSeq === dismissedSeq
          ? null
          : fallback,
      queue: response?.queue ?? [],
      thread: response?.thread ?? IDLE_THREAD,
      machine: response?.machine ?? null,
    };
  }, [children, currentThread, dismissedSeq, response]);

  return {
    activity,
    refresh,
    dismissFallback: () => {
      const seq = response?.modelFallback?.sourceSeq;
      if (seq !== undefined && seq !== readDismissedFallback(threadId)) {
        dismissFallback(seq);
      }
    },
  };
}
