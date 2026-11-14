import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  experimental_Icon as Icon,
  experimental_usePluginId,
  useComposer,
  useRealtime,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { useMenuKeyboard } from "@wy3z/bb-suite/menu-keyboard";
import { agentPillsRpcContract } from "../rpc";
import type { ModeOption, ThreadModeState } from "./rpc";
import {
  cycleMode,
  modeItemId,
  newNonce,
  sameMode,
  type ModeRef,
} from "./model";
import { syncModePill, type ModePill } from "./draft";
import { MODE_CHANNEL, MODE_MENTION_PROVIDER, MODES_CHANNEL } from "./channel";
import { readNewThreadMode, writeNewThreadMode } from "./new-thread-store";
import { DEFAULT_MODE_ICON } from "./icons";
import { createDraftWriter } from "./draft-writer";

const MENU_WIDTH = 280;

function toneClass(color: string): string {
  return `bb-agent-pills-mode-tone-${color}`;
}
const GAP = 6;
const FILTER_THRESHOLD = 8;
const TOAST_MS = 6000;

interface Workspace {
  projectId: string | null;
  environmentId: string | null;
  providerId: string | null;
  excludeUserSkills: boolean;
}

const OPTIONS_STORE_PREFIX = "bb-plugin-agent-pills.modes.v1:";
const optionsCache = new Map<string, ModeOption[]>();

function cachedOptions(key: string): ModeOption[] | null {
  const memory = optionsCache.get(key);
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(OPTIONS_STORE_PREFIX + key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return null;
    const options = parsed.filter(
      (entry): entry is ModeOption =>
        entry !== null && typeof entry === "object" && typeof entry.skillId === "string" && typeof entry.label === "string" && typeof entry.icon === "string",
    );
    optionsCache.set(key, options);
    return options;
  } catch {
    return null;
  }
}

function storeOptions(key: string, options: ModeOption[]): void {
  optionsCache.set(key, options);
  try {
    localStorage.setItem(OPTIONS_STORE_PREFIX + key, JSON.stringify(options));
  } catch {
    return;
  }
}

function useModeOptions(workspace: Workspace): { options: ModeOption[] | null; refresh: () => void } {
  const rpc = useRpc<typeof agentPillsRpcContract>();
  const key =
    workspace.projectId === null
      ? null
      : `${workspace.projectId}|${workspace.environmentId ?? ""}|${workspace.providerId ?? ""}|${workspace.excludeUserSkills ? "remote" : "local"}`;
  const [options, setOptions] = useState<ModeOption[] | null>(() => (key === null ? null : cachedOptions(key)));
  const request = useRef(0);

  const refresh = useCallback(() => {
    if (key === null || workspace.projectId === null) return;
    const id = ++request.current;
    rpc
      .call("listModes", {
        projectId: workspace.projectId,
        environmentId: workspace.environmentId,
        providerId: workspace.providerId,
        excludeUserSkills: workspace.excludeUserSkills,
      })
      .then((result) => {
        storeOptions(key, result.modes);
        if (id === request.current) setOptions(result.modes);
      })
      .catch(() => {
        if (id === request.current) setOptions((current) => current ?? []);
      });
  }, [key, rpc, workspace.environmentId, workspace.excludeUserSkills, workspace.projectId, workspace.providerId]);

  useEffect(() => {
    setOptions(key === null ? null : cachedOptions(key));
    refresh();
  }, [key, refresh]);

  useRealtime(MODES_CHANNEL, (payload) => {
    if ((payload as { projectId?: unknown } | null)?.projectId === workspace.projectId) refresh();
  });

  return { options, refresh };
}

interface ThreadModeData {
  state: ThreadModeState;
  workspace: Omit<Workspace, "excludeUserSkills">;
}

const THREAD_STORE_PREFIX = "bb-plugin-agent-pills.thread-mode.v1:";
const EMPTY_STATE: ThreadModeState = { draft: null, rev: 0, notice: null };

function cachedThreadMode(threadId: string): ThreadModeData | null {
  try {
    const raw = localStorage.getItem(THREAD_STORE_PREFIX + threadId);
    const parsed = raw ? (JSON.parse(raw) as ThreadModeData) : null;
    return parsed && typeof parsed.state === "object" && typeof parsed.workspace === "object" ? { ...parsed, state: { ...parsed.state, notice: null } } : null;
  } catch {
    return null;
  }
}

function storeThreadMode(threadId: string, data: ThreadModeData): void {
  try {
    localStorage.setItem(THREAD_STORE_PREFIX + threadId, JSON.stringify(data));
  } catch {
    return;
  }
}

function useThreadMode(threadId: string | null) {
  const rpc = useRpc<typeof agentPillsRpcContract>();
  const [data, setData] = useState<ThreadModeData | null>(() => (threadId === null ? null : cachedThreadMode(threadId)));
  const [hydrated, setHydrated] = useState(false);
  const [desired, setDesired] = useState<{ mode: ModeRef | null } | null>(null);
  const request = useRef(0);
  const workspaceRef = useRef<ThreadModeData["workspace"] | null>(data?.workspace ?? null);

  const accept = useCallback(
    (next: ThreadModeData) => {
      workspaceRef.current = next.workspace;
      if (threadId !== null) storeThreadMode(threadId, next);
      setData(next);
      setHydrated(true);
    },
    [threadId],
  );

  const writerRef = useRef<ReturnType<typeof createDraftWriter> | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);

  const writer = useMemo(() => {
    if (threadId === null) return null;
    return createDraftWriter({
      write: (mode, rev) => rpc.call("setThreadMode", { threadId, mode, rev }),
      settled: (state) => {
        setDesired(null);
        const workspace = workspaceRef.current;
        if (workspace) accept({ state, workspace });
      },
      failed: () => {
        setDesired(null);
        refreshRef.current();
      },
    });
  }, [accept, rpc, threadId]);
  writerRef.current = writer;

  const refresh = useCallback(() => {
    if (threadId === null) return;
    const id = ++request.current;
    rpc
      .call("threadMode", { threadId })
      .then((result) => {
        if (id !== request.current) return;
        writerRef.current?.know(result.state);
        accept({
          state: result.state,
          workspace: { projectId: result.projectId, environmentId: result.environmentId, providerId: result.providerId },
        });
      })
      .catch(() => undefined);
  }, [accept, rpc, threadId]);
  refreshRef.current = refresh;

  useEffect(() => {
    setData(threadId === null ? null : cachedThreadMode(threadId));
    setHydrated(false);
    setDesired(null);
    refresh();
  }, [refresh, threadId]);

  useRealtime(MODE_CHANNEL, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) refresh();
  });

  const setDraft = useCallback(
    (mode: ModeRef | null) => {
      if (!writer || !hydrated) return;
      setDesired({ mode });
      void writer.choose(mode);
    },
    [hydrated, writer],
  );

  const clearNotice = useCallback(() => {
    if (threadId === null) return;
    setData((current) => (current ? { ...current, state: { ...current.state, notice: null } } : current));
    rpc.call("clearModeNotice", { threadId }).catch(() => undefined);
  }, [rpc, threadId]);

  const shown = useMemo<ThreadModeData | null>(
    () => (data && desired ? { ...data, state: { ...data.state, draft: desired.mode } } : data),
    [data, desired],
  );

  return useMemo(
    () => ({ data: shown, hydrated, writing: desired !== null, setDraft, clearNotice, refresh }),
    [clearNotice, desired, hydrated, refresh, setDraft, shown],
  );
}

interface EnvironmentTarget {
  environmentId: string | null;
  hostId: string | null;
  newMachine: boolean;
}

export function environmentTargetOf(environment: unknown): EnvironmentTarget {
  const none: EnvironmentTarget = { environmentId: null, hostId: null, newMachine: false };
  if (environment === null || typeof environment !== "object") return none;
  const value = environment as {
    type?: unknown;
    environmentId?: unknown;
    hostId?: unknown;
    machine?: { type?: unknown; hostId?: unknown };
  };
  if (value.type === "reuse" && typeof value.environmentId === "string") return { ...none, environmentId: value.environmentId };
  if (value.type === "host") return { ...none, hostId: typeof value.hostId === "string" ? value.hostId : null };
  if (value.type === "provider") {
    if (value.machine?.type === "new") return { ...none, newMachine: true };
    if (value.machine?.type === "existing" && typeof value.machine.hostId === "string") return { ...none, hostId: value.machine.hostId };
  }
  return none;
}

export function isRemoteTarget(target: EnvironmentTarget, primaryHostId: string | null): boolean {
  if (target.newMachine) return true;
  return target.hostId !== null && primaryHostId !== null && target.hostId !== primaryHostId;
}

function usePrimaryHostId(enabled: boolean): string | null {
  const sdk = useSdk();
  const [primary, setPrimary] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    sdk.system
      .config()
      .then((config) => {
        if (live) setPrimary(config.primaryHostId ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, sdk]);
  return primary;
}

export function ModeBadge({ option, label }: { option: Pick<ModeOption, "icon" | "color"> | null; label: string }) {
  return (
    <>
      <span className="bb-agent-pills-mode__glyph" aria-hidden="true">
        {option ? (
          <span className={`bb-agent-pills-mode__svg ${toneClass(option.color)}`}><Icon name={option.icon} fallback={DEFAULT_MODE_ICON} /></span>
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

function OptionGroup({
  title,
  options,
  selected,
  choose,
}: {
  title: string;
  options: ModeOption[];
  selected: ModeRef | null;
  choose: (mode: ModeRef | null) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="bb-agent-pills-env__section" role="group" aria-label={title}>
      <div className="bb-agent-pills-env__section-title" aria-hidden="true">{title}</div>
      {options.map((option) => {
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
              <span className={`bb-agent-pills-mode__svg ${toneClass(option.color)}`}><Icon name={option.icon} fallback={DEFAULT_MODE_ICON} /></span>
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
  );
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
        {options === null ? <div className="bb-agent-pills-mode__empty">Loading skills…</div> : null}
        {options !== null && shown.length === 0 ? (
          <div className="bb-agent-pills-mode__empty">{query ? "No matching skills" : "No skills in this thread"}</div>
        ) : null}
        <OptionGroup title="Modes" options={shown.filter((option) => option.mode)} selected={selected} choose={choose} />
        <OptionGroup title="Skills" options={shown.filter((option) => !option.mode)} selected={selected} choose={choose} />
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
      className={`bb-agent-pills-env__trigger bb-agent-pills-mode__trigger${active ? ` ${toneClass(option?.color ?? "default")}` : ""}`}
      data-active={active ? "" : undefined}
      aria-label={active ? `Mode: ${active.label}` : "Mode: none"}
      aria-haspopup="menu"
      aria-expanded={open}
      title={active ? `${active.label} mode (Shift+Tab cycles modes)` : "Choose a mode (Shift+Tab cycles modes)"}
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

function useSubmitGate(anchor: HTMLElement | null, blocked: boolean) {
  const latest = useRef(blocked);
  latest.current = blocked;
  useEffect(() => {
    const root = anchor?.closest<HTMLElement>("[data-app-composer]");
    if (!root) return;
    const stop = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!latest.current || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      stop(event);
    };
    const onPress = (event: Event) => {
      if (!latest.current) return;
      const target = event.target as Element | null;
      if (target?.closest("[data-promptbox-submit-action], [data-promptbox-send-menu]")) stop(event);
    };
    root.addEventListener("keydown", onKey, true);
    root.addEventListener("click", onPress, true);
    root.addEventListener("pointerdown", onPress, true);
    return () => {
      root.removeEventListener("keydown", onKey, true);
      root.removeEventListener("click", onPress, true);
      root.removeEventListener("pointerdown", onPress, true);
    };
  }, [anchor]);
}

function useShiftTab(anchor: HTMLElement | null, cycle: () => boolean) {
  const latest = useRef(cycle);
  latest.current = cycle;
  useEffect(() => {
    const root = anchor?.closest<HTMLElement>("[data-app-composer]");
    if (!root) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (!target?.isContentEditable && target?.tagName !== "TEXTAREA") return;
      if (!latest.current()) return;
      event.preventDefault();
      event.stopPropagation();
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

  const target = useMemo(() => environmentTargetOf(composer.selection?.environment), [composer.selection?.environment]);
  const primaryHostId = usePrimaryHostId(scope.kind === "new-thread" && (target.hostId !== null || target.newMachine));
  const workspace: Workspace = useMemo(() => {
    if (scope.kind === "new-thread") {
      return {
        projectId: scope.projectId,
        environmentId: target.environmentId,
        providerId: composer.selection?.providerId ?? null,
        excludeUserSkills: isRemoteTarget(target, primaryHostId),
      };
    }
    const known = thread.data?.workspace ?? { projectId: null, environmentId: null, providerId: null };
    return { ...known, excludeUserSkills: false };
  }, [composer.selection?.providerId, primaryHostId, scope, target, thread.data?.workspace]);

  const { options, refresh: refreshOptions } = useModeOptions(workspace);
  const state: ThreadModeState =
    scope.kind === "new-thread" ? { draft: newThreadDraft, rev: 0, notice: null } : (thread.data?.state ?? EMPTY_STATE);
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

  const authoritative = scope.kind === "new-thread" || (thread.hydrated && !thread.writing);
  const [nonce, setNonce] = useState(newNonce);
  const mode = state.draft;
  const modeOption = mode ? (options?.find((option) => sameMode(option, mode)) ?? null) : null;
  const tone = modeOption?.color ?? "default";
  const pillIcon = modeOption?.icon ?? DEFAULT_MODE_ICON;
  const pill: ModePill | null = useMemo(() => {
    if (!authoritative || mode === null || workspace.projectId === null) return null;
    return {
      pluginId,
      provider: MODE_MENTION_PROVIDER,
      id: modeItemId(tone, { mode, rev: state.rev, threadId, projectId: workspace.projectId, environmentId: workspace.environmentId, nonce }),
      label: mode.label,
      icon: pillIcon,
    };
  }, [authoritative, mode, nonce, pillIcon, pluginId, state.rev, threadId, tone, workspace.environmentId, workspace.projectId]);

  const pending = authoritative ? syncModePill(composer.draft, pill, pluginId, MODE_MENTION_PROVIDER) : null;
  useEffect(() => {
    if (pending !== null) composer.replace(pending);
  }, [composer, pending]);

  useSubmitGate(anchor, !authoritative || pending !== null);

  useEffect(
    () =>
      composer.onSubmitted(() => {
        setNonce(newNonce());
        if (scope.kind === "new-thread") {
          setNewThreadDraft(null);
          writeNewThreadMode(composer.key, null);
        }
      }),
    [composer, scope.kind],
  );

  const notice = thread.data?.state.notice ?? null;
  useEffect(() => {
    if (notice === null) return;
    setToast(notice);
    thread.clearNotice();
  }, [notice, thread]);

  const ring = useMemo(
    () => (options ?? []).filter((option) => option.mode).map((option) => ({ skillId: option.skillId, label: option.label })),
    [options],
  );
  const cycle = useCallback(() => {
    if (ring.length === 0 && active === null) return false;
    choose(cycleMode(ring, active));
    return true;
  }, [active, choose, ring]);
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
        onToggle={() => {
          if (!open) refreshOptions();
          setOpen((value) => !value);
        }}
        onOpen={() => {
          refreshOptions();
          setOpen(true);
        }}
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
