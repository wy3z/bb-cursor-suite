# Cursor Composer

Restyles BB's composer to look like Cursor's, and swaps the full-width cards above it for one row of small pills: agents, changes, to-dos, the queue and the rest.

## Who it's for

People who spend their day in the prompt box and want it calm. The pills keep child threads, background tasks and uncommitted changes in view without pushing the conversation up the screen.

## What it looks like

- **The composer** becomes a rounded, opaque row: the paperclip, then permission mode, model and reasoning as plain text, and a round send button. Right-click the send button for BB's send options.
- **The environment picker** under a new thread's prompt box works like Cursor's: **Cloud** and **This Computer** under Run on, then your existing worktrees, **New Worktree** and any other local environment. Cloud appears once a cloud environment provider is installed, and is greyed out with a Learn more link until then. See [Cloud agents](../../README.md#cloud-agents).
- **Agents** collects child threads and background tasks in one tray. Answer, stop or open them from there.
- **Changes** shows the checkout's changes with commit, push and pull request buttons. These need the Pull Requests plugin.
- **Apply locally** copies a child thread's worktree into the parent's checkout as uncommitted changes. This also needs Pull Requests.
- Pills for workflows, plan mode, the goal, to-dos, model fallback, queued messages, an archived thread and a paused machine, each with its own actions.
- **Desktop** opens the thread's computer in the right-hand panel when the thread runs on a cloud VM with a desktop (Boat Sandbox today). You watch the agent work, then **Take Control** to click and type in it yourself; the agent's computer tools wait until you **Release control**.

The restyle is on whenever the plugin is. The pills are on by default; turn them off under **Settings → Plugins → Cursor Composer → Agent pills** to get BB's own cards back. That setting is kept in this browser only.

The full behaviour reference is in [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md).

## Install

```sh
bb marketplace add git:github.com/wy3z/bb-cursor-suite@main --subdirectory marketplace
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^1.0.0 --plugin agent-pills --tag-prefix agent-pills/
```

Needs BB 0.49 or newer with plugin SDK 0.6.132 or newer. It uses the experimental thread context segment slot. Turn it off with `bb plugin disable agent-pills`.

## For agents

This plugin adds no CLI commands or agent tools. Its RPC methods, and the Pull Requests git actions it calls, are in [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md#for-agents).

## Development

```sh
npm run typecheck
npm run build
bb plugin reload agent-pills
```

## Licence

MIT, see [LICENSE](LICENSE).

---

Not affiliated with, endorsed by or sponsored by Anysphere, Inc. Cursor is a trademark of Anysphere, Inc.
