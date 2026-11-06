import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  experimental_Icon as Icon,
  experimental_useAppPanel,
  experimental_useRpcKeyedQuery,
  useBbNavigate,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { useActivity } from "./pill-data";
import { CommitBar } from "./CommitBar";

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
  uncommitted: boolean;
  insertions: number;
  deletions: number;
  fileCount: number;
  files: z.infer<typeof fileSchema>[];
}

function pickChanges(row: unknown): Changes | null {
  const parsed = statusSchema.safeParse(row);
  if (!parsed.success) return null;
  const { workingTree, mergeBase } = parsed.data.workspace;
  if (workingTree.fileCount > 0) {
    return {
      title: workingTree.state === "untracked" ? "Untracked changes" : "Uncommitted changes",
      uncommitted: true,
      ...workingTree,
    };
  }
  if (mergeBase && mergeBase.fileCount > 0) {
    return {
      title: mergeBase.mergeBaseBranch
        ? `Changes against ${mergeBase.mergeBaseBranch}`
        : "Committed changes",
      uncommitted: false,
      ...mergeBase,
    };
  }
  return null;
}

function openDiff(panel: ReturnType<typeof experimental_useAppPanel>) {
  const diff = panel
    .getTabs()
    .tabs.find((tab) => tab.detail.kind === "plugin" && tab.detail.pluginId === "bb--git" && tab.detail.tab.id === "diff");
  if (diff && panel.selectTab(diff.key)) return;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "d", code: "KeyD", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }),
  );
}

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

export function ChangesPill(props: ExperimentalThreadContextSegmentProps) {
  const changes = useChanges(props);
  const environmentId = useEnvironmentId(props);
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
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
        <div className="bb-agent-pills__panel bb-agent-pills__tray" role="dialog" aria-label={title}>
          <div className="bb-agent-pills__tray-header">
            <span className="bb-agent-pills__tray-title" title={title}>
              {fileCount} {fileWord}
            </span>
            <button
              type="button"
              className="bb-agent-pills__tray-icon-button"
              aria-label="Open diff"
              title="Open diff"
              onClick={() => {
                setOpen(false);
                openDiff(panel);
              }}
            >
              <Icon name="FileDiff" />
            </button>
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
              <button
                type="button"
                role="menuitem"
                key={`${file.status}:${file.path}`}
                className="bb-agent-pills__tray-row"
                disabled={environmentId === null || file.status === "D"}
                onClick={() => {
                  if (environmentId === null) return;
                  if (
                    navigate.experimental_openFilePreview({
                      target: { kind: "workspace", environmentId, path: file.path },
                      location: null,
                    })
                  )
                    setOpen(false);
                }}
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
              </button>
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
          {environmentId !== null ? <CommitBar environmentId={environmentId} uncommitted={changes.uncommitted} /> : null}
        </div>
      ) : null}
    </div>
  );
}
