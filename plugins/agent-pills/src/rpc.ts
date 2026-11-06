/** The RPC contract shared by the server and the app's typed client. */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const backgroundTaskSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  description: z.string(),
  taskType: z.string(),
  model: z.string().nullable(),
  status: z.enum(["completed", "error", "interrupted", "pending"]),
  taskStatus: z.enum([
    "completed",
    "failed",
    "killed",
    "paused",
    "pending",
    "running",
    "stopped",
  ]),
  startedAt: z.number(),
  workflowName: z.string().nullable(),
});

export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;

const workflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  startedAt: z.number(),
  agentsDone: z.number(),
  agentsTotal: z.number(),
});

export type ActiveWorkflow = z.infer<typeof workflowSchema>;

const planSchema = z.object({
  prompt: z.string(),
});

export type ActivePlan = z.infer<typeof planSchema>;

const goalSchema = z.object({
  objective: z.string(),
  status: z.enum([
    "active",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
  ]),
  timeUsedSeconds: z.number(),
  tokensUsed: z.number(),
  tokenBudget: z.number().nullable(),
});

export type ActiveGoal = z.infer<typeof goalSchema>;

const todosSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      status: z.enum(["completed", "in_progress", "pending"]),
    }),
  ),
});

export type PendingTodos = z.infer<typeof todosSchema>;

const modelFallbackSchema = z.object({
  message: z.string(),
  originalModel: z.string(),
  fallbackModel: z.string(),
  sourceSeq: z.number(),
});

export type ModelFallback = z.infer<typeof modelFallbackSchema>;

const queuedMessageSchema = z.object({
  id: z.string(),
  preview: z.string(),
  state: z.enum([
    "claimed",
    "failed_exhausted",
    "failed_retrying",
    "queued",
    "scheduled",
    "waiting",
  ]),
});

export type QueuedMessage = z.infer<typeof queuedMessageSchema>;

const threadStateSchema = z.object({
  archived: z.boolean(),
  workspaceGone: z.boolean(),
  /** For the changes pill: BB hands segments no environment for project checkouts. */
  environmentId: z.string().nullable(),
});

export type ThreadState = z.infer<typeof threadStateSchema>;

const machineSchema = z.object({
  hostId: z.string(),
  phase: z.enum(["suspended", "suspending", "resuming"]),
});

export type MachineState = z.infer<typeof machineSchema>;

const threadIdSchema = z.object({
  threadId: z.string().trim().min(1).max(200),
});

const okSchema = z.object({ ok: z.boolean() });

export type ActionResult = z.infer<typeof okSchema>;

const environmentIdSchema = z.string().trim().min(1).max(200);

const gitActionResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  sha: z.string().optional(),
  subject: z.string().optional(),
  branch: z.string().optional(),
  url: z.string().optional(),
  existed: z.boolean().optional(),
  files: z.number().optional(),
});

export type GitActionResult = z.infer<typeof gitActionResultSchema>;

export const agentPillsRpcContract = defineRpcContract({
  threadActivity: {
    input: z.object({
      threadId: z.string().trim().min(1).max(200),
      childThreadIds: z.array(z.string().trim().min(1).max(200)).max(50),
    }),
    output: z.object({
      tasks: z.array(backgroundTaskSchema),
      models: z.array(
        z.object({ threadId: z.string(), model: z.string().nullable() }),
      ),
      workflows: z.array(workflowSchema),
      plan: planSchema.nullable(),
      goal: goalSchema.nullable(),
      todos: todosSchema.nullable(),
      modelFallback: modelFallbackSchema.nullable(),
      queue: z.array(queuedMessageSchema),
      thread: threadStateSchema,
      machine: machineSchema.nullable(),
    }),
  },

  exitPlanMode: {
    input: threadIdSchema,
    output: okSchema,
  },
  clearGoal: {
    input: threadIdSchema,
    output: okSchema,
  },
  sendQueued: {
    input: threadIdSchema.extend({
      queuedMessageId: z.string().trim().min(1).max(200),
    }),
    output: okSchema,
  },
  deleteQueued: {
    input: threadIdSchema.extend({
      queuedMessageId: z.string().trim().min(1).max(200),
    }),
    output: okSchema,
  },
  unarchive: {
    input: threadIdSchema,
    output: okSchema,
  },
  restoreEnvironment: {
    input: threadIdSchema,
    output: okSchema,
  },
  gitCommit: {
    input: z.object({
      environmentId: environmentIdSchema,
      message: z.string().max(20_000),
      push: z.boolean(),
      includeUntracked: z.boolean().default(false),
    }),
    output: gitActionResultSchema,
  },
  gitPush: {
    input: z.object({ environmentId: environmentIdSchema }),
    output: gitActionResultSchema,
  },
  gitCreatePullRequest: {
    input: z.object({ environmentId: environmentIdSchema }),
    output: gitActionResultSchema,
  },
  gitApplyLocally: {
    input: z.object({
      sourceEnvironmentId: environmentIdSchema,
      targetEnvironmentId: environmentIdSchema,
    }),
    output: gitActionResultSchema,
  },
  resumeHost: {
    input: threadIdSchema.extend({
      hostId: z.string().trim().min(1).max(200),
    }),
    output: okSchema,
  },
});
