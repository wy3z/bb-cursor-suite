// bb-plugin-agent-pills — Cursor-style subagent pills and composer.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time.
import "./app.css";
import { useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_THREAD_CONTEXT_SEGMENT_GROUPS,
} from "@get-bb/plugin-sdk/app";
import { AgentPillsSummary } from "./src/PillRow";
import { useActivity } from "./src/pill-data";
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
    <div className="bb-agent-pills-settings">
      <label className="bb-agent-pills-settings__row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            writeComposerRestyle(event.currentTarget.checked);
            setEnabled(event.currentTarget.checked);
          }}
        />
        <span className="bb-agent-pills-settings__copy">
          <span className="bb-agent-pills-settings__title">
            Cursor-style composer
          </span>
          <span className="bb-agent-pills-settings__hint">
            Rounds the prompt box, moves the execution controls onto one row and
            turns the send button into a round arrow. Pills stay on either way.
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
