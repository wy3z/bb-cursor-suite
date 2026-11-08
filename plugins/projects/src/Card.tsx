import { useEffect, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { experimental_Icon as Icon, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import {
  PULL_REQUESTS_PLUGIN,
  TASKS_PLUGIN,
  gitActionsContract,
  tasksContract,
  type Label,
  type Preset,
  type Status,
  type Task,
  type TaskThread,
} from "./contracts";
import { useChangeStats, usePullRequestSummaries, useTaskPullRequests, useTaskThreads, type ThreadInfo } from "./data";
import { Dot, PriorityGlyph, StatusGlyph } from "./glyphs";
import { openInTasks } from "./TaskDetail";
import { usePopover } from "./usePopover";
import { deriveStatus, type Derived, type Landing } from "./derive";
import { AgentChips, AttachmentsChip, BehindHint, CommitChip, PullRequestChips, SubtaskPill, agentViews } from "./Chips";

export function renderTitle(title: string) {
  return title.split(/(`[^`]+`)/g).map((part, index) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code key={index}>{part.slice(1, -1)}</code> : part,
  );
}

type Flash = { tone: "good" | "bad" | "busy"; text: string } | null;

export interface TaskEvidence {
  lastActivityAt: string | null;
  landing: Landing | null;
  hold: { status: string; rule: string; since: string } | null;
}

export interface CardContext {
  labels: ReadonlyMap<string, Label>;
  threads: ReadonlyMap<string, ThreadInfo>;
  presets: readonly Preset[];
  targetEnvironmentId: string | null;
  now: number;
  children: ReadonlyMap<string, Task[]>;
  tasksById: ReadonlyMap<string, Task>;
  evidence: ReadonlyMap<string, TaskEvidence>;
  attachmentCounts: ReadonlyMap<string, number>;
  selectedId?: string | null;
  onSelect?: (task: Task) => void;
  onOpen?: (task: Task) => void;
  onApply?: (task: Task, status: Status) => void;
}

function pickWorker(taskThreads: readonly TaskThread[], index: ReadonlyMap<string, ThreadInfo>) {
  const live = taskThreads
    .map((link) => ({ link, info: index.get(link.threadId) ?? null }))
    .sort((left, right) => Date.parse(right.link.attachedAt) - Date.parse(left.link.attachedAt));
  const working = live.find((item) => item.info?.working || item.link.liveStatus === "working" || item.link.liveStatus === "starting");
  const input = live.find((item) => item.info?.needsInput);
  return { latest: live[0] ?? null, working: working ?? null, input: input ?? null, count: live.length };
}

export function useDerived(
  task: Task,
  links: readonly TaskThread[],
  pullRequests: readonly { number: number; state: "open" | "draft" | "merged" | "closed" }[],
  ctx: CardContext,
): Derived | null {
  const evidence = ctx.evidence.get(task.id);
  const derived = deriveStatus({
    status: task.status,
    updatedAt: task.updatedAt,
    threads: links.map((link) => ({ liveStatus: link.liveStatus, updatedAt: link.updatedAt, working: ctx.threads.get(link.threadId)?.working })),
    pullRequests,
    children: (ctx.children.get(task.id) ?? []).map((child) => child.status),
    landing: evidence?.landing ?? null,
    lastActivityAt: evidence?.lastActivityAt ?? null,
    now: ctx.now,
  });
  if (derived?.rule === "idle-demotion" && !evidence) return null;
  if (derived && evidence?.hold && evidence.hold.status === derived.status) return null;
  return derived;
}

export function TaskCard({
  task,
  activeThreads,
  ctx,
  layout,
  dragging,
  depth = 0,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  activeThreads: readonly TaskThread[];
  ctx: CardContext;
  layout: "board" | "row";
  dragging: boolean;
  depth?: number;
  onDragStart?: (event: DragEvent, task: Task) => void;
  onDragEnd?: () => void;
}) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const taskThreads = useTaskThreads(task.id, task.status !== "backlog" || activeThreads.length > 0);
  const links = taskThreads.length > 0 ? taskThreads : activeThreads;
  const worker = pickWorker(links, ctx.threads);
  const pullRequests = useTaskPullRequests(task.id, links.length > 0);
  const openPrUrls = pullRequests.filter((pr) => pr.state === "open").map((pr) => pr.url);
  const summaries = usePullRequestSummaries(openPrUrls);
  const workerEnv = worker.latest?.info?.isWorktree ? worker.latest.info.environmentId : null;
  const changes = useChangeStats(workerEnv && layout === "board" ? [workerEnv] : []).get(workerEnv ?? "") ?? null;
  const openPr = pullRequests.find((pr) => pr.state === "open" || pr.state === "draft") ?? null;
  const derived = useDerived(task, links, pullRequests, ctx);
  const subtasks = ctx.children.get(task.id) ?? [];
  const parent = task.parentTaskId ? ctx.tasksById.get(task.parentTaskId) ?? null : null;
  const landing = ctx.evidence.get(task.id)?.landing ?? null;
  const attachmentCount = ctx.attachmentCounts.get(task.id) ?? 0;
  const agents = agentViews(links, ctx.threads, ctx.now);
  const { open: menu, setOpen: setMenu, ref: menuRef } = usePopover();
  const [flash, setFlash] = useState<Flash>(null);

  useEffect(() => {
    if (flash === null || flash.tone === "busy") return;
    const timer = window.setTimeout(() => setFlash(null), 6000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const openTask = () => (ctx.onSelect ? ctx.onSelect(task) : openInTasks(task.key));
  const primary = worker.input ?? worker.working ?? worker.latest;
  const primaryThreadId = primary?.link.threadId ?? null;
  const openThread = (split: boolean) => {
    if (primaryThreadId) navigate.toThread(primaryThreadId, split ? { split: true } : undefined);
  };
  const openPrimary = (split: boolean) => (primaryThreadId ? openThread(split) : openTask());

  const run = async (label: string, action: () => Promise<{ ok: boolean; text: string }>) => {
    setMenu(false);
    setFlash({ tone: "busy", text: label });
    try {
      const result = await action();
      setFlash({ tone: result.ok ? "good" : "bad", text: result.text });
    } catch (error) {
      setFlash({ tone: "bad", text: error instanceof Error ? error.message : "Something went wrong" });
    }
  };

  const delegate = (preset: Preset) =>
    run(`Starting ${preset.name}…`, async () => {
      const result = await sdk.plugins.callRpc({
        pluginId: TASKS_PLUGIN,
        method: "delegate",
        input: { taskId: task.id, presetId: preset.id },
        outputSchema: tasksContract.delegate.output,
      });
      return { ok: true, text: result.threadId ? `Delegated to ${preset.name}` : "Delegated" };
    });

  const applyLocally = () =>
    workerEnv && ctx.targetEnvironmentId
      ? run("Applying…", async () => {
          const result = await sdk.plugins.callRpc({
            pluginId: PULL_REQUESTS_PLUGIN,
            method: "gitApplyLocally",
            input: { sourceEnvironmentId: workerEnv, targetEnvironmentId: ctx.targetEnvironmentId! },
            outputSchema: gitActionsContract.gitApplyLocally.output,
          });
          return result.ok
            ? { ok: true, text: `Applied ${result.files ?? 0} ${result.files === 1 ? "file" : "files"}` }
            : { ok: false, text: result.error ?? "Apply failed" };
        })
      : undefined;

  const createPr = () =>
    workerEnv
      ? run("Creating pull request…", async () => {
          const result = await sdk.plugins.callRpc({
            pluginId: PULL_REQUESTS_PLUGIN,
            method: "gitCreatePullRequest",
            input: { environmentId: workerEnv },
            outputSchema: gitActionsContract.gitCreatePullRequest.output,
          });
          return result.ok
            ? { ok: true, text: result.existed ? "Pull request already open" : "Opened pull request" }
            : { ok: false, text: result.error ?? "Couldn't create the pull request" };
        })
      : undefined;

  const labels = task.labelIds.map((id) => ctx.labels.get(id)).filter((label): label is Label => label !== undefined);
  const agentTone = agents[0]?.tone ?? "idle";

  const shell = {
    className: "bbp-card",
    "data-layout": layout,
    "data-status": task.status,
    "data-behind": derived ? derived.status : undefined,
    style: depth > 0 ? { ["--bbp-depth" as string]: depth } : undefined,
    "data-dragging": dragging || undefined,
    "data-selected": ctx.selectedId === task.id || undefined,
    "data-working": agentTone === "working" || undefined,
    draggable: layout === "board",
    tabIndex: 0,
    "aria-label": `${task.key} ${task.title}`,
    title: primaryThreadId ? "Open the agent's thread (Ctrl-click for a split)" : "Open the task",
    onDragStart: (event: DragEvent) => onDragStart?.(event, task),
    onDragEnd: () => onDragEnd?.(),
    onClick: (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest("button, a, [data-menu]")) return;
      openPrimary(event.metaKey || event.ctrlKey || event.altKey);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter") openPrimary(event.metaKey || event.ctrlKey);
    },
  };

  const tools = (
    <div className="bbp-card__tools" data-menu="" ref={menuRef} data-open={menu || undefined}>
      {layout === "board" && worker.latest ? (
        <button type="button" className="bbp-icon-button" title="Open agent (Ctrl-click for a split)" aria-label="Open agent" onClick={(event) => openThread(event.ctrlKey || event.metaKey)}>
          <Icon name="ArrowUpRight" />
        </button>
      ) : null}
      <button type="button" className="bbp-icon-button" aria-label="Task actions" aria-expanded={menu} onClick={() => setMenu((open) => !open)}>
        <Icon name="MoreHorizontal" />
      </button>
      {menu ? (
        <div className="bbp-menu" role="menu">
          <div className="bbp-menu__label">Delegate to</div>
          {ctx.presets.length === 0 ? (
            <div className="bbp-menu__empty">No presets yet. Add one in Tasks.</div>
          ) : (
            ctx.presets.map((preset) => (
              <button type="button" role="menuitem" className="bbp-menu__item" key={preset.id} onClick={() => void delegate(preset)}>
                <Icon name="Play" />
                <span>{preset.name}</span>
              </button>
            ))
          )}
          {workerEnv ? <div className="bbp-menu__sep" /> : null}
          {workerEnv && ctx.targetEnvironmentId ? (
            <button type="button" role="menuitem" className="bbp-menu__item" onClick={() => void applyLocally()}>
              <Icon name="Download" />
              <span>Apply locally</span>
            </button>
          ) : null}
          {workerEnv && !openPr ? (
            <button type="button" role="menuitem" className="bbp-menu__item" onClick={() => void createPr()}>
              <Icon name="GitPullRequest" />
              <span>Create PR</span>
            </button>
          ) : null}
          <div className="bbp-menu__sep" />
          {ctx.onSelect ? (
            <button
              type="button"
              role="menuitem"
              className="bbp-menu__item"
              onClick={() => {
                setMenu(false);
                ctx.onSelect?.(task);
              }}
            >
              <Icon name="Eye" />
              <span>Details</span>
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="bbp-menu__item"
            onClick={() => {
              setMenu(false);
              openInTasks(task.key);
            }}
          >
            <Icon name="ExternalLink" />
            <span>Open in Tasks</span>
          </button>
        </div>
      ) : null}
    </div>
  );

  const flashChip = flash ? (
    <span className="bbp-flash" data-tone={flash.tone} key={flash.text}>
      {flash.tone === "busy" ? <Dot tone="working" /> : <Icon name={flash.tone === "good" ? "CircleCheck" : "CircleX"} />}
      <span>{flash.text}</span>
    </span>
  ) : null;

  const parentMark =
    parent && depth === 0 ? (
      <button
        type="button"
        className="bbp-parent-mark"
        title={`Sub-task of ${parent.key} ${parent.title}`}
        onClick={(event) => {
          event.stopPropagation();
          ctx.onOpen?.(parent);
        }}
      >
        <Icon name="CornerDownRight" />
        {parent.key}
      </button>
    ) : null;

  if (layout === "row") {
    return (
      <article {...shell}>
        <StatusGlyph status={task.status} />
        <span className="bbp-card__key">{task.key}</span>
        <span className="bbp-card__title">{renderTitle(task.title)}</span>
        {parentMark}
        {derived ? <BehindHint derived={derived} stored={task.status} compact /> : null}
        <span className="bbp-row-slots">
          {flashChip ?? (
            <>
              <span className="bbp-row-pr">
                <SubtaskPill subtasks={subtasks} onOpen={ctx.onOpen} />
                {landing ? <CommitChip landing={landing} /> : null}
                <PullRequestChips pullRequests={pullRequests} summaries={summaries} showLabel={false} />
              </span>
              <span className="bbp-row-agent">
                <AgentChips agents={agents} max={1} compact />
              </span>
            </>
          )}
        </span>
        {tools}
      </article>
    );
  }

  return (
    <article {...shell}>
      <header className="bbp-card__head">
        <span className="bbp-card__key">{task.key}</span>
        {parentMark}
        {labels.map((label) => (
          <span className="bbp-label" key={label.id} style={{ ["--bbp-label" as string]: label.color }}>
            {label.name}
          </span>
        ))}
        <PriorityGlyph priority={task.priority} />
        {tools}
      </header>
      <div className="bbp-card__title">{renderTitle(task.title)}</div>
      {derived ? <BehindHint derived={derived} stored={task.status} compact={false} onApply={ctx.onApply ? () => ctx.onApply!(task, derived.status) : undefined} /> : null}
      {agents.length > 0 ? <AgentChips agents={agents} max={3} /> : null}
      {pullRequests.length > 0 || changes || flash || subtasks.length > 0 || landing || attachmentCount > 0 ? (
        <footer className="bbp-card__foot">
          {flashChip ?? <SubtaskPill subtasks={subtasks} onOpen={ctx.onOpen} />}
          <span className="bbp-card__chips">
            {changes ? (
              <button
                type="button"
                className="bbp-chip"
                title={`${changes.files} changed ${changes.files === 1 ? "file" : "files"} in the agent's worktree`}
                onClick={() => openThread(true)}
              >
                <span className="bbp-diff" data-sign="plus">+{changes.insertions}</span>
                <span className="bbp-diff" data-sign="minus">−{changes.deletions}</span>
              </button>
            ) : null}
            <AttachmentsChip taskId={task.id} count={attachmentCount} />
            {landing ? <CommitChip landing={landing} /> : null}
            <PullRequestChips pullRequests={pullRequests} summaries={summaries} showLabel />
          </span>
        </footer>
      ) : null}
    </article>
  );
}
