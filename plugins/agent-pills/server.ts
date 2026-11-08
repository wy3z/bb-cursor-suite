/**
 * bb-plugin-agent-pills backend.
 *
 * BB's bundled thread timeline already folds the composer's cards into one
 * summary read: background tasks, running workflows, plan mode, the goal, the
 * to-do list and a model fallback. This exposes them to the app, adds the
 * model each child thread is running plus the queue and thread state the
 * timeline does not carry, and performs the few actions those pills offer.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { AGENT_PILLS_CHANNEL } from "./src/channels";
import {
  agentPillsRpcContract,
  type ActionResult,
  type ActiveGoal,
  type ModelFallback,
  type PendingTodos,
  type QueuedMessage,
  type ThreadState,
} from "./src/rpc";

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(agentPillsRpcContract, {
    async threadActivity({ threadId, childThreadIds }) {
      const [summary, queue, thread] = await Promise.all([
        readTimeline(bb, threadId),
        readQueue(bb, threadId),
        readThread(bb, threadId),
      ]);
      const [models, machine] = await Promise.all([
        Promise.all(
          childThreadIds.map(async (childThreadId) => {
            try {
              const options = await bb.sdk.threads.defaultExecutionOptions({
                threadId: childThreadId,
              });
              return { threadId: childThreadId, model: options?.model ?? null };
            } catch {
              return { threadId: childThreadId, model: null };
            }
          }),
        ),
        readMachine(bb, thread.environmentId),
      ]);
      return { ...summary, thread: thread.state, models, queue, machine };
    },

    exitPlanMode: ({ threadId }) =>
      runAction(() => bb.sdk.threads.cancelPlan({ threadId })),
    clearGoal: ({ threadId }) =>
      runAction(() => bb.sdk.threads.clearGoal({ threadId })),
    sendQueued: ({ threadId, queuedMessageId }) =>
      runAction(() =>
        bb.sdk.threads.queuedMessages.send({
          threadId,
          queuedMessageId,
          mode: "auto",
        }),
      ),
    deleteQueued: ({ threadId, queuedMessageId }) =>
      runAction(() =>
        bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId }),
      ),
    unarchive: ({ threadId }) =>
      runAction(() => bb.sdk.threads.unarchive({ threadId })),
    restoreEnvironment: ({ threadId }) =>
      runAction(() => bb.sdk.threads.restoreEnvironment({ threadId })),
    resumeHost: ({ hostId }) =>
      runAction(() => bb.sdk.hosts.experimental_resume({ hostId })),
  });

  bb.events.on("experimental_thread.events", ({ thread }) => {
    publish(bb, thread.id);
  });
  // Queue rows change without a timeline event: a message can be queued,
  // cancelled or dispatched while nothing else about the thread moves.
  bb.events.on("message.queued", ({ entry }) => publish(bb, entry.threadId));
  bb.events.on("message.cancelled", ({ entry }) => publish(bb, entry.threadId));
  bb.events.on("message.dispatched", ({ entry }) => publish(bb, entry.threadId));
  bb.events.on("thread.archived", ({ thread }) => publish(bb, thread.id));
  bb.events.on("thread.unarchived", ({ thread }) => publish(bb, thread.id));
}

function publish(bb: BbPluginApi, threadId: string) {
  bb.realtime.publish(AGENT_PILLS_CHANNEL, { threadId });
}

/** An action that failed is "nothing happened"; the app just stops pending. */
async function runAction(run: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await run();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

interface TimelineSummary {
  tasks: Array<{
    id: string;
    itemId: string;
    description: string;
    taskType: string;
    model: string | null;
    status: "completed" | "error" | "interrupted" | "pending";
    taskStatus:
      | "completed"
      | "failed"
      | "killed"
      | "paused"
      | "pending"
      | "running"
      | "stopped";
    startedAt: number;
    workflowName: string | null;
  }>;
  workflows: Array<{
    id: string;
    name: string;
    startedAt: number;
    agentsDone: number;
    agentsTotal: number;
  }>;
  plan: { prompt: string } | null;
  goal: ActiveGoal | null;
  todos: PendingTodos | null;
  modelFallback: ModelFallback | null;
}

const EMPTY_TIMELINE: TimelineSummary = {
  tasks: [],
  workflows: [],
  plan: null,
  goal: null,
  todos: null,
  modelFallback: null,
};

async function readTimeline(
  bb: BbPluginApi,
  threadId: string,
): Promise<TimelineSummary> {
  try {
    // summaryOnly skips building transcript rows: we only want the folded
    // card summaries that sit beside them.
    const timeline = await bb.sdk.threads.timeline({
      threadId,
      summaryOnly: "true",
    });
    return {
      tasks: timeline.activeBackgroundCommands.map((task) => ({
        id: task.id,
        itemId: task.itemId,
        description: task.description,
        taskType: task.taskType,
        model: task.model,
        status: task.status,
        taskStatus: task.taskStatus,
        startedAt: task.startedAt,
        workflowName: task.workflowName ?? null,
      })),
      // BB's own workflow card only ever shows the pending ones.
      workflows: timeline.activeWorkflows
        .filter((workflow) => workflow.status === "pending")
        .map((workflow) => {
          const agents = workflow.workflow?.agents ?? [];
          return {
            id: workflow.id,
            name: workflow.workflowName ?? workflow.description,
            startedAt: workflow.startedAt,
            agentsDone: agents.filter((agent) => isSettled(agent.state)).length,
            agentsTotal: agents.length,
          };
        }),
      plan:
        timeline.activePromptMode?.mode === "plan"
          ? { prompt: timeline.activePromptMode.prompt }
          : null,
      goal: readGoal(timeline.extensionStates),
      todos: timeline.pendingTodos
        ? {
            items: timeline.pendingTodos.items.map((item) => ({
              id: item.id,
              text: item.text,
              status: item.status,
            })),
          }
        : null,
      modelFallback: timeline.modelFallback
        ? {
            message: timeline.modelFallback.message,
            originalModel: timeline.modelFallback.originalModel,
            fallbackModel: timeline.modelFallback.fallbackModel,
            sourceSeq: timeline.modelFallback.sourceSeq,
          }
        : null,
    };
  } catch {
    // A deleted thread, an unavailable host or a failed timeline read just
    // means there is nothing to show; the pills must not break the pane.
    return EMPTY_TIMELINE;
  }
}

const goalStateSchema = z.object({
  objective: z.string(),
  status: z.string(),
  timeUsedSeconds: z.number(),
  tokensUsed: z.number(),
  tokenBudget: z.number().nullable(),
});

const ACTIVE_GOAL_STATUSES: ReadonlySet<string> = new Set<ActiveGoal["status"]>([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
]);

function readGoal(states: Record<string, unknown> | undefined): ActiveGoal | null {
  const parsed = goalStateSchema.safeParse(states?.goal);
  if (!parsed.success) return null;
  const goal = parsed.data;
  if (goal.status === "complete" || goal.status === "budgetLimited") return null;
  if (!ACTIVE_GOAL_STATUSES.has(goal.status)) return null;
  return {
    objective: goal.objective,
    status: goal.status as ActiveGoal["status"],
    timeUsedSeconds: goal.timeUsedSeconds,
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget,
  };
}

function isSettled(state: string): boolean {
  return state === "done" || state === "failed" || state === "skipped";
}

async function readQueue(
  bb: BbPluginApi,
  threadId: string,
): Promise<QueuedMessage[]> {
  try {
    const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
    return rows.map((row) => ({
      id: row.id,
      preview: previewOf(row.content),
      state: row.state,
    }));
  } catch {
    return [];
  }
}

/** The first line of a queued row's text, mentions and images left out. */
function previewOf(content: Array<{ type: string; text?: string }>): string {
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return "(empty message)";
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

interface ThreadStateAndEnvironment {
  state: ThreadState;
  environmentId: string | null;
}

async function readThread(
  bb: BbPluginApi,
  threadId: string,
): Promise<ThreadStateAndEnvironment> {
  try {
    const thread = await bb.sdk.threads.get({ threadId });
    return {
      state: {
        archived: thread.archivedAt !== null,
        // BB only offers the "Restore workspace" banner when the provider can
        // bring a destroyed workspace back, which is exactly this flag.
        workspaceGone: thread.canRestoreEnvironment,
        environmentId: thread.environmentId,
      },
      environmentId: thread.environmentId,
    };
  } catch {
    return {
      state: { archived: false, workspaceGone: false, environmentId: null },
      environmentId: null,
    };
  }
}

/**
 * Cloud machines show a paused/resuming banner. A persistent local host never
 * leaves "active", so reading it for every thread stays cheap and silent.
 */
async function readMachine(bb: BbPluginApi, environmentId: string | null) {
  if (environmentId === null) return null;
  try {
    const environment = await bb.sdk.environments.get({ environmentId });
    const host = await bb.sdk.hosts.get({ hostId: environment.hostId });
    const phase = host.lifecycle.phase;
    if (phase !== "suspended" && phase !== "suspending" && phase !== "resuming") {
      return null;
    }
    return { hostId: host.id, phase };
  } catch {
    return null;
  }
}
