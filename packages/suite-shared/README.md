# bb-suite

The shared code behind the BB Cursor Suite: RPC contracts and plugin ids, the project icon picker, time formatting, the settings kit, design tokens, git safety and a few helpers. It is not a plugin and is never installed on its own.

## Who it's for

People working on the suite's plugins (agent-pills, pull-requests, cursor-sidebar, projects, filetree, ui-tweaks). Plugins depend on it as `"@wy3z/bb-suite": "file:../../packages/suite-shared"`, and `bb plugin build` bundles it. Release tags carry a vendored copy under `plugins/<id>/vendor/bb-suite`.

## For agents

This package adds no CLI commands, agent tools or RPC methods of its own. It defines the contracts the plugins serve to each other; each plugin's `PLUGIN_OVERVIEW.md` documents the methods it serves. The modules:

- `@wy3z/bb-suite/contracts`: the Tasks plugin subset the suite reads, BB's git
  status read, the git actions served by pull-requests (commit, push, create
  PR, apply locally) and the Projects plugin's meta, leads and board icons.
- `@wy3z/bb-suite/change-requests`: the provider-neutral change request read
  served by pull-requests (`changeRequests`, keyed by environment id) for GitHub
  pull requests and GitLab merge requests, its labels (`#12`, `!12`) and the
  `bb-pull-requests:open` event detail. Frontend-safe: zod only, no SDK import.
- `@wy3z/bb-suite/plugin-availability`: `usePluginAvailability(pluginId)`,
  whether another plugin is installed, enabled and running (`unknown` until
  BB's plugin list loads, then `available` or `unavailable`). One
  `plugins.list()` per app is shared by every caller and refreshed when BB
  reports `plugins-changed` or the realtime connection comes back, so enabling
  or disabling a plugin updates the UI without a reload. A refresh that fails
  keeps the last list that loaded. If no list has loaded, because the call
  failed or took longer than `LIST_TIMEOUT_MS` (10 seconds), it answers
  `available` and leaves the click to report the error. A plugin whose service
  crashes after it started still reads as running in BB, so it stays
  `available` too. Plus `NEEDS_PULL_REQUESTS`, the label for actions served by
  pull-requests.
- `@wy3z/bb-suite/plugin-status`: `pluginAvailability(plugins, pluginId)` and
  the types behind the hook, without React or the app SDK, for plugin servers
  that read `bb.sdk.plugins.list()` themselves.
- `@wy3z/bb-suite/project-icon`: the stored icon format (`glyph:<name>:<color>`,
  `emoji:`, `monogram:`, PNG data URL), Cursor's ten picker colours plus the
  older 18, the icon catalog (Cursor's picker icons in Cursor's order, matched
  by name to Hugeicons), search, and PNG checks. Frontend-safe: no SDK import.
- `@wy3z/bb-suite/project-icon/picker`: `ProjectIconPicker`, an anchored port
  of Cursor's project icon picker (search, colour swatches, icon grid, **No
  icon**) with an image upload and paste addition, plus `ProjectIconArt` and
  `ProjectIconGlyph` to draw a stored icon. Import
  `@wy3z/bb-suite/project-icon.css` with it. Glyph artwork is not bundled into
  the app: the picker and marks fetch it from the plugin's own server through
  an `iconGlyphs` RPC (`PROJECT_ICON_GLYPHS_METHOD`), answered by
  `serveProjectIconGlyphs` from `@wy3z/bb-suite/project-icon/server`.
  Third-party notices for this code are in
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- `@wy3z/bb-suite/machine-backend`: the sandbox policy (`idleMinutes` 15,
  `ttlMinutes` 120, `maxConcurrent` 2, `monthlyCapUsd` 30, `hourlyRateUsd`,
  orphan handling), the machine resource schema, cap and concurrency refusal
  messages, `findSecretLike` and `redactSecrets`. Frontend-safe: zod only.
- `@wy3z/bb-suite/machine-backend/server`: `registerSandboxBackend(bb, backend,
  policy)` for vendor machine plugins. Boat Sandbox (`plugins/machine-boat`) uses it. The vendor supplies `create`, `exec`,
  `snapshot`, `stop`, `resume`, `remove` and `listByName`, plus optional
  `findSnapshot`, `extendTtl` and `vendorSpendRefusal`. The last one reports
  the vendor's own meter (`{ reason: "cap" | "unreadable", message }` or
  `null`); the helper checks it with its own estimate on create, resume,
  `validate`, `availability`, every TTL extension and every sweep. A `cap`
  answer suspends running sandboxes; either answer refuses admissions and
  TTL extensions, and a hook that throws counts as `unreadable`. The
  helper's own estimate is kept in USD per month at the rate each
  allocation started or resumed at, so a later rate change never reprices
  past time. `snapshot` must return only once the saved
  state is durable (`snapshotId: null` means the compute keeps its state
  across `stop`, in which case `stop` returns the surviving sandbox id). It
  receives an `operationKey` that the helper records before the call.
  `remove` resolving means the listed compute and snapshots are gone.
  Snapshot recovery comes in two strengths:
  - With `findSnapshot` (keyed recovery): the vendor tags the snapshot with
    `operationKey`, returns the same snapshot for a repeated key, and
    `findSnapshot` returns it (or `null` if the operation never produced one).
    A snapshot whose response was lost is found and tracked like any other.
  - Without it (conservative fallback): compute is never stopped until a
    snapshot id is durably recorded. A lost snapshot response leaves the
    sandbox running, the helper retries once, and the operation that may have
    left an orphaned snapshot is recorded as unverified. It goes in the
    machine resource (`unverifiedSnapshotOps`), a progress line and a server
    warning, and survives machine removal in the plugin store
    (`unverifiedSnapshots()`, `forgetUnverifiedSnapshot()`) for manual
    cleanup.

  | Vendor | Snapshot guarantee | Path |
  |---|---|---|
  | Modal (built-in plugin's SDK) | `snapshotFilesystem` takes no caller key and returns the image id only in its response | fallback, unverified records possible |
  | boat.dev | every stop snapshots the disk and resume restores the newest snapshot, so `snapshot` returns `null` and `stop` returns the stopped sandbox's id. Saved (named) snapshots are templates for new sandboxes, not resume points | retained disk |
  | Vercel Sandbox | not yet checked (confirm) | fallback until checked |
  | Test fake | keyed and idempotent | keyed recovery |

  The helper registers the machine provider: an idempotent create keyed by
  name, with a checkpoint before allocating and core bootstrap over the vendor exec, plus a systemd
  probe. Suspend checkpoints the snapshot before stopping, stops every
  allocation under the name, and verifies none is still running. Each snapshot
  is bound to the compute it came from (`snapshotSandboxId`). If the current
  compute has vanished and its only snapshot came from earlier compute,
  suspend refuses rather than silently rolling back. Every snapshot id and
  pending snapshot operation goes into a ledger that sweeps only add to; ids
  leave it only once the vendor confirms deletion. Resume
  re-runs bootstrap, then `remove` and `reconcileCleanup` complete the
  provider. Create and resume are admitted one at a time, with slot
  reservations against the concurrency and spend caps. A reservation holds its
  slot until the vendor proves there is no compute under the name, including
  after a lost response or a restart.
  It also registers the composed `project-checkout` environment and runs a
  minute sweep. The sweep suspends idle machines and extends the vendor TTL
  while a machine is active and under budget. Once the monthly cap is reached
  it stops renewing and asks core to suspend every running sandbox, so spend
  can overshoot by at most one sweep interval plus core's suspend time per
  running sandbox. It also removes orphaned allocations, but only after a
  complete ownership read and a grace period counted from when the allocation
  was first seen without an owner. Vendor progress, availability and validate
  messages are redacted. Sweeps are single-flight: a tick that fires while
  one is running joins it. Every allocation record write is a
  compare-and-set on a revision field inside one exclusive store section, with
  usage accrual in the same section. A sweep commits only against the revision
  it read, and drops its write if a lifecycle call changed the record
  meanwhile. Exec output is passed to core unchanged; core
  line-buffers it into the progress report, which the helper has already
  wrapped with redaction.
  It also installs a `message.dispatch` hook for its own sandboxes only that
  rejects a launch when the thread's agent has no cloud login. The check
  reads machine env names, never values, plus Account Pooler routing
  (`status.get`: `routing`, `accounts[].provider/enabled/status/error`), plus
  logins the vendor's own machine supplies. A `machine-login` requirement
  (`claude`, `codex`) is met by `launchCheck.machineLogins(context, signal)`,
  which the vendor implements by checking the VM itself (or, before one
  exists, its own account settings) and answers `{ logins, note }`; the
  helper asks only when env and pool don't already satisfy the rule, gives it
  20 s, and puts the note, or a redacted error, at the end of the reject
  message. The default fix text sends users to the machine's own logins or
  the Account Pooler rather than BB machine env, because machine env also
  reaches the BB server's own computer, where a `claude setup-token` token
  overrides the local login and hides its usage. The
  rules are data (`DEFAULT_CLOUD_LOGIN_RULES`, `evaluateCloudLogin`) in the
  frontend-safe module, so vendors share them. Pass `launchCheck: { rules }`
  to extend them, or `launchCheck: false` and compose
  `createCloudLaunchCheck` into a plugin's own hook. The same hook then runs
  the provider CLI check (`createProviderCliCheck`): BB never installs agent
  CLIs when a thread starts and machine `create` isn't told which provider a
  thread needs, so on a turn to an active sandbox host it reads
  `hosts.providerCliStatus` (4 s budget; unreadable status proceeds). A
  missing CLI answers `wait`, installs through `hosts.installProviderCli` in
  the background and calls `recheck`; a failed install, or a provider BB has
  no installer for, rejects with the `bb machine provider-cli install`
  command. Pass `providerCliCheck: false` to leave it out, or compose
  `createProviderCliCheck` and `chainDispatchChecks` yourself; BB allows one
  `message.dispatch` handler per plugin, so `launchCheck: false` alone no
  longer means the helper registers no handler. An install that hasn't
  finished after 10 minutes rejects the turn with the install command, and
  an installed CLI is remembered for 5 minutes so most messages skip the
  status read. `@wy3z/bb-suite/testing/sandbox-fakes`
  exports the fake BB and backend the helper's own tests use. Server-only.
- `@wy3z/bb-suite/desktop`: the vendor-neutral contract for a thread's
  computer. A desktop vendor serves three JSON routes under its plugin,
  `POST /api/v1/plugins/<id>/http/desktop/status`, `/view` and `/control`
  (`DESKTOP_ROUTES`, `desktopRouteUrl`), each answering
  `{ ok: true, result }` or `{ ok: false, error: { code, message } }`:
  - `status` (`{ threadId, clientId }`): state `ready`, `starting`,
    `stopped` or `unavailable`, whether the stream takes input, whether the
    vendor can pause the agent, and control as `{ holder, mine,
    agentPaused, since, expiresAt }`. `mine` says whether the caller's
    `clientId` holds control; another window's id is never returned.
  - `view` (`{ threadId, theme?, touch? }`): a fresh https view URL and the
    time it must be opened by. `touch: true` says the viewer is on a touch
    screen, so a vendor can keep its own touch controls (boat keeps its
    overlay for the on-screen keyboard). A Cursor Composer that sends it needs
    a vendor plugin built from the same suite version, because the body is
    validated strictly.
  - `control` (`{ threadId, clientId, action: "take" | "renew" | "release" }`).

  `DESKTOP_PROVIDERS` maps a machine provider id to the plugin that serves its
  desktop (`boat-sandbox` to `machine-boat`). The registry is compiled into
  the UI, so a new vendor means one line here plus a new Cursor Composer
  release. Also the timings (`DESKTOP_LEASE_MS` 2 minutes,
  `DESKTOP_RENEW_MS` 30 seconds, `DESKTOP_HIDDEN_STOP_MS` 30 seconds,
  `DESKTOP_MAX_HOLD_MS` 30 minutes), the iframe `allow` list (no clipboard)
  and `sandbox` tokens (`allow-scripts allow-same-origin allow-pointer-lock`,
  never top navigation or popups), and `browserRequestRefusal`.
  Frontend-safe.
- `@wy3z/bb-suite/desktop/server`: `registerDesktopProvider(bb, vendor)`
  serves those routes for a vendor plugin. The vendor supplies `probe`,
  `view`, and optionally `pauseAgent` (resolving `false` when there was
  nothing to pause) and `resumeAgent`. The helper:
  - **Who may call.** It answers only requests that look like a BB app page's
    own `fetch`:
    - Through Connect, only a signed-in session passes. The gate's
      `x-bb-gate-auth` is set by Connect from the verified credential and
      can't be forged through it, and `machine`, `oauth` or any other value
      is refused.
    - Every request also needs the browser's same-origin fetch metadata
      (`Sec-Fetch-Site: same-origin`, a `cors` or `same-origin`
      `Sec-Fetch-Mode` and an `Origin`).

    That shuts out the bb CLI, `bb plugin rpc call`, other plugins' servers
    and agents on cloud machines. It doesn't separate plugins inside BB's
    page: any plugin's frontend shares that page, so its `fetch` is genuinely
    same-origin and can reach the routes. Nor is it a boundary against
    software on a trusted loopback or direct route that forges browser
    headers: BB gives that software the user's full access anyway.
  - **Scope.** It resolves the thread to its host, and refuses threads on
    another provider's machine or on none.
  - **Control.** One lease per host, in memory. Taking control calls
    `pauseAgent`. Taking and renewing both count as machine activity, so a
    hold isn't idle-suspended. The lease
    ends after 2 minutes without a renewal, after 30 minutes in total (the
    renewal is refused and the agent resumed), on release, or when the
    plugin stops, and each of those calls `resumeAgent`. When the machine
    is paused or stopped the lease is simply dropped, because the stop ended
    the pause. A transient probe failure keeps the lease. When the agent was
    paused, every thread on that machine with a turn running gets an
    agent-only steer saying control came back and to take a fresh
    screenshot, because they all share the screen.
  - **Storage.** Nothing is stored: the view URL goes straight back to the
    caller and is never logged.

  Server-only.
- `@wy3z/bb-suite/git-safety`: every git call the suite makes inside a
  checkout goes through this module, so a repository's own config can't run
  code where nobody asked for it. Files, Pull Requests and Projects share it.
  See [Git safety](#git-safety). `@wy3z/bb-suite/testing/hostile-git` is the
  hostile repository the plugins' tests run against.
- `@wy3z/bb-suite/thread-tabs`: opening a project lead's worker as a tab of
  the lead, so the lead's side panel stays. `openThreadAsTab` finds the lead
  above a thread, adds the tab, selects it, and routes to the lead only when
  it isn't already showing or a maximized panel hides its conversation.
  Ctrl or Cmd-click stays a real split, and threads with no lead navigate
  plainly. `shownThread` and `useShownThread` name the thread actually on
  screen (the overlaid worker when its lead is routed). Projects' tab strip
  calls `registerTabHost` while it can show tabs, and `tabHostReady` tells
  other plugins whether to route through it or navigate plainly; with no host
  the shown thread is just the route. The tab, view and host stores live on
  the page under one `Symbol.for` key, so Projects' tab strip and the Cursor
  sidebar share them even though each plugin bundles its own copy.
- `@wy3z/bb-suite/time`: `shortAge` ("now", "5m", "3d", "2w", "1mo"),
  `shortAgo` ("5m ago", "just now"), `longAge` ("5 minutes ago"),
  `duration` ("2h 5m") and `elapsed`.
- `@wy3z/bb-suite/git`: finds a trustworthy `git` (or another tool, with
  `findExecutable`) on hosts where it isn't in `/usr/bin`, such as NixOS,
  Guix and Homebrew. `PATH` entries must not be group or world writable and
  must belong to the user or root; known install folders follow. On Windows it
  checks Git for Windows' install folders, then `PATH`. `gitBinary()` caches
  the result, and `missingToolMessage(name)` words the error.
- `@wy3z/bb-suite/menu-keyboard`: `useMenuKeyboard(rootRef, open, close)`
  and its helpers, arrow-key and Escape handling for the suite's menus.
- `@wy3z/bb-suite/tokens.css`: the suite palette (`--bbs-*`) and pill metrics.
- `@wy3z/bb-suite/settings`: the settings kit every plugin page uses, drawn to
  match BB's own plugin settings card: `SettingsCard`, `SettingsRow` (label,
  help text, control inline or `placement="below"`), `SettingsToggleRow`,
  `SettingsSelectRow`, `SettingsSwitch`, `SettingsSelect`, `SettingsButton`,
  `SettingsLinkButton` (an in-app link, such as `/settings/appearance`) and
  `DEVICE_ONLY`. Import `@wy3z/bb-suite/settings.css` with it. It uses BB's
  theme variables (`--border`, `--input`, `--surface-recessed`,
  `--subtle-foreground`), not Tailwind classes, so it doesn't depend on which
  classes BB's build happens to include.

## Git safety

A checkout's `.git/config` can name programs that git runs on its own: an
fsmonitor, filter, diff and merge drivers, hooks, a pager, a signing program
behind `log.showSignature`, credential helpers and transports such as `ext::`.
A folder from an archive, a shared drive or another user can carry that config,
so the suite never runs plain `git` in a checkout. `git-safety.ts` has three
modes.

**Read-only** (`GitSession.read`). The full Files protection:

- `--no-optional-locks` and `--no-pager`, so reads never write the index.
- `core.fsmonitor`, `diff.external` and `credential.helper` emptied,
  `core.hooksPath` pointed at a path that can't exist,
  `submodule.recurse=false` and `log.showSignature=false`.
- Every `filter`, `diff`, `merge` and `hook` entry from `git config --list` is
  switched off with `-c`. If a name can't be expressed that way (it contains
  `=`, isn't UTF-8, or there are too many), the session refuses to open.
- `GIT_ALLOW_PROTOCOL=none` and `GIT_NO_LAZY_FETCH=1`, so a partial clone
  can't fetch through a transport the repository chose.
- Inherited `GIT_*` variables dropped and `PATH` pinned to trusted folders.
- Scope `user` (Pull Requests and Projects) keeps the user's global and system
  config, including `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and
  `GIT_CONFIG_NOSYSTEM`, so `safe.directory`, `insteadOf` and ignore rules
  apply as in a terminal. That config is the user's own, and the overrides
  above still beat it. Scope `isolated` (Files) also skips it by pointing
  `HOME`, `XDG_CONFIG_HOME` and `GIT_CONFIG_*` nowhere.

**User action** (`GitSession.action`). Runs git the way the user's terminal
would: their environment, `PATH` (minus relative entries), global and system
config, credentials, remotes and identity. Inherited repository-location and
config-injection variables (`GIT_DIR`, `GIT_INDEX_FILE`,
`GIT_CONFIG_PARAMETERS` and the like) are dropped; `GIT_AUTHOR_*`,
`GIT_COMMITTER_*`, `GIT_SSH*`, `GIT_ASKPASS`, `GIT_SSL_*`, `GIT_HTTP_*`,
`GIT_PROXY_*`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and
`GIT_CONFIG_NOSYSTEM` are kept. Switched off because no action needs them: the pager,
fsmonitor, `diff.external`, every diff driver's `textconv` and `command`, every
merge driver, `log.showSignature`, and the `ext::` transport. Hooks stay on or
go off per action (`hooks`), and an action can also refuse lazy fetches
(`lazyFetch: false` sets `GIT_NO_LAZY_FETCH=1`) and index writes
(`optionalLocks: false`). Filters always stay on, because they change the
bytes: without them Git LFS files would be committed whole and git-crypt files
committed in plain text.

The "anything to commit?" check before Commit and Create PR is a `git status`
with that action policy: filters on, hooks off, no lazy fetch, no index write.
With filters off, a Git LFS or git-crypt file whose timestamps changed (after a
`touch`, an editor save or a copy of the checkout) would look modified, and
Create PR would refuse a tree with nothing to commit.

**CLIs** (`cliGitEnv`). `gh` and `glab` run git themselves, so the same
overrides travel in `GIT_CONFIG_PARAMETERS`. With `repository: false`,
`GIT_DIR` points nowhere, so the CLI's git can't open any repository at all.
In `read` mode the CLI's git gets the read-only protection with the user's
config. In `action` mode it can still fetch missing objects with the user's
credentials, and every hook and driver is off.

### What can still run

| Action | Still runs | Why |
|---|---|---|
| "Anything to commit?" check before Commit and Create PR (`git status`) | Clean and process filters on files whose timestamps changed | Without them a filtered file looks modified. Both actions run the same filters and hooks moments later. |
| Commit (`git add`, `git commit`) | The repository's hooks (`pre-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`, `post-index-change`, `reference-transaction`, config-defined hooks), clean filters on staged files, the signing program when signing is on, and a partial clone's lazy-fetch transport (the repository's `uploadpack`, `core.sshCommand`, URL helpers) | Hooks on an explicit commit are git's contract (husky, pre-commit, Git LFS). Filters decide what gets committed. Signing and fetching follow the user's config, which can be per repository. |
| Push | `pre-push` and `reference-transaction` hooks, `core.sshCommand`, credential helpers, `core.askPass`, `remote.<name>.receivepack` on a local remote, and remote helpers named by the URL | Git LFS uploads from `pre-push`. A per-repository SSH key or credential helper is common and is the user's push credential. |
| Apply locally (`git apply` in the target, the patch build in the source) | Clean and smudge filters on the files the patch touches. On Git older than 2.45, a partial clone's lazy-fetch transport (the repository's `uploadpack`, `core.sshCommand`, URL helpers) | Without the filters an LFS or git-crypt file can't match its preimage or is written in the wrong form. Hooks are off: neither step is a commit. Apply sets `GIT_NO_LAZY_FETCH=1`, so a missing base object makes it fail instead of fetching, but Git only honours that variable from 2.45. |
| `gh pr create --fill --head` | A partial clone's lazy-fetch transport (the repository's `uploadpack`, `core.sshCommand`, URL helpers) when gh's `git log --cherry` needs a missing object | `--head` means gh doesn't push or run `git status` (gh source, `pkg/cmd/pr/create`). Hooks and drivers are off. Create PR has already pushed with hooks on by then. |

The hostile repository in `test/hostile-git.ts` sets every one of these knobs.
Each plugin's tests show that plain git runs its code, that every read-only
path runs none of it, and which markers each user action leaves.

## Settings pages

Every plugin has a page under Settings → Plugins, and they all look the same:

- **Where a setting lives.** Anything the server or an agent reads, and
  secrets, go in `bb.settings.define`; BB draws those rows itself. Looks that
  only change this browser go in localStorage and their help text ends with
  `DEVICE_ONLY` ("This device only."). View state (sorting, grouping, filters)
  stays in the surface's own view menu.
- **Layout.** One `SettingsCard` per `app.slots.settingsSection`. Give the
  section a `title` when the page has more than one; leave it off for a single
  card.
- **Rows.** Booleans use `SettingsToggleRow`, never a bare checkbox. Three to
  five choices use `SettingsSelectRow`. Visual choices (icon packs) may use
  cards inside a `SettingsRow` with `placement="below"`.
- **Labels.** Sentence case, units in brackets at the end: "Check every
  (seconds)".
- **Help text.** One or two sentences on what changes, ending with the default:
  "On by default.", "60 by default."
- **Nothing to set.** The page still has one row saying where the options live,
  with a `SettingsLinkButton` when they live on another settings page.

Each plugin's tsconfig maps `@get-bb/plugin-sdk` and `zod` to its own copy, so
shared files type-check against the same SDK as the plugin.
