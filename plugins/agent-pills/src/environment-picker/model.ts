import type { ComposerSelection } from "@get-bb/plugin-sdk/app";

export type EnvironmentArgs = NonNullable<ComposerSelection["environment"]>;

export const LOCAL_PROVIDER = "project-checkout";
export const WORKTREE_PROVIDER = "git-worktree";
export const PERSONAL_PROVIDER = "personal-workspace";

export const CLOUD_LEARN_MORE_URL = "https://github.com/wy3z/bb-cursor-suite#cloud-agents";

type Availability =
  | { status: "available" }
  | { status: "setup-required" | "unavailable"; message: string }
  | null;

export interface PickerProvider {
  id: string;
  displayName: string;
  description?: string | null;
  icon: string | null;
  logoUrl: string | null;
  machineProviderId: string | null;
  availability: Availability;
  machineAvailability?: Record<string, Availability>;
}

export interface PickerWorktree {
  id: string;
  name: string | null;
  branchName: string | null;
  path: string | null;
  updatedAt: number;
}

export type Location =
  | { kind: "local" }
  | { kind: "new-worktree" }
  | { kind: "worktree"; environmentId: string }
  | { kind: "cloud"; providerId: string }
  | { kind: "provider"; providerId: string }
  | { kind: "personal" };

export interface ProviderState {
  provider: PickerProvider;
  disabledReason: string | null;
}

export type CloudUnavailable = "none-installed" | "not-for-project";

export interface PickerModel {
  local: ProviderState | null;
  newWorktree: ProviderState | null;
  cloud: ProviderState[];
  cloudUnavailable: CloudUnavailable | null;
  others: ProviderState[];
  worktrees: PickerWorktree[];
}

export const CLOUD_DESCRIPTION = "Runs on a cloud machine with a fresh clone of this project.";
export const NO_CLOUD_MESSAGE = "Install a cloud machine plugin to run agents in the cloud.";
export const CLOUD_NOT_FOR_PROJECT_MESSAGE = "Cloud isn't available for this project.";

export function cloudUnavailableMessage(reason: CloudUnavailable): string {
  return reason === "none-installed" ? NO_CLOUD_MESSAGE : CLOUD_NOT_FOR_PROJECT_MESSAGE;
}

export const isCloudProvider = (provider: Pick<PickerProvider, "machineProviderId">): boolean =>
  (provider.machineProviderId?.trim() ?? "") !== "";

function unavailableMessage(availability: Availability): string | null {
  if (availability === null || availability.status === "available") return null;
  return availability.message;
}

export function disabledReason(provider: PickerProvider): string | null {
  const own = unavailableMessage(provider.availability);
  if (own !== null) return own;
  if (isCloudProvider(provider)) return null;
  const machines = Object.values(provider.machineAvailability ?? {});
  if (machines.length === 0 || machines.some((entry) => entry === null || entry.status === "available")) return null;
  return machines.map(unavailableMessage).find((message) => message !== null) ?? "Unavailable for this project.";
}

const MAX_WORKTREES = 20;

export function buildModel(
  providers: readonly PickerProvider[],
  worktrees: readonly PickerWorktree[],
  catalog: readonly Pick<PickerProvider, "machineProviderId">[] = providers,
): PickerModel {
  const state = (provider: PickerProvider): ProviderState => ({ provider, disabledReason: disabledReason(provider) });
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const local = byId.get(LOCAL_PROVIDER);
  const worktree = byId.get(WORKTREE_PROVIDER);
  const builtIn = new Set([LOCAL_PROVIDER, WORKTREE_PROVIDER, PERSONAL_PROVIDER]);
  const cloud = providers.filter(isCloudProvider).map(state);
  const cloudUnavailable: CloudUnavailable | null =
    cloud.length > 0 ? null : catalog.some(isCloudProvider) ? "not-for-project" : "none-installed";
  return {
    local: local && !isCloudProvider(local) ? state(local) : null,
    newWorktree: worktree && !isCloudProvider(worktree) ? state(worktree) : null,
    cloud,
    cloudUnavailable,
    others: providers.filter((provider) => !isCloudProvider(provider) && !builtIn.has(provider.id)).map(state),
    worktrees: [...worktrees].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_WORKTREES),
  };
}

export function locationOf(
  environment: EnvironmentArgs | undefined,
  providers: readonly PickerProvider[],
): Location | null {
  if (!environment) return null;
  switch (environment.type) {
    case "reuse":
      return { kind: "worktree", environmentId: environment.environmentId };
    case "host":
      if (environment.workspace.type === "unmanaged") return { kind: "local" };
      if (environment.workspace.type === "managed-worktree") return { kind: "new-worktree" };
      return { kind: "personal" };
    case "provider": {
      const id = environment.environmentProviderId;
      if (id === LOCAL_PROVIDER) return { kind: "local" };
      if (id === WORKTREE_PROVIDER) return { kind: "new-worktree" };
      if (id === PERSONAL_PROVIDER) return { kind: "personal" };
      const provider = providers.find((entry) => entry.id === id);
      if (provider ? isCloudProvider(provider) : environment.machine?.type === "new") {
        return { kind: "cloud", providerId: id };
      }
      return { kind: "provider", providerId: id };
    }
    default:
      return null;
  }
}

export function hostIdOf(environment: EnvironmentArgs | undefined): string | null {
  if (!environment) return null;
  if (environment.type === "host") return environment.hostId ?? null;
  if (environment.type === "provider" && environment.machine?.type === "existing") return environment.machine.hostId;
  return null;
}

export function environmentFor(location: Location, hostId: string | null): EnvironmentArgs | null {
  const onHost = hostId === null ? {} : { machine: { type: "existing" as const, hostId } };
  switch (location.kind) {
    case "local":
      return { type: "provider", environmentProviderId: LOCAL_PROVIDER, inputs: null, ...onHost };
    case "new-worktree":
      return { type: "provider", environmentProviderId: WORKTREE_PROVIDER, inputs: null, ...onHost };
    case "worktree":
      return { type: "reuse", environmentId: location.environmentId };
    case "cloud":
      return { type: "provider", environmentProviderId: location.providerId, inputs: null };
    case "provider":
      return { type: "provider", environmentProviderId: location.providerId, inputs: null, ...onHost };
    case "personal":
      return null;
  }
}

export function sameLocation(a: Location | null, b: Location | null): boolean {
  if (a === null || b === null || a.kind !== b.kind) return false;
  if (a.kind === "worktree" && b.kind === "worktree") return a.environmentId === b.environmentId;
  if ((a.kind === "cloud" || a.kind === "provider") && (b.kind === "cloud" || b.kind === "provider")) {
    return a.providerId === b.providerId;
  }
  return true;
}

export function worktreeLabel(worktree: PickerWorktree): string {
  const name = worktree.name?.trim() || worktree.branchName?.trim();
  if (name) return name;
  const parts = (worktree.path ?? "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? worktree.id;
}

export interface TriggerLabel {
  label: string;
  detail: string | null;
  icon: "laptop" | "fork" | "cloud" | "provider" | "server";
  providerId: string | null;
}

export interface Machines {
  primaryHostId: string | null;
  connectedHostCount: number;
}

export function isRemoteHost(selectedHostId: string | null, machines: Machines): boolean {
  return selectedHostId !== null && selectedHostId !== machines.primaryHostId;
}

export function canReplaceBbPicker(selectedHostId: string | null, machines: Machines): boolean {
  return machines.connectedHostCount <= 1 && !isRemoteHost(selectedHostId, machines);
}

export function triggerLabel(location: Location | null, model: PickerModel, remoteHostName: string | null = null): TriggerLabel | null {
  if (location === null || location.kind === "personal") return null;
  if (remoteHostName !== null && location.kind !== "cloud" && location.kind !== "worktree") {
    const base = triggerLabel(location, model);
    return { label: remoteHostName, detail: base?.label ?? null, icon: "server", providerId: null };
  }
  switch (location.kind) {
    case "local":
      return { label: "This Computer", detail: null, icon: "laptop", providerId: null };
    case "new-worktree":
      return { label: "New Worktree", detail: null, icon: "fork", providerId: null };
    case "worktree": {
      const worktree = model.worktrees.find((entry) => entry.id === location.environmentId);
      return { label: "Worktree", detail: worktree ? worktreeLabel(worktree) : null, icon: "fork", providerId: null };
    }
    case "cloud": {
      const provider = model.cloud.find((entry) => entry.provider.id === location.providerId)?.provider;
      const detail = model.cloud.length > 1 ? (provider?.displayName ?? location.providerId) : null;
      return { label: "Cloud", detail, icon: "cloud", providerId: location.providerId };
    }
    case "provider": {
      const provider = model.others.find((entry) => entry.provider.id === location.providerId)?.provider;
      return { label: provider?.displayName ?? location.providerId, detail: null, icon: "provider", providerId: location.providerId };
    }
  }
}

export function accessibleTriggerLabel(label: TriggerLabel): string {
  const text = label.detail ? `${label.label}: ${label.detail}` : label.label;
  return `${text}, select environment`;
}

export const INLINE_WORKTREE_LIMIT = 3;
export const MENU_WIDTH = 280;
export const SUBMENU_GAP = 4;
const EDGE = 8;

export type SubmenuSide = "right" | "left" | "inline";

export function submenuSide(menuLeft: number, viewportWidth: number): SubmenuSide {
  const width = MENU_WIDTH + SUBMENU_GAP;
  if (menuLeft + MENU_WIDTH + width <= viewportWidth - EDGE) return "right";
  if (menuLeft - width >= EDGE) return "left";
  return "inline";
}
