Pull Requests brings your GitHub pull requests into BB, grouped by what each one needs, with checks, diffs, the conversation and agent hand-offs.
It also serves the suite's git actions (commit, push, create PR, apply locally) and reads GitLab merge requests for a thread's branch.
Agents link pull requests to their thread and subscribe it to updates through `bb pull-requests` or the `pull_request_subscriptions` tool.

## For agents

### CLI: `bb pull-requests`

Every command acts on the thread running it, or `--thread <id>`. Outside a thread without `--thread` it fails with `no thread to link to` (code `thread_required`). Every command takes `--json`.

| Command | Arguments | Does | `--json` output |
|---|---|---|---|
| `link <url>` | a github.com pull request URL | Links it to the thread, shown in the PRs tray. Idempotent; a thread keeps the newest 12 | `{ ok: true, urls }` |
| `unlink <url>` | a github.com pull request URL | Removes a link | `{ ok: true, urls }` |
| `list` | | Lists linked pull requests | `{ ok: true, urls }` |
| `subscribe <pr...>` | URLs, `owner/repo#123`, or bare numbers inside a project with a GitHub remote. Comma-separated works too | Follows them. Idempotent, at most 100 per thread | `{ ok: true, urls }` |
| `unsubscribe <pr...>` | as above | Stops following them | `{ ok: true, urls }` |
| `subscriptions` | | Lists what the thread follows | `{ ok: true, subscriptions: { url, snapshot, error, checkedAt }[], intervalSeconds }` |

A URL that isn't a github.com pull request fails with code `invalid_url`. A subscription problem (an unknown repository, the 100 limit) fails with `subscription_failed` and the reason. Without `--json`, `subscriptions` prints `owner/repo#N — <state, error or "waiting for first check">` per line.

`snapshot` is `{ title, url, state, updatedAt, fields }`. It is null until the first check, which sets a silent baseline.

```sh
bb pull-requests link https://github.com/acme/web/pull/123
bb pull-requests subscribe acme/web#123 acme/api#45
bb pull-requests subscriptions --json
```

### Agent tool: `pull_request_subscriptions`

Registered for every agent. Acts on the calling thread.

| Parameter | Type | Meaning |
|---|---|---|
| `action` | `"subscribe" \| "unsubscribe" \| "list"` | What to do |
| `prs` | `string[]` (max 50), optional | Pull requests, as for the CLI. Required for subscribe and unsubscribe |

Returns a JSON string: `{ subscriptions, intervalSeconds }` for `list`, `{ urls }` for the others, or `{ error }` when `prs` is missing. Through BB's MCP server, the `run` tool can run the CLI instead.

```json
{ "action": "subscribe", "prs": ["https://github.com/acme/web/pull/123"] }
```

Changes arrive in the thread as one `[Subscription update] …` message covering everything since the last one. A subscription to a pull request that merged or closed is dropped once that final update has been delivered.

### Skill

`skills/pull-requests/SKILL.md` (`pull-requests`) teaches linking, mentioning and subscribing.

### RPC (plugin id `pull-requests`)

**Git actions** (`gitActionsContract` in `@wy3z/bb-suite/contracts`), used by Cursor Composer and Projects. Each returns `{ ok, error?, sha?, subject?, branch?, url?, existed?, files? }`. They run on the BB server's machine, so they only work for environments there.

| Method | Input | Does |
|---|---|---|
| `gitCommit` | `{ environmentId, message, push, includeUntracked = false }` | Commits tracked changes (all changes with `includeUntracked`). An empty message uses BB's generated commit. `push: true` pushes after |
| `gitPush` | `{ environmentId }` | Pushes the branch to `origin` |
| `gitCreatePullRequest` | `{ environmentId }` | Commits if needed, pushes, and runs `gh pr create --fill`, or returns the open one (`existed: true`) |
| `gitApplyLocally` | `{ sourceEnvironmentId, targetEnvironmentId }` | Copies the source worktree's changes into the target checkout as uncommitted changes, or refuses if the patch doesn't apply cleanly |

**Change requests** (`changeRequestsContract` in `@wy3z/bb-suite/change-requests`): `changeRequests` takes `{ keys: environmentId[] }` and returns, per environment, the pull or merge request for its current branch, GitHub or GitLab. GitHub rows come from the builtin GitHub PR Status plugin. Cursor Sidebar reads it for its marks.

**The app's own methods.** Results are `{ ok: true, value } | { ok: false, error }` unless noted.

| Method | Input | Output |
|---|---|---|
| `repositories` | `null` | `{ choices: { projectId, projectName, repository, icon }[] }` |
| `preferences_get` / `preferences_set` | `null` / `{ repository?, filter? }` | `Preferences` |
| `star_toggle` | `{ key }` | `{ stars }` |
| `list` | `{ repository, filter, after, refresh }` | a page of pull requests |
| `detail` / `diff` / `pr_commits` | `{ url, refresh }` | detail, diff files, commits |
| `summaries` | `{ urls (max 20), refresh }` | `{ items: { url, summary }[] }` |
| `comment` | `{ url, body }` | the new comment |
| `pr_rename` | `{ url, title }` | `{ ok: true }` |
| `pr_ready` | `{ url }` | `{ ok: true }` |
| `pr_merge` | `{ url, method: "merge" \| "squash" \| "rebase" }` | `{ ok: true }` |
| `pr_set_state` | `{ url, state: "close" \| "reopen" }` | `{ ok: true }` |
| `pr_action` | `{ threadId, url, action: "fix-conflicts" \| "debug-ci" \| "update-branch" }` | `{ delivery }`. Sends the matching prompt to the thread |
| `linked_list` / `link` / `unlink` | `{ threadId }` / `{ threadId, url }` | `{ urls }` |
| `subscriptions_list` | `{ threadId }` | `{ subscriptions, intervalSeconds }` |
| `subscribe` / `unsubscribe` | `{ threadId, urls (1-50) }` | `{ urls }` |
| `change_request_detail` | `{ url, connection, refresh }` | a GitLab merge request's detail |

```ts
await sdk.plugins.callRpc({
  pluginId: "pull-requests",
  method: "gitPush",
  input: { environmentId: "env_..." },
  outputSchema: gitActionsContract.gitPush.output,
});
```

### Opening a pull request from another plugin

Dispatch a cancelable, bubbling `bb-pull-requests:open` `CustomEvent` with `detail: { url }` from the clicked element (see `components/pr/open-event.ts`). Inside a thread view it opens in that thread's side panel; elsewhere in the full-page view. The event is always cancelled, so `dispatchEvent` returning `true` means the plugin isn't installed and you should open the URL yourself.

### Message directive

`::pull-request{url="…"}` on its own line renders the same live link as a markdown link.

### Realtime channels

`links-changed` and `subscriptions-changed`, both with `{ threadId }`.

### Settings

| Key | Default | Meaning |
|---|---|---|
| `intervalSeconds` | 60 | How often followed pull requests are checked (30 to 3600) |
| `debounceSeconds` | 10 | Changes within this window go out as one message (0 to 600) |
| `gitlabInstances` | empty | Self-hosted GitLab hosts, see below |

### Background service

`watch` checks followed pull requests and delivers `[Subscription update]` messages. A message still queued for a busy thread is rewritten rather than stacked.

## Reference

### In threads

- **PRs tray.** A "PRs" chip with the open count opens a tray headed "N Open", newest first, then merged and closed ones under "N Done" (three at a time). Each row has a status icon, the title, `#N` and a status word (Draft, Conflicts, CI Failing, Ready, Waiting for Reviewers); hover swaps the word for Add to chat. A click opens it in the side panel, Ctrl or middle-click opens GitHub. The branch's pull request is highlighted. The tray also lists the thread's subscriptions and the branch, linked and subscribed pull requests of its child threads, all the way down. The chip and tray use this plugin's own `bb-pr-` classes, so no other plugin has to be installed.
- **Links in messages.** Any markdown link to a github.com pull request gets a live lifecycle icon, reads `#N` when its text is just the URL or number, and has a hover card. BB renders message markdown itself, so an app overlay decorates the links in place.
- **Tabs** read "PR #N" and take the lifecycle colour.
- **Listening.** A "Listening N" chip opens a tray of what the thread follows. Subscribe also from **Subscribe** in the pull request viewer's **...** menu.

### Requests to GitHub

Every request goes through `gh` on the BB server's machine, with prompts disabled, from the temp folder, and with a git that can't open any repository. Results are cached for a minute, and reads pause for 15 minutes if GitHub's rate limit is hit. Writes happen only when you press a button: comment, rename, ready, merge, close or reopen.

### GitLab merge requests (read-only)

A thread's branch can have a GitLab merge request. Pull Requests finds it
without the GitLab MR Status plugin:

- It reads the checkout's branch, upstream and remotes on the environment's own
  machine (the plugin's `host.ts`), so linked worktrees and enrolled remote
  hosts work. Nothing is fetched and no git config changes.
- It asks GitLab through that machine's signed-in `glab`
  (`glab api --hostname <host>`, GET only). It never reads glab's token or
  config. Without glab, or signed out, the MR shows a setup message, not a
  fake mark.
- gitlab.com works as is. Add self-hosted instances in the plugin's settings
  ("Self-hosted GitLab instances"): `git.example.com` (HTTPS and SSH remotes on
  that host), `git.example.com:8443` (HTTPS on that port only), or
  `alias=https://git.example.com` for an SSH host alias. HTTPS remotes must
  match the host and port exactly; two instances can't claim one SSH alias.
  GitLab installed under a path (`https://host/gitlab`) is reported as not
  supported yet. Other hosts are never guessed from their name.
- Only an open same-project MR for the branch is shown. Two open MRs for one
  branch are reported as ambiguous, and a branch with more open MRs than BB
  reads is reported as incomplete. Merged or closed MRs that only share the
  branch name aren't shown until BB can prove they belong to the checkout.
- Remote URLs never leave the machine: the host returns only the parsed host,
  port and project path, with no credentials, query or fragment.

`changeRequests` (keyed by environment id, contract in
`@wy3z/bb-suite/change-requests`) serves GitHub and GitLab to other plugins;
GitHub rows come from the builtin GitHub PR Status plugin. Cursor Sidebar uses
it to show `!iid` marks, which open the MR in this plugin's pull request tab.
The GitLab tab shows the title, state, branches, pipeline and description,
with no merge, comment, subscription or agent actions yet.

### Git safety

Every git, `gh` and `glab` call goes through `@wy3z/bb-suite/git-safety` (see
the [suite-shared README](../../packages/suite-shared/README.md#git-safety)), so
a checkout's own config can't run code during a read. User actions run git the
way your terminal would, minus what they don't need.

| Where | Calls | Kind |
|---|---|---|
| `host.ts` inspect (branch, upstream, remotes for GitLab MRs) | `rev-parse --is-inside-work-tree`, `symbolic-ref -q --short HEAD`, `rev-parse -q --verify HEAD`, `remote`, `config --get` (branch remote, merge, pushRemote, `remote.pushDefault`), `remote get-url` | Read-only, with your global config |
| `host.ts` GitLab | `glab api --hostname … --include` | CLI with no repository |
| `server.ts` (board, detail, diff, comments, title, ready, merge, close) | `gh api graphql`, `gh pr view/diff/edit/ready/merge/close/reopen <url>`, `gh api POST …/comments` | CLI with no repository, run from the temp folder |
| Commit, Push, Create PR and Apply checks | `rev-parse --show-toplevel`, `rev-parse --abbrev-ref HEAD`, `ls-files --others --exclude-standard`, `diff --cached --quiet`, `log -1`, `rev-parse --git-common-dir`, `rev-parse HEAD`, `merge-base`, `apply --numstat` | Read-only, with your global config |
| Commit and Create PR "anything to commit?" check | `status --porcelain --ignore-submodules=dirty` | Action policy: filters on, hooks off, no lazy fetch, no index write |
| Create PR lookup | `gh pr view <branch>` | CLI, read-only git |
| Commit | `add -u` or `add -A`, `commit -F -` | User action, hooks on |
| Push (also after Commit and Create PR) | `push -u origin HEAD:refs/heads/<branch>` | User action, hooks on |
| Create PR | `gh pr create --fill --head <branch>` | CLI action: hooks and drivers off, lazy fetch allowed |
| Apply locally | `read-tree`, `add -A` and `diff --binary --no-ext-diff --no-textconv` into a temporary index in the source; `apply --check`, `apply --binary` in the target | User action, hooks off, no lazy fetch |

What can still run, and why, is in the suite-shared table: clean filters in
the "anything to commit?" check, your repository's hooks and clean filters on
Commit, push hooks and the remote's own SSH command or credential helper on
Push, clean and smudge filters on Apply, and a partial clone's lazy-fetch
transport on Commit, Create PR and (on Git older than 2.45) Apply. A commit
with an empty message goes through BB's own commit
(`bb.sdk.environments.commit`), which this plugin doesn't run itself.

The "anything to commit?" check ignores changes inside a submodule's own
worktree, since Commit can't stage those anyway; a submodule that moved to
another commit still counts.

### GitHub ownership and the old subscriptions

This plugin is the only watcher and tool for GitHub pull requests. The
Subscriptions plugin now follows Linear issues only, and its "Listening" chip
shows those.

Subscriptions recorded before the split (rows in the Subscriptions plugin's
database) are adopted on this plugin's first start: that database is read
read-only through `bb.server.experimental_dataDir`, each `owner/repo#N` becomes
`https://github.com/owner/repo/pull/N`, and the last snapshot is carried over.
Every adopted pull request is recorded in a `legacy_import` table, so the import
is idempotent, a restart does not duplicate anything, and a subscription removed
here is never resurrected from the old file. Because it reads the file rather
than calling that plugin, it works whether the Subscriptions plugin is enabled,
disabled, or not yet updated, and it never writes to its database. Pending
legacy changes are not carried over.

### What was ported

| Zeron source | Here |
| --- | --- |
| `crates/proto/src/change_request_assessment.rs` | `lib/model.ts`: CI state, blockers, attention, actions, missing info |
| `crates/engine/src/source_control.rs` (+ review threads) | `server.ts`: the same GraphQL queries, CI rollup, rename following, error classes, cache and rate-limit pause |
| `crates/ui/src/pull_requests.rs` | `components/pr/board.tsx` |
| `crates/ui/src/pull_request_detail.rs` | `components/pr/detail.tsx` |
| `crates/ui/src/pull_request_handoff.rs` | `lib/handoff.ts` |

Not ported: Zeron's device switcher (BB runs `gh` on the server's machine),
its custom code viewer (BB's `experimental_Diff` is used instead), comment
@-mention completion, and image lightboxes.

### Icons from Cursor Sidebar

`components/ui/icon*.tsx`, `components/ui/host-icon-names.ts` and
`components/project-icons/` are copied from `bb-plugin-cursor-sidebar`, so
icons render the same in both plugins. The only change is that
`host-icon-names.ts` also exports a `HostIconName` type, so names BB draws
itself type-check. The project-icon colours are copied into `app.css`.

Project icons (glyph, emoji, monogram or uploaded image) are read at runtime
from Cursor Sidebar's `listProjectIcons` RPC and shown in the repository
picker and the detail header. Without that plugin, projects show the folder.
Re-copy these files when Cursor Sidebar's icon code changes.

### How the footer button works

`experimental_sidebarFooter` actions can only open the plugin's settings
page, so the button is registered as a disclosure whose component calls
`useBbNavigate().toPluginPanel(...)` on mount and dismisses itself.
The panel also appears in BB's navigation like any plugin page.

---

Not affiliated with, endorsed by or sponsored by Anysphere, Inc. Cursor is a trademark of Anysphere, Inc.
