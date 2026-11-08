export const MANUAL_MACHINE_PROVIDER_ID = "manual";

export interface CloudHostFacts {
  id: string;
  type?: string | null;
  machineProviderId?: string | null;
}

export function isCloudHost(host: CloudHostFacts): boolean {
  const provider = host.machineProviderId?.trim() || null;
  return host.type === "ephemeral" || (provider !== null && provider !== MANUAL_MACHINE_PROVIDER_ID);
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

export function createCloudHostsLoader(
  fetchIds: () => Promise<readonly string[]>,
  apply: (hostIds: ReadonlySet<string> | null) => void,
): () => Promise<void> {
  let latest = 0;
  return async () => {
    const request = ++latest;
    let next: ReadonlySet<string> | null;
    try {
      next = new Set(await fetchIds());
    } catch {
      next = null;
    }
    if (request === latest) apply(next);
  };
}

export function createCloudHostWatcher({
  list,
  publish,
  debounceMs = 250,
}: {
  list: (signal: AbortSignal) => Promise<readonly CloudHostFacts[]>;
  publish: () => void;
  debounceMs?: number;
}): { read: () => Promise<string[]>; notify: () => void; dispose: () => void } {
  const controller = new AbortController();
  let notified: string[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let disposed = false;

  const refresh = async (): Promise<void> => {
    const mine = ++generation;
    let hostIds: string[] | null;
    try {
      hostIds = cloudHostIdsOf(await list(controller.signal));
    } catch {
      hostIds = null;
    }
    if (disposed || mine !== generation) return;
    if (hostIds === null) {
      notified = null;
      return;
    }
    if (notified !== null && sameHostIds(notified, hostIds)) return;
    notified = hostIds;
    publish();
  };

  return {
    read: async () => cloudHostIdsOf(await list(controller.signal)),
    notify: () => {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, debounceMs);
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      controller.abort();
    },
  };
}
