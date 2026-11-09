// bb-plugin-agent-pills — Cursor-style subagent pills and composer.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time.
import "@wy3z/bb-suite/tokens.css";
import "@wy3z/bb-suite/settings.css";
import "./app.css";
import {
  definePluginApp,
  experimental_THREAD_CONTEXT_SEGMENT_GROUPS,
} from "@get-bb/plugin-sdk/app";
import { DEVICE_ONLY, SettingsCard, SettingsToggleRow } from "@wy3z/bb-suite/settings";
import { AgentPillsSummary } from "./src/PillRow";
import { ChangesPill, useChanges } from "./src/ChangesPill";
import { ParentPill, useParentPillVisible } from "./src/ParentPill";
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
import { EnvironmentPickerAction } from "./src/environment-picker/EnvironmentPicker";
import { OpenInEditorGuard } from "./src/open-in-editor/OpenInEditorGuard";
import { DesktopPill, useDesktopPillVisible } from "./src/desktop/DesktopPill";
import { DesktopTab, useDesktopTabVisible } from "./src/desktop/DesktopTab";
import { DESKTOP_TAB } from "./src/desktop/model";

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
    <SettingsCard>
      <SettingsToggleRow
        label="Agent pills"
        description={`Pills above the composer for child threads, background tasks, to-dos, the queue and changed files, in place of BB's full-width cards. Off brings BB's cards back; the composer stays. On by default. ${DEVICE_ONLY}`}
        checked={enabled}
        onCheckedChange={writePillsEnabled}
      />
    </SettingsCard>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadContextSegment({
    id: "parent-thread",
    title: "Parent thread",
    group: experimental_THREAD_CONTEXT_SEGMENT_GROUPS.thread,
    order: 11,
    summary: ParentPill,
    useVisible: useParentPillVisible,
  });

  app.slots.experimental_threadContextSegment({
    id: "desktop",
    title: "Desktop",
    group: experimental_THREAD_CONTEXT_SEGMENT_GROUPS.thread,
    order: 12,
    summary: DesktopPill,
    useVisible: useDesktopPillVisible,
  });

  app.slots.experimental_tab({
    ...DESKTOP_TAB,
    title: "Desktop",
    icon: "ComputerCloud",
    tooltip: "The desktop of this thread's machine",
    layout: "flush",
    useVisible: useDesktopTabVisible,
    component: DesktopTab,
  });

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

  app.composer.customize({
    id: "environment-picker",
    scopes: ["new-thread"],
    actions: [{ id: "environment", component: EnvironmentPickerAction }],
  });

  app.composer.customize({
    id: "open-in-editor-guard",
    scopes: ["thread"],
    actions: [{ id: "open-in-editor-guard", component: OpenInEditorGuard }],
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
