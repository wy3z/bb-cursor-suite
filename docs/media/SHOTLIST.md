# Shot list

Every screenshot the READMEs and the launch posts use. BCS-86 and BCS-87 captured them in a throwaway BB with fake data: invented projects (`acme/web`, `acme/api` and the `orbit` game, published as [wy3z/orbit](https://github.com/wy3z/orbit)), people, tasks and pull requests, with real agent turns. Plugin READMEs embed them with absolute `https://raw.githubusercontent.com/wy3z/bb-cursor-suite/main/docs/media/<name>.png` URLs, the root README with a relative path. Captions and alt text for every file are in [docs/launch/captions.md](../launch/captions.md).

When you replace a shot, keep the fake data: no real thread titles, client names, customer data, tokens, hostnames or emails. Run OCR over the new file and read what it found before committing it.

Common rules:

- PNG, BB's default light theme and default palette, 2x scale (a 1600x1000 window), no browser chrome or OS menu bar.
- Crop to the surface named. Leave a little of BB around it so the reader can tell where it lives.
- Use the plugin's defaults unless the shot says otherwise.
- Save each file under `docs/media/` with the exact name below.

| File | Used in | What it must show |
|---|---|---|
| `suite-hero.png` | `README.md` | One BB window with the whole suite on: Cursor Sidebar on the left in Projects grouping, a thread in the middle with the Cursor Composer and its pill row (Agents, Changes, PRs), and the right panel open on the Files tab. At least one chat working, one needing input. |
| `cursor-sidebar-projects.png` | `plugins/cursor-sidebar/README.md` | The sidebar in Projects grouping: the toolbar (project switcher, view menu button), a Pinned block, two or three projects with icons, a parent chat with child chats under it, the accent pill counting working children, and a Chats section with standalone chats. |
| `cursor-sidebar-view-menu.png` | `plugins/cursor-sidebar/README.md` | The view menu open over the sidebar, showing Grouping, Ordering, Threads per group, Show and the Filters entry. |
| `cursor-sidebar-icon-picker.png` | `plugins/cursor-sidebar/README.md` | The project icon picker anchored to a project heading: search box, the ten colour swatches, the icon grid with one glyph selected, and the image button. |
| `agent-pills-composer.png` | `plugins/agent-pills/README.md` | A thread's composer with a short draft: paperclip, permission mode, model and reasoning as plain text, the round send button, the project and environment under the box and the context ring on the right. A row of pills above it (Agents working, a to-do count, Changes). |
| `agent-pills-agents-tray.png` | `plugins/agent-pills/README.md` | The Agents tray open: the "N Agents" header with Stop All, two running child threads with orbs and elapsed time, one waiting on input with its Answer button, and a Recent group with finished items. |
| `agent-pills-changes-tray.png` | `plugins/agent-pills/README.md` | The Changes tray open: a few files with status and +/- counts, the message box, the "Include N untracked files" tick, and the Commit, Commit & Push and Create PR buttons enabled (Pull Requests installed). |
| `filetree-tree.png` | `plugins/filetree/README.md` | The Files tab in a thread's right panel: the workspace switcher, the search box, a tree a few folders deep with Symbols file icons, and Git decorations on modified, added and untracked files. |
| `filetree-split.png` | `plugins/filetree/README.md` | The right panel split: the Files tree in one pane and a file open in BB's viewer in the other pane. |
| `projects-board.png` | `plugins/projects/README.md` | The Projects page in Board view: the board header with its icon, the "N behind" hint and the loop button, and the For Review, In Progress, Queued and Done columns with several cards each. |
| `projects-card.png` | `plugins/projects/README.md` | One card up close: key, labels, priority, title, an agent chip with live time, a +A -D changes chip, a PR chip reading Ready or CI Failing, a sub-task progress pill and a "behind" hint with Apply. |
| `projects-lead-panel.png` | `plugins/projects/README.md` | The lead thread with the Project tab open in the side panel: the board's compact list with PR and agent chips. |
| `pull-requests-board.png` | `plugins/pull-requests/README.md` | The Pull requests page for one repository: the Authored, Reviewing and All views, search, the Needs you and Starred filters, and rows grouped into Needs attention, Awaiting review, Approved and Drafts. |
| `pull-requests-detail.png` | `plugins/pull-requests/README.md` | One pull request open in a thread's side panel: status, checks, the assessment, the description and the start of the conversation, with the hand-off buttons visible. |
| `pull-requests-thread-tray.png` | `plugins/pull-requests/README.md` | The PRs tray above a composer: "N Open" with three rows (Draft, CI Failing, Ready), the branch's pull request highlighted, and the "Listening N" chip beside it. |
| `ui-tweaks-settings.png` | `plugins/ui-tweaks/README.md` | Settings → Plugins → UI Tweaks, Interface section: Clearer hierarchy on, prompt placement and height selects, the animation, Steer label and syntax highlighting switches. |
| `ui-tweaks-icon-packs.png` | `plugins/ui-tweaks/README.md` | The Icons section with the four pack cards (BB Default, Lucide, Iconoir, Tabler Outline), one selected, and the spinner select below. |
| `cursor-sidebar-hover-actions.png` | `plugins/cursor-sidebar/README.md` | A row under the pointer with its pin and archive buttons. |
| `cursor-sidebar-cloud-mark.png` | `plugins/cursor-sidebar/README.md` | A thread running on a cloud machine, with the cloud mark beside its provider mark. |
| `agent-pills-parent-pill.png` | `plugins/agent-pills/README.md` | A worker's composer with the Parent pill, its PRs and its Changes. |
| `composer-environment-picker.png` | `plugins/agent-pills/README.md`, `README.md` | A new thread's environment menu open: Cloud and This Computer under Run on, then Worktrees. |
| `desktop-take-control.png` | `plugins/agent-pills/README.md`, `plugins/machine-boat/README.md`, `README.md` | A thread on a Boat Sandbox VM with the Desktop tab open on the agent's screen and the Take Control button. |
| `projects-lead-tabs.png` | `plugins/projects/README.md` | A worker open as a tab of its lead: the lead's tab, sibling worker tabs and the Parent pill. |
| `projects-lead-question.png` | `docs/launch/guide-pt1.md` | The lead asking the user to choose, with its recommendation first, and the Submit answer button. |
| `projects-done-sorted.png` | `plugins/projects/README.md` | List view with the Done group open, newest completion first. |
