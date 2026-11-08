import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { buildPooledOrdinarySection, buildSections, flattenShelf } from "./forest";
import {
  DEFAULT_SIDEBAR_VIEW,
  familyAwareComparator,
  groupOrdinaryRows,
  machineGroupHostId,
  machineGroupIcon,
  machineGroupOf,
  ordinaryFamilyFacts,
  ordinaryThreadStatus,
} from "./sidebar-view";

function thread(id: string, projectId: string, updatedAt: number,
  overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id, projectId, title: id, titleFallback: null, displayTitle: id,
    parentThreadId: null, lifecycleOwnerThreadId: null, parentNotifications: "auto",
    sourceThreadId: null, sectionId: null, originKind: null, originPluginId: null,
    providerId: "codex", status: "idle", runtimeStatus: "idle", queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
    indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false,
    pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null,
    href: `/threads/${id}`, isHidden: false, environment: null, host: null,
    createdAt: 0, updatedAt, lastReadAt: null, latestAttentionAt: 0,
    ...overrides,
  };
}

for (const groupBy of ["status", "updated", "environment"] as const) {
  test(`${groupBy} groups sort conversations across projects and keep children together`, () => {
    const members = [
      thread("a-old", "a", 10),
      thread("a-new", "a", 30),
      thread("b-parent", "b", 5),
      thread("b-child", "b", 20, { parentThreadId: "b-parent" }),
      thread("b-old", "b", 1),
    ];
    const render = () => {
      const parentOf = (id: string) => members.find((entry) => entry.id === id)?.parentThreadId ?? null;
      const familyFacts = ordinaryFamilyFacts(members, { parentOf, statusOf: ordinaryThreadStatus });
      const homes = buildSections(members, [{ id: "a", name: "A" }, { id: "b", name: "B" }],
        () => "active", () => ({ compare: familyAwareComparator("updated", familyFacts) }));
      const pool = buildPooledOrdinarySection(homes, "pool", "Chats");
      return groupOrdinaryRows(flattenShelf(pool, "active"), {
        ...DEFAULT_SIDEBAR_VIEW, groupBy, sortConversationsBy: "updated",
      }, { now: 100, parentOf, statusOf: ordinaryThreadStatus, members, familyFacts })
        .flatMap((group) => group.rows.map((row) => row.thread.id));
    };
    assert.deepEqual(render(), ["a-new", "b-parent", "b-child", "a-old", "b-old"]);
    members[0]!.updatedAt = 40;
    assert.deepEqual(render(), ["a-old", "a-new", "b-parent", "b-child", "b-old"]);
  });
}

const LOCAL = { id: "host_local", name: "arch" };
const BOX = { id: "host_box", name: "box" };
const SANDBOX_A = { id: "host_sa", name: "Modal sandbox a" };
const SANDBOX_B = { id: "host_sb", name: "Modal sandbox b" };
const CLOUD = new Set([SANDBOX_A.id, SANDBOX_B.id]);

function machineGroups(
  members: PluginSidebarThread[],
  cloudHostIds: ReadonlySet<string> | null,
  primaryHostId: string | null = LOCAL.id,
) {
  const parentOf = (id: string) => members.find((entry) => entry.id === id)?.parentThreadId ?? null;
  const familyFacts = ordinaryFamilyFacts(members, { parentOf, statusOf: ordinaryThreadStatus });
  const homes = buildSections(members, [{ id: "p", name: "P" }],
    () => "active", () => ({ compare: familyAwareComparator("updated", familyFacts) }));
  const pool = buildPooledOrdinarySection(homes, "pool", "Chats");
  return groupOrdinaryRows(flattenShelf(pool, "active"), {
    ...DEFAULT_SIDEBAR_VIEW, groupBy: "environment", sortGroupsBy: "manual", sortConversationsBy: "updated",
  }, { now: 100, parentOf, statusOf: ordinaryThreadStatus, members, familyFacts, primaryHostId, cloudHostIds })
    .map((group) => ({ key: group.key, label: group.label, ids: group.rows.map((row) => row.thread.id) }));
}

test("environment grouping splits by machine with every cloud machine in one Cloud group", () => {
  const groups = machineGroups([
    thread("local-1", "p", 50, { host: LOCAL }),
    thread("no-host", "p", 40),
    thread("box-1", "p", 30, { host: BOX }),
    thread("cloud-a", "p", 20, { host: SANDBOX_A }),
    thread("cloud-b", "p", 10, { host: SANDBOX_B }),
  ], CLOUD);
  assert.deepEqual(groups, [
    { key: "machine:local", label: "Local", ids: ["local-1", "no-host"] },
    { key: "machine:host:host_box", label: "box", ids: ["box-1"] },
    { key: "machine:cloud", label: "Cloud", ids: ["cloud-a", "cloud-b"] },
  ]);
});

test("environment grouping hides empty machine groups", () => {
  assert.deepEqual(
    machineGroups([thread("cloud-a", "p", 20, { host: SANDBOX_A })], CLOUD).map((group) => group.key),
    ["machine:cloud"],
  );
  assert.deepEqual(
    machineGroups([thread("local-1", "p", 20, { host: LOCAL })], CLOUD).map((group) => group.key),
    ["machine:local"],
  );
});

test("unknown cloud status falls back to the machine's own group", () => {
  assert.deepEqual(
    machineGroups([
      thread("cloud-a", "p", 20, { host: SANDBOX_A }),
      thread("local-1", "p", 10, { host: LOCAL }),
    ], null),
    [
      { key: "machine:local", label: "Local", ids: ["local-1"] },
      { key: "machine:host:host_sa", label: "Modal sandbox a", ids: ["cloud-a"] },
    ],
  );
});

test("a child thread sits in its family root's machine group", () => {
  const groups = machineGroups([
    thread("root", "p", 10, { host: SANDBOX_A }),
    thread("child", "p", 50, { host: LOCAL, parentThreadId: "root" }),
  ], CLOUD);
  assert.deepEqual(groups, [{ key: "machine:cloud", label: "Cloud", ids: ["root", "child"] }]);
});

test("machine group keys never reuse the old per-environment keys", () => {
  for (const host of [null, LOCAL, BOX, SANDBOX_A]) {
    assert.match(machineGroupOf(host, LOCAL.id, CLOUD).key, /^machine:/);
  }
});

test("machine group icons and grouped hosts", () => {
  assert.equal(machineGroupIcon("machine:local"), "Laptop");
  assert.equal(machineGroupIcon("machine:cloud"), "Cloud");
  assert.equal(machineGroupIcon("machine:host:host_box"), "Monitor");
  assert.equal(machineGroupIcon("status:working"), null);
  assert.equal(machineGroupHostId("machine:local", LOCAL.id), LOCAL.id);
  assert.equal(machineGroupHostId("machine:host:host_box", LOCAL.id), "host_box");
  assert.equal(machineGroupHostId("machine:cloud", LOCAL.id), null);
  assert.deepEqual(machineGroupOf({ id: "host_box", name: null }, LOCAL.id, CLOUD), { key: "machine:host:host_box", label: "host_box" });
});
