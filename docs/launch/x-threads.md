# X drafts

Drafts for James to post. Every tweet is under 280 characters as X counts them (a link counts as 23). Media names refer to the files attached to BCS-87; the README shots live in `docs/media/`. Numbers are as of 9 November 2026: refresh them on the day.

Never call it "open source Cursor". The line is "Cursor's agent UI for Claude Code and Codex, open source".

## Scrappy post (James posts it himself)

Media: `x-video-4-opus-in-cursor.mp4` (47 s, 1920x1200, captions burned in, no audio). A rough screen recording of the demo: picking Opus 5.5 in the composer, the sidebar and pills, Opus doing a real task, the board, a cloud agent on its own desktop, and Take Control.

The joke is the UI, not the model. Cursor itself offers Anthropic models, so never say or imply it can't run Opus. The honest hook is Claude Code itself, on your own Claude subscription, inside a Cursor-style UI.

Burned-in captions, in order: "ok so this looks like cursor", "but it's claude code. picking opus 5.5", "on my own claude subscription", "same sidebar. same little pills", "opus did the thing", "diff's right there. commit from the pill", "one lead thread runs the whole board", "cloud agents get their own desktop", "and i can just grab the mouse", "open source. link below".

Title options:

- opus 5.5 in Cursor
- opus 5.5 in Cursor (it's Claude Code)
- it's basically Cursor. it's actually Claude Code
- Claude Code in a Cursor costume
- Cursor's UI, Claude Code's brain, my Claude sub

Read on its own, "opus 5.5 in Cursor" says this is Cursor. Keep it with the post's next line, which says what it really is.

**S1** (media: `x-video-4-opus-in-cursor.mp4`)

> opus 5.5 in Cursor
>
> (well, a Cursor-style UI. Cursor runs Anthropic models too; this is Claude Code itself, on my own Claude sub. sidebar, pills, boards, cloud desktops. open source)
>
> https://github.com/wy3z/bb-cursor-suite

**S2** (no media, reply)

> it's a set of plugins for BB, so the same UI works with codex too. not affiliated with anysphere, i just like how cursor lays out agent work

## Launch post

**1/** (media: `x-video-1-sidebar-composer.mp4`)

> I built Cursor's agent UI for Claude Code and Codex, open source.
>
> Sidebar, composer, file tree, project boards, PR review, and cloud agents with a desktop you can take over. Seven plugins for BB, and each one works on its own.
>
> https://github.com/wy3z/bb-cursor-suite

**2/** (media: `x-video-2-lead-fanout.mp4`)

> The part I use most: one lead thread runs the whole board.
>
> It plans, starts workers on cheaper models, gets Opus to review, and only pings me when I have to act. Here it's starting three tasks and asking me one question.

**3/** (media: `x-video-3-cloud-desktop.mp4`)

> Cloud agents get a real desktop. This one is play-testing a game on a boat.dev VM.
>
> I can watch it in the Desktop tab, or press Take Control and drive it myself while the agent waits.

**4/** (media: `x-01-lead-hero.png`)

> It runs on BB, so it works with the agents you already use. Install the lot from the marketplace or just the one piece you miss. MIT licence.
>
> Not affiliated with Anysphere. Cursor is their trademark.

## Thread A: how I run a project from one lead thread

Links the long post (guide part 1).

**A1** (media: `x-02-board.png`)

> How I run a whole project from one lead thread, with real files behind every rule. 🧵
>
> The board for this suite: 100 tasks, 71 done, 99 child threads under one lead, 42 merged PRs, 38 of them in the last two days.

**A2** (no media)

> 1. One board, one lead.
>
> `bb projects lead WEB` makes a thread the lead. It gets a playbook skill and about 20 lines of rules pinned to its instructions, so they survive compaction.
>
> https://github.com/wy3z/bb-cursor-suite/blob/main/plugins/projects/src/lead-instructions.ts

**A3** (no media)

> 2. Cheap workers, strong reviewers.
>
> In the demo: features on Sonnet, small UI on Haiku, reviews on Opus. The Opus reviewer bounced a PR for a missing test. The lead sent it back and the worker fixed it. I touched nothing.

**A4** (media: `x-04-needs-input.png`)

> 3. Questions go to the right person.
>
> The lead answers what it can and asks me the rest, with its recommendation first. One click and the worker starts with the decision in its brief.

**A5** (no media)

> 4. No proof, no Done.
>
> Anything visible needs a screenshot or recording on the task. Backend work needs test output. The lead shows me the proof inline when it wants my go.
>
> "Fixed, looks good" from an agent that never opened a browser is worth nothing.

**A6** (no media)

> 5. Reconcile, don't trust.
>
> The board works out what each card's evidence says (merged PR, running agent, open PR) and flags the ones that are behind. It never writes Done itself. The lead checks first.

**A7** (no media)

> The whole playbook is one skill file. Read it, steal it, tell me what's wrong with it.
>
> https://github.com/wy3z/bb-cursor-suite/blob/main/plugins/projects/skills/projects/SKILL.md

## Thread B: the UI, piece by piece

Links the long post (guide part 2).

**B1** (media: `x-01-lead-hero.png`)

> A quick tour of my Cursor-style UI for Claude Code and Codex. Seven plugins, each one optional. 🧵

**B2** (media: `cursor-sidebar-projects.png`)

> The sidebar. Workers nest under the thread that started them. Spinner means working, orange means it's waiting on me, green means done and unread. I scan twenty chats in a second.

**B3** (media: `agent-pills-agents-tray.png`)

> The composer swaps BB's cards for one row of pills: agents, PRs, changes, to-dos. Each opens a tray. Agents shows who's working and who needs an answer, with an Answer button right there.

**B4** (media: `x-06-files-split.png`)

> Files: a read-only tree in the right panel with Git status on every file and folder. Split the panel and files open in the other pane.

**B5** (media: `x-05-pr-review.png`)

> Pull requests grouped by what they need from you, and each one opens beside the thread that wrote it. Read the diff, check CI, merge, or hand it to a new agent.

**B6** (no media)

> Install the lot or one piece:
>
> bb marketplace add git:github.com/wy3z/bb-cursor-suite@main --subdirectory marketplace
>
> https://github.com/wy3z/bb-cursor-suite

## Thread C: cloud agents with a desktop

**C1** (media: `x-video-3-cloud-desktop.mp4`)

> Cloud agents in BB, with a desktop you can take over. 🧵
>
> Pick Cloud in the composer and the thread runs on a boat.dev VM: its own checkout, its own branch, Docker, Chrome, and Claude Code or Codex already installed.

**C2** (media: `x-03-cloud-desktop.png`)

> The agent drives the VM's desktop with computer-use tools. Here it starts the dev server, opens the game in Chrome, and plays both levels. Then it tells me what it saw.

**C3** (no media)

> Take Control pauses the agent's computer tools while you drive. Release and it carries on, with a note to take a fresh screenshot first.

**C4** (no media)

> It's cheap. The VM in this video cost about half a cent. Idle VMs suspend after 15 minutes, and a monthly cap you set refuses new ones once it's reached.
>
> https://github.com/wy3z/bb-cursor-suite/tree/main/plugins/machine-boat
