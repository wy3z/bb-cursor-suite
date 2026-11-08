import type { Status, Task } from "./contracts";
import { canApply, deriveStatus, type Landing, type PullRequestSignal, type Rule, type ThreadSignal } from "./derive";
import { COLUMN_LABEL, columnOf, isComplete, type Column } from "./status";

export const REVIEW_STALE_MS = 48 * 60 * 60_000;
const ASK_RE = /^[\s*_>#-]*needs\s+[\p{L}][\p{L}\p{N}_.-]*\s*[:：]/iu;
const STATUS_CHANGE_RE = /^status changed/i;

export interface CommentSignal {
  kind: "user" | "agent" | "system";
  body: string;
  createdAt: string;
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
}

export interface ReconcileResult {
  checkedAt: string;
  drifts: Drift[];
  flags: Flag[];
  evidence: Evidence[];
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

export async function reconcileProject(source: ReconcileSource, now: number): Promise<ReconcileResult> {
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
  const flags: Flag[] = [];
  const evidence: Evidence[] = [];
  for (const { task, threads, comments, pullRequests, changedAt } of gathered) {
    const landing = landingFor(task.key, changedAt, commits);
    const lastActivityAt = latest([task.updatedAt, ...comments.map((comment) => comment.createdAt)]);
    evidence.push({ taskId: task.id, lastActivityAt, landing });
    const derived = deriveStatus({
      status: task.status,
      updatedAt: task.updatedAt,
      threads,
      pullRequests,
      children: children.get(task.id) ?? [],
      landing,
      lastActivityAt,
      now,
    });
    if (derived) {
      drifts.push({ taskId: task.id, key: task.key, title: task.title, stored: task.status, suggested: derived.status, rule: derived.rule, reason: derived.reason, applicable: canApply(derived) });
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
  return { checkedAt: new Date(now).toISOString(), drifts: drifts.sort(byKey), flags: flags.sort(byKey), evidence };
}

export function describeDrift(drift: Drift): string {
  return `${drift.key} ${COLUMN_LABEL[columnOf(drift.stored)]} → ${COLUMN_LABEL[drift.suggested]}: ${drift.reason}`;
}
