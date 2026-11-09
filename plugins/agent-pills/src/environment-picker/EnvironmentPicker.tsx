import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  experimental_Icon as Icon,
  experimental_ProviderIcon as ProviderIcon,
  useComposer,
  useEnvironmentProviders,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { useMenuKeyboard } from "@wy3z/bb-suite/menu-keyboard";
import {
  CLOUD_DESCRIPTION,
  CLOUD_LEARN_MORE_URL,
  INLINE_WORKTREE_LIMIT,
  MENU_WIDTH,
  WORKTREE_PROVIDER,
  accessibleTriggerLabel,
  buildModel,
  canReplaceBbPicker,
  cloudUnavailableMessage,
  environmentFor,
  hostIdOf,
  isRemoteHost,
  locationOf,
  sameLocation,
  submenuSide,
  triggerLabel,
  worktreeLabel,
  type Location,
  type Machines,
  type PickerModel,
  type PickerProvider,
  type PickerWorktree,
  type ProviderState,
  type TriggerLabel,
} from "./model";
import { REPLACED_ATTRIBUTE, SLOT_ATTRIBUTE, findBbEnvironmentPicker } from "./bb-picker";

const LOAD_TIMEOUT_MS = 5000;

interface PickerData {
  providers: PickerProvider[];
  worktrees: PickerWorktree[];
  machines: Machines;
  hostNames: Record<string, string>;
}

type PickerDataState = { status: "loading" } | { status: "failed" } | { status: "ready"; data: PickerData };

function usePickerData(projectId: string | null): PickerDataState {
  const sdk = useSdk();
  const catalog = useEnvironmentProviders();
  const catalogKey = catalog.providers.map((provider) => `${provider.id}:${provider.machineProviderId ?? ""}`).join("|");
  const [state, setState] = useState<PickerDataState>({ status: "loading" });

  useEffect(() => {
    if (projectId === null) {
      setState({ status: "failed" });
      return;
    }
    setState({ status: "loading" });
    const controller = new AbortController();
    const signal = controller.signal;
    const timer = window.setTimeout(() => {
      controller.abort();
      setState((current) => (current.status === "loading" ? { status: "failed" } : current));
    }, LOAD_TIMEOUT_MS);
    const load = async (): Promise<PickerData> => {
      const [providers, config, hosts] = await Promise.all([
        sdk.environments.listProviders({ projectId, signal }),
        sdk.system.config(),
        sdk.hosts.list({ signal }),
      ]);
      const primaryHostId = config.primaryHostId ?? null;
      const environments = primaryHostId
        ? await sdk.environments
            .list({ projectId, environmentProviderId: WORKTREE_PROVIDER, hostId: primaryHostId, status: "ready", signal })
            .catch(() => [])
        : [];
      return {
        providers: providers as PickerProvider[],
        worktrees: environments
          .filter((environment) => environment.lifecycle.phase === "active")
          .map((environment) => ({
            id: environment.id,
            name: environment.name,
            branchName: environment.branchName,
            path: environment.path,
            updatedAt: environment.updatedAt,
          })),
        machines: {
          primaryHostId,
          connectedHostCount: hosts.filter((host) => host.status === "connected").length,
        },
        hostNames: Object.fromEntries(hosts.map((host) => [host.id, host.name])),
      };
    };
    load()
      .then((data) => {
        if (!signal.aborted) setState({ status: "ready", data });
      })
      .catch(() => {
        if (!signal.aborted) setState({ status: "failed" });
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [sdk, projectId, catalogKey]);

  return state;
}

function useBbPickerSlot(anchor: HTMLElement | null, enabled: boolean): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!enabled || anchor === null) {
      setSlot(null);
      return;
    }
    let current: { slot: HTMLElement; button: HTMLElement } | null = null;
    const release = () => {
      if (current === null) return;
      current.button.removeAttribute(REPLACED_ATTRIBUTE);
      current.slot.remove();
      current = null;
    };
    const sync = () => {
      const found = findBbEnvironmentPicker(anchor);
      if (found === null) {
        if (current !== null) {
          release();
          setSlot(null);
        }
        return;
      }
      if (current !== null && current.button === found.button && current.slot.nextElementSibling === found.button) return;
      release();
      const element = document.createElement("span");
      element.setAttribute(SLOT_ATTRIBUTE, "");
      element.className = "bb-agent-pills-env__slot";
      found.row.insertBefore(element, found.button);
      found.button.setAttribute(REPLACED_ATTRIBUTE, "");
      current = { slot: element, button: found.button };
      setSlot(element);
    };
    sync();
    const root = anchor.closest("[data-app-composer]") ?? document.body;
    const observer = new MutationObserver(() => sync());
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "data-promptbox-project-control"],
    });
    return () => {
      observer.disconnect();
      release();
      setSlot(null);
    };
  }, [anchor, enabled]);

  return slot;
}

function TriggerIcon({ label }: { label: TriggerLabel }) {
  if (label.icon === "laptop") return <Icon name="Laptop" fallback="Monitor" />;
  if (label.icon === "cloud") return <Icon name="Cloud" />;
  if (label.icon === "fork") return <Icon name="GitFork" fallback="GitBranch" />;
  if (label.icon === "server") return <Icon name="Server" fallback="Monitor" />;
  return <ProviderIcon providerKind="environment" provider={{ id: label.providerId ?? "" }} />;
}

function Check({ on }: { on: boolean }) {
  return <span className="bb-agent-pills-env__check" aria-hidden="true">{on ? <Icon name="Check" /> : null}</span>;
}

interface RowProps {
  icon: ReactNode;
  label: string;
  description?: string | null;
  selected?: boolean;
  disabled?: boolean;
  title?: string;
  describedBy?: string;
  onSelect?: (element: HTMLButtonElement) => void;
  trailing?: ReactNode;
  submenu?: { id: string; expanded: boolean };
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

function Row({ icon, label, description, selected, disabled, title, describedBy, onSelect, trailing, submenu, onKeyDown }: RowProps) {
  return (
    <button
      type="button"
      role={selected === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={selected === undefined ? undefined : selected}
      aria-disabled={disabled ? "true" : undefined}
      aria-describedby={describedBy}
      aria-haspopup={submenu ? "menu" : undefined}
      aria-expanded={submenu?.expanded}
      aria-controls={submenu?.id}
      title={title}
      className="bb-agent-pills-env__item"
      data-disabled={disabled ? "" : undefined}
      data-submenu-trigger={submenu ? "" : undefined}
      onClick={disabled || !onSelect ? undefined : (event) => onSelect(event.currentTarget)}
      onKeyDown={onKeyDown}
    >
      <span className="bb-agent-pills-env__icon" aria-hidden="true">{icon}</span>
      <span className="bb-agent-pills-env__text">
        <span className="bb-agent-pills-env__label">{label}</span>
        {description ? <span className="bb-agent-pills-env__description">{description}</span> : null}
      </span>
      {trailing ?? <Check on={selected === true} />}
    </button>
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="bb-agent-pills-env__section" role="group" aria-label={title}>
      {title ? <div className="bb-agent-pills-env__section-title" aria-hidden="true">{title}</div> : null}
      {children}
    </div>
  );
}

function UnavailableCloud({ message }: { message: string }) {
  const noteId = useId();
  return (
    <div className="bb-agent-pills-env__unavailable" role="none">
      <Row icon={<Icon name="Cloud" />} label="Cloud" disabled title={message} describedBy={noteId} />
      <div className="bb-agent-pills-env__note" role="none">
        <span id={noteId}>{message}</span>{" "}
        <a
          role="menuitem"
          href={CLOUD_LEARN_MORE_URL}
          target="_blank"
          rel="noreferrer"
          aria-describedby={noteId}
          className="bb-agent-pills-env__link"
        >
          Learn more
        </a>
      </div>
    </div>
  );
}

function CloudRows({
  model,
  location,
  choose,
}: {
  model: PickerModel;
  location: Location | null;
  choose: (next: Location) => void;
}) {
  const { cloud, cloudUnavailable } = model;
  if (cloudUnavailable !== null) return <UnavailableCloud message={cloudUnavailableMessage(cloudUnavailable)} />;
  if (cloud.length === 1 && cloud[0]!.disabledReason !== null) return <UnavailableCloud message={cloud[0]!.disabledReason} />;
  return (
    <>
      {cloud.map((entry: ProviderState) => {
        const next: Location = { kind: "cloud", providerId: entry.provider.id };
        return (
          <Row
            key={entry.provider.id}
            icon={<Icon name="Cloud" />}
            label="Cloud"
            description={entry.disabledReason ?? (cloud.length > 1 ? entry.provider.displayName : null)}
            title={entry.disabledReason ?? CLOUD_DESCRIPTION}
            selected={sameLocation(location, next)}
            disabled={entry.disabledReason !== null}
            onSelect={() => choose(next)}
          />
        );
      })}
    </>
  );
}

function WorktreeRows({
  worktrees,
  location,
  choose,
}: {
  worktrees: PickerWorktree[];
  location: Location | null;
  choose: (next: Location) => void;
}) {
  return (
    <>
      {worktrees.map((worktree) => {
        const next: Location = { kind: "worktree", environmentId: worktree.id };
        return (
          <Row
            key={worktree.id}
            icon={<Icon name="GitFork" fallback="GitBranch" />}
            label={worktreeLabel(worktree)}
            title={worktree.path ?? undefined}
            selected={sameLocation(location, next)}
            onSelect={() => choose(next)}
          />
        );
      })}
    </>
  );
}

export function PickerMenu({
  model,
  location,
  choose,
  close,
  position,
  viewportWidth,
}: {
  model: PickerModel;
  location: Location | null;
  choose: (next: Location) => void;
  close: () => void;
  position: { top: number; left: number; maxHeight: number };
  viewportWidth?: number;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const subId = useId();
  const [subOpen, setSubOpen] = useState(false);
  const [subTop, setSubTop] = useState(0);
  const side = submenuSide(position.left, viewportWidth ?? (typeof window === "undefined" ? 1280 : window.innerWidth));
  const flyout = side !== "inline";
  useMenuKeyboard(menuRef, true, close);
  useMenuKeyboard(subRef, flyout && subOpen, () => {
    setSubOpen(false);
    moreRef.current?.focus();
  });

  const inlineWorktrees = model.worktrees.length <= INLINE_WORKTREE_LIMIT;
  const hasWorktreeSection = model.worktrees.length > 0 || model.newWorktree !== null || model.others.length > 0;

  const openSub = (button: HTMLButtonElement | null) => {
    moreRef.current = button;
    const menu = menuRef.current;
    if (button && menu) setSubTop(button.getBoundingClientRect().top - menu.getBoundingClientRect().top);
    setSubOpen(true);
  };

  const onPointerOver = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!flyout) return;
    const row = (event.target as Element).closest?.('[role^="menuitem"]');
    if (!row) return;
    if (row.hasAttribute("data-submenu-trigger")) openSub(row as HTMLButtonElement);
    else setSubOpen(false);
  };

  const worktreeMore =
    model.worktrees.length > 0 && !inlineWorktrees ? (
      <Row
        icon={<Icon name="GitFork" fallback="GitBranch" />}
        label="Worktree..."
        submenu={{ id: subId, expanded: subOpen }}
        trailing={
          <span className="bb-agent-pills-env__check" aria-hidden="true">
            <Icon name={flyout ? (side === "left" ? "ChevronLeft" : "ChevronRight") : subOpen ? "ChevronUp" : "ChevronDown"} />
          </span>
        }
        onSelect={(element) => (flyout ? openSub(element) : setSubOpen((open) => !open))}
        onKeyDown={(event) => {
          moreRef.current = event.currentTarget;
          if (!flyout) return;
          const opens = side === "left" ? "ArrowLeft" : "ArrowRight";
          if (event.key === opens) {
            event.preventDefault();
            openSub(event.currentTarget);
          }
        }}
      />
    ) : null;

  return (
    <div className="bb-agent-pills-env__popover" style={{ top: position.top, left: position.left }}>
      <div
        ref={menuRef}
        className="bb-agent-pills-env__menu"
        role="menu"
        aria-label="Select Environment"
        style={{ maxHeight: position.maxHeight }}
        onPointerOver={onPointerOver}
      >
        <Section title="Run on">
          <CloudRows model={model} location={location} choose={choose} />
          {model.local ? (
            <Row
              icon={<Icon name="Laptop" fallback="Monitor" />}
              label="This Computer"
              description={model.local.disabledReason}
              disabled={model.local.disabledReason !== null}
              selected={sameLocation(location, { kind: "local" })}
              onSelect={() => choose({ kind: "local" })}
            />
          ) : null}
        </Section>
        {hasWorktreeSection ? (
          <Section title="Worktrees">
            {model.worktrees.length > 0 && inlineWorktrees ? (
              <WorktreeRows worktrees={model.worktrees} location={location} choose={choose} />
            ) : null}
            {worktreeMore}
            {worktreeMore && !flyout && subOpen ? (
              <div id={subId} className="bb-agent-pills-env__inline-list" role="group" aria-label="Worktrees">
                <WorktreeRows worktrees={model.worktrees} location={location} choose={choose} />
              </div>
            ) : null}
            {model.newWorktree ? (
              <Row
                icon={<Icon name="Plus" />}
                label="New Worktree"
                description={model.newWorktree.disabledReason}
                disabled={model.newWorktree.disabledReason !== null}
                title={model.newWorktree.disabledReason ?? undefined}
                selected={sameLocation(location, { kind: "new-worktree" })}
                onSelect={() => choose({ kind: "new-worktree" })}
              />
            ) : null}
            {model.others.map((entry) => {
              const next: Location = { kind: "provider", providerId: entry.provider.id };
              return (
                <Row
                  key={entry.provider.id}
                  icon={<ProviderIcon providerKind="environment" provider={entry.provider} />}
                  label={entry.provider.displayName}
                  description={entry.disabledReason}
                  title={entry.disabledReason ?? entry.provider.description ?? undefined}
                  disabled={entry.disabledReason !== null}
                  selected={sameLocation(location, next)}
                  onSelect={() => choose(next)}
                />
              );
            })}
          </Section>
        ) : null}
      </div>
      {worktreeMore && flyout && subOpen ? (
        <div
          ref={subRef}
          id={subId}
          className="bb-agent-pills-env__menu bb-agent-pills-env__submenu"
          data-side={side}
          role="menu"
          aria-label="Select worktree"
          style={{ top: subTop, maxHeight: position.maxHeight, width: MENU_WIDTH }}
          onKeyDownCapture={(event) => {
            if (event.key !== "Tab") return;
            event.preventDefault();
            event.stopPropagation();
            setSubOpen(false);
            close();
          }}
          onKeyDown={(event) => {
            const back = side === "left" ? "ArrowRight" : "ArrowLeft";
            if (event.key === back) {
              event.preventDefault();
              setSubOpen(false);
              moreRef.current?.focus();
            }
          }}
        >
          <WorktreeRows worktrees={model.worktrees} location={location} choose={choose} />
        </div>
      ) : null}
    </div>
  );
}

const GAP = 6;

function placeBelow(trigger: HTMLElement): { top: number; left: number; maxHeight: number } {
  const rect = trigger.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const below = viewportHeight - rect.bottom - GAP - 8;
  const above = rect.top - GAP - 8;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8));
  if (below >= 240 || below >= above) return { top: rect.bottom + GAP, left, maxHeight: Math.max(160, below) };
  return { top: Math.max(8, rect.top - GAP - Math.min(above, 440)), left, maxHeight: Math.min(above, 440) };
}

export function EnvironmentPickerControl({
  model,
  location,
  label,
  onChoose,
}: {
  model: PickerModel;
  location: Location | null;
  label: TriggerLabel;
  onChoose: (next: Location) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const update = () => {
      if (triggerRef.current) setPosition(placeBelow(triggerRef.current));
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

  const text = label.detail ? `${label.label}: ${label.detail}` : label.label;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="bb-agent-pills-env__trigger"
        aria-label={accessibleTriggerLabel(label)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Select Environment"
        data-location={location?.kind}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="bb-agent-pills-env__trigger-icon" aria-hidden="true"><TriggerIcon label={label} /></span>
        <span className="bb-agent-pills-env__trigger-label">{text}</span>
        <span className="bb-agent-pills-env__chevron" aria-hidden="true"><Icon name="ChevronDown" /></span>
      </button>
      {open && position
        ? createPortal(
            <div ref={popoverRef} className="bb-agent-pills-env__layer">
              <PickerMenu
                model={model}
                location={location}
                position={position}
                close={close}
                choose={(next) => {
                  onChoose(next);
                  close();
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function EnvironmentPickerAction() {
  const composer = useComposer();
  const catalog = useEnvironmentProviders();
  const projectId = composer.scope.kind === "new-thread" ? composer.scope.projectId : null;
  const environment = composer.selection?.environment;
  const state = usePickerData(projectId);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const data = state.status === "ready" ? state.data : null;
  const model = useMemo(
    () => (data ? buildModel(data.providers, data.worktrees, catalog.providers) : null),
    [data, catalog.providers],
  );
  const location = useMemo(() => locationOf(environment, data?.providers ?? []), [environment, data]);
  const selectedHostId = hostIdOf(environment);
  const personal = location?.kind === "personal";
  const remote = data !== null && isRemoteHost(selectedHostId, data.machines);
  const remoteName = remote && selectedHostId !== null ? (data.hostNames[selectedHostId] ?? "Remote machine") : null;
  const label = model ? triggerLabel(location, model, remoteName) : null;
  const replace = model !== null && label !== null && data !== null && canReplaceBbPicker(selectedHostId, data.machines);
  const holding = state.status === "loading" && environment !== undefined && !personal;
  const slot = useBbPickerSlot(anchor, replace || holding);

  const choose = useCallback(
    (next: Location) => {
      const hostId = data?.machines.primaryHostId ?? (remote ? null : selectedHostId);
      const args = environmentFor(next, hostId);
      if (args === null) return;
      void composer.setSelection({ environment: args }).catch(() => undefined);
    },
    [composer, data, remote, selectedHostId],
  );

  if (composer.scope.kind !== "new-thread") return null;
  const control =
    model !== null && label !== null ? (
      <EnvironmentPickerControl model={model} location={remote ? null : location} label={label} onChoose={choose} />
    ) : null;

  return (
    <span ref={setAnchor} className="bb-agent-pills-env__anchor" data-bb-agent-pills-environment-anchor="">
      {slot !== null ? (replace && control ? createPortal(control, slot) : null) : control}
    </span>
  );
}
