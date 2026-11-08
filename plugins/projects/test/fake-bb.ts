import { Database } from "bun:sqlite";
import { migrate } from "./harness";

type Thread = {
  id: string;
  visibility?: "visible" | "hidden";
  parentThreadId: string | null;
  archivedAt: number | null;
  runtime: { displayStatus: string };
  queuedWork: string;
  hasPendingInteraction: boolean;
};

export type FakeTask = {
  id: string;
  projectId: string;
  key: string;
  title: string;
  description: string;
  status: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "canceled";
  priority: "none";
  parentTaskId: string | null;
  position: number;
  labelIds: string[];
  createdAt: string;
  updatedAt: string;
};
type FakeThreadLink = { threadId: string; presetName: string; title: string; liveStatus: "starting" | "working" | "idle" | "completed" | "failed"; attachedAt: string; updatedAt: string };
type FakePr = { url: string; number: number; title: string; state: "open" | "draft" | "merged" | "closed"; updatedAt: string; threadIds: string[] };
type FakeComment = { id: string; kind: "user" | "agent" | "system"; authorName: string; body: string; createdAt: string; threadId: string | null };

type Cli = { run(argv: string[], ctx: { threadId?: string }): Promise<{ exitCode: number; stdout?: string; stderr?: string }> };

export function fakeBb(opts: { dbPath?: string; kv?: Map<string, unknown>; settings?: Record<string, unknown> } = {}) {
  const kv = opts.kv ?? new Map<string, unknown>();
  const db = new Database(opts.dbPath ?? ":memory:");
  const threads = new Map<string, Thread>();
  const sent: { threadId: string; text: string }[] = [];
  const subscribed: { threadId: string; urls: string[] }[] = [];
  const linked = new Map<string, string[]>();
  const plugins = [
    { id: "tasks", enabled: true, status: "running" },
    { id: "pull-requests", enabled: true, status: "running" },
  ];
  const services = new Map<string, { start(signal: AbortSignal): Promise<void> | void }>();
  const logs: string[] = [];
  const faults = { listProjects: 0, threadsList: 0, send: 0, kvSetDelayMs: 0 };
  const settings = { wakeEnabled: false, wakeHeaderName: "", wakeRemindMinutes: 60, ...opts.settings };
  let cli: Cli | null = null;
  let instructions: ((ctx: { threadId: string; projectId: string }) => string | null) | null = null;
  const tasks = new Map<string, FakeTask>();
  const taskThreads = new Map<string, FakeThreadLink[]>();
  const taskPrs = new Map<string, FakePr[]>();
  const comments = new Map<string, FakeComment[]>();
  const updates: { taskId: string; status: string }[] = [];
  const addTask = (task: Partial<FakeTask> & { key: string }) => {
    const id = task.id ?? `task_${task.key.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
    const full: FakeTask = {
      id,
      projectId: "proj_abc",
      title: task.key,
      description: "",
      status: "todo",
      priority: "none",
      parentTaskId: null,
      position: tasks.size,
      labelIds: [],
      createdAt: "2026-11-01T09:00:00.000Z",
      updatedAt: "2026-11-01T09:00:00.000Z",
      ...task,
      id,
    };
    tasks.set(id, full);
    return full;
  };
  let rpc: Record<string, (input: unknown) => Promise<unknown>> = {};

  const addThread = (id: string, patch: Partial<Thread> = {}) =>
    threads.set(id, { id, parentThreadId: null, archivedAt: null, runtime: { displayStatus: "idle" }, queuedWork: "none", hasPendingInteraction: false, ...patch });

  const bb = {
    log: {
      debug: () => undefined,
      info: (message: string) => logs.push(`info ${message}`),
      warn: (message: string) => logs.push(`warn ${message}`),
      error: (message: string) => logs.push(`error ${message}`),
    },
    storage: {
      kv: {
        get: async (key: string) => structuredClone(kv.get(key)),
        set: async (key: string, value: unknown) => {
          if (faults.kvSetDelayMs) await new Promise((resolve) => setTimeout(resolve, faults.kvSetDelayMs));
          kv.set(key, structuredClone(value));
        },
        delete: async (key: string) => void kv.delete(key),
        list: async (prefix = "") => [...kv.keys()].filter((key) => key.startsWith(prefix)),
      },
      database: () => db,
      migrate: (handle: never, statements: string[]) => migrate(handle, statements),
    },
    settings: { define: () => ({ get: async () => ({ ...settings }), experimental_set: async () => ({}), onChange: () => undefined }) },
    realtime: { publish: () => undefined },
    agents: {
      contributeInstructions: (provider: (ctx: { threadId: string; projectId: string }) => string | null) => {
        instructions = provider;
      },
    },
    rpc: {
      experimental_invalidate: () => undefined,
      register: (_contract: unknown, handlers: typeof rpc) => {
        rpc = handlers;
      },
    },
    background: { service: (name: string, service: { start(signal: AbortSignal): Promise<void> | void }) => services.set(name, service) },
    cli: {
      register: (registration: Cli) => {
        cli = registration;
      },
    },
    sdk: {
      plugins: {
        list: async () => ({ plugins: structuredClone(plugins) }),
        callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input: Record<string, unknown> }) => {
          if (!plugins.some((plugin) => plugin.id === pluginId && plugin.enabled)) throw new Error(`Plugin ${pluginId} is not running`);
          if (pluginId === "tasks" && method === "listProjects") {
            if (faults.listProjects > 0) {
              faults.listProjects--;
              throw new Error("tasks plugin is reloading");
            }
            return { projects: [{ id: "proj_abc", name: "Acme", prefix: "ABC", color: "blue", linkedBbProjectId: null }, { id: "proj_other", name: "Other", prefix: "OTHER", color: "red", linkedBbProjectId: null }] };
          }
          if (pluginId === "tasks" && method === "listAllTasks") return { tasks: [...tasks.values()].filter((task) => task.projectId === input.projectId).map((task) => structuredClone(task)) };
          if (pluginId === "tasks" && method === "listTaskCardMeta") return { cards: [] };
          if (pluginId === "tasks" && method === "listTaskThreads") return { taskThreads: taskThreads.get(String(input.taskId)) ?? [] };
          if (pluginId === "tasks" && method === "listTaskPullRequests") return { pullRequests: taskPrs.get(String(input.taskId)) ?? [], unavailableThreadIds: [] };
          if (pluginId === "tasks" && method === "listComments") return { comments: comments.get(String(input.taskId)) ?? [] };
          if (pluginId === "tasks" && method === "updateTask") {
            const task = tasks.get(String(input.taskId));
            if (!task) return { ok: false, error: { message: "no such task" } };
            updates.push({ taskId: task.id, status: String(input.status) });
            task.status = input.status as FakeTask["status"];
            return { ok: true, task: structuredClone(task) };
          }
          if (pluginId === "pull-requests" && method === "linked_list") return { urls: linked.get(String(input.threadId)) ?? [] };
          if (pluginId === "pull-requests" && method === "subscribe") {
            subscribed.push({ threadId: String(input.threadId), urls: input.urls as string[] });
            return {};
          }
          throw new Error(`no fake for ${pluginId}.${method}`);
        },
      },
      projects: { list: async () => [] },
      threads: {
        list: async (args: { threadIds?: string[]; parentThreadId?: string }) => {
          if (faults.threadsList > 0) {
            faults.threadsList--;
            throw new Error("threads.list failed");
          }
          const all = [...threads.values()];
          if (args.threadIds) return all.filter((thread) => args.threadIds!.includes(thread.id));
          if (args.parentThreadId) return all.filter((thread) => thread.parentThreadId === args.parentThreadId);
          return all;
        },
        send: async ({ threadId, input }: { threadId: string; input: { text: string }[] }) => {
          if (faults.send > 0) {
            faults.send--;
            throw new Error("send failed");
          }
          sent.push({ threadId, text: input[0]!.text });
          return { ok: true, delivery: "sent" };
        },
        queuedMessages: { list: async () => [], delete: async () => ({}) },
        search: async ({ query }: { query: string }) => {
          const results = [...threads.keys()]
            .filter((id) => threads.get(id)!.visibility !== "hidden")
            .map((id) => ({
              thread: { id },
              matches: sent
                .map((item, index) => ({ item, seq: index + 1 }))
                .filter(({ item }) => item.threadId === id && item.text.includes(query))
                .slice(0, 1)
                .map(({ item, seq }) => ({ sourceKind: "user_message", sourceSeq: seq, text: item.text.slice(0, 160) })),
            }))
            .filter((result) => result.matches.length);
          return { active: { total: results.length, results }, archived: { total: 0, results: [] } };
        },
        events: {
          list: async ({ threadId, afterSeq }: { threadId: string; afterSeq: string }) => {
            const seq = Number(afterSeq) + 1;
            const item = sent[seq - 1];
            return item && item.threadId === threadId
              ? [{ seq, type: "client/turn/requested", data: { senderThreadId: null, input: [{ type: "text", text: item.text, mentions: [] }] } }]
              : [];
          },
        },
      },
    },
  };

  async function run(argv: string[], threadId?: string) {
    const result = await cli!.run(argv, threadId ? { threadId } : {});
    return { ...result, json: () => JSON.parse(result.stdout ?? "null") };
  }

  return {
    bb,
    db,
    kv,
    threads,
    sent,
    subscribed,
    linked,
    plugins,
    services,
    logs,
    faults,
    settings,
    addThread,
    run,
    rpc: () => rpc,
    instructions: (threadId: string) => instructions?.({ threadId, projectId: "proj_any" }) ?? null,
    tasks,
    taskThreads,
    taskPrs,
    comments,
    updates,
    addTask,
  };
}
