import { useState, type MouseEvent } from "react";
import { experimental_Icon as Icon, experimental_ImageLightbox as ImageLightbox, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PullRequest, Task, TaskThread } from "./contracts";
import { PR_STATUS, attachmentUrl, prStatus, useAttachments, type Attachment, type PullRequestSummary, type ThreadInfo } from "./data";
import { canApply, type Derived, type Landing } from "./derive";
import { CommitGlyph, Dot, ProgressRing, StatusGlyph, formatElapsed } from "./glyphs";
import { openPullRequestInPanel } from "./pullRequestLink";
import { COLUMN_LABEL, columnOf, isComplete } from "./status";
import { usePopover } from "./usePopover";

export type AgentTone = "working" | "input" | "failed" | "idle";

export interface AgentView {
  link: TaskThread;
  name: string;
  tone: AgentTone;
  age: string;
}

export function agentViews(links: readonly TaskThread[], index: ReadonlyMap<string, ThreadInfo>, now: number): AgentView[] {
  const rank: Record<AgentTone, number> = { input: 0, working: 1, failed: 2, idle: 3 };
  return links
    .map((link) => {
      const info = index.get(link.threadId);
      const tone: AgentTone = info?.needsInput
        ? "input"
        : info?.working || link.liveStatus === "working" || link.liveStatus === "starting"
          ? "working"
          : link.liveStatus === "failed"
            ? "failed"
            : "idle";
      const since = formatElapsed(link.updatedAt, now);
      const age = tone === "working" ? `live ${since}` : tone === "input" ? "needs input" : tone === "failed" ? `failed ${since}` : `idle ${since}`;
      return { link, name: info?.title || link.title || link.presetName, tone, age };
    })
    .sort((left, right) => rank[left.tone] - rank[right.tone] || Date.parse(right.link.updatedAt) - Date.parse(left.link.updatedAt));
}

function openThread(navigate: ReturnType<typeof useBbNavigate>, threadId: string, event: MouseEvent) {
  event.stopPropagation();
  navigate.toThread(threadId, event.ctrlKey || event.metaKey ? { split: true } : undefined);
}

function AgentChip({ agent, compact }: { agent: AgentView; compact: boolean }) {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      className="bbp-chip bbp-agent-chip"
      data-tone={agent.tone}
      title={`${agent.name} · ${agent.link.presetName} · ${agent.age}. Ctrl-click opens a split.`}
      onClick={(event) => openThread(navigate, agent.link.threadId, event)}
    >
      <Dot tone={agent.tone} />
      <span className="bbp-agent-chip__name" data-shimmer={agent.tone === "working" || undefined}>
        {agent.name}
      </span>
      {compact ? null : <span className="bbp-agent-chip__age">{agent.age}</span>}
    </button>
  );
}

export function AgentChips({ agents, max, compact = false }: { agents: readonly AgentView[]; max: number; compact?: boolean }) {
  const navigate = useBbNavigate();
  const { open, setOpen, ref } = usePopover<HTMLSpanElement>();
  if (agents.length === 0) return null;
  const shown = agents.slice(0, max);
  const rest = agents.slice(max);
  return (
    <span className="bbp-agents" data-menu="">
      {shown.map((agent) => (
        <AgentChip key={agent.link.threadId} agent={agent} compact={compact} />
      ))}
      {rest.length > 0 ? (
        <span className="bbp-anchor" ref={ref}>
          <button
            type="button"
            className="bbp-chip bbp-agent-chip__more"
            aria-expanded={open}
            title={rest.map((agent) => `${agent.name} · ${agent.age}`).join("\n")}
            onClick={(event) => {
              event.stopPropagation();
              setOpen(!open);
            }}
          >
            +{rest.length}
          </button>
          {open ? (
            <span className="bbp-menu" role="menu">
              {rest.map((agent) => (
                <button
                  type="button"
                  role="menuitem"
                  key={agent.link.threadId}
                  className="bbp-menu__item"
                  onClick={(event) => {
                    setOpen(false);
                    openThread(navigate, agent.link.threadId, event);
                  }}
                >
                  <Dot tone={agent.tone} />
                  <span className="bbp-menu__grow">{agent.name}</span>
                  <span className="bbp-menu__meta">{agent.age}</span>
                </button>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

export function PullRequestChips({
  pullRequests,
  summaries,
  showLabel,
}: {
  pullRequests: readonly PullRequest[];
  summaries: ReadonlyMap<string, PullRequestSummary>;
  showLabel: boolean;
}) {
  const { open, setOpen, ref } = usePopover<HTMLSpanElement>();
  if (pullRequests.length === 0) return null;
  const items = pullRequests.map((pr) => ({ pr, status: prStatus(pr, summaries.get(pr.url)) }));
  if (items.length === 1) {
    const { pr, status } = items[0]!;
    const meta = PR_STATUS[status];
    const label = showLabel && status !== "merged" && status !== "closed" ? meta.label : null;
    return (
      <a
        className="bbp-chip"
        data-pr={pr.state}
        data-pr-status={status}
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        title={`${pr.title} · ${meta.label}`}
        onClick={(event) => {
          event.stopPropagation();
          openPullRequestInPanel(event, pr.url);
        }}
      >
        <Icon name={meta.icon} />#{pr.number}
        {label ? <span className="bbp-chip__label">{label}</span> : null}
      </a>
    );
  }
  return (
    <span className="bbp-anchor" ref={ref} data-menu="">
      <button
        type="button"
        className="bbp-chip bbp-pr-stack"
        aria-expanded={open}
        title={items.map(({ pr, status }) => `#${pr.number} ${pr.title} · ${PR_STATUS[status].label}`).join("\n")}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        <span className="bbp-pr-stack__icons">
          {items.slice(0, 4).map(({ pr, status }) => (
            <span key={pr.url} data-pr={pr.state} data-pr-status={status}>
              <Icon name={PR_STATUS[status].icon} />
            </span>
          ))}
        </span>
        <span>{items.length} PRs</span>
      </button>
      {open ? (
        <span className="bbp-menu" role="menu">
          {items.map(({ pr, status }) => (
            <a
              key={pr.url}
              role="menuitem"
              className="bbp-menu__item"
              data-pr={pr.state}
              data-pr-status={status}
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                setOpen(false);
                event.stopPropagation();
                openPullRequestInPanel(event, pr.url);
              }}
            >
              <Icon name={PR_STATUS[status].icon} />
              <span className="bbp-menu__grow">
                #{pr.number} {pr.title}
              </span>
              <span className="bbp-menu__meta">{PR_STATUS[status].label}</span>
            </a>
          ))}
        </span>
      ) : null}
    </span>
  );
}

export function SubtaskPill({ subtasks, onOpen }: { subtasks: readonly Task[]; onOpen?: (task: Task) => void }) {
  const { open, setOpen, ref } = usePopover<HTMLSpanElement>();
  if (subtasks.length === 0) return null;
  const complete = subtasks.filter((task) => isComplete(task.status)).length;
  return (
    <span className="bbp-anchor" ref={ref} data-menu="">
      <button
        type="button"
        className="bbp-chip bbp-subtasks"
        aria-expanded={open}
        title={`${complete} of ${subtasks.length} sub-tasks complete`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        <ProgressRing value={complete / subtasks.length} />
        <span>
          {complete}/{subtasks.length}
        </span>
      </button>
      {open ? (
        <span className="bbp-menu" role="menu">
          <span className="bbp-menu__label">Sub-tasks</span>
          {subtasks.map((task) => (
            <button
              type="button"
              role="menuitem"
              key={task.id}
              className="bbp-menu__item"
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                onOpen?.(task);
              }}
            >
              <StatusGlyph status={task.status} />
              <span className="bbp-card__key">{task.key}</span>
              <span className="bbp-menu__grow">{task.title}</span>
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

export function CommitChip({ landing }: { landing: Landing }) {
  const content = (
    <>
      <CommitGlyph />
      <span>{landing.sha.slice(0, 7)}</span>
    </>
  );
  const title = `${landing.subject} · on ${landing.ref}`;
  return landing.url ? (
    <a className="bbp-chip bbp-commit" href={landing.url} target="_blank" rel="noreferrer" title={title} onClick={(event) => event.stopPropagation()}>
      {content}
    </a>
  ) : (
    <span className="bbp-chip bbp-commit" title={title}>
      {content}
    </span>
  );
}

export function useLightbox(images: readonly Attachment[]) {
  const [index, setIndex] = useState<number | null>(null);
  const current = index === null ? null : images[index] ?? null;
  const element = (
    <ImageLightbox
      isOpen={current !== null}
      imageSrc={current ? attachmentUrl(current.id) : null}
      imageAlt={current?.fileName ?? ""}
      title={current?.fileName ?? ""}
      hasMultipleImages={images.length > 1}
      previousDisabled={index === null || index === 0}
      nextDisabled={index === null || index >= images.length - 1}
      navigationStatus={index === null ? undefined : `${index + 1} of ${images.length}`}
      onPrevious={() => setIndex((value) => (value === null ? value : Math.max(0, value - 1)))}
      onNext={() => setIndex((value) => (value === null ? value : Math.min(images.length - 1, value + 1)))}
      onClose={() => setIndex(null)}
    />
  );
  return { open: (attachment: Attachment) => setIndex(Math.max(0, images.indexOf(attachment))), element };
}

export function AttachmentList({ attachments, onImage }: { attachments: readonly Attachment[]; onImage: (attachment: Attachment) => void }) {
  return (
    <span className="bbp-attachments">
      {attachments.map((attachment) =>
        attachment.isImage ? (
          <button
            type="button"
            key={attachment.id}
            className="bbp-attachment bbp-attachment--image"
            title={attachment.fileName}
            onClick={(event) => {
              event.stopPropagation();
              onImage(attachment);
            }}
          >
            <img src={attachmentUrl(attachment.id)} alt={attachment.fileName} loading="lazy" />
          </button>
        ) : (
          <a
            key={attachment.id}
            className="bbp-attachment bbp-attachment--file"
            href={attachmentUrl(attachment.id)}
            target="_blank"
            rel="noreferrer"
            title={attachment.fileName}
            onClick={(event) => event.stopPropagation()}
          >
            <Icon name="FileText" />
            <span>{attachment.fileName}</span>
          </a>
        ),
      )}
    </span>
  );
}

export function AttachmentsChip({ taskId, count }: { taskId: string; count: number }) {
  const { open, setOpen, ref } = usePopover<HTMLSpanElement>();
  const state = useAttachments(taskId, open);
  const attachments = state.kind === "ready" ? state.items : [];
  const images = attachments.filter((attachment) => attachment.isImage);
  const lightbox = useLightbox(images);
  if (count === 0) return null;
  return (
    <span className="bbp-anchor" ref={ref} data-menu="">
      <button
        type="button"
        className="bbp-chip"
        aria-expanded={open}
        title={`${count} attachment${count === 1 ? "" : "s"}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        <Icon name="Paperclip" />
        {count}
      </button>
      {open ? (
        <span className="bbp-menu bbp-menu--attachments" role="dialog" aria-label="Attachments">
          <span className="bbp-menu__label">Attachments</span>
          {state.kind === "ready" ? (
            <AttachmentList attachments={attachments} onImage={lightbox.open} />
          ) : (
            <span className="bbp-menu__empty" data-tone={state.kind === "error" ? "error" : undefined}>
              {state.kind === "loading" ? "Loading…" : state.kind === "error" ? `Couldn't load attachments: ${state.message}` : "No attachments."}
            </span>
          )}
        </span>
      ) : null}
      {lightbox.element}
    </span>
  );
}

export function BehindHint({ derived, stored, onApply, compact }: { derived: Derived; stored: Task["status"]; onApply?: () => void; compact: boolean }) {
  const label = COLUMN_LABEL[derived.status];
  const title = `Stored as ${COLUMN_LABEL[columnOf(stored)]}; the evidence says ${label}: ${derived.reason}.${canApply(derived) ? "" : " The lead or you write this one; the board only applies sub-task roll-ups and idle demotions."}`;
  if (compact) {
    return (
      <span className="bbp-behind-chip" title={title}>
        <Icon name="ArrowRight" />
        <StatusGlyph status={derived.status} />
      </span>
    );
  }
  return (
    <div className="bbp-behind-hint" title={title} data-menu="">
      <StatusGlyph status={derived.status} />
      <span className="bbp-behind-hint__text">
        <strong>{label}</strong> · {derived.reason}
      </span>
      {onApply && canApply(derived) ? (
        <button
          type="button"
          className="bbp-text-button bbp-behind-hint__apply"
          onClick={(event) => {
            event.stopPropagation();
            onApply();
          }}
        >
          Apply
        </button>
      ) : null}
    </div>
  );
}
