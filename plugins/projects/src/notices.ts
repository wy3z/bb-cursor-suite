import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { TASKS_PLUGIN, tasksContract, type Status, type Task } from "./contracts";
import { mapLimited } from "./completion";
import { isComplete } from "./status";
import type { ProjectMeta } from "./meta";
import type { NotifyMode } from "./settings";
import { sleep } from "./sleep";

export const NOTICES_TICK_MS = 30_000;
export const NOTE_GRACE_MS = 2 * 60_000;
export const TITLE_MAX = 80;
export const BODY_MAX = 180;
const PUSH = "push-notifications";
const LEVELS_BATCH = 200;
const HANDLED_MAX = 5_000;
const NEEDS = /^Needs [^:\n]{1,60}:/;

type Lead = { projectId: string; prefix: string; meta: ProjectMeta };
type Notable = "in_review" | "done";

export type NoticeBook = { primedAt: string; statuses: Record<string, Status> };
export type Transition = { task: Task; to: Notable; folded: Task[] };
export type ReviewItem = { key: string; title: string; note: string | null };
export type DoneItem = { key: string; title: string; folded: string[] };

const notable = (status: Status): status is Notable => status === "in_review" || status === "done";

export function transitionsOf(tasks: readonly Task[], book: NoticeBook): Transition[] {
  const primedAt = Date.parse(book.primedAt);
  const moved = tasks.filter((task) => {
    if (!notable(task.status)) return false;
    const before = book.statuses[task.id];
    if (before === undefined) return Date.parse(task.createdAt) >= primedAt;
    return before !== task.status;
  });
  const movingIds = new Set(moved.map((task) => task.id));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const rootOf = (task: Task): Task => {
    let root = task;
    const seen = new Set([task.id]);
    for (let parent = byId.get(task.parentTaskId ?? ""); parent && !seen.has(parent.id); parent = byId.get(parent.parentTaskId ?? "")) {
      seen.add(parent.id);
      if (movingIds.has(parent.id) && parent.status === task.status) root = parent;
    }
    return root;
  };
  const out = new Map<string, Transition>();
  for (const task of moved) {
    const root = rootOf(task);
    if (root.id === task.id) out.set(task.id, { task, to: task.status as Notable, folded: out.get(task.id)?.folded ?? [] });
    else {
      const entry = out.get(root.id) ?? { task: root, to: root.status as Notable, folded: [] };
      entry.folded.push(task);
      out.set(root.id, entry);
    }
  }
  return [...out.values()].sort((a, b) => a.task.position - b.task.position);
}

export function nextBook(tasks: readonly Task[], book: NoticeBook | null, deferred: ReadonlySet<string>, now: string): NoticeBook {
  const statuses: Record<string, Status> = {};
  for (const task of tasks) {
    if (!deferred.has(task.id)) statuses[task.id] = task.status;
    else if (book?.statuses[task.id] !== undefined) statuses[task.id] = book.statuses[task.id]!;
  }
  return { primedAt: book?.primedAt ?? now, statuses };
}

export function needsNote(comments: readonly { body: string; createdAt: string }[]): string | null {
  let latest: { body: string; createdAt: string } | null = null;
  for (const comment of comments) {
    if (!NEEDS.test(comment.body.trim())) continue;
    if (!latest || Date.parse(comment.createdAt) >= Date.parse(latest.createdAt)) latest = comment;
  }
  return latest ? latest.body.trim().replace(/\s+/g, " ") : null;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

function keyList(lead: string, keys: readonly string[], max: number): string {
  let out = lead + keys[0];
  for (let index = 1; index < keys.length; index++) {
    const next = `${out}, ${keys[index]}`;
    const rest = index < keys.length - 1 ? 5 : 0;
    if (next.length + rest > max) return `${out}, ...`;
    out = next;
  }
  return out;
}

export function composeNotice(review: readonly ReviewItem[], done: readonly DoneItem[]): { title: string; body: string } | null {
  if (!review.length && !done.length) return null;
  const doneLine =
    done.length === 1
      ? `Done: ${done[0]!.key} ${done[0]!.title}${done[0]!.folded.length ? ` (with ${done[0]!.folded.join(", ")})` : ""}`
      : done.length > 1
        ? keyList(`${done.length} done: `, done.map((item) => item.key), BODY_MAX)
        : "";
  if (!review.length) {
    if (done.length === 1) return { title: clip(`Done: ${done[0]!.key} ${done[0]!.title}`, TITLE_MAX), body: done[0]!.folded.length ? clip(`With ${done[0]!.folded.join(", ")}`, BODY_MAX) : "" };
    return { title: keyList(`${done.length} done: `, done.map((item) => item.key), TITLE_MAX), body: clip(done.map((item) => `${item.key} ${item.title}`).join("; "), BODY_MAX) };
  }
  const title =
    review.length === 1 ? clip(`Needs you: ${review[0]!.key} ${review[0]!.title}`, TITLE_MAX) : keyList(`${review.length} need you: `, review.map((item) => item.key), TITLE_MAX);
  const notes = review.length === 1 ? (review[0]!.note ?? "") : review.map((item) => `${item.key}: ${item.note ?? item.title}`).join("; ");
  return { title, body: clip([notes, doneLine].filter(Boolean).join(" · "), BODY_MAX) };
}

export function createNotices(
  bb: BbPluginApi,
  deps: {
    leads: () => Promise<Lead[]>;
    mode: () => Promise<NotifyMode>;
    now?: () => number;
  },
) {
  const now = deps.now ?? Date.now;
  const bookKey = (projectId: string) => `notices:${projectId}`;
  const handledKey = (projectId: string) => `muted:${projectId}`;
  let degraded = false;

  function degrade(what: string, cause: unknown) {
    if (degraded) return;
    degraded = true;
    bb.log.warn(`${what}: ${cause instanceof Error ? cause.message : String(cause)}. Projects notifications stay off until Push Notifications answers again.`);
  }

  const push = <T>(method: string, input: Record<string, string | string[]>, outputSchema: z.ZodType<T>) =>
    bb.sdk.plugins.callRpc({ pluginId: PUSH, method, input, outputSchema }).then((result) => {
      degraded = false;
      return result as T;
    });

  const tasksCall = <T>(method: string, input: Record<string, string>, outputSchema: z.ZodType<T>) =>
    bb.sdk.plugins.callRpc({ pluginId: TASKS_PLUGIN, method, input, outputSchema }) as Promise<T>;

  const levelsOutput = z.object({ threads: z.record(z.string(), z.object({ own: z.string() }).passthrough()) });

  async function muteWorkers(lead: Lead, tasks: readonly Task[], leadIds: ReadonlySet<string>) {
    const open = tasks.filter((task) => !isComplete(task.status));
    const links = await mapLimited(open, 8, (task) =>
      tasksCall("listTaskThreads", { taskId: task.id }, tasksContract.listTaskThreads.output).then(
        (result) => result.taskThreads.map((link) => link.threadId),
        () => [] as string[],
      ),
    );
    const handled = new Set((await bb.storage.kv.get<string[]>(handledKey(lead.projectId))) ?? []);
    const fresh = [...new Set(links.flat())].filter((threadId) => !leadIds.has(threadId) && !handled.has(threadId));
    if (!fresh.length) return;
    let levels: Record<string, { own: string }>;
    try {
      levels = {};
      for (let index = 0; index < fresh.length; index += LEVELS_BATCH) {
        Object.assign(levels, (await push("threadNotifications.list", { threadIds: fresh.slice(index, index + LEVELS_BATCH) }, levelsOutput)).threads);
      }
    } catch (cause) {
      degrade("Could not read worker notification levels", cause);
      return;
    }
    for (const threadId of fresh) {
      const own = levels[threadId]?.own;
      if (!own || own === "inherit") {
        try {
          await push("threadNotifications.set", { threadId, level: "muted" }, z.unknown());
        } catch (cause) {
          bb.log.debug(`Could not mute ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      handled.add(threadId);
    }
    await bb.storage.kv.set(handledKey(lead.projectId), [...handled].slice(-HANDLED_MAX));
  }

  async function leadIsAsking(threadId: string): Promise<boolean> {
    try {
      const [thread] = await bb.sdk.threads.list({ threadIds: [threadId], includeHidden: true });
      return thread?.hasPendingInteraction === true;
    } catch {
      return false;
    }
  }

  async function announce(lead: Lead, tasks: readonly Task[], book: NoticeBook, mode: NotifyMode): Promise<Set<string>> {
    const deferred = new Set<string>();
    if (mode === "off") {
      await bb.storage.kv.set(bookKey(lead.projectId), nextBook(tasks, book, deferred, new Date(now()).toISOString()));
      return deferred;
    }
    const moves = transitionsOf(tasks, book);
    const review: ReviewItem[] = [];
    const done: DoneItem[] = [];
    for (const move of moves) {
      if (move.to === "done") {
        if (mode === "done-and-review") done.push({ key: move.task.key, title: move.task.title, folded: move.folded.map((task) => task.key) });
        continue;
      }
      const comments = await tasksCall("listComments", { taskId: move.task.id }, tasksContract.listComments.output).then(
        (result) => result.comments,
        () => [],
      );
      const note = needsNote(comments);
      if (note === null && now() - Date.parse(move.task.updatedAt) < NOTE_GRACE_MS) {
        deferred.add(move.task.id);
        for (const task of move.folded) deferred.add(task.id);
        continue;
      }
      review.push({ key: move.task.key, title: move.task.title, note });
    }
    const asking = review.length > 0 && (await leadIsAsking(lead.meta.leadThreadId!));
    const notice = composeNotice(asking ? [] : review, done);
    await bb.storage.kv.set(bookKey(lead.projectId), nextBook(tasks, book, deferred, new Date(now()).toISOString()));
    if (!notice) return deferred;
    try {
      await push("notifications.send", { ...notice, threadId: lead.meta.leadThreadId! }, z.object({ ok: z.literal(true), channels: z.array(z.string()) }).passthrough());
    } catch (cause) {
      degrade(`Could not send the ${lead.prefix} notification`, cause);
    }
    return deferred;
  }

  async function pass(lead: Lead, leadIds: ReadonlySet<string>) {
    if (!lead.meta.leadThreadId) return;
    const tasks = (await tasksCall("listAllTasks", { projectId: lead.projectId }, tasksContract.listAllTasks.output)).tasks as Task[];
    await muteWorkers(lead, tasks, leadIds);
    const book = await bb.storage.kv.get<NoticeBook>(bookKey(lead.projectId));
    if (!book) {
      await bb.storage.kv.set(bookKey(lead.projectId), nextBook(tasks, null, new Set(), new Date(now()).toISOString()));
      return;
    }
    await announce(lead, tasks, book, await deps.mode());
  }

  async function tick() {
    const leads = await deps.leads();
    const leadIds = new Set(leads.map((lead) => lead.meta.leadThreadId).filter((id): id is string => Boolean(id)));
    for (const lead of leads) {
      try {
        await pass(lead, leadIds);
      } catch (cause) {
        bb.log.warn(`Notification check for ${lead.prefix} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }

  bb.background.service("board-notices", {
    async start(signal) {
      while (!signal.aborted) {
        await tick().catch((cause) => bb.log.warn(`Notification tick failed: ${cause instanceof Error ? cause.message : String(cause)}`));
        await sleep(NOTICES_TICK_MS, signal);
      }
    },
  });

  return { tick, pass };
}

