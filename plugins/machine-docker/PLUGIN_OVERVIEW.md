Docker Sandbox gives a BB thread its own local Docker container as a machine. It is built on `registerSandboxBackend` from `@wy3z/bb-suite/machine-backend/server`, which does the BB side (machine provider, composed environment, idle sweep, TTL renewal, allocation ledger, launch check); this plugin supplies only the Docker calls.

## For agents

### CLI, agent tools, MCP and RPC

None of its own. Use BB's commands:

```sh
bb thread spawn --project <id> --environment-provider docker-sandbox \
  --environment-inputs '{"branch":{"kind":"new","baseBranch":"main"}}' --prompt "..."
bb machine create --provider docker-sandbox
bb machine list --all
bb machine provider-cli status <machine>
bb machine suspend <machine>
bb machine resume <machine>
bb machine remove <machine>
bb browser-automation open --backend local --headless --machine <machine> --json
```

### Ids

| Thing | Id |
|---|---|
| Plugin | `machine-docker` |
| Machine provider | `docker-sandbox` |
| Composed environment provider | `docker-sandbox` (machine `docker-sandbox` + environment `project-checkout`) |
| Sweep schedule | `docker-sandbox-sweep`, every minute |

Machine inputs: none. Every option is a plugin setting.

### Settings

| Key | Type | Default | Meaning |
|---|---|---|---|
| `image` | string | `""` | Empty uses the built-in image. Otherwise any image with `sh`, Node.js 22.19+, `curl`, `git` and `ps`; pulled if missing |
| `cpus` | number | `2` | `docker --cpus` |
| `memoryGb` | number | `4` | `--memory` and `--memory-swap` (swap off) |
| `shmMb` | number | `1024` | `--shm-size`; Chromium needs more than Docker's 64 MB |
| `idleMinutes` | number | `15` | Suspend after this long without thread or terminal activity; `0` off |
| `ttlHours` | number | `2` | Container stops itself this long after start unless renewed; `0` off |
| `maxConcurrent` | number | `2` | Running sandboxes allowed; suspended ones don't count; `0` no limit |

There is no spend cap: local containers cost nothing.

### What it creates

| Resource | Name | Labels |
|---|---|---|
| Container | `bb-docker-<key slug>` | `app.getbb.docker-sandbox=1`, `app.getbb.docker-sandbox.name=<name>`, `app.getbb.docker-sandbox.key=<key>` |
| Network | `bb-docker-sandbox`, bridge, subnet `10.213.89.0/24`, inter-container traffic off. Adopted only if it has this label, `enable_icc=false` and that subnet; removed by ID | `app.getbb.docker-sandbox=1` |
| Probe container | throwaway `--rm` container on the network, from the pinned Node base image | `app.getbb.docker-sandbox-probe=1` |
| Built-in image | `bb-docker-sandbox:<dockerfile hash>` (agents layer) and `bb-docker-sandbox:base` (no agent CLIs) | `app.getbb.docker-sandbox-image=1` |

Containers run as the image user (`node` in the built-in image) with `--init`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 4096`, no bind mounts, no named volumes (anonymous ones from an image's `VOLUME` go with `--volumes`), no published ports and no environment variables beyond the image's. Secrets reach the container only through BB: the enrolment bundle on `docker exec` stdin and Machine environment values delivered to the daemon at run time.

PID 1 is a small shell loop that exits at the deadline in `/tmp/.bb-sandbox-expires-at`, written at start and on every TTL renewal. When it exits the container stops, which BB sees as compute gone; `bb machine suspend` then records it as suspended and `resume` starts it again.

The built-in Dockerfile has two stages. `base` is Debian, Node, git, gh, Chromium and fonts, ending as `USER node`. `agents` is `FROM base` with one layer per CLI, each installed by `node` into `/home/node/.local` with `npm install --global` at a pinned version: `@anthropic-ai/claude-code@2.1.319`, then `@openai/codex@0.159.0` (BB 0.49's own sandbox pin; BB's Codex provider needs at least 0.136.0). Nothing runs as root after `base`. To extend it, build on `FROM bb-docker-sandbox:base` or on the agents tag, switch to `USER root` for packages, back to `USER node` at the end, and set **Image** to your tag.

### Lifecycle

| BB action | Docker |
|---|---|
| create | build or pull the image, `docker run`, then BB's bootstrap through `docker exec -i` |
| suspend | `docker stop`; no snapshot, the stopped container keeps its filesystem |
| resume | `docker start`, rewrite the TTL deadline, then `--start` the installed daemon (no reinstall) |
| remove | `docker rm --force --volumes` every container with the name label, then the network by ID once no labelled container is left. Network create and remove are serialised so a remove can't delete the network between another create's check and its `docker run` |
| reconcileCleanup | the same lookup by name label |

### Reaching BB

The daemon dials out to BB's machine address, usually bb Connect, over the bridge network's normal outbound route. A server bound to loopback is not reachable from a container.

### Host and LAN access (fails closed)

A bridge network routes to the host and the LAN. Published host ports are reachable from a sandbox even with ufw's default-drop input policy, because Docker handles that traffic before the input rules. `availability()` therefore runs a probe container on `bb-docker-sandbox` (cap-drop ALL, `no-new-privileges`, user `node`, 128 MB, 64 pids). It tries TCP to: the network gateway on a closed port; each private host address; every non-loopback published TCP port at the gateway and those addresses; and the LAN default gateway on 53, 80 and 443. A connect or a refusal counts as reachable; only a timeout or unreachable counts as blocked. Any reachable target, or a probe that can't run, returns `setup-required` with the targets that answered. The result is cached for ten minutes. Blocking that traffic is a host change (root) the plugin never makes.

### Keepalive and TTL

PID 1 keeps the deadline in a shell variable set from the TTL at start. `/tmp/.bb-sandbox-expires-at` can only push it later, so deleting or corrupting the file never disables the TTL. TTL `0` sets an explicit `none` sentinel and the file is ignored. Resume and the sweep's renewals write a later deadline into the file.

### Custom images

**Image** must match `^[a-z0-9][A-Za-z0-9._/:@-]*$` (max 256 characters) in both the settings page and the runtime check, so it can never be read as a `docker` flag. At create the plugin reads the image's `Config.User` and refuses root, `0` or no `USER`.

### Agent CLIs and logins

Claude Code and Codex are baked into the built-in image, so `bb machine provider-cli status` reports both installed on a new sandbox and its first turn starts without an install. BB never installs CLIs when a thread starts, so the plugin's `message.dispatch` handler covers the rest. When a turn targets an active Docker Sandbox host, it reads `hosts.providerCliStatus` for the requested provider (4 s budget; if the status can't be read, the turn proceeds). If the CLI is missing it answers `wait`, runs `hosts.installProviderCli` in the background, and calls `recheck` when that finishes. A failed install, or a provider BB has no installer for, rejects the turn with the `bb machine provider-cli install` command to run. BB doesn't tell machine `create` which provider a thread needs; dispatch is the first point that knows. The same handler runs the shared cloud-login check first.

| Provider | Login in a sandbox (enforced by the launch check) |
|---|---|
| `claude-code` | `CLAUDE_CODE_OAUTH_TOKEN` in Machine environment (`claude setup-token`, then `bb machine env set CLAUDE_CODE_OAUTH_TOKEN [--project <id>]`, value on stdin), or Claude routed through the Account Pooler |
| `codex` | Account Pooler with a usable Codex account (`bb pool account add --provider codex --login`) and `bb pool routing codex`. BB's Codex provider reads `~/.codex/auth.json` or the pooled `CODEX_OPENAI_BASE_URL` and `CODEX_POOL_AUTH_TOKEN`; copying `auth.json` into a sandbox is not supported |
| `acp-opencode`, `pi` | `OPENCODE_API_KEY` in Machine environment |
| any | GitHub: BB's forwarded `gh` login or a `GH_TOKEN` row |

### Finding the thread's own machine

Sandboxes are ephemeral, so plain `bb machine list` hides them. Inside a sandbox thread use `bb machine list --all`, or the host of the thread's environment (`bb environment show <id> --json`). Passing `arch` to `--machine` drives the server's browser, whose `localhost` is not the sandbox.

### Browser automation

The built-in image installs Debian's `chromium`, which Browser Automation finds on `PATH`. It launches Chromium with `--no-sandbox`, so the container's own isolation is the sandbox; no capability or seccomp change is needed. The first `open` downloads DevBrowser from GitHub into the container. Screenshots are written to the container's `/tmp`; a thread running in the same container reads them directly, genui's `Image("/tmp/...")` loads them through BB from the environment's host, and `bb tasks attachment add --file <path>` uploads from the thread's machine. Nothing has to be copied off the container.
