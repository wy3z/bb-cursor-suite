import { describe, expect, it } from "vitest";
import { COLUMNS, COLUMN_LABEL, columnOf, statusLabel } from "./status";
import { IDLE_DEMOTION_MS, canApply, deriveStatus, rollup, type DeriveInput } from "./derive";
import { STATUS_LABEL } from "./glyphs";

const now = Date.parse("2026-11-08T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

const base: DeriveInput = {
  status: "in_progress",
  updatedAt: hoursAgo(1),
  threads: [],
  pullRequests: [],
  children: [],
  landing: null,
  lastActivityAt: null,
  now,
};

const working = { liveStatus: "working" as const, updatedAt: hoursAgo(0.1) };
const idle = { liveStatus: "idle" as const, updatedAt: hoursAgo(1) };

describe("status mapping", () => {
  it("uses Cursor's five statuses in Cursor's order", () => {
    expect([...COLUMNS]).toEqual(["in_review", "in_progress", "todo", "done", "canceled"]);
    expect(COLUMNS.map((column) => COLUMN_LABEL[column])).toEqual(["For Review", "In Progress", "Queued", "Done", "Canceled"]);
  });

  it("shows backlog and todo both as Queued", () => {
    expect(columnOf("backlog")).toBe("todo");
    expect(columnOf("todo")).toBe("todo");
    expect(statusLabel("backlog")).toBe("Queued");
    expect(STATUS_LABEL.backlog).toBe("Queued");
    expect(Object.values(STATUS_LABEL)).not.toContain("Backlog");
  });
});

describe("deriveStatus", () => {
  it("never touches Done or Canceled cards", () => {
    expect(deriveStatus({ ...base, status: "done", threads: [working] })).toBeNull();
    expect(deriveStatus({ ...base, status: "canceled", pullRequests: [{ number: 1, state: "open" }], threads: [idle] })).toBeNull();
  });

  it("shows Done once every PR is merged or closed and at least one merged", () => {
    expect(deriveStatus({ ...base, threads: [idle], pullRequests: [{ number: 12, state: "merged" }] })).toMatchObject({ status: "done", rule: "merged-prs-done", reason: "PR #12 merged" });
    expect(deriveStatus({ ...base, threads: [idle], pullRequests: [{ number: 1, state: "merged" }, { number: 2, state: "closed" }] })).toMatchObject({ status: "done" });
    expect(deriveStatus({ ...base, threads: [idle], pullRequests: [{ number: 1, state: "closed" }] })?.rule).not.toBe("merged-prs-done");
    expect(deriveStatus({ ...base, threads: [working], pullRequests: [{ number: 12, state: "merged" }] })).toBeNull();
    expect(deriveStatus({ ...base, threads: [idle], pullRequests: [{ number: 12, state: "merged" }], children: ["in_progress"] })?.rule).not.toBe("merged-prs-done");
    expect(deriveStatus({ ...base, threads: [idle], pullRequests: [{ number: 1, state: "merged" }, { number: 2, state: "open" }] })?.status).toBe("in_review");
  });

  it("shows Done for a direct-to-main commit only when no agent is working and no sub-task is open", () => {
    const landing = { sha: "7502059abcdef", subject: "Ship it (ABC-4)", at: hoursAgo(2), ref: "main", url: null };
    expect(deriveStatus({ ...base, landing })).toMatchObject({ status: "done", rule: "merged-commit-done", reason: "7502059 landed on main" });
    expect(deriveStatus({ ...base, landing, threads: [working] })).toBeNull();
    expect(deriveStatus({ ...base, landing, children: ["done", "todo"] })?.rule).not.toBe("merged-commit-done");
  });

  it("shows In Progress when an agent runs on a Queued or For Review card", () => {
    expect(deriveStatus({ ...base, status: "todo", threads: [working] })).toMatchObject({ status: "in_progress", rule: "agent-running-in-progress" });
    expect(deriveStatus({ ...base, status: "backlog", threads: [{ liveStatus: "starting", updatedAt: hoursAgo(0) }] })?.status).toBe("in_progress");
    expect(deriveStatus({ ...base, status: "in_review", threads: [{ ...idle, working: true }] })?.status).toBe("in_progress");
    expect(deriveStatus({ ...base, status: "todo", threads: [idle] })).toBeNull();
  });

  it("shows For Review when every agent is idle and a PR is open", () => {
    expect(deriveStatus({ ...base, threads: [idle], pullRequests: [{ number: 7, state: "open" }] })).toMatchObject({ status: "in_review", rule: "agent-idle-open-pr-for-review", reason: "agents idle, PR #7 open: land it, or For Review if the user must act" });
    expect(deriveStatus({ ...base, threads: [idle, working], pullRequests: [{ number: 7, state: "open" }] })).toBeNull();
  });

  it("demotes In Progress to Queued after 4 idle hours, counting comments as activity", () => {
    const stale = { ...base, updatedAt: hoursAgo(5), threads: [{ liveStatus: "idle" as const, updatedAt: hoursAgo(6) }] };
    expect(deriveStatus(stale)).toMatchObject({ status: "todo", rule: "idle-demotion", reason: "nothing running for 5h" });
    expect(deriveStatus({ ...stale, lastActivityAt: hoursAgo(1) })).toBeNull();
    expect(deriveStatus({ ...stale, updatedAt: new Date(now - IDLE_DEMOTION_MS + 60_000).toISOString() })).toBeNull();
    expect(deriveStatus({ ...stale, threads: [working] })).toBeNull();
    expect(deriveStatus({ ...base, updatedAt: hoursAgo(72) })?.reason).toBe("nothing running for 3d");
  });

  it("rolls a parent up from its sub-tasks only when it has no agent or PR of its own", () => {
    expect(deriveStatus({ ...base, children: ["done", "in_progress", "todo"] })).toBeNull();
    expect(deriveStatus({ ...base, children: ["done", "backlog", "todo"] })).toMatchObject({ status: "todo", rule: "children-rollup" });
    expect(deriveStatus({ ...base, status: "todo", children: ["in_review", "todo"] })).toMatchObject({ status: "in_review" });
    expect(deriveStatus({ ...base, children: ["done", "canceled"] })).toMatchObject({ status: "done", reason: "all 2 sub-tasks complete" });
    expect(deriveStatus({ ...base, status: "todo", children: ["canceled", "canceled"] })).toMatchObject({ status: "canceled" });
    expect(deriveStatus({ ...base, children: ["done", "done"], threads: [working] })).toBeNull();
  });

  it("prefers the most active child", () => {
    expect(rollup(["todo", "in_review", "in_progress"])?.status).toBe("in_progress");
    expect(rollup(["todo", "in_review"])?.status).toBe("in_review");
    expect(rollup([])).toBeNull();
  });

  it("lets the board apply only roll-ups and idle demotions, never Done or For Review", () => {
    expect(canApply({ status: "todo", rule: "idle-demotion" })).toBe(true);
    expect(canApply({ status: "in_progress", rule: "children-rollup" })).toBe(true);
    expect(canApply({ status: "todo", rule: "children-rollup" })).toBe(true);
    expect(canApply({ status: "in_review", rule: "children-rollup" })).toBe(false);
    expect(canApply({ status: "in_review", rule: "agent-idle-open-pr-for-review" })).toBe(false);
    expect(canApply({ status: "in_progress", rule: "agent-running-in-progress" })).toBe(false);
    expect(canApply({ status: "done", rule: "merged-prs-done" })).toBe(false);
    expect(canApply({ status: "done", rule: "children-rollup" })).toBe(false);
    expect(canApply({ status: "canceled", rule: "children-rollup" })).toBe(false);
  });
});
