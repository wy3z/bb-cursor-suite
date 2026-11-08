/**
 * The pill row's contents: one track per thing BB would otherwise draw as a
 * full-width card above the composer.
 */
import { useMemo } from "react";
import type { Activity, PillGroup, PillState } from "../pill-data";
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
