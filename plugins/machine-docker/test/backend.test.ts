import { describe, expect, test } from "bun:test";
import {
  KEEPALIVE,
  LABEL_KEY,
  LABEL_MANAGED,
  LABEL_NAME,
  NETWORK_NAME,
  createDockerBackend,
  dockerSandboxName,
  runArgs,
} from "../lib/backend.ts";
import type { DockerResult, DockerRunOptions } from "../lib/docker.ts";
import { BUILTIN_BASE_TAG, BUILTIN_DOCKERFILE, builtinImageTag } from "../lib/image.ts";
import { policyFrom, readDockerSettings, type DockerSettings } from "../lib/settings.ts";

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

function fakeDocker(initial: { images?: string[]; containers?: Container[]; network?: boolean } = {}) {
  const calls: Array<{ args: string[]; options: DockerRunOptions }> = [];
  const images = new Set(initial.images ?? []);
  const containers = new Map((initial.containers ?? []).map((item) => [item.id, item]));
  let network = initial.network ?? false;
  let next = 1;
  const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string): DockerResult => ({ code: 1, stdout: "", stderr });
  const run = async (args: string[], options: DockerRunOptions = {}): Promise<DockerResult> => {
    calls.push({ args, options });
    const [a, b] = args;
    if (a === "version") return ok("29.9.3\n");
    if (a === "image" && b === "inspect") return images.has(args.at(-1)!) ? ok("sha256:x\n") : fail("Error: No such image");
    if (a === "build") {
      for (let i = 0; i < args.length; i += 1) if (args[i] === "--tag") images.add(args[i + 1]!);
      return ok();
    }
    if (a === "pull") {
      images.add(args[1]!);
      return ok();
    }
    if (a === "network" && b === "ls") return ok(network ? "net1\n" : "");
    if (a === "network" && b === "create") {
      network = true;
      return ok("net1\n");
    }
    if (a === "network" && b === "rm") {
      network = false;
      return ok();
    }
    if (a === "run") {
      const name = args[args.indexOf("--name") + 1]!;
      const id = `c${next++}`.padEnd(12, "0");
      containers.set(id, { id, name, running: true, managed: true });
      return ok(`${id}\n`);
    }
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
    if (a === "volume" && b === "ls") return ok("");
    if (a === "exec") return ok();
    return fail(`unexpected docker ${args.join(" ")}`);
  };
  return { run, calls, images, containers, network: () => network };
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
  test("builds the built-in image from stdin once, tagged by content and as base", async () => {
    const fake = fakeDocker();
    const backend = backendWith(fake);
    const progress = report();
    const handle = await backend.create({ key: "k1", name: "bb-docker-k1", inputs: null, ttlMs: 0, signal: signal(), report: progress.progress });
    const build = fake.calls.find((call) => call.args[0] === "build")!;
    expect(build.options.stdin).toBe(BUILTIN_DOCKERFILE);
    expect(build.args).toContain(builtinImageTag());
    expect(build.args).toContain(BUILTIN_BASE_TAG);
    expect(build.args.at(-1)).toBe("-");
    expect(handle).toMatchObject({ running: true, expiresAt: 1_000_000 + 7_200_000, meta: { image: builtinImageTag() } });
    await backend.create({ key: "k2", name: "bb-docker-k2", inputs: null, ttlMs: 0, signal: signal(), report: progress.progress });
    expect(fake.calls.filter((call) => call.args[0] === "build")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.args[0] === "network" && call.args[1] === "create")).toHaveLength(1);
  });

  test("pulls a custom image instead of building", async () => {
    const fake = fakeDocker();
    const backend = backendWith(fake, { image: "debian:custom" });
    await backend.create({ key: "k", name: "bb-docker-k", inputs: null, ttlMs: 0, signal: signal(), report: report().progress });
    expect(fake.calls.some((call) => call.args[0] === "pull" && call.args[1] === "debian:custom")).toBe(true);
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
    expect(fake.network()).toBe(true);
    await backend.remove({ name: "bb-docker-other", sandboxIds: [], snapshotIds: [], signal: signal(), report: report().progress });
    expect(fake.network()).toBe(false);
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
