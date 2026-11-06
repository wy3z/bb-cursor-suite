/**
 * The popover body behind each pill: a row per member for the activity pills,
 * a short read-out plus one action for the state pills.
 */
import type { ReactNode } from "react";
import { SHOW_QUEUE_ATTRIBUTE } from "../channels";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Activity } from "../pill-data";
import type { PillActions } from "./actions";
import {
  StateDot,
  formatDuration,
  formatElapsed,
  formatTokens,
  shortModel,
  useNow,
} from "./primitives";
import type { Track } from "./tracks";

interface PanelProps {
  track: Track;
  activity: Activity;
  actions: PillActions;
  onClose: () => void;
}

function Action({
  children,
  onClick,
  busy,
  tone,
}: {
  children: string;
  onClick: () => void;
  busy: boolean;
  tone?: "primary";
}) {
  return (
    <button
      type="button"
      className="bb-agent-pills__action"
      data-tone={tone}
      disabled={busy}
      onClick={onClick}
    >
      {busy ? `${children}…` : children}
    </button>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <div className="bb-agent-pills__panel-meta">{children}</div>;
}

function Note({ children }: { children: ReactNode }) {
  return <p className="bb-agent-pills__panel-note">{children}</p>;
}

/** Model names in a fallback read-out: provider prefix dropped, as elsewhere. */
function modelPair(original: string, fallback: string): string {
  return `${shortModel(original)} -> ${shortModel(fallback)}`;
}

export function PillPanel({ track, activity, actions, onClose }: PanelProps) {
  const navigate = useBbNavigate();
  const now = useNow(track.id === "workflow" || track.id === "goal");
  const { pending } = actions;

  let body: ReactNode = null;
  let footer: ReactNode = null;

  switch (track.id) {
    case "subagents":
      body = activity.subagents.map((item) => (
        <button
          type="button"
          role="menuitem"
          key={item.threadId}
          className="bb-agent-pills__row-item"
          data-state={item.state}
          onClick={() => {
            onClose();
            navigate.toThread(item.threadId);
          }}
        >
          <StateDot state={item.state} />
          <span className="bb-agent-pills__row-text">
            <span className="bb-agent-pills__row-title">{item.title}</span>
            {item.model ? (
              <span className="bb-agent-pills__row-model" title={item.model}>
                {shortModel(item.model)}
              </span>
            ) : null}
          </span>
          <span className="bb-agent-pills__row-time">
            {formatElapsed(item.createdAt, now)}
          </span>
        </button>
      ));
      break;

    case "workflow":
      body = activity.workflows.map((workflow) => (
        <div
          role="menuitem"
          aria-disabled="true"
          key={workflow.id}
          className="bb-agent-pills__row-item"
        >
          <StateDot state="running" />
          <span className="bb-agent-pills__row-text">
            <span className="bb-agent-pills__row-title" title={workflow.name}>
              {workflow.name}
            </span>
            {workflow.agentsTotal > 0 ? (
              <span className="bb-agent-pills__row-model">
                {workflow.agentsDone}/{workflow.agentsTotal} agents
              </span>
            ) : null}
          </span>
          <span className="bb-agent-pills__row-time">
            {formatElapsed(workflow.startedAt, now)}
          </span>
        </div>
      ));
      break;

    case "plan":
      body = activity.plan ? (
        <div className="bb-agent-pills__panel-text" role="menuitem" aria-disabled="true">
          {activity.plan.prompt.trim() || "No prompt text."}
        </div>
      ) : null;
      footer = (
        <Action busy={pending === "plan"} onClick={actions.exitPlanMode}>
          Exit plan mode
        </Action>
      );
      break;

    case "goal":
      body = activity.goal ? (
        <>
          <div className="bb-agent-pills__panel-text" role="menuitem" aria-disabled="true">
            {activity.goal.objective.trim() || "No goal objective."}
          </div>
          <Meta>
            {formatDuration(activity.goal.timeUsedSeconds)} ·{" "}
            {activity.goal.tokenBudget === null
              ? `${formatTokens(activity.goal.tokensUsed)} tokens`
              : `${formatTokens(activity.goal.tokensUsed)} / ${formatTokens(
                  activity.goal.tokenBudget,
                )} tokens`}
          </Meta>
        </>
      ) : null;
      footer = (
        <Action busy={pending === "goal"} onClick={actions.clearGoal}>
          Clear goal
        </Action>
      );
      break;

    case "todos":
      body = (activity.todos?.items ?? []).map((item) => (
        <div
          role="menuitem"
          aria-disabled="true"
          key={item.id}
          className="bb-agent-pills__row-item"
          data-todo={item.status}
        >
          <span
            className="bb-agent-pills__dot"
            data-todo={item.status}
            aria-hidden="true"
          />
          <span className="bb-agent-pills__row-title" title={item.text}>
            {item.text}
          </span>
        </div>
      ));
      break;

    case "fallback":
      body = activity.modelFallback ? (
        <>
          <Note>{activity.modelFallback.message}</Note>
          <Meta>
            <span className="bb-agent-pills__row-model">
              {modelPair(
                activity.modelFallback.originalModel,
                activity.modelFallback.fallbackModel,
              )}
            </span>
          </Meta>
        </>
      ) : null;
      footer = (
        <Action busy={false} onClick={actions.dismissFallback}>
          Dismiss
        </Action>
      );
      break;

    case "queue":
      body = activity.queue.map((message) => (
        <div
          role="menuitem"
          aria-disabled="true"
          key={message.id}
          className="bb-agent-pills__row-item"
        >
          <span className="bb-agent-pills__row-title" title={message.preview}>
            {message.preview}
          </span>
          <span className="bb-agent-pills__row-actions">
            <Action
              busy={pending === `queue:${message.id}:send`}
              onClick={() => actions.sendQueued(message.id)}
            >
              Send now
            </Action>
            <Action
              busy={pending === `queue:${message.id}:delete`}
              onClick={() => actions.deleteQueued(message.id)}
            >
              Delete
            </Action>
          </span>
        </div>
      ));
      // Editing and reordering stay in BB's own queue box, which the pill
      // hides; this brings it back until the queue empties.
      footer = (
        <Action
          busy={false}
          onClick={() => {
            document.documentElement.setAttribute(SHOW_QUEUE_ATTRIBUTE, "");
            onClose();
          }}
        >
          Edit or reorder
        </Action>
      );
      break;

    case "thread":
      body = (
        <Note>
          {activity.thread.archived
            ? "This thread is archived. Unarchive it to bring it back to the sidebar."
            : "This thread's workspace was removed. Restore it to send messages again."}
        </Note>
      );
      footer = activity.thread.archived ? (
        <Action busy={pending === "thread"} onClick={actions.unarchive}>
          Unarchive
        </Action>
      ) : (
        <Action busy={pending === "thread"} onClick={actions.restoreEnvironment}>
          Restore workspace
        </Action>
      );
      break;

    case "machine":
      body = (
        <Note>
          {activity.machine?.phase === "suspended"
            ? "This thread's machine is paused. Resume it to keep working."
            : "This thread's machine is waking up."}
        </Note>
      );
      footer = activity.machine ? (
        <Action
          busy={pending === "machine"}
          onClick={() => actions.resumeHost(activity.machine!.hostId)}
        >
          Resume
        </Action>
      ) : null;
      break;
  }

  return (
    <>
      <div className="bb-agent-pills__list">{body}</div>
      {footer ? <div className="bb-agent-pills__panel-footer">{footer}</div> : null}
    </>
  );
}
