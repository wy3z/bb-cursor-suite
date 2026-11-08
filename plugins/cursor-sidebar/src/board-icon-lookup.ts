import { parseProjectIcon, type ProjectIcon } from "./project-icons";

export function boardIconLookup(
  rows: readonly { projectId: string; icon: string }[] | undefined,
  overrides: ReadonlyMap<string, string | null>,
): (boardId: string) => ProjectIcon | null {
  const stored = new Map((rows ?? []).map((row) => [row.projectId, row.icon]));
  for (const [boardId, icon] of overrides) {
    if (icon === null) stored.delete(boardId);
    else stored.set(boardId, icon);
  }
  return (boardId) => {
    const value = stored.get(boardId);
    return value === undefined ? null : parseProjectIcon(value);
  };
}
