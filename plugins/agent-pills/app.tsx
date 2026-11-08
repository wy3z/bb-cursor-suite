// bb-plugin-agent-pills — Cursor-style subagent pills and composer.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time.
import "@wy3z/bb-suite/tokens.css";
import "./app.css";
import {
  definePluginApp,
  experimental_THREAD_CONTEXT_SEGMENT_GROUPS,
} from "@get-bb/plugin-sdk/app";
import { AgentPillsSummary } from "./src/PillRow";
import { ChangesPill, useChanges } from "./src/ChangesPill";
import { useActivity } from "./src/pill-data";
import { CompactPill, useCompactToggleVisible } from "./src/CompactPill";
import {
  applyPillsEnabled,
  onPillsEnabledChange,
  readPillsEnabled,
  usePillsEnabled,
  writePillsEnabled,
} from "./src/preferences";
import { COMPOSER_ATTRIBUTE } from "./src/channels";
import { startComposerLayout } from "./src/composer-layout";

/** The segment exists only while it has at least one pill to draw. */
function usePillsVisible({
  threadId,
}: {
  threadId: string;
  projectId: string;
  environment: { id: string } | null;
}): boolean {
  const enabled = usePillsEnabled();
  const { activity } = useActivity(threadId);
  return enabled && (
    activity.subagents.length > 0 ||
    activity.background.length > 0 ||
    activity.workflows.length > 0 ||
    activity.plan !== null ||
    activity.goal !== null ||
    (activity.todos?.items.length ?? 0) > 0 ||
    activity.modelFallback !== null ||
    activity.queue.length > 0 ||
    activity.thread.archived ||
    activity.thread.workspaceGone ||
    activity.machine !== null
  );
}

function PillsSettings() {
  const enabled = usePillsEnabled();

  return (
    <div className="bb-agent-pills-settings">
      <label className="bb-agent-pills-settings__row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => writePillsEnabled(event.currentTarget.checked)}
        />
        <span className="bb-agent-pills-settings__copy">
          <span className="bb-agent-pills-settings__title">Agent pills</span>
          <span className="bb-agent-pills-settings__hint">
            Adds pills above the composer for child threads, background tasks,
            to-dos, the queue and changed files, in place of BB's full-width
            cards. Turn off to keep BB's cards. On by default.
          </span>
        </span>
      </label>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadContextSegment({
    id: "activity-pills",
    title: "Agent activity",
    group: experimental_THREAD_CONTEXT_SEGMENT_GROUPS.thread,
    order: 20,
    summary: AgentPillsSummary,
    useVisible: usePillsVisible,
  });

  app.slots.experimental_threadContextSegment({
    id: "compact-before-send",
    title: "Compact before sending",
    group: experimental_THREAD_CONTEXT_SEGMENT_GROUPS.thread,
    order: 30,
    summary: CompactPill,
    useVisible: () => {
      const enabled = usePillsEnabled();
      return useCompactToggleVisible() && enabled;
    },
  });

  // Git +/- for the thread's checkout, in BB's git group (after the thread
  // group's pills). BB's own changed-files segment is hidden in app.css.
  app.slots.experimental_threadContextSegment({
    id: "changes",
    title: "Changed files",
    group: experimental_THREAD_CONTEXT_SEGMENT_GROUPS.git,
    order: 10,
    summary: ChangesPill,
    useVisible: (input) => {
      const enabled = usePillsEnabled();
      return useChanges(input) !== null && enabled;
    },
  });

  app.slots.settingsSection({
    id: "pills",
    title: "Agent pills",
    component: PillsSettings,
  });

  app.contentScripts.register({
    id: "composer-restyle",
    mount: ({ signal }) => {
      const root = document.documentElement;
      root.setAttribute(COMPOSER_ATTRIBUTE, "cursor");
      applyPillsEnabled(readPillsEnabled(), root);
      const stopPills = onPillsEnabledChange((on) => applyPillsEnabled(on, root));
      startComposerLayout(signal);
      signal.addEventListener("abort", () => {
        stopPills();
        root.removeAttribute(COMPOSER_ATTRIBUTE);
        applyPillsEnabled(false, root);
      });
    },
  });
});
