import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  experimental_Icon as Icon,
  experimental_usePluginId,
  useComposer,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { ProjectIconGlyph } from "@wy3z/bb-suite/project-icon/picker";
import { projectIconColorClass } from "@wy3z/bb-suite/project-icon";
import { useMenuKeyboard } from "@wy3z/bb-suite/menu-keyboard";
import { agentPillsRpcContract } from "../rpc";
import type { ModeOption, StoredModeState } from "./rpc";
import {
  DEFAULT_MODE_ICON,
  cycleMode,
  mentionLabel,
  modeItemId,
  sameMode,
  transitionOf,
  type ModeRef,
  type ModeTransition,
} from "./model";
import { syncModePill, type ModePill } from "./draft";
import { MODE_CHANNEL, MODE_MENTION_PROVIDER } from "./channel";
import { readNewThreadMode, writeNewThreadMode } from "./new-thread-store";
import { modeIconName } from "./icons";

const MENU_WIDTH = 280;
const GAP = 6;
const FILTER_THRESHOLD = 8;
const TOAST_MS = 6000;

interface Workspace {
  projectId: string | null;
  environmentId: string | null;
  providerId: string | null;
}

const optionsCache = new Map<string, ModeOption[]>();

function useModeOptions(workspace: Workspace): ModeOption[] | null {
  const rpc = useRpc<typeof agentPillsRpcContract>();
  const key = workspace.projectId === null ? null : `${workspace.projectId}|${workspace.environmentId ?? ""}|${workspace.providerId ?? ""}`;
  const [options, setOptions] = useState<ModeOption[] | null>(() => (key === null ? null : (optionsCache.get(key) ?? null)));

  useEffect(() => {
    if (key === null || workspace.projectId === null) {
      setOptions(null);
      return;
    }
    setOptions(optionsCache.get(key) ?? null);
    let live = true;
    rpc
      .call("listModes", {
        projectId: workspace.projectId,
        environmentId: workspace.environmentId,
        providerId: workspace.providerId,
      })
      .then((result) => {
        optionsCache.set(key, result.modes);
        if (live) setOptions(result.modes);
      })
      .catch(() => {
        if (live) setOptions((current) => current ?? []);
      });
    return () => {
      live = false;
    };
  }, [key, rpc, workspace.environmentId, workspace.projectId, workspace.providerId]);

  return options;
}

interface ThreadModeData {
  state: StoredModeState;
  workspace: Workspace;
}

const EMPTY_STATE: StoredModeState = { committed: null, draft: null, notice: null };

function useThreadMode(threadId: string | null) {
  const rpc = useRpc<typeof agentPillsRpcContract>();
  const [data, setData] = useState<ThreadModeData | null>(null);
  const request = useRef(0);

  const refresh = useCallback(() => {
    if (threadId === null) return;
    const id = ++request.current;
    rpc
      .call("threadMode", { threadId })
      .then((result) => {
        if (id !== request.current) return;
        setData({
          state: result.state,
          workspace: { projectId: result.projectId, environmentId: result.environmentId, providerId: result.providerId },
        });
      })
      .catch(() => undefined);
  }, [rpc, threadId]);

  useEffect(() => {
    setData(null);
    refresh();
  }, [refresh]);

  useRealtime(MODE_CHANNEL, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) refresh();
  });

  const setDraft = useCallback(
    (mode: ModeRef | null) => {
      if (threadId === null) return;
      request.current += 1;
      setData((current) => (current ? { ...current, state: { ...current.state, draft: mode } } : current));
      rpc
        .call("setThreadMode", { threadId, mode })
        .then((result) => setData((current) => (current ? { ...current, state: result.state } : current)))
        .catch(() => refresh());
    },
    [refresh, rpc, threadId],
  );

  const markSent = useCallback((committed: ModeRef | null) => {
    request.current += 1;
    setData((current) => (current ? { ...current, state: { ...current.state, committed } } : current));
  }, []);

  const clearNotice = useCallback(() => {
    if (threadId === null) return;
    setData((current) => (current ? { ...current, state: { ...current.state, notice: null } } : current));
    rpc.call("clearModeNotice", { threadId }).catch(() => undefined);
  }, [rpc, threadId]);

  return useMemo(() => ({ data, setDraft, markSent, clearNotice }), [clearNotice, data, markSent, setDraft]);
}

function environmentIdOf(environment: unknown): string | null {
  if (environment === null || typeof environment !== "object") return null;
  const value = environment as { type?: unknown; environmentId?: unknown };
  return value.type === "existing" && typeof value.environmentId === "string" ? value.environmentId : null;
}

export function ModeBadge({ option, label }: { option: Pick<ModeOption, "icon" | "color"> | null; label: string }) {
  return (
    <>
      <span className="bb-agent-pills-mode__glyph" aria-hidden="true">
        {option ? (
          <ProjectIconGlyph name={option.icon} className={`bb-agent-pills-mode__svg ${projectIconColorClass(option.color)}`} />
        ) : (
          <Icon name="Sparkles" fallback="Zap" />
        )}
      </span>
      <span className="bb-agent-pills-mode__label">{label}</span>
    </>
  );
}

function placeMenu(trigger: HTMLElement): { top: number; left: number; maxHeight: number } {
  const rect = trigger.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - GAP - 8;
  const above = rect.top - GAP - 8;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8));
  if (below >= 240 || below >= above) return { top: rect.bottom + GAP, left, maxHeight: Math.max(160, below) };
  const height = Math.min(above, 420);
  return { top: Math.max(8, rect.top - GAP - height), left, maxHeight: height };
}

export function ModeMenu({
  options,
  selected,
  choose,
  close,
  position,
}: {
  options: ModeOption[] | null;
  selected: ModeRef | null;
  choose: (mode: ModeRef | null) => void;
  close: () => void;
  position: { top: number; left: number; maxHeight: number };
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  useMenuKeyboard(menuRef, true, close);
  const query = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (options ?? []).filter(
        (option) => query.length === 0 || option.label.toLowerCase().includes(query),
      ),
    [options, query],
  );

  return (
    <div className="bb-agent-pills-env__popover" style={{ top: position.top, left: position.left }}>
      <div
        ref={menuRef}
        className="bb-agent-pills-env__menu bb-agent-pills-mode__menu"
        role="menu"
        aria-label="Select mode"
        style={{ maxHeight: position.maxHeight }}
      >
        {(options?.length ?? 0) > FILTER_THRESHOLD ? (
          <input
            className="bb-agent-pills-mode__filter"
            type="text"
            placeholder="Search modes"
            aria-label="Search modes"
            value={filter}
            autoFocus
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
              } else if (event.key === "Enter" && shown[0]) {
                event.preventDefault();
                choose({ skillId: shown[0].skillId, label: shown[0].label });
              }
            }}
          />
        ) : null}
        <div className="bb-agent-pills-env__section" role="group" aria-label="Mode">
          {query.length === 0 ? (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={selected === null}
              className="bb-agent-pills-env__item"
              onClick={() => choose(null)}
            >
              <span className="bb-agent-pills-env__icon" aria-hidden="true"><Icon name="Circle" fallback="Minus" /></span>
              <span className="bb-agent-pills-env__text"><span className="bb-agent-pills-env__label">None</span></span>
              <span className="bb-agent-pills-env__check" aria-hidden="true">{selected === null ? <Icon name="Check" /> : null}</span>
            </button>
          ) : null}
        </div>
        <div className="bb-agent-pills-env__section" role="group" aria-label="Skills">
          <div className="bb-agent-pills-env__section-title" aria-hidden="true">Skills</div>
          {options === null ? <div className="bb-agent-pills-mode__empty">Loading skills…</div> : null}
          {options !== null && shown.length === 0 ? (
            <div className="bb-agent-pills-mode__empty">{query ? "No matching skills" : "No skills in this thread"}</div>
          ) : null}
          {shown.map((option) => {
            const on = sameMode(selected, option);
            return (
              <button
                key={option.skillId}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                title={option.path}
                className="bb-agent-pills-env__item"
                onClick={() => choose({ skillId: option.skillId, label: option.label })}
              >
                <span className="bb-agent-pills-env__icon" aria-hidden="true">
                  <ProjectIconGlyph name={option.icon} className={`bb-agent-pills-mode__svg ${projectIconColorClass(option.color)}`} />
                </span>
                <span className="bb-agent-pills-env__text">
                  <span className="bb-agent-pills-env__label">{option.label}</span>
                  {option.description ? <span className="bb-agent-pills-env__description">{option.description}</span> : null}
                </span>
                <span className="bb-agent-pills-env__check" aria-hidden="true">{on ? <Icon name="Check" /> : null}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function ModeTrigger({
  active,
  option,
  open,
  onToggle,
  onOpen,
  triggerRef,
}: {
  active: ModeRef | null;
  option: ModeOption | null;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={triggerRef}
      type="button"
      className={`bb-agent-pills-env__trigger bb-agent-pills-mode__trigger${active ? ` ${projectIconColorClass(option?.color ?? "default")}` : ""}`}
      data-active={active ? "" : undefined}
      aria-label={active ? `Mode: ${active.label}` : "Mode: none"}
      aria-haspopup="menu"
      aria-expanded={open}
      title={active ? `${active.label} mode (Shift+Tab to cycle)` : "Choose a mode (Shift+Tab to cycle)"}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {active ? <ModeBadge option={option} label={active.label} /> : <span className="bb-agent-pills-mode__label">Mode</span>}
      <span className="bb-agent-pills-env__chevron" aria-hidden="true"><Icon name="ChevronDown" /></span>
    </button>
  );
}

function ModeToast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [onDone]);
  return createPortal(
    <div className="bb-agent-pills-mode__toast" role="status">
      <span>{message}</span>
      <button type="button" className="bb-agent-pills-mode__toast-close" aria-label="Dismiss" onClick={onDone}>
        <Icon name="X" />
      </button>
    </div>,
    document.body,
  );
}

function useShiftTab(anchor: HTMLElement | null, cycle: () => void) {
  const latest = useRef(cycle);
  latest.current = cycle;
  useEffect(() => {
    const root = anchor?.closest<HTMLElement>("[data-app-composer]");
    if (!root) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (!target?.isContentEditable && target?.tagName !== "TEXTAREA") return;
      event.preventDefault();
      event.stopPropagation();
      latest.current();
    };
    root.addEventListener("keydown", onKey, true);
    return () => root.removeEventListener("keydown", onKey, true);
  }, [anchor]);
}

export function ModeAction() {
  const composer = useComposer();
  const pluginId = experimental_usePluginId();
  const scope = composer.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const thread = useThreadMode(threadId);
  const [newThreadDraft, setNewThreadDraft] = useState<ModeRef | null>(() => readNewThreadMode(composer.key));
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const workspace: Workspace = useMemo(() => {
    if (scope.kind === "new-thread") {
      return {
        projectId: scope.projectId,
        environmentId: environmentIdOf(composer.selection?.environment),
        providerId: composer.selection?.providerId ?? null,
      };
    }
    return thread.data?.workspace ?? { projectId: null, environmentId: null, providerId: null };
  }, [composer.selection?.environment, composer.selection?.providerId, scope, thread.data?.workspace]);

  const options = useModeOptions(workspace);
  const state = scope.kind === "new-thread" ? { committed: null, draft: newThreadDraft, notice: null } : (thread.data?.state ?? EMPTY_STATE);
  const transition: ModeTransition = transitionOf(state);
  const active = state.draft;
  const activeOption = active ? (options?.find((option) => option.skillId === active.skillId) ?? null) : null;

  const choose = useCallback(
    (mode: ModeRef | null) => {
      if (scope.kind === "new-thread") {
        setNewThreadDraft(mode);
        writeNewThreadMode(composer.key, mode);
      } else {
        thread.setDraft(mode);
      }
    },
    [composer.key, scope.kind, thread],
  );

  const ready = scope.kind === "new-thread" || thread.data !== null;
  const shown = transition.kind === "exit" ? transition.exited : transition.kind === "none" ? null : transition.mode;
  const shownOption = shown ? (options?.find((option) => option.skillId === shown.skillId) ?? null) : null;
  const tone = transition.kind === "exit" ? "exit" : (shownOption?.color ?? "default");
  const pillIcon = modeIconName(shownOption?.icon ?? DEFAULT_MODE_ICON);
  const pill: ModePill | null = useMemo(() => {
    if (!ready || transition.kind === "none" || workspace.projectId === null) return null;
    return {
      pluginId,
      provider: MODE_MENTION_PROVIDER,
      id: modeItemId(tone, { transition, projectId: workspace.projectId, environmentId: workspace.environmentId }),
      label: mentionLabel(transition),
      icon: pillIcon,
    };
  }, [pillIcon, pluginId, ready, tone, transition, workspace.environmentId, workspace.projectId]);

  useEffect(() => {
    const next = syncModePill(composer.draft, pill, pluginId, MODE_MENTION_PROVIDER);
    if (next !== null) composer.replace(next);
  }, [composer, composer.draft, pill, pluginId]);

  const committedAfterSend = transition.kind === "none" || transition.kind === "exit" ? null : transition.mode;
  const afterSend = useRef(committedAfterSend);
  afterSend.current = committedAfterSend;
  useEffect(
    () =>
      composer.onSubmitted(() => {
        if (scope.kind === "new-thread") {
          setNewThreadDraft(null);
          writeNewThreadMode(composer.key, null);
        } else {
          thread.markSent(afterSend.current);
        }
      }),
    [composer, scope.kind, thread],
  );

  const notice = thread.data?.state.notice ?? null;
  useEffect(() => {
    if (notice === null) return;
    setToast(notice);
    thread.clearNotice();
  }, [notice, thread]);

  const cycle = useCallback(() => {
    const ring = (options ?? []).map((option) => ({ skillId: option.skillId, label: option.label }));
    choose(cycleMode(ring, active));
  }, [active, choose, options]);
  useShiftTab(anchor, cycle);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const update = () => {
      if (triggerRef.current) setPosition(placeMenu(triggerRef.current));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [open]);

  if (scope.kind !== "thread" && scope.kind !== "new-thread") return null;

  return (
    <span ref={setAnchor} className="bb-agent-pills-mode" data-bb-agent-pills-mode-anchor="">
      <ModeTrigger
        active={active}
        option={activeOption}
        open={open}
        triggerRef={triggerRef}
        onToggle={() => setOpen((value) => !value)}
        onOpen={() => setOpen(true)}
      />
      {open && position
        ? createPortal(
            <div ref={popoverRef} className="bb-agent-pills-env__layer">
              <ModeMenu
                options={options}
                selected={active}
                position={position}
                close={close}
                choose={(mode) => {
                  choose(mode);
                  close();
                  composer.focus();
                }}
              />
            </div>,
            document.body,
          )
        : null}
      {toast ? <ModeToast message={toast} onDone={() => setToast(null)} /> : null}
    </span>
  );
}
