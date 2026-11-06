/**
 * Pills above the composer, after Paseo's composer tracks: one pill per group
 * (subagents, background, workflow, plan mode, goal, to-dos, model fallback,
 * queue, thread state, machine), split into status segments where a group has
 * more than one state ("2 working · 1 needs input"). Clicking a pill opens a
 * popover above it with that group's members and actions.
 * Styling lives in app.css.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ExperimentalThreadContextSegmentProps } from "@get-bb/plugin-sdk/app";
import { SHOW_QUEUE_ATTRIBUTE } from "./channels";
import { useActivity, type Activity, type PillGroup } from "./pill-data";
import { usePillActions } from "./pills/actions";
import { PillPanel } from "./pills/panels";
import { useTracks, type Track } from "./pills/tracks";
import { StateDot } from "./pills/primitives";
import { AgentsChip, AgentsTray, trayItems } from "./pills/AgentsTray";

function TrackPill({
  track,
  open,
  onToggle,
}: {
  track: Track;
  open: boolean;
  onToggle: () => void;
}) {
  const label = track.segments.map((segment) => segment.text).join(", ");
  return (
    <button
      type="button"
      className="bb-agent-pills__pill"
      data-group={track.id}
      data-tone={track.tone}
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label={`${track.title}: ${label}`}
      onClick={onToggle}
    >
      {track.segments.map((segment) => (
        <span className="bb-agent-pills__segment" key={segment.state ?? "plain"}>
          {segment.state ? <StateDot state={segment.state} /> : null}
          <span className="bb-agent-pills__label">{segment.text}</span>
        </span>
      ))}
    </button>
  );
}

export function AgentPillsSummary({ threadId }: ExperimentalThreadContextSegmentProps) {
  const { activity, refresh, dismissFallback } = useActivity(threadId);
  const tracks = useTracks(activity);
  const [open, setOpen] = useState<PillGroup | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const actions = usePillActions({ threadId, refresh, dismissFallback });

  const openTrack = tracks.find((track) => track.id === open) ?? null;
  const agentItems = useMemo(
    () => trayItems(activity.subagents, activity.background),
    [activity.subagents, activity.background],
  );
  const hasAgents = agentItems.length > 0;
  const agentsOpen = open === "subagents" && hasAgents;
  const anyOpen = openTrack !== null || agentsOpen;

  // Close on a click outside or Escape, like a menu.
  useEffect(() => {
    if (!anyOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anyOpen]);

  // A pill that just disappeared (goal cleared, queue drained) must not leave
  // its popover behind.
  useEffect(() => {
    if (open !== null && !anyOpen) setOpen(null);
  }, [open, anyOpen]);

  // BB's queue box was brought back for editing; hide it again once the
  // queue is empty or this thread's row goes away.
  const queueEmpty = activity.queue.length === 0;
  useEffect(() => {
    if (queueEmpty) document.documentElement.removeAttribute(SHOW_QUEUE_ATTRIBUTE);
  }, [queueEmpty]);
  useEffect(() => () => document.documentElement.removeAttribute(SHOW_QUEUE_ATTRIBUTE), [threadId]);

  if (tracks.length === 0 && !hasAgents) return null;

  return (
    <div className="bb-agent-pills" data-bb-agent-pills="" ref={rootRef}>
      <div className="bb-agent-pills__row">
        {hasAgents ? (
          <AgentsChip
            items={agentItems}
            open={agentsOpen}
            onToggle={() => setOpen((current) => (current === "subagents" ? null : "subagents"))}
          />
        ) : null}
        {tracks.map((track) => (
          <TrackPill
            key={track.id}
            track={track}
            open={open === track.id}
            onToggle={() => setOpen((current) => (current === track.id ? null : track.id))}
          />
        ))}
      </div>
      {agentsOpen ? (
        <AgentsTray items={agentItems} parentEnvironmentId={activity.thread.environmentId} onDismiss={() => setOpen(null)} refresh={refresh} />
      ) : null}
      {openTrack ? (
        <Popover
          track={openTrack}
          activity={activity}
          actions={actions}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

function Popover({
  track,
  activity,
  actions,
  onClose,
}: {
  track: Track;
  activity: Activity;
  actions: ReturnType<typeof usePillActions>;
  onClose: () => void;
}) {
  return (
    <div className="bb-agent-pills__panel" role="menu" aria-label={track.title}>
      <div className="bb-agent-pills__panel-title">{track.title}</div>
      <PillPanel track={track} activity={activity} actions={actions} onClose={onClose} />
    </div>
  );
}
