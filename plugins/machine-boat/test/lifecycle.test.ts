import { describe, expect, test } from "bun:test";
import { readSandboxResource, registerSandboxBackend } from "@wy3z/bb-suite/machine-backend/server";
import { Clock, fakeBb, report } from "@wy3z/bb-suite/testing/sandbox-fakes";
import { createBoatApi } from "../lib/api.ts";
import { LABEL_NAME, PROVIDER_ID, createBoatBackend } from "../lib/backend.ts";
import { createBoatService } from "../lib/rpc.ts";
import { policyFrom, type BoatSettings } from "../lib/settings.ts";
import { FakeBoat, TEST_KEY } from "./fake-boat.ts";

const SETTINGS: BoatSettings = {
  apiKey: TEST_KEY,
  size: "small",
  environment: "",
  idleMinutes: 15,
  ttlHours: 2,
  maxConcurrent: 1,
  monthlyCapUsd: 30,
  keepStoppedDays: 12,
};

function world(over: Partial<BoatSettings> = {}) {
  const clock = new Clock(Date.parse("2026-11-09T12:00:00Z"));
  const sdk = fakeBb(clock);
  const boat = new FakeBoat();
  const settings = { ...SETTINGS, ...over };
  const api = createBoatApi({ apiKey: async () => settings.apiKey, fetch: boat.fetch as typeof fetch, baseUrl: "https://boat.test/api/v1" });
  const backend = createBoatBackend({ api, settings: async () => settings, now: clock.now, sleep: async () => undefined, pollMs: 1, log: sdk.bb.log });
  const registration = registerSandboxBackend(sdk.bb, backend, async () => policyFrom(settings), { now: clock.now });
  const service = createBoatService({
    backend,
    registration,
    settings: async () => settings,
    api,
    machines: {
      host: async (hostId) => sdk.hosts.find((host) => host.id === hostId) ?? null,
      resource: async (hostId) => sdk.resources.get(hostId) ?? null,
    },
  });
  const signal = () => new AbortController().signal;

  async function create(key: string) {
    const progress = report();
    const result = await sdk.machine.create({ key, attempt: 1, inputs: null as never, checkpoint: async () => undefined, report: progress.progress, signal: signal() });
    if (result.status !== "created") return { result, hostId: null, lines: progress.lines };
    const hostId = `host_${sdk.state.nextHost}abcdef`;
    sdk.hosts.push({ id: hostId, machineProviderId: PROVIDER_ID, lifecycle: { phase: "active" } });
    sdk.resources.set(hostId, result.resource);
    return { result, hostId, lines: progress.lines };
  }

  async function suspend(hostId: string) {
    const progress = report();
    const out = await sdk.machine.suspend!({
      hostId,
      resource: sdk.resources.get(hostId) as never,
      checkpoint: async (resource) => void sdk.resources.set(hostId, resource),
      report: progress.progress,
      signal: signal(),
    });
    sdk.resources.set(hostId, out.resource);
    sdk.hosts.find((host) => host.id === hostId)!.lifecycle.phase = "suspended";
    return { resource: readSandboxResource(out.resource), lines: progress.lines };
  }

  async function resume(hostId: string) {
    const progress = report();
    const out = await sdk.machine.resume!({
      hostId,
      resource: sdk.resources.get(hostId) as never,
      checkpoint: async (resource) => void sdk.resources.set(hostId, resource),
      report: progress.progress,
      signal: signal(),
    });
    sdk.resources.set(hostId, out.resource);
    sdk.hosts.find((host) => host.id === hostId)!.lifecycle.phase = "active";
    return { resource: readSandboxResource(out.resource), lines: progress.lines };
  }

  async function remove(hostId: string) {
    const progress = report();
    return sdk.machine.remove!({ hostId, resource: sdk.resources.get(hostId) as never, report: progress.progress, signal: signal() } as never);
  }

  return { clock, sdk, boat, backend, service, registration, create, suspend, resume, remove };
}

describe("Boat Sandbox through the shared helper", () => {
  test("create, suspend, resume and remove a machine, leaving nothing on boat", async () => {
    const w = world();
    const created = await w.create("thr_life");
    expect(created.result.status).toBe("created");
    const resource = readSandboxResource(created.result.status === "created" ? created.result.resource : null);
    expect(resource).toMatchObject({ providerId: PROVIDER_ID, state: "running", init: "unknown" });
    const sandbox = w.boat.sandboxes.get(resource.sandboxId!)!;
    expect(sandbox.labels[LABEL_NAME]).toBe(resource.name);
    expect(w.boat.commands.length).toBeGreaterThanOrEqual(2);
    expect(w.boat.files.size).toBe(0);

    const suspended = await w.suspend(created.hostId!);
    expect(suspended.resource).toMatchObject({ state: "suspended", sandboxId: sandbox.id, snapshotId: null });
    expect(sandbox.state).toBe("archived");

    const resumed = await w.resume(created.hostId!);
    expect(resumed.resource).toMatchObject({ state: "running", sandboxId: sandbox.id });
    expect(sandbox.state).toBe("ready");
    expect(w.boat.calls("POST", `/sandboxes/${sandbox.id}/resume`)).toHaveLength(1);

    const machine = await w.service.inspectMachine(created.hostId!);
    expect(machine).toMatchObject({ providerId: PROVIDER_ID, sandboxId: sandbox.id, state: "ready", running: true, size: "small", vcpu: 2 });
    expect(JSON.stringify(machine)).not.toContain("token");

    expect(await w.remove(created.hostId!)).toEqual({ status: "removed" });
    expect(w.boat.sandboxes.size).toBe(0);
  });

  test("max concurrent refuses a second running sandbox before boat is called", async () => {
    const w = world();
    expect((await w.create("thr_a")).result.status).toBe("created");
    const second = await w.create("thr_b");
    expect(second.result).toMatchObject({ status: "failed", message: expect.stringContaining("max concurrent 1") });
    expect(w.boat.calls("POST", "/sandboxes")).toHaveLength(1);
  });

  test("the key never reaches resources, progress lines, logs or RPC output", async () => {
    const w = world();
    w.boat.trialTtlCap = 60;
    const failed = await w.create("thr_secret");
    w.boat.trialTtlCap = 7200;
    const ok = await w.create("thr_secret2");
    const usage = await w.service.usage();
    const account = await w.service.inspectAccount();
    const everything = JSON.stringify([failed, ok, [...w.sdk.resources.values()], w.sdk.logs, usage, account, [...w.sdk.kv.entries()]]);
    expect(everything).not.toContain(TEST_KEY);
    expect(everything).not.toContain("secretdesktoptoken");
  });

  test("account inspect and usage mirror Modal's shape plus boat's limits and spend", async () => {
    const w = world();
    w.boat.deletedCostUsd = 1.25;
    expect(await w.service.inspectAccount()).toMatchObject({ available: true, providerId: PROVIDER_ID, plan: "trial", canStart: true, maxActiveSandboxes: 2 });
    expect(await w.service.usage()).toMatchObject({ capUsd: 30, size: "small", hourlyRateUsd: 0.018, vendor: { usd: 1.25 }, refusal: null });
    const none = world({ apiKey: "" });
    expect(await none.service.inspectAccount()).toMatchObject({ available: false, message: expect.stringContaining("no boat.dev API key") });
  });

  test("boat's meter over the cap refuses create before boat is called, stops renewals and suspends running VMs", async () => {
    const w = world({ maxConcurrent: 2 });
    const first = await w.create("thr_meter");
    expect(first.result.status).toBe("created");
    w.boat.deletedCostUsd = 40;
    w.clock.advance(2);
    const second = await w.create("thr_meter2");
    expect(second.result).toMatchObject({ status: "failed", message: expect.stringContaining("($40.00 of boat.dev machine time") });
    expect(w.boat.calls("POST", "/sandboxes")).toHaveLength(1);
    await w.registration.bumpIdle(first.hostId!);
    await w.registration.sweep();
    expect(w.sdk.state.suspends).toEqual([first.hostId!]);
    expect(w.boat.requests.filter((request) => request.method === "PATCH")).toHaveLength(0);
    expect((await w.service.usage()).refusal).toContain("$40.00");
  });

  test("usage.get's refusal is what create would answer, including the concurrency limit", async () => {
    const w = world();
    expect((await w.service.usage()).refusal).toBeNull();
    await w.create("thr_slot");
    expect((await w.service.usage()).refusal).toContain("max concurrent 1");
  });

  test("machine inspect refuses hosts from other providers", async () => {
    const w = world();
    w.sdk.hosts.push({ id: "host_local", machineProviderId: null, lifecycle: { phase: "active" } });
    await expect(w.service.inspectMachine("host_local")).rejects.toThrow(/isn't a Boat Sandbox machine/);
  });
});
