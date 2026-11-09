# Captions and alt text

One caption (for posts and articles) and one alt text (for screen readers) per file. Everything shown is from the demo workspace: invented projects, people, tasks and pull requests, with real agent turns.

## Videos for X

All four are H.264 MP4, 1920x1200, 30 fps, no audio, recorded from a headless Chromium with the CDP screencast and encoded with ffmpeg. Slow stretches are sped up; nothing is staged in between. Video 4 is the rough one: fast cuts, a human-paced cursor and burned-in captions.

| File | Length | Caption | Alt text |
|---|---|---|---|
| `x-video-1-sidebar-composer.mp4` | 28 s | Pick a project, pick a fresh worktree, type, send. The thread shows up in the sidebar while it works, and the Changes pill has its diff ready to commit. | A new thread is started from a Cursor-style composer in BB; it appears in the sidebar with a spinner, finishes, and its Changes tray opens with three files and Commit, Commit & Push and Create PR buttons. |
| `x-video-2-lead-fanout.mp4` | 36 s | I ask the lead to start three tasks. It starts two workers, asks me one question, and starts the third with my answer. The cards move, and PR chips appear as the workers open PRs. | A lead thread receives an instruction; the project board shows cards moving from Queued to In Progress with agent and PR chips; the lead asks a multiple-choice question, it is answered, and a third card moves. |
| `x-video-3-cloud-desktop.mp4` | 36 s | A cloud agent play-tests a small game on its own VM desktop. Then I take control. | A thread runs on a boat.dev VM; its desktop appears in a Desktop tab; the agent opens Chrome and plays a two-level game; the user presses Take Control and the tab says the agent's tools wait. |
| `x-video-4-opus-in-cursor.mp4` | 47 s | opus 5.5 in Cursor, well, a Cursor-style UI: Claude Code on my own Claude subscription, in a Cursor-style UI. Rough cut, captions burned in. | A quick screen recording with white-on-black captions: Opus 5.5 is picked in a Cursor-style composer, a task is sent and finishes, the Changes tray opens, a project board appears, and a cloud agent's desktop is shown before the user takes control. |

## Stills for X (16:9, framed)

| File | Caption | Alt text |
|---|---|---|
| `x-01-lead-hero.png` | One lead thread, its workers in the sidebar, and the files it just wrote. | BB with a Cursor-style sidebar listing a project board and its worker threads, a lead thread explaining why a PR shouldn't merge, a pill row reading Working 2, PRs 4, Listening 4, Changes +13, and a file tree on the right. |
| `x-02-board.png` | The board keeps itself honest: every card shows its agents, changes and PR checks. | A four-column project board (For Review, In Progress, Queued, Done) with cards showing labels, agent chips, change counts and PR chips reading Ready, CI Failing, Checks running and Draft. |
| `x-03-cloud-desktop.png` | A cloud agent narrates its play-test while its VM desktop shows the result. | A thread whose messages describe clicking through a game, beside a Desktop tab showing Chrome on a VM with the words "Beacon reached" and a Take Control button. |
| `x-04-needs-input.png` | The lead asks before it guesses, recommendation first. | A lead thread showing a question card with two options, "Card-shaped (Recommended)" and "One shimmer block", and a Submit answer button. |
| `x-05-pr-review.png` | Review the PR next to the thread that wrote it. | A pull request open in BB's side panel showing its title, branch, Squash and merge button, tabs for Description, Changes, Commits, Reviews and Checks, and the description. |
| `x-06-files-split.png` | A read-only file tree with Git status, and the file open beside it. | A right panel split in two: a file tree with added and modified markers, and a TypeScript file open in a code viewer. |

## README shots (`docs/media/`)

| File | Caption | Alt text |
|---|---|---|
| `suite-hero.png` | The whole suite in one window. | Same as `x-01-lead-hero.png`, unframed. |
| `cursor-sidebar-projects.png` | A board row with its workers, a pinned chat, and repositories with icons. | A sidebar with a Projects section listing a board and five worker threads, a Pinned section and a Repositories section. |
| `cursor-sidebar-view-menu.png` | Grouping, ordering, how many per group, what each row shows, and filters. | A dropdown menu over the sidebar with Grouping, Ordering, Threads per group, Show and filters for Status, PR, Age, Repository and Environment. |
| `cursor-sidebar-icon-picker.png` | Cursor's icon picker: ten colours, a few hundred glyphs, or your own PNG. | An icon picker with a search box, ten colour swatches and a grid of line icons. |
| `cursor-sidebar-hover-actions.png` | Hover a row to pin or archive it. | A sidebar row highlighted on hover with pin and archive buttons. |
| `cursor-sidebar-cloud-mark.png` | A cloud mark on threads that run on a VM. | A sidebar row with a small cloud icon beside the provider mark. |
| `agent-pills-composer.png` | One row of pills above a calm composer. | A prompt box with a typed draft, permission, model and reasoning as plain text, and pills reading Working 1, PRs 4, Listening 4 and Changes +13. |
| `agent-pills-agents-tray.png` | Who's working, who needs an answer. | A tray titled 2 Agents with Stop All, one row marked Needs input with an Answer button and one marked Working. |
| `agent-pills-changes-tray.png` | Commit, push or open a PR without leaving the thread. | A tray titled 3 Files listing two modified files and one untracked file with line counts, a commit message box, an Include 1 untracked file checkbox, and Commit, Commit & Push and Create PR buttons. |
| `agent-pills-parent-pill.png` | A worker always knows its lead. | A pill row reading Parent Lead the WEB board, PRs 1 and Changes +34 -1 above a composer. |
| `composer-environment-picker.png` | Cloud or This Computer, like Cursor. | An environment menu with Run on: Cloud and This Computer, and Worktrees: Worktree… and New Worktree. |
| `filetree-tree.png` | Git status on every changed file and folder. | A file tree with folders expanded, a plus marker on a new file, pencil markers on modified files and counts on their folders. |
| `filetree-split.png` | The tree in one pane, the file in the other. | A split right panel with a file tree and a TypeScript file. |
| `projects-board.png` | Cursor's five columns over BB Tasks. | Same as `x-02-board.png`, unframed. |
| `projects-card.png` | Cards up close. | Board cards with agent chips, change counts, attachment counts, PR chips (Ready, CI Failing, Checks running, Draft), a needs-input chip and a parent card with a sub-task pill and an Apply hint. |
| `projects-lead-panel.png` | The lead with its board in the side panel. | A lead thread beside a side panel listing the board's tasks by status with PR and agent chips. |
| `projects-lead-tabs.png` | Workers open as tabs of their lead. | A thread header with three tabs (the lead and two workers) and a worker's message, with a Parent pill above the composer. |
| `projects-lead-question.png` | The lead asks before it guesses. | Same as `x-04-needs-input.png`, unframed. |
| `projects-done-sorted.png` | Done, newest first. | The board's List view with For Review, In Progress, Queued and Done groups; Done items are struck through in completion order. |
| `pull-requests-board.png` | PRs grouped by what they need from you. | A Pull requests page for acme/web with Authored, Reviewing and All views, a search box, Needs you and Starred filters and groups for Needs attention, Awaiting review, Approved and Drafts. |
| `pull-requests-detail.png` | A PR beside the thread that wrote it. | Same as `x-05-pr-review.png`, unframed. |
| `pull-requests-thread-tray.png` | The PRs tray: Draft, CI Failing, Ready, and what the thread is listening to. | A tray titled 4 Open listing PRs with Waiting for Reviewers, Draft, CI Failing and Ready, above pills including Listening 4. |
| `desktop-take-control.png` | A cloud agent's desktop, one click from yours. | Same as `x-03-cloud-desktop.png`, unframed. |
| `ui-tweaks-settings.png` | Small switches for a calmer BB. | UI Tweaks settings with switches for animations, Clearer hierarchy, Steer labels and syntax highlighting, and selects for prompt position and height. |
| `ui-tweaks-icon-packs.png` | Four icon packs, live. | Cards for the BB Default, Lucide, Iconoir and Tabler Outline icon packs, and spinner options below. |
