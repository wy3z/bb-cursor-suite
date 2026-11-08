import { useCallback, useEffect, useMemo, useState } from "react";
import {
  experimental_useRpcKeyedQuery,
  experimental_useRpcQuery,
  experimental_useSidebarThreads,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { usePluginAvailability } from "@wy3z/bb-suite/plugin-availability";
import {
  GIT_PLUGIN,
  PULL_REQUESTS_PLUGIN,
  TASKS_PLUGIN,
  gitContract,
  gitStatusSchema,
  tasksContract,
  type Label,
  type Project,
  type PullRequest,
  type Status,
  type Task,
  type TaskThread,
} from "./contracts";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { projectsContract, type ReconcileView } from "./meta";
import { COLUMNS, columnOf, type Column } from "./status";
import { loadState, type LoadState } from "./moves";

const REFRESH_MS = 15_000;

function useTick(ms: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return tick;
}

export function useProjects(): { projects: Project[]; loading: boolean } {
  const query = experimental_useRpcQuery({
    pluginId: TASKS_PLUGIN,
    contract: tasksContract,
    method: "listProjects",
    input: {},
  });
  return { projects: query.data?.projects ?? [], loading: query.data === undefined && !query.error };
}

export interface ProjectData {
  tasks: Task[];
  labels: ReadonlyMap<string, Label>;
  activeThreads: ReadonlyMap<string, TaskThread[]>;
  attachmentCounts: ReadonlyMap<string, number>;
  loading: boolean;
  error: string | null;
}

export function useProjectData(projectId: string | null): ProjectData {
  const enabled = projectId !== null;
  const input = { projectId: projectId ?? "" };
  const tasks = experimental_useRpcQuery({ pluginId: TASKS_PLUGIN, contract: tasksContract, method: "listAllTasks", input, enabled });
  const labels = experimental_useRpcQuery({ pluginId: TASKS_PLUGIN, contract: tasksContract, method: "listLabels", input, enabled });
  const meta = experimental_useRpcQuery({ pluginId: TASKS_PLUGIN, contract: tasksContract, method: "listTaskCardMeta", input, enabled });
  return useMemo(() => {
    const labelMap = new Map((labels.data?.labels ?? []).map((label) => [label.id, label]));
    const active = new Map((meta.data?.cards ?? []).map((card) => [card.taskId, card.activeThreads]));
    const attachments = new Map((meta.data?.cards ?? []).map((card) => [card.taskId, card.attachmentCount]));
    const error = tasks.error ? String((tasks.error as { message?: string }).message ?? tasks.error) : null;
    return {
      tasks: tasks.data?.tasks ?? [],
      labels: labelMap,
      activeThreads: active,
      attachmentCounts: attachments,
      loading: enabled && tasks.data === undefined && !tasks.error,
      error,
    };
  }, [tasks.data, tasks.error, labels.data, meta.data, enabled]);
}

export function useTaskThreads(taskId: string, enabled: boolean): TaskThread[] {
  const query = experimental_useRpcQuery({
    pluginId: TASKS_PLUGIN,
    contract: tasksContract,
    method: "listTaskThreads",
    input: { taskId },
    enabled,
  });
  return query.data?.taskThreads ?? [];
}

export function useTaskPullRequests(taskId: string, enabled: boolean): PullRequest[] {
  const query = experimental_useRpcQuery({
    pluginId: TASKS_PLUGIN,
    contract: tasksContract,
    method: "listTaskPullRequests",
    input: { taskId },
    enabled,
  });
  return query.data?.pullRequests ?? [];
}

export function usePresets() {
  const query = experimental_useRpcQuery({ pluginId: TASKS_PLUGIN, contract: tasksContract, method: "listPresets", input: null });
  return query.data?.presets ?? [];
}

export interface ThreadInfo {
  id: string;
  title: string;
  environmentId: string | null;
  isWorktree: boolean;
  projectId: string;
  working: boolean;
  needsInput: boolean;
  createdAt: number;
}

const ACTIVE = new Set(["active", "provisioning", "starting", "waiting-for-host"]);

export function useThreadIndex(): ReadonlyMap<string, ThreadInfo> {
  const { threads } = experimental_useSidebarThreads();
  return useMemo(
    () =>
      new Map(
        threads.map((thread) => [
          thread.id,
          {
            id: thread.id,
            title: thread.displayTitle,
            environmentId: thread.environment?.id ?? null,
            isWorktree: thread.environment?.isWorktree === true,
            projectId: thread.projectId,
            working:
              ACTIVE.has(thread.runtimeStatus) ||
              thread.activity.backgroundAgents + thread.activity.backgroundCommands + thread.activity.workflows > 0,
            needsInput: thread.hasPendingInteraction || thread.indicator === "waiting-for-input",
            createdAt: thread.createdAt,
          },
        ]),
      ),
    [threads],
  );
}

export interface ChangeStats {
  insertions: number;
  deletions: number;
  files: number;
}

export function useChangeStats(environmentIds: readonly string[]): ReadonlyMap<string, ChangeStats> {
  const query = experimental_useRpcKeyedQuery({
    pluginId: GIT_PLUGIN,
    contract: gitContract,
    method: "status",
    keys: [...environmentIds],
    enabled: environmentIds.length > 0,
  });
  return useMemo(() => {
    const map = new Map<string, ChangeStats>();
    for (const id of environmentIds) {
      const parsed = gitStatusSchema.safeParse(query.data?.[id]);
      if (!parsed.success) continue;
      const { workingTree, mergeBase } = parsed.data.workspace;
      const base = mergeBase ?? { insertions: 0, deletions: 0, fileCount: 0 };
      const stats = {
        insertions: workingTree.insertions + base.insertions,
        deletions: workingTree.deletions + base.deletions,
        files: Math.max(workingTree.fileCount, base.fileCount),
      };
      if (stats.insertions + stats.deletions + stats.files > 0) map.set(id, stats);
    }
    return map;
  }, [query.data, environmentIds]);
}

export function useNow(): number {
  const tick = useTick(REFRESH_MS);
  return useMemo(() => Date.now(), [tick]);
}

export type MoveTask = (task: Task, status: Status, beforeTaskId: string | null, afterTaskId: string | null) => void;

export function useBoardMoves(tasks: readonly Task[]) {
  const sdk = useSdk();
  const [overrides, setOverrides] = useState<ReadonlyMap<string, { status: Status; position: number }>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOverrides((current) => {
      if (current.size === 0) return current;
      const next = new Map(current);
      for (const task of tasks) {
        const pending = next.get(task.id);
        if (pending && pending.status === task.status) next.delete(task.id);
      }
      return next.size === current.size ? current : next;
    });
  }, [tasks]);

  const merged = useMemo(
    () =>
      tasks.map((task) => {
        const pending = overrides.get(task.id);
        return pending ? { ...task, status: pending.status, position: pending.position } : task;
      }),
    [tasks, overrides],
  );

  const move: MoveTask = useCallback(
    (task, status, beforeTaskId, afterTaskId) => {
      const position = (() => {
        const byId = new Map(merged.map((item) => [item.id, item.position]));
        const before = beforeTaskId ? byId.get(beforeTaskId) : undefined;
        const after = afterTaskId ? byId.get(afterTaskId) : undefined;
        if (before !== undefined && after !== undefined) return (before + after) / 2;
        if (after !== undefined) return after - 1;
        if (before !== undefined) return before + 1;
        return task.position;
      })();
      setOverrides((current) => new Map(current).set(task.id, { status, position }));
      setError(null);
      sdk.plugins
        .callRpc({
          pluginId: TASKS_PLUGIN,
          method: "boardMove",
          input: { taskId: task.id, status, beforeTaskId, afterTaskId },
          outputSchema: tasksContract.boardMove.output,
        })
        .then((result) => {
          if (!result.ok) throw new Error(result.error.message);
        })
        .catch((reason: unknown) => {
          setOverrides((current) => {
            const next = new Map(current);
            next.delete(task.id);
            return next;
          });
          setError(reason instanceof Error ? reason.message : "Couldn't move the task");
        });
    },
    [merged, sdk],
  );

  return { tasks: merged, move, error, clearError: () => setError(null) };
}

export function byColumn(tasks: readonly Task[]): Record<Column, Task[]> {
  const groups = Object.fromEntries(COLUMNS.map((column) => [column, [] as Task[]])) as Record<Column, Task[]>;
  for (const task of tasks) groups[columnOf(task.status)].push(task);
  for (const column of COLUMNS) groups[column].sort((left, right) => left.position - right.position);
  return groups;
}

export function childrenByParent(tasks: readonly Task[]): ReadonlyMap<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parentTaskId) continue;
    const list = map.get(task.parentTaskId) ?? [];
    list.push(task);
    map.set(task.parentTaskId, list);
  }
  for (const list of map.values()) list.sort((left, right) => left.position - right.position);
  return map;
}

export function useReconcile(projectId: string): ReconcileView | null {
  const query = experimental_useRpcQuery({ contract: projectsContract, method: "reconcile", input: { projectId } });
  return query.data ?? null;
}

const ciSchema = z.object({ state: z.string(), totalCount: z.number() }).passthrough();
const summarySchema = z
  .object({
    url: z.string(),
    number: z.number(),
    title: z.string(),
    state: z.string(),
    isDraft: z.boolean(),
    ci: ciSchema,
    reviewDecision: z.string(),
    mergeability: z.string(),
  })
  .passthrough();
export type PullRequestSummary = z.infer<typeof summarySchema>;

const pullRequestsContract = defineRpcContract({
  summaries: {
    input: z.object({ urls: z.array(z.string()).max(20), refresh: z.boolean() }),
    output: z.object({
      items: z.array(z.object({ url: z.string(), summary: z.union([z.object({ ok: z.literal(true), value: summarySchema }), z.object({ ok: z.literal(false) }).passthrough()]) })),
    }),
  },
});

export function usePullRequestSummaries(urls: readonly string[]): ReadonlyMap<string, PullRequestSummary> {
  const available = usePluginAvailability(PULL_REQUESTS_PLUGIN) === "available";
  const query = experimental_useRpcQuery({
    pluginId: PULL_REQUESTS_PLUGIN,
    contract: pullRequestsContract,
    method: "summaries",
    input: { urls: urls.slice(0, 20), refresh: false },
    enabled: available && urls.length > 0,
  });
  return useMemo(() => {
    const map = new Map<string, PullRequestSummary>();
    if (!available) return map;
    for (const item of query.data?.items ?? []) if (item.summary.ok) map.set(item.url, item.summary.value);
    return map;
  }, [available, query.data]);
}

export { PR_STATUS, prStatus, type PrStatus } from "./pr-status";

const attachmentSchema = z
  .object({ id: z.string(), fileName: z.string(), mime: z.string(), sizeBytes: z.number(), isImage: z.boolean(), createdAt: z.string() })
  .passthrough();
export type Attachment = z.infer<typeof attachmentSchema>;

const attachmentsContract = defineRpcContract({
  listAttachments: {
    tags: (input: { taskId: string }) => [`attachments:${input.taskId}`],
    input: z.object({ taskId: z.string() }),
    output: z.object({ attachments: z.array(attachmentSchema) }).passthrough(),
  },
});

export function useAttachments(taskId: string, enabled: boolean): LoadState<Attachment> {
  const query = experimental_useRpcQuery({ pluginId: TASKS_PLUGIN, contract: attachmentsContract, method: "listAttachments", input: { taskId }, enabled });
  return loadState({ data: query.data ? { items: query.data.attachments } : undefined, error: query.error, isLoading: query.isLoading });
}

export function attachmentUrl(id: string): string {
  return `/api/v1/plugins/tasks/http/attachments/download?attachmentId=${encodeURIComponent(id)}`;
}
