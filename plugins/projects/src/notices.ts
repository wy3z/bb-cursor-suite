import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { STATUSES, TASKS_PLUGIN, tasksContract, type Status, type Task } from "./contracts";
import { mapLimited } from "./completion";
import { isComplete } from "./status";
import type { ProjectMeta } from "./meta";
import type { NotifyMode } from "./settings";
import { sleep } from "./sleep";

export const NOTICES_TICK_MS = 30_000;
export const NOTE_GRACE_MS = 2 * 60_000;
export const RESCAN_MS = 5 * 60_000;
export const RESCAN_BATCH = 25;
export const TITLE_MAX = 80;
export const BODY_MAX = 180;
const PUSH = "push-notifications";
const LEVELS_BATCH = 200;
const NEEDS = /^Needs [^:\n]{1,60}:/;
const STATUS_COMMENT = /^Status changed to (.+?)(?: by |\s·|$)/;

type Lead = { projectId: string; prefix: string; meta: ProjectMeta };
type Notable = "in_review" | "done";
type Comment = { kind: string; body: string; createdAt: string };
type Scan = { at: number; updatedAt: string };

export type Card = { status: Status; updatedAt: string };
export type ReviewItem = { taskId: string; key: string; title: string; note: string | null };
export type DoneItem = { taskId: string; key: string; title: string; folded: string[] };
export type Pending = { review: ReviewItem[]; done: DoneItem[] };
export type NoticeBook = { primedAt: string; cards: Record<string, Card>; pending: Pending };
export type Transition = { task: Task; to: Notable; folded: Task[] };
export type MuteRecord = { owner: "projects"; previous: string; at: string } | { owner: "user"; level: string; at: string };

const EMPTY: Pending = { review: [], done: [] };
const notable = (status: Status): status is Notable => status === "in_review" || status === "done";
const label = (status: Status) => status.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
const BY_LABEL = new Map<string, Status>(STATUSES.map((status) => [label(status), status]));

export function statusFromComment(comment: Comment): Status | null {
  if (comment.kind !== "system") return null;
  const match = STATUS_COMMENT.exec(comment.body.trim());
  return match ? (BY_LABEL.get(match[1]!.trim()) ?? null) : null;
}

export function departed(task: Pick<Task, "status">, card: Card, comments: readonly Comment[]): boolean {
  const since = Date.parse(card.updatedAt);
  return comments.some((comment) => {
    if (Date.parse(comment.createdAt) <= since) return false;
    const status = statusFromComment(comment);
    return status !== null && status !== task.status;
  });
}

export function historyCandidates(tasks: readonly Task[], book: NoticeBook): Task[] {
  return tasks.filter((task) => {
    const card = book.cards[task.id];
    return notable(task.status) && card !== undefined && card.status === task.status && card.updatedAt !== task.updatedAt;
  });
}

export function transitionsOf(tasks: readonly Task[], book: NoticeBook, departedIds: ReadonlySet<string> = new Set()): Transition[] {
  const primedAt = Date.parse(book.primedAt);
  const moved = tasks.filter((task) => {
    if (!notable(task.status)) return false;
    const card = book.cards[task.id];
    if (card === undefined) return Date.parse(task.createdAt) >= primedAt;
    return card.status !== task.status || departedIds.has(task.id);
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

export function nextCards(tasks: readonly Task[], book: NoticeBook | null, deferred: ReadonlySet<string>): Record<string, Card> {
  const cards: Record<string, Card> = {};
  for (const task of tasks) {
    const before = book?.cards[task.id];
    if (!deferred.has(task.id)) cards[task.id] = { status: task.status, updatedAt: task.updatedAt };
    else if (before !== undefined) cards[task.id] = before;
  }
  return cards;
}

export function mergePending(pending: Pending, review: readonly ReviewItem[], done: readonly DoneItem[]): Pending {
  const fresh = new Set([...review, ...done].map((item) => item.taskId));
  return {
    review: [...pending.review.filter((item) => !fresh.has(item.taskId)), ...review],
    done: [...pending.done.filter((item) => !fresh.has(item.taskId)), ...done],
  };
}

export function livePending(pending: Pending, tasks: readonly Task[]): Pending {
  const status = new Map(tasks.map((task) => [task.id, task.status]));
  return {
    review: pending.review.filter((item) => status.get(item.taskId) === "in_review"),
    done: pending.done.filter((item) => status.get(item.taskId) === "done"),
  };
}

export function applyPolicy(pending: Pending, mode: NotifyMode, asking: boolean): Pending {
  if (mode === "off") return EMPTY;
  return { review: asking ? [] : pending.review, done: mode === "done-and-review" ? pending.done : [] };
}

export function askBoundary(comments: readonly Comment[], fallback: string | null): string | null {
  const changes = comments
    .map((comment) => ({ status: statusFromComment(comment), at: Date.parse(comment.createdAt) }))
    .filter((change): change is { status: Status; at: number } => change.status !== null)
    .sort((a, b) => a.at - b.at);
  let entry = -1;
  for (let index = 0; index < changes.length; index++) if (changes[index]!.status === "in_review") entry = index;
  if (entry < 0) return fallback;
  return entry === 0 ? fallback : new Date(changes[entry - 1]!.at).toISOString();
}

export function needsNote(comments: readonly { body: string; createdAt: string }[], after: string | null = null): string | null {
  const since = after === null ? -Infinity : Date.parse(after);
  let latest: { body: string; createdAt: string } | null = null;
  for (const comment of comments) {
    if (!NEEDS.test(comment.body.trim()) || Date.parse(comment.createdAt) <= since) continue;
    if (!latest || Date.parse(comment.createdAt) >= Date.parse(latest.createdAt)) latest = comment;
  }
  return latest ? latest.body.trim().replace(/\s+/g, " ") : null;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

function keyList(lead: string, keys: readonly string[], max: number): string {
  const more = (shown: number) => (shown < keys.length ? `, and ${keys.length - shown} more` : "");
  let shown = 1;
  while (shown < keys.length && `${lead}${keys.slice(0, shown + 1).join(", ")}${more(shown + 1)}`.length <= max) shown++;
  return `${lead}${keys.slice(0, shown).join(", ")}${more(shown)}`;
}

export type Notice = { title: string; body: string };

export function composeReview(review: readonly Omit<ReviewItem, "taskId">[]): Notice | null {
  if (!review.length) return null;
  if (review.length === 1) return { title: clip(`Needs you: ${review[0]!.key} ${review[0]!.title}`, TITLE_MAX), body: clip(review[0]!.note ?? "", BODY_MAX) };
  return {
    title: keyList(`${review.length} need you: `, review.map((item) => item.key), TITLE_MAX),
    body: clip(review.map((item) => `${item.key}: ${item.note ?? item.title}`).join("; "), BODY_MAX),
  };
}

export function composeDone(done: readonly Omit<DoneItem, "taskId">[]): Notice | null {
  if (!done.length) return null;
  if (done.length === 1) return { title: clip(`Done: ${done[0]!.key} ${done[0]!.title}`, TITLE_MAX), body: done[0]!.folded.length ? clip(`With ${done[0]!.folded.join(", ")}`, BODY_MAX) : "" };
  return { title: keyList(`${done.length} done: `, done.map((item) => item.key), TITLE_MAX), body: clip(done.map((item) => `${item.key} ${item.title}`).join("; "), BODY_MAX) };
}

export function createNotices(
  bb: BbPluginApi,
  deps: {
    leads: () => Promise<Lead[]>;
    mode: () => Promise<NotifyMode>;
    restoreLead: (threadId: string) => Promise<void>;
    now?: () => number;
  },
) {
  const now = deps.now ?? Date.now;
  const stamp = () => new Date(now()).toISOString();
  const bookKey = (projectId: string) => `notices:${projectId}`;
  const muteKey = (threadId: string) => `mute:${threadId}`;
  const mutes = new Map<string, MuteRecord>();
  const sweepKey = (projectId: string) => `sweep:${projectId}`;
  const coverage = new Map<string, Map<string, Scan>>();
  let degraded = false;

  function degrade(what: string, cause: unknown) {
    if (degraded) return;
    degraded = true;
    bb.log.warn(`${what}: ${cause instanceof Error ? cause.message : String(cause)}. Projects notifications wait until Push Notifications answers again.`);
  }

  const push = <T>(method: string, input: Record<string, string | string[]>, outputSchema: z.ZodType<T>) =>
    bb.sdk.plugins.callRpc({ pluginId: PUSH, method, input, outputSchema }).then((result) => {
      degraded = false;
      return result as T;
    });

  const tasksCall = <T>(method: string, input: Record<string, string>, outputSchema: z.ZodType<T>) =>
    bb.sdk.plugins.callRpc({ pluginId: TASKS_PLUGIN, method, input, outputSchema }) as Promise<T>;

  const levelsOutput = z.object({ threads: z.record(z.string(), z.object({ own: z.string() }).passthrough()) });

  async function levelsOf(threadIds: readonly string[]): Promise<Record<string, { own: string }>> {
    const levels: Record<string, { own: string }> = {};
    for (let index = 0; index < threadIds.length; index += LEVELS_BATCH) {
      Object.assign(levels, (await push("threadNotifications.list", { threadIds: threadIds.slice(index, index + LEVELS_BATCH) }, levelsOutput)).threads);
    }
    return levels;
  }

  async function muteRecord(threadId: string): Promise<MuteRecord | undefined> {
    const cached = mutes.get(threadId);
    if (cached) return cached;
    const stored = await bb.storage.kv.get<MuteRecord>(muteKey(threadId));
    if (stored) mutes.set(threadId, stored);
    return stored;
  }

  async function saveMute(threadId: string, record: MuteRecord | null) {
    if (record) {
      await bb.storage.kv.set(muteKey(threadId), record);
      mutes.set(threadId, record);
    } else {
      await bb.storage.kv.delete(muteKey(threadId));
      mutes.delete(threadId);
    }
  }

  async function release(threadId: string): Promise<void> {
    const record = await muteRecord(threadId);
    if (record?.owner !== "projects") return;
    const own = (await levelsOf([threadId]))[threadId]?.own ?? "inherit";
    if (own !== "muted") {
      await saveMute(threadId, { owner: "user", level: own, at: stamp() });
      return;
    }
    await push("threadNotifications.set", { threadId, level: record.previous }, z.unknown());
    await saveMute(threadId, null);
  }

  async function muteWorkers(threadIds: readonly string[], leadIds: ReadonlySet<string>) {
    const fresh: string[] = [];
    for (const threadId of new Set(threadIds)) {
      if (!leadIds.has(threadId) && !(await muteRecord(threadId))) fresh.push(threadId);
    }
    if (!fresh.length) return;
    let levels: Record<string, { own: string }>;
    try {
      levels = await levelsOf(fresh);
    } catch (cause) {
      degrade("Could not read worker notification levels", cause);
      return;
    }
    for (const threadId of fresh) {
      const own = levels[threadId]?.own;
      if (own && own !== "inherit") {
        await saveMute(threadId, { owner: "user", level: own, at: stamp() });
        continue;
      }
      try {
        await push("threadNotifications.set", { threadId, level: "muted" }, z.unknown());
      } catch (cause) {
        bb.log.debug(`Could not mute ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        continue;
      }
      await saveMute(threadId, { owner: "projects", previous: own ?? "inherit", at: stamp() });
    }
  }

  async function coverageOf(projectId: string): Promise<Map<string, Scan>> {
    const cached = coverage.get(projectId);
    if (cached) return cached;
    const loaded = new Map(Object.entries((await bb.storage.kv.get<Record<string, Scan>>(sweepKey(projectId))) ?? {}));
    coverage.set(projectId, loaded);
    return loaded;
  }

  async function attachedThreads(projectId: string, tasks: readonly Task[]): Promise<string[]> {
    const scanned = await coverageOf(projectId);
    const meta = await tasksCall("listTaskCardMeta", { projectId }, tasksContract.listTaskCardMeta.output);
    const threads = meta.cards.flatMap((card) => card.activeThreads.map((link) => link.threadId));
    const open = tasks.filter((task) => !isComplete(task.status));
    const changed = open.filter((task) => {
      const last = scanned.get(task.id);
      return last !== undefined && last.updatedAt !== task.updatedAt;
    });
    const unseen = open.filter((task) => !scanned.has(task.id)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const stale = open
      .filter((task) => {
        const last = scanned.get(task.id);
        return last !== undefined && last.updatedAt === task.updatedAt && now() - last.at >= RESCAN_MS;
      })
      .sort((a, b) => scanned.get(a.id)!.at - scanned.get(b.id)!.at);
    const due = [...changed, ...[...unseen, ...stale].slice(0, RESCAN_BATCH)];
    const links = await mapLimited(due, 8, (task) =>
      tasksCall("listTaskThreads", { taskId: task.id }, tasksContract.listTaskThreads.output).then(
        (result) => {
          scanned.set(task.id, { at: now(), updatedAt: task.updatedAt });
          return result.taskThreads.map((link) => link.threadId);
        },
        () => [] as string[],
      ),
    );
    const known = new Set(tasks.map((task) => task.id));
    let pruned = false;
    for (const taskId of scanned.keys()) {
      if (known.has(taskId)) continue;
      scanned.delete(taskId);
      pruned = true;
    }
    if (due.length || pruned) await bb.storage.kv.set(sweepKey(projectId), Object.fromEntries(scanned));
    return [...threads, ...links.flat()];
  }

  async function leadIsAsking(threadId: string): Promise<boolean> {
    try {
      const [thread] = await bb.sdk.threads.list({ threadIds: [threadId], includeHidden: true });
      return thread?.hasPendingInteraction === true;
    } catch {
      return false;
    }
  }

  const commentsOf = (taskId: string) =>
    tasksCall("listComments", { taskId }, tasksContract.listComments.output).then(
      (result) => result.comments as Comment[],
      () => null,
    );

  async function collect(lead: Lead, tasks: readonly Task[], book: NoticeBook, mode: NotifyMode) {
    const deferred = new Set<string>();
    const held = new Set<string>();
    if (mode === "off") return { deferred, held, pending: EMPTY };
    const comments = new Map<string, Comment[] | null>();
    const read = async (taskId: string) => {
      if (comments.has(taskId)) return comments.get(taskId)!;
      const loaded = await commentsOf(taskId);
      comments.set(taskId, loaded);
      return loaded;
    };
    const departedIds = new Set<string>();
    for (const task of historyCandidates(tasks, book)) {
      const history = await read(task.id);
      if (history === null) {
        deferred.add(task.id);
        held.add(task.id);
      } else if (departed(task, book.cards[task.id]!, history)) departedIds.add(task.id);
    }
    const review: ReviewItem[] = [];
    const done: DoneItem[] = [];
    const superseded = new Set<string>();
    for (const move of transitionsOf(tasks, book, departedIds)) {
      if (move.to === "done") {
        done.push({ taskId: move.task.id, key: move.task.key, title: move.task.title, folded: move.folded.map((task) => task.key) });
        continue;
      }
      superseded.add(move.task.id);
      for (const task of move.folded) superseded.add(task.id);
      const history = await read(move.task.id);
      if (history === null) {
        held.add(move.task.id);
        deferred.add(move.task.id);
        for (const task of move.folded) deferred.add(task.id);
        continue;
      }
      const note = needsNote(history, askBoundary(history, book.cards[move.task.id]?.updatedAt ?? null));
      if (note === null && now() - Date.parse(move.task.updatedAt) < NOTE_GRACE_MS) {
        deferred.add(move.task.id);
        for (const task of move.folded) deferred.add(task.id);
        continue;
      }
      review.push({ taskId: move.task.id, key: move.task.key, title: move.task.title, note });
    }
    const kept = { review: book.pending.review.filter((item) => !superseded.has(item.taskId)), done: book.pending.done };
    const merged = livePending(mergePending(kept, review, done), tasks);
    const asking = merged.review.length > 0 && (await leadIsAsking(lead.meta.leadThreadId!));
    return { deferred, held, pending: applyPolicy(merged, mode, asking) };
  }

  async function send(lead: Lead, notice: Notice): Promise<boolean> {
    let channels: string[];
    try {
      channels = (await push("notifications.send", { ...notice, threadId: lead.meta.leadThreadId! }, z.object({ ok: z.literal(true), channels: z.array(z.string()) }).passthrough())).channels;
    } catch (cause) {
      degrade(`Could not send the ${lead.prefix} notification`, cause);
      return false;
    }
    if (!channels.length) bb.log.debug(`The ${lead.prefix} notification reached no channel; it stays pending.`);
    return channels.length > 0;
  }

  async function deliver(lead: Lead, book: NoticeBook, held: ReadonlySet<string>) {
    let current = book;
    const ready = <T extends { taskId: string }>(items: readonly T[]) => items.filter((item) => !held.has(item.taskId));
    const waiting = <T extends { taskId: string }>(items: readonly T[]) => items.filter((item) => held.has(item.taskId));
    const review = composeReview(ready(current.pending.review));
    if (review && (await send(lead, review))) {
      current = { ...current, pending: { ...current.pending, review: waiting(current.pending.review) } };
      await bb.storage.kv.set(bookKey(lead.projectId), current);
    }
    const done = composeDone(ready(current.pending.done));
    if (done && (await send(lead, done))) {
      current = { ...current, pending: { ...current.pending, done: waiting(current.pending.done) } };
      await bb.storage.kv.set(bookKey(lead.projectId), current);
    }
  }

  async function pass(lead: Lead, leadIds: ReadonlySet<string>) {
    if (!lead.meta.leadThreadId) return;
    const tasks = (await tasksCall("listAllTasks", { projectId: lead.projectId }, tasksContract.listAllTasks.output)).tasks as Task[];
    await muteWorkers(await attachedThreads(lead.projectId, tasks), leadIds);
    const book = await bb.storage.kv.get<NoticeBook>(bookKey(lead.projectId));
    if (!book) {
      await bb.storage.kv.set(bookKey(lead.projectId), { primedAt: stamp(), cards: nextCards(tasks, null, new Set()), pending: EMPTY } satisfies NoticeBook);
      return;
    }
    const { deferred, held, pending } = await collect(lead, tasks, book, await deps.mode());
    const next: NoticeBook = { primedAt: book.primedAt, cards: nextCards(tasks, book, deferred), pending };
    await bb.storage.kv.set(bookKey(lead.projectId), next);
    await deliver(lead, next, held);
  }

  async function tick() {
    const leads = await deps.leads();
    const leadIds = new Set(leads.map((lead) => lead.meta.leadThreadId).filter((id): id is string => Boolean(id)));
    for (const threadId of leadIds) {
      if ((await muteRecord(threadId))?.owner === "projects") await deps.restoreLead(threadId);
    }
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

  return { tick, pass, release };
}
