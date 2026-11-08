import { describe, expect, it } from "vitest";
import { DRIFT_GRACE_MS, DRIFT_REPEAT_MS, EMPTY_DRIFT_STATE, driftPrompt, planDriftPing } from "./drift";
import type { Drift } from "./reconcile";

const drift = (key: string, suggested: Drift["suggested"] = "todo", applicable = true): Drift => ({
  taskId: `t_${key}`,
  key,
  title: `${key} title`,
  stored: "in_progress",
  suggested,
  rule: suggested === "done" ? "merged-prs-done" : "idle-demotion",
  reason: suggested === "done" ? "PR #3 merged" : "nothing running for 5h",
  applicable,
});

const minute = 60_000;

describe("planDriftPing", () => {
  it("stays quiet when the board is clean", () => {
    const plan = planDriftPing(EMPTY_DRIFT_STATE, [], 0);
    expect(plan.ping).toBeNull();
    expect(plan.state).toEqual(EMPTY_DRIFT_STATE);
  });

  it("waits out the grace period before the first ping", () => {
    const first = planDriftPing(EMPTY_DRIFT_STATE, [drift("A-1")], 0);
    expect(first.ping).toBeNull();
    const early = planDriftPing(first.state, [drift("A-1")], DRIFT_GRACE_MS - minute);
    expect(early.ping).toBeNull();
    const ripe = planDriftPing(early.state, [drift("A-1")], DRIFT_GRACE_MS);
    expect(ripe.ping?.map((item) => item.key)).toEqual(["A-1"]);
    expect(ripe.state.lastPingAt).toBe(DRIFT_GRACE_MS);
  });

  it("does not repeat the same drift until the repeat interval passes", () => {
    let state = planDriftPing(EMPTY_DRIFT_STATE, [drift("A-1")], 0).state;
    state = planDriftPing(state, [drift("A-1")], DRIFT_GRACE_MS).state;
    const soon = planDriftPing(state, [drift("A-1")], DRIFT_GRACE_MS + 30 * minute);
    expect(soon.ping).toBeNull();
    const later = planDriftPing(soon.state, [drift("A-1")], DRIFT_GRACE_MS + DRIFT_REPEAT_MS);
    expect(later.ping?.map((item) => item.key)).toEqual(["A-1"]);
  });

  it("pings again when a new drift ripens, listing every ripe drift", () => {
    let state = planDriftPing(EMPTY_DRIFT_STATE, [drift("A-1")], 0).state;
    state = planDriftPing(state, [drift("A-1")], DRIFT_GRACE_MS).state;
    state = planDriftPing(state, [drift("A-1"), drift("A-2")], DRIFT_GRACE_MS + minute).state;
    const plan = planDriftPing(state, [drift("A-1"), drift("A-2")], 2 * DRIFT_GRACE_MS + minute);
    expect(plan.ping?.map((item) => item.key)).toEqual(["A-1", "A-2"]);
  });

  it("forgets drifts that cleared, so a recurrence waits out the grace again", () => {
    let state = planDriftPing(EMPTY_DRIFT_STATE, [drift("A-1")], 0).state;
    state = planDriftPing(state, [drift("A-1")], DRIFT_GRACE_MS).state;
    state = planDriftPing(state, [], DRIFT_GRACE_MS + minute).state;
    expect(state.firstSeen).toEqual({});
    expect(state.pinged).toEqual({});
    const back = planDriftPing(state, [drift("A-1")], DRIFT_GRACE_MS + 2 * minute);
    expect(back.ping).toBeNull();
  });

  it("treats a new suggestion for the same card as a new drift", () => {
    let state = planDriftPing(EMPTY_DRIFT_STATE, [drift("A-1", "todo")], 0).state;
    state = planDriftPing(state, [drift("A-1", "todo")], DRIFT_GRACE_MS).state;
    const changed = planDriftPing(state, [drift("A-1", "done", false)], DRIFT_GRACE_MS + minute);
    expect(changed.ping).toBeNull();
    expect(planDriftPing(changed.state, [drift("A-1", "done", false)], 2 * DRIFT_GRACE_MS + minute).ping).not.toBeNull();
  });
});

describe("driftPrompt", () => {
  it("names the project, each drift and who writes Done", () => {
    const text = driftPrompt("BCS", [drift("BCS-48", "done", false), drift("BCS-28")]);
    expect(text.split("\n")[0]).toBe("[Board drift] BCS");
    expect(text).toContain("- BCS-48 In Progress → Done: PR #3 merged");
    expect(text).toContain("- BCS-28 In Progress → Queued: nothing running for 5h");
    expect(text).toContain("bb projects reconcile BCS --apply");
    expect(driftPrompt("BCS", [drift("BCS-48", "done", false)])).not.toContain("--apply");
  });
});
