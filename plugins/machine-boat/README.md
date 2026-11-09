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
- Nothing from your boat account reaches the VM by default: no boat CLI key, no boat GitHub app token, no boat secrets or agent logins. BB supplies the logins it needs. boat always leaves its own `ASCII_TOKEN` on the VM; it can only publish the VM's own ports on public URLs, so anything running on the VM can expose itself.

Configure it under **Settings → Plugins → Boat Sandbox**: API key, size, boat environment, idle minutes, TTL hours, max concurrent, monthly cap and the 14-day keep.

### Agent logins

A VM has no logins of its own, and BB checks before a turn starts that the agent can sign in there:

- **Claude Code:** run `claude setup-token`, then `bb machine env set CLAUDE_CODE_OAUTH_TOKEN --project <id>` with the token on stdin. Routing Claude through the Account Pooler works too.
- **Codex:** enable the Account Pooler, add a Codex account with `bb pool account add --provider codex --login`, and turn routing on with `bb pool routing codex`.
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
