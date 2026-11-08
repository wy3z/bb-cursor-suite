import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { TASKS_PLUGIN, tasksContract, type Project, type Task } from "./contracts";
import { commitsMentioning } from "./landings";
import { reconcileProject, type CommentSignal, type ReconcileResult, type ReconcileSource } from "./reconcile";
import { DRIFT_CHECK_MS, EMPTY_DRIFT_STATE, driftPrompt, planDriftPing, type DriftState } from "./drift";
import { inWorkingHours, type LeadStatus } from "./outer-loop";
import type { ProjectMeta } from "./meta";
import { sleep } from "./sleep";

const CACHE_MS = 60_000;
const TICK_MS = 60_000;
const REFRESH_MS = 2 * 60_000;

const pullRequestsOutput = z.object({
  pullRequests: z.array(z.object({ number: z.number(), state: z.enum(["open", "draft", "merged", "closed"]) }).passthrough()),
});

type Lead = { projectId: string; prefix: string; meta: ProjectMeta };

export function createBoard(
  bb: BbPluginApi,
  deps: {
    leads: () => Promise<Lead[]>;
    projects: () => Promise<Project[]>;
    leadStatus: (threadId: string) => Promise<LeadStatus>;
    deliver: (threadId: string, text: string) => Promise<unknown>;
  },
) {
  const cache = new Map<string, { at: number; result: Promise<ReconcileResult> }>();

  const call = <T>(method: string, input: Record<string, string>, outputSchema: z.ZodType<T>) =>
    bb.sdk.plugins.callRpc({ pluginId: TASKS_PLUGIN, method, input, outputSchema }) as Promise<T>;

  async function sourcePath(project: Project): Promise<{ path: string; remote: string | null } | null> {
    if (!project.linkedBbProjectId) return null;
    try {
      const projects = (await bb.sdk.projects.list()) as unknown as { id: string; gitRemoteUrl?: string | null; sources?: { type: string; path?: string; isDefault?: boolean }[] }[];
      const linked = projects.find((item) => item.id === project.linkedBbProjectId);
      const local = linked?.sources?.filter((item) => item.type === "local_path" && item.path) ?? [];
      const source = local.find((item) => item.isDefault) ?? local[0];
      return source?.path ? { path: source.path, remote: linked?.gitRemoteUrl ?? null } : null;
    } catch {
      return null;
    }
  }

  function source(project: Project): ReconcileSource {
    return {
      tasks: async () => (await call("listAllTasks", { projectId: project.id }, tasksContract.listAllTasks.output)).tasks as Task[],
      threads: async (taskId) => (await call("listTaskThreads", { taskId }, tasksContract.listTaskThreads.output)).taskThreads,
      pullRequests: async (taskId) => {
        try {
          return (await call("listTaskPullRequests", { taskId }, pullRequestsOutput)).pullRequests;
        } catch {
          return [];
        }
      },
      comments: async (taskId) =>
        (await call("listComments", { taskId }, tasksContract.listComments.output)).comments.map(
          (comment): CommentSignal => ({ kind: comment.kind, body: comment.body, createdAt: comment.createdAt }),
        ),
      commits: async (sinceIso) => {
        const where = await sourcePath(project);
        return where ? commitsMentioning(where.path, project.prefix, sinceIso, where.remote) : [];
      },
    };
  }

  function reconcile(project: Project, fresh = false): Promise<ReconcileResult> {
    const hit = cache.get(project.id);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.result;
    const result = reconcileProject(source(project), Date.now());
    cache.set(project.id, { at: Date.now(), result });
    result.catch(() => cache.delete(project.id));
    return result;
  }

  async function apply(project: Project, result: ReconcileResult) {
    const moved: string[] = [];
    const failed: { key: string; error: string }[] = [];
    for (const drift of result.drifts) {
      if (!drift.applicable) continue;
      try {
        const outcome = await call("updateTask", { taskId: drift.taskId, status: drift.suggested }, tasksContract.updateTask.output);
        if (!outcome.ok) throw new Error(outcome.error.message);
        moved.push(drift.key);
      } catch (cause) {
        failed.push({ key: drift.key, error: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    cache.delete(project.id);
    invalidate(project.id);
    return { moved, failed };
  }

  function invalidate(projectId: string) {
    bb.rpc.experimental_invalidate([`reconcile:${projectId}`]);
  }

  const stateKey = (projectId: string) => `drift:${projectId}`;
  const lastCheck = new Map<string, number>();

  async function readDriftState(projectId: string): Promise<DriftState> {
    return (await bb.storage.kv.get<DriftState>(stateKey(projectId))) ?? EMPTY_DRIFT_STATE;
  }

  async function watch(lead: Lead, project: Project | undefined, now: Date) {
    if (!lead.meta.driftPings || !lead.meta.leadThreadId || !project) return;
    if (now.getTime() - (lastCheck.get(lead.projectId) ?? 0) < DRIFT_CHECK_MS) return;
    if (lead.meta.sweepWorkingHours && !inWorkingHours(now)) return;
    lastCheck.set(lead.projectId, now.getTime());
    const result = await reconcile(project, true);
    invalidate(project.id);
    const before = await readDriftState(project.id);
    const plan = planDriftPing(before, result.drifts, now.getTime());
    if (plan.ping && (await deps.leadStatus(lead.meta.leadThreadId)) === "idle") {
      await deps.deliver(lead.meta.leadThreadId, driftPrompt(project.prefix, plan.ping));
      await bb.storage.kv.set(stateKey(project.id), plan.state);
      return;
    }
    await bb.storage.kv.set(stateKey(project.id), plan.ping ? { ...plan.state, pinged: before.pinged, lastPingAt: before.lastPingAt } : plan.state);
  }

  let lastRefresh = 0;

  async function tick(now: Date) {
    const [leads, projects] = await Promise.all([deps.leads(), deps.projects()]);
    if (now.getTime() - lastRefresh >= REFRESH_MS) {
      lastRefresh = now.getTime();
      for (const project of projects) invalidate(project.id);
    }
    for (const lead of leads) {
      try {
        await watch(lead, projects.find((project) => project.id === lead.projectId), now);
      } catch (cause) {
        bb.log.warn(`Drift check for ${lead.prefix} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }

  bb.background.service("board-drift", {
    async start(signal) {
      while (!signal.aborted) {
        await tick(new Date()).catch((cause) => bb.log.warn(`Board drift tick failed: ${cause instanceof Error ? cause.message : String(cause)}`));
        await sleep(TICK_MS, signal);
      }
    },
  });

  return { reconcile, apply, invalidate, watch, tick, readDriftState };
}
