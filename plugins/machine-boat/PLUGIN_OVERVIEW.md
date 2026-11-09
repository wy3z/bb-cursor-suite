Boat Sandbox gives a BB thread its own boat.dev cloud VM as a machine. It is built on `registerSandboxBackend` from `@wy3z/bb-suite/machine-backend/server`, which does the BB side (machine provider, composed environment, idle sweep, TTL renewal, allocation ledger, login guard, CLI install check); this plugin supplies the boat.dev calls. It has no pages of its own: the cloud UX lives in the suite's UI plugins, which read the RPC below.

## For agents

### Commands

```sh
bb thread spawn --project <id> --environment-provider boat-sandbox \
  --environment-inputs '{"branch":{"kind":"new","baseBranch":"main"}}' \
  --provider claude-code --model <model> --prompt "..."
bb machine create --provider boat-sandbox
bb machine list --all
bb machine provider-cli status <machine>
bb machine suspend <machine>
bb machine resume <machine>
bb machine remove <machine> --yes
bb browser-automation open --backend local --headless --machine <machine> --json
bb boat account inspect [--json]
bb boat usage [--json]
bb boat machine inspect <host-id> [--json]
```

A composed spawn needs `--model` the first time: a new cloud machine has no catalog to read a default from.

### Ids

| Thing | Id |
|---|---|
| Plugin | `machine-boat` |
| Machine provider | `boat-sandbox` |
| Composed environment provider | `boat-sandbox` (machine `boat-sandbox` + environment `project-checkout`) |
| Schedules | `boat-sandbox-sweep` every minute; `boat-sandbox-keep` daily at 04:41 |
| CLI | `bb boat` |
| RPC contract | `boatRpcContract` in `lib/rpc.ts` |

Machine inputs: none. Every option is a plugin setting.

### RPC (for UI plugins such as BCS-95)

Call with `sdk.plugins.callRpc({ pluginId: "machine-boat", method, input, outputSchema })`. Every output carries `providerId: "boat-sandbox"`. Nothing returned is secret: no API key, no desktop or preview URLs with tokens.

| Method | Input | Output |
|---|---|---|
| `account.inspect` | `{}` | `{ available, message, providerId, login, plan, billingStatus, canStart, activeSandboxes, maxActiveSandboxes, includedHoursRemaining, includedPeriodEnd, walletUsd, sizes: [{ type, available, reason }] }`. Same `available`/`message` pair as Modal's `account.inspect`. |
| `usage.get` | `{}` | `{ providerId, month, capUsd, size, hourlyRateUsd, vendor: { usd, deletedUsd, sandboxes, running } \| null, vendorError, estimate: { runningMs, usd }, refusal }`. `vendor` is boat's own meter for sandboxes this plugin labelled, at list price; `estimate` is the shared helper's ledger. `refusal` is the message create and resume would give right now, or `null`. |
| `machine.inspect` | `{ hostId }` | `{ providerId, hostId, name, sandboxId, state, running, size, vcpu, memoryGB, expiresAt, stoppedAt, snapshotCompletedAt, hydrated, health, desktopAvailable, monthUsd, keepSnapshot: { status, createdAt } \| null }`. `state` is boat's (`ready`, `idle`, `running`, `archiving`, `archived`, `error`) or `gone`. Refuses hosts of other providers. |

Machine status itself comes from BB: `sdk.hosts.list()` / `bb machine list --all` give `machineProviderId`, `status` and `lifecycle.phase` (`active`, `suspending`, `suspended`, `resuming`, `removing`). The CLI commands print the same objects with `--json`; `bb boat account inspect` exits 1 when the account isn't usable.

### Settings

| Key | Type | Default | Meaning |
|---|---|---|---|
| `apiKey` | secret string | none | boat API key (`boat_…`). A `ci`-preset key plus `account.read` is enough |
| `size` | select | `small` | `small` 2 vCPU/4 GB $0.018/h, `default` 4/8 $0.036/h, `large` 8/16 $0.072/h (paid plans), `xlarge` 16/32 $0.20/h ($100 plan). Resume moves a stopped VM to the current size |
| `environment` | string | `""` | Empty creates VMs with `noEnv: true`. A name attaches that boat environment (its repos, variables, secret files, logins and the in-sandbox boat CLI key, per its own toggles) |
| `idleMinutes` | number | `15` | Suspend after this long without thread or terminal activity; `0` off |
| `ttlHours` | number | `2` | boat's auto-stop, renewed while a thread is active; `0` off (the trial caps it at 2 hours, and the plugin falls back to that) |
| `maxConcurrent` | number | `2` | Running VMs allowed; suspended ones don't count; `0` no limit |
| `monthlyCapUsd` | number | `30` | Refuse create and resume once this month's spend reaches it, and suspend running VMs; `0` no cap |
| `keepStoppedDays` | number | `12` | Save a saved snapshot for VMs stopped longer than this; `0` off |

Region: boat has no region choice. Every VM runs in Germany, Finland or France; boat says snapshot copies may be stored outside the EU.

### What it creates on boat

| Resource | Name | Labels |
|---|---|---|
| Sandbox | `bb-boat-<key slug>` (also its boat display name) | `app.getbb.boat-sandbox=1`, `app.getbb.boat-sandbox.name=<name>` |
| Saved snapshot (only from the keep job) | same as the sandbox name | none; found by name |

Created with `monitoring: false` (boat keeps no command history or output), `noEnv: true` unless an environment is set, the configured `type` and `ttlSeconds`, and an `Idempotency-Key` of the name plus a hash of the body, so a create retried after a lost response returns the same VM. Lookups use both labels and refuse a sandbox without them; resume refuses a sandbox whose labels don't match. Deletes go by sandbox id with boat's `X-Ascii-Confirm-Delete` header.

### Lifecycle

| BB action | boat.dev |
|---|---|
| create | refuse if the vendor spend is at the cap, `POST /sandboxes`, poll until `ready`, then BB's bootstrap over the command API |
| exec | `POST /sandboxes/{id}/commands` with `stream: true`, the argv quoted into `bash -lc` so nvm's Node is on `PATH`, timeout capped at boat's 600 s |
| suspend | `snapshot` returns `null`; `stop` is `POST /stop` and polls until `archived`. boat's stop snapshots the disk first, so the VM keeps its id and disk and costs nothing |
| resume | `POST /resume` with the TTL (and `type` if the size setting changed), poll until `ready`, then BB's `--start` of the installed daemon. A resume within 10 minutes of the stop reuses the same machine; later ones restore onto a new machine and IP |
| remove | delete every labelled sandbox with the name, any listed snapshot ids, and the keep snapshot |
| reconcileCleanup | the same lookup by name label |
| TTL renewal | `PATCH /sandboxes/{id}` with `ttlSeconds` (deadline becomes now plus the TTL) |

Measured on the trial (`small`): create to connected daemon 11 s; composed thread provisioned (VM, daemon, clone, branch) in 15 s; suspend 3 to 5 s; warm resume 4 s.

### How the enrolment secret travels

boat's command API has no stdin, and keeps every command and its output for 90 days unless monitoring is off. The executor therefore writes stdin to `/tmp/.bb-boat-stdin-<uuid>` through the files API, and the command is `exec <file && rm -f file && exec <argv>`, so the file is gone before the real command starts. If the command never runs, the plugin deletes the file. `/tmp` is not in boat snapshots. Monitoring is off for every VM as well.

### Daemon and agent CLIs

BB's installer puts the daemon under `~/.bb-machines/<server>` and runs it as a systemd user service (`linger` is on in boat's image), with `ExecStart` pinned to nvm's Node 24 in `/home/user/.nvm`. All of it is in the snapshot, so resume restarts it without reinstalling.

boat preinstalls `claude`, `codex`, `pi` and `cursor-agent` in `/usr/local/bin` and updates them to their latest releases when it prepares a machine. BB reports them installed with `installSource: external`. The shared `message.dispatch` hook runs two checks on turns for this provider: the login guard (`CLAUDE_CODE_OAUTH_TOKEN` or the Account Pooler for Claude, the Account Pooler for Codex, `OPENCODE_API_KEY` for OpenCode and Pi, plus a GitHub credential), then the CLI install check, which installs a missing CLI in the background while the turn waits.

### Finding the thread's own machine

Composed machines are ephemeral, so plain `bb machine list` hides them. Inside a cloud thread use `bb machine list --all`, or the host of the thread's environment (`bb environment show <id> --json`). `--machine arch` drives the server's browser, whose `localhost` is not the VM.

### Browser automation

boat's image has `google-chrome-stable` (Chrome 151 when checked), which Browser Automation finds on `PATH`; no setup is needed. The first `open` downloads DevBrowser from GitHub onto the VM (about 30 s). Screenshots are written to the VM's `/tmp`. genui's `Image("/tmp/…")` loads them through the thread's machine, and `bb tasks attachment add <task> --file <path>` uploads from the thread's machine (or pass `--machine <host-id>` from outside a thread). boat's image has no colour emoji font; add `sudo apt-get install -y fonts-noto-color-emoji` to the project's `.bb-env-setup.sh` if screenshots need emoji.

### Desktop and computer use (for BCS-90)

Every boat VM already runs a desktop, even with `noEnv`: Xorg on `:0` (1920x1080, lightdm), Chrome, and boat's computer-use daemon (`cua-driver.service`, a systemd user service). boat registers it as an MCP server named `computer` in `~/.claude.json` and `~/.codex/config.toml` at every start, so Claude Code and Codex threads on the VM may see `computer` tools with no BB change (confirm with a real turn). What BCS-90 still needs:

- A way to watch the desktop: `POST /sandboxes/{id}/desktop` returns a token-bearing stream URL that must be opened within 10 minutes. Add it as a client-only RPC that returns the URL to the app and never logs or stores it, and needs the `desktop` key action.
- One screen per VM: parallel GUI threads on one VM fight over it, so keep one GUI thread per machine.
- A decision on whether BB's own browser automation should drive the visible Chrome on `:0` instead of a headless one.
- Larger sizes: a desktop, Chrome and an agent fit in `small`, but `default` is the comfortable minimum for GUI work.

### The 14-day keep

boat keeps a stopped VM's disk for at least 14 days; after that an automated cleanup may delete it (boat says the job only reports candidates today), and resume would fail with `409 snapshot_data_expired`. The daily `boat-sandbox-keep` job saves a saved snapshot, named like the sandbox, for every labelled VM stopped longer than `keepStoppedDays` that doesn't already have one from its latest stop. Resume falls back to creating a new VM from that snapshot when the disk is gone, then deletes the old VM. A normal resume deletes the keep snapshot, and remove always does. Saved snapshots don't work on the free trial, and extras beyond the plan's allowance (10 per $20) cost $0.056 a day; failures are logged and the job moves on.

### Cost guards

- `maxConcurrent`, `monthlyCapUsd` and the hourly rate of `size` feed the shared policy, which refuses create and resume when a slot or the budget is gone, and suspends everything once the cap is reached.
- The plugin also reads boat's own meter (`GET /sandboxes?label=app.getbb.boat-sandbox=1&include=cost,deletedCost`, cached for a minute) and refuses create and resume, in `validate` and `availability` too, when this month's list-price spend for its own VMs reaches the cap. That figure counts VMs created by any BB server using the same boat account.
- `availability` reports setup required without a key, with a rejected key, when the account has no plan, or when the chosen size isn't available on the plan, and unavailable when boat won't start sandboxes or the cap is reached.

### Secrets

The API key is a `secret: true` setting. It is sent only in the `Authorization` header and is redacted from every error, progress line and log, together with any `boat_…` key and `?token=` value. Machine inputs and the machine resource are checked for credential-like values by the shared helper. The desktop URL boat returns on sandbox reads is never copied anywhere.
