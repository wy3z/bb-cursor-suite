import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
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
  CLOUD_LEARN_MORE_URL,
  INLINE_WORKTREE_LIMIT,
  WORKTREE_PROVIDER,
  accessibleTriggerLabel,
  buildModel,
  environmentFor,
  hostIdOf,
  locationOf,
  sameLocation,
  triggerLabel,
  worktreeLabel,
  type Location,
  type PickerModel,
  type PickerProvider,
  type PickerWorktree,
  type ProviderState,
  type TriggerLabel,
} from "./model";
import { REPLACED_ATTRIBUTE, SLOT_ATTRIBUTE, findBbEnvironmentPicker } from "./bb-picker";

const CLOUD_DESCRIPTION = "Runs on a cloud machine with a fresh clone of this project.";
const NO_CLOUD_DESCRIPTION = "Install a cloud machine plugin to run agents in the cloud.";

interface PickerData {
  providers: PickerProvider[];
  worktrees: PickerWorktree[];
}

function usePickerData(projectId: string | null): PickerData | null {
  const sdk = useSdk();
  const catalog = useEnvironmentProviders();
  const catalogKey = catalog.providers.map((provider) => `${provider.id}:${provider.machineProviderId ?? ""}`).join("|");
  const [data, setData] = useState<PickerData | null>(null);

  useEffect(() => {
    if (projectId === null) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    void Promise.all([
      sdk.environments.listProviders({ projectId, signal: controller.signal }),
      sdk.environments
        .list({ projectId, environmentProviderId: WORKTREE_PROVIDER, status: "ready", signal: controller.signal })
        .catch(() => []),
    ])
      .then(([providers, environments]) => {
        if (controller.signal.aborted) return;
        setData({
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
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setData(null);
      });
    return () => controller.abort();
  }, [sdk, projectId, catalogKey]);

  return data;
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
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label", "data-promptbox-project-control"] });
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
  return <ProviderIcon providerKind="environment" provider={{ id: label.providerId ?? "" }} />;
}

function Check({ on }: { on: boolean }) {
  return <span className="bb-agent-pills-env__check" aria-hidden="true">{on ? <Icon name="Check" /> : null}</span>;
}

function Row({
  icon,
  label,
  description,
  selected,
  disabled,
  title,
  onSelect,
  trailing,
  expanded,
  onKeyDown,
  onPointerEnter,
}: {
  icon: ReactNode;
  label: string;
  description?: string | null;
  selected?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect?: (element: HTMLButtonElement) => void;
  trailing?: ReactNode;
  expanded?: boolean;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onPointerEnter?: () => void;
}) {
  return (
    <button
      type="button"
      role={selected === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={selected === undefined ? undefined : selected}
      aria-disabled={disabled ? "true" : undefined}
      aria-haspopup={expanded === undefined ? undefined : "menu"}
      aria-expanded={expanded}
      title={title}
      className="bb-agent-pills-env__item"
      data-disabled={disabled ? "" : undefined}
      onClick={disabled || !onSelect ? undefined : (event) => onSelect(event.currentTarget)}
      onKeyDown={onKeyDown}
      onPointerEnter={onPointerEnter}
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

function CloudRows({
  cloud,
  location,
  choose,
}: {
  cloud: ProviderState[];
  location: Location | null;
  choose: (next: Location) => void;
}) {
  if (cloud.length === 0) {
    return (
      <div className="bb-agent-pills-env__unavailable">
        <Row icon={<Icon name="Cloud" />} label="Cloud" disabled title={NO_CLOUD_DESCRIPTION} />
        <p className="bb-agent-pills-env__note">
          {NO_CLOUD_DESCRIPTION}{" "}
          <a role="menuitem" href={CLOUD_LEARN_MORE_URL} target="_blank" rel="noreferrer" className="bb-agent-pills-env__link">
            Learn more
          </a>
        </p>
      </div>
    );
  }
  if (cloud.length === 1) {
    const [only] = cloud;
    const next: Location = { kind: "cloud", providerId: only!.provider.id };
    return (
      <Row
        icon={<Icon name="Cloud" />}
        label="Cloud"
        title={only!.disabledReason ?? CLOUD_DESCRIPTION}
        description={only!.disabledReason}
        selected={sameLocation(location, next)}
        disabled={only!.disabledReason !== null}
        onSelect={() => choose(next)}
      />
    );
  }
  return (
    <>
      {cloud.map((entry) => {
        const next: Location = { kind: "cloud", providerId: entry.provider.id };
        return (
          <Row
            key={entry.provider.id}
            icon={<Icon name="Cloud" />}
            label="Cloud"
            description={entry.disabledReason ?? entry.provider.displayName}
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
}: {
  model: PickerModel;
  location: Location | null;
  choose: (next: Location) => void;
  close: () => void;
  position: { top: number; left: number; maxHeight: number };
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [subOpen, setSubOpen] = useState(false);
  const [subTop, setSubTop] = useState(0);
  useMenuKeyboard(menuRef, true, close);
  useMenuKeyboard(subRef, subOpen, () => {
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

  return (
    <div className="bb-agent-pills-env__popover" style={{ top: position.top, left: position.left }}>
      <div
        ref={menuRef}
        className="bb-agent-pills-env__menu"
        role="menu"
        aria-label="Select Environment"
        style={{ maxHeight: position.maxHeight }}
      >
        <Section title="Run on">
          <CloudRows cloud={model.cloud} location={location} choose={choose} />
          {model.local ? (
            <Row
              icon={<Icon name="Laptop" fallback="Monitor" />}
              label="This Computer"
              description={model.local.disabledReason}
              disabled={model.local.disabledReason !== null}
              selected={sameLocation(location, { kind: "local" })}
              onSelect={() => choose({ kind: "local" })}
              onPointerEnter={() => setSubOpen(false)}
            />
          ) : null}
        </Section>
        {hasWorktreeSection ? (
          <Section title="Worktrees">
            {model.worktrees.length > 0 && inlineWorktrees ? (
              <WorktreeRows worktrees={model.worktrees} location={location} choose={choose} />
            ) : null}
            {model.worktrees.length > 0 && !inlineWorktrees ? (
              <Row
                icon={<Icon name="GitFork" fallback="GitBranch" />}
                label="Worktree..."
                expanded={subOpen}
                trailing={<span className="bb-agent-pills-env__check" aria-hidden="true"><Icon name="ChevronRight" /></span>}
                onSelect={openSub}
                onPointerEnter={() => {
                  const row = menuRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]') ?? null;
                  openSub(row);
                }}
                onKeyDown={(event) => {
                  moreRef.current = event.currentTarget;
                  if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openSub(event.currentTarget);
                  }
                }}
              />
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
                onPointerEnter={() => setSubOpen(false)}
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
                  onPointerEnter={() => setSubOpen(false)}
                />
              );
            })}
          </Section>
        ) : null}
      </div>
      {subOpen ? (
        <div
          ref={subRef}
          className="bb-agent-pills-env__menu bb-agent-pills-env__submenu"
          role="menu"
          aria-label="Select worktree"
          style={{ top: subTop, maxHeight: position.maxHeight }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
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

const MENU_WIDTH = 280;
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
  onChoose,
}: {
  model: PickerModel;
  location: Location | null;
  onChoose: (next: Location) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const label = triggerLabel(location, model);

  const close = useCallback(() => setOpen(false), []);

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

  if (label === null) return null;
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
                  setOpen(false);
                  onChoose(next);
                  triggerRef.current?.focus();
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
  const projectId = composer.scope.kind === "new-thread" ? composer.scope.projectId : null;
  const environment = composer.selection?.environment;
  const data = usePickerData(projectId);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const model = useMemo(() => (data ? buildModel(data.providers, data.worktrees) : null), [data]);
  const location = useMemo(() => locationOf(environment, data?.providers ?? []), [environment, data]);
  const active = model !== null && location !== null && location.kind !== "personal";
  const slot = useBbPickerSlot(anchor, active);

  const choose = useCallback(
    (next: Location) => {
      const args = environmentFor(next, hostIdOf(environment));
      if (args === null) return;
      void composer.setSelection({ environment: args }).catch(() => undefined);
    },
    [composer, environment],
  );

  if (composer.scope.kind !== "new-thread") return null;
  const control = active ? <EnvironmentPickerControl model={model} location={location} onChoose={choose} /> : null;

  return (
    <span ref={setAnchor} className="bb-agent-pills-env__anchor" data-bb-agent-pills-environment-anchor="">
      {slot ? (control ? createPortal(control, slot) : null) : control}
    </span>
  );
}
