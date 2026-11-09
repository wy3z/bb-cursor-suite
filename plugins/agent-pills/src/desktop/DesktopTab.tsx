import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon, type ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import {
  DESKTOP_FRAME_ALLOW,
  DESKTOP_FRAME_SANDBOX,
  DESKTOP_HIDDEN_STOP_MS,
  DESKTOP_RENEW_MS,
  type DesktopStatus,
} from "@wy3z/bb-suite/desktop";
import {
  CONTROL_LABEL,
  controlView,
  lostControlNote,
  preferredTheme,
  shouldRenew,
  statusMessage,
  urlExpired,
  type ControlView,
} from "./model";
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

function crossOriginLoaded(frame: HTMLIFrameElement): boolean {
  try {
    void frame.contentWindow?.location.href;
    return false;
  } catch {
    return true;
  }
}

export function useDesktopTabVisible({ environment }: ExperimentalThreadTabProps): boolean {
  return useDesktopProvider(environment?.id) !== null;
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

export function DesktopTab({ threadId, environment }: ExperimentalThreadTabProps) {
  const target = useDesktopProvider(environment?.id);
  const { status, error, loaded, refresh } = useDesktopStatus(threadId, target);
  if (target === null) return <Notice text="This thread's machine has no desktop." />;
  if (!loaded) return <Notice text="Connecting to Desktop…" />;
  if (error || status === null) return <Notice text="Couldn't reach the desktop." action={{ label: "Retry", run: () => void refresh() }} />;
  if (status.state !== "ready") return <Notice text={statusMessage(status)} action={{ label: "Check again", run: () => void refresh() }} />;
  return <DesktopStage key={`${threadId}:${target.hostId}`} threadId={threadId} target={target} status={status} refresh={refresh} />;
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
  const pluginId = target.provider.pluginId;
  const clientId = desktopClientId();
  const mode: ControlView = controlView(status.control);
  const interactive = status.interactive;
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const pendingRef = useRef<string | null>(null);
  const loadedRef = useRef(false);
  const expiresRef = useRef<number | null>(null);
  const hiddenSinceRef = useRef<number | null>(typeof document !== "undefined" && document.visibilityState === "hidden" ? Date.now() : null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const attachFrame = useCallback((element: HTMLIFrameElement | null) => {
    frameRef.current = element;
    const url = pendingRef.current;
    if (element === null || url === null) return;
    pendingRef.current = null;
    loadedRef.current = false;
    element.contentWindow?.location.replace(url);
  }, []);

  const open = useCallback(async () => {
    setViewError(null);
    try {
      const next = await callDesktop(pluginId, "view", { threadId, theme: theme() });
      pendingRef.current = next.url;
      expiresRef.current = next.expiresAt;
      setExpiresAt(next.expiresAt);
      setFrame((value) => value + 1);
    } catch (failure) {
      pendingRef.current = null;
      expiresRef.current = null;
      setExpiresAt(null);
      setViewError(messageOf(failure, "Couldn't open the desktop."));
      void refresh();
    }
  }, [pluginId, threadId, refresh]);

  useEffect(() => {
    void open();
  }, [open]);

  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(
      () => {
        if (!loadedRef.current && expiresRef.current === expiresAt) void open();
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt, open]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenSinceRef.current ??= Date.now();
        return;
      }
      const away = hiddenSinceRef.current === null ? 0 : Date.now() - hiddenSinceRef.current;
      hiddenSinceRef.current = null;
      void refresh();
      const current = expiresRef.current === null ? null : { expiresAt: expiresRef.current };
      if (away >= HIDDEN_RECONNECT_MS && urlExpired(current, Date.now())) void open();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [open, refresh]);

  const control = useCallback(
    async (action: "take" | "renew" | "release") => {
      const next = await callDesktop(pluginId, "control", { threadId, clientId, action });
      setStatusControl(pluginId, threadId, next);
      return controlView(next);
    },
    [pluginId, threadId, clientId],
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
      if (!shouldRenew(hiddenSinceRef.current, Date.now(), DESKTOP_HIDDEN_STOP_MS)) return;
      control("renew").then(
        (after) => {
          const lost = lostControlNote(after);
          if (lost !== null) setNote(lost);
        },
        (failure) => {
          setNote(messageOf(failure, "Couldn't keep control; it goes back to the agent shortly."));
          void refresh();
        },
      );
    }, DESKTOP_RENEW_MS);
    return () => clearInterval(timer);
  }, [mode, control, refresh]);

  useEffect(
    () => () => {
      if (modeRef.current === "you") void control("release").catch(() => undefined);
    },
    [control],
  );

  const live = interactive && mode === "you";
  const takeLabel = mode === "elsewhere" ? "Take control here" : "Take Control";
  const opened = expiresAt !== null;

  return (
    <div className="bb-desktop" data-control={mode}>
      <div className="bb-desktop__bar">
        <span className="bb-desktop__holder" data-control={mode} role="status" aria-live="polite">
          <span className="bb-desktop__holder-dot" aria-hidden="true" />
          <span className="bb-desktop__holder-text">{interactive ? CONTROL_LABEL[mode] : "View only"}</span>
        </span>
        <div className="bb-desktop__actions">
          {!interactive ? null : live ? (
            <button type="button" className="bb-agent-pills__action" data-primary="" disabled={busy} onClick={() => void release()}>
              Release control
            </button>
          ) : (
            <button type="button" className="bb-agent-pills__action" data-primary="" disabled={busy || !opened} onClick={() => void take()}>
              {takeLabel}
            </button>
          )}
          <button type="button" className="bb-desktop__icon" aria-label="Reconnect" title="Reconnect" disabled={busy} onClick={() => void open()}>
            <Icon name="RotateCcw" aria-hidden />
          </button>
        </div>
      </div>
      {live && status.control.agentPaused ? <p className="bb-desktop__hint">The agent's computer tools wait until you release control.</p> : null}
      {live && !status.control.agentPaused ? <p className="bb-desktop__hint">The agent can still use this desktop while you have control.</p> : null}
      {note ? (
        <p className="bb-desktop__note" role="alert">
          {note}
        </p>
      ) : null}
      <div className="bb-desktop__stage">
        <div className="bb-desktop__screen" data-live={live ? "" : undefined}>
          {opened ? (
            <iframe
              key={frame}
              ref={attachFrame}
              className="bb-desktop__frame"
              title="Desktop"
              sandbox={DESKTOP_FRAME_SANDBOX}
              allow={DESKTOP_FRAME_ALLOW}
              allowFullScreen
              referrerPolicy="no-referrer"
              inert={!live}
              tabIndex={live ? 0 : -1}
              onLoad={(event) => {
                if (crossOriginLoaded(event.currentTarget)) loadedRef.current = true;
              }}
            />
          ) : (
            <p className="bb-desktop__connecting" role="status">
              {viewError ?? "Connecting to Desktop…"}
            </p>
          )}
          {interactive && !live && opened ? (
            <button type="button" className="bb-desktop__take" disabled={busy} onClick={() => void take()}>
              {takeLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
