import type { Status } from "./contracts";

export function anchorsFor(
  column: readonly { id: string; status: Status }[],
  draggedId: string,
  index: number,
  status: Status,
): { beforeTaskId: string | null; afterTaskId: string | null } {
  const others = column.filter((task) => task.id !== draggedId);
  let beforeTaskId: string | null = null;
  for (let i = Math.min(index, others.length) - 1; i >= 0; i--) {
    if (others[i]!.status === status) {
      beforeTaskId = others[i]!.id;
      break;
    }
  }
  let afterTaskId: string | null = null;
  for (let i = Math.max(index, 0); i < others.length; i++) {
    if (others[i]!.status === status) {
      afterTaskId = others[i]!.id;
      break;
    }
  }
  return { beforeTaskId, afterTaskId };
}

export type LoadState<T> = { kind: "loading" } | { kind: "error"; message: string } | { kind: "empty" } | { kind: "ready"; items: T[] };

export function loadState<T>(query: { data: { items: T[] } | undefined; error: { message?: string } | null; isLoading: boolean }): LoadState<T> {
  if (query.data) return query.data.items.length ? { kind: "ready", items: query.data.items } : { kind: "empty" };
  if (query.error) return { kind: "error", message: query.error.message || "Couldn't load" };
  return { kind: "loading" };
}
