import type { SandboxAvailability, SandboxBackend, SandboxHandle, SandboxProgress } from "@wy3z/bb-suite/machine-backend/server";
import { sandboxNameForKey } from "@wy3z/bb-suite/machine-backend/server";
import { docker, DockerError, isMissing, type DockerRunner } from "./docker.ts";
import { BUILTIN_BASE_TAG, BUILTIN_BASE_TARGET, BUILTIN_DOCKERFILE, builtinImageTag } from "./image.ts";
import type { DockerSettings } from "./settings.ts";

export const PROVIDER_ID = "docker-sandbox";
export const LABEL_MANAGED = "app.getbb.docker-sandbox";
export const LABEL_NAME = "app.getbb.docker-sandbox.name";
export const LABEL_KEY = "app.getbb.docker-sandbox.key";
export const LABEL_IMAGE = "app.getbb.docker-sandbox-image";
export const NETWORK_NAME = "bb-docker-sandbox";
export const DEADLINE_FILE = "/tmp/.bb-sandbox-expires-at";
export const PIDS_LIMIT = 4096;

export const KEEPALIVE = [
  `f=${DEADLINE_FILE}`,
  'ttl="$1"',
  'if [ "$ttl" -gt 0 ] 2>/dev/null; then echo $(( $(date +%s) + ttl )) > "$f"; else rm -f "$f"; fi',
  "trap 'exit 0' TERM INT",
  "while :; do",
  '  if [ -f "$f" ] && [ "$(date +%s)" -ge "$(cat "$f" 2>/dev/null || echo 9999999999)" ] 2>/dev/null; then exit 0; fi',
  "  sleep 15 & wait $!",
  "done",
].join("\n");

const SHORT_MS = 30_000;
const BUILD_MS = 20 * 60_000;
const PULL_MS = 20 * 60_000;
const STOP_GRACE_SECONDS = 20;

export interface DockerBackendOptions {
  docker: DockerRunner;
  settings: () => Promise<DockerSettings>;
  now?: () => number;
}

interface InspectedContainer {
  Id: string;
  State?: { Running?: boolean };
  Config?: { Labels?: Record<string, string> | null };
}

export function dockerSandboxName(key: string): string {
  return sandboxNameForKey(key, "bb-docker");
}

function ttlSeconds(settings: DockerSettings): number {
  return Math.round(settings.ttlHours * 3600);
}

export function runArgs(request: { name: string; key: string; image: string; settings: DockerSettings }): string[] {
  const { name, key, image, settings } = request;
  const memory = `${Math.round(settings.memoryGb * 1024)}m`;
  return [
    "run",
    "--detach",
    "--name",
    name,
    "--hostname",
    name.slice(0, 63),
    "--label",
    `${LABEL_MANAGED}=1`,
    "--label",
    `${LABEL_NAME}=${name}`,
    "--label",
    `${LABEL_KEY}=${key}`,
    "--network",
    NETWORK_NAME,
    "--init",
    "--restart",
    "no",
    "--cpus",
    String(settings.cpus),
    "--memory",
    memory,
    "--memory-swap",
    memory,
    "--shm-size",
    `${settings.shmMb}m`,
    "--pids-limit",
    String(PIDS_LIMIT),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--stop-timeout",
    String(STOP_GRACE_SECONDS),
    "--entrypoint",
    "sh",
    image,
    "-c",
    KEEPALIVE,
    "bb-sandbox-keepalive",
    String(ttlSeconds(settings)),
  ];
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function createDockerBackend(options: DockerBackendOptions): SandboxBackend {
  const run = options.docker;
  const now = options.now ?? Date.now;

  async function inspect(ids: string[], signal?: AbortSignal): Promise<InspectedContainer[]> {
    if (ids.length === 0) return [];
    const args = ["container", "inspect", ...ids];
    const result = await run(args, { signal, timeoutMs: SHORT_MS });
    if (result.code !== 0 && !/no such (container|object)/i.test(result.stderr)) throw new DockerError(args, result);
    const parsed = result.stdout.trim() === "" ? [] : (JSON.parse(result.stdout) as InspectedContainer[]);
    return parsed.filter((item) => item.Config?.Labels?.[LABEL_MANAGED] === "1");
  }

  async function idsByName(name: string, signal?: AbortSignal): Promise<string[]> {
    return lines(
      await docker(
        run,
        ["container", "ls", "--all", "--no-trunc", "--quiet", "--filter", `label=${LABEL_NAME}=${name}`],
        { signal, timeoutMs: SHORT_MS },
      ),
    );
  }

  async function ensureNetwork(signal: AbortSignal): Promise<void> {
    const existing = lines(
      await docker(run, ["network", "ls", "--quiet", "--filter", `name=^${NETWORK_NAME}$`], { signal, timeoutMs: SHORT_MS }),
    );
    if (existing.length > 0) return;
    const result = await run(
      [
        "network",
        "create",
        "--driver",
        "bridge",
        "--label",
        `${LABEL_MANAGED}=1`,
        "--opt",
        "com.docker.network.bridge.enable_icc=false",
        NETWORK_NAME,
      ],
      { signal, timeoutMs: SHORT_MS },
    );
    if (result.code !== 0 && !/already exists/i.test(result.stderr)) {
      await docker(run, ["network", "inspect", NETWORK_NAME], { signal, timeoutMs: SHORT_MS });
    }
  }

  async function imageExists(image: string, signal: AbortSignal): Promise<boolean> {
    const result = await run(["image", "inspect", "--format", "{{.Id}}", image], { signal, timeoutMs: SHORT_MS });
    return result.code === 0;
  }

  async function ensureImage(settings: DockerSettings, signal: AbortSignal, report: SandboxProgress): Promise<string> {
    if (settings.image !== "") {
      if (!(await imageExists(settings.image, signal))) {
        report.step(`Pulling ${settings.image}…`);
        await docker(run, ["pull", settings.image], { signal, timeoutMs: PULL_MS, onOutput: (chunk) => report.log(chunk) });
      }
      return settings.image;
    }
    const tag = builtinImageTag();
    if (await imageExists(tag, signal)) return tag;
    report.step("Building the sandbox image (first run only, a few minutes)…");
    const build = (args: string[]) =>
      docker(run, ["build", ...args, "--label", `${LABEL_IMAGE}=1`, "-"], {
        stdin: BUILTIN_DOCKERFILE,
        signal,
        timeoutMs: BUILD_MS,
        onOutput: (chunk) => report.log(chunk),
      });
    await build(["--target", BUILTIN_BASE_TARGET, "--tag", BUILTIN_BASE_TAG]);
    await build(["--tag", tag]);
    return tag;
  }

  async function writeDeadline(sandboxId: string, signal: AbortSignal): Promise<number | null> {
    const seconds = ttlSeconds(await options.settings());
    const script = seconds > 0 ? `echo $(( $(date +%s) + ${seconds} )) > ${DEADLINE_FILE}` : `rm -f ${DEADLINE_FILE}`;
    await docker(run, ["exec", sandboxId, "sh", "-c", script], { signal, timeoutMs: SHORT_MS });
    return seconds > 0 ? now() + seconds * 1000 : null;
  }

  async function removeContainers(ids: string[], signal: AbortSignal): Promise<void> {
    if (ids.length === 0) return;
    const result = await run(["container", "rm", "--force", "--volumes", ...ids], { signal, timeoutMs: 2 * SHORT_MS });
    if (result.code !== 0 && !/no such container/i.test(result.stderr)) {
      await docker(run, ["container", "rm", "--force", "--volumes", ...ids], { signal, timeoutMs: 2 * SHORT_MS });
    }
  }

  async function removeLabelledVolumes(name: string, signal: AbortSignal): Promise<void> {
    const volumes = lines(
      await docker(run, ["volume", "ls", "--quiet", "--filter", `label=${LABEL_NAME}=${name}`], { signal, timeoutMs: SHORT_MS }),
    );
    if (volumes.length > 0) await docker(run, ["volume", "rm", "--force", ...volumes], { signal, timeoutMs: SHORT_MS });
  }

  async function removeNetworkIfUnused(signal: AbortSignal): Promise<void> {
    const remaining = lines(
      await docker(run, ["container", "ls", "--all", "--quiet", "--filter", `label=${LABEL_MANAGED}=1`], { signal, timeoutMs: SHORT_MS }),
    );
    if (remaining.length > 0) return;
    await run(["network", "rm", NETWORK_NAME], { signal, timeoutMs: SHORT_MS });
  }

  return {
    id: PROVIDER_ID,
    displayName: "Docker Sandbox",
    description: "A local Docker container on the BB server's machine, with CPU and memory limits and no host mounts.",
    environmentDescription: "Create a project checkout in a new local Docker container.",
    icon: "./icon.svg",
    ephemeral: true,
    nameFor: dockerSandboxName,

    async availability(): Promise<SandboxAvailability> {
      const result = await run(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 5_000 }).catch((error: unknown) => ({
        code: 127,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }));
      if (result.code === 0) return { status: "available" };
      const detail = result.stderr.trim().split("\n").pop() ?? "";
      return {
        status: "setup-required",
        message: `Docker isn't reachable from the BB server${detail ? ` (${detail.slice(0, 200)})` : ""}. Install Docker and make sure the user running BB can use it.`,
      };
    },

    async create({ key, name, signal, report }): Promise<SandboxHandle> {
      const settings = await options.settings();
      const image = await ensureImage(settings, signal, report);
      const leftovers = await idsByName(name, signal);
      if (leftovers.length > 0) {
        report.log(`Removing ${leftovers.length} stopped container(s) left by an earlier attempt`);
        await removeContainers(leftovers, signal);
      }
      await ensureNetwork(signal);
      report.step("Starting the container…");
      const id = (await docker(run, runArgs({ name, key, image, settings }), { signal, timeoutMs: 2 * SHORT_MS })).trim();
      const seconds = ttlSeconds(settings);
      return { id, running: true, expiresAt: seconds > 0 ? now() + seconds * 1000 : null, meta: { image } };
    },

    async exec(sandboxId, request) {
      const result = await run(["exec", "--interactive", sandboxId, ...request.command], {
        stdin: request.stdin,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
        onOutput: request.onOutput,
      });
      return { exitCode: result.code };
    },

    async snapshot() {
      return { snapshotId: null };
    },

    async stop({ sandboxId, signal }) {
      await docker(run, ["container", "stop", "--time", String(STOP_GRACE_SECONDS), sandboxId], {
        signal,
        timeoutMs: (STOP_GRACE_SECONDS + 30) * 1000,
      });
      return { sandboxId };
    },

    async resume({ name, sandboxId, signal, report }) {
      const ids = sandboxId !== null ? [sandboxId] : await idsByName(name, signal);
      const [container] = await inspect(ids, signal);
      if (container === undefined) {
        throw new Error(`The container for ${name} is gone, so there is nothing to resume. Remove the machine and start a new one.`);
      }
      if (!container.State?.Running) {
        report.step("Starting the stopped container…");
        await docker(run, ["container", "start", container.Id], { signal, timeoutMs: 2 * SHORT_MS });
      }
      const expiresAt = await writeDeadline(container.Id, signal);
      return { id: container.Id, running: true, expiresAt };
    },

    async remove({ name, sandboxIds, signal, report }) {
      const ids = [...new Set([...sandboxIds, ...(await idsByName(name, signal))])];
      if (ids.length > 0) report.log(`Removing ${ids.length} container(s) for ${name}`);
      await removeContainers(ids, signal);
      await removeLabelledVolumes(name, signal);
      await removeNetworkIfUnused(signal);
    },

    async listByName(name, signal) {
      const found = await inspect(await idsByName(name, signal), signal);
      return found.map((item) => ({ id: item.Id, running: item.State?.Running === true, expiresAt: null }));
    },

    async extendTtl({ sandboxId, signal }) {
      try {
        return { expiresAt: await writeDeadline(sandboxId, signal) };
      } catch (error) {
        if (isMissing(error)) return { expiresAt: null };
        throw error;
      }
    },
  };
}
