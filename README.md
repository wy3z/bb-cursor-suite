# BB Cursor Suite

Plugins that make [BB](https://getbb.app) look and work like Cursor. Each plugin installs and works on its own; together they cover the sidebar, the composer, files, project boards and pull requests.

| Plugin | Folder | What it does |
|---|---|---|
| Cursor Sidebar | `plugins/cursor-sidebar` | A Cursor-style sidebar: project trees, standalone chats, pins, folders and aggregate activity. |
| Agent Pills | `plugins/agent-pills` | Cursor-style pills for child threads and background tasks, plus a Cursor-looking composer. |
| Files | `plugins/filetree` | Browse thread workspaces and project sources with search, Git status and document previews. |
| Projects | `plugins/projects` | Board and list views over BB Tasks, with live agents, pull requests and changes on every card. |
| Pull Requests | `plugins/pull-requests` | GitHub pull requests and GitLab merge requests in BB, grouped by what each one needs. |
| UI Tweaks | `plugins/ui-tweaks` | Small, configurable improvements to BB's interface. |

`packages/suite-shared` holds the contracts, time formatting and design tokens the plugins share. Release tags carry a vendored copy, so a plugin installed from Git never needs the rest of the repository.

## Install

Add the suite's marketplace and install from the store:

```sh
bb marketplace add git:github.com/wy3z/bb-cursor-suite@main --subdirectory marketplace
```

Or install one plugin straight from Git. Each plugin has its own tags, `<id>/vX.Y.Z`:

```sh
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.3.4 --plugin cursor-sidebar --tag-prefix cursor-sidebar/
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.1.0 --plugin agent-pills --tag-prefix agent-pills/
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.3.0 --plugin filetree --tag-prefix filetree/
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.1.0 --plugin projects --tag-prefix projects/
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.1.0 --plugin pull-requests --tag-prefix pull-requests/
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.30.1 --plugin ui-tweaks --tag-prefix ui-tweaks/
```

Installs of Cursor Sidebar from `bb-plugin-cursor-sidebar` on a `^0.3.x` range keep updating from the root-level `vX.Y.Z` tags on the `legacy/cursor-sidebar` branch. UI Tweaks keeps publishing to `wy3z/bb-plugin-ui-tweaks`.

## Develop

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

## Licence

MIT. Marketplace icons come from [Lucide](https://lucide.dev) (ISC).
