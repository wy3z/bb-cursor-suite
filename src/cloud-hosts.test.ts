import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cloudHostIdsOf,
  createCloudHostsLoader,
  createCloudHostWatcher,
  isCloudHost,
  rowHostDisplay,
  rowHostLabel,
  sameHostIds,
  type CloudHostFacts,
} from "./cloud-hosts";

test("a provider sandbox is cloud", () => {
  assert.equal(isCloudHost({ id: "host_83ufksdhp3", type: "ephemeral", machineProviderId: "modal-sandbox" }), true);
});

test("a persistent provider machine is cloud", () => {
  assert.equal(isCloudHost({ id: "h", type: "persistent", machineProviderId: "boat" }), true);
});

test("the local host is not cloud", () => {
  assert.equal(isCloudHost({ id: "host_5qqwqc9eye", type: "persistent", machineProviderId: null }), false);
});

test("an ephemeral host is cloud even with the manual provider", () => {
  assert.equal(isCloudHost({ id: "e", type: "ephemeral", machineProviderId: "manual" }), true);
});

test("a manually enrolled machine is not cloud", () => {
  assert.equal(isCloudHost({ id: "h", type: "persistent", machineProviderId: "manual" }), false);
  assert.equal(isCloudHost({ id: "h", type: "persistent", machineProviderId: " manual " }), false);
});

test("an ephemeral host with no provider id is cloud", () => {
  assert.equal(isCloudHost({ id: "h", type: "ephemeral", machineProviderId: null }), true);
  assert.equal(isCloudHost({ id: "h", type: "ephemeral", machineProviderId: "  " }), true);
});

test("missing facts are not cloud", () => {
  assert.equal(isCloudHost({ id: "h" }), false);
});

test("cloud host ids are unique and sorted", () => {
  assert.deepEqual(
    cloudHostIdsOf([
      { id: "host_b", type: "ephemeral", machineProviderId: "modal-sandbox" },
      { id: "host_local", type: "persistent", machineProviderId: null },
      { id: "host_a", type: "persistent", machineProviderId: "boat" },
      { id: "host_b", type: "ephemeral", machineProviderId: "modal-sandbox" },
      { id: "host_m", type: "persistent", machineProviderId: "manual" },
    ]),
    ["host_a", "host_b"],
  );
  assert.equal(sameHostIds(["a", "b"], ["a", "b"]), true);
  assert.equal(sameHostIds(["a"], ["a", "b"]), false);
  assert.equal(sameHostIds(["a", "c"], ["a", "b"]), false);
});

const cloud = new Set(["host_83ufksdhp3"]);
const sandbox = { id: "host_83ufksdhp3", name: "Modal sandbox ksdhp3" };
const remote = { id: "host_box", name: "box" };
const local = { id: "host_local", name: "arch" };

test("a cloud host row gets the cloud glyph with the machine name", () => {
  assert.deepEqual(
    rowHostLabel({ host: sandbox, primaryHostId: "host_local", cloudHostIds: cloud, hasWorkspaceOrBranch: true }),
    { kind: "cloud", name: "Modal sandbox ksdhp3" },
  );
});

test("a cloud host with a blank name falls back to its id", () => {
  assert.deepEqual(
    rowHostLabel({ host: { id: "host_83ufksdhp3", name: " " }, primaryHostId: null, cloudHostIds: cloud, hasWorkspaceOrBranch: false }),
    { kind: "cloud", name: "host_83ufksdhp3" },
  );
});

test("unknown cloud facts keep today's text", () => {
  assert.deepEqual(
    rowHostLabel({ host: sandbox, primaryHostId: "host_local", cloudHostIds: null, hasWorkspaceOrBranch: true }),
    { kind: "text", text: "Host: Modal sandbox ksdhp3" },
  );
});

test("an enrolled remote host keeps today's text", () => {
  assert.deepEqual(
    rowHostLabel({ host: remote, primaryHostId: "host_local", cloudHostIds: cloud, hasWorkspaceOrBranch: true }),
    { kind: "text", text: "Host: box" },
  );
});

test("the local host is only named when nothing else locates the row", () => {
  assert.equal(
    rowHostLabel({ host: local, primaryHostId: "host_local", cloudHostIds: cloud, hasWorkspaceOrBranch: true }),
    null,
  );
  assert.deepEqual(
    rowHostLabel({ host: local, primaryHostId: "host_local", cloudHostIds: cloud, hasWorkspaceOrBranch: false }),
    { kind: "text", text: "Host: arch" },
  );
});

test("a row without a host has no host label", () => {
  assert.equal(rowHostLabel({ host: null, primaryHostId: null, cloudHostIds: cloud, hasWorkspaceOrBranch: false }), null);
});

test("the cloud glyph shows whether or not the Machine option is on", () => {
  const label = { kind: "cloud", name: "Modal sandbox ksdhp3" } as const;
  assert.deepEqual(rowHostDisplay(label, true), { cloudName: "Modal sandbox ksdhp3", hostText: null });
  assert.deepEqual(rowHostDisplay(label, false), { cloudName: "Modal sandbox ksdhp3", hostText: null });
});

test("the Machine option only controls host text", () => {
  const label = { kind: "text", text: "Host: box" } as const;
  assert.deepEqual(rowHostDisplay(label, true), { cloudName: null, hostText: "Host: box" });
  assert.deepEqual(rowHostDisplay(label, false), { cloudName: null, hostText: null });
  assert.deepEqual(rowHostDisplay(null, true), { cloudName: null, hostText: null });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sandboxHost = (id: string): CloudHostFacts => ({ id, type: "ephemeral", machineProviderId: "modal-sandbox" });

test("loader clears to null when a refresh fails after a success", async () => {
  const applied: Array<string[] | null> = [];
  let fail = false;
  const load = createCloudHostsLoader(
    async () => {
      if (fail) throw new Error("offline");
      return ["host_a"];
    },
    (ids) => applied.push(ids === null ? null : [...ids]),
  );
  await load();
  fail = true;
  await load();
  assert.deepEqual(applied, [["host_a"], null]);
});

test("loader drops a stale in-flight response", async () => {
  const slow = deferred<readonly string[]>();
  const fast = deferred<readonly string[]>();
  const queue = [slow, fast];
  const applied: Array<string[] | null> = [];
  const load = createCloudHostsLoader(
    () => queue.shift()!.promise,
    (ids) => applied.push(ids === null ? null : [...ids]),
  );
  const first = load();
  const second = load();
  fast.reject(new Error("offline"));
  await second;
  slow.resolve(["host_a"]);
  await first;
  assert.deepEqual(applied, [null]);
});

test("an RPC read between a host change and the debounced refresh still notifies", async () => {
  let hosts: CloudHostFacts[] = [sandboxHost("host_a")];
  let published = 0;
  const watcher = createCloudHostWatcher({
    list: async () => hosts,
    publish: () => published++,
    debounceMs: 5,
  });
  watcher.notify();
  await sleep(20);
  assert.equal(published, 1);
  assert.deepEqual(await watcher.read(), ["host_a"]);
  hosts = [sandboxHost("host_b")];
  watcher.notify();
  assert.deepEqual(await watcher.read(), ["host_b"]);
  await sleep(20);
  assert.equal(published, 2);
  watcher.notify();
  await sleep(20);
  assert.equal(published, 2);
  watcher.dispose();
});

test("a burst of host changes publishes once", async () => {
  let published = 0;
  const watcher = createCloudHostWatcher({
    list: async () => [sandboxHost("host_a")],
    publish: () => published++,
    debounceMs: 5,
  });
  watcher.notify();
  watcher.notify();
  watcher.notify();
  await sleep(20);
  assert.equal(published, 1);
  watcher.dispose();
});

test("an older refresh never publishes over a newer one", async () => {
  const first = deferred<readonly CloudHostFacts[]>();
  const second = deferred<readonly CloudHostFacts[]>();
  const queue = [first, second];
  let published = 0;
  const watcher = createCloudHostWatcher({
    list: () => queue.shift()!.promise,
    publish: () => published++,
    debounceMs: 1,
  });
  watcher.notify();
  await sleep(10);
  watcher.notify();
  await sleep(10);
  second.resolve([sandboxHost("host_b")]);
  await sleep(5);
  first.resolve([sandboxHost("host_a")]);
  await sleep(5);
  assert.equal(published, 1);
  watcher.dispose();
});

test("disposal during an outstanding host list never publishes and aborts the read", async () => {
  const pending = deferred<readonly CloudHostFacts[]>();
  let signal: AbortSignal | null = null;
  let published = 0;
  const watcher = createCloudHostWatcher({
    list: (listSignal) => {
      signal = listSignal;
      return pending.promise;
    },
    publish: () => published++,
    debounceMs: 1,
  });
  watcher.notify();
  await sleep(10);
  watcher.dispose();
  assert.equal(signal!.aborted, true);
  pending.resolve([sandboxHost("host_a")]);
  await sleep(5);
  watcher.notify();
  await sleep(10);
  assert.equal(published, 0);
});
