import { describe, expect, it } from "vitest";
import {
  accessibleTriggerLabel,
  buildModel,
  environmentFor,
  locationOf,
  sameLocation,
  triggerLabel,
  type PickerProvider,
  type PickerWorktree,
} from "./model";

function provider(id: string, overrides: Partial<PickerProvider> = {}): PickerProvider {
  return {
    id,
    displayName: id,
    icon: null,
    logoUrl: null,
    machineProviderId: null,
    availability: null,
    machineAvailability: { host_a: { status: "available" } },
    ...overrides,
  };
}

const LOCAL = provider("project-checkout", { displayName: "Project checkout" });
const WORKTREE = provider("git-worktree", { displayName: "Worktree" });
const COW = provider("btrfs-cow", { displayName: "Btrfs Cow" });
const MODAL = provider("modal-sandbox", { displayName: "Modal Sandbox", machineProviderId: "modal-sandbox", machineAvailability: {} });
const BOAT = provider("boat-sandbox", { displayName: "Boat Sandbox", machineProviderId: "boat" });

const worktree = (id: string, updatedAt: number, branchName: string | null = `branch-${id}`): PickerWorktree => ({
  id,
  name: null,
  branchName,
  path: `/tmp/worktrees/${id}/repo`,
  updatedAt,
});

describe("buildModel", () => {
  it("puts providers with a machineProviderId under Cloud and other local ones under Worktrees", () => {
    const model = buildModel([LOCAL, WORKTREE, COW, MODAL], []);
    expect(model.local?.provider.id).toBe("project-checkout");
    expect(model.newWorktree?.provider.id).toBe("git-worktree");
    expect(model.cloud.map((entry) => entry.provider.id)).toEqual(["modal-sandbox"]);
    expect(model.others.map((entry) => entry.provider.id)).toEqual(["btrfs-cow"]);
  });

  it("has no cloud entries when no provider runs on a machine provider", () => {
    expect(buildModel([LOCAL, WORKTREE], []).cloud).toEqual([]);
    expect(buildModel([LOCAL, provider("blank", { machineProviderId: "  " })], []).cloud).toEqual([]);
  });

  it("never lists the personal workspace", () => {
    const model = buildModel([LOCAL, provider("personal-workspace")], []);
    expect(model.others).toEqual([]);
  });

  it("disables a provider its machines or availability refuse", () => {
    const refused = provider("git-worktree", {
      machineAvailability: { host_a: { status: "unavailable", message: "Not a git repository." } },
    });
    expect(buildModel([refused], []).newWorktree?.disabledReason).toBe("Not a git repository.");
    const setup = provider("boat-sandbox", { machineProviderId: "boat", availability: { status: "setup-required", message: "Add an API key." } });
    expect(buildModel([setup], []).cloud[0]?.disabledReason).toBe("Add an API key.");
    expect(buildModel([MODAL], []).cloud[0]?.disabledReason).toBeNull();
  });

  it("orders existing worktrees newest first", () => {
    const model = buildModel([], [worktree("a", 1), worktree("b", 3), worktree("c", 2)]);
    expect(model.worktrees.map((entry) => entry.id)).toEqual(["b", "c", "a"]);
  });
});

describe("locationOf", () => {
  const providers = [LOCAL, WORKTREE, COW, MODAL];

  it("reads every shape the composer reports", () => {
    expect(locationOf({ type: "provider", environmentProviderId: "project-checkout", inputs: null }, providers)).toEqual({ kind: "local" });
    expect(locationOf({ type: "provider", environmentProviderId: "git-worktree", inputs: null }, providers)).toEqual({ kind: "new-worktree" });
    expect(locationOf({ type: "provider", environmentProviderId: "modal-sandbox", inputs: null }, providers)).toEqual({ kind: "cloud", providerId: "modal-sandbox" });
    expect(locationOf({ type: "provider", environmentProviderId: "btrfs-cow", inputs: null }, providers)).toEqual({ kind: "provider", providerId: "btrfs-cow" });
    expect(locationOf({ type: "provider", environmentProviderId: "personal-workspace", inputs: null }, providers)).toEqual({ kind: "personal" });
    expect(locationOf({ type: "reuse", environmentId: "env_1" }, providers)).toEqual({ kind: "worktree", environmentId: "env_1" });
    expect(locationOf({ type: "host", hostId: "host_a", workspace: { type: "unmanaged", path: null } }, providers)).toEqual({ kind: "local" });
    expect(locationOf({ type: "host", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } }, providers)).toEqual({ kind: "new-worktree" });
    expect(locationOf({ type: "project-default" }, providers)).toBeNull();
    expect(locationOf(undefined, providers)).toBeNull();
  });

  it("treats an unknown provider on a new machine as cloud", () => {
    const args = { type: "provider" as const, environmentProviderId: "later", inputs: null, machine: { type: "new" as const, machineProviderId: "later", inputs: null } };
    expect(locationOf(args, providers)).toEqual({ kind: "cloud", providerId: "later" });
  });
});

describe("environmentFor", () => {
  it("keeps the composer's host for local choices and lets core create the cloud machine", () => {
    expect(environmentFor({ kind: "local" }, "host_a")).toEqual({
      type: "provider",
      environmentProviderId: "project-checkout",
      inputs: null,
      machine: { type: "existing", hostId: "host_a" },
    });
    expect(environmentFor({ kind: "new-worktree" }, null)).toEqual({ type: "provider", environmentProviderId: "git-worktree", inputs: null });
    expect(environmentFor({ kind: "cloud", providerId: "modal-sandbox" }, "host_a")).toEqual({
      type: "provider",
      environmentProviderId: "modal-sandbox",
      inputs: null,
    });
    expect(environmentFor({ kind: "worktree", environmentId: "env_1" }, "host_a")).toEqual({ type: "reuse", environmentId: "env_1" });
    expect(environmentFor({ kind: "personal" }, "host_a")).toBeNull();
  });
});

describe("triggerLabel", () => {
  it("uses Cursor's names", () => {
    const model = buildModel([LOCAL, WORKTREE, COW, MODAL], [worktree("env_1", 1, "feature-x")]);
    expect(triggerLabel({ kind: "local" }, model)?.label).toBe("This Computer");
    expect(triggerLabel({ kind: "new-worktree" }, model)?.label).toBe("New Worktree");
    expect(triggerLabel({ kind: "cloud", providerId: "modal-sandbox" }, model)).toMatchObject({ label: "Cloud", detail: null });
    expect(triggerLabel({ kind: "provider", providerId: "btrfs-cow" }, model)?.label).toBe("Btrfs Cow");
    const existing = triggerLabel({ kind: "worktree", environmentId: "env_1" }, model);
    expect(existing).toMatchObject({ label: "Worktree", detail: "feature-x" });
    expect(accessibleTriggerLabel(existing!)).toBe("Worktree: feature-x, select environment");
    expect(triggerLabel({ kind: "personal" }, model)).toBeNull();
    expect(triggerLabel(null, model)).toBeNull();
  });

  it("names the provider when there is more than one cloud", () => {
    const model = buildModel([MODAL, BOAT], []);
    expect(triggerLabel({ kind: "cloud", providerId: "boat-sandbox" }, model)).toMatchObject({ label: "Cloud", detail: "Boat Sandbox" });
  });
});

describe("sameLocation", () => {
  it("compares by kind and identity", () => {
    expect(sameLocation({ kind: "local" }, { kind: "local" })).toBe(true);
    expect(sameLocation({ kind: "cloud", providerId: "a" }, { kind: "cloud", providerId: "b" })).toBe(false);
    expect(sameLocation({ kind: "worktree", environmentId: "a" }, { kind: "worktree", environmentId: "a" })).toBe(true);
    expect(sameLocation(null, { kind: "local" })).toBe(false);
  });
});
