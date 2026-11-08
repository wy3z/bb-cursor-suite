import type { Status } from "./contracts";
import { COLUMN_LABEL, columnOf, isComplete, type Column } from "./status";

export const IDLE_DEMOTION_MS = 4 * 60 * 60_000;

export type LiveStatus = "starting" | "working" | "idle" | "completed" | "failed";

export interface ThreadSignal {
  liveStatus: LiveStatus;
  updatedAt: string;
  working?: boolean;
}

export interface PullRequestSignal {
  number: number;
  state: "open" | "draft" | "merged" | "closed";
}

export interface Landing {
  sha: string;
  subject: string;
  at: string;
  ref: string;
  url: string | null;
}

export interface DeriveInput {
  status: Status;
  updatedAt: string;
  threads: readonly ThreadSignal[];
  pullRequests: readonly PullRequestSignal[];
  children: readonly Status[];
  landing?: Landing | null;
  lastActivityAt?: string | null;
  now: number;
}

export type Rule =
  | "merged-prs-done"
  | "merged-commit-done"
  | "children-rollup"
  | "agent-running-in-progress"
  | "agent-idle-open-pr-for-review"
  | "idle-demotion";

export interface Derived {
  status: Column;
  rule: Rule;
  reason: string;
}

export function isWorking(thread: ThreadSignal): boolean {
  return thread.working === true || thread.liveStatus === "working" || thread.liveStatus === "starting";
}

function hours(ms: number): string {
  const value = Math.floor(ms / 3_600_000);
  return value >= 48 ? `${Math.floor(value / 24)}d` : `${value}h`;
}

function prList(prs: readonly PullRequestSignal[]): string {
  return prs.length === 1 ? `PR #${prs[0]!.number}` : `${prs.length} PRs`;
}

export function rollup(children: readonly Status[]): Derived | null {
  if (children.length === 0) return null;
  const columns = children.map(columnOf);
  const open = columns.filter((column) => column !== "done" && column !== "canceled");
  const done = columns.length - open.length;
  if (open.length > 0) {
    const status: Column = open.includes("in_progress") ? "in_progress" : open.includes("in_review") ? "in_review" : "todo";
    const count = open.filter((column) => column === status).length;
    const reason =
      status === "todo"
        ? `${done} of ${columns.length} sub-tasks complete, none in flight`
        : `${count} sub-task${count === 1 ? "" : "s"} ${COLUMN_LABEL[status].toLowerCase()}`;
    return { status, rule: "children-rollup", reason };
  }
  if (columns.every((column) => column === "canceled")) return { status: "canceled", rule: "children-rollup", reason: "every sub-task canceled" };
  return { status: "done", rule: "children-rollup", reason: `all ${columns.length} sub-tasks complete` };
}

function lastActivity(input: DeriveInput): number {
  const times = [input.updatedAt, input.lastActivityAt ?? null, ...input.threads.map((thread) => thread.updatedAt)]
    .filter((value): value is string => typeof value === "string")
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  return times.length ? Math.max(...times) : input.now;
}

export function evaluate(input: DeriveInput): Derived | null {
  const stored = columnOf(input.status);
  if (isComplete(input.status)) return null;
  const prs = input.pullRequests;
  const working = input.threads.some(isWorking);
  const merged = prs.filter((pr) => pr.state === "merged");
  if (merged.length > 0 && prs.every((pr) => pr.state === "merged" || pr.state === "closed")) {
    return { status: "done", rule: "merged-prs-done", reason: `${prList(merged)} merged` };
  }
  const childrenOpen = input.children.some((child) => !isComplete(child));
  if (input.landing && !working && !childrenOpen) {
    return { status: "done", rule: "merged-commit-done", reason: `${input.landing.sha.slice(0, 7)} landed on ${input.landing.ref}` };
  }
  if (prs.length === 0 && input.threads.length === 0 && input.children.length > 0) return rollup(input.children);
  if ((stored === "todo" || stored === "in_review") && working) {
    return { status: "in_progress", rule: "agent-running-in-progress", reason: "an agent is running" };
  }
  const openPrs = prs.filter((pr) => pr.state === "open" || pr.state === "draft");
  if (stored === "in_progress" && openPrs.length > 0 && input.threads.length > 0 && !working) {
    return { status: "in_review", rule: "agent-idle-open-pr-for-review", reason: `agents idle, ${prList(openPrs)} open` };
  }
  if (stored === "in_progress" && !working) {
    const idle = input.now - lastActivity(input);
    if (idle >= IDLE_DEMOTION_MS) return { status: "todo", rule: "idle-demotion", reason: `nothing running for ${hours(idle)}` };
  }
  return null;
}

export function deriveStatus(input: DeriveInput): Derived | null {
  const derived = evaluate(input);
  return derived && derived.status !== columnOf(input.status) ? derived : null;
}

export function canApply(derived: Pick<Derived, "status" | "rule">): boolean {
  if (derived.rule === "idle-demotion") return derived.status === "todo";
  if (derived.rule === "children-rollup") return derived.status === "in_progress" || derived.status === "todo";
  return false;
}
