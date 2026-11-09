Cursor Composer restyles BB's composer to look like Cursor's.
It also replaces the full-width cards above the composer with one row of pills for agents, changes, to-dos, the queue and more.
It adds no CLI commands or agent tools; agents see its work only through BB's own thread state.

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

### Realtime channel

`agent-pills:thread-updated`, payload `{ threadId }`. Published on thread timeline events, queue changes (queued, cancelled, dispatched), archive and unarchive.

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

The composer restyle and the pills setting live in this browser only. Keys: `bb-plugin-agent-pills.pills.v1` (pills on or off) and `bb-plugin-agent-pills.fallback-dismissed.v1` (model fallback dismissals per thread). The Desktop tab stores nothing: the view URL and this window's control id live in memory only.

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
