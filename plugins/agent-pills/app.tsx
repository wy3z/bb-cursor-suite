// bb-plugin-agent-pills — Cursor-style subagent pills and composer.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time.
import "@wy3z/bb-suite/tokens.css";
import "@wy3z/bb-suite/settings.css";
import "./app.css";
import { useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_THREAD_CONTEXT_SEGMENT_GROUPS,
} from "@get-bb/plugin-sdk/app";
import { DEVICE_ONLY, SettingsCard, SettingsToggleRow } from "@wy3z/bb-suite/settings";
import { AgentPillsSummary } from "./src/PillRow";
import { ChangesPill, useChanges } from "./src/ChangesPill";
import { useActivity } from "./src/pill-data";
import { CompactPill, useCompactToggleVisible } from "./src/CompactPill";
import {
  applyComposerRestyle,
  readComposerRestyle,
  writeComposerRestyle,
} from "./src/preferences";
import {
  COMPOSER_PREFERENCE_EVENT,
  COMPOSER_PREFERENCE_KEY,
} from "./src/channels";
import {
  startComposerLayout,
  syncComposerLayout,
} from "./src/composer-layout";

/** The segment exists only while it has at least one pill to draw. */
function usePillsVisible({
  threadId,
}: {
  threadId: string;
  projectId: string;
  environment: { id: string } | null;
}): boolean {
  const { activity } = useActivity(threadId);
  return (
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

function ComposerSettings() {
  const [enabled, setEnabled] = useState(readComposerRestyle);

  useEffect(() => {
    const onChange = (event: Event) => {
      setEnabled((event as CustomEvent<boolean>).detail);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === COMPOSER_PREFERENCE_KEY || event.key === null) {
        setEnabled(readComposerRestyle());
      }
    };
    window.addEventListener(COMPOSER_PREFERENCE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(COMPOSER_PREFERENCE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return (
    <SettingsCard>
      <SettingsToggleRow
        label="Cursor-style composer"
        description={`Rounds the prompt box, puts the run controls on one row and makes Send a round arrow. On by default. ${DEVICE_ONLY}`}
        checked={enabled}
        onCheckedChange={(next) => {
          writeComposerRestyle(next);
          setEnabled(next);
        }}
      />
    </SettingsCard>
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
    useVisible: () => useCompactToggleVisible(),
  });

  // Git +/- for the thread's checkout, in BB's git group (after the thread
  // group's pills). BB's own changed-files segment is hidden in app.css.
  app.slots.experimental_threadContextSegment({
    id: "changes",
    title: "Changed files",
    group: experimental_THREAD_CONTEXT_SEGMENT_GROUPS.git,
    order: 10,
    summary: ChangesPill,
    useVisible: (input) => useChanges(input) !== null,
  });

  app.slots.settingsSection({
    id: "composer",
    title: "Composer",
    component: ComposerSettings,
  });

  app.contentScripts.register({
    id: "composer-restyle",
    mount: ({ signal }) => {
      const root = document.documentElement;
      const apply = (on: boolean) => {
        applyComposerRestyle(on, root);
        syncComposerLayout(on);
      };
      apply(readComposerRestyle());

      const onChange = (event: Event) =>
        apply((event as CustomEvent<boolean>).detail);
      const onStorage = (event: StorageEvent) => {
        if (event.key === COMPOSER_PREFERENCE_KEY || event.key === null) {
          apply(readComposerRestyle());
        }
      };

      window.addEventListener(COMPOSER_PREFERENCE_EVENT, onChange);
      window.addEventListener("storage", onStorage);
      const refresh = startComposerLayout(signal);
      window.addEventListener(COMPOSER_PREFERENCE_EVENT, refresh);
      signal.addEventListener("abort", () => {
        window.removeEventListener(COMPOSER_PREFERENCE_EVENT, onChange);
        window.removeEventListener(COMPOSER_PREFERENCE_EVENT, refresh);
        window.removeEventListener("storage", onStorage);
        root.removeAttribute("data-bb-agent-pills-composer");
      });
    },
  });
});
