import type { Status, Task } from "./contracts";
import { canApply, deriveStatus, isWorking, type Landing, type PullRequestSignal, type Rule, type ThreadSignal } from "./derive";
import { COLUMN_LABEL, columnOf, isComplete, type Column } from "./status";

export const REVIEW_STALE_MS = 48 * 60 * 60_000;
const ASK_RE = /^[\s*_>#-]*needs\s+[\p{L}][\p{L}\p{N}_.-]*\s*[:：]/iu;
const STATUS_CHANGE_RE = /^status changed/i;
const HOLDING_RE = /^[\s*_>]*holding\s*[:：][\s*_]*\S/i;
const AGENT_AUTHOR_RE = /^agent \((thr_[A-Za-z0-9_-]+)\)$/;

export interface CommentSignal {
  kind: "user" | "agent" | "system";
  body: string;
  createdAt: string;
  threadId?: string | null;
  authorName?: string;
}

export type SignalBook = Record<string, { fp: string; changedAt: string }>;

export interface ReconcileContext {
  leadThreadId?: string | null;
  signals?: SignalBook;
}

export interface Commit {
  sha: string;
  at: string;
  message: string;
  ref: string;
  url: string | null;
}

export interface ReconcileSource {
  tasks(): Promise<Task[]>;
  threads(taskId: string): Promise<ThreadSignal[]>;
  pullRequests(taskId: string): Promise<PullRequestSignal[]>;
  comments(taskId: string): Promise<CommentSignal[]>;
  commits(sinceIso: string): Promise<Commit[]>;
}

export interface Drift {
  taskId: string;
  key: string;
  title: string;
  stored: Status;
  suggested: Column;
  rule: Rule;
  reason: string;
  applicable: boolean;
}

export interface Flag {
  taskId: string;
  key: string;
  title: string;
  kind: "review-without-ask" | "review-stale";
  text: string;
}

export interface Evidence {
  taskId: string;
  lastActivityAt: string | null;
  landing: Landing | null;
  hold: { status: Column; rule: Rule; since: string } | null;
}

export interface ReconcileResult {
  checkedAt: string;
  drifts: Drift[];
  held: Drift[];
  flags: Flag[];
  evidence: Evidence[];
}

export function fingerprint(signals: {
  threads: readonly ThreadSignal[];
  pullRequests: readonly PullRequestSignal[];
  children: readonly Status[];
  landing: Landing | null;
}): string {
  return JSON.stringify({
    prs: signals.pullRequests.map((pr) => `${pr.number}:${pr.state}`).sort(),
    landing: signals.landing?.sha ?? null,
    threads: signals.threads.length,
    working: signals.threads.some(isWorking),
    children: signals.children.map(columnOf).sort(),
  });
}

export function lastDecision(comments: readonly CommentSignal[], leadThreadId: string | null | undefined): string | null {
  const byLeadOrPerson = (thread: string | null) => thread === null || (!!leadThreadId && thread === leadThreadId);
  let latest: string | null = null;
  for (const comment of comments) {
    let decision = false;
    if (comment.kind === "system") {
      const agent = AGENT_AUTHOR_RE.exec(comment.authorName?.trim() ?? "");
      decision = STATUS_CHANGE_RE.test(comment.body.trim()) && byLeadOrPerson(agent ? agent[1]! : null);
    } else {
      const thread = comment.kind === "user" ? null : (comment.threadId ?? AGENT_AUTHOR_RE.exec(comment.authorName?.trim() ?? "")?.[1] ?? "unknown");
      decision = HOLDING_RE.test(comment.body) && byLeadOrPerson(thread);
    }
    if (decision && (!latest || Date.parse(comment.createdAt) > Date.parse(latest))) latest = comment.createdAt;
  }
  return latest;
}

export function mentionsKey(message: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![0-9])`, "i").test(message);
}

export function lastStatusChange(task: Pick<Task, "createdAt">, comments: readonly CommentSignal[]): string {
  let latest = task.createdAt;
  for (const comment of comments) {
    if (comment.kind === "system" && STATUS_CHANGE_RE.test(comment.body.trim()) && Date.parse(comment.createdAt) > Date.parse(latest)) latest = comment.createdAt;
  }
  return latest;
}

export function landingFor(key: string, sinceIso: string, commits: readonly Commit[]): Landing | null {
  const since = Date.parse(sinceIso);
  let best: Commit | null = null;
  for (const commit of commits) {
    if (Date.parse(commit.at) <= since || !mentionsKey(commit.message, key)) continue;
    if (!best || Date.parse(commit.at) > Date.parse(best.at)) best = commit;
  }
  if (!best) return null;
  return { sha: best.sha, subject: best.message.split("\n")[0]!.trim(), at: best.at, ref: best.ref, url: best.url };
}

export function hasAsk(comments: readonly CommentSignal[], sinceIso: string): boolean {
  const since = Date.parse(sinceIso) - 10 * 60_000;
  return comments.some((comment) => comment.kind !== "system" && Date.parse(comment.createdAt) >= since && ASK_RE.test(comment.body));
}

function keyNumber(key: string): number {
  return Number(/(\d+)$/.exec(key)?.[1] ?? 0);
}

function latest(values: readonly (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const value of values) if (value && (!best || Date.parse(value) > Date.parse(best))) best = value;
  return best;
}

export async function reconcileProject(source: ReconcileSource, now: number, context: ReconcileContext = {}): Promise<ReconcileResult & { signals: SignalBook }> {
  const nowIso = new Date(now).toISOString();
  const previous = context.signals ?? {};
  const signals: SignalBook = {};
  const tasks = await source.tasks();
  const children = new Map<string, Status[]>();
  for (const task of tasks) {
    if (task.parentTaskId) children.set(task.parentTaskId, [...(children.get(task.parentTaskId) ?? []), task.status]);
  }
  const open = tasks.filter((task) => !isComplete(task.status));
  const gathered = await Promise.all(
    open.map(async (task) => {
      const [threads, comments] = await Promise.all([source.threads(task.id), source.comments(task.id)]);
      const pullRequests = threads.length > 0 ? await source.pullRequests(task.id) : [];
      return { task, threads, comments, pullRequests, changedAt: lastStatusChange(task, comments) };
    }),
  );
  const oldest = gathered.reduce((min, item) => (Date.parse(item.changedAt) < Date.parse(min) ? item.changedAt : min), new Date(now).toISOString());
  const commits = gathered.length > 0 ? await source.commits(oldest).catch(() => [] as Commit[]) : [];

  const drifts: Drift[] = [];
  const held: Drift[] = [];
  const flags: Flag[] = [];
  const evidence: Evidence[] = [];
  for (const { task, threads, comments, pullRequests, changedAt } of gathered) {
    const landing = landingFor(task.key, changedAt, commits);
    const lastActivityAt = latest([task.updatedAt, ...comments.map((comment) => comment.createdAt)]);
    const kids = children.get(task.id) ?? [];
    const fp = fingerprint({ threads, pullRequests, children: kids, landing });
    const before = previous[task.id];
    const book = before && before.fp === fp ? before : { fp, changedAt: nowIso };
    signals[task.id] = book;
    const derived = deriveStatus({
      status: task.status,
      updatedAt: task.updatedAt,
      threads,
      pullRequests,
      children: kids,
      landing,
      lastActivityAt,
      now,
    });
    const decidedAt = lastDecision(comments, context.leadThreadId);
    const isHeld = !!derived && derived.rule !== "idle-demotion" && !!decidedAt && Date.parse(decidedAt) > Date.parse(book.changedAt);
    evidence.push({ taskId: task.id, lastActivityAt, landing, hold: isHeld && derived ? { status: derived.status, rule: derived.rule, since: decidedAt! } : null });
    if (derived) {
      const drift = { taskId: task.id, key: task.key, title: task.title, stored: task.status, suggested: derived.status, rule: derived.rule, reason: derived.reason, applicable: canApply(derived) };
      (isHeld ? held : drifts).push(drift);
    }
    if (columnOf(task.status) === "in_review" && !derived) {
      if (!hasAsk(comments, changedAt)) {
        flags.push({ taskId: task.id, key: task.key, title: task.title, kind: "review-without-ask", text: 'For Review without a "Needs <name>:" comment saying what the user must do' });
      } else if (now - Date.parse(changedAt) >= REVIEW_STALE_MS) {
        flags.push({ taskId: task.id, key: task.key, title: task.title, kind: "review-stale", text: `waiting on the user for ${Math.floor((now - Date.parse(changedAt)) / 86_400_000)}d: ask once, or close it if they have used it` });
      }
    }
  }
  const byKey = (left: { key: string }, right: { key: string }) => keyNumber(left.key) - keyNumber(right.key);
  return { checkedAt: nowIso, drifts: drifts.sort(byKey), held: held.sort(byKey), flags: flags.sort(byKey), evidence, signals };
}

export function describeDrift(drift: Drift): string {
  return `${drift.key} ${COLUMN_LABEL[columnOf(drift.stored)]} → ${COLUMN_LABEL[drift.suggested]}: ${drift.reason}`;
}
