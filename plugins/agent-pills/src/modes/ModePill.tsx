import { useMemo } from "react";
import {
  experimental_Icon as Icon,
  experimental_useThreadContextKind,
  useComposer,
  type ExperimentalThreadContextSegmentInput,
} from "@get-bb/plugin-sdk/app";
import { sameMode, type ModeRef } from "./model";
import type { ModeOption } from "./rpc";
import { DEFAULT_MODE_ICON } from "./icons";
import { environmentTargetOf, useModeOptions, type Workspace } from "./ModeControl";
import { setNewThreadMode, useNewThreadMode, useThreadMode } from "./thread-mode";

export function ModePillView({ mode, option, onLeave }: { mode: ModeRef; option: ModeOption | null; onLeave: () => void }) {
  const leave = `Leave ${mode.label} mode`;
  return (
    <div className="bb-agent-pills" data-bb-agent-pills="">
      <div className="bb-agent-pills__row">
        <button
          type="button"
          className={`bb-agent-pills__pill bb-agent-pills-mode__pill bb-agent-pills-mode-tone-${option?.color ?? "default"}`}
          data-group="mode"
          aria-label={`${mode.label} mode. ${leave}`}
          title={leave}
          onClick={onLeave}
        >
          <span className="bb-agent-pills-mode__pill-icon" aria-hidden="true">
            <Icon name={option?.icon ?? DEFAULT_MODE_ICON} fallback={DEFAULT_MODE_ICON} />
          </span>
          <span className="bb-agent-pills__label">{mode.label}</span>
          <span className="bb-agent-pills-mode__pill-x" aria-hidden="true">
            <Icon name="X" fallback="CircleX" />
          </span>
        </button>
      </div>
    </div>
  );
}

function useOptionFor(mode: ModeRef | null, workspace: Workspace): ModeOption | null {
  const { options } = useModeOptions(workspace);
  return useMemo(() => (mode ? (options?.find((option) => sameMode(option, mode)) ?? null) : null), [mode, options]);
}

export function useModePillVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const kind = experimental_useThreadContextKind();
  const thread = useThreadMode(threadId);
  return kind === "banner" && (thread.data?.state.draft ?? null) !== null;
}

export function ModePill({ threadId }: ExperimentalThreadContextSegmentInput) {
  const thread = useThreadMode(threadId);
  const mode = thread.data?.state.draft ?? null;
  const workspace = thread.data?.workspace ?? { projectId: null, environmentId: null, providerId: null };
  const option = useOptionFor(mode, { ...workspace, excludeUserSkills: false });
  if (mode === null) return null;
  return <ModePillView mode={mode} option={option} onLeave={() => thread.setDraft(null)} />;
}

export function NewThreadModeBanner() {
  const composer = useComposer();
  const mode = useNewThreadMode(composer.key);
  const scope = composer.scope;
  const target = environmentTargetOf(composer.selection?.environment);
  const option = useOptionFor(mode, {
    projectId: scope.kind === "new-thread" ? scope.projectId : null,
    environmentId: target.environmentId,
    providerId: composer.selection?.providerId ?? null,
    excludeUserSkills: false,
  });
  if (scope.kind !== "new-thread" || mode === null) return null;
  return <ModePillView mode={mode} option={option} onLeave={() => setNewThreadMode(composer.key, null)} />;
}
