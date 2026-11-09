Docker Sandbox gives a BB thread its own local Docker container as a machine. It is built on `registerSandboxBackend` from `@wy3z/bb-suite/machine-backend/server`, which does the BB side (machine provider, composed environment, idle sweep, TTL renewal, allocation ledger, launch check); this plugin supplies only the Docker calls.

## For agents

### CLI, agent tools, MCP and RPC

None of its own. Use BB's commands:

```sh
bb thread spawn --project <id> --environment-provider docker-sandbox \
  --environment-inputs '{"branch":{"kind":"new","baseBranch":"main"}}' --prompt "..."
bb machine create --provider docker-sandbox
bb machine list --all
bb machine provider-cli install <machine> claude-code
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
| Network | `bb-docker-sandbox`, bridge, inter-container traffic off | `app.getbb.docker-sandbox=1` |
| Built-in image | `bb-docker-sandbox:<dockerfile hash>` and `bb-docker-sandbox:base` | `app.getbb.docker-sandbox-image=1` |

Containers run as the image user (`node` in the built-in image) with `--init`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 4096`, no bind mounts, no volumes, no published ports and no environment variables beyond the image's. Secrets reach the container only through BB: the enrolment bundle on `docker exec` stdin and Machine environment values delivered to the daemon at run time.

PID 1 is a small shell loop that exits at the deadline in `/tmp/.bb-sandbox-expires-at`, written at start and on every TTL renewal. When it exits the container stops, which BB sees as compute gone; `bb machine suspend` then records it as suspended and `resume` starts it again.

The built-in image is layered for extension: build on `FROM bb-docker-sandbox:base`, switch to `USER root` for packages, back to `USER node` at the end, and set **Image** to your tag.

### Lifecycle

| BB action | Docker |
|---|---|
| create | build or pull the image, `docker run`, then BB's bootstrap through `docker exec -i` |
| suspend | `docker stop`; no snapshot, the stopped container keeps its filesystem |
| resume | `docker start`, rewrite the TTL deadline, then `--start` the installed daemon (no reinstall) |
| remove | `docker rm --force --volumes` every container with the name label, remove labelled volumes, and the network once no labelled container is left |
| reconcileCleanup | the same lookup by name label |

### Reaching BB

The daemon dials out to BB's machine address, usually bb Connect. Docker's bridge network cannot reach a server bound to loopback, and a host firewall with a default-drop input policy blocks container-to-host traffic as well, so a direct URL only works if the firewall allows it.

### Agent CLIs

Not baked into the image and not installed by BB at thread start. Run `bb machine provider-cli install <machine> <provider>` once per sandbox (Claude Code took 18 s into `/home/node/.local/bin`); it survives suspend and resume. A composed thread on a new sandbox fails its first turn until then; `bb thread retry` after installing.

### Finding the thread's own machine

Sandboxes are ephemeral, so plain `bb machine list` hides them. Inside a sandbox thread use `bb machine list --all`, or the host of the thread's environment (`bb environment show <id> --json`). Passing `arch` to `--machine` drives the server's browser, whose `localhost` is not the sandbox.

### Browser automation

The built-in image installs Debian's `chromium`, which Browser Automation finds on `PATH`. It launches Chromium with `--no-sandbox`, so the container's own isolation is the sandbox; no capability or seccomp change is needed. The first `open` downloads DevBrowser from GitHub into the container. Screenshots are written to the container's `/tmp`; a thread running in the same container reads them directly, genui's `Image("/tmp/...")` loads them through BB from the environment's host, and `bb tasks attachment add --file <path>` uploads from the thread's machine. Nothing has to be copied off the container.
