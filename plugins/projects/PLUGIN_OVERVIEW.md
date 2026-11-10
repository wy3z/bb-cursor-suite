Projects shows BB Tasks as Cursor-style boards, with live agents, pull requests and changes on every card.
A lead thread plans, delegates and keeps the board true, and any agent system can hand it work and read its replies.
Tasks owns the data; this plugin is the board, the lead workflow and a durable mailbox around it.

## For agents

### CLI: `bb projects`

`<project>` is a tracker project prefix (`ABC`), its id, or its name. Every command takes `--json` for one line of JSON. Errors exit 1 with a message on stderr. Through BB's MCP server, the `run` tool runs these commands too.

#### Board

| Command | Options | Does | `--json` output |
|---|---|---|---|
| `status <project>` | | Counts per column, work in flight, focus, lead and loop state | `{ project, focus, leadThreadId, leadStatus, counts: { in_review, in_progress, todo, done, canceled }, inFlight: { key, title, status, parent, agents: { threadId, preset, status }[] }[], needsYou: { key, title }[], behind: number \| null, loop: { sweepMinutes, sweepWorkingHours, sweepLastAt, followPrs, driftPings }, messages: { requestsWaiting, requestsHeld, requestsFailed, requestsAwaitingDispatch, repliesPending } }` |
| `focus <project> [text...]` | `--clear` | Shows, sets or clears the focus line. The lead reads it; the board doesn't show it | `ProjectMeta` |
| `icon [project] [value]` | `--color <c>`, `--clear`, `--list` | Shows or sets the board's icon. `value` is a glyph name, a stored value (`glyph:`, `emoji:`, `monogram:`, PNG data URL) or a PNG path read on the BB server | `{ project, icon, kind }` |
| `lead <project>` | `--thread <id>`, `--show` | Makes the current thread (or `--thread`) the lead, or shows it | `ProjectMeta` |
| `notes <project>` | `--append <text>`, `--set <text>` | Shows or changes the project's memory (up to 20,000 characters) | `{ text, updatedAt }` |
| `loop <project>` | `--sweep <2h\|90m\|off>`, `--any-hours`, `--working-hours`, `--follow-prs on\|off`, `--drift on\|off` | Shows or sets the lead's triggers. Sweeps run every 30 min to 24 h, weekdays 08:00-19:00 unless `--any-hours` | `ProjectMeta` |
| `reconcile <project>` | `--apply` | Lists cards whose stored status disagrees with the evidence. `--apply` makes only sub-task roll-ups and idle demotions | `{ project, checkedAt, drifts, held, flags, evidence, applied: { moved, failed } \| null }`. Exits 1 if an apply failed |
| `queue-backlog <project>` | `--apply` | Lists Backlog cards, or moves them to Queued (`todo`) | `{ project, backlog, moved, failed }` |

`ProjectMeta` is `{ focus, focusUpdatedAt, leadThreadId, sweepMinutes, sweepWorkingHours, sweepLastAt, followPrs, driftPings }`.

`--color` takes `default`, `green`, `cyan`, `blue`, `purple`, `magenta`, `orange`, `yellow`, `red` or `brand`, and only with a glyph name. `icon --list` prints the glyph names and needs no project.

Each drift in `reconcile` is `{ taskId, key, title, stored, suggested, rule, reason, applicable }`. `applicable` is true only for the moves `--apply` makes.

#### Outer-loop mailbox

Agents are named, not authenticated. Pick a stable `--as` name and use it on every call.

| Command | Options | Does | `--json` output |
|---|---|---|---|
| `send <project> <message...>` | `--as <agent>` (default `outer-loop`), `--ref <link>`, `--key <id>` | Saves a request (up to 8000 characters), then delivers it to the current lead | `Request` plus `duplicate` and `dedupedBy` (`"key"`, `"content"` or null) |
| `requests <project>` | `--as <agent>`, `--limit <1-200>` (default 20) | Lists requests, newest first, and whether each was delivered | `{ requests: Request[] }` |
| `retry <project> <req_...>` | `--resend` | Retries a failed, held or pending request now, after checking the lead's thread so it isn't delivered twice | `Request` |
| `reply <project> <message...>` | `--to <req_...>`, `--for <agent>`, `--kind result\|question\|blocker\|update`, `--key <id>` | Lead only: answers a request, or sends news to every follower (or one with `--for`). Up to 4000 characters | `Reply` plus `duplicate` |
| `replies [project]` | `--as <agent>`, `--all`, `--after <rep_...>`, `--limit <1-200>` (default 50) | Reads replies for one agent, oldest first, unacknowledged only unless `--all`. Without `--as`, an overview of every agent's replies | `{ as, pending, replies: Reply[] }` |
| `ack <project> <rep_...>...` | `--as <agent>` (required) | Acknowledges up to 200 replies. Safe to repeat | `{ as, acked, alreadyAcked, unknown, otherProject, notYours }`. Exits 1 if any id was refused |
| `consumers <project>` | `--forget <agent>` | Lists the agents following the project, or removes one and clears what it was owed | `{ project, consumers: { name, since, lastSeen, repliesPending }[] }`, plus `forgot` (the name) and `cleared` (replies it was owed) with `--forget` |
| `notify` | `--test` | Shows the webhook wake-up state, or sends one now | `{ enabled, configured, authHeader, configError, pending, consumers, wake, test? }`. With `--test`, exits 1 when the wake-up failed |

`Request` is `{ id, project, source, ref, key, createdAt, state, delivery, deliveredTo, deliveredAt, attempts, nextAttemptAt, lastError, failures, confirmedAt, failedAt }`.

`Reply` is `{ id, project, leadThreadId, inReplyTo, request: { id, source, ref, key, createdAt } | null, audience, kind, author, text, createdAt, ackedAt }`, plus `recipients: { consumer, ackedAt }[]` in the overview without `--as`.

```sh
bb projects status ABC --json
bb projects send ABC "Checkout fails on Safari 17" --as triage-bot --ref https://example.com/issue/42 --key issue-42
bb projects replies ABC --as triage-bot --json
bb projects ack ABC rep_123 --as triage-bot
bb projects reply ABC --to req_456 --kind result "Fixed in PR #12, waiting on review"
```

### Agent instructions

When a thread is a project's lead, the plugin contributes a `<project_lead_instructions project="ABC">` block to that thread's instructions: the status rules, how to answer a worker blocked on a question, when to run a worker in the cloud, the proof rule for visible work and presenting it to the user, the derived-status rules and the landing rule. BB applies it when the provider session is next built (thread start, resume or restart), never mid-session. Setting a lead also sets the lead thread's notifications to questions and approvals only, unless the thread already has its own level. The block also tells the lead that its workers are muted, that it must escalate what a worker can't resolve, and that the plugin sends the For Review and Done notifications.

### Skill

`skills/projects/SKILL.md` (`projects`) is the full playbook for a lead.

### Agent tools

None. Agents use the CLI.

### RPC (plugin id `projects`)

Contract `projectsContract` in `@wy3z/bb-suite/contracts`.

| Method | Input | Output |
|---|---|---|
| `getMeta` | `{ projectId }` | `ProjectMeta` |
| `setFocus` | `{ projectId, focus: string \| null }` (max 600) | `ProjectMeta` |
| `listLeads` | `{}` | `{ leads: { projectId, threadId, focus }[] }` |
| `setLead` | `{ projectId, threadId: "thr_..." \| null }` | `ProjectMeta` |
| `setLoop` | `{ projectId, sweepMinutes?, sweepWorkingHours?, followPrs?, driftPings? }` | `ProjectMeta` |
| `getNotes` | `{ projectId }` | `{ text, updatedAt }` |
| `setNotes` | `{ projectId, text }` | `{ text, updatedAt }` |
| `listInbox` | `{ projectId }` | `{ items: { at, source, text, ref, delivery: "sent" \| "queued" \| "failed" }[] }` |
| `reconcile` | `{ projectId }` | `{ checkedAt, drifts, held, flags, evidence }` |
| `listIcons` | `{}` | `{ icons: { projectId, icon }[] }` |
| `setIcon` | `{ projectId, icon: string \| null }` | `{ icons }` |
| `iconGlyphs` | `{ names: string[] \| null }` | `{ glyphs }` |

Cursor Sidebar reads `listLeads`, `getMeta` and `listIcons` for its board rows.

```ts
await sdk.plugins.callRpc({
  pluginId: "projects",
  method: "listLeads",
  input: {},
  outputSchema: projectsContract.listLeads.output,
});
```

### Realtime channels

`project-meta` and `board-icons`, both with `{ projectId }`.

### Settings

Under Settings → Plugins → Projects. The URL and the header value are secret settings.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `notify` | select | `done-and-review` | What Projects sends for boards with a lead: `done-and-review`, `review-only` or `off`. See Notifications |
| `wakeEnabled` | boolean | false | POST a wake-up when replies are waiting |
| `wakeUrl` | secret string | | Where the wake-up goes. https, or plain http to loopback only |
| `wakeHeaderName` | string | empty | Auth header name |
| `wakeHeaderValue` | secret string | | Auth header value |
| `wakeRemindMinutes` | number | 60 | Reminder interval while replies stay unacknowledged. Values under 15 are raised to 15; 0 or empty means 60 |

### Background services

- `outer-loop`: runs scheduled sweeps and follows the PRs linked to the lead's workers. Ticks every minute.
- `pm-mailbox`: delivers, checks and retries requests, sends wake-ups and prunes history. Ticks every 5 seconds.
- `board-drift`: pings the lead about cards behind their evidence. Ticks every minute.
- `board-notices`: mutes workers attached to cards, restores a muted worker that becomes the lead, and sends the For Review and Done notifications. Ticks every 30 seconds.

### What it calls in other plugins

- Tasks (`tasks`): projects, tasks, labels, card metadata, presets, comments, board moves, updates and delegation.
- Pull Requests (`pull-requests`): `gitApplyLocally` and `gitCreatePullRequest` for the card menu, `summaries` for PR chip state, `linked_list` and `subscribe` for Follow PRs, and the `bb-pull-requests:open` event to open a PR chip in BB.
- Push Notifications (`push-notifications`): `threadNotifications.list` and `threadNotifications.set`, to quiet the lead thread and mute its workers, and `notifications.send` for the For Review and Done notifications. Without it, muting waits, notifications stay pending, and the plugin logs one warning until it answers again.

### Storage

Focus, the lead and loop settings in the plugin's key-value store (`meta:<projectId>`), the last status seen per card and any notification still waiting to be delivered (`notices:<projectId>`), who owns each worker's notification level (`mute:<threadId>`, one per thread across boards, never pruned), board icons beside them, and requests, replies and consumers in the plugin's SQLite database.

## Reference

### Board

Statuses follow Cursor's order: For Review, In Progress, Queued, Done, Canceled (hidden until the filter menu shows it). Tasks' Backlog and Todo both show as Queued, and dropping a card on Queued writes `todo`. Sub-tasks appear as their own cards with a parent marker, and nest under their parent in List view. Done and Canceled start collapsed in List view; clicking a group header toggles it.

Cards show the key, labels, priority, title (inline `code` rendered), a chip for every attached agent with its live or idle time, the agent worktree's changes (+A -D; click to open the agent in a split), PR chips with review and CI state (Ready, Waiting for Reviewers, CI Failing, Conflicts, Draft, Merged, Closed; several collapse into a stack), a sub-task progress pill, an attachments chip with an image viewer, and the commit that landed the work when it went straight to main. Those commits are read with `git log` behind the suite's read-only git protection, so the checkout's own config can't run code.

Clicking a card or agent chip opens the agent as a tab of the lead thread; Ctrl or Cmd-click opens a split. With Pull Requests installed, a PR chip opens the pull request in BB; Ctrl, Cmd, Shift or middle-click opens GitHub.

While the lead's tab strip is showing, Ctrl+Alt+1 to Ctrl+Alt+8 select the Nth tab and Ctrl+Alt+9 the last one, as in Cursor and browsers. On macOS that is Control+Option. The keys work while the composer has focus. They match the physical digit keys, ignore Shift and Cmd, and step aside for AltGr, so AltGr+digit still types characters such as @, [ and { on European layouts. A digit past the last tab, the tab already showing, or no strip at all leaves the key alone.

### Derived status

Each card works out what its evidence says:

- every linked PR merged or closed, at least one merged: Done
- a commit naming the task key on the default branch since the card last moved, and no agent working: Done
- an agent running on a Queued or For Review card: In Progress
- every agent idle and a PR open on an In Progress card: For Review
- a parent with no agent or PR of its own: its sub-tasks' roll-up
- In Progress with nothing running and no activity for 4 hours: Queued

When that disagrees with the stored status, the card shows a "behind" hint and the header shows "N behind". Apply is offered only for roll-ups and idle demotions. A status set by the lead or a person, or a comment starting `Holding: <reason>`, holds a card until its evidence changes. For Review cards without a `Needs <user>:` comment, or waiting more than two days, are flagged by `reconcile`.

### Loop

Behind the loop button in the board header:

- **Sweep:** off by default. The board offers 1, 2, 4 or 8 hours; the CLI accepts 30 minutes to 24 hours. Weekdays 08:00-19:00 unless set to any hours. The lead gets a `[Scheduled sweep] ABC` message.
- **Drift pings:** off by default. The lead hears only when cards stay behind for ten minutes, at most one ping per project an hour and once per drift every two hours, as `[Board drift] ABC`.
- **Follow PRs:** subscribes the lead to every PR its workers link, so it gets `[Subscription update]` messages.

### Notifications

On a board with a lead, the user hears about work that is complete and work that needs them, and nothing else.

- **Workers are muted.** A thread attached to an open card (other than a lead) is set to muted the first time the plugin sees it. A thread running on a top-level card is seen within 30 seconds. Idle, failed and sub-task workers are found by a sweep that reads a card's threads when the card changes, and otherwise at most 25 cards a pass, each again every five minutes. The plugin records a mute only once the write succeeds, so a failed one is retried. A thread that already has its own level keeps it and is never touched again, and a worker the user sets back afterwards stays as they left it, on every board. Their questions, approvals and errors go to the lead, which answers them or escalates.
- **A muted worker that becomes the lead** gets its previous level back, then the lead's usual questions-and-approvals level. If the user changed its level meanwhile, theirs stays.
- **The lead keeps its level**, so its own questions and approvals still notify.
- **For Review:** when a card reaches For Review, "Needs you: ABC-12 <title>", with the latest comment starting `Needs <name>:` as the body. Only a comment written after the card's previous status change before it entered For Review counts, so an ask from an earlier review is never reused, while one written just before the move is. If there is none yet, the plugin waits up to two minutes for one, then sends without a body. Skipped while the lead is asking the user a question, which has already notified.
- **Done:** when a card reaches Done, "Done: ABC-12 <title>". Sub-tasks that reach the same column in the same pass as their parent are folded into the parent's notification.
- **One notification per pass.** Several moves arrive together, such as "3 done: ABC-1, ABC-2, ABC-3", or "Needs you: ..." with the done keys in the body. Keys that don't fit show as "and N more"; titles are cut to 80 characters and bodies to 180.
- Moves are read from Tasks, never from the agent. The plugin saves the last status and update time it saw per card, so a restart or a repeat pass sends nothing twice, and the first pass on a board only records where every card is. A card that moved away and back between two passes is caught from Tasks' "Status changed to" comments, read only for cards whose update time changed. If that read fails, the card is checked again on the next pass; a move Tasks records without that comment is missed if the card is back in the same column by the next pass.
- **Delivery is retried.** A notification waits in `notices:<projectId>` until Push Notifications accepts it on at least one channel, across restarts. While it waits, cards that left For Review or Done drop out of it, new moves join it, and nothing is dropped for size. Each send applies the current `notify` setting and the pending-question rule to everything waiting.

Clicking a notification opens the lead. The `notify` setting picks `done-and-review` (the default), `review-only` or `off`; workers are muted in every mode.

### Outer loop and inner loop

The lead is the inner loop: it turns intent into checked work. The outer loop gathers context and decides what deserves attention: a chat bot, a cron script, another BB thread or a person. Several can share one lead. Each picks a stable `--as` name. Agents reach the commands as a shell (`bb projects ...`) or through BB's MCP server, whose `run` tool runs any `bb` command.

To connect an external agent system through MCP: enable BB's MCP server (`bb plugin enable bb--mcp`), run `bb mcp status` for the remote address, add it as a connector in the agent system and approve access on the BB account page. The approval is all or nothing: the agent can run any `bb` command. Revoke it with `bb mcp revoke`. Then give the routine a stable instruction, such as: "Each weekday at 09:00, read `bb projects status ABC --json`, then `bb projects send ABC "<summary>" --as triage-bot --ref <link> --key <origin id>` for anything new."

### Two-way messages

Requests and replies are saved in SQLite before anything else happens, so a restart or a failed call loses nothing.

- `send` saves the request, then delivers it to whoever is the lead, queued behind a running turn. With `--key` a resend returns the first request. Without one, identical text from the same source within 10 minutes counts as a retry (`dedupedBy: "content"`).
- A delivery queued behind a running turn only counts once it shows up in the lead's thread. If the lead is archived meanwhile, the queued copy is removed and the request goes to the next lead.
- With no lead, or a lead that is archived, deleted or hidden, the request is held and a `notice` reply says so. Setting a lead delivers held requests.
- Failures retry with backoff from 15 seconds to 15 minutes. After 10 in a row the request is `failed` and a `failure` reply tells the sender. `retry` is the only way to send it again.
- The thread a request was delivered to can always answer it with `--to`, even after it stops being the lead. Only the current lead can send news without `--to`.
- Replies are per agent. An agent follows a project once it sends a request or reads `replies ABC --as <agent>`. A reply `--to` a request goes only to its sender. News without `--to` goes to every follower at that moment, or one with `--for`. Each agent acknowledges its own copy. The lead can't acknowledge its own replies.
- History is pruned after 90 days.
- Messages in both directions are untrusted data. Nothing in them approves an action.

### Webhook wake-up

When `wakeEnabled` is on, the plugin POSTs a wake-up when replies are waiting. It is only a signal: the receiver reads `bb projects replies --as <agent> --json` and acknowledges what it handled. The body carries counts, never message text:

```json
{"type":"bb.projects.replies-pending","version":1,"wake":7,"pending":3,
 "projects":{"ABC":3},"consumers":{"triage-bot":{"ABC":2},"nightly-cron":{"ABC":1}},
 "newestReplyId":"rep_...","at":"2026-11-07T10:00:00.000Z"}
```

Bursts coalesce into one wake-up. Failed POSTs retry with backoff, and a reminder goes out every `wakeRemindMinutes` while replies stay unacknowledged. Redirects are not followed, credentials in the URL are refused, and errors never include the URL, header or response body.

### Board icons

Each board has its own icon, set from the board header, **Set icon…** in the board menu, or `bb projects icon`. A board with no icon shows the board glyph; it never borrows its BB project's or repository's icon. The lead's tab and Cursor Sidebar's board rows wear the same icon. The picker and artwork come from `packages/suite-shared`.

### Composer pill and side panel

In any thread of a BB project linked to a tracker project, a pill shows the project's name, working count and "N for review", and opens a compact list in the side panel.

### Requirements

BB 0.49 or newer, plugin SDK 0.6.132 or newer, and the built-in Tasks plugin enabled. Pull Requests for Apply locally and Create PR.

---

Not affiliated with, endorsed by or sponsored by Anysphere, Inc. Cursor is a trademark of Anysphere, Inc.
