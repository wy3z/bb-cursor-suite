import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudGroupHost, cloudHostIdsOf, isCloudHost, rowHostLabel, sameHostIds } from "./cloud-hosts";

test("a provider sandbox is cloud", () => {
  assert.equal(isCloudHost({ id: "host_83ufksdhp3", type: "ephemeral", machineProviderId: "modal-sandbox" }), true);
});

test("a persistent provider machine is cloud", () => {
  assert.equal(isCloudHost({ id: "h", type: "persistent", machineProviderId: "boat" }), true);
});

test("the local host is not cloud", () => {
  assert.equal(isCloudHost({ id: "host_5qqwqc9eye", type: "persistent", machineProviderId: null }), false);
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

test("only a cloud host's environment heading is a cloud group", () => {
  assert.equal(cloudGroupHost("environment:host:host_83ufksdhp3", cloud), "host_83ufksdhp3");
  assert.equal(cloudGroupHost("environment:host:host_box", cloud), null);
  assert.equal(cloudGroupHost("environment:name:host_83ufksdhp3", cloud), null);
  assert.equal(cloudGroupHost("status:working", cloud), null);
  assert.equal(cloudGroupHost("environment:host:host_83ufksdhp3", null), null);
});
