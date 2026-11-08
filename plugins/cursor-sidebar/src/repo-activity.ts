import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { threadStatusFacts } from "./status";
import { flattenShelf, type ProjectSectionData } from "./forest";

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

export function renderedRowIds(
  section: ProjectSectionData,
  options: {
    open: boolean;
    expandedParents: ReadonlySet<string>;
    keepIds: ReadonlySet<string>;
    expandIds?: ReadonlySet<string> | undefined;
    childLimit: number;
  },
): Set<string> {
  const { open, expandedParents, keepIds, expandIds, childLimit } = options;
  if (!open && (expandIds === undefined || expandIds.size === 0)) return new Set();
  const rows = flattenShelf(
    section,
    "active",
    (id) => expandedParents.has(id) || (expandIds?.has(id) ?? false),
    (id) => keepIds.has(id),
    (id) => (expandIds?.has(id) ? Number.POSITIVE_INFINITY : childLimit),
  );
  return new Set(rows.filter((row) => keepIds.has(row.thread.id)).map((row) => row.thread.id));
}

export function hasHiddenWork(members: readonly PluginSidebarThread[], renderedIds: ReadonlySet<string>): boolean {
  return members.some((thread) => !thread.isArchived && !renderedIds.has(thread.id) && threadStatusFacts(thread).working);
}
