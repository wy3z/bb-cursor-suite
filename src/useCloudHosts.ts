import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { CLOUD_HOSTS_CHANNEL } from "./channels";
import type { cursorSidebarRpcContract } from "./server";

export function useCloudHosts(): ReadonlySet<string> | null {
  const rpc = useRpc<typeof cursorSidebarRpcContract>();
  const realtimeState = useRealtimeConnectionState();
  const [hostIds, setHostIds] = useState<ReadonlySet<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("cloudHosts", {});
      setHostIds((current) => {
        if (current !== null && current.size === result.hostIds.length && result.hostIds.every((id) => current.has(id))) {
          return current;
        }
        return new Set(result.hostIds);
      });
    } catch {
      return;
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load, realtimeState]);
  useRealtime(CLOUD_HOSTS_CHANNEL, () => {
    void load();
  });

  return hostIds;
}
