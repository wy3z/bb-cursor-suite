import type { Task } from "./contracts";
import { COLUMNS, columnOf, type Column } from "./status";

export function byColumn(tasks: readonly Task[], completedAt: ReadonlyMap<string, string> = new Map()): Record<Column, Task[]> {
  const groups = Object.fromEntries(COLUMNS.map((column) => [column, [] as Task[]])) as Record<Column, Task[]>;
  for (const task of tasks) groups[columnOf(task.status)].push(task);
  const position = (left: Task, right: Task) => left.position - right.position || left.id.localeCompare(right.id);
  const completed = (task: Task) => Date.parse(completedAt.get(task.id) ?? task.updatedAt) || 0;
  const recency = (left: Task, right: Task) => completed(right) - completed(left) || position(left, right);
  for (const column of COLUMNS) groups[column].sort(column === "done" || column === "canceled" ? recency : position);
  return groups;
}
