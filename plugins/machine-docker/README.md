# BB Docker Sandbox

Run BB threads in local Docker containers. Each container is a BB machine with its own daemon, a fresh project checkout and a branch of its own, so an agent can install, build, run a dev server and drive a headless browser without touching your own checkout. It is the free, local twin of the cloud sandbox plugins: same lifecycle, no account and no bill.

## Who it's for

Anyone who wants agents in throwaway machines before paying for cloud ones, or who wants threads isolated from their own workstation. You need Docker on the computer that runs the BB server, and the user running BB must be able to use it.

## What you get

- **Docker Sandbox** in the environment picker and in `bb thread spawn --environment-provider docker-sandbox`. BB creates the container, installs its daemon, clones the project, checks out a new branch and starts the thread.
- A built-in Debian image with Node 22, git, gh, ripgrep, Chromium and fonts, plus Claude Code 2.1.319 and Codex 0.159.0 baked in, so a new sandbox's first turn starts straight away. Point **Image** at your own image if you prefer.
- Headless browser checks inside the container: `bb browser-automation open --backend local --headless --machine <sandbox>` starts Chromium there, so the agent can test a dev server running in the same container and take screenshots.
- Limits on every container: CPUs, memory with swap off, shared memory, process count, all Linux capabilities dropped, `no-new-privileges`, and no host mounts, Docker socket or published ports.
- Idle stop, a TTL backstop the container enforces itself, and a cap on running sandboxes. Suspend stops the container in place; resume starts it and reconnects the daemon without reinstalling.
- Every container and network the plugin makes carries an `app.getbb.docker-sandbox` label, and built images carry `app.getbb.docker-sandbox-image`, so cleanup finds exactly what it created. Older built images are pruned after each rebuild.

Configure it under **Settings → Plugins → Docker Sandbox**: image, CPU limit, memory limit, shared memory, idle minutes, TTL hours and max concurrent.

### How the container reaches BB

The daemon dials out to BB's machine address. The BB server listens on loopback, so containers reach it through bb Connect, the same way a cloud machine does. Nothing uses host networking, and nothing listens inside the container.

### Host and LAN access

Sandboxes run on their own bridge network, `bb-docker-sandbox` (`10.213.89.0/24`, traffic between sandboxes off). A bridge network still routes to your host and your LAN: a sandbox can reach ports other containers publish on the host (a local database, for example) and devices on your network. Docker sends published-port traffic around the host firewall's input rules, so a default-drop firewall such as ufw does not stop it.

Before it offers sandboxes, the plugin starts a throwaway container on that network and tries the network's gateway, the host's addresses, every published host port and your LAN router. If any of them answers, Docker Sandbox reports **setup required**, names what answered, and creates nothing. The check repeats every ten minutes. It only lifts once that traffic is blocked on the host, which needs root and a decision about how; the plugin never changes your firewall.

### Agent logins and CLIs

A sandbox has no logins of its own, and BB checks before a turn starts that the provider can sign in there:

- **Claude Code:** run `claude setup-token` on the server's computer, then set the result with `bb machine env set CLAUDE_CODE_OAUTH_TOKEN --project <id>`, value on stdin. Routing Claude through the Account Pooler works too.
- **Codex:** use the Account Pooler. Enable the Account Pooler plugin, add a Codex account with `bb pool account add --provider codex --login`, and turn routing on with `bb pool routing codex`; BB then hands the sandbox a pooled endpoint and token. Copying `~/.codex/auth.json` into a sandbox isn't supported.
- **GitHub:** BB's forwarded `gh` login, unless the project sets its own `GH_TOKEN`.

Claude Code and Codex are already in the built-in image. For any other provider, or a custom image without one, the plugin installs the CLI through BB when the first turn reaches the sandbox; the message waits as "Installing … on Docker Sandbox …" and sends itself when the install finishes. Sandboxes are ephemeral, so `bb machine list` only shows them with `--all`.

## Installation

```sh
bb marketplace add git:github.com/wy3z/bb-cursor-suite@main --subdirectory marketplace
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.1.0 --plugin machine-docker --tag-prefix machine-docker/
```

Needs BB `>=0.49`, plugin SDK `>=0.6.132` and Docker on the BB server's computer. The first sandbox builds the built-in image (about 2.6 GB with Chromium and both agent CLIs), which takes a few minutes.

This plugin is experimental and on 0.1.x, so its install range only follows patch releases until it reaches 1.0.

## For agents

No CLI commands, tools or RPC of its own. The machine provider, the composed environment, settings, labels and lifecycle are in [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md#for-agents).

## Development

```sh
npm install
npm run suite -- check machine-docker
bb plugin install ./plugins/machine-docker --yes
```

## License

[MIT](LICENSE)

---

Not affiliated with, endorsed by or sponsored by Docker, Inc. Docker is a trademark of Docker, Inc.
