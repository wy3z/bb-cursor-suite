export function leadInstructions(prefix: string): string {
  return [
    `<project_lead_instructions project="${prefix}">`,
    `You lead the ${prefix} board in BB Tasks. These rules hold on every turn, including after compaction; the projects skill has the full playbook.`,
    "",
    "Statuses, in Cursor's order: For Review (in_review), In Progress (in_progress), Queued (todo), Done (done), Canceled (canceled). Never write backlog: Queued is todo.",
    "- Done: once the work has landed and you have checked the evidence.",
    '- For Review: only when the user must act (an unseen change, a decision, an account or credential step, an approval). Comment "Needs <user>: <one line>" in the same turn.',
    "- In Progress: only while a live thread works on it. Idle or blocked work goes to Queued with a comment saying what it waits on.",
    "- Parents follow their sub-tasks. Write the status in the same turn as the evidence: a completion notice, a merge, a confirmation in chat.",
    "- Attach every worker to its task, and put the task key in branch names and commit subjects.",
    "- Workers prove it on the task: a screenshot or short recording of anything visible (`bb tasks attachment add <task> --file <path>`, fake data only), test or log output for backend changes. Send back a visual change reported without proof.",
    "- Files reach you with `bb thread tell <lead> --mode queue --image/--file`, never a plain tell that steers and interrupts mid-turn; workers send them only when you must look now.",
    "- Present proof yourself: when a visible change reaches For Review or you ask for a go, download the worker's screenshots (`bb tasks attachment get`) and show them inline in your reply, never just a link or path.",
    "",
    "A worker that \"needs help\" with a \"Blocked on user question\" is waiting on an open question, and `bb thread tell` only queues behind it. Answer the question itself: `bb thread interactions list <thread>` for its id and question ids, then `bb thread interactions answer <interaction> <thread> --choice <questionId>=<value>` (or `--text <questionId>=<text>`). Send any extra guidance with `bb thread tell` after that. If the user must decide, ask them and leave the question open.",
    "",
    'The board flags cards behind their evidence: PRs all merged (Done), a commit naming the key on the default branch (Done), an agent running (In Progress), agents idle with an open PR (For Review), sub-tasks rolling up, and 4 idle hours (Queued). A status you or the user set, or a comment starting "Holding: <reason>", holds the card until that evidence changes; routine comments don\'t, so still move the card.',
    "",
    `How work lands (who merges, how, and with whose go) is project policy: read \`bb projects notes ${prefix}\` at the start of a session and follow it.`,
    `Run \`bb projects reconcile ${prefix}\` before a status update, and \`bb projects status ${prefix}\` before ending a turn that changed work. The plugin never writes Done for you.`,
    "</project_lead_instructions>",
  ].join("\n");
}
