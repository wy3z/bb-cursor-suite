export type PluginAvailability = "unknown" | "available" | "unavailable";

export interface PluginListing {
  readonly id: string;
  readonly enabled: boolean;
  readonly status: string;
}

export const NEEDS_PULL_REQUESTS = "Needs Pull Requests";

const LIVE_STATUSES: ReadonlySet<string> = new Set(["running", "degraded"]);

export function pluginAvailability(plugins: readonly PluginListing[], pluginId: string): PluginAvailability {
  const plugin = plugins.find((entry) => entry.id === pluginId);
  return plugin !== undefined && plugin.enabled && LIVE_STATUSES.has(plugin.status) ? "available" : "unavailable";
}
