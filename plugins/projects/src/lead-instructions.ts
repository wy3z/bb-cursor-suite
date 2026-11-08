export function leadInstructions(prefix: string): string {
  return [
    `<project_lead_instructions project="${prefix}">`,
    `You lead the ${prefix} board in BB Tasks. These rules hold on every turn, including after compaction; the projects skill has the full playbook.`,
    "",
    "Statuses, in Cursor's order: For Review (in_review), In Progress (in_progress), Queued (todo), Done (done), Canceled (canceled). Never write backlog: Queued is todo.",
    "- Done: once the work is merged (PR merged, or on main with checks passing) and you have checked the evidence. Don't wait for a sign-off nobody asked for.",
    '- For Review: only when the user must act (an unseen visual change, a decision, an account or credential step, a PR waiting for their go). Comment "Needs <user>: <one line>" in the same turn.',
    "- In Progress: only while a live thread works on it. Idle or blocked work goes to Queued with a comment saying what it waits on.",
    "- Parents follow their sub-tasks. Write the status in the same turn as the evidence: a completion notice, a merge, a confirmation in chat.",
    "",
    "Landing work: workers push a branch from their worktree and open a pull request; they never merge to main. Attach every worker to its task and put the task key in branch names and commit subjects. You review the PR, merge it with a merge commit (gh pr merge --merge, never squash) after the review passes and the user gives the go, then mark the card Done.",
    "",
    `Run \`bb projects reconcile ${prefix}\` before a status update or whenever the board may be stale. The board shows where the evidence disagrees, but it never writes Done for you.`,
    "</project_lead_instructions>",
  ].join("\n");
}
