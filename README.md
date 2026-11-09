# BB Cursor Suite

Run Claude Code, Codex and the other agents BB supports behind a Cursor-style interface. Six plugins give [BB](https://getbb.app) Cursor's sidebar, composer, file tree, project boards and pull request views, and each one installs and works on its own.

Not affiliated with, endorsed by or sponsored by Anysphere, Inc. Cursor is a trademark of Anysphere, Inc.

## Who it's for

People who like how Cursor lays out agent work and want that layout in BB, with whichever agent they already use. Take the whole suite, or pick the one or two pieces you miss.

## What it looks like

| Plugin | Folder | What it does |
|---|---|---|
| [Cursor Sidebar](plugins/cursor-sidebar) | `plugins/cursor-sidebar` | A Cursor-style sidebar: project trees, standalone chats, pins, folders and aggregate activity. |
| [Cursor Composer](plugins/agent-pills) | `plugins/agent-pills` | A Cursor-style composer for BB, with optional pills for child threads and background tasks above it. |
| [Files](plugins/filetree) | `plugins/filetree` | Browse thread workspaces and project sources with search and Git status. |
| [Projects](plugins/projects) | `plugins/projects` | Board and list views over BB Tasks, with live agents, pull requests and changes on every card. |
| [Pull Requests](plugins/pull-requests) | `plugins/pull-requests` | GitHub pull requests and GitLab merge requests in BB, grouped by what each one needs. |
| [UI Tweaks](plugins/ui-tweaks) | `plugins/ui-tweaks` | Small, configurable improvements to BB's interface. |
| [Docker Sandbox](plugins/machine-docker) | `plugins/machine-docker` | Run threads in local Docker containers as BB machines, with limits and idle stop. |

`packages/suite-shared` holds the contracts, time formatting, settings kit, git safety and design tokens the plugins share. Release tags carry a vendored copy, so a plugin installed from Git never needs the rest of the repository.

## Install

Add the suite's marketplace and install from the store:

```sh
bb marketplace add git:github.com/wy3z/bb-cursor-suite@main --subdirectory marketplace
```

Or install one plugin straight from Git. Each plugin has its own tags, `<id>/vX.Y.Z`:

```sh
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.3.4 --plugin cursor-sidebar --tag-prefix cursor-sidebar/
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^1.0.0 --plugin agent-pills --tag-prefix agent-pills/
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^1.0.0 --plugin filetree --tag-prefix filetree/
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^1.0.0 --plugin projects --tag-prefix projects/
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^1.0.0 --plugin pull-requests --tag-prefix pull-requests/
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.30.1 --plugin ui-tweaks --tag-prefix ui-tweaks/
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.1.0 --plugin machine-docker --tag-prefix machine-docker/
```

Cursor Composer, Files, Projects and Pull Requests are on 1.x. Docker Sandbox is experimental and starts at 0.1.x; its caret range only follows patch releases until it reaches 1.0. Cursor Sidebar stays on 0.3.x and UI Tweaks on 0.30.x, so the installs already out there keep getting updates: moving them to a new range means a reinstall, which deletes their settings.

Installs of Cursor Sidebar from `bb-plugin-cursor-sidebar` on a `^0.3.x` range keep updating from the root-level `vX.Y.Z` tags on the `legacy/cursor-sidebar` branch. UI Tweaks keeps publishing to `wy3z/bb-plugin-ui-tweaks`.

## For agents

Each plugin's `PLUGIN_OVERVIEW.md` lists every `bb` CLI command, agent tool, RPC method and setting it adds, with arguments, output and an example. Files, Projects and Pull Requests also ship a skill under `skills/`. [packages/suite-shared/README.md](packages/suite-shared/README.md) documents the shared modules.

## Development

Node 22 or newer, npm, bun (for the bun test suites) and the `bb` CLI on PATH.

```sh
npm ci
npm run check            # typecheck, test and build every workspace changed since origin/main
npm run check:all        # the same for every workspace
npm run suite -- test projects pull-requests
npm run suite -- reload  # reload changed plugins whose live install points into this checkout
```

Each step runs in its own `systemd-run --user --scope` with a 2 GB memory cap when systemd is available (`SUITE_NO_GUARD=1` turns that off). Changes under `packages/suite-shared` also check every plugin that depends on it.

Work in worktrees under `.worktrees/` and keep this checkout on `main`: live path installs load from it.

## Release

```sh
npm run release -- <plugin-id> <x.y.z>
```

The script bumps the plugin's version on the current branch, writes a release commit with `packages/suite-shared` vendored into `plugins/<id>/vendor/bb-suite` when the plugin uses it, and tags that commit `<id>/vX.Y.Z`. For `cursor-sidebar` and `ui-tweaks` it also adds the root-level legacy commit and tag. Nothing is pushed unless you pass `--push`; otherwise it prints the push commands. Never move a published tag.

Before it changes anything, the script runs `npm run versions` with the new version and refuses to release when:

- Cursor Composer, Files, Projects or Pull Requests would drop below 1.0.0.
- Cursor Sidebar or UI Tweaks would leave its legacy stream (`^0.3.2`, `^0.30.0`). Ending a stream on purpose means removing it from `legacyStreams` in `scripts/versions.mjs`.
- The range in `marketplace/marketplace.json` would never offer the new version, or an install or marketplace line in this README or any plugin README disagrees with it.
- A plugin depends on `@wy3z/bb-suite` with anything but `file:../../packages/suite-shared`, or lists it as a peer, optional or bundled dependency. Any of those would send BB's install to the public npm registry.
- `package-lock.json` has a stale version.

It also refuses a downgrade, and any version at or below one already tagged on origin (or on the legacy stream's remote). It then runs the install check below on the exact tree it is about to tag, for the legacy layout too, and only tags if that passes. If it fails, the script drops the version bump commit it made.

`npm run install-check -- <plugin-id>` builds the layout the release would tag, installs it the way BB does (BB's bundled npm with `--prefix`, `--omit=dev` and `--ignore-scripts`, then `bb plugin build`). It checks that `@wy3z/bb-suite` resolved to the vendored copy and that each `dist/*.meta.json` carries the right plugin id and version. Add `--legacy` for the root-level stream, or `--ref <tag>` to check a published tag. CI runs it for every plugin on each pull request and for the tagged plugin on each `<id>/vX.Y.Z` push.

## Licence

MIT, see [LICENSE](LICENSE). Marketplace icons come from [Lucide](https://lucide.dev) (ISC).
