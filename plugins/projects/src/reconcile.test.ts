import { describe, expect, it } from "vitest";
import { hasAsk, lastDecision, landingFor, lastStatusChange, mentionsKey, reconcileProject, type Commit, type CommentSignal, type ReconcileSource } from "./reconcile";
import { commitUrl, parseLog } from "./landings";
import type { Task } from "./contracts";

const now = Date.parse("2026-11-08T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

function task(key: string, patch: Partial<Task> = {}): Task {
  return {
    id: `t_${key}`,
    projectId: "p",
    key,
    title: `${key} title`,
    description: "",
    status: "in_progress",
    priority: "none",
    parentTaskId: null,
    position: 0,
    labelIds: [],
    createdAt: hoursAgo(100),
    updatedAt: hoursAgo(1),
    ...patch,
  };
}

function source(world: {
  tasks: Task[];
  threads?: Record<string, { liveStatus: "working" | "idle"; updatedAt: string }[]>;
  prs?: Record<string, { number: number; state: "open" | "draft" | "merged" | "closed" }[]>;
  comments?: Record<string, CommentSignal[]>;
  commits?: Commit[];
}): ReconcileSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    tasks: async () => world.tasks,
    threads: async (id) => world.threads?.[id] ?? [],
    pullRequests: async (id) => {
      asked.push(id);
      return world.prs?.[id] ?? [];
    },
    comments: async (id) => world.comments?.[id] ?? [],
    commits: async () => world.commits ?? [],
  };
}

describe("commit matching", () => {
  it("matches a task key without matching longer keys", () => {
    expect(mentionsKey("Fix swipe (BCS-4)", "BCS-4")).toBe(true);
    expect(mentionsKey("Merge branch 'bcs-4-swipe'", "BCS-4")).toBe(true);
    expect(mentionsKey("Monorepo (BCS-48)", "BCS-4")).toBe(false);
    expect(mentionsKey("XBCS-4 thing", "BCS-4")).toBe(false);
  });

  it("only counts commits after the card last changed status", () => {
    const commits: Commit[] = [
      { sha: "aaaaaaa1", at: hoursAgo(10), message: "Old (BCS-4)", ref: "main", url: null },
      { sha: "bbbbbbb2", at: hoursAgo(2), message: "New (BCS-4)\n\nbody", ref: "main", url: "https://github.com/o/r/commit/bbbbbbb2" },
    ];
    expect(landingFor("BCS-4", hoursAgo(5), commits)).toMatchObject({ sha: "bbbbbbb2", subject: "New (BCS-4)", ref: "main" });
    expect(landingFor("BCS-4", hoursAgo(1), commits)).toBeNull();
  });

  it("reads the last status change from system comments", () => {
    const comments: CommentSignal[] = [
      { kind: "system", body: "Status changed to In Progress by agent", createdAt: hoursAgo(5) },
      { kind: "agent", body: "Status changed? no", createdAt: hoursAgo(2) },
    ];
    expect(lastStatusChange(task("X-1"), comments)).toBe(hoursAgo(5));
    expect(lastStatusChange(task("X-1"), [])).toBe(hoursAgo(100));
  });

  it("parses git log records and builds GitHub commit links", () => {
    const log = "abc1234def\x1f2026-11-08T10:00:00+00:00\x1fShip (BCS-9)\x1fbody line\x1e\nnot-a-sha\x1fbad\x1fx\x1f\x1e";
    expect(parseLog(log, "origin/main", "https://github.com/wy3z/bb-cursor-suite.git")).toEqual([
      { sha: "abc1234def", at: "2026-11-08T10:00:00+00:00", message: "Ship (BCS-9)\nbody line", ref: "main", url: "https://github.com/wy3z/bb-cursor-suite/commit/abc1234def" },
    ]);
    expect(commitUrl("git@github.com:wy3z/x.git", "s")).toBe("https://github.com/wy3z/x/commit/s");
    expect(commitUrl("https://gitlab.com/a/b", "s")).toBeNull();
  });

  it("recognises Needs <name>: asks near the move to For Review", () => {
    const ask: CommentSignal = { kind: "agent", body: "Needs James: look at the board on mobile", createdAt: hoursAgo(3) };
    expect(hasAsk([ask], hoursAgo(3))).toBe(true);
    expect(hasAsk([{ ...ask, body: "**Needs James:** decide" }], hoursAgo(3))).toBe(true);
    expect(hasAsk([{ ...ask, body: "This needs James to look" }], hoursAgo(3))).toBe(false);
    expect(hasAsk([ask], hoursAgo(1))).toBe(false);
  });
});

describe("reconcileProject", () => {
  it("lists cards whose stored status disagrees with the evidence, with suggested moves", async () => {
    const world = source({
      tasks: [
        task("P-1", { status: "in_progress" }),
        task("P-2", { status: "todo" }),
        task("P-3", { status: "in_progress" }),
        task("P-4", { status: "in_progress", updatedAt: hoursAgo(6) }),
        task("P-5", { status: "in_progress" }),
        task("P-6", { status: "in_progress" }),
        task("P-7", { status: "done", parentTaskId: "t_P-6" }),
        task("P-8", { status: "backlog", parentTaskId: "t_P-6" }),
        task("P-9", { status: "done" }),
        task("P-10", { status: "in_progress" }),
      ],
      threads: {
        "t_P-1": [{ liveStatus: "idle", updatedAt: hoursAgo(1) }],
        "t_P-2": [{ liveStatus: "working", updatedAt: hoursAgo(0) }],
        "t_P-3": [{ liveStatus: "idle", updatedAt: hoursAgo(1) }],
        "t_P-4": [{ liveStatus: "idle", updatedAt: hoursAgo(7) }],
        "t_P-10": [{ liveStatus: "working", updatedAt: hoursAgo(0) }],
      },
      prs: { "t_P-1": [{ number: 3, state: "merged" }], "t_P-3": [{ number: 4, state: "open" }] },
      commits: [{ sha: "c0ffee12", at: hoursAgo(2), message: "Direct (P-5)", ref: "main", url: null }],
    });
    const result = await reconcileProject(world, now);
    expect(result.drifts.map((drift) => [drift.key, drift.suggested, drift.rule, drift.applicable])).toEqual([
      ["P-1", "done", "merged-prs-done", false],
      ["P-2", "in_progress", "agent-running-in-progress", false],
      ["P-3", "in_review", "agent-idle-open-pr-for-review", false],
      ["P-4", "todo", "idle-demotion", true],
      ["P-5", "done", "merged-commit-done", false],
      ["P-6", "todo", "children-rollup", true],
    ]);
    expect(result.evidence.find((item) => item.taskId === "t_P-5")?.landing?.sha).toBe("c0ffee12");
    expect(result.evidence.some((item) => item.taskId === "t_P-9")).toBe(false);
    expect(world.asked).not.toContain("t_P-5");
  });

  it("flags For Review cards with no Needs ask, and stale asks", async () => {
    const world = source({
      tasks: [task("R-1", { status: "in_review" }), task("R-2", { status: "in_review" }), task("R-3", { status: "in_review" })],
      comments: {
        "t_R-2": [
          { kind: "system", body: "Status changed to For Review", createdAt: hoursAgo(80) },
          { kind: "agent", body: "Needs James: approve the icon", createdAt: hoursAgo(80) },
        ],
        "t_R-3": [
          { kind: "system", body: "Status changed to For Review", createdAt: hoursAgo(2) },
          { kind: "agent", body: "Needs James: pick a name", createdAt: hoursAgo(2) },
        ],
      },
    });
    const result = await reconcileProject(world, now);
    expect(result.drifts).toEqual([]);
    expect(result.flags.map((flag) => [flag.key, flag.kind])).toEqual([
      ["R-1", "review-without-ask"],
      ["R-2", "review-stale"],
    ]);
  });

  it("is clean when the board matches", async () => {
    const result = await reconcileProject(source({ tasks: [task("C-1", { status: "todo" }), task("C-2", { status: "done" })] }), now);
    expect(result.drifts).toEqual([]);
    expect(result.flags).toEqual([]);
  });
});

describe("manual-pick hold", () => {
  const merged = { "t_H-1": [{ number: 3, state: "merged" as const }] };
  const idleThread = { "t_H-1": [{ liveStatus: "idle" as const, updatedAt: hoursAgo(3) }] };

  it("counts status changes by the lead or a person, and Holding comments, as decisions", () => {
    const lead = "thr_lead";
    const at = (hours: number) => hoursAgo(hours);
    const change = (author: string, hours: number): CommentSignal => ({ kind: "system", body: "Status changed to In Progress by " + author, authorName: author, createdAt: at(hours), threadId: null });
    expect(lastDecision([change("agent (thr_lead)", 5)], lead)).toBe(at(5));
    expect(lastDecision([change("James", 4)], lead)).toBe(at(4));
    expect(lastDecision([change("agent (thr_worker)", 3)], lead)).toBeNull();
    expect(lastDecision([{ kind: "system", body: "Thread attached", authorName: "James", createdAt: at(1) }], lead)).toBeNull();
  });

  it("ignores routine comments, and Holding comments without a reason or from workers", () => {
    const lead = "thr_lead";
    const note = (body: string, extra: Partial<CommentSignal> = {}): CommentSignal => ({ kind: "agent", body, createdAt: hoursAgo(1), threadId: lead, ...extra });
    expect(lastDecision([note("PR #12 opened, tests pass")], lead)).toBeNull();
    expect(lastDecision([note("Not done yet, holding: later")], lead)).toBeNull();
    expect(lastDecision([note("Holding:")], lead)).toBeNull();
    expect(lastDecision([note("Holding: PR #3 was only the first half")], lead)).toBe(hoursAgo(1));
    expect(lastDecision([note("**holding:** waiting on the vendor")], lead)).toBe(hoursAgo(1));
    expect(lastDecision([note("Holding: shipped", { threadId: null, authorName: "agent (thr_lead)" })], lead)).toBe(hoursAgo(1));
    expect(lastDecision([note("Holding: mine", { threadId: "thr_worker" })], lead)).toBeNull();
    expect(lastDecision([{ kind: "user", body: "HOLDING: I checked, the commit only mentions it", createdAt: hoursAgo(2) }], null)).toBe(hoursAgo(2));
    expect(lastDecision([{ kind: "user", body: "works", createdAt: hoursAgo(2) }], null)).toBeNull();
  });

  it("holds a drift once the lead decides after the evidence last changed, until the evidence changes again", async () => {
    const tasks = [task("H-1", { status: "in_progress" })];
    const first = await reconcileProject(source({ tasks, threads: idleThread, prs: merged }), now - 3_600_000, { leadThreadId: "thr_lead" });
    expect(first.drifts.map((drift) => drift.key)).toEqual(["H-1"]);

    const routine = { "t_H-1": [{ kind: "agent" as const, body: "PR #3 merged, tests pass", createdAt: hoursAgo(0.5), threadId: "thr_lead" }] };
    expect((await reconcileProject(source({ tasks, threads: idleThread, prs: merged, comments: routine }), now, { leadThreadId: "thr_lead", signals: first.signals })).drifts).toHaveLength(1);
    const comments = { "t_H-1": [{ kind: "agent" as const, body: "Holding: the PR was a partial fix", createdAt: hoursAgo(0.5), threadId: "thr_lead" }] };
    const second = await reconcileProject(source({ tasks, threads: idleThread, prs: merged, comments }), now, { leadThreadId: "thr_lead", signals: first.signals });
    expect(second.drifts).toEqual([]);
    expect(second.held.map((drift) => [drift.key, drift.suggested])).toEqual([["H-1", "done"]]);
    expect(second.evidence[0]!.hold).toMatchObject({ status: "done", rule: "merged-prs-done" });

    const morePrs = { "t_H-1": [{ number: 3, state: "merged" as const }, { number: 4, state: "merged" as const }] };
    const third = await reconcileProject(source({ tasks, threads: idleThread, prs: morePrs, comments }), now + 60_000, { leadThreadId: "thr_lead", signals: second.signals });
    expect(third.drifts.map((drift) => drift.key)).toEqual(["H-1"]);
    expect(third.held).toEqual([]);
  });

  it("does not hold on decisions made before the evidence was seen, or on a worker's comment", async () => {
    const tasks = [task("H-1", { status: "in_progress" })];
    const early = { "t_H-1": [{ kind: "user" as const, body: "Holding: ok", createdAt: hoursAgo(10) }] };
    expect((await reconcileProject(source({ tasks, threads: idleThread, prs: merged, comments: early }), now)).drifts).toHaveLength(1);
    const first = await reconcileProject(source({ tasks, threads: idleThread, prs: merged }), now - 3_600_000, { leadThreadId: "thr_lead" });
    const worker = { "t_H-1": [{ kind: "agent" as const, body: "Holding: done!", createdAt: hoursAgo(0.5), threadId: "thr_worker" }] };
    expect((await reconcileProject(source({ tasks, threads: idleThread, prs: merged, comments: worker }), now, { leadThreadId: "thr_lead", signals: first.signals })).drifts).toHaveLength(1);
  });

  it("never holds idle demotion: the comment restarts the idle clock instead", async () => {
    const tasks = [task("H-2", { status: "in_progress", updatedAt: hoursAgo(10) })];
    const first = await reconcileProject(source({ tasks }), now - 6 * 3_600_000);
    const comments = { "t_H-2": [{ kind: "user" as const, body: "Holding: still on it", createdAt: hoursAgo(5) }] };
    const later = await reconcileProject(source({ tasks, comments }), now, { signals: first.signals });
    expect(later.drifts.map((drift) => drift.rule)).toEqual(["idle-demotion"]);
    expect(later.held).toEqual([]);
  });
});
