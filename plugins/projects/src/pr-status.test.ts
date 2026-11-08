import { describe, expect, it } from "vitest";
import { PR_STATUS, prStatus, type PrSummaryFacts } from "./pr-status";

const open = { state: "open" as const };
const facts = (patch: Partial<PrSummaryFacts> = {}): PrSummaryFacts => ({
  isDraft: false,
  ci: { state: "passed", totalCount: 1 },
  reviewDecision: "approved",
  mergeability: "mergeable",
  ...patch,
});

describe("prStatus", () => {
  it("keeps the lifecycle states", () => {
    expect(prStatus({ state: "merged" }, undefined)).toBe("merged");
    expect(prStatus({ state: "closed" }, facts())).toBe("closed");
    expect(prStatus({ state: "draft" }, undefined)).toBe("draft");
    expect(prStatus(open, facts({ isDraft: true }))).toBe("draft");
  });

  it("says Open, not Waiting for Reviewers, when nothing is known", () => {
    expect(prStatus(open, undefined)).toBe("open");
    expect(PR_STATUS[prStatus(open, undefined)].label).toBe("Open");
    expect(prStatus(open, facts({ ci: { state: "unknown", totalCount: 0 } }))).toBe("open");
    expect(prStatus(open, facts({ reviewDecision: "unknown", mergeability: "unknown" }))).toBe("open");
  });

  it("names conflicts, failing CI, requested changes and running checks", () => {
    expect(prStatus(open, facts({ mergeability: "conflicting" }))).toBe("conflict");
    expect(prStatus(open, facts({ ci: { state: "failed", totalCount: 2 } }))).toBe("ci-failing");
    expect(prStatus(open, facts({ reviewDecision: "changesRequested" }))).toBe("changes-requested");
    expect(PR_STATUS["changes-requested"].label).toBe("Changes requested");
    expect(prStatus(open, facts({ ci: { state: "pending", totalCount: 1 } }))).toBe("ci-pending");
  });

  it("is Ready once approved with checks done, counting no checks or skipped checks as done", () => {
    expect(prStatus(open, facts())).toBe("ready");
    expect(prStatus(open, facts({ ci: { state: "noChecks", totalCount: 0 } }))).toBe("ready");
    expect(prStatus(open, facts({ ci: { state: "skipped", totalCount: 1 } }))).toBe("ready");
    expect(prStatus(open, facts({ reviewDecision: "unknown" }))).toBe("ready");
  });

  it("waits for reviewers only when GitHub says a review is required", () => {
    expect(prStatus(open, facts({ reviewDecision: "reviewRequired" }))).toBe("waiting");
  });
});
