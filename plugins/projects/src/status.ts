import type { Status } from "./contracts";

export const COLUMNS = ["in_review", "in_progress", "todo", "done", "canceled"] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABEL: Record<Column, string> = {
  in_review: "For Review",
  in_progress: "In Progress",
  todo: "Queued",
  done: "Done",
  canceled: "Canceled",
};

export const NEEDS_RE = /^[\s*_>#-]*needs\s+[^:：\n]{1,60}[:：]/i;

export function columnOf(status: Status): Column {
  return status === "backlog" ? "todo" : status;
}

export function statusLabel(status: Status): string {
  return COLUMN_LABEL[columnOf(status)];
}

export function isComplete(status: Status): boolean {
  return status === "done" || status === "canceled";
}
