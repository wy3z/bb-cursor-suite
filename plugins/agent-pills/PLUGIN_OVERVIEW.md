Cursor Composer restyles BB's composer to look like Cursor's.
It also replaces the full-width cards above the composer with one row of pills for agents, changes, to-dos, the queue and more.
It adds no CLI commands or agent tools; agents see its work only through BB's own thread state, plus the skill modes it attaches to messages.

## For agents

### CLI, agent tools and MCP

None. Everything the pills show comes from BB's own thread APIs, so agents read and change that state with BB's commands (`bb thread ...`), not through this plugin.

### RPC (plugin id `agent-pills`)

Used by the app. Every action returns `{ ok: boolean }`; a failure is reported as `ok: false`, never thrown.

| Method | Input | Output |
|---|---|---|
| `threadActivity` | `{ threadId, childThreadIds: string[] (max 50) }` | See below |
| `exitPlanMode` | `{ threadId }` | `{ ok }`. Cancels plan mode |
| `clearGoal` | `{ threadId }` | `{ ok }` |
| `sendQueued` | `{ threadId, queuedMessageId }` | `{ ok }`. Sends a queued message now |
| `deleteQueued` | `{ threadId, queuedMessageId }` | `{ ok }` |
| `unarchive` | `{ threadId }` | `{ ok }` |
| `restoreEnvironment` | `{ threadId }` | `{ ok }` |
| `resumeHost` | `{ threadId, hostId }` | `{ ok }`. Resumes a paused cloud machine |
| `listModes` | `{ projectId, environmentId, providerId, excludeUserSkills }` | `{ modes: { skillId, label, description, path, scope, icon, color, styled, mode }[] }`. Mode-flagged skills first. Answers from cache and refreshes in the background |
| `threadMode` | `{ threadId }` | `{ state: { draft, rev, notice }, projectId, environmentId, providerId }` |
| `setThreadMode` | `{ threadId, mode: { skillId, label } \| null, rev }` | `{ ok, state }`. Sets the thread's mode; `ok: false` when `rev` is stale |
| `clearModeNotice` | `{ threadId }` | `{ ok }` |

`threadActivity` returns:

```ts
{
  tasks: { id, itemId, description, taskType, model, status, taskStatus, startedAt, workflowName }[],
  models: { threadId, model: string | null }[],
  workflows: { id, name, startedAt, agentsDone, agentsTotal }[],
  plan: { prompt } | null,
  goal: { objective, status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited", timeUsedSeconds, tokensUsed, tokenBudget } | null,
  todos: { items: { id, text, status: "completed" | "in_progress" | "pending" }[] } | null,
  modelFallback: { message, originalModel, fallbackModel, sourceSeq } | null,
  queue: { id, preview, state }[],
  thread: { archived, workspaceGone, environmentId },
  machine: { hostId, phase: "suspended" | "suspending" | "resuming" } | null,
}
```

A deleted thread or an unreachable host returns empty lists and nulls rather than an error.

```ts
await sdk.plugins.callRpc({
  pluginId: "agent-pills",
  method: "clearGoal",
  input: { threadId: "thr_..." },
  outputSchema: z.object({ ok: z.boolean() }),
});
```

### Realtime channels

- `agent-pills:thread-updated`, payload `{ threadId }`. Published on thread timeline events, queue changes (queued, cancelled, dispatched), archive and unarchive.
- `agent-pills:mode-updated`, payload `{ threadId }`. Published when a thread's mode or notice changes.
- `agent-pills:modes-updated`, payload `{ projectId }`. Published when a background frontmatter scan changed the skill list.

### Mention provider and dispatch hook

- Mention provider `mode` (trigger `~`, never listed in the menu). The app inserts its pill. BB calls `resolve` when it sends the message, and it returns the mode line plus the SKILL.md as agent-only context.
- `message.dispatch` hook. Records which thread each mode pill is being delivered to, binds a first-message pill to the created thread, hands a new-thread choice over, and notes a title to fix. It proceeds, except for the one message that needs the exit note: that one waits a moment while the note is added (below).

### Plugin storage

`bb.storage.kv`:

- `draft:<threadId>`: `{ draft, rev }`, the thread's mode. Kept once set, so a None chosen for a new thread survives its first message.
- `notice:<threadId>`: the missing-skill toast text, until shown.
- `pill:<nonce>`: the thread a first-message pill was sent to.
- `exit:<threadId>`: set when a thread goes from a mode to None (or its skill went missing), until the next message carries the exit note.
- `frontmatter:v1`: icon, color, description and `mode` per skill, so the menu opens warm after a restart.

### What it calls in other plugins

- Pull Requests (`pull-requests`): `gitCommit`, `gitPush`, `gitCreatePullRequest` and `gitApplyLocally`, the git actions behind the Changes tray and Apply locally. The contract is `gitActionsContract` in `@wy3z/bb-suite/contracts`. Without Pull Requests installed and enabled, those buttons are disabled and say "Needs Pull Requests".
- BB's git plugin (`bb--git`): `status`, for the Changes pill, and its Diff tab.
- A desktop vendor, for the Desktop pill and tab. This is the plugin `DESKTOP_PROVIDERS` in `@wy3z/bb-suite/desktop` names for the thread's machine provider; today that's `machine-boat` for `boat-sandbox`.
  - It calls the vendor's `/desktop/status`, `/desktop/view` and `/desktop/control` routes with a same-origin `fetch`, not RPC. The vendor answers only requests from BB's own page, which other plugins' frontends share.
  - When that plugin isn't installed and enabled, or answers with an error, the pill and tab stay hidden and nothing is reported.
  - The registry is compiled into this plugin, so a new vendor needs a new release of it.
- BB's SDK, for the Desktop pill and tab: `environments.get` and `hosts.get`, to find the thread's machine provider.
- BB's SDK, for the environment picker:
  - `environments.listProviders({ projectId })`
  - `environments.list({ projectId, environmentProviderId: "git-worktree", hostId, status: "ready" })`
  - `hosts.list()`
  - `system.config()`

### Browser storage

The composer restyle and the pills setting live in this browser only. Keys: `bb-plugin-agent-pills.pills.v1` (pills on or off) and `bb-plugin-agent-pills.fallback-dismissed.v1` (model fallback dismissals per thread). The Mode menu setting is `bb-plugin-agent-pills.mode-menu.v1`. A mode picked in the new-thread composer sits in session storage under `bb-plugin-agent-pills.new-thread-mode.v1:<composer key>` until that thread is sent. The last known mode per thread (`bb-plugin-agent-pills.thread-mode.v1:<threadId>`) and skill list per workspace (`bb-plugin-agent-pills.modes.v1:<key>`) are cached in local storage. The Desktop tab stores nothing: the view URL and this window's control id live in memory only.

## Reference

### Composer

- **Layout.** Paperclip on the left, then permission mode, model and reasoning level as plain text, and a round send button. The restyle targets BB's `data-promptbox-*` attributes, not its Tailwind classes.
- **Growing.** Once the draft wraps or has an attachment, the text takes the full width and the controls move to a bottom row. It returns to one row when the draft is empty.
- **Hidden:** the dictation button, the collapse button and **New thread in this environment**. BB's send options menu (Save draft, Send later and plugins' send items) opens by right-clicking the send button. The button dims while the draft is empty and shows a stop square while a turn runs.
- **Prompt height.** UI Tweaks' One line and Two lines settings win. When `data-bb-ui-prompt-height` is set, the composer drops its own 48 px floor.
- **Under the box:** the project and environment on the left, the context ring and percentage on the right.
- **Environment picker (new threads).** BB's Environment button under the box is replaced with Cursor's picker. The trigger shows the location's icon and name ("This Computer", "New Worktree", "Worktree: <branch>", "Cloud", or another provider's name). Its menu has two sections:
  - **Run on:** **Cloud**, then **This Computer**.
  - **Worktrees:** existing worktrees for the project on this computer, newest first. Three or fewer are listed inline; with more, a **Worktree...** submenu holds them. It opens to the right, flips left when there's no room, and on a phone-width screen expands in place instead. Then **New Worktree**, then any other local environment provider (Btrfs Cow, for example).
- **Cloud.** It lists every environment provider whose `machineProviderId` is set. With several, each gets its own Cloud row named after the provider. With none installed, Cloud is greyed out with "Install a cloud machine plugin to run agents in the cloud." When one is installed but the project's provider list leaves it out, the message is "Cloud isn't available for this project." A single provider that needs setup, or is unavailable, shows its own message. Each message is followed by a Learn more link to the suite README's [Cloud agents](../../README.md#cloud-agents) section, and both the greyed-out row and the link point at it with `aria-describedby`.
- **Selecting.** A choice is applied through `useComposer().setSelection({ environment })`, so BB's own state, its branch picker and the send stay in charge. Choosing Cloud starts nothing; the machine is created when the thread is sent.
- **Fallback.** The picker only replaces BB's button when all of these hold:
  - It finds exactly one `button[aria-label="Environment"][data-promptbox-shrinkable-control]` next to the single project control in the new-thread footer.
  - At most one machine is connected (`hosts.list`, status `connected`).
  - The selected host is BB's primary host (`system.config().primaryHostId`), or the selection names no host.

  Otherwise nothing is hidden: the picker moves into the box's action row and both pickers show. A remote host is labelled with its machine name rather than "This Computer". Projectless threads keep BB's picker. While the provider list loads, BB's button is hidden and the slot stays empty, so it doesn't flicker. If loading fails or takes longer than five seconds, BB's button comes back.
- **Open in editor on cloud threads.** On a thread whose machine has a machine provider (`machineProviderId` set), BB's "Open workspace in <editor>" button in the thread header is hidden, because the workspace isn't on this computer. Local threads keep it. It is hidden only when all of these hold, and reappears the moment one stops holding:
  - A hidden anchor in the thread's own primary composer sits in a `[data-split-pane-id]` pane with exactly one primary composer and exactly one `[data-thread-header-workflow-actions]` header.
  - That pane has exactly one button labelled "Open workspace in <name>" and one labelled "Choose another app to open workspace", inside a single `[data-thread-header-responsive-action]` that is a direct child of the header and holds just those two buttons.
  - The thread, environment and host lookups all succeed. A failed lookup leaves the button alone and retries every 5 seconds.

  BB re-renders the header often, so a mutation observer on the pane re-checks whenever the header or a composer changes.
- **The "..." menu on cloud threads.** On narrow screens BB moves the same "Open workspace in <name>" entries into the thread's "..." menu (a bottom drawer, or a dropdown for a narrow split pane). They're hidden, with one separator next to them, only when all of these hold:
  - The pane above matches, and the document has exactly one open `button[aria-label="Thread actions"]`, inside that pane's header.
  - Exactly one open surface belongs to it: a drawer titled "Thread actions", or a `role="menu"` labelled by the trigger.
  - Every "Open workspace in <name>" item with a FolderOpen icon sits in one unbroken run, with only a separator or the menu's edge on each side.

  While that menu is open, the watcher also observes the page body, where BB portals it. The anchor is a thread-scope composer action; BB shows at most three plugins' composer actions inline, and today only this plugin adds any.
- **Keyboard.** Arrow Down or Up on the trigger opens the menu. Tab closes the menu and its submenu together. The **Worktree...** row names its submenu with `aria-controls`.
- **Surface.** Opaque, like Cursor's: the theme's foreground at 6% over its background, a 1 px outline at 8% (12% with focus), no blur. The transcript fades out just above the box.
- **Touch screens.** Controls keep a 28 px line. The unfocused phone box drops the paperclip's gap and truncates long model names.

It restyles BB's composer rather than replacing it, so it is not listed under **Settings → Appearance → Composer** and BB's composer fixes keep arriving.

### Skill modes

Cursor 3.30's custom modes: any skill becomes a thread's mode and stays in context until the user exits or switches.

- **Starting a mode.** In BB's `/` or `$` skill menu, highlight a skill and press Alt+Enter (Option+Enter on a Mac) instead of Enter. That skill becomes the thread's mode in one press: the typed trigger (such as `$rev`) is replaced, and if any other text is left in the draft it is sent as the first message in that mode; if nothing else is left, the mode just switches and nothing is sent. Alt+Enter on a skill already picked into the draft does the same. Plain Enter in the menu still inserts the skill as a one-off use. Works in the thread and new-thread composers.
  - How: the plugin can't see which row BB's menu highlights (the SDK only exposes the menu to full composer replacements, and the menu has no `aria-selected` or similar). BB's menu already inserts the highlighted skill on Alt+Enter just as on Enter, so when `[data-promptbox-typeahead-menu]` is open the plugin lets BB insert it, then takes the newly inserted skill from the draft and turns it into the mode. BB binds nothing to Alt+Enter otherwise; without a picked skill it still sends like Enter.
- **Mode pill above the composer.** The active mode shows in the pill row above the composer (a thread context segment; a bare composer banner on the new-thread screen), tinted with the skill's colour, with its icon, name and an x. Clicking it leaves the mode. It shows whether or not the Agent pills setting is on, since it replaces none of BB's cards.
- **Shift+Tab** in the prompt box cycles None and the skills marked `mode: true`. With none flagged and no mode on, Shift+Tab is left alone. BB 0.49 binds nothing to it.
- **Mode menu (off by default).** **Settings → Plugins → Cursor Composer → Mode menu** adds a Mode menu to the composer's toolbar. It lists **None**, then **Modes** (skills with `mode: true` in frontmatter), then every other skill: project skills, then user skills, then plugin skills, one per name, preferring the thread's provider. More than eight shows a search box. The list opens from cache and refreshes on open and when a background scan finds changes. Kept in this browser only.
- **Badge style.** Frontmatter `icon:` takes one of BB's built-in icon names (`Eye`, `Bug`, `Beaker`, `GitBranch`, …) or a lowercase alias for the common ones (`eye`, `bug`, `book`, `map`, `shield`, `terminal`, …), defaulting to `Zap`. The same icon shows in the menu, the composer pill and the sent message. `color:` takes `default`, `green`, `cyan`, `blue`, `purple`, `magenta`, `orange`, `yellow`, `red` or `brand`.
- **Which skills a thread can use.** A thread's menu lists skills from its own environment, so a cloud thread sees what its VM can load. In the new-thread composer, choosing a new cloud machine or another host leaves out this computer's own provider and shared user skills, and keeps BB's user skills (`~/.bb/skills`, which BB ships to the machine), project skills and plugin skills. When a host lists a skill under another id, it is matched by name.
- **What the agent gets.** Every message sent while a mode is on carries a small mode pill at the start of its text (added once the draft has text). When BB sends it, the pill resolves to agent-only context: one fixed line, then the SKILL.md body.
  - "You are in <label> mode. Follow that mode's skill on this turn. Do not drop it because the request looks small or you already have context. Do not drift back to default agent behavior. If you cannot state the mode's hard rules, read "<path>" before acting."
  - Each message describes itself, so queued, retried, steered or reordered messages and second tabs all get exactly what their own pill says.
- **Leaving a mode.** After a thread goes from a mode to None, the next message the user sends carries one agent-only line, with nothing in the draft or the sent bubble: "No custom mode is active. Stop following earlier mode instructions." Only that one message; later messages carry nothing, and picking a mode again before sending cancels it. It is a plain statement, not a tracked transition.
  - How: the dispatch hook answers `wait` for that message, which queues it; the plugin appends the agent-only line to the queued row (`queuedMessages.update`), then calls `experimental_hooks.recheck`, and the hook lets the noted row through. In the demo the round trip took 71 ms. A message from an agent or BB itself never gets the note.
- **Fresh reads.** The skill is read on every message, from the thread the message is actually being delivered to (recorded by the dispatch hook), falling back to the pill's own thread for sends that skip the hook. When it has gone (renamed or removed), the message goes without it and a toast says "'<label>' mode couldn't be applied — its skill file may have been renamed or removed. Message sent without it." The thread's mode is cleared only if it is still the mode and revision that message was sent under.
- **Opening a thread.** The last known state from this browser is shown while the composer asks the server, but only for display. Until the server answers and the draft's pill matches, Enter and the send button do nothing. Typing stays open: locking the box would blur it, and on a phone that collapses the composer.
- **Picking quickly.** Choices are coalesced: one write is in flight at a time, and the latest choice is written against the revision the server returned. After three conflicts with another tab, the server's state wins.
- **New threads.** A mode picked in the new-thread composer travels in the first message's pill, and becomes the thread's mode unless a None was already chosen for it. BB resolves that first message before the thread exists, against the project's source. The dispatch hook binds the pill to the created thread, so any later resolution of it, such as a retry, reads from that thread's environment once ready.
- **Titles.** The pill's label is part of the message text, so BB's fallback title would start with it. When the first turn settles (or after 20 seconds), a thread that is still untitled and whose fallback is exactly the one recorded at dispatch gets the user's own words as its title. Any title set by BB or by hand is left alone. BB's thread update has no compare-and-set, so a rename in the moment between the read and the write can still be overwritten.
- **Why a pill, not instructions.** `bb.agents.contributeInstructions` only reaches a provider session when the session is built ("BB never hot-mutates a running session"), so it can't enter or leave a mode mid-thread. A plugin mention is the only per-message channel.

### Pills

- **Agents.** A chip reading "Agents", or "Working 2" with a glowing orb while child threads or background tasks run. It opens a tray headed "N Agents" ("N Tasks" once a background command is in it). Running and waiting items come first, finished ones under "Recent" (five, then "More"). Rows show the status glyph, title, a description with the model, and elapsed time. On child-thread rows, hover swaps the time for × (stop a running one, mark a finished one read). Background tasks are read-only. An Answer button appears when a child waits on you. The header has Stop All (click twice) or Clear All. Ctrl or Alt-click opens a split.
- **Workflow.** "name · 3/5 agents" for one running workflow, "2 workflows" for several.
- **Plan mode.** Shows the plan prompt and an "Exit plan mode" button.
- **Goal.** "Goal · 12m", or "Goal paused / blocked / usage limited" in a warning tone, with the objective, elapsed time, tokens and "Clear goal".
- **To-dos.** "3/7 to-dos", with each step and a status dot.
- **Model fallback.** A warning-toned "Model fallback" with "Dismiss", remembered per thread in this browser.
- **Queue.** "2 queued", with "Send now" and "Delete" per message. **Edit or reorder** brings BB's own queue box back until the queue is empty.
- **Archived / Workspace removed.** Offers "Unarchive" or "Restore workspace".
- **Machine.** "Machine paused" or "Machine resuming…" for cloud machines, with "Resume".
- **Changes.** "Changes +18 -2" for the checkout's uncommitted changes, or the branch against its merge base when the tree is clean. The tray lists each file with its status and line counts; a file opens in BB's preview, and the diff button selects BB's Diff tab. Under the files: a message box (empty means BB's generated message; Ctrl+Enter commits, Ctrl+Shift+Enter commits and pushes), then **Commit**, **Commit & Push** and **Create PR**. A clean tree offers **Push** and **Create PR**. Commits stage tracked files only, unless you tick **Include N untracked files**. While untracked files are left out, a generated-message commit is refused, because BB's commit could sweep them in. Create PR commits if needed, pushes, and runs `gh pr create --fill` against the environment's base branch, or returns the pull request already open. These run from the Pull Requests plugin's backend, so they only work for environments on the BB server's own machine.
- **Apply locally.** On hover, a child thread in its own worktree gets a download button in the Agents tray. It copies everything the worktree has against the parent's checkout (commits, uncommitted and untracked files, binaries) into the parent's checkout as uncommitted changes, and refuses rather than half-applying.
- **Compact before sending.** BB's "Compact 120k / Keep history" toggle moves into the pill row. The pill mirrors and clicks BB's hidden button, so BB still owns the state.
- **Parent thread.** "Parent Plan the launch" (or "Forked from …") on a child or forked thread; click it to open the parent. BB draws its own segment as an icon-only toggle over a "This thread is a child of" box whenever another segment shares the row, so the plugin draws this pill instead and hides BB's toggle and box.

While the pills are on, BB's own cards are hidden with CSS on their `aria-label`s: Child threads, Background agents/commands/activity, Workflow(s), To-do list, Model fallback, Machine status, Prompt mode, Goal and Queued messages. If a BB update renames them, the old cards come back beside the pills. While an approval or question is pending, BB shows its short composer stack and the pill row is absent.

### Desktop

The thread's computer, the way Cursor shows a cloud agent's desktop.

- **Desktop pill.** In the pill row above the composer, for a thread whose machine has a desktop provider and whose desktop is running or starting. It opens the Desktop tab. While you hold control it reads "Desktop, you have control" and shows a dot. It doesn't depend on the Agent pills setting, because it replaces none of BB's cards.
- **Desktop tab.** A fixed tab in the thread's right-hand panel, named Desktop with a cloud computer icon, shown only for threads on a machine with a desktop provider. It shows the live stream at the panel's full width in a 16:9 frame at the top, with a 1 px border in BB's `--border` colour and BB's `--radius` corners. The area inside the border is exactly 16:9, so the stream page never letterboxes and a click lands on the VM pixel under the pointer. A panel shorter than the frame scrolls. A paused machine, a starting desktop or a machine without one shows a plain message with Check again.
- **View-only by default.**
  - The stream is `inert` until you take control, so clicks and keys can't reach it by accident.
  - The bar says who has control: "Agent has control", "You have control", or "You have control in another window".
  - A vendor whose stream takes no input shows "View only" and no Take Control.
- **Take Control / Release control.**
  - Take Control (in the bar; there is no second button over the stream) asks the vendor to pause the agent's computer tools, then focuses the stream so your mouse and keyboard go to the VM.
  - The agent's computer calls wait until you release, and the tab says so. If there was nothing to pause, it says the agent can still use the desktop.
  - When you release, every agent on that machine with a turn running is told to take a fresh screenshot before acting.
- **When control ends.**
  - The window renews control every 30 seconds, but not once the page has been hidden for 30 seconds, so a forgotten background tab hands control back within about 2 minutes.
  - A hold lasts at most 30 minutes, then goes back to the agent; take control again to carry on.
  - Closing the tab, switching to another thread or another tab releases it.
  - Taking control in a second window moves it there. The first window says "You took control in another window" and can take it back.
- **The frame.**
  - It is sandboxed (`allow-scripts allow-same-origin allow-pointer-lock`), so the stream can't navigate BB's page or open windows.
  - It gets `autoplay`, `fullscreen`, `keyboard-map` and `pointer-lock`, and no clipboard access.
- **The URL.**
  - The frame has no `src`: it's navigated with `location.replace`, so the token-bearing URL never sits in BB's DOM or in React state.
  - A fresh URL is fetched each time the tab opens and with Reconnect. A URL that was never opened in time is replaced, and so is one that expired while the page was hidden for 30 seconds or more.
  - Nothing is persisted.
- **The bar is the only control.** Status, Take Control or Release control, and Reconnect. There is no full-screen button: BB's panel expands instead. On a fine pointer the vendor's own viewer overlay is turned off where it can be (boat: `overlay=0`). On a touch screen (`pointer: coarse`) the tab asks for the vendor's touch viewer instead, so boat keeps its overlay and its on-screen keyboard button.
- **Phone width.** The bar wraps and the buttons grow to 32 px.

### Requirements

BB 0.49 or newer, with plugin SDK 0.6.132 or newer.

---

Not affiliated with, endorsed by or sponsored by Anysphere, Inc. Cursor is a trademark of Anysphere, Inc.
