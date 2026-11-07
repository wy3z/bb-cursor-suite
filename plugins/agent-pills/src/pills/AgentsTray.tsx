import { useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  useBbNavigate,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { useGitActions } from "../git-client";
import { STATE_ORDER, type PillState, type SubagentItem, type TaskItem } from "../pill-data";
import { AgentIcon, CommandIcon, Orb, StateDot, formatElapsed, shortModel, useNow } from "./primitives";

const FIRST_PAGE = 5;
const NEXT_PAGE = 8;

const INDICATOR: Record<PillState, "runtime" | "waiting-for-input" | "unread-error" | "unread-success" | "none"> = {
  running: "runtime",
  "needs-input": "waiting-for-input",
  error: "unread-error",
  "done-unread": "unread-success",
  done: "none",
};

const DESCRIPTION: Record<PillState, string> = {
  running: "Working",
  "needs-input": "Needs input",
  error: "Failed",
  "done-unread": "Ready to review",
  done: "Done",
};

export type TrayItem =
  | { type: "thread"; key: string; state: PillState; title: string; model: string | null; startedAt: number; thread: SubagentItem }
  | { type: "task"; key: string; state: PillState; title: string; model: string | null; startedAt: number; task: TaskItem };

function isActive(item: { state: PillState }): boolean {
  return item.state === "running" || item.state === "needs-input";
}

export function trayItems(subagents: readonly SubagentItem[], background: readonly TaskItem[]): TrayItem[] {
  const items: TrayItem[] = [
    ...subagents.map((thread): TrayItem => ({
      type: "thread",
      key: `thread:${thread.threadId}`,
      state: thread.state,
      title: thread.title,
      model: thread.model,
      startedAt: thread.createdAt,
      thread,
    })),
    ...background.map((task): TrayItem => ({
      type: "task",
      key: `task:${task.id}`,
      state: task.state,
      title: task.title,
      model: task.model,
      startedAt: task.startedAt,
      task,
    })),
  ];
  return items.sort((left, right) => {
    const rank = STATE_ORDER[left.state] - STATE_ORDER[right.state];
    return rank !== 0 ? rank : right.startedAt - left.startedAt;
  });
}

function trayTitle(items: readonly TrayItem[]): string {
  const total = items.length;
  const commands = items.some((item) => item.type === "task" && item.task.kind === "command");
  if (commands) return `${total} ${total === 1 ? "Task" : "Tasks"}`;
  return `${total} ${total === 1 ? "Agent" : "Agents"}`;
}

export function AgentsChip({
  items,
  open,
  onToggle,
}: {
  items: readonly TrayItem[];
  open: boolean;
  onToggle: () => void;
}) {
  const working = items.filter(isActive).length;
  const needsYou = items.some((item) => item.state === "needs-input");
  return (
    <button
      type="button"
      className="bb-agent-pills__pill"
      data-group="subagents"
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label={working > 0 ? `Agents, Working ${working}` : "Agents"}
      onClick={onToggle}
    >
      {needsYou ? (
        <span className="bb-agent-pills__chip-lead" aria-hidden="true">
          <ThreadStatusGlyph indicator="waiting-for-input" />
        </span>
      ) : working > 0 ? (
        <span className="bb-agent-pills__chip-lead" aria-hidden="true">
          <Orb />
        </span>
      ) : null}
      <span className="bb-agent-pills__label">{working > 0 ? "Working" : "Agents"}</span>
      {working > 0 ? <span className="bb-agent-pills__chip-count">{working}</span> : null}
    </button>
  );
}

function Leading({ item }: { item: TrayItem }) {
  if (item.state === "running") return <Orb />;
  if (item.type === "thread") {
    if (item.state === "done-unread") return <StateDot state={item.state} />;
    return <ThreadStatusGlyph indicator={INDICATOR[item.state]} />;
  }
  return (
    <span className="bb-agent-pills__glyph" data-kind={item.task.kind} data-state={item.state}>
      {item.task.kind === "agent" ? <AgentIcon /> : <CommandIcon />}
    </span>
  );
}

type ApplyState = { kind: "busy" } | { kind: "done"; text: string } | { kind: "error"; text: string };

function AgentRow({
  item,
  now,
  canApply,
  apply,
  onOpen,
  onClose,
  onApply,
}: {
  item: TrayItem;
  now: number;
  canApply: boolean;
  apply: ApplyState | undefined;
  onOpen: (item: SubagentItem, split: boolean) => void;
  onClose: (item: SubagentItem) => void;
  onApply: (item: SubagentItem) => void;
}) {
  const description = DESCRIPTION[item.state];
  const thread = item.type === "thread" ? item.thread : null;
  return (
    <div
      role="menuitem"
      tabIndex={thread ? 0 : -1}
      aria-disabled={thread ? undefined : true}
      className="bb-agent-pills__tray-row"
      data-kind={item.type}
      aria-label={`${item.title}, ${description}`}
      onClick={thread ? (event) => onOpen(thread, event.metaKey || event.ctrlKey || event.altKey) : undefined}
      onKeyDown={
        thread
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(thread, false);
              }
            }
          : undefined
      }
    >
      <span className="bb-agent-pills__tray-leading" aria-hidden="true">
        <Leading item={item} />
      </span>
      <span className="bb-agent-pills__tray-label" title={item.title}>
        {item.title}
      </span>
      {apply ? (
        <span
          className="bb-agent-pills__tray-description bb-agent-pills__apply-status"
          data-kind={apply.kind}
          data-shimmer={apply.kind === "busy" || undefined}
          title={apply.kind === "busy" ? undefined : apply.text}
          key={apply.kind}
        >
          {apply.kind === "busy" ? "Applying…" : apply.text}
        </span>
      ) : (
        <span
          className="bb-agent-pills__tray-description"
          data-shimmer={item.state === "running" || undefined}
          title={item.model ?? undefined}
        >
          {item.type === "task" && item.task.kind === "command" ? "Command" : description}
          {item.model ? ` · ${shortModel(item.model)}` : ""}
        </span>
      )}
      {thread && item.state === "needs-input" ? (
        <span className="bb-agent-pills__tray-inline">
          <button
            type="button"
            className="bb-agent-pills__tray-button"
            data-tone="primary"
            onClick={(event) => {
              event.stopPropagation();
              onOpen(thread, false);
            }}
          >
            Answer
          </button>
        </span>
      ) : null}
      <span className="bb-agent-pills__tray-end">
        {thread ? (
          <span className="bb-agent-pills__tray-actions">
            {canApply ? (
              <button
                type="button"
                className="bb-agent-pills__tray-icon-button"
                aria-label={`Apply ${thread.title} locally`}
                title="Apply locally: copy this worktree's changes into your checkout"
                disabled={apply?.kind === "busy"}
                onClick={(event) => {
                  event.stopPropagation();
                  onApply(thread);
                }}
              >
                <Icon name="Download" />
              </button>
            ) : null}
            <button
              type="button"
              className="bb-agent-pills__tray-icon-button"
              aria-label={`${isActive(thread) ? "Stop" : "Close"} ${thread.title}`}
              title={isActive(thread) ? "Stop" : "Close"}
              onClick={(event) => {
                event.stopPropagation();
                onClose(thread);
              }}
            >
              <Icon name="X" />
            </button>
          </span>
        ) : null}
        <span className="bb-agent-pills__tray-meta">{formatElapsed(item.startedAt, now)}</span>
      </span>
    </div>
  );
}

export function AgentsTray({
  items,
  parentEnvironmentId,
  onDismiss,
  refresh,
}: {
  items: readonly TrayItem[];
  parentEnvironmentId: string | null;
  onDismiss: () => void;
  refresh: () => void;
}) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const rpc = useGitActions();
  const [applies, setApplies] = useState<Record<string, ApplyState>>({});
  const canApply = (item: SubagentItem) =>
    parentEnvironmentId !== null &&
    item.isWorktree &&
    item.environmentId !== null &&
    item.environmentId !== parentEnvironmentId;
  const applyLocally = (item: SubagentItem) => {
    if (!canApply(item) || applies[item.threadId]?.kind === "busy") return;
    const set = (state: ApplyState) => setApplies((current) => ({ ...current, [item.threadId]: state }));
    set({ kind: "busy" });
    rpc
      .call("gitApplyLocally", { sourceEnvironmentId: item.environmentId!, targetEnvironmentId: parentEnvironmentId! })
      .then(
        (result) =>
          result.ok
            ? set({ kind: "done", text: `Applied ${result.files ?? 0} ${result.files === 1 ? "file" : "files"}` })
            : set({ kind: "error", text: result.error ?? "Apply failed" }),
        (error: unknown) => set({ kind: "error", text: error instanceof Error ? error.message : "Apply failed" }),
      );
  };
  const now = useNow(true);
  const [confirmStop, setConfirmStop] = useState(false);
  const [recentShown, setRecentShown] = useState(FIRST_PAGE);

  const threads = items.flatMap((item) => (item.type === "thread" ? [item.thread] : []));
  const active = items.filter(isActive);
  const recent = items.filter((item) => !isActive(item));
  const running = threads.filter((item) => item.state === "running");
  const recentThreads = threads.filter((item) => !isActive(item));

  const open = (item: SubagentItem, split: boolean) => {
    onDismiss();
    navigate.toThread(item.threadId, split ? { split: true } : undefined);
  };
  const stop = (list: readonly SubagentItem[]) => {
    void Promise.allSettled(list.map((item) => sdk.threads.stop({ threadId: item.threadId }))).then(refresh);
  };
  const clear = (list: readonly SubagentItem[]) => {
    void Promise.allSettled(list.map((item) => sdk.threads.markRead({ threadId: item.threadId }))).then(refresh);
  };
  const close = (item: SubagentItem) => (isActive(item) ? stop([item]) : clear([item]));

  const row = (item: TrayItem) => (
    <AgentRow
      key={item.key}
      item={item}
      now={now}
      canApply={item.type === "thread" && canApply(item.thread)}
      apply={item.type === "thread" ? applies[item.thread.threadId] : undefined}
      onOpen={open}
      onClose={close}
      onApply={applyLocally}
    />
  );
  const hidden = Math.max(0, recent.length - recentShown);

  return (
    <div className="bb-agent-pills__panel bb-agent-pills__tray" role="menu" aria-label="Agents">
      <div className="bb-agent-pills__tray-header">
        <span className="bb-agent-pills__tray-title">{trayTitle(items)}</span>
        {running.length > 0 ? (
          <button
            type="button"
            className="bb-agent-pills__tray-header-action"
            aria-label={
              confirmStop
                ? `Confirm stopping ${running.length} running ${running.length === 1 ? "agent" : "agents"}`
                : `Stop ${running.length} running ${running.length === 1 ? "agent" : "agents"}`
            }
            onClick={() => {
              if (!confirmStop) {
                setConfirmStop(true);
                return;
              }
              setConfirmStop(false);
              stop(running);
            }}
          >
            {confirmStop ? "Confirm" : "Stop All"}
          </button>
        ) : recentThreads.length > 0 ? (
          <button
            type="button"
            className="bb-agent-pills__tray-header-action"
            aria-label={`Clear ${recentThreads.length} completed ${recentThreads.length === 1 ? "agent" : "agents"}`}
            onClick={() => clear(recentThreads)}
          >
            Clear All
          </button>
        ) : null}
        <button
          type="button"
          className="bb-agent-pills__tray-icon-button"
          aria-label="Minimize"
          title="Minimize (Esc)"
          onClick={onDismiss}
        >
          <Icon name="Minus" />
        </button>
      </div>
      {items.length === 0 ? (
        <div className="bb-agent-pills__tray-empty">No recent agents yet.</div>
      ) : (
        <div className="bb-agent-pills__tray-rows">
          {active.map(row)}
          {active.length > 0 && recent.length > 0 ? <div className="bb-agent-pills__tray-subheader">Recent</div> : null}
          {recent.slice(0, recentShown).map(row)}
          {hidden > 0 ? (
            <button
              type="button"
              className="bb-agent-pills__tray-more"
              aria-label={`Show ${Math.min(hidden, NEXT_PAGE)} more agents`}
              onClick={() => setRecentShown((count) => count + NEXT_PAGE)}
            >
              More
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
