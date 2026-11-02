/**
 * The pill row's contents: one track per thing BB would otherwise draw as a
 * full-width card above the composer.
 */
import { useMemo } from "react";
import type { Activity, PillGroup, PillState } from "../pill-data";
import { STATE_ORDER } from "../pill-data";
import type { ActiveGoal } from "../rpc";
import { formatDuration } from "./primitives";

export interface Segment {
  state: PillState | null;
  text: string;
}

export interface Track {
  id: PillGroup;
  /** Panel heading and the accessible name's prefix. */
  title: string;
  segments: Segment[];
  tone?: "warn";
}

/** Paseo's wording: one segment per non-empty bucket, "done" never shown. */
function segmentText(state: PillState, count: number): string {
  switch (state) {
    case "needs-input":
      return count === 1 ? "1 needs input" : `${count} need input`;
    case "running":
      return `${count} working`;
    case "error":
      return `${count} failed`;
    case "done-unread":
      return `${count} ready to review`;
    case "done":
      return `${count} done`;
  }
}

function buildSegments(states: readonly PillState[], fallback: string): Segment[] {
  const counts = new Map<PillState, number>();
  for (const state of states) {
    if (state !== "done") counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  if (counts.size === 0) return [{ state: null, text: fallback }];
  return [...counts.entries()]
    .sort(([left], [right]) => STATE_ORDER[left] - STATE_ORDER[right])
    .map(([state, count]) => ({ state, text: segmentText(state, count) }));
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

function backgroundTitle(activity: Activity): string {
  const count = activity.background.length;
  const agents = activity.background.filter((task) => task.kind === "agent").length;
  if (agents === count) return plural(count, "background agent", "background agents");
  if (agents === 0) return plural(count, "background command", "background commands");
  return `${count} background tasks`;
}

const GOAL_LABELS: Record<ActiveGoal["status"], string> = {
  active: "Goal",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usageLimited: "Goal usage limited",
  budgetLimited: "Goal usage limited",
};

const MACHINE_LABELS = {
  suspended: "Machine paused",
  suspending: "Machine pausing…",
  resuming: "Machine resuming…",
} as const;

function workflowTrack(activity: Activity): Track | null {
  const [first] = activity.workflows;
  if (first === undefined) return null;
  if (activity.workflows.length > 1) {
    return {
      id: "workflow",
      title: "Workflows",
      segments: [{ state: null, text: `${activity.workflows.length} workflows` }],
    };
  }
  const agents =
    first.agentsTotal > 0 ? ` · ${first.agentsDone}/${first.agentsTotal} agents` : "";
  return {
    id: "workflow",
    title: "Workflow",
    segments: [{ state: null, text: `${first.name}${agents}` }],
  };
}

/** Every track the current thread has something to say about, in BB's order. */
export function useTracks(activity: Activity): Track[] {
  return useMemo(() => {
    const tracks: (Track | null)[] = [];

    if (activity.subagents.length > 0) {
      const count = activity.subagents.length;
      tracks.push({
        id: "subagents",
        title: plural(count, "subagent", "subagents"),
        segments: buildSegments(
          activity.subagents.map((item) => item.state),
          plural(count, "subagent", "subagents"),
        ),
      });
    }
    if (activity.background.length > 0) {
      const title = backgroundTitle(activity);
      tracks.push({
        id: "background",
        title,
        segments: buildSegments(
          activity.background.map((item) => item.state),
          title,
        ),
      });
    }

    tracks.push(workflowTrack(activity));

    if (activity.plan) {
      tracks.push({
        id: "plan",
        title: "Plan mode",
        segments: [{ state: null, text: "Plan mode" }],
      });
    }

    if (activity.goal) {
      const goal = activity.goal;
      const label = GOAL_LABELS[goal.status];
      tracks.push({
        id: "goal",
        title: "Goal",
        tone: goal.status === "active" ? undefined : "warn",
        segments: [
          {
            state: null,
            text:
              goal.status === "active"
                ? `${label} · ${formatDuration(goal.timeUsedSeconds)}`
                : label,
          },
        ],
      });
    }

    const todoItems = activity.todos?.items ?? [];
    if (todoItems.length > 0) {
      const done = todoItems.filter((item) => item.status === "completed").length;
      tracks.push({
        id: "todos",
        title: "To-dos",
        segments: [{ state: null, text: `${done}/${todoItems.length} to-dos` }],
      });
    }

    if (activity.modelFallback) {
      tracks.push({
        id: "fallback",
        title: "Model fallback",
        tone: "warn",
        segments: [{ state: null, text: "Model fallback" }],
      });
    }

    if (activity.queue.length > 0) {
      tracks.push({
        id: "queue",
        title: "Queued messages",
        segments: [
          { state: null, text: `${activity.queue.length} queued` },
        ],
      });
    }

    if (activity.thread.archived || activity.thread.workspaceGone) {
      tracks.push({
        id: "thread",
        title: activity.thread.archived ? "Archived" : "Workspace removed",
        segments: [
          {
            state: null,
            text: activity.thread.archived ? "Archived" : "Workspace removed",
          },
        ],
      });
    }

    if (activity.machine) {
      tracks.push({
        id: "machine",
        title: "Machine",
        segments: [{ state: null, text: MACHINE_LABELS[activity.machine.phase] }],
      });
    }

    return tracks.filter((track): track is Track => track !== null);
  }, [activity]);
}
