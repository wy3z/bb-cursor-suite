/**
 * The popovers' few writes, each on BB's own SDK method, then a re-read so the
 * pill reflects what the server now says. A button disables while its own call
 * is in flight.
 */
import { useCallback, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { agentPillsRpcContract } from "../rpc";

export interface PillActions {
  /** Key of the call in flight, matching the keys used below. */
  pending: string | null;
  exitPlanMode: () => void;
  clearGoal: () => void;
  sendQueued: (queuedMessageId: string) => void;
  deleteQueued: (queuedMessageId: string) => void;
  unarchive: () => void;
  restoreEnvironment: () => void;
  resumeHost: (hostId: string) => void;
  dismissFallback: () => void;
}

export function usePillActions({
  threadId,
  refresh,
  dismissFallback,
}: {
  threadId: string;
  refresh: () => void;
  dismissFallback: () => void;
}): PillActions {
  const rpc = useRpc<typeof agentPillsRpcContract>();
  const [pending, setPending] = useState<string | null>(null);
  const inFlight = useRef(0);

  const run = useCallback(
    (key: string, call: () => Promise<{ ok: boolean }>) => {
      const id = ++inFlight.current;
      setPending(key);
      void call()
        .catch(() => undefined)
        .then(() => {
          if (id === inFlight.current) setPending(null);
          refresh();
        });
    },
    [refresh],
  );

  return {
    pending,
    exitPlanMode: () =>
      run("plan", () => rpc.call("exitPlanMode", { threadId })),
    clearGoal: () => run("goal", () => rpc.call("clearGoal", { threadId })),
    sendQueued: (queuedMessageId: string) =>
      run(`queue:${queuedMessageId}:send`, () =>
        rpc.call("sendQueued", { threadId, queuedMessageId }),
      ),
    deleteQueued: (queuedMessageId: string) =>
      run(`queue:${queuedMessageId}:delete`, () =>
        rpc.call("deleteQueued", { threadId, queuedMessageId }),
      ),
    unarchive: () => run("thread", () => rpc.call("unarchive", { threadId })),
    restoreEnvironment: () =>
      run("thread", () => rpc.call("restoreEnvironment", { threadId })),
    resumeHost: (hostId: string) =>
      run("machine", () => rpc.call("resumeHost", { threadId, hostId })),
    dismissFallback,
  };
}
