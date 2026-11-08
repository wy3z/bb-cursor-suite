import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { threadStatusFacts } from "./status";
import type { DisplayRow } from "./forest";

export function repoActivityMembers(
  threads: readonly PluginSidebarThread[],
  sectionId: string,
  familyRootOf: (threadId: string) => string,
  liftedRoots: ReadonlySet<string>,
  boardRoots: ReadonlySet<string>,
): PluginSidebarThread[] {
  return threads.filter((thread) => {
    if (thread.projectId !== sectionId) return false;
    const root = familyRootOf(thread.id);
    return !liftedRoots.has(root) && !boardRoots.has(root);
  });
}

export function renderedIdsOf(blocks: readonly { open: boolean; rows: readonly DisplayRow[] }[]): Set<string> {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (!block.open) continue;
    for (const row of block.rows) ids.add(row.thread.id);
  }
  return ids;
}

export function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

export function hasHiddenWork(members: readonly PluginSidebarThread[], renderedIds: ReadonlySet<string>): boolean {
  return members.some((thread) => !thread.isArchived && !renderedIds.has(thread.id) && threadStatusFacts(thread).working);
}
