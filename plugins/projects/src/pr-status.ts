export type PrState = "open" | "draft" | "merged" | "closed";

export interface PrSummaryFacts {
  isDraft: boolean;
  ci: { state: string; totalCount: number };
  reviewDecision: string;
  mergeability: string;
}

export type PrStatus = "merged" | "closed" | "draft" | "conflict" | "ci-failing" | "changes-requested" | "ci-pending" | "ready" | "waiting" | "open";

export const PR_STATUS: Record<PrStatus, { icon: string; label: string }> = {
  merged: { icon: "GitMerge", label: "Merged" },
  closed: { icon: "GitPullRequestClosed", label: "Closed" },
  draft: { icon: "GitPullRequestDraft", label: "Draft" },
  conflict: { icon: "GitPullRequest", label: "Conflicts" },
  "ci-failing": { icon: "CircleX", label: "CI Failing" },
  "changes-requested": { icon: "GitPullRequest", label: "Changes requested" },
  "ci-pending": { icon: "GitPullRequest", label: "Checks running" },
  ready: { icon: "GitPullRequestArrow", label: "Ready" },
  waiting: { icon: "GitPullRequest", label: "Waiting for Reviewers" },
  open: { icon: "GitPullRequest", label: "Open" },
};

const CI_DONE = new Set(["passed", "noChecks", "skipped"]);

export function prStatus(pr: { state: PrState }, summary: PrSummaryFacts | undefined): PrStatus {
  if (pr.state === "merged" || pr.state === "closed" || pr.state === "draft") return pr.state;
  if (!summary) return "open";
  if (summary.isDraft) return "draft";
  if (summary.mergeability === "conflicting") return "conflict";
  if (summary.ci.state === "failed") return "ci-failing";
  if (summary.reviewDecision === "changesRequested") return "changes-requested";
  if (summary.ci.state === "pending") return "ci-pending";
  if (!CI_DONE.has(summary.ci.state)) return "open";
  if (summary.reviewDecision === "approved") return "ready";
  if (summary.reviewDecision === "reviewRequired") return "waiting";
  return summary.mergeability === "mergeable" ? "ready" : "open";
}
