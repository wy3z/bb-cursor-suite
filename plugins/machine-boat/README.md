# BB Boat Sandbox

Run BB threads in [boat.dev](https://boat.dev) cloud VMs. Each VM is a BB machine with its own daemon, a fresh project checkout and a branch of its own, so an agent can install, build, run services in Docker, start a dev server and drive a headless browser without touching your computer. Cloud threads stay ordinary BB threads: same composer, same history, same tools.

## Who it's for

Anyone who wants agents off their own machine: long or parallel work, untrusted repositories, or threads that should keep running while the laptop sleeps. You need a boat.dev account (the free trial works) and a BB server that machines can reach, which normally means bb Connect.

## What you get

- **Boat Sandbox** in the environment picker and in `bb thread spawn --environment-provider boat-sandbox`. BB creates the VM, installs its daemon, clones the project, checks out a new branch and starts the thread. A new VM is ready in about 15 seconds.
- A real Ubuntu 24.04 VM per thread: root through passwordless `sudo`, systemd, Docker with Compose, `/dev/kvm`, Node 24, git, `gh`, Google Chrome, and Claude Code and Codex preinstalled by boat at their latest releases.
- Headless browser checks on the VM: `bb browser-automation open --backend local --headless --machine <vm>` starts Chrome there, so an agent can test a dev server running beside it, take screenshots, show them inline and attach them to tasks.
- Suspend and resume. Suspend is boat's stop, which snapshots the disk and stops billing; resume brings the same VM back from that snapshot and restarts the daemon without reinstalling anything.
- Cost guards, all in the plugin settings: idle suspend after 15 minutes, a 2-hour auto-stop that boat enforces even if BB is down (renewed while a thread is active, never past the cap), 2 VMs at once, and a $30 monthly cap checked against boat's own meter before every create and resume and on every minute's sweep. If boat's meter can't be read for 10 minutes, new and resumed VMs are refused and no auto-stop is extended until it can.
- Agent logins come from your boat account: connect Claude (and ChatGPT for Codex) on boat.dev and name a boat environment that passes only Agents credentials. With the environment setting empty, nothing from your boat account reaches the VM: no logins, no boat CLI key, no boat GitHub app token, no boat secrets. boat always leaves its own `ASCII_TOKEN` on the VM; it can only publish the VM's own ports on public URLs, so anything running on the VM can expose itself.

Configure it under **Settings → Plugins → Boat Sandbox**: API key, size, boat environment, idle minutes, TTL hours, max concurrent, monthly cap and the 14-day keep.

### Agent logins

Keep agent logins on boat.dev, not in BB. Before each turn BB checks that the agent can sign in on the VM.

Do these in order. Removing the BB env var any earlier leaves cloud Claude threads with no login.

1. Install this version of the plugin (`bb plugin update machine-boat`, or the install command below).
2. On boat.dev, open **Agents & Proxying** and click **Sign in** on the Claude row (Pro or Max). Do the same on the ChatGPT row if you run Codex in cloud threads. Then, on the **Environment** page, add an environment for BB, for example `bb`. Turn **Safe for third parties** off, since these VMs are just for you. Turn **GitHub**, **Secrets** and **boat credentials** off and leave **Agents credentials** on. Don't add repositories, variables or secret files. From a signed-in boat CLI: `boat env new bb`, then `boat env set bb --safe-for-third-parties false --github false --secrets false --boat-credentials false --agents-credentials true`.
3. In BB, set **Settings → Plugins → Boat Sandbox → boat environment** to `bb`.
4. Delete your existing Boat Sandbox VMs: find them with `bb machine list --all` and remove each with `bb machine remove <id>`. A VM keeps the environment it was created in, and VMs made before this setup have none, so they would never get a login.
5. If you put `CLAUDE_CODE_OAUTH_TOKEN` in BB's machine env before, remove it with `bb machine env unset CLAUDE_CODE_OAUTH_TOKEN` (add `--project <id>` if you set it for one project).

Your default `base` environment works too, as long as only Agents credentials is on. A separate environment is the safer habit, because `base` is what every other sandbox on your boat account gets.

**Why not BB's machine env.** BB's global and project machine env reach every machine, including the computer BB itself runs on. There, a `claude setup-token` token takes over from your own Claude Code login. That token can only run models, so BB's usage panel shows Claude Code as signed out and loses your plan limits.

**Why "just me" and not "Safe for third parties".** Safe for third parties withholds every login. boat's AI credentials proxy can then give the VM placeholder keys instead, but the plugin doesn't support that mode: it hasn't been tested with BB's agents, so the plugin treats a Safe for third parties environment like one with Agents credentials off.

**What else an environment brings.** Each switch you leave on adds to every new VM:

- **GitHub:** boat's GitHub app token, a `gh` login in `~/.config/gh/hosts.yml`, git credentials, the environment's repositories and their setup scripts. BB forwards its own GitHub login already, so leave this off.
- **Secrets:** the environment's variables and secret files.
- **boat credentials:** a boat API key in `~/.config/ascii/boat/config.json` that lets the VM snapshot, stop and resume itself. Anything running on the VM can use it, so leave it off.
- **Agents credentials:** the agent logins you connected.

A change reaches new VMs only. A VM keeps the environment version it started with until you run `boat env upgrade bb` or press **Upgrade** on boat.dev.

**How the login reaches BB's agents.** boat hands the Claude login to the VM as `CLAUDE_CODE_OAUTH_TOKEN` in the environment of its own commands only: not in a file, and not to systemd services. BB's daemon is a systemd user service, so on every create and resume the plugin runs one boat command that copies the login variables, by name, into the VM's systemd user manager. The plugin's copy stays in memory and never passes through BB. If BB's daemon is running without it, or with an older value (say, after you reconnect Claude on boat.dev), the plugin restarts the daemon, but only while the VM is resuming or has just been created, before BB can start a turn there. The comparison happens on the VM and only the daemon's unit name comes back. On a VM that was already running, the daemon keeps what it has until you suspend and resume it. Every agent process on the VM can read the login, as with any login an agent uses.

**The login does reach the VM's disk, through boat.** boat keeps it in `/run/ascii-secrets/env.sh` (mode 600). On every resume it also writes it into `~/.pi/agent/auth.json` and `~/.prime/agent/auth.json` for its own pi and Prime Agent harnesses. Those two files are on disk, so a VM that has been resumed once carries your Claude login in its snapshots, including the 14-day keep snapshots, until the VM is deleted. The plugin leaves them alone: boat rewrites them on every resume and saves the disk every minute, so removing them wouldn't keep them out of snapshots and would break boat's own harnesses. If that matters to you, delete VMs when you're done with them rather than keeping them stopped, and set **Keep stopped sandboxes after (days)** (`keepStoppedDays`) to 0 so the plugin's 14-day keep doesn't save extra snapshots that carry the login.

**What BB checks.** On a running VM it looks at the VM itself, by name and never by value: Claude counts when BB's daemon has `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, or `~/.claude/.credentials.json` exists; Codex counts when `~/.codex/auth.json` exists. A login it found is remembered for 5 minutes. On a suspended VM it reads the environment that VM was created in, not the setting, and blocks the turn when that can't be read, the VM has no environment, or the VM is on an older version of it. Before a VM exists there's nothing to look at, so it checks that the environment in the setting exists, is not Safe for third parties and passes Agents credentials. When a VM in a named environment then gets no login from boat, or the environment also passes GitHub, Secrets or boat credentials, the plugin says so in the thread's progress and BB's log. The Account Pooler still works for both agents. Codex through boat follows boat's docs, which say a ChatGPT login arrives as `~/.codex/auth.json` (confirm): no ChatGPT login was connected when this was tested, so it hasn't been seen on a live VM.

- **GitHub:** BB's forwarded `gh` login, unless the project sets its own `GH_TOKEN`. A fine-grained token scoped to the one repository is the safer choice for anything beyond a trial.

Claude Code and Codex come with boat's image. For any other provider the plugin installs the CLI through BB when the first turn reaches the VM; the message waits as "Installing … on Boat Sandbox …" and sends itself when the install finishes.

### The API key

Create the key from a signed-in boat CLI with `boat api-key create bb --preset ci --ttl never`, or in the boat.dev dashboard. Without `--ttl` a key expires after 90 days, and an expired key can't be rotated.

- A `ci` key can create sandboxes but delete only the ones it created itself. If you ever replace the key with a new one, the new key gets 403 when BB removes VMs the old key made, and you delete those on boat.dev instead.
- To change the secret (for example after a leak), use `boat api-key rotate <key id>`, which keeps the key's id, scope and ownership. Rotation needs a browser sign-in on the boat CLI or the dashboard.
- The plugin reads your plan and limits when the key allows it; without that it still works and skips those checks.

The key is a secret setting: it lives in a 0600 file in BB's data folder, never in the database, the browser, machine records or logs.

### Costs

boat bills per second while a VM runs: `small` (2 vCPU, 4 GB) is $0.018 an hour and `default` (4 vCPU, 8 GB) $0.036. A stopped VM costs nothing. A plan's price comes back as machine time: the $20 plan covers about 555 hours of `default` or 1,100 of `small` a month. `bb boat usage` shows this month's spend from boat's meter next to BB's own estimate and the cap.

## Installation

```sh
bb marketplace add git:github.com/wy3z/bb-cursor-suite@main --subdirectory marketplace
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.1.0 --plugin machine-boat --tag-prefix machine-boat/
```

Needs BB `>=0.49`, plugin SDK `>=0.6.132`, a boat.dev account and a BB server that VMs can reach (bb Connect, or a public URL set as the machine address). Check the connection without starting a VM:

```sh
bb boat account inspect
```

This plugin is experimental and on 0.1.x, so its install range only follows patch releases until it reaches 1.0.

## For agents

The machine provider, settings, CLI commands, RPC, labels and lifecycle are in [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md#for-agents).

## Development

```sh
npm install
npm run suite -- check machine-boat
bb plugin install ./plugins/machine-boat --yes
```

## License

[MIT](LICENSE)

---

Not affiliated with, endorsed by or sponsored by boat.dev.
