import { useMemo } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { PULL_REQUESTS_PLUGIN, gitActionsContract, type GitActionResult } from "@wy3z/bb-suite/contracts";

type GitMethod = keyof typeof gitActionsContract;

export function useGitActions() {
  const sdk = useSdk();
  return useMemo(
    () => ({
      call: (method: GitMethod, input: Record<string, unknown>): Promise<GitActionResult> =>
        sdk.plugins.callRpc({
          pluginId: PULL_REQUESTS_PLUGIN,
          method,
          input: input as never,
          outputSchema: gitActionsContract[method].output,
        }),
    }),
    [sdk],
  );
}
