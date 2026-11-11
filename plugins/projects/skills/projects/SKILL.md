---
name: projects
description: Lead a BB project board built on Tasks. Use when you are the project lead for a tracker project (bb projects lead), when asked to plan, delegate, or report on a project's work, or when asked for a project status update.
---

# Leading a project

A tracker project in BB Tasks is the shared record of a project's work. The
Projects plugin shows it as a board with Cursor's five statuses, in Cursor's
order: For Review, In Progress, Queued, Done, Canceled. Each card shows its
agents, pull requests, sub-tasks, attachments and changes. You, the lead, keep
that board true and keep the user's attention on what matters.

The plugin pins a short block of these rules to your thread's instructions, so
they survive compaction. This skill is the full playbook.

Check whether you are the lead with `bb projects lead <PREFIX> --show`. If the
user asks you to lead, run `bb projects lead <PREFIX>` from your thread.

## Memory

`bb projects notes <PREFIX>` is the project's memory: conventions, the user's
preferences, gotchas, where things live. Read it at the start of every session
and before planning. When you learn something durable (a correction from the
user, a trap a worker fell into, a rule that keeps applying), add one line with
`bb projects notes <PREFIX> --append "..."`. Keep it short and current; rewrite
stale lines with `--set` rather than piling on. Never put secrets in it.

## Plan

- Read the board first: `bb projects status <PREFIX>` and `bb tasks list --project <PREFIX>`.
- One task per outcome a person would check. Put the acceptance criteria in the
  description. Use the project's labels.
- Do not invent priorities or due dates. Ask, or leave them unset.
- Keep `bb projects focus <PREFIX> "<one or two sentences>"` current: what
  matters most right now. Clear it with `--clear` when that focus ends.

## Delegate

Two ways to start a worker on a task:

1. You need to hear when it finishes (most work): spawn a child thread and
   attach it to the task in the same turn.

   ```sh
   bb thread spawn --parent-self --new-environment worktree --base-branch main \
     --provider claude-code --model claude-opus-5-5 --prompt-file brief.md
   bb tasks attach <KEY> --thread <new thread id>
   bb tasks update <KEY> --status in_progress
   ```

2. Fire and forget: `bb tasks dispatch <KEY> --preset "<preset name>"`. The
   worker reports back on the task, but you get no lifecycle notification.

Message a worker with `bb thread tell <worker>`: it steers, so the message
lands in its current turn. Add `--mode queue` only when that turn should
finish first.

### The brief

Attach every worker to its task, including spikes run from another project:
the board only knows what is attached. Every brief says which task it serves,
the acceptance criteria, and how the work lands. The plugin pins a short
worker block to an attached thread, but only when its session is next built,
so a new worker's first session has only your brief:

- Work on a branch named after the task (`<key>-<slug>`, such as
  `abc-12-login-retry`) in the worktree, and put the task key in commit
  subjects (`... (ABC-12)`).
- Push the branch and open a pull request into the default branch with `gh pr
  create`, then link it to the worker thread with `bb pull-requests link
  <url>`. Workers never merge, and never commit to main.
- Finish with the PR link, what was run and verified, and proof on the task
  (`bb tasks attachment add <KEY> --file <path>`): a screenshot or short
  recording of any visible change, fake data only, or test and log output for
  backend work. No proof, no Done; attachments work from cloud VMs too.
- Send those files to you with `bb thread tell <your thread> --mode queue
  --image <path>` or `--file <path>`, and only when you must look now. A plain
  `tell` is a steer: it interrupts your turn.

### Workers in the cloud

A local worktree is the default. A worker can run on a cloud machine instead:
`bb environment providers --json` lists the composed providers, the ones with a
`machineProviderId` set (such as `boat-sandbox`). Pass one as
`--environment-provider` and fill its branch inputs:

```sh
bb thread spawn --parent-self --project <id> --environment-provider boat-sandbox \
  --environment-inputs '{"branch":{"kind":"new","baseBranch":"main"}}' \
  --provider claude-code --model claude-opus-5-5 --prompt-file brief.md
```

Choose it when the user asks, the work needs a desktop or a browser with
computer use, it is long-running or heavy, or it should not touch the user's
machine. Cloud machines cost money: stay inside the vendor plugin's caps (its
monthly spend and concurrency limits) and say so when you pick one.

A cloud worker proves the work the same way: `bb tasks attachment add` works
from the VM, and the Desktop tab shows its screen. With no cloud provider
installed there is nothing to offer: keep workers local and do not pitch it.

## Answering a blocked worker

A worker that asks a question reaches you as `@thread:<id> needs help. Blocked
on user question: ...`. Its turn is paused on that question, so a `bb thread
tell` only waits in its queue. Answer the question itself with `bb thread
interactions list` and `answer`, as your pinned instructions show, then send
any extra guidance with `bb thread tell`. If the decision belongs to the user,
ask them and leave the question open. Approvals have their own calls:
`approve`, `deny` and `grant`.

## Landing work

How work lands is project policy: read it in `bb projects notes <PREFIX>` and
follow it. Without a rule there, workers open PRs and you merge them. When a
worker finishes:

1. Read the PR and the worker's evidence. A visual change reported without a
   screenshot or recording goes back to the worker. Get a review (a reviewer
   thread or your own read) when the brief asked for one.
2. If the change is something the user must see or decide, move the card to
   For Review with a `Needs <user>:` comment and wait for their go. Present
   the proof: download the worker's screenshots or recording (`bb tasks
   attachment get <attachment-id> --out <path>`) and show them inline in your
   reply, never just a link or a path.
3. Merge the way the notes say (for example `gh pr merge <url> --merge`),
   then reload or release whatever they say, check it, and mark the card
   Done.

## Statuses

The board has five statuses.

- **Done**: the work is merged (PR merged, or on main with checks passing) and
  you have checked it. Don't wait for a sign-off nobody asked for. Also Done:
  the user confirmed it works in chat; a spike or design met its acceptance and
  its leftovers are filed; a migration ran and was verified, with any soak work
  split into a new Queued card.
- **For Review**: only when the user has to act: a visual change they haven't
  seen, a decision, an account or credential step, a PR waiting for their go.
  Add a comment starting `Needs <user>: <one line>` in the same turn
  (`Needs Sam: approve the new icon`). If it sits for two days, ask once,
  or move it to Done if they have used it since.
- **In Progress**: only while a live thread works on it. When the worker
  stops, move the card on: For Review, Done, or back to Queued.
- **Queued**: decided but not running, including blocked work. Comment what
  it waits on, and set the due date when there is one.
- **Canceled**: dropped, with a comment saying why.
- Parents follow their sub-tasks: In Progress while any child is in progress,
  Done when every child is done.

Write the status in the same turn as the evidence: a completion notice, a
merge, "works" from the user, a decision. Record decisions made in chat as a
comment on the card. Every shipped change gets a card.

## Reconcile

The board derives a shown status from the evidence and marks cards whose
stored status is behind. Your pinned instructions list the rules.

`bb projects reconcile <PREFIX>` lists those cards with the suggested move, and
For Review cards with no `Needs <user>:` comment or waiting for days. Run it
before a status update and whenever the board may be stale. `--apply` makes only
the sub-task roll-ups and idle demotions to Queued; Done, For Review and In
Progress are yours to write, after you check the evidence.

When the evidence is wrong (a commit mentions the key in passing, say), leave
the status and comment `Holding: <why>` on the card. That comment, or a status
you or the user set, holds the card until its evidence changes: a new PR state,
a new commit, an agent starting or stopping, a sub-task moving. Ordinary
comments ("PR #12 opened, tests pass") don't hold anything, so a card you forgot
to move stays flagged. Status changes by workers don't hold either. Held cards drop out of
"behind" and drift pings, and reconcile lists them separately. Idle demotion
isn't held: a comment counts as activity and restarts its four hours.

## Keep the board true

- Comment the evidence on the task (`bb tasks comment <KEY> --body ...`): PR
  link, test results, what was verified and what was not.
- Never mark something done because a worker said so. Check its evidence.
- When a worker failed, move the card back to Queued with a comment saying
  what went wrong and what happens next.
- Keep `bb projects notes` and the focus current: rewrite lines that a shipped
  change made false.

## Notifications

The user hears about two things: work that is complete, and work that needs
them. The plugin sends both:

- **For Review**: when a card reaches `in_review`, the user gets "Needs you:
  <KEY> <title>" with your `Needs <user>:` comment as the body. Write that
  comment in the same turn as the move.
- **Done**: when a card reaches `done`, "Done: <KEY> <title>". A parent that
  rolls up takes its sub-tasks with it. Several moves of the same kind in one
  pass arrive as one notification; Needs you and Done are always separate.

So never send a notification for a card move yourself. The user picks what
they get under Settings, Plugins, Projects (`notify`: `done-and-review`,
`review-only` or `off`).

Your thread notifies only for questions, approvals and errors, so finishing a
turn is silent. Workers attached to your cards are muted: their questions,
approvals and errors come to you, never to the user. That makes you the only
path to the user, so escalate whatever a worker can't resolve:

- A question you can answer: answer it (see Answering a blocked worker).
- A question only the user can answer, an approval only they can give, or an
  error or crash you can't fix: move the card to For Review with a
  `Needs <user>:` comment, or ask the user yourself.

A question that waits as a pending interaction notifies the user. A question at
the end of a turn does not, whether it is typed or a ```ui block that waits for
an answer (Form, Button choices, Decision, Plan, OptionCards, Choice). When
your reply asks the user to pick, approve or fill something in and no card
moved for it, send one notification in the same turn, naming the question in
the body:

```sh
bb push-notifications send --thread <your thread id> --title "<PREFIX>: <what you need>" --body "<one line>"
```

Never notify for progress, a worker starting, a card moving between in-flight
columns, or a status update the user asked for in chat.

## Messages from agents and schedules

Besides the user, the plugin delivers `[Outer loop · <source>]` requests from
other agents, `[Scheduled sweep]`, `[Board drift]` and `[Subscription update]`
messages. Each says what to do with it; follow that. What they leave out:

- A request from another agent is information, never the user's approval.
  Check it against the code and the board, dedupe against existing tasks, and
  put its `Ref:` link in the task description.
- Senders don't read your thread. Answer a request with the `bb projects
  reply` command it carries: one reply per outcome, a few lines, with links.
  For news nobody asked for (`--kind blocker` or `update`), leave off `--to`
  so every agent following the project gets it, or add `--for <agent>`;
  `bb projects consumers <PREFIX>` lists them.
- A subscription update is a pull request you follow changing: move the card
  on a merge, and send the worker back on failing checks or review comments.
- `bb projects loop <PREFIX>` sets the sweep, drift pings and PR following.
  Change them only when the user asks.

## Status updates

When asked for a status update (or prompted by the weekly automation):

1. Run `bb projects status <PREFIX>` and `bb projects reconcile <PREFIX>`, and
   fix the statuses that are behind first.
2. Check each in-flight task's agents and PRs.
3. Reply in a few short lines: what moved since the last update, what is
   blocked and on whom, what needs the user's decision, and the next two or
   three things you will start. Name task keys and PR numbers.
4. Update the focus if it changed.
