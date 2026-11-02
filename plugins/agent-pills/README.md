# Agent Pills

Replaces the full-width boxes above BB's composer with small pills, and
restyles the composer to look like Cursor's and Zeron's.

## Pills

- **Subagents.** One pill for a thread's child threads, split by status in
  the style of Paseo's composer tracks: "1 needs input", "2 working",
  "1 failed", "1 ready to review". Click it to open a list above the pill;
  click a row to open that thread.
- **Background tasks.** The same for the thread's background agents and
  commands.
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
- **Parent thread and changed files.** BB's own segments are kept, but drawn
  as pills on the same row.

The pills for BB's own cards are hidden with CSS on their `aria-label`s:
Child threads, Background agents/commands/activity, Workflow(s), To-do list,
Model fallback, Machine status, Prompt mode, Goal, and Queued messages
(except while BB's inline editor is open). If a BB update renames them, the
old boxes come back next to the pills. "Thread history" is hidden only while
a pill row is on the page, so an archived thread keeps BB's own Unarchive
banner. While an approval or question is pending, BB swaps in its short
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
- **Hidden:** the dictation button, the send-options arrow, the collapse
  button and **New thread in this environment**. While a turn runs, the send
  circle shows a stop square.
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

BB 0.48.1 or newer, with plugin SDK 0.6.104 or newer. It uses the experimental
thread context segment slot.

## Install

```sh
bb plugin install path:/home/wyez/Projects/personal/bb-plugins/bb-plugin-agent-pills
bb plugin reload agent-pills
```

Turn it off with `bb plugin disable agent-pills`.

## Development

```sh
npm run typecheck
npm run build
bb plugin reload agent-pills
```
