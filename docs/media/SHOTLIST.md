# Shot list

Every screenshot slot the READMEs will show. None of these files exist yet, so the READMEs don't embed them; BCS-87 captures the shots and adds the embeds (plugin READMEs use absolute `https://raw.githubusercontent.com/wy3z/bb-cursor-suite/main/docs/media/<name>.png` URLs, the root README a relative path). Capture them from a demo workspace with fake data: invented project names, thread titles, repositories (`acme/web`, `acme/api`), people and pull request numbers. No real thread titles, client names, customer data, tokens or hostnames.

Common rules:

- PNG, dark theme, 2x scale, no browser chrome or OS menu bar.
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
| `projects-lead-panel.png` | `plugins/projects/README.md` | A thread in a linked BB project: the composer pill with the project name, working count and "N for review", and the compact list it opens in the side panel. |
| `pull-requests-board.png` | `plugins/pull-requests/README.md` | The Pull requests page for one repository: the Authored, Reviewing and All views, search, the Needs you and Starred filters, and rows grouped into Needs attention, Awaiting review, Approved and Drafts. |
| `pull-requests-detail.png` | `plugins/pull-requests/README.md` | One pull request open in a thread's side panel: status, checks, the assessment, the description and the start of the conversation, with the hand-off buttons visible. |
| `pull-requests-thread-tray.png` | `plugins/pull-requests/README.md` | The PRs tray above a composer: "N Open" with three rows (Draft, CI Failing, Ready), the branch's pull request highlighted, and the "Listening N" chip beside it. |
| `ui-tweaks-settings.png` | `plugins/ui-tweaks/README.md` | Settings → Plugins → UI Tweaks, Interface section: Clearer hierarchy on, prompt placement and height selects, the animation, Steer label and syntax highlighting switches. |
| `ui-tweaks-icon-packs.png` | `plugins/ui-tweaks/README.md` | The Icons section with the four pack cards (BB Default, Lucide, Iconoir, Tabler Outline), one selected, and the spinner select below. |
