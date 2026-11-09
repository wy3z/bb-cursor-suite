import { createContext } from "react";
import { openThreadAsTab, tabHostReady, type ThreadNavigate, type ThreadNode } from "@wy3z/bb-suite/thread-tabs";

export interface ThreadRouting {
  current: string | null;
  byId: ReadonlyMap<string, ThreadNode>;
  leadIds: ReadonlySet<string>;
}

export const ThreadRoutingContext = createContext<ThreadRouting | null>(null);

export function openSidebarThread(
  target: string,
  options: { split?: boolean } | undefined,
  routing: ThreadRouting | null,
  navigate: ThreadNavigate,
  isConversationHidden?: () => boolean,
): void {
  const parentThreadId = routing?.byId.get(target)?.parentThreadId ?? null;
  const isLead = routing?.leadIds.has(target) ?? false;
  if (routing === null || !tabHostReady() || (parentThreadId === null && (!isLead || options?.split === true))) {
    navigate.toThread(target, options);
    return;
  }
  openThreadAsTab({
    target,
    current: routing.current,
    byId: routing.byId,
    leadIds: routing.leadIds,
    split: options?.split ?? false,
    navigate,
    ...(isConversationHidden ? { isConversationHidden } : {}),
  });
}
