export interface CloudLookupSdk {
  threads: { get(args: { threadId: string }): Promise<{ environmentId?: string | null }> };
  environments: { get(args: { environmentId: string }): Promise<{ hostId: string }> };
  hosts: { get(args: { hostId: string }): Promise<{ machineProviderId?: string | null }> };
}

const hostsByEnvironment = new Map<string, Promise<boolean | null>>();

export function isCloudProvider(machineProviderId: string | null | undefined): boolean {
  return typeof machineProviderId === "string" && machineProviderId.trim() !== "";
}

export async function threadOnCloudMachine(sdk: CloudLookupSdk, threadId: string): Promise<boolean | null> {
  let environmentId: string | null;
  try {
    environmentId = (await sdk.threads.get({ threadId })).environmentId ?? null;
  } catch {
    return null;
  }
  if (environmentId === null) return null;
  let cached = hostsByEnvironment.get(environmentId);
  if (cached === undefined) {
    const id = environmentId;
    cached = (async () => {
      try {
        const environment = await sdk.environments.get({ environmentId: id });
        const host = await sdk.hosts.get({ hostId: environment.hostId });
        return isCloudProvider(host.machineProviderId);
      } catch {
        hostsByEnvironment.delete(id);
        return null;
      }
    })();
    hostsByEnvironment.set(environmentId, cached);
  }
  return cached;
}

export function resetCloudLookups(): void {
  hostsByEnvironment.clear();
}
