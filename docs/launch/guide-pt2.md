# A tour of the Cursor-style UI for Claude Code and Codex

*Part 2 of 2. [Part 1](guide-pt1.md) is the workflow: one lead thread running a whole board.*

[BB](https://getbb.app) runs Claude Code, Codex and the other agents you already use. My [BB Cursor Suite](https://github.com/wy3z/bb-cursor-suite) gives it Cursor's agent UI: seven plugins, each of which installs and works on its own. Take the lot, or just the one you miss.

Everything here is from a demo workspace with invented projects. The agent turns are real.

![The whole suite in one window](../media/suite-hero.png)
*Sidebar on the left, a lead thread with its pill row in the middle, Files on the right.*

## The sidebar

[Cursor Sidebar](https://github.com/wy3z/bb-cursor-suite/tree/main/plugins/cursor-sidebar) replaces BB's thread list with a port of Cursor's. Workers sit under the thread that started them, pinned chats gather at the top, and a project board's lead and workers get their own block.

The thing I look at most is the left edge. A spinner means working, an orange dot means it's waiting on me, and a green dot means it finished and I haven't read it yet. I can scan twenty chats in a second.

![The sidebar in Projects grouping](../media/cursor-sidebar-projects.png)
*A board row with its workers, a pinned chat, and repositories with their icons.*

Hover a row for pin and archive. The view menu does grouping, ordering, how many chats each group shows, and filters by status, PR, age, repository and environment.

![The sidebar's view menu](../media/cursor-sidebar-view-menu.png)

Projects get icons from a port of Cursor's picker: ten colours and a few hundred glyphs, or your own PNG.

![The project icon picker](../media/cursor-sidebar-icon-picker.png)

## The composer and its pills

[Cursor Composer](https://github.com/wy3z/bb-cursor-suite/tree/main/plugins/agent-pills) restyles BB's prompt box to look like Cursor's and replaces the cards above it with one row of small pills.

![The composer with a draft and its pill row](../media/agent-pills-composer.png)
*Working children, the thread's PRs, the PRs it's listening to, and uncommitted changes. Permission mode, model and reasoning sit in the box as plain text.*

Each pill opens a tray. **Agents** shows the children: who's working, who needs an answer (with an Answer button), and Stop All.

![The Agents tray with one worker running and one waiting on an answer](../media/agent-pills-agents-tray.png)

**Changes** shows the checkout's changes and lets me commit, commit and push, or open a PR without leaving the thread.

![The Changes tray](../media/agent-pills-changes-tray.png)

On a new thread, the environment picker works like Cursor's: **Cloud**, **This Computer**, your worktrees, or a new one.

![The environment picker on a new thread](../media/composer-environment-picker.png)

## Files

[Files](https://github.com/wy3z/bb-cursor-suite/tree/main/plugins/filetree) adds a file tree to the right panel. It's read-only, so it's safe to leave open while agents work, and it shows Git status on every changed file and folder.

![The Files tab with Git decorations](../media/filetree-tree.png)
*A worker's checkout: one new file, two modified, and the count on each folder.*

Split the panel and a file opens in the other pane, so the tree stays put.

![Files in one pane, a file open in the other](../media/filetree-split.png)

## Projects

[Projects](https://github.com/wy3z/bb-cursor-suite/tree/main/plugins/projects) is the board from part 1. Board and List views over BB Tasks, in Cursor's order.

![The board](../media/projects-board.png)

The cards are where it earns its keep. Every agent on the task, its changes, the PR with review and CI state, sub-task progress, attachments, and a "behind" hint when the stored status disagrees with the evidence.

![Cards up close](../media/projects-card.png)
*Ready, CI Failing, Checks running and Draft, plus a parent card that's behind its sub-tasks with an Apply button.*

Workers open as tabs of their lead, so the lead's side panel stays where it is. Ctrl+Alt+1 to 8 jumps between them.

![A worker open as a tab of its lead, with the Parent pill above the composer](../media/projects-lead-tabs.png)

## Pull requests

[Pull Requests](https://github.com/wy3z/bb-cursor-suite/tree/main/plugins/pull-requests) puts GitHub PRs inside BB, grouped by what each one needs from me.

![The Pull requests page for one repository](../media/pull-requests-board.png)

Open one beside the thread that wrote it to read the description, changes, commits, reviews and checks, then merge or hand it to a new agent.

![A pull request open in the side panel](../media/pull-requests-detail.png)

Above every composer there's a PRs tray: the thread's PRs, its children's, and the branch's own. The **Listening** chip shows which PRs the thread follows. When one changes, the thread gets one message.

![The PRs tray above a lead's composer](../media/pull-requests-thread-tray.png)

## Cloud and the Desktop tab

[Boat Sandbox](https://github.com/wy3z/bb-cursor-suite/tree/main/plugins/machine-boat) runs a thread on a [boat.dev](https://boat.dev) VM. When a thread runs there, a **Desktop** pill appears above the composer. It opens the VM's screen in the right panel. I watch the agent work, and **Take Control** lets me drive while the agent's computer tools wait.

![A cloud agent's desktop in the Desktop tab](../media/desktop-take-control.png)

## Small things

[UI Tweaks](https://github.com/wy3z/bb-cursor-suite/tree/main/plugins/ui-tweaks) is the grab bag: a clearer type hierarchy, prompt placement and height, four icon packs, Open With filtering and Alt+1 to 9 for panel tabs.

![UI Tweaks settings](../media/ui-tweaks-settings.png)

## Install

```sh
bb marketplace add git:github.com/wy3z/bb-cursor-suite@main --subdirectory marketplace
```

Then install what you want from the store. Each plugin's README has its own one-line install.

*Not affiliated with, endorsed by or sponsored by Anysphere, Inc. Cursor is a trademark of Anysphere, Inc.*
