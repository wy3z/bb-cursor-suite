# Agent Pills

Replaces the full-width boxes above BB's composer with small pills, and
restyles the composer to look like Cursor's and Zeron's.

## Pills

The Agents and Changes chips, and the Pull Requests and Subscriptions
plugins' chips, share one Cursor tray style from `app.css` (`__tray-*`): a
muted "N Things" header with a minimise button, one-line rows whose time or
status swaps for actions on hover, five rows then "More".

- **Agents.** After Cursor's agent tray: a chip reading "Agents", or
  "Working 2" with a glowing orb while child threads or background tasks run,
  opens a tray headed "N Agents" ("N Tasks" once a background command is in
  it). Child threads and the thread's background agents and commands share
  the tray. Running and waiting items come first, finished ones under
  "Recent" (five, then "More"). Rows show bb's status glyph (the orb while
  running), the title, a description ("Working", "Needs input", with the
  model) and elapsed time. On child-thread rows, hover swaps the time for ×
  (stop a running one, mark a finished one read); background tasks have no
  stop in the SDK, so their rows are read-only. An Answer button appears when
  a child waits on you. The header has Stop All (click twice to confirm) or
  Clear All, both for child threads. Ctrl or Alt-click opens a split.
- **Workflow.** "name · 3/5 agents" for one running workflow, "2 workflows"
  for several; the popover lists each with its agent count and elapsed time.
- **Plan mode.** "Plan mode"; the popover shows the plan prompt and an
  "Exit plan mode" button.
- **Goal.** "Goal · 12m", or "Goal paused / blocked / usage limited" in a
  warning tone; the popover shows the objective, elapsed time and tokens,
  plus "Clear goal".
- **To-dos.** "3/7 to-dos" (done of total); the popover lists each step with
  a status dot.
- **Model fallback.** A warning-toned "Model fallback"; the popover explains
  the fallback and offers "Dismiss" (remembered per thread in this browser).
- **Queue.** "2 queued"; each row previews the message and offers
  "Send now" and "Delete". **Edit or reorder** brings BB's own queue box back
  until the queue is empty.
- **Archived / Workspace removed.** Offers "Unarchive" or "Restore
  workspace" where the composer still exists.
- **Machine.** "Machine paused" / "Machine resuming…" for cloud machines,
  with a "Resume" button.
- **Changes.** "Changes +18 -2", after Cursor's review-changes pill, for the
  checkout's uncommitted changes, or the branch's changes against its merge
  base when the tree is clean; the tray lists each file with its status and
  line counts. Clicking a file opens it in BB's file preview, and the tray's
  diff button selects BB's Diff tab (falling back to its Ctrl/Cmd+D
  shortcut). Under the files, a commit bar: a message box
  (leave it empty for BB's generated message; Ctrl+Enter commits,
  Ctrl+Shift+Enter commits and pushes), then **Commit**, **Commit & Push**
  and **Create PR**. With a clean tree it offers **Push** and **Create PR**.
  Commits stage tracked files only. Untracked files go in only when you tick
  **Include N untracked files**; while untracked files are left out, a
  generated-message commit is refused (BB's commit could sweep them in), so
  the box asks for a typed message.
  Create PR commits first if needed, pushes the branch and runs
  `gh pr create --fill` against the environment's base branch, or returns the
  pull request already open for the branch. Progress and the result show
  under the buttons. These run git and `gh` from the plugin's backend, so they
  only work for environments on the BB server's own machine.
- **Apply locally.** A child thread in its own worktree gets a download
  button on hover in the Agents tray. It copies everything the worktree has
  against the parent's checkout (commits, uncommitted and untracked files,
  binaries) into the parent's checkout as uncommitted changes. It refuses
  rather than half-applying when the patch doesn't apply cleanly. Plugins can't open another plugin's tab at a file, so the diff
  starts at the top. BB's own changed-files
  segment only appears for worktree environments (segments get no environment
  for project checkouts), so this reads the same status from BB's git plugin
  by the thread's environment id, and BB's segment is hidden.
- **Compact before sending.** BB's "Compact 120k / Keep history" toggle,
  shown when the prompt cache has expired, moves out of the prompt box into
  the pill row. It keeps BB's warning colour while compacting is on. The pill
  mirrors BB's hidden button and clicks it, so BB still owns the state. The
  touch-screen version (an icon with a menu) is left in the box.
- **Parent thread.** BB's own segment is kept, but drawn as a pill on the
  same row.

The pills for BB's own cards are hidden with CSS on their `aria-label`s:
Child threads, Background agents/commands/activity, Workflow(s), To-do list,
Model fallback, Machine status, Prompt mode, Goal, and Queued messages
(except while BB's inline editor is open). If a BB update renames them, the
old boxes come back next to the pills. "Thread history" is hidden only in a
thread pane whose pill row carries the Archived or Workspace removed pill, so
an archived thread keeps BB's own Unarchive banner and another split pane is
left alone. While an approval or question is pending, BB swaps in its short
composer stack: the child-thread, plan and goal boxes are shown again and the
pill row is absent.

## Composer

The prompt box becomes a rounded row in the style of Cursor and Zeron: the
paperclip on the left, then the permission mode, model and reasoning level as
plain text, and a round send button. The restyle selects BB's
`data-promptbox-*` attributes, not its Tailwind classes.

- **Growing.** Once the draft wraps or has an attachment, the text takes the
  full width and the paperclip and controls move to a bottom row. It returns
  to one row when the draft is empty. Attachments sit between the text and
  the controls.
- **Hidden:** the dictation button, the collapse button and **New thread in
  this environment**. BB's Send options menu (Save draft, Send later, and any
  plugin's send items) opens by right-clicking the send circle; its chevron
  is hidden.
  The circle is drawn with an inset box-shadow, because BB's composer forces
  its buttons transparent with a layered `!important` utility. It dims while
  the draft is empty, and shows a stop square while a turn runs.
- **Prompt height.** UI Tweaks' One line and Two lines settings win: when
  `data-bb-ui-prompt-height` is set, the composer drops its own 48px floor and
  taller block padding, leaving the height to UI Tweaks. Without it, the
  original Cursor-sized box is unchanged.
- **Under the box:** the project and environment on the left, and the
  context ring and percentage on the right.
- **Glass.** The box and the pills share the theme's `--border` outline and a
  translucent fill: `--background` at 60% in light themes and `--popover` at
  45% in dark ones, with the same `blur(28px) saturate(160%)` as dark-theme
  popovers. The opaque strip under the box is removed, and the transcript fades
  out towards the bottom of the window behind it. A theme that hides the
  transcript's top edge with `mask-image` blocks the blur, so the plugin swaps
  that mask for an overlay of the same 40px fade.
- **Touch screens.** Controls keep the 28px line instead of BB's 40-44px touch
  sizes. The unfocused phone box (BB's compact mode) drops the paperclip's
  gap, the placeholder stays on one line, and long model names truncate.

Turn the restyle off under **Settings → Plugins → Agent Pills → Composer**.
The pills stay either way.

It is a restyle, not a replacement composer, so it is not listed under
**Settings → Appearance → Composer**. A replacement would have to redraw BB's
whole editor and would stop picking up BB's composer fixes.

## Requirements

BB 0.49 or newer, with plugin SDK 0.6.132 or newer. It uses the experimental
thread context segment slot.

## Install

```sh
bb marketplace add git:github.com/wy3z/bb-cursor-suite@main --subdirectory marketplace
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.1.0 --plugin agent-pills --tag-prefix agent-pills/
```

Turn it off with `bb plugin disable agent-pills`.

## Development

```sh
npm run typecheck
npm run build
bb plugin reload agent-pills
```

## License

MIT, see [LICENSE](LICENSE).
