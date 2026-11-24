import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { ProjectBoard } from "./project-boards";

export function activeProjectBoards<Board extends Pick<ProjectBoard, "leadThreadId">>(
  boards: readonly Board[],
  shown: readonly Pick<PluginSidebarThread, "id" | "isArchived">[],
  rootOf: (threadId: string) => string,
): Board[] {
  const activeRoots = new Set<string>();
  for (const thread of shown) {
    if (!thread.isArchived) activeRoots.add(rootOf(thread.id));
  }
  return boards.filter((board) => board.leadThreadId !== null && activeRoots.has(board.leadThreadId));
}
