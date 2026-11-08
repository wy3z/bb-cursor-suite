import { useEffect, useState } from "react";
import {
  Markdown,
  experimental_Icon as Icon,
  experimental_useRpcQuery,
  useBbNavigate,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { TASKS_PLUGIN, tasksContract, type Preset, type Status, type Task } from "./contracts";
import { renderTitle, useDerived, type CardContext } from "./Card";
import { PR_STATUS, prStatus, useAttachments, usePullRequestSummaries, useTaskPullRequests, useTaskThreads } from "./data";
import { CommitGlyph, Dot, PriorityGlyph, StatusGlyph, formatElapsed } from "./glyphs";
import { AttachmentList, BehindHint, agentViews, useLightbox } from "./Chips";
import { COLUMNS, COLUMN_LABEL, columnOf } from "./status";
import { useOpenThread } from "./useOpenThread";

const URL_RE = /https?:\/\/[^\s<>()"'`\]]+[^\s<>()"'`\].,;:!?]/g;

export function linksIn(texts: readonly string[], exclude: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(URL_RE)) {
      const url = match[0];
      if (seen.has(url) || exclude.has(url) || url.includes("/api/v1/plugins/tasks/http/attachments/")) continue;
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

function linkLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const pr = /^\/([^/]+)\/([^/]+)\/(pull|issues|commit)\/([^/]+)/.exec(parsed.pathname);
    if (parsed.hostname === "github.com" && pr) return `${pr[2]} ${pr[3] === "commit" ? pr[4]!.slice(0, 7) : `#${pr[4]}`}`;
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

export function openInTasks(key: string) {
  window.history.pushState(window.history.state, "", `/plugins/tasks/tasks/task/${encodeURIComponent(key)}`);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

export function TaskDetail({
  task,
  ctx,
  onClose,
  onStatus,
  compact,
  projectName,
}: {
  task: Task;
  ctx: CardContext;
  compact: boolean;
  projectName: string;
  onClose: () => void;
  onStatus: (task: Task, status: Status) => void;
}) {
  const navigate = useBbNavigate();
  const openThreadIn = useOpenThread();
  const sdk = useSdk();
  const threads = useTaskThreads(task.id, true);
  const pullRequests = useTaskPullRequests(task.id, true);
  const summaries = usePullRequestSummaries(pullRequests.filter((pr) => pr.state === "open").map((pr) => pr.url));
  const attachmentState = useAttachments(task.id, true);
  const attachments = attachmentState.kind === "ready" ? attachmentState.items : [];
  const lightbox = useLightbox(attachments.filter((attachment) => attachment.isImage));
  const derived = useDerived(task, threads, pullRequests, ctx);
  const agents = agentViews(threads, ctx.threads, ctx.now);
  const subtasks = ctx.children.get(task.id) ?? [];
  const parent = task.parentTaskId ? ctx.tasksById.get(task.parentTaskId) ?? null : null;
  const landing = ctx.evidence.get(task.id)?.landing ?? null;
  const comments = experimental_useRpcQuery({
    pluginId: TASKS_PLUGIN,
    contract: tasksContract,
    method: "listComments",
    input: { taskId: task.id },
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const labels = task.labelIds.map((id) => ctx.labels.get(id)).filter((label) => label !== undefined);
  const recent = (comments.data?.comments ?? []).slice(-5).reverse();
  const links = linksIn(
    [task.description, ...(comments.data?.comments ?? []).map((comment) => comment.body)],
    new Set([...pullRequests.map((pr) => pr.url), ...(landing?.url ? [landing.url] : [])]),
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target as HTMLElement).closest("input, textarea, select")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => setNote(null), [task.id]);

  const delegate = async (preset: Preset) => {
    setBusy(preset.id);
    setNote(null);
    try {
      const result = await sdk.plugins.callRpc({
        pluginId: TASKS_PLUGIN,
        method: "delegate",
        input: { taskId: task.id, presetId: preset.id },
        outputSchema: tasksContract.delegate.output,
      });
      setNote({ tone: "good", text: `Delegated to ${preset.name}` });
      if (result.threadId) navigate.toThread(result.threadId, { split: true });
    } catch (error) {
      setNote({ tone: "bad", text: error instanceof Error ? error.message : "Couldn't delegate" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="bbp-detail" aria-label={`${task.key} details`} key={task.id}>
      <header className="bbp-detail__head">
        {compact ? (
          <button type="button" className="bbp-back" onClick={onClose} title="Back (Esc)">
            <Icon name="ChevronLeft" />
            <span>{projectName}</span>
          </button>
        ) : null}
        <span className="bbp-card__key">{task.key}</span>
        <PriorityGlyph priority={task.priority} />
        <span className="bbp-detail__spacer" />
        <button type="button" className="bbp-icon-button" title="Open in Tasks" aria-label="Open in Tasks" onClick={() => openInTasks(task.key)}>
          <Icon name="ExternalLink" />
        </button>
        {compact ? null : (
          <button type="button" className="bbp-icon-button" title="Close (Esc)" aria-label="Close" onClick={onClose}>
            <Icon name="X" />
          </button>
        )}
      </header>
      <h2 className="bbp-detail__title">{renderTitle(task.title)}</h2>
      <div className="bbp-detail__props">
        <label className="bbp-detail__status">
          <StatusGlyph status={task.status} />
          <select value={columnOf(task.status)} aria-label="Status" onChange={(event) => onStatus(task, event.currentTarget.value as Status)}>
            {COLUMNS.map((status) => (
              <option key={status} value={status}>
                {COLUMN_LABEL[status]}
              </option>
            ))}
          </select>
        </label>
        {parent ? (
          <button type="button" className="bbp-parent-mark" title={parent.title} onClick={() => ctx.onOpen?.(parent)}>
            <Icon name="CornerDownRight" />
            Sub-task of {parent.key}
          </button>
        ) : null}
        {labels.map((label) => (
          <span className="bbp-label" key={label!.id} style={{ ["--bbp-label" as string]: label!.color }}>
            {label!.name}
          </span>
        ))}
      </div>

      {derived ? (
        <BehindHint derived={derived} stored={task.status} compact={false} onApply={ctx.onApply ? () => ctx.onApply!(task, derived.status) : undefined} />
      ) : null}

      <div className="bbp-detail__body">
        <section className="bbp-detail__section">
          {task.description.trim() ? (
            <div className="bbp-detail__markdown">
              <Markdown content={task.description} />
            </div>
          ) : (
            <p className="bbp-detail__muted">No description.</p>
          )}
        </section>

        <section className="bbp-detail__section">
          <h3>Agents</h3>
          {agents.length === 0 ? (
            <p className="bbp-detail__muted">No agent has worked on this yet.</p>
          ) : (
            agents.map((agent) => (
              <button
                type="button"
                key={agent.link.threadId}
                className="bbp-detail__row"
                data-tone={agent.tone}
                onClick={(event) => openThreadIn(agent.link.threadId, { split: event.ctrlKey || event.metaKey })}
              >
                <Dot tone={agent.tone} />
                <span className="bbp-detail__row-title">{agent.name}</span>
                <span className="bbp-detail__row-meta">
                  {agent.link.presetName} · {agent.age}
                </span>
              </button>
            ))
          )}
        </section>

        {subtasks.length > 0 ? (
          <section className="bbp-detail__section">
            <h3>
              Sub-tasks{" "}
              <span className="bbp-detail__count">
                {subtasks.filter((child) => child.status === "done" || child.status === "canceled").length}/{subtasks.length}
              </span>
            </h3>
            {subtasks.map((child) => (
              <button type="button" key={child.id} className="bbp-detail__row" onClick={() => ctx.onOpen?.(child)}>
                <StatusGlyph status={child.status} />
                <span className="bbp-card__key">{child.key}</span>
                <span className="bbp-detail__row-title">{child.title}</span>
              </button>
            ))}
          </section>
        ) : null}

        {pullRequests.length > 0 || landing ? (
          <section className="bbp-detail__section">
            <h3>Pull requests</h3>
            {pullRequests.map((pr) => {
              const status = prStatus(pr, summaries.get(pr.url));
              const summary = summaries.get(pr.url);
              const checks = summary && summary.ci.totalCount > 0 ? `${summary.ci.totalCount} check${summary.ci.totalCount === 1 ? "" : "s"} ${summary.ci.state}` : null;
              return (
                <a key={pr.url} className="bbp-detail__row" href={pr.url} target="_blank" rel="noreferrer" data-pr={pr.state} data-pr-status={status}>
                  <Icon name={PR_STATUS[status].icon} />
                  <span className="bbp-detail__row-title">{pr.title}</span>
                  <span className="bbp-detail__row-meta">
                    #{pr.number} · {PR_STATUS[status].label}
                    {checks ? ` · ${checks}` : ""}
                  </span>
                </a>
              );
            })}
            {landing ? (
              <a className="bbp-detail__row" href={landing.url ?? undefined} target="_blank" rel="noreferrer" data-commit="">
                <CommitGlyph />
                <span className="bbp-detail__row-title">{landing.subject}</span>
                <span className="bbp-detail__row-meta">
                  {landing.sha.slice(0, 7)} on {landing.ref} · {formatElapsed(landing.at, ctx.now)}
                </span>
              </a>
            ) : null}
          </section>
        ) : null}

        {attachments.length > 0 ? (
          <section className="bbp-detail__section">
            <h3>Attachments</h3>
            <AttachmentList attachments={attachments} onImage={lightbox.open} />
            {lightbox.element}
          </section>
        ) : attachmentState.kind === "error" ? (
          <section className="bbp-detail__section">
            <h3>Attachments</h3>
            <p className="bbp-detail__muted">Couldn't load attachments: {attachmentState.message}</p>
          </section>
        ) : null}

        {links.length > 0 ? (
          <section className="bbp-detail__section">
            <h3>Links</h3>
            {links.slice(0, 12).map((url) => (
              <a key={url} className="bbp-detail__row" href={url} target="_blank" rel="noreferrer" title={url}>
                <Icon name="Link" />
                <span className="bbp-detail__row-title">{linkLabel(url)}</span>
              </a>
            ))}
          </section>
        ) : null}

        {recent.length > 0 ? (
          <section className="bbp-detail__section">
            <h3>Recent activity</h3>
            {recent.map((comment) => (
              <div key={comment.id} className="bbp-detail__comment" data-kind={comment.kind}>
                <div className="bbp-detail__comment-head">
                  <span>{comment.authorName}</span>
                  <span className="bbp-detail__row-meta">{formatElapsed(comment.createdAt, ctx.now)}</span>
                </div>
                <div className="bbp-detail__markdown">
                  <Markdown content={comment.body} />
                </div>
              </div>
            ))}
          </section>
        ) : null}
      </div>

      <footer className="bbp-detail__foot">
        {note ? (
          <span className="bbp-flash" data-tone={note.tone}>
            <Icon name={note.tone === "good" ? "CircleCheck" : "CircleX"} />
            <span>{note.text}</span>
          </span>
        ) : (
          <span className="bbp-detail__muted">Delegate</span>
        )}
        <div className="bbp-detail__presets">
          {ctx.presets.map((preset) => (
            <button
              type="button"
              key={preset.id}
              className="bbp-text-button"
              data-variant={ctx.presets[0]?.id === preset.id ? "primary" : undefined}
              disabled={busy !== null}
              onClick={() => void delegate(preset)}
            >
              {busy === preset.id ? "Starting…" : preset.name}
            </button>
          ))}
        </div>
      </footer>
    </aside>
  );
}
