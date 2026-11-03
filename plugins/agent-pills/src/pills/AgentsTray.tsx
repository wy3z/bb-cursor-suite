/**
 * Subagents, after Cursor's agent tray (subagent-tray.surfaces,
 * subagent-tray-rows): a chip reading "Agents", or "Working 2" with a
 * spinner while children run, opens a tray headed "N Agents". Running and
 * waiting agents come first, finished ones under "Recent". Each row has bb's
 * status glyph, the title, an inline description, and the elapsed time,
 * which hover swaps for a close button. Stop All (confirmed) or Clear All
 * sits in the header.
 */
import { useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  useBbNavigate,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { PillState, SubagentItem } from "../pill-data";
import { formatElapsed, shortModel, useNow } from "./primitives";

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

function isActive(item: SubagentItem): boolean {
  return item.state === "running" || item.state === "needs-input";
}

export function AgentsChip({
  subagents,
  open,
  onToggle,
}: {
  subagents: readonly SubagentItem[];
  open: boolean;
  onToggle: () => void;
}) {
  const working = subagents.filter(isActive).length;
  const needsYou = subagents.some((item) => item.state === "needs-input");
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
          <ThreadStatusGlyph indicator="runtime" />
        </span>
      ) : null}
      <span className="bb-agent-pills__label">{working > 0 ? "Working" : "Agents"}</span>
      {working > 0 ? <span className="bb-agent-pills__chip-count">{working}</span> : null}
    </button>
  );
}

function AgentRow({
  item,
  now,
  onOpen,
  onClose,
}: {
  item: SubagentItem;
  now: number;
  onOpen: (item: SubagentItem, split: boolean) => void;
  onClose: (item: SubagentItem) => void;
}) {
  const description = DESCRIPTION[item.state];
  return (
    <div
      role="menuitem"
      tabIndex={0}
      className="bb-agent-pills__tray-row"
      aria-label={`${item.title}, ${description}`}
      onClick={(event) => onOpen(item, event.metaKey || event.ctrlKey || event.altKey)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(item, false);
        }
      }}
    >
      <span className="bb-agent-pills__tray-leading" aria-hidden="true">
        <ThreadStatusGlyph indicator={INDICATOR[item.state]} />
      </span>
      <span className="bb-agent-pills__tray-label" title={item.title}>
        {item.title}
      </span>
      <span
        className="bb-agent-pills__tray-description"
        data-shimmer={item.state === "running" || undefined}
        title={item.model ?? undefined}
      >
        {description}
        {item.model ? ` · ${shortModel(item.model)}` : ""}
      </span>
      {item.state === "needs-input" ? (
        <span className="bb-agent-pills__tray-inline">
          <button
            type="button"
            className="bb-agent-pills__tray-button"
            data-tone="primary"
            onClick={(event) => {
              event.stopPropagation();
              onOpen(item, false);
            }}
          >
            Answer
          </button>
        </span>
      ) : null}
      <span className="bb-agent-pills__tray-end">
        <span className="bb-agent-pills__tray-actions">
          <button
            type="button"
            className="bb-agent-pills__tray-icon-button"
            aria-label={`${isActive(item) ? "Stop" : "Close"} ${item.title}`}
            title={isActive(item) ? "Stop" : "Close"}
            onClick={(event) => {
              event.stopPropagation();
              onClose(item);
            }}
          >
            <Icon name="X" />
          </button>
        </span>
        <span className="bb-agent-pills__tray-meta">{formatElapsed(item.createdAt, now)}</span>
      </span>
    </div>
  );
}

export function AgentsTray({
  subagents,
  onDismiss,
  refresh,
}: {
  subagents: readonly SubagentItem[];
  onDismiss: () => void;
  refresh: () => void;
}) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const now = useNow(true);
  const [confirmStop, setConfirmStop] = useState(false);
  const [recentShown, setRecentShown] = useState(FIRST_PAGE);

  const active = subagents.filter(isActive);
  const recent = subagents.filter((item) => !isActive(item));
  const running = subagents.filter((item) => item.state === "running");
  const total = subagents.length;

  const open = (item: SubagentItem, split: boolean) => {
    onDismiss();
    navigate.toThread(item.threadId, split ? { split: true } : undefined);
  };
  const stop = (items: readonly SubagentItem[]) => {
    void Promise.allSettled(items.map((item) => sdk.threads.stop({ threadId: item.threadId }))).then(refresh);
  };
  const clear = (items: readonly SubagentItem[]) => {
    void Promise.allSettled(items.map((item) => sdk.threads.markRead({ threadId: item.threadId }))).then(refresh);
  };
  const close = (item: SubagentItem) => (isActive(item) ? stop([item]) : clear([item]));

  const row = (item: SubagentItem) => (
    <AgentRow key={item.threadId} item={item} now={now} onOpen={open} onClose={close} />
  );
  const hidden = Math.max(0, recent.length - recentShown);

  return (
    <div className="bb-agent-pills__panel bb-agent-pills__tray" role="menu" aria-label="Agents">
      <div className="bb-agent-pills__tray-header">
        <span className="bb-agent-pills__tray-title">
          {total} {total === 1 ? "Agent" : "Agents"}
        </span>
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
        ) : recent.length > 0 ? (
          <button
            type="button"
            className="bb-agent-pills__tray-header-action"
            aria-label={`Clear ${recent.length} completed ${recent.length === 1 ? "agent" : "agents"}`}
            onClick={() => clear(recent)}
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
      {total === 0 ? (
        <div className="bb-agent-pills__tray-empty">No recent agents yet.</div>
      ) : (
        <div className="bb-agent-pills__tray-rows">
          {active.map(row)}
          {active.length > 0 && recent.length > 0 ? (
            <div className="bb-agent-pills__tray-subheader">Recent</div>
          ) : null}
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
