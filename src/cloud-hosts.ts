export const MANUAL_MACHINE_PROVIDER_ID = "manual";

export interface CloudHostFacts {
  id: string;
  type?: string | null;
  machineProviderId?: string | null;
}

export function isCloudHost(host: CloudHostFacts): boolean {
  const provider = host.machineProviderId?.trim() || null;
  if (provider !== null) return provider !== MANUAL_MACHINE_PROVIDER_ID;
  return host.type === "ephemeral";
}

export function cloudHostIdsOf(hosts: readonly CloudHostFacts[]): string[] {
  return [...new Set(hosts.filter(isCloudHost).map((host) => host.id))].sort();
}

export function sameHostIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export type RowHostLabel =
  | { kind: "cloud"; name: string }
  | { kind: "text"; text: string }
  | null;

export function rowHostLabel({
  host,
  primaryHostId,
  cloudHostIds,
  hasWorkspaceOrBranch,
}: {
  host: { id: string; name: string } | null | undefined;
  primaryHostId: string | null;
  cloudHostIds: ReadonlySet<string> | null;
  hasWorkspaceOrBranch: boolean;
}): RowHostLabel {
  if (!host) return null;
  const name = host.name?.trim() || null;
  if (cloudHostIds?.has(host.id)) return { kind: "cloud", name: name ?? host.id };
  if (host.id !== primaryHostId) return { kind: "text", text: `Host: ${host.name}` };
  if (!hasWorkspaceOrBranch && name !== null) return { kind: "text", text: `Host: ${name}` };
  return null;
}

export function rowHostDisplay(
  label: RowHostLabel,
  showHostText: boolean,
): { cloudName: string | null; hostText: string | null } {
  if (label?.kind === "cloud") return { cloudName: label.name, hostText: null };
  return { cloudName: null, hostText: showHostText && label?.kind === "text" ? label.text : null };
}

const HOST_GROUP_PREFIX = "environment:host:";

export function cloudGroupHost(
  groupKey: string,
  cloudHostIds: ReadonlySet<string> | null,
): string | null {
  if (cloudHostIds === null || !groupKey.startsWith(HOST_GROUP_PREFIX)) return null;
  const hostId = groupKey.slice(HOST_GROUP_PREFIX.length);
  return cloudHostIds.has(hostId) ? hostId : null;
}
