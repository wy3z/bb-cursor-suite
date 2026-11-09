Boat Sandbox gives a BB thread its own boat.dev cloud VM as a machine. It is built on `registerSandboxBackend` from `@wy3z/bb-suite/machine-backend/server`, which does the BB side (machine provider, composed environment, idle sweep, TTL renewal, allocation ledger, login guard, CLI install check); this plugin supplies the boat.dev calls. It also serves the suite's desktop routes through `registerDesktopProvider` from `@wy3z/bb-suite/desktop/server`. It has no pages of its own: the cloud UX, including the Desktop tab, lives in the suite's UI plugins, which read the RPC below.

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

Any caller BB authenticates can reach these methods, whether or not they are listed: the app, every plugin's frontend, the bb CLI, and agents on cloud machines through their machine's local bb proxy. A Claude agent on a boat VM ran `bb plugin rpc call machine-boat account.inspect` successfully. That is why the desktop is not on RPC.

| Method | Input | Output |
|---|---|---|
| `account.inspect` | `{}` | `{ available, message, providerId, login, plan, billingStatus, canStart, activeSandboxes, maxActiveSandboxes, includedHoursRemaining, includedPeriodEnd, walletUsd, sizes: [{ type, available, reason }] }`. Same `available`/`message` pair as Modal's `account.inspect`. |
| `usage.get` | `{}` | `{ providerId, month, capUsd, size, hourlyRateUsd, vendor: { usd, deletedUsd, sandboxes, running } \| null, vendorError, estimate: { runningMs, usd }, refusal }`. `vendor` is boat's own meter for sandboxes this plugin labelled, at list price; `estimate` is the shared helper's ledger, priced at each VM's own rate. `refusal` is the message create and resume would give right now (spend from either meter, an unreadable boat meter, or the concurrency limit), or `null`. |
| `machine.inspect` | `{ hostId }` | `{ providerId, hostId, name, sandboxId, state, running, size, vcpu, memoryGB, expiresAt, stoppedAt, snapshotCompletedAt, hydrated, health, desktopAvailable, monthUsd, keepSnapshot: { status, createdAt } \| null }`. `state` is boat's (`ready`, `idle`, `running`, `archiving`, `archived`, `error`) or `gone`. Refuses hosts of other providers. |

### Desktop routes (for the Desktop tab)

The suite's vendor-neutral desktop contract (`DESKTOP_ROUTES` in `@wy3z/bb-suite/desktop`), served as JSON `POST` routes under `/api/v1/plugins/machine-boat/http`, not as RPC:

| Route | Input | Output |
|---|---|---|
| `/desktop/status` | `{ threadId, clientId }` | `{ providerId, state, message, interactive, pausesAgent, control: { holder: "agent" \| "user", mine, agentPaused, since, expiresAt } }`. `state` is `ready`, `starting`, `stopped` or `unavailable`. |
| `/desktop/view` | `{ threadId, theme?: "light" \| "dark" \| null }` | `{ url, expiresAt }`: a fresh boat desktop URL (`https://<host>.on.boat.dev/stream.html?…#token=…`) and the time it must be opened by (boat's 10 minutes less 30 s). |
| `/desktop/control` | `{ threadId, clientId, action: "take" \| "renew" \| "release" }` | The `control` object above. |

- **Who can call.** Every route answers only requests that look like a BB app page's own `fetch`.
  - Through Connect, only a signed-in session passes: machine, OAuth and any other credential kind are refused. Connect sets that from the verified credential.
  - Everything also needs the browser's same-origin fetch metadata. That shuts out the bb CLI, `bb plugin rpc call` and other plugins' servers.
  - An agent on a cloud VM is shut out twice on its bb proxy:
    - Without browser headers, the routes answer 403 (tested from a boat VM).
    - With forged `Origin` or `Sec-Fetch-*`, BB's machine proxy itself refuses the request with an empty 403 before forwarding it (tested on live BB).
  - An agent that skipped the proxy and called Connect with the machine's own credential would be stamped `machine` by Connect and refused. That case is from BB's code; it wasn't observed live.
  - Other plugins' frontends share BB's page, so their `fetch` is genuinely same-origin and can reach the routes.
  - This is not a boundary against software on the BB server machine that forges browser headers; BB gives that software the user's full access anyway.
- **Scope.** A thread on another provider's machine, or on none, is refused.
- **The URL** goes straight back to the caller. It is never logged, stored, cached or put in an error, and `?token=`, `&token=` and `#token=` values are redacted from every boat error. Only https addresses on `*.on.boat.dev` are accepted.

Machine status itself comes from BB: `sdk.hosts.list()` / `bb machine list --all` give `machineProviderId`, `status` and `lifecycle.phase` (`active`, `suspending`, `suspended`, `resuming`, `removing`). The CLI commands print the same objects with `--json`; `bb boat account inspect` exits 1 when the account isn't usable.

### Settings

| Key | Type | Default | Meaning |
|---|---|---|---|
| `apiKey` | secret string | none | boat API key (`boat_…`). `boat api-key create bb --preset ci --ttl never`; rotate it with `boat api-key rotate <id>` rather than replacing it, because a `ci` key can only delete the sandboxes it created. Read without the rest of the settings, so a bad value elsewhere never blocks stop or delete |
| `size` | select | `small` | `small` 2 vCPU/4 GB $0.018/h, `default` 4/8 $0.036/h, `large` 8/16 $0.072/h (paid plans), `xlarge` 16/32 $0.20/h ($100 plan). Resume moves a stopped VM to the current size |
| `environment` | string | `""` | Empty creates VMs with `noEnv: true`. A name attaches that boat environment (its repos, variables, secret files, logins and the in-sandbox boat CLI key, per its own toggles). Validated in the settings form and again when a VM is created |
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

Created with `monitoring: false` (boat keeps no command history or output), `noEnv: true` unless an environment is set, the configured `type` and `ttlSeconds`, and an `Idempotency-Key` of the name plus a hash of the body, so a create retried after a lost response returns the same VM. boat keeps those keys for 24 hours; if a replay answers with a sandbox that no longer exists, the create retries once with a fresh key. Lookups use both labels and refuse a sandbox without them; resume refuses a sandbox whose labels don't match. Deletes go by sandbox id with boat's `X-Ascii-Confirm-Delete` header.

### Lifecycle

| BB action | boat.dev |
|---|---|
| create | refuse if the vendor spend is at the cap, `POST /sandboxes`, poll until `ready`, then BB's bootstrap over the command API |
| exec | `POST /sandboxes/{id}/commands` with `stream: true`, the argv quoted into `bash -lc` so nvm's Node is on `PATH`, timeout capped at boat's 600 s |
| suspend | `snapshot` returns `null`; `stop` is `POST /stop` and polls until `archived`. boat's stop snapshots the disk first, so the VM keeps its id and disk and costs nothing |
| resume | `POST /resume` with the TTL (and `type` if the size setting changed), poll until `ready`, then BB's `--start` of the installed daemon. A resume within 10 minutes of the stop reuses the same machine; later ones restore onto a new machine and IP |
| remove | delete every labelled sandbox with the name and any listed snapshot ids, then the keep snapshot if one exists. A 403 on a sandbox explains key ownership (a `ci` key can only delete what it created). A keep snapshot the key can't read or delete is logged with its name and doesn't block removal |
| reconcileCleanup | the same lookup by name label |
| TTL renewal | `PATCH /sandboxes/{id}` with `ttlSeconds` (deadline becomes now plus the TTL) |

Measured on the trial (`small`): create to connected daemon 11 s; composed thread provisioned (VM, daemon, clone, branch) in 15 s; suspend 3 to 5 s; resume within 10 minutes 4 s; resume after 10 minutes (new machine, new IP, disk restored) 8 s. A cold restore recreates symlinks, so their mtimes change; regular files keep theirs.

### How the enrolment secret travels

boat's command API has no stdin, and keeps every command and its output for 90 days unless monitoring is off. A command is retried only on boat's "restoring" error, which means it never ran; any other failure is reported as is. The executor therefore writes stdin to `/tmp/.bb-boat-stdin-<uuid>` through the files API, and the command is `exec <file && rm -f file && exec <argv>`, so the file is gone before the real command starts. If the command never runs, the plugin deletes the file. `/tmp` is not in boat snapshots. Monitoring is off for every VM as well.

### Daemon and agent CLIs

BB's installer puts the daemon under `~/.bb-machines/<server>` and runs it as a systemd user service (`linger` is on in boat's image), with `ExecStart` pinned to nvm's Node 24 in `/home/user/.nvm`. All of it is in the snapshot, so resume restarts it without reinstalling.

boat preinstalls `claude`, `codex`, `pi` and `cursor-agent` in `/usr/local/bin` and updates them to their latest releases when it prepares a machine. BB reports them installed with `installSource: external`. If a CLI disappears while a thread's agent runtime is loaded, the install check reinstalls it (into `~/.local/bin`) but that runtime keeps the old path until `bb thread stop`; a new turn after that uses the new one. The shared `message.dispatch` hook runs two checks on turns for this provider: the login guard (`CLAUDE_CODE_OAUTH_TOKEN` or the Account Pooler for Claude, the Account Pooler for Codex, `OPENCODE_API_KEY` for OpenCode and Pi, plus a GitHub credential), then the CLI install check, which installs a missing CLI in the background while the turn waits.

### Finding the thread's own machine

Composed machines are ephemeral, so plain `bb machine list` hides them. Inside a cloud thread use `bb machine list --all`, or the host of the thread's environment (`bb environment show <id> --json`). `--machine arch` drives the server's browser, whose `localhost` is not the VM.

### Browser automation

boat's image has `google-chrome-stable` (Chrome 151 when checked), which Browser Automation finds on `PATH`; no setup is needed. The first `open` downloads DevBrowser from GitHub onto the VM (about 30 s). Screenshots are written to the VM's `/tmp`. genui's `Image("/tmp/…")` loads them through the thread's machine, and `bb tasks attachment add <task> --file <path>` uploads from the thread's machine (or pass `--machine <host-id>` from outside a thread). boat's image has no colour emoji font; add `sudo apt-get install -y fonts-noto-color-emoji` to the project's `.bb-env-setup.sh` if screenshots need emoji.

### Desktop and computer use

Every boat VM runs a desktop, even with `noEnv`: Xorg on `:0` (1920x1080, lightdm), Chrome, and boat's computer-use daemon (`cua-driver.service`, a systemd user service). boat registers it as an MCP server named `computer` in `~/.claude.json` and `~/.codex/config.toml` at every start. A real Claude Code turn on a Boat Sandbox thread sees the `mcp__computer__*` tools (about 60, loaded through ToolSearch) with no BB change: `get_screen_size`, `list_apps`, `click`, `type_text`, `get_window_state` and the rest. The harness talks to `computer-mcp.py`, which runs `cua-driver mcp` against the daemon's socket `/run/ascii-cua/driver.sock`.

**The view.** The `/desktop/view` route calls `POST /sandboxes/{id}/desktop` (Moonlight over WebRTC, 1920x1080 at 60 fps; not `?vnc=1`, which stays a fallback). boat's stream page sends no `X-Frame-Options` or CSP, so the suite frames it, sandboxed to `allow-scripts allow-same-origin allow-pointer-lock` with no clipboard permission; input, video and Take Control were checked live in that sandbox. The token travels in the URL fragment, which the viewer removes at once; a stream already open keeps playing past the 10 minutes, and a reload or reconnect needs a new URL. `desktop_not_ready`, `sandbox_starting` and `provisioning: true` are retried every 2 seconds for up to 40 seconds.

**boat's viewer overlay is off on fine pointers.** Unless the Desktop tab says the viewer is on a touch screen (`touch: true` in the view request, sent for `pointer: coarse`), the view adds `overlay=0` to the stream URL's query, before the `#` fragment. That keeps boat's side panel (its arrow tab, reconnect and on-screen keyboard buttons) and stats text hidden, and the tab's bar is the only control. Reconnect is in that bar, and the keyboard reaches the VM because the tab focuses the frame when you take control. On a touch screen the overlay stays, because its keyboard button is the only way to raise a phone's soft keyboard inside the stream.

**Control.** The stream takes mouse and keyboard input. While a user holds control, the agent's computer tools are paused so they never fight them:

- **Take control** runs `systemctl --user freeze cua-driver.service` on the VM: a cgroup freeze, or `SIGSTOP` if freezing isn't available.
  - Calls already made, and new ones, block inside the daemon until the release, then complete. A `get_screen_size` issued while frozen answered 79 s later, right after the release.
  - With no `cua-driver` unit, nothing is paused. The control answer then says `agentPaused: false`, and the tab says the agent can still use the desktop.
- **The VM-side timer.** Before freezing, a transient timer, `bb-desktop-release`, is set to the lease plus 30 seconds (`AccuracySec=1s`). It thaws the daemon by itself if BB never releases (BB down, network lost).
  - Every renewal restarts it. If the timer can't be armed, the script thaws at once and the request fails.
- **Release** stops that timer and runs `thaw` (and `SIGCONT`).
- **Limits.**
  - Taking and renewing control both bump the idle sweep, so a hold isn't suspended at the 15-minute idle mark.
  - A hold ends after 2 minutes without a renewal, or after 30 minutes in total.
  - When the agent was paused, every thread on the VM with a turn running gets an agent-only note to take a fresh screenshot before its next computer action, since they all share the screen.
- **Codex.** Codex's MCP tool timeout defaults to 60 seconds, so a Codex call would fail rather than wait.
  - After every create and resume, the plugin installs `~/.local/share/bb-boat/codex-computer-timeout.sh` and a `bb-codex-computer-timeout.path` user unit that watches `~/.codex/config.toml`.
  - Whenever boat (re)writes that file, `tool_timeout_sec = 3600` is put straight under `[mcp_servers.computer]`. An existing value there is replaced; other servers are untouched.
  - A failure here is logged and never fails create or resume. Claude Code waits on its own.

Other notes:

- One screen per VM: parallel GUI threads on one VM fight over it, so keep one GUI thread per machine.
- A desktop, Chrome and an agent fit in `small`, but `default` is the comfortable minimum for GUI work.
- BB's own browser automation still runs its own headless Chrome, not the visible one on `:0`.

### The 14-day keep

boat keeps a stopped VM's disk for at least 14 days; after that an automated cleanup may delete it (boat says the job only reports candidates today), and resume would fail with `409 snapshot_data_expired`. The daily `boat-sandbox-keep` job saves a saved snapshot, named like the sandbox, for every labelled VM stopped longer than `keepStoppedDays` that doesn't already have one from its latest stop. When the disk is gone, resume creates a new VM from that snapshot only if it was taken from the expired VM itself (`sourceSandboxId`) on or after that VM's last stop; otherwise it refuses rather than roll back to older work. After a restore it deletes the expired VM and the snapshot. A normal resume deletes the keep snapshot, and remove does when one exists. Saved snapshots don't work on the free trial, and extras beyond the plan's allowance (10 per $20) cost $0.056 a day; failures are logged and the job moves on.

### Cost guards

- `maxConcurrent`, `monthlyCapUsd` and the hourly rate of `size` feed the shared policy. The helper records spend in USD at the rate each VM started or resumed at, so changing the size later never reprices past time.
- The plugin also implements the helper's `vendorSpendRefusal` hook from boat's own meter (`GET /sandboxes?label=app.getbb.boat-sandbox=1&state=<every state but cancelled>&include=cost,deletedCost`, cached for a minute). That figure counts this month's list-price time of every VM it labelled, stopped and deleted ones included, from any BB server using the same boat account.
- The helper consults both on create, resume, `validate`, `availability`, every auto-stop extension and every minute's sweep. At the cap it refuses create and resume, never extends an auto-stop, and asks core to suspend every running VM.
- If boat's meter can't be read and there is no reading from the last 10 minutes, create and resume are refused and no auto-stop is extended, but nothing is suspended; boat's own auto-stop then ends the VMs.
- `usage.get`'s `refusal` is the helper's full answer (both meters and the concurrency limit), so it matches what create would say.
- `availability` reports setup required without a key, with a rejected or expired key (with the `--ttl never` and rotate advice), when the account has no plan, or when the chosen size isn't available on the plan.

### Secrets

With `noEnv`, boat still leaves its own `ASCII_TOKEN` (plus `ASCII_PORT`, `ASCII_API_URL` and `BOAT_ID`) in the VM's command environment; boat says it can only host ports of its own sandbox. `~/.config/ascii/boat/config.json` holds no key.

The API key is a `secret: true` setting. It is sent only in the `Authorization` header and is redacted from every error, progress line and log, together with any `boat_…` key and `?token=`, `&token=` or `#token=` value. Machine inputs and the machine resource are checked for credential-like values by the shared helper. The desktop URL boat returns on sandbox reads is never copied anywhere, and the one the desktop view route asks for goes only to the BB app that asked.
