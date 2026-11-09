import {
  experimental_Icon as Icon,
  experimental_useAppPanel,
  type ExperimentalThreadContextSegmentInput,
} from "@get-bb/plugin-sdk/app";
import { CONTROL_LABEL, DESKTOP_TAB, controlView, pillVisible, type ControlView } from "./model";
import { useDesktopProvider, useDesktopStatus } from "./store";

export function useDesktopPillVisible({ threadId, environment }: ExperimentalThreadContextSegmentInput): boolean {
  const target = useDesktopProvider(environment?.id);
  const { status } = useDesktopStatus(threadId, target);
  return target !== null && pillVisible(status);
}

export function DesktopPillView({ control, onOpen }: { control: ControlView; onOpen: () => void }) {
  const label = control === "agent" ? "Desktop" : `Desktop, ${CONTROL_LABEL[control].toLowerCase()}`;
  return (
    <div className="bb-agent-pills" data-bb-agent-pills="">
      <div className="bb-agent-pills__row">
        <button type="button" className="bb-agent-pills__pill" data-group="desktop" data-control={control} aria-label={label} title={label} onClick={onOpen}>
          <Icon name="ComputerCloud" aria-hidden />
          <span className="bb-agent-pills__label">Desktop</span>
          {control === "agent" ? null : <span className="bb-agent-pills__dot" data-state="control" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

export function DesktopPill({ threadId, environment }: ExperimentalThreadContextSegmentInput) {
  const panel = experimental_useAppPanel();
  const target = useDesktopProvider(environment?.id);
  const { status } = useDesktopStatus(threadId, target);
  if (target === null || !pillVisible(status)) return null;
  return <DesktopPillView control={controlView(status?.control)} onOpen={() => panel.openTab({ tab: DESKTOP_TAB })} />;
}
