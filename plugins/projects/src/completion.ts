import type { Task } from "./contracts";
import type { CommentSignal } from "./reconcile";
import { COLUMN_LABEL } from "./status";

export function enteredStatusAt(task: Pick<Task, "status" | "updatedAt">, comments: readonly CommentSignal[]): string {
  if (task.status !== "done" && task.status !== "canceled") return task.updatedAt;
  const prefix = `Status changed to ${COLUMN_LABEL[task.status]} by `;
  let latest: string | null = null;
  for (const comment of comments) {
    if (comment.kind !== "system" || !comment.body.trim().startsWith(prefix)) continue;
    if (latest === null || Date.parse(comment.createdAt) > Date.parse(latest)) latest = comment.createdAt;
  }
  return latest ?? task.updatedAt;
}

export async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
