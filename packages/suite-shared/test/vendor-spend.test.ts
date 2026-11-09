import { describe, expect, it } from "bun:test";
import type { VendorSpendRefusal } from "../src/machine-backend-server.ts";
import { setup } from "./sandbox-harness.ts";

function withVendor(t: ReturnType<typeof setup>, verdict: () => VendorSpendRefusal | null | Error) {
  let calls = 0;
  t.fake.backend.vendorSpendRefusal = async () => {
    calls += 1;
    const value = verdict();
    if (value instanceof Error) throw value;
    return value;
  };
  return { calls: () => calls };
}

describe("vendor spend check", () => {
  it("refuses create, suspends running sandboxes and never extends past the vendor's cap", async () => {
    let verdict: VendorSpendRefusal | null = null;
    const t = setup({ hourlyRateUsd: 0.01, monthlyCapUsd: 30, idleMinutes: null, ttlMinutes: 10, maxConcurrent: null });
    const vendor = withVendor(t, () => verdict);
    const { hostId } = await t.create("thr_v1");
    verdict = { reason: "cap", message: "Fake Sandbox: the vendor says $45.00 of the $30.00 cap is used." };
    t.clock.advance(1);
    await t.registration.bumpIdle(hostId!);
    await t.registration.sweep();
    expect(t.fake.calls.extend).toBe(0);
    expect(t.sdk.state.suspends).toEqual([hostId!]);
    await expect(t.registration.extendTtl(hostId!)).rejects.toThrow("$45.00");
    const refused = await t.create("thr_v2");
    expect(refused.result).toMatchObject({ status: "failed", message: expect.stringContaining("$45.00") });
    expect(t.fake.calls.create).toBe(1);
    expect(await t.sdk.machine.availability!()).toMatchObject({ status: "unavailable", message: expect.stringContaining("$45.00") });
    expect(await t.registration.refusal()).toContain("$45.00");
    expect(vendor.calls()).toBeGreaterThan(0);
  });

  it("an unreadable meter refuses create and stops renewals without suspending anything", async () => {
    const t = setup({ hourlyRateUsd: 0.01, monthlyCapUsd: 30, idleMinutes: null, ttlMinutes: 10, maxConcurrent: null });
    let failing = false;
    withVendor(t, () => (failing ? new Error("timeout token=abc123") : null));
    const { hostId } = await t.create("thr_u1");
    failing = true;
    t.clock.advance(1);
    await t.registration.bumpIdle(hostId!);
    await t.registration.sweep();
    expect(t.fake.calls.extend).toBe(0);
    expect(t.sdk.state.suspends).toEqual([]);
    const refused = await t.create("thr_u2");
    expect(refused.result).toMatchObject({ status: "failed", message: expect.stringContaining("couldn't check this month's spend") });
    expect(JSON.stringify(refused.result)).not.toContain("abc123");
    failing = false;
    await t.registration.sweep();
    expect(t.fake.calls.extend).toBe(1);
  });
});

describe("spend is recorded at the rate a sandbox ran at", () => {
  it("doesn't reprice past time when the rate changes, and a resume picks up the new rate", async () => {
    let rate = 1;
    const t = setup(() => ({ hourlyRateUsd: rate, monthlyCapUsd: null, idleMinutes: null, maxConcurrent: null }));
    const { hostId } = await t.create("thr_rate");
    t.clock.advance(60);
    rate = 0.1;
    expect((await t.registration.usage()).estimatedUsd).toBeCloseTo(1, 5);
    t.clock.advance(60);
    expect((await t.registration.usage()).estimatedUsd).toBeCloseTo(2, 5);
    await t.suspend(hostId!);
    await t.resume(hostId!);
    t.clock.advance(60);
    const usage = await t.registration.usage();
    expect(usage.estimatedUsd).toBeCloseTo(2.1, 5);
    expect(usage.runningMs).toBe(180 * 60_000);
  });
});
