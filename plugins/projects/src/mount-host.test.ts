import { describe, expect, it } from "vitest";
import { visibleMount, watchMountHost, type MountState } from "./mount-host";

interface Slot {
  id: string;
  child: Node | null;
}

interface Node {
  slot: Slot;
}

function harness(initial: Slot | null, graceMs = 5) {
  let slot = initial;
  let listener = () => undefined as void;
  const changes: [string | null, MountState][] = [];
  const stop = watchMountHost<Slot, Node>({
    locate: () => slot,
    attach: (target) => {
      const node = { slot: target };
      target.child = node;
      return node;
    },
    holds: (target, node) => target.child === node,
    detach: (node) => {
      if (node.slot.child === node) node.slot.child = null;
    },
    observe: (next) => {
      listener = next;
      return () => {
        listener = () => undefined;
      };
    },
    onChange: (host, state) => changes.push([host?.slot.id ?? null, state]),
    graceMs,
  });
  return {
    changes,
    stop,
    setSlot(next: Slot | null) {
      slot = next;
      listener();
    },
    mutate: () => listener(),
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function canShowTabs(leadId: string | null, state: MountState) {
  return leadId === null || state !== "missing";
}

describe("watchMountHost", () => {
  it("mounts straight away when the header slot is there", () => {
    const { changes } = harness({ id: "header", child: null });
    expect(changes).toEqual([["header", "mounted"]]);
  });

  it("stays pending through the grace period, then reports missing once", async () => {
    const run = harness(null);
    run.mutate();
    run.mutate();
    expect(run.changes).toEqual([[null, "pending"]]);
    await wait(20);
    run.mutate();
    expect(run.changes).toEqual([
      [null, "pending"],
      [null, "missing"],
    ]);
    run.stop();
  });

  it("mounts when the header shows up late, without passing through missing", async () => {
    const run = harness(null, 50);
    run.setSlot({ id: "late", child: null });
    await wait(80);
    expect(run.changes).toEqual([
      [null, "pending"],
      ["late", "mounted"],
    ]);
    run.stop();
  });

  it("treats a header that re-renders as pending, not missing", async () => {
    const run = harness({ id: "first", child: null }, 50);
    run.setSlot(null);
    run.setSlot({ id: "second", child: null });
    await wait(80);
    expect(run.changes).toEqual([
      ["first", "mounted"],
      [null, "pending"],
      ["second", "mounted"],
    ]);
    run.stop();
  });

  it("ignores mutations while the host is still in its slot", () => {
    const run = harness({ id: "header", child: null });
    run.mutate();
    run.mutate();
    expect(run.changes).toEqual([["header", "mounted"]]);
  });

  it("recovers from missing when the header finally appears", async () => {
    const run = harness(null);
    await wait(20);
    run.setSlot({ id: "header", child: null });
    expect(run.changes.at(-1)).toEqual(["header", "mounted"]);
    run.stop();
  });

  it("detaches its node when stopped", () => {
    const slot: Slot = { id: "header", child: null };
    const run = harness(slot);
    run.stop();
    expect(slot.child).toBeNull();
  });
});

describe("visibleMount", () => {
  const mounted = { token: "lead:lead", host: "node", state: "mounted" as const };

  it("is pending on the first render of a new lead route, before the watcher runs", () => {
    expect(visibleMount(mounted, "lead:worker")).toEqual({ host: null, state: "pending" });
    expect(visibleMount({ token: null, host: null, state: "pending" }, "lead:lead")).toEqual({ host: null, state: "pending" });
  });

  it("shows the mounted host for the current route and nothing when inactive", () => {
    expect(visibleMount(mounted, "lead:lead")).toEqual({ host: "node", state: "mounted" });
    expect(visibleMount(mounted, null)).toEqual({ host: null, state: "pending" });
  });
});

describe("tab host registration", () => {
  it("stays registered from entering a lead route until the strip mounts, so the sidebar highlight never flickers", async () => {
    const seen: boolean[] = [canShowTabs("thr_lead", visibleMount({ token: null, host: null, state: "pending" }, "thr_lead:thr_lead").state)];
    const run = harness(null, 50);
    for (const [, state] of run.changes) seen.push(canShowTabs("thr_lead", state));
    run.setSlot({ id: "header", child: null });
    for (const [, state] of run.changes) seen.push(canShowTabs("thr_lead", state));
    expect(seen.every(Boolean)).toBe(true);
    run.stop();
  });

  it("drops out only once the strip is truly missing, and always counts off a lead", async () => {
    const run = harness(null);
    await wait(20);
    expect(canShowTabs("thr_lead", run.changes.at(-1)![1])).toBe(false);
    expect(canShowTabs(null, "missing")).toBe(true);
    run.stop();
  });
});
