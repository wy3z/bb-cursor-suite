import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KEEPALIVE,
  LABEL_IMAGE,
  LABEL_KEY,
  LABEL_MANAGED,
  LABEL_NAME,
  LABEL_PROBE,
  ICC_OPTION,
  NETWORK_NAME,
  NETWORK_SUBNET,
  isRootUser,
  networkProblem,
  createDockerBackend,
  dockerSandboxName,
  runArgs,
} from "../lib/backend.ts";
import type { DockerResult, DockerRunOptions } from "../lib/docker.ts";
import { BUILTIN_BASE_IMAGE, BUILTIN_BASE_TAG, BUILTIN_DOCKERFILE, CLAUDE_CODE_VERSION, CODEX_VERSION, builtinImageTag } from "../lib/image.ts";
import { settingDescriptors as settingsDescriptorsForTest } from "../lib/settings.ts";
import { IMAGE_REFERENCE, policyFrom, readDockerSettings, type DockerSettings } from "../lib/settings.ts";
import { DEADLINE_FILE } from "../lib/backend.ts";

const settings: DockerSettings = readDockerSettings({});
const signal = () => new AbortController().signal;
const report = () => {
  const lines: string[] = [];
  return { lines, progress: { step: (text: string) => lines.push(text), log: (text: string) => lines.push(text) } };
};

interface Container {
  id: string;
  name: string;
  running: boolean;
  managed: boolean;
}

type FakeNetwork = { Id: string; Driver: string; Labels: Record<string, string>; Options: Record<string, string>; IPAM: { Config: Array<{ Subnet: string; Gateway: string }> } };

const goodNetwork = (): FakeNetwork => ({
  Id: "net-good",
  Driver: "bridge",
  Labels: { [LABEL_MANAGED]: "1" },
  Options: { [ICC_OPTION]: "false" },
  IPAM: { Config: [{ Subnet: NETWORK_SUBNET, Gateway: "10.213.89.1" }] },
});

function fakeDocker(
  initial: {
    images?: string[];
    containers?: Container[];
    network?: boolean | FakeNetwork;
    users?: Record<string, string>;
    builtImages?: Array<{ id: string; repository: string }>;
    imageIds?: Record<string, string>;
    ports?: string;
    probeOutput?: string;
  } = {},
) {
  const calls: Array<{ args: string[]; options: DockerRunOptions }> = [];
  const images = new Set(initial.images ?? []);
  const containers = new Map((initial.containers ?? []).map((item) => [item.id, item]));
  let network: FakeNetwork | null = initial.network === true ? goodNetwork() : initial.network ? initial.network : null;
  const builtImages = [...(initial.builtImages ?? [])];
  let next = 1;
  const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string): DockerResult => ({ code: 1, stdout: "", stderr });
  const run = async (args: string[], options: DockerRunOptions = {}): Promise<DockerResult> => {
    calls.push({ args, options });
    const [a, b] = args;
    if (a === "version") return ok("29.9.3\n");
    if (a === "image" && b === "inspect") {
      const ref = args.at(-1)!;
      if (!images.has(ref)) return fail("Error: No such image");
      const format = args[args.indexOf("--format") + 1];
      if (format === "{{.Config.User}}") return ok(`${initial.users?.[ref] ?? "node"}\n`);
      return ok(`${initial.imageIds?.[ref] ?? "sha256:x"}\n`);
    }
    if (a === "image" && b === "ls") return ok(builtImages.map((image) => `${image.id}\t${image.repository}\n`).join(""));
    if (a === "image" && b === "rm") {
      const index = builtImages.findIndex((image) => image.id === args[2]);
      if (index < 0) return fail("Error: No such image");
      builtImages.splice(index, 1);
      return ok();
    }
    if (a === "build") {
      for (let i = 0; i < args.length; i += 1) if (args[i] === "--tag") images.add(args[i + 1]!);
      return ok();
    }
    if (a === "pull") {
      images.add(args.at(-1)!);
      return ok();
    }
    if (a === "network" && b === "inspect") return network === null ? fail("Error response from daemon: network bb-docker-sandbox not found") : ok(JSON.stringify([network]));
    if (a === "network" && b === "create") {
      const options = Object.fromEntries(args.flatMap((arg, i) => (args[i - 1] === "--opt" ? [arg.split("=") as [string, string]] : [])));
      const labels = Object.fromEntries(args.flatMap((arg, i) => (args[i - 1] === "--label" ? [arg.split("=") as [string, string]] : [])));
      network = { Id: "net-new", Driver: args[args.indexOf("--driver") + 1]!, Labels: labels, Options: options, IPAM: { Config: [{ Subnet: args[args.indexOf("--subnet") + 1]!, Gateway: "10.213.89.1" }] } };
      return ok("net-new\n");
    }
    if (a === "network" && b === "rm") {
      if (network === null || args[2] !== network.Id) return fail("Error: No such network");
      network = null;
      return ok();
    }
    if (a === "run" && args.includes(`${LABEL_PROBE}=1`)) return ok(initial.probeOutput ?? "[]");
    if (a === "run") {
      const name = args[args.indexOf("--name") + 1]!;
      const id = `c${next++}`.padEnd(12, "0");
      containers.set(id, { id, name, running: true, managed: true });
      return ok(`${id}\n`);
    }
    if (a === "container" && b === "ls" && args.includes("{{.Ports}}")) return ok(initial.ports ?? "");
    if (a === "container" && b === "ls") {
      const filter = args[args.indexOf("--filter") + 1]!;
      const wantName = filter.startsWith(`label=${LABEL_NAME}=`) ? filter.slice(`label=${LABEL_NAME}=`.length) : null;
      const ids = [...containers.values()].filter((item) => item.managed && (wantName === null || item.name === wantName)).map((item) => item.id);
      return ok(ids.map((id) => `${id}\n`).join(""));
    }
    if (a === "container" && b === "inspect") {
      const found = args.slice(2).flatMap((id) => (containers.has(id) ? [containers.get(id)!] : []));
      const json = JSON.stringify(
        found.map((item) => ({
          Id: item.id,
          State: { Running: item.running },
          Config: { Labels: item.managed ? { [LABEL_MANAGED]: "1", [LABEL_NAME]: item.name } : {} },
        })),
      );
      return found.length === args.length - 2 ? ok(json) : { code: 1, stdout: json, stderr: "Error: No such container: x" };
    }
    if (a === "container" && b === "stop") {
      const item = containers.get(args.at(-1)!);
      if (!item) return fail("Error: No such container");
      item.running = false;
      return ok();
    }
    if (a === "container" && b === "start") {
      containers.get(args.at(-1)!)!.running = true;
      return ok();
    }
    if (a === "container" && b === "rm") {
      for (const id of args.slice(4)) containers.delete(id);
      return ok();
    }
    if (a === "exec") return ok();
    return fail(`unexpected docker ${args.join(" ")}`);
  };
  return { run, calls, images, containers, builtImages, network: () => network };
}

function backendWith(fake: ReturnType<typeof fakeDocker>, overrides: Partial<DockerSettings> = {}) {
  return createDockerBackend({ docker: fake.run, settings: async () => ({ ...settings, ...overrides }), now: () => 1_000_000 });
}

describe("runArgs", () => {
  const args = runArgs({ name: "bb-docker-x", key: "k1", image: "img:1", settings });
  const joined = args.join(" ");

  test("sets every resource limit", () => {
    expect(args).toContain("--cpus");
    expect(args[args.indexOf("--memory") + 1]).toBe("4096m");
    expect(args[args.indexOf("--memory-swap") + 1]).toBe("4096m");
    expect(args[args.indexOf("--shm-size") + 1]).toBe("1024m");
    expect(args).toContain("--pids-limit");
  });

  test("drops privileges and never mounts the host", () => {
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(joined).not.toContain("--privileged");
    expect(joined).not.toContain("docker.sock");
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("--mount");
    expect(args).not.toContain("--publish");
    expect(args[args.indexOf("--network") + 1]).toBe(NETWORK_NAME);
    expect(args).not.toContain("--env");
  });

  test("labels the container for exact cleanup", () => {
    expect(args).toContain(`${LABEL_MANAGED}=1`);
    expect(args).toContain(`${LABEL_NAME}=bb-docker-x`);
    expect(args).toContain(`${LABEL_KEY}=k1`);
  });

  test("runs the TTL keepalive with the configured seconds", () => {
    expect(args.slice(-4)).toEqual(["-c", KEEPALIVE, "bb-sandbox-keepalive", "7200"]);
  });
});

describe("docker backend", () => {
  test("builds the base target, then the agents layer on top, from stdin, once", async () => {
    const fake = fakeDocker();
    const backend = backendWith(fake);
    const progress = report();
    const handle = await backend.create({ key: "k1", name: "bb-docker-k1", inputs: null, ttlMs: 0, signal: signal(), report: progress.progress });
    const [base, agents] = fake.calls.filter((call) => call.args[0] === "build");
    for (const build of [base!, agents!]) {
      expect(build.options.stdin).toBe(BUILTIN_DOCKERFILE);
      expect(build.args.at(-1)).toBe("-");
      expect(build.args).toContain(`${LABEL_IMAGE}=1`);
      expect(build.args).not.toContain(`${LABEL_MANAGED}=1`);
    }
    expect(base!.args.slice(1, 5)).toEqual(["--target", "base", "--tag", BUILTIN_BASE_TAG]);
    expect(agents!.args).not.toContain("--target");
    expect(agents!.args).toContain(builtinImageTag());
    expect(handle).toMatchObject({ running: true, expiresAt: 1_000_000 + 7_200_000, meta: { image: builtinImageTag() } });
    await backend.create({ key: "k2", name: "bb-docker-k2", inputs: null, ttlMs: 0, signal: signal(), report: progress.progress });
    expect(fake.calls.filter((call) => call.args[0] === "build")).toHaveLength(2);
    expect(fake.calls.filter((call) => call.args[0] === "network" && call.args[1] === "create")).toHaveLength(1);
  });

  test("pulls a custom image instead of building", async () => {
    const fake = fakeDocker();
    const backend = backendWith(fake, { image: "debian:custom" });
    await backend.create({ key: "k", name: "bb-docker-k", inputs: null, ttlMs: 0, signal: signal(), report: report().progress });
    expect(fake.calls.some((call) => call.args[0] === "pull" && call.args.at(-1) === "debian:custom" && call.args.includes("--"))).toBe(true);
    expect(fake.calls.some((call) => call.args[0] === "build")).toBe(false);
  });

  test("replaces stopped leftovers from a failed attempt", async () => {
    const fake = fakeDocker({ images: [builtinImageTag()], network: true, containers: [{ id: "old", name: "bb-docker-k", running: false, managed: true }] });
    const backend = backendWith(fake);
    await backend.create({ key: "k", name: "bb-docker-k", inputs: null, ttlMs: 0, signal: signal(), report: report().progress });
    expect(fake.containers.has("old")).toBe(false);
    expect(fake.calls.some((call) => call.args[0] === "container" && call.args[1] === "rm" && call.args.includes("old"))).toBe(true);
  });

  test("passes executor stdin through docker exec stdin, never argv", async () => {
    const fake = fakeDocker();
    const backend = backendWith(fake);
    const secret = '{"headers":{"authorization":"Bearer abcdefghijklmnopqrstuvwxyz"}}';
    await backend.exec("c1", { command: ["sh", "-c", "cat"], stdin: secret, timeoutMs: 1000, signal: signal(), onOutput: () => undefined });
    const call = fake.calls.at(-1)!;
    expect(call.args).toEqual(["exec", "--interactive", "c1", "sh", "-c", "cat"]);
    expect(call.options.stdin).toBe(secret);
    expect(call.args.join(" ")).not.toContain("Bearer");
  });

  test("suspend stops in place and resume starts the same container", async () => {
    const fake = fakeDocker({ images: [builtinImageTag()], network: true });
    const backend = backendWith(fake);
    const handle = await backend.create({ key: "k", name: "bb-docker-k", inputs: null, ttlMs: 0, signal: signal(), report: report().progress });
    expect(await backend.snapshot({ sandboxId: handle.id, name: "bb-docker-k", operationKey: "op", signal: signal(), report: report().progress })).toEqual({ snapshotId: null });
    expect(await backend.stop({ sandboxId: handle.id, name: "bb-docker-k", signal: signal(), report: report().progress })).toEqual({ sandboxId: handle.id });
    expect(await backend.listByName("bb-docker-k", signal())).toEqual([{ id: handle.id, running: false, expiresAt: null }]);
    const resumed = await backend.resume({ name: "bb-docker-k", sandboxId: handle.id, snapshotId: null, meta: {}, ttlMs: 0, signal: signal(), report: report().progress });
    expect(resumed).toEqual({ id: handle.id, running: true, expiresAt: 1_000_000 + 7_200_000 });
    expect(fake.calls.some((call) => call.args[0] === "exec" && call.args.at(-1)!.includes("/tmp/.bb-sandbox-expires-at"))).toBe(true);
  });

  test("resume refuses when the container is gone", async () => {
    const backend = backendWith(fakeDocker());
    await expect(
      backend.resume({ name: "bb-docker-k", sandboxId: "gone", snapshotId: null, meta: {}, ttlMs: 0, signal: signal(), report: report().progress }),
    ).rejects.toThrow(/gone/);
  });

  test("listByName ignores containers without the managed label", async () => {
    const fake = fakeDocker({ containers: [{ id: "x", name: "bb-docker-k", running: true, managed: false }] });
    expect(await backendWith(fake).listByName("bb-docker-k", signal())).toEqual([]);
  });

  test("remove deletes labelled containers and the network once unused", async () => {
    const fake = fakeDocker({
      network: true,
      containers: [
        { id: "a", name: "bb-docker-k", running: true, managed: true },
        { id: "b", name: "bb-docker-k", running: false, managed: true },
        { id: "z", name: "bb-docker-other", running: true, managed: true },
      ],
    });
    const backend = backendWith(fake);
    await backend.remove({ name: "bb-docker-k", sandboxIds: ["a"], snapshotIds: [], signal: signal(), report: report().progress });
    expect([...fake.containers.keys()]).toEqual(["z"]);
    expect(fake.network()).not.toBeNull();
    await backend.remove({ name: "bb-docker-other", sandboxIds: [], snapshotIds: [], signal: signal(), report: report().progress });
    expect(fake.network()).toBeNull();
  });

  test("a zero TTL means no deadline", async () => {
    const fake = fakeDocker({ images: [builtinImageTag()], network: true });
    const backend = backendWith(fake, { ttlHours: 0 });
    const handle = await backend.create({ key: "k", name: "bb-docker-k", inputs: null, ttlMs: 0, signal: signal(), report: report().progress });
    expect(handle.expiresAt).toBeNull();
    expect(await backend.extendTtl!({ sandboxId: handle.id, name: "bb-docker-k", ttlMs: 0, signal: signal() })).toEqual({ expiresAt: null });
  });

  test("availability explains an unreachable daemon", async () => {
    const backend = createDockerBackend({
      docker: async () => ({ code: 1, stdout: "", stderr: "permission denied while trying to connect to the docker API" }),
      settings: async () => settings,
    });
    const result = await backend.availability!();
    expect(result.status).toBe("setup-required");
  });
});

describe("built-in image", () => {
  test("layers pinned Claude Code and Codex above base, each in its own layer, as the unprivileged user", () => {
    const [base, agents] = BUILTIN_DOCKERFILE.split(/\n(?=FROM )/);
    expect(base).toMatch(/^FROM node:22\.19\.0-bookworm-slim@sha256:[0-9a-f]{64} AS base\n/);
    expect(base).toContain("chromium");
    expect(base).not.toContain("claude-code");
    expect(agents).toMatch(/^FROM base AS agents\n/);
    expect(agents).toContain(`@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`);
    expect(agents).toContain(`@openai/codex@${CODEX_VERSION}`);
    for (const version of [CLAUDE_CODE_VERSION, CODEX_VERSION]) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const installs = agents!.split("\n").filter((line) => line.startsWith("RUN "));
    expect(installs).toHaveLength(2);
    expect(installs[0]).toContain("claude-code");
    expect(installs[1]).toContain("@openai/codex");
    expect(base).not.toContain("@openai/codex");
    expect(agents).not.toContain("USER root");
    expect(BUILTIN_DOCKERFILE.trimEnd().split("\n").filter((line) => line.startsWith("USER "))).toEqual(["USER node"]);
  });
});

describe("settings", () => {
  test("defaults", () => {
    expect(settings).toEqual({ image: "", cpus: 2, memoryGb: 4, shmMb: 1024, idleMinutes: 15, ttlHours: 2, maxConcurrent: 2 });
  });

  test("policy maps zero to off and spends nothing", () => {
    expect(policyFrom({ ...settings, idleMinutes: 0, maxConcurrent: 0, ttlHours: 0 })).toEqual({
      idleMinutes: null,
      ttlMinutes: 525_600,
      maxConcurrent: null,
      monthlyCapUsd: null,
      hourlyRateUsd: null,
    });
    expect(policyFrom(settings)).toMatchObject({ idleMinutes: 15, ttlMinutes: 120, maxConcurrent: 2 });
  });

  test("names are prefixed and docker-safe", () => {
    expect(dockerSandboxName("abc")).toBe("bb-docker-abc");
    expect(dockerSandboxName("Weird Key/1")).toMatch(/^bb-docker-[a-z0-9-]+$/);
  });
});

function keepalive(ttl: string, file: string) {
  const script = KEEPALIVE.replace(`f=${DEADLINE_FILE}`, `f=${file}`).replace("sleep 15", "sleep 0.1");
  const child = spawn("sh", ["-c", script, "keepalive", ttl], { stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const within = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
  return { child, within };
}

describe("keepalive", () => {
  test("a deleted deadline file can't turn the TTL off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bcs89-keepalive-"));
    const file = join(dir, "deadline");
    const run = keepalive("1", file);
    await new Promise((resolve) => setTimeout(resolve, 150));
    rmSync(file, { force: true });
    expect(await run.within(3000)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the file can only extend the deadline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bcs89-keepalive-"));
    const file = join(dir, "deadline");
    const run = keepalive("1", file);
    await new Promise((resolve) => setTimeout(resolve, 150));
    writeFileSync(file, `${Math.floor(Date.now() / 1000) + 3600}\n`);
    expect(await run.within(2500)).toBe(false);
    run.child.kill("SIGKILL");
    const shorter = keepalive("3600", file);
    await new Promise((resolve) => setTimeout(resolve, 150));
    writeFileSync(file, "1\n");
    expect(await shorter.within(1000)).toBe(false);
    shorter.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  test("TTL 0 is an explicit no-deadline sentinel that a past file can't trigger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bcs89-keepalive-"));
    const file = join(dir, "deadline");
    writeFileSync(file, "1\n");
    const run = keepalive("0", file);
    expect(await run.within(1000)).toBe(false);
    run.child.kill("SIGKILL");
    const junk = keepalive("abc", file);
    expect(await junk.within(800)).toBe(false);
    junk.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  test("SIGTERM still stops it promptly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bcs89-keepalive-"));
    const run = keepalive("3600", join(dir, "deadline"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    run.child.kill("SIGTERM");
    expect(await run.within(1500)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("network adoption", () => {
  test("creates the network with the fixed subnet, label and inter-container traffic off", async () => {
    const fake = fakeDocker({ images: [builtinImageTag()] });
    await backendWith(fake).create({ key: "k", name: "bb-docker-k", inputs: null, ttlMs: 0, signal: signal(), report: report().progress });
    expect(networkProblem(fake.network()!)).toBeNull();
    const create = fake.calls.find((call) => call.args[0] === "network" && call.args[1] === "create")!;
    expect(create.args).toContain(NETWORK_SUBNET);
  });

  test("refuses a same-named network it didn't create, and never puts a sandbox on it", async () => {
    for (const bad of [
      { ...goodNetwork(), Labels: { "bcs89-test": "1" } },
      { ...goodNetwork(), Options: {} },
      { ...goodNetwork(), IPAM: { Config: [{ Subnet: "172.24.0.0/16", Gateway: "172.24.0.1" }] } },
      { ...goodNetwork(), Driver: "macvlan" },
    ]) {
      const fake = fakeDocker({ images: [builtinImageTag()], network: bad });
      await expect(backendWith(fake).create({ key: "k", name: "bb-docker-k", inputs: null, ttlMs: 0, signal: signal(), report: report().progress })).rejects.toThrow(/isn't one it created/);
      expect(fake.calls.some((call) => call.args[0] === "run")).toBe(false);
    }
  });

  test("leaves an unlabelled same-named network alone on remove", async () => {
    const foreign = { ...goodNetwork(), Id: "net-foreign", Labels: {} };
    const fake = fakeDocker({ network: foreign });
    await backendWith(fake).remove({ name: "bb-docker-k", sandboxIds: [], snapshotIds: [], signal: signal(), report: report().progress });
    expect(fake.network()?.Id).toBe("net-foreign");
    expect(fake.calls.some((call) => call.args[0] === "network" && call.args[1] === "rm")).toBe(false);
  });

  test("removes the network by ID, not by name", async () => {
    const fake = fakeDocker({ network: true });
    await backendWith(fake).remove({ name: "bb-docker-k", sandboxIds: [], snapshotIds: [], signal: signal(), report: report().progress });
    expect(fake.calls.find((call) => call.args[0] === "network" && call.args[1] === "rm")!.args).toEqual(["network", "rm", "net-good"]);
  });

  test("serialises network work so a remove can't delete the network between ensure and run", async () => {
    const fake = fakeDocker({ images: [builtinImageTag()], network: true });
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowRun: typeof fake.run = async (args, options) => {
      if (args[0] === "run") {
        order.push("run:start");
        await gate;
        order.push("run:end");
      }
      if (args[0] === "network" && args[1] === "rm") order.push("network:rm");
      return fake.run(args, options);
    };
    const backend = createDockerBackend({ docker: slowRun, settings: async () => settings, now: () => 0 });
    const creating = backend.create({ key: "a", name: "bb-docker-a", inputs: null, ttlMs: 0, signal: signal(), report: report().progress });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const removing = backend.remove({ name: "bb-docker-b", sandboxIds: [], snapshotIds: [], signal: signal(), report: report().progress });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await Promise.all([creating, removing]);
    expect(order.slice(0, 2)).toEqual(["run:start", "run:end"]);
    expect(order).not.toContain("network:rm");
  });
});

describe("images", () => {
  test("prunes older built images after a build, keeping the current and base images", async () => {
    const fake = fakeDocker({
      imageIds: { [builtinImageTag()]: "sha256:new", [BUILTIN_BASE_TAG]: "sha256:base" },
      builtImages: [
        { id: "sha256:new", repository: "bb-docker-sandbox" },
        { id: "sha256:base", repository: "bb-docker-sandbox" },
        { id: "sha256:old", repository: "bb-docker-sandbox" },
        { id: "sha256:oldbase", repository: "<none>" },
        { id: "sha256:desktop", repository: "my-desktop" },
      ],
    });
    const progress = report();
    await backendWith(fake).create({ key: "k", name: "bb-docker-k", inputs: null, ttlMs: 0, signal: signal(), report: progress.progress });
    expect(fake.builtImages.map((image) => image.id).sort()).toEqual(["sha256:base", "sha256:desktop", "sha256:new"]);
    expect(fake.calls.filter((call) => call.args[0] === "image" && call.args[1] === "rm").every((call) => !call.args.includes("--force"))).toBe(true);
  });

  test("refuses a custom image that runs as root", async () => {
    for (const user of ["", "root", "0", "0:0", "root:staff"]) {
      const fake = fakeDocker({ network: true, images: ["debian:custom"], users: { "debian:custom": user } });
      await expect(
        backendWith(fake, { image: "debian:custom" }).create({ key: "k", name: "bb-docker-k", inputs: null, ttlMs: 0, signal: signal(), report: report().progress }),
      ).rejects.toThrow(/non-root/);
      expect(fake.calls.some((call) => call.args[0] === "run")).toBe(false);
    }
    expect(isRootUser("node")).toBe(false);
    expect(isRootUser("1000:1000")).toBe(false);
  });

  test("image references can't look like flags, in either schema", () => {
    for (const bad of ["--privileged", "-v", " --rm", "Debian", "a b", "x".repeat(300)]) {
      expect(IMAGE_REFERENCE.test(bad.trim()) && bad.length <= 256 && bad.trim() === bad).toBe(false);
      expect(() => readDockerSettings({ image: bad })).toThrow(/valid image reference/);
    }
    for (const good of ["", "debian:bookworm", "ghcr.io/org/img:Tag-1", "node@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9", "localhost:5000/x"]) {
      expect(readDockerSettings({ image: good }).image).toBe(good);
    }
    const descriptor = settingsDescriptorsForTest.image.experimental_schema;
    expect(descriptor.safeParse("--privileged").success).toBe(false);
    expect(descriptor.safeParse("debian:bookworm").success).toBe(true);
  });
});

describe("host access probe", () => {
  test("availability fails closed when a probe target is reachable", async () => {
    const reachable = JSON.stringify([{ host: "10.213.89.1", port: 5433, why: "a published container port on the host (10.213.89.1:5433)" }]);
    const fake = fakeDocker({ network: true, images: [BUILTIN_BASE_IMAGE], ports: "0.0.0.0:5433->5432/tcp", probeOutput: reachable });
    const result = await backendWith(fake).availability!();
    expect(result.status).toBe("setup-required");
    expect((result as { message: string }).message).toContain("10.213.89.1:5433");
    const probe = fake.calls.find((call) => call.args[0] === "run" && call.args.includes(`${LABEL_PROBE}=1`))!;
    expect(probe.args).toContain("--rm");
    expect(probe.args[probe.args.indexOf("--cap-drop") + 1]).toBe("ALL");
    const targets = JSON.parse(probe.args.at(-1)!) as Array<{ host: string; port: number }>;
    expect(targets).toContainEqual(expect.objectContaining({ host: "10.213.89.1", port: 5433 }));
  });

  test("availability is available when nothing private answers, and caches the probe", async () => {
    const fake = fakeDocker({ network: true, images: [BUILTIN_BASE_IMAGE], probeOutput: "[]" });
    const backend = backendWith(fake);
    expect(await backend.availability!()).toEqual({ status: "available" });
    expect(await backend.availability!()).toEqual({ status: "available" });
    expect(fake.calls.filter((call) => call.args[0] === "run").length).toBe(1);
  });

  test("availability fails closed when the probe itself can't run", async () => {
    const fake = fakeDocker({ network: { ...goodNetwork(), Labels: {} }, images: [BUILTIN_BASE_IMAGE] });
    const result = await backendWith(fake).availability!();
    expect(result.status).toBe("setup-required");
  });
});
