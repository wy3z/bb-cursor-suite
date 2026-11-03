/**
 * A "+18 −2" pill for the thread's uncommitted (or, failing that, branch)
 * changes. BB's own changed-files segment gets no environment for project
 * checkouts, so it never shows on most threads; this reads the same git
 * status from BB's git plugin, keyed by the thread's environment id.
 */
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  experimental_Icon as Icon,
  experimental_useRpcKeyedQuery,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { useActivity } from "./pill-data";

/** Just enough of `bb--git`'s `status` method to call it; rows are parsed below. */
const gitRpcContract = {
  status: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(z.string(), z.unknown()),
  },
} as const;

const fileSchema = z.object({
  path: z.string(),
  status: z.string(),
  insertions: z.number().nullable(),
  deletions: z.number().nullable(),
});

const statsSchema = z.object({
  insertions: z.number(),
  deletions: z.number(),
  fileCount: z.number(),
  files: z.array(fileSchema),
});

const statusSchema = z.object({
  outcome: z.literal("available"),
  workspace: z.object({
    workingTree: statsSchema.extend({ state: z.string().optional() }),
    mergeBase: statsSchema.extend({ mergeBaseBranch: z.string().optional() }).nullish(),
  }),
});

export interface Changes {
  title: string;
  insertions: number;
  deletions: number;
  fileCount: number;
  files: z.infer<typeof fileSchema>[];
}

/** BB's order: the working tree first, then commits ahead of the merge base. */
function pickChanges(row: unknown): Changes | null {
  const parsed = statusSchema.safeParse(row);
  if (!parsed.success) return null;
  const { workingTree, mergeBase } = parsed.data.workspace;
  if (workingTree.fileCount > 0) {
    return {
      title: workingTree.state === "untracked" ? "Untracked changes" : "Uncommitted changes",
      ...workingTree,
    };
  }
  if (mergeBase && mergeBase.fileCount > 0) {
    return {
      title: mergeBase.mergeBaseBranch
        ? `Changes against ${mergeBase.mergeBaseBranch}`
        : "Committed changes",
      ...mergeBase,
    };
  }
  return null;
}

/** The segment's environment, or the thread's when BB passes none. */
function useEnvironmentId({ threadId, environment }: ExperimentalThreadContextSegmentProps | {
  threadId: string;
  environment: { id: string } | null;
}): string | null {
  const { activity } = useActivity(threadId);
  return environment?.id ?? activity.thread.environmentId;
}

export function useChanges(input: {
  threadId: string;
  environment: { id: string } | null;
}): Changes | null {
  const environmentId = useEnvironmentId(input);
  const query = experimental_useRpcKeyedQuery({
    pluginId: "bb--git",
    contract: gitRpcContract,
    method: "status",
    keys: environmentId ? [environmentId] : [],
    enabled: environmentId !== null,
  });
  if (environmentId === null) return null;
  return pickChanges(query.data?.[environmentId]);
}

const STATUS_LABEL: Record<string, string> = {
  "??": "U",
  A: "A",
  M: "M",
  D: "D",
  R: "R",
  C: "C",
};

const FIRST_PAGE = 5;
const NEXT_PAGE = 8;

const STATUS_TONE: Record<string, string> = {
  "??": "green",
  A: "green",
  M: "yellow",
  D: "red",
  R: "purple",
  C: "purple",
};

/**
 * "Changes +18 −2", after Cursor's review-changes-pill, opening a tray of the
 * changed files (Cursor opens its review surface; BB gives plugins no way to
 * open its own diff tab, so the files list stays).
 */
export function ChangesPill(props: ExperimentalThreadContextSegmentProps) {
  const changes = useChanges(props);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(FIRST_PAGE);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [props.threadId]);
  useEffect(() => {
    if (!open) {
      setShown(FIRST_PAGE);
      return;
    }
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (changes === null) return null;
  const { title, insertions, deletions, fileCount, files } = changes;
  const fileWord = fileCount === 1 ? "File" : "Files";
  const hidden = Math.max(0, files.length - shown);

  return (
    <div className="bb-agent-pills" data-bb-agent-pills="" ref={rootRef}>
      <div className="bb-agent-pills__row">
        <button
          type="button"
          className="bb-agent-pills__pill"
          data-group="changes"
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`${title}: ${fileCount} ${fileWord.toLowerCase()}, ${insertions} added, ${deletions} removed`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="bb-agent-pills__label">Changes</span>
          {insertions > 0 ? <span className="bb-agent-pills__diff" data-sign="plus">+{insertions}</span> : null}
          {deletions > 0 ? <span className="bb-agent-pills__diff" data-sign="minus">-{deletions}</span> : null}
        </button>
      </div>
      {open ? (
        <div className="bb-agent-pills__panel bb-agent-pills__tray" role="menu" aria-label={title}>
          <div className="bb-agent-pills__tray-header">
            <span className="bb-agent-pills__tray-title" title={title}>
              {fileCount} {fileWord}
            </span>
            <button
              type="button"
              className="bb-agent-pills__tray-icon-button"
              aria-label="Minimize"
              title="Minimize (Esc)"
              onClick={() => setOpen(false)}
            >
              <Icon name="Minus" />
            </button>
          </div>
          <div className="bb-agent-pills__tray-rows">
            {files.slice(0, shown).map((file) => (
              <div
                role="menuitem"
                aria-disabled="true"
                key={`${file.status}:${file.path}`}
                className="bb-agent-pills__tray-row"
              >
                <span
                  className="bb-agent-pills__tray-leading bb-agent-pills__file-status"
                  data-tone={STATUS_TONE[file.status]}
                  data-status={file.status}
                >
                  {STATUS_LABEL[file.status] ?? file.status}
                </span>
                <span className="bb-agent-pills__tray-label" dir="rtl" title={file.path}>
                  <bdi dir="ltr">{file.path}</bdi>
                </span>
                {file.insertions !== null && file.deletions !== null ? (
                  <span className="bb-agent-pills__tray-end">
                    <span className="bb-agent-pills__tray-meta">
                      <span className="bb-agent-pills__diff" data-sign="plus">+{file.insertions}</span>{" "}
                      <span className="bb-agent-pills__diff" data-sign="minus">-{file.deletions}</span>
                    </span>
                  </span>
                ) : null}
              </div>
            ))}
            {hidden > 0 ? (
              <button
                type="button"
                className="bb-agent-pills__tray-more"
                aria-label={`Show ${Math.min(hidden, NEXT_PAGE)} more files`}
                onClick={() => setShown((count) => count + NEXT_PAGE)}
              >
                More
              </button>
            ) : null}
            {fileCount > files.length && hidden === 0 ? (
              <div className="bb-agent-pills__tray-empty">and {fileCount - files.length} more not listed</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
