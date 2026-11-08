import { useEffect, useMemo, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { CLOUD_HOSTS_CHANNEL } from "./channels";
import { createCloudHostsLoader } from "./cloud-hosts";
import type { cursorSidebarRpcContract } from "./server";

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

export function useCloudHosts(): ReadonlySet<string> | null {
  const rpc = useRpc<typeof cursorSidebarRpcContract>();
  const realtimeState = useRealtimeConnectionState();
  const [hostIds, setHostIds] = useState<ReadonlySet<string> | null>(null);

  const load = useMemo(
    () =>
      createCloudHostsLoader(
        async () => (await rpc.call("cloudHosts", {})).hostIds,
        (next) =>
          setHostIds((current) =>
            next !== null && current !== null && sameSet(current, next) ? current : next,
          ),
      ),
    [rpc],
  );

  useEffect(() => {
    void load();
  }, [load, realtimeState]);
  useRealtime(CLOUD_HOSTS_CHANNEL, () => {
    void load();
  });

  return hostIds;
}
