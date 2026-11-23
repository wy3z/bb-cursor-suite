import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { buildPooledOrdinarySection, buildSections, buildArchivedSection, flattenShelf } from "./forest";
import {
  archivedNewestFirst,
  coerceEnvironmentFilter,
  coerceSidebarView,
  DEFAULT_SIDEBAR_VIEW,
  environmentFilterOptions,
  familyAwareComparator,
  filterOrdinaryThreads,
  groupOrdinaryRows,
  machineGroupHostId,
  machineGroupIcon,
  machineGroupOf,
  ordinaryCollapsibleTargets,
  ordinaryFamilyFacts,
  ordinaryFamilyGroupKeys,
  ordinaryThreadStatus,
  archivedMembers,
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

const filterMembers = () => [
  thread("local-1", "p", 50, { host: LOCAL }),
  thread("no-host", "p", 45),
  thread("box-1", "p", 40, { host: BOX }),
  thread("cloud-a", "p", 30, { host: SANDBOX_A }),
  thread("cloud-b", "p", 20, { host: SANDBOX_B }),
  thread("cloud-child", "p", 60, { host: LOCAL, parentThreadId: "cloud-a" }),
];

function filtered(environmentFilter: string[] | null, cloudHostIds: ReadonlySet<string> | null = CLOUD) {
  return filterOrdinaryThreads(filterMembers(), { ...DEFAULT_SIDEBAR_VIEW, environmentFilter }, {
    now: 100, bypass: () => false, primaryHostId: LOCAL.id, cloudHostIds,
  }).map((entry) => entry.id);
}

test("environment filter offers Local, each other machine by name, then Cloud", () => {
  assert.deepEqual(
    environmentFilterOptions(filterMembers(), { primaryHostId: LOCAL.id, cloudHostIds: CLOUD }),
    [
      { id: "machine:local", label: "Local" },
      { id: "machine:host:host_box", label: "box" },
      { id: "machine:cloud", label: "Cloud" },
    ],
  );
});

test("environment filter options fall back to machine entries when cloud status is unknown", () => {
  assert.deepEqual(
    environmentFilterOptions(filterMembers(), { primaryHostId: LOCAL.id, cloudHostIds: null }).map((option) => option.label),
    ["Local", "box", "Modal sandbox a", "Modal sandbox b"],
  );
});

test("environment filter keeps exactly the selected machine groups by family", () => {
  assert.deepEqual(filtered(["machine:cloud"]), ["cloud-a", "cloud-b", "cloud-child"]);
  assert.deepEqual(filtered(["machine:local"]), ["local-1", "no-host"]);
  assert.deepEqual(filtered(["machine:host:host_box", "machine:local"]), ["local-1", "no-host", "box-1"]);
  assert.deepEqual(filtered([]), []);
  assert.equal(filtered(null).length, 6);
});

test("environment filter falls back to the machine entry when cloud status is unknown", () => {
  assert.deepEqual(filtered(["machine:host:host_sa"], null), ["cloud-a", "cloud-child"]);
  assert.deepEqual(filtered(["machine:cloud"], null), []);
});

test("saved per-environment filter values are ignored instead of hiding threads", () => {
  assert.equal(coerceEnvironmentFilter(["name:bb-plugins", "host:host_local", "__none__", "env_abc"]), null);
  assert.deepEqual(coerceEnvironmentFilter(["host:host_local", "machine:cloud"]), ["machine:cloud"]);
  assert.deepEqual(coerceEnvironmentFilter([]), []);
  assert.equal(coerceEnvironmentFilter(null), null);
  assert.equal(coerceEnvironmentFilter("machine:cloud"), null);
  const migrated = coerceSidebarView({ ...DEFAULT_SIDEBAR_VIEW, environmentFilter: ["name:arch"] });
  assert.equal(migrated.environmentFilter, null);
  assert.equal(filterOrdinaryThreads(filterMembers(), migrated, { now: 100, bypass: () => false }).length, 6);
});

function familyKeys(members: PluginSidebarThread[]) {
  const parentOf = (id: string) => members.find((entry) => entry.id === id)?.parentThreadId ?? null;
  const familyFacts = ordinaryFamilyFacts(members, { parentOf, statusOf: ordinaryThreadStatus });
  const facts = { now: 100, parentOf, statusOf: ordinaryThreadStatus, familyFacts, primaryHostId: LOCAL.id, cloudHostIds: CLOUD };
  return {
    keys: Object.fromEntries(ordinaryFamilyGroupKeys(members, { ...DEFAULT_SIDEBAR_VIEW, groupBy: "environment" }, facts)),
    options: environmentFilterOptions(members, facts).map((option) => option.id),
    cloudOnly: filterOrdinaryThreads(members, { ...DEFAULT_SIDEBAR_VIEW, environmentFilter: ["machine:cloud"] }, { ...facts, bypass: () => false }).map((entry) => entry.id),
  };
}

test("a family's machine comes from its root even when a child is listed first", () => {
  const result = familyKeys([
    thread("child", "p", 50, { host: LOCAL, parentThreadId: "root" }),
    thread("root", "p", 10, { host: SANDBOX_A }),
  ]);
  assert.deepEqual(result.keys, { child: "machine:cloud", root: "machine:cloud" });
  assert.deepEqual(result.options, ["machine:cloud"]);
  assert.deepEqual(result.cloudOnly, ["child", "root"]);
});

test("mixed hosts in one family follow the root", () => {
  const result = familyKeys([
    thread("root", "p", 10, { host: BOX }),
    thread("cloud-child", "p", 30, { host: SANDBOX_A, parentThreadId: "root" }),
    thread("local-child", "p", 20, { host: LOCAL, parentThreadId: "root" }),
  ]);
  assert.deepEqual(result.keys, { root: "machine:host:host_box", "cloud-child": "machine:host:host_box", "local-child": "machine:host:host_box" });
  assert.deepEqual(result.options, ["machine:host:host_box"]);
  assert.deepEqual(result.cloudOnly, []);
});

test("a hostless root keeps its family Local even with a cloud child", () => {
  const result = familyKeys([
    thread("cloud-child", "p", 30, { host: SANDBOX_A, parentThreadId: "root" }),
    thread("root", "p", 10),
  ]);
  assert.deepEqual(result.keys, { "cloud-child": "machine:local", root: "machine:local" });
  assert.deepEqual(result.options, ["machine:local"]);
  assert.deepEqual(result.cloudOnly, []);
});

for (const order of ["updated", "status"] as const) {
  test(`${order} order puts a lead's active children first, then the latest activity`, () => {
    const members = [
      thread("lead", "p", 100),
      thread("idle-old", "p", 10, { parentThreadId: "lead" }),
      thread("idle-new", "p", 50, { parentThreadId: "lead" }),
      thread("working-old", "p", 5, { parentThreadId: "lead", indicator: "runtime" }),
      thread("waiting", "p", 20, { parentThreadId: "lead", hasPendingInteraction: true }),
    ];
    const parentOf = (id: string) => members.find((entry) => entry.id === id)?.parentThreadId ?? null;
    const familyFacts = ordinaryFamilyFacts(members, { parentOf, statusOf: ordinaryThreadStatus });
    const homes = buildSections(members, [{ id: "p", name: "P" }],
      () => "active", () => ({ compare: familyAwareComparator(order, familyFacts) }));
    assert.deepEqual(
      flattenShelf(homes[0]!, "active").map((row) => row.thread.id),
      ["lead", "waiting", "working-old", "idle-new", "idle-old"],
    );
  });
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

function activityGroups(
  members: PluginSidebarThread[],
  overrides: Partial<typeof DEFAULT_SIDEBAR_VIEW> = {},
): { key: string; label: string | null; ids: string[] }[] {
  const view = { ...DEFAULT_SIDEBAR_VIEW, groupBy: "activity" as const, ...overrides };
  const parentOf = (id: string) => members.find((entry) => entry.id === id)?.parentThreadId ?? null;
  const familyFacts = ordinaryFamilyFacts(members, { parentOf, statusOf: ordinaryThreadStatus });
  const homes = buildSections(members, [{ id: "p", name: "P" }],
    () => "active", () => ({ compare: familyAwareComparator(view.sortConversationsBy, familyFacts) }));
  const pool = buildPooledOrdinarySection(homes, "pool", "Chats");
  return groupOrdinaryRows(flattenShelf(pool, "active"), view,
    { now: NOW, parentOf, statusOf: ordinaryThreadStatus, members, familyFacts })
    .map((group) => ({ key: group.key, label: group.label, ids: group.rows.map((row) => row.thread.id) }));
}

const WORKFLOW = { workflows: 1, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 };

test("activity grouping renders a headless inbox, then Working; old idle threads stay in the inbox", () => {
  assert.deepEqual(activityGroups([
    thread("old-idle", "p", NOW - 30 * DAY),
    thread("working", "p", NOW - 1000, { indicator: "runtime" }),
    thread("quiet", "p", NOW - 2 * DAY),
    thread("unread", "p", NOW - 3 * DAY, { isUnread: true }),
    thread("input", "p", NOW - 5 * DAY, { hasPendingInteraction: true }),
    thread("failed", "p", NOW - 4 * DAY, { indicator: "unread-error" }),
  ]), [
    { key: "activity:inbox", label: null, ids: ["quiet", "unread", "failed", "input", "old-idle"] },
    { key: "activity:working", label: "Working", ids: ["working"] },
  ]);
});

test("activity sections use the selected ordering inside each section", () => {
  const members = () => [
    thread("quiet-new", "p", NOW - DAY),
    thread("input-old", "p", NOW - 5 * DAY, { hasPendingInteraction: true }),
    thread("unread-mid", "p", NOW - 3 * DAY, { isUnread: true }),
    thread("working-old", "p", NOW - 2 * DAY, { activity: WORKFLOW }),
    thread("working-new", "p", NOW - 1, { indicator: "runtime" }),
  ];
  assert.deepEqual(activityGroups(members(), { sortConversationsBy: "updated" }).map((group) => group.ids), [
    ["quiet-new", "unread-mid", "input-old"],
    ["working-new", "working-old"],
  ]);
  assert.deepEqual(activityGroups(members(), { sortConversationsBy: "status" }).map((group) => group.ids), [
    ["input-old", "unread-mid", "quiet-new"],
    ["working-new", "working-old"],
  ]);
});

test("activity grouping hides an empty inbox or Working section", () => {
  assert.deepEqual(activityGroups([thread("quiet", "p", NOW - DAY)]).map((group) => group.key), ["activity:inbox"]);
  assert.deepEqual(activityGroups([
    thread("working", "p", NOW - 9 * DAY, { indicator: "runtime" }),
  ]).map((group) => group.key), ["activity:working"]);
});

test("activity sections keep T3's order when groups are sorted by most recent", () => {
  assert.deepEqual(activityGroups([
    thread("working", "p", NOW - 9 * DAY, { indicator: "runtime" }),
    thread("quiet", "p", NOW - 3 * DAY),
  ], { sortGroupsBy: "updated" }).map((group) => group.key), ["activity:inbox", "activity:working"]);
});

test("activity places a family by its aggregate and keeps it together: attention wins, then working", () => {
  assert.deepEqual(activityGroups([
    thread("quiet", "p", NOW - DAY),
    thread("lead-working", "p", NOW - 10, { indicator: "runtime" }),
    thread("lead-working-child", "p", NOW - 20, { parentThreadId: "lead-working", isUnread: true }),
    thread("old-lead", "p", NOW - 20 * DAY),
    thread("old-lead-child", "p", NOW - 30 * DAY, { parentThreadId: "old-lead", indicator: "runtime" }),
  ]).map((group) => [group.key, group.ids]), [
    ["activity:inbox", ["lead-working", "lead-working-child", "quiet"]],
    ["activity:working", ["old-lead", "old-lead-child"]],
  ]);
});

test("Working and Archived are activity toggles, not collapsed-group keys, and the inbox has none", () => {
  const members = [
    thread("quiet", "p", NOW - DAY),
    thread("working", "p", NOW - 1, { indicator: "runtime" }),
  ];
  const targets = ordinaryCollapsibleTargets([{
    id: "pool", isPersonal: true, members, childrenOf: () => [], parentOf: () => null,
  }], { ...DEFAULT_SIDEBAR_VIEW, groupBy: "activity" }, {
    now: NOW, folderIds: new Set(), statusOf: ordinaryThreadStatus,
  });
  assert.deepEqual([...targets.groupKeys], []);
  assert.deepEqual([...targets.activityKeys].sort(), ["activity:archived", "activity:working"]);
  const other = ordinaryCollapsibleTargets([{
    id: "pool", isPersonal: true, members, childrenOf: () => [], parentOf: () => null,
  }], { ...DEFAULT_SIDEBAR_VIEW, groupBy: "status" }, {
    now: NOW, folderIds: new Set(), statusOf: ordinaryThreadStatus,
  });
  assert.deepEqual([...other.activityKeys], []);
});

test("Archived takes archived, visible threads only", () => {
  assert.deepEqual(archivedMembers([
    thread("active", "p", 1),
    thread("archived", "p", 1, { isArchived: true, archivedAt: 10 }),
    thread("hidden", "p", 1, { isArchived: true, archivedAt: 11, isHidden: true }),
  ]).map((entry) => entry.id), ["archived"]);
});

test("Archived goes through the list's own filters: status, PR, age, repository, environment and project", () => {
  const archived = (id: string, overrides: Partial<PluginSidebarThread> = {}) =>
    thread(id, "p", NOW - DAY, { isArchived: true, archivedAt: NOW, host: LOCAL, ...overrides });
  const members = archivedMembers([
    archived("keep"),
    archived("unread", { isUnread: true }),
    archived("old", { updatedAt: NOW - 60 * DAY }),
    archived("other-project", { projectId: "q" }),
    archived("cloud", { host: SANDBOX_A }),
    archived("merged"),
  ]);
  const view = {
    ...DEFAULT_SIDEBAR_VIEW,
    groupBy: "activity" as const,
    statusFilter: ["idle" as const],
    ageFilter: ["Yesterday" as const, "Last 7 days" as const],
    projectFilter: ["p"],
    environmentFilter: ["machine:local"],
    prFilter: ["none" as const, "open" as const],
  };
  const kept = filterOrdinaryThreads(members, view, {
    now: NOW,
    primaryHostId: LOCAL.id,
    cloudHostIds: CLOUD,
    prStateOf: (entry) => (entry.id === "merged" ? "merged" : "none"),
    bypass: () => false,
  });
  assert.deepEqual(kept.map((entry) => entry.id), ["keep"]);
});

test("Archived orders families newest archived first and keeps children under their parent", () => {
  const members = archivedMembers([
    thread("old", "p", 50, { isArchived: true, archivedAt: 100 }),
    thread("new", "q", 1, { isArchived: true, archivedAt: 300 }),
    thread("parent", "p", 1, { isArchived: true, archivedAt: 200 }),
    thread("child", "p", 1, { isArchived: true, archivedAt: 400, parentThreadId: "parent" }),
  ]);
  const pool = buildArchivedSection(members, "archived", archivedNewestFirst);
  assert.deepEqual(flattenShelf(pool, "settled").map((row) => [row.thread.id, row.depth]), [
    ["new", 0], ["parent", 0], ["child", 1], ["old", 0],
  ]);
});

test("a saved Activity ordering becomes the Activity grouping with Updated ordering", () => {
  const migrated = coerceSidebarView({ ...DEFAULT_SIDEBAR_VIEW, groupBy: "environment", sortConversationsBy: "activity" });
  assert.equal(migrated.groupBy, "activity");
  assert.equal(migrated.sortConversationsBy, "updated");
  const kept = coerceSidebarView({ ...DEFAULT_SIDEBAR_VIEW, groupBy: "activity", sortConversationsBy: "status" });
  assert.equal(kept.groupBy, "activity");
  assert.equal(kept.sortConversationsBy, "status");
});
