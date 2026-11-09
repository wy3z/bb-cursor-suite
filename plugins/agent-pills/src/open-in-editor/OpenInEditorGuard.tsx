import { useEffect, useLayoutEffect, useState } from "react";
import { useComposer, useSdk } from "@get-bb/plugin-sdk/app";
import { watchBbOpenButton } from "./bb-open-button";
import { threadOnCloudMachine, type CloudLookupSdk } from "./cloud";

const RETRY_MS = 5_000;

function useCloudThread(threadId: string | null): boolean {
  const sdk = useSdk() as unknown as CloudLookupSdk;
  const [cloud, setCloud] = useState(false);

  useEffect(() => {
    setCloud(false);
    if (threadId === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      void threadOnCloudMachine(sdk, threadId).then((answer) => {
        if (!live) return;
        if (answer === null) {
          timer = setTimeout(check, RETRY_MS);
          return;
        }
        setCloud(answer);
      });
    };
    check();
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [sdk, threadId]);

  return cloud;
}

export function useHideBbOpenButton(anchor: HTMLElement | null, enabled: boolean): void {
  useLayoutEffect(() => {
    if (!enabled || anchor === null) return;
    return watchBbOpenButton(anchor);
  }, [anchor, enabled]);
}

export function OpenInEditorGuard() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const cloud = useCloudThread(threadId);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useHideBbOpenButton(anchor, cloud);
  if (threadId === null) return null;
  return <span ref={setAnchor} data-bb-agent-pills-open-in-anchor="" hidden />;
}
