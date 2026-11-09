import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon, useSdk, type ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { DESKTOP_FRAME_ALLOW, DESKTOP_RENEW_MS, type DesktopStatus, type DesktopView } from "@wy3z/bb-suite/desktop";
import { CONTROL_LABEL, controlView, preferredTheme, statusMessage, urlExpired, type ControlView } from "./model";
import { callDesktop, desktopClientId, setStatusControl, useDesktopProvider, useDesktopStatus, type DesktopTarget } from "./store";

const HIDDEN_RECONNECT_MS = 30_000;

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

function theme(): "light" | "dark" | null {
  if (typeof document === "undefined") return null;
  const root = document.documentElement;
  return preferredTheme(root, getComputedStyle(root).colorScheme || null);
}

function Notice({ text, action }: { text: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="bb-desktop bb-desktop--empty">
      <p className="bb-desktop__empty" role="status">
        {text}
      </p>
      {action ? (
        <button type="button" className="bb-agent-pills__action" onClick={action.run}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export function useDesktopTabVisible({ environment }: ExperimentalThreadTabProps): boolean {
  return useDesktopProvider(environment?.id) !== null;
}

export function DesktopTab({ threadId, environment }: ExperimentalThreadTabProps) {
  const target = useDesktopProvider(environment?.id);
  const { status, error, loaded, refresh } = useDesktopStatus(threadId, target);
  if (target === null) return <Notice text="This thread's machine has no desktop." />;
  if (!loaded) return <Notice text="Connecting to Desktop…" />;
  if (error || status === null) return <Notice text="Couldn't reach the desktop." action={{ label: "Retry", run: () => void refresh() }} />;
  if (status.state !== "ready") return <Notice text={statusMessage(status)} action={{ label: "Check again", run: () => void refresh() }} />;
  return <DesktopStage threadId={threadId} target={target} status={status} refresh={refresh} />;
}

export function DesktopStage({
  threadId,
  target,
  status,
  refresh,
}: {
  threadId: string;
  target: DesktopTarget;
  status: DesktopStatus;
  refresh: () => Promise<void>;
}) {
  const sdk = useSdk();
  const pluginId = target.provider.pluginId;
  const clientId = desktopClientId();
  const mode: ControlView = controlView(status.control, clientId);
  const [view, setView] = useState<DesktopView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const loadedRef = useRef(false);
  const viewRef = useRef<DesktopView | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const open = useCallback(async () => {
    setViewError(null);
    try {
      const next = await callDesktop(sdk, pluginId, "desktop.view", { threadId, theme: theme() });
      loadedRef.current = false;
      viewRef.current = next;
      setView(next);
      setFrame((value) => value + 1);
    } catch (failure) {
      viewRef.current = null;
      setView(null);
      setViewError(messageOf(failure, "Couldn't open the desktop."));
      void refresh();
    }
  }, [sdk, pluginId, threadId, refresh]);

  useEffect(() => {
    void open();
  }, [open]);

  useEffect(() => {
    if (view === null) return;
    const wait = Math.max(0, view.expiresAt - Date.now());
    const timer = setTimeout(() => {
      if (!loadedRef.current && viewRef.current === view) void open();
    }, wait);
    return () => clearTimeout(timer);
  }, [view, open]);

  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (away >= HIDDEN_RECONNECT_MS && urlExpired(viewRef.current, Date.now())) void open();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [open]);

  const control = useCallback(
    async (action: "take" | "renew" | "release") => {
      const next = await callDesktop(sdk, pluginId, "desktop.control", { threadId, clientId, action });
      setStatusControl(pluginId, threadId, next);
      return controlView(next, clientId);
    },
    [sdk, pluginId, threadId, clientId],
  );

  const take = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      await control("take");
    } catch (failure) {
      setNote(messageOf(failure, "Couldn't take control."));
    } finally {
      setBusy(false);
    }
  }, [control]);

  const release = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      await control("release");
    } catch (failure) {
      setNote(messageOf(failure, "Couldn't release control."));
    } finally {
      setBusy(false);
    }
  }, [control]);

  useEffect(() => {
    if (mode !== "you") return;
    frameRef.current?.focus();
    const timer = setInterval(() => {
      control("renew").then(
        (after) => {
          if (after !== "you") setNote("Control went back to the agent.");
        },
        () => setNote("Couldn't keep control; it goes back to the agent shortly."),
      );
    }, DESKTOP_RENEW_MS);
    return () => clearInterval(timer);
  }, [mode, control]);

  useEffect(
    () => () => {
      if (modeRef.current === "you") void control("release").catch(() => undefined);
    },
    [control],
  );

  const fullscreen = typeof document !== "undefined" && document.fullscreenEnabled === true;
  const live = mode === "you";
  const takeLabel = mode === "elsewhere" ? "Take control here" : "Take Control";

  return (
    <div className="bb-desktop" data-control={mode}>
      <div className="bb-desktop__bar">
        <span className="bb-desktop__holder" data-control={mode} role="status" aria-live="polite">
          <span className="bb-desktop__holder-dot" aria-hidden="true" />
          <span className="bb-desktop__holder-text">{CONTROL_LABEL[mode]}</span>
        </span>
        <div className="bb-desktop__actions">
          {live ? (
            <button type="button" className="bb-agent-pills__action" data-primary="" disabled={busy} onClick={() => void release()}>
              Release control
            </button>
          ) : (
            <button type="button" className="bb-agent-pills__action" data-primary="" disabled={busy || view === null} onClick={() => void take()}>
              {takeLabel}
            </button>
          )}
          <button
            type="button"
            className="bb-desktop__icon"
            aria-label="Reconnect"
            title="Reconnect"
            disabled={busy}
            onClick={() => void open()}
          >
            <Icon name="RotateCcw" aria-hidden />
          </button>
          {fullscreen ? (
            <button
              type="button"
              className="bb-desktop__icon"
              aria-label="Full screen"
              title="Full screen"
              onClick={() => void stageRef.current?.requestFullscreen?.().catch(() => undefined)}
            >
              <Icon name="Maximize2" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
      {live && status.pausesAgent ? <p className="bb-desktop__hint">The agent's computer tools wait until you release control.</p> : null}
      {live && !status.pausesAgent ? <p className="bb-desktop__hint">The agent can still use this desktop while you have control.</p> : null}
      {note ? (
        <p className="bb-desktop__note" role="alert">
          {note}
        </p>
      ) : null}
      <div className="bb-desktop__stage" ref={stageRef}>
        <div className="bb-desktop__screen" data-live={live ? "" : undefined}>
          {view !== null ? (
            <iframe
              key={frame}
              ref={frameRef}
              className="bb-desktop__frame"
              src={view.url}
              title="Desktop"
              allow={DESKTOP_FRAME_ALLOW}
              allowFullScreen
              referrerPolicy="no-referrer"
              inert={!live}
              tabIndex={live ? 0 : -1}
              onLoad={() => {
                loadedRef.current = true;
              }}
            />
          ) : (
            <p className="bb-desktop__connecting" role="status">
              {viewError ?? "Connecting to Desktop…"}
            </p>
          )}
          {!live && view !== null ? (
            <button type="button" className="bb-desktop__take" disabled={busy} onClick={() => void take()}>
              {takeLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
