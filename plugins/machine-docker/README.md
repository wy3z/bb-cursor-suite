# BB Docker Sandbox

Run BB threads in local Docker containers. Each container is a BB machine with its own daemon, a fresh project checkout and a branch of its own, so an agent can install, build, run a dev server and drive a headless browser without touching your own checkout. It is the free, local twin of the cloud sandbox plugins: same lifecycle, no account and no bill.

## Who it's for

Anyone who wants agents in throwaway machines before paying for cloud ones, or who wants threads isolated from their own workstation. You need Docker on the computer that runs the BB server, and the user running BB must be able to use it.

## What you get

- **Docker Sandbox** in the environment picker and in `bb thread spawn --environment-provider docker-sandbox`. BB creates the container, installs its daemon, clones the project, checks out a new branch and starts the thread.
- A built-in Debian image with Node 22, git, gh, ripgrep, Chromium and fonts. Agent CLIs install into the container user's `~/.local` the first time BB needs them. Point **Image** at your own image if you prefer.
- Headless browser checks inside the container: `bb browser-automation open --backend local --headless --machine <sandbox>` starts Chromium there, so the agent can test a dev server running in the same container and take screenshots.
- Limits on every container: CPUs, memory with swap off, shared memory, process count, all Linux capabilities dropped, `no-new-privileges`, and no host mounts, Docker socket or published ports.
- Idle stop, a TTL backstop the container enforces itself, and a cap on running sandboxes. Suspend stops the container in place; resume starts it and reconnects the daemon without reinstalling.
- Every container, network and image the plugin makes carries an `app.getbb.docker-sandbox` label, so cleanup finds exactly what it created.

Configure it under **Settings → Plugins → Docker Sandbox**: image, CPU limit, memory limit, shared memory, idle minutes, TTL hours and max concurrent.

### How the container reaches BB

The daemon dials out to BB's machine address. The BB server listens on loopback, so containers reach it through bb Connect, the same way a cloud machine does. Nothing uses host networking, and nothing listens inside the container. Without Connect, set **Settings → Machines → Server URL reachable by machines** to an address containers can reach and your firewall allows.

### Agent logins

A sandbox has no logins of its own. Before a thread starts in one, BB checks that the provider can sign in there: set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) with `bb machine env set --project <id>`, value on stdin, or route the provider through the Account Pooler. GitHub uses BB's forwarded `gh` login unless the project sets its own `GH_TOKEN`.

## Installation

```sh
bb marketplace add git:github.com/wy3z/bb-cursor-suite@main --subdirectory marketplace
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.1.0 --plugin machine-docker --tag-prefix machine-docker/
```

Needs BB `>=0.49`, plugin SDK `>=0.6.132` and Docker on the BB server's computer. The first sandbox builds the built-in image, which takes a minute or two.

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
