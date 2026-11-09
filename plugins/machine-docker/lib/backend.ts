import type { SandboxAvailability, SandboxBackend, SandboxHandle, SandboxProgress } from "@wy3z/bb-suite/machine-backend/server";
import { sandboxNameForKey } from "@wy3z/bb-suite/machine-backend/server";
import { docker, DockerError, isMissing, type DockerRunner } from "./docker.ts";
import { PROBE_SCRIPT, parsePublishedPorts, reachabilityMessage, type ProbeFacts, type ProbeTarget, probeTargets } from "./egress-probe.ts";
import { BUILTIN_BASE_IMAGE, BUILTIN_BASE_TAG, BUILTIN_BASE_TARGET, BUILTIN_DOCKERFILE, BUILTIN_IMAGE_REPOSITORY, builtinImageTag } from "./image.ts";
import type { DockerSettings } from "./settings.ts";

export const PROVIDER_ID = "docker-sandbox";
export const LABEL_MANAGED = "app.getbb.docker-sandbox";
export const LABEL_NAME = "app.getbb.docker-sandbox.name";
export const LABEL_KEY = "app.getbb.docker-sandbox.key";
export const LABEL_IMAGE = "app.getbb.docker-sandbox-image";
export const LABEL_PROBE = "app.getbb.docker-sandbox-probe";
export const NETWORK_NAME = "bb-docker-sandbox";
export const NETWORK_SUBNET = "10.213.89.0/24";
export const ICC_OPTION = "com.docker.network.bridge.enable_icc";
export const DEADLINE_FILE = "/tmp/.bb-sandbox-expires-at";
export const PIDS_LIMIT = 4096;

export const KEEPALIVE = [
  `f=${DEADLINE_FILE}`,
  'ttl="$1"',
  "case \"$ttl\" in ''|*[!0-9]*) ttl=0 ;; esac",
  'if [ "$ttl" -gt 0 ]; then d=$(( $(date +%s) + ttl )); echo "$d" > "$f"; else d=none; fi',
  "trap 'exit 0' TERM INT",
  "while :; do",
  '  if [ "$d" != none ]; then',
  '    n=$(cat "$f" 2>/dev/null) && [ "$n" -gt "$d" ] 2>/dev/null && d=$n',
  '    [ "$(date +%s)" -ge "$d" ] && exit 0',
  "  fi",
  "  sleep 15 & wait $!",
  "done",
].join("\n");

const SHORT_MS = 30_000;
const BUILD_MS = 20 * 60_000;
const PULL_MS = 20 * 60_000;
const STOP_GRACE_SECONDS = 20;
const PROBE_MS = 90_000;
const PROBE_CACHE_MS = 10 * 60_000;

export interface DockerBackendOptions {
  docker: DockerRunner;
  settings: () => Promise<DockerSettings>;
  hostFacts?: () => Promise<Omit<ProbeFacts, "gateway" | "publishedPorts">>;
  now?: () => number;
}

interface InspectedNetwork {
  Id: string;
  Driver?: string;
  Labels?: Record<string, string> | null;
  Options?: Record<string, string> | null;
  IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> | null };
}

export function networkProblem(network: InspectedNetwork): string | null {
  const problems: string[] = [];
  if (network.Labels?.[LABEL_MANAGED] !== "1") problems.push(`it has no ${LABEL_MANAGED}=1 label`);
  if (network.Driver !== "bridge") problems.push(`its driver is ${network.Driver ?? "unknown"}, not bridge`);
  if (network.Options?.[ICC_OPTION] !== "false") problems.push("traffic between its containers is allowed");
  const subnets = (network.IPAM?.Config ?? []).map((config) => config.Subnet);
  if (subnets.length !== 1 || subnets[0] !== NETWORK_SUBNET) problems.push(`its subnet is ${subnets.join(", ") || "unset"}, not ${NETWORK_SUBNET}`);
  return problems.length === 0
    ? null
    : `Docker Sandbox: a Docker network named ${NETWORK_NAME} already exists but isn't one it created (${problems.join("; ")}). Remove or rename that network, then try again.`;
}

export function isRootUser(user: string | undefined | null): boolean {
  const name = (user ?? "").trim().split(":")[0] ?? "";
  return name === "" || name === "root" || name === "0";
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
  let networkChain: Promise<unknown> = Promise.resolve();
  let probeCache: { at: number; message: string | null } | null = null;
  let probeRun: Promise<string | null> | null = null;

  function withNetwork<T>(work: () => Promise<T>): Promise<T> {
    const next = networkChain.then(work, work);
    networkChain = next.catch(() => undefined);
    return next;
  }

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

  async function inspectNetwork(signal: AbortSignal): Promise<InspectedNetwork | null> {
    const args = ["network", "inspect", NETWORK_NAME];
    const result = await run(args, { signal, timeoutMs: SHORT_MS });
    if (result.code !== 0) {
      if (/no such network|not found/i.test(result.stderr)) return null;
      throw new DockerError(args, result);
    }
    return (JSON.parse(result.stdout) as InspectedNetwork[])[0] ?? null;
  }

  async function ensureNetwork(signal: AbortSignal): Promise<InspectedNetwork> {
    let network = await inspectNetwork(signal);
    if (network === null) {
      await docker(
        run,
        [
          "network",
          "create",
          "--driver",
          "bridge",
          "--subnet",
          NETWORK_SUBNET,
          "--label",
          `${LABEL_MANAGED}=1`,
          "--opt",
          `${ICC_OPTION}=false`,
          NETWORK_NAME,
        ],
        { signal, timeoutMs: SHORT_MS },
      );
      network = await inspectNetwork(signal);
      if (network === null) throw new Error(`Docker Sandbox: the ${NETWORK_NAME} network disappeared right after it was created.`);
    }
    const problem = networkProblem(network);
    if (problem !== null) throw new Error(problem);
    return network;
  }

  async function imageExists(image: string, signal: AbortSignal): Promise<boolean> {
    const result = await run(["image", "inspect", "--format", "{{.Id}}", "--", image], { signal, timeoutMs: SHORT_MS });
    return result.code === 0;
  }

  async function ensureImage(settings: DockerSettings, signal: AbortSignal, report: SandboxProgress): Promise<string> {
    if (settings.image !== "") {
      if (!(await imageExists(settings.image, signal))) {
        report.step(`Pulling ${settings.image}…`);
        await docker(run, ["pull", "--", settings.image], { signal, timeoutMs: PULL_MS, onOutput: (chunk) => report.log(chunk) });
      }
      const user = (await docker(run, ["image", "inspect", "--format", "{{.Config.User}}", "--", settings.image], { signal, timeoutMs: SHORT_MS })).trim();
      if (isRootUser(user)) {
        throw new Error(
          `Docker Sandbox: ${settings.image} runs as ${user === "" ? "root (no USER set)" : user}. Sandboxes must run as a non-root user; add a USER line to the image.`,
        );
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
    await pruneBuiltImages(tag, signal, report);
    return tag;
  }

  async function imageId(ref: string, signal: AbortSignal): Promise<string | null> {
    const result = await run(["image", "inspect", "--format", "{{.Id}}", "--", ref], { signal, timeoutMs: SHORT_MS });
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async function pruneBuiltImages(current: string, signal: AbortSignal, report: SandboxProgress): Promise<void> {
    try {
      const keep = new Set((await Promise.all([imageId(current, signal), imageId(BUILTIN_BASE_TAG, signal)])).filter((id): id is string => id !== null));
      const listed = lines(
        await docker(run, ["image", "ls", "--no-trunc", "--filter", `label=${LABEL_IMAGE}=1`, "--format", "{{.ID}}\t{{.Repository}}"], {
          signal,
          timeoutMs: SHORT_MS,
        }),
      );
      const stale = [
        ...new Set(
          listed
            .map((line) => line.split("\t"))
            .filter(([id, repository]) => id !== undefined && !keep.has(id) && (repository === BUILTIN_IMAGE_REPOSITORY || repository === "<none>"))
            .map(([id]) => id!),
        ),
      ];
      let removed = 0;
      for (const id of stale) if ((await run(["image", "rm", id], { signal, timeoutMs: SHORT_MS })).code === 0) removed += 1;
      if (removed > 0) report.log(`Removed ${removed} older sandbox image(s)`);
    } catch (error) {
      signal.throwIfAborted();
      report.log(`Skipped cleaning up older sandbox images: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function writeDeadline(sandboxId: string, signal: AbortSignal): Promise<number | null> {
    const seconds = ttlSeconds(await options.settings());
    if (seconds <= 0) return null;
    await docker(run, ["exec", sandboxId, "sh", "-c", `echo $(( $(date +%s) + ${seconds} )) > ${DEADLINE_FILE}`], { signal, timeoutMs: SHORT_MS });
    return now() + seconds * 1000;
  }

  async function removeContainers(ids: string[], signal: AbortSignal): Promise<void> {
    if (ids.length === 0) return;
    const result = await run(["container", "rm", "--force", "--volumes", ...ids], { signal, timeoutMs: 2 * SHORT_MS });
    if (result.code !== 0 && !/no such container/i.test(result.stderr)) {
      await docker(run, ["container", "rm", "--force", "--volumes", ...ids], { signal, timeoutMs: 2 * SHORT_MS });
    }
  }

  async function removeNetworkIfUnused(signal: AbortSignal): Promise<void> {
    const remaining = lines(
      await docker(run, ["container", "ls", "--all", "--quiet", "--filter", `label=${LABEL_MANAGED}=1`], { signal, timeoutMs: SHORT_MS }),
    );
    if (remaining.length > 0) return;
    const network = await inspectNetwork(signal);
    if (network === null || network.Labels?.[LABEL_MANAGED] !== "1") return;
    await run(["network", "rm", network.Id], { signal, timeoutMs: SHORT_MS });
  }

  async function publishedPorts(signal: AbortSignal): Promise<ProbeFacts["publishedPorts"]> {
    return parsePublishedPorts(await docker(run, ["container", "ls", "--format", "{{.Ports}}"], { signal, timeoutMs: SHORT_MS }));
  }

  async function probeHostAccess(): Promise<string | null> {
    const signal = AbortSignal.timeout(PROBE_MS);
    const network = await withNetwork(() => ensureNetwork(signal));
    const gateway = network.IPAM?.Config?.[0]?.Gateway;
    if (!gateway) throw new Error(`Docker Sandbox: the ${NETWORK_NAME} network has no gateway address.`);
    const facts = options.hostFacts ? await options.hostFacts() : { hostAddresses: [], lanGateway: null };
    const targets = probeTargets({ ...facts, gateway, publishedPorts: await publishedPorts(signal) });
    if (!(await imageExists(BUILTIN_BASE_IMAGE, signal))) {
      await docker(run, ["pull", BUILTIN_BASE_IMAGE], { signal, timeoutMs: PROBE_MS });
    }
    const output = await docker(
      run,
      [
        "run",
        "--rm",
        "--label",
        `${LABEL_PROBE}=1`,
        "--network",
        NETWORK_NAME,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "node",
        "--memory",
        "128m",
        "--pids-limit",
        "64",
        "--entrypoint",
        "node",
        BUILTIN_BASE_IMAGE,
        "-e",
        PROBE_SCRIPT,
        JSON.stringify(targets),
      ],
      { signal, timeoutMs: PROBE_MS },
    );
    return reachabilityMessage(JSON.parse(output) as ProbeTarget[], NETWORK_SUBNET);
  }

  async function hostAccessRefusal(): Promise<string | null> {
    if (probeCache !== null && now() - probeCache.at < PROBE_CACHE_MS) return probeCache.message;
    probeRun ??= probeHostAccess()
      .catch((error: unknown) => `Docker Sandbox: couldn't check whether sandboxes can reach the host (${error instanceof Error ? error.message.slice(0, 300) : String(error)}).`)
      .then((message) => {
        probeCache = { at: now(), message };
        return message;
      })
      .finally(() => {
        probeRun = null;
      });
    return probeRun;
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
      if (result.code === 0) {
        const refusal = await hostAccessRefusal();
        return refusal === null ? { status: "available" } : { status: "setup-required", message: refusal };
      }
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
      report.step("Starting the container…");
      const id = await withNetwork(async () => {
        await ensureNetwork(signal);
        return (await docker(run, runArgs({ name, key, image, settings }), { signal, timeoutMs: 2 * SHORT_MS })).trim();
      });
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
      await withNetwork(async () => {
        await removeContainers(ids, signal);
        await removeNetworkIfUnused(signal);
      });
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
