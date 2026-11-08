import { useEffect, useState } from "react";
import {
  UrlLink,
  definePluginApp,
} from "@get-bb/plugin-sdk/app";
import {
  IconPackPreview,
  SpinnerStylePreview,
  registerIconPacks,
} from "./lib/icon-pack.js";
import {
  ICON_PACK_OPTIONS,
  SPINNER_STYLE_OPTIONS,
  normalizeRetiredIconAppearance,
  parseIconPack,
  parseSpinnerStyle,
  type IconPack,
  type SpinnerStyle,
} from "./lib/icon-pack-preference.js";
import {
  PREFERENCES_CHANGE_EVENT as CHANGE_EVENT,
  PREFERENCES_STORAGE_KEY as STORAGE_KEY,
} from "./lib/preferences-storage.js";
import { setMonacoEnhancedTokenizers } from "./lib/monaco-tokenizers.js";
import {
  dispatchWindowTouchCancel,
  forwardOrphanedTouchEnds,
} from "./lib/orphan-touch.js";
import {
  fetchRemotePreferences,
  pushRemotePreferences,
  setPreferencesPluginId,
} from "./lib/preferences-sync.js";
import {
  WORKSPACE_APP_CATEGORIES,
  legacyWorkspaceAppKey,
  parseStoredWorkspaceAppCatalog,
  parseWorkspaceAppsTargetsResponse,
  resolveWorkspaceMenuApps,
  workspaceAppMenuLabel,
  type WorkspaceAppCatalogItem,
  type WorkspaceAppCategory,
} from "./lib/workspace-apps.js";
import {
  createRootOverrides,
  releaseRootOverrides,
  setOwnedAttribute,
  type RootOverrides,
} from "./lib/root-attributes.js";
import "./app.css";

const WORKSPACE_APPS_STORAGE_KEY = "bb-plugin-ui-tweaks.workspace-apps.v3";
const LEGACY_PROMPT_POSITION_KEY = "bb-plugin-prompt-box-position";
const WORKSPACE_APPS_CHANGE_EVENT = "bb:ui-tweaks-workspace-apps-change";
const WORKSPACE_APPS_REFRESH_EVENT = "bb:ui-tweaks-workspace-apps-refresh";
const WORKSPACE_APPS_STATUS_EVENT = "bb:ui-tweaks-workspace-apps-status";
const WORKSPACE_APP_MENU_TRIGGER_LABEL =
  "Choose another app to open workspace";
const CHAT_FILE_OPEN_SUBMENU_TRIGGER_LABEL = "Open in";
const CHAT_FILE_MENU_SIGNATURE_LABELS = [
  "Copy file path",
  "Copy file name",
] as const;
const WORKSPACE_APP_MENU_ITEM_MARKER =
  "data-bb-ui-tweaks-workspace-app-menu-item";
const WORKSPACE_APP_MENU_HIDDEN_MARKER =
  "data-bb-ui-tweaks-workspace-app-menu-hidden";
const PROMPT_CONTAINER_MARKER = "data-bb-ui-tweaks-prompt-container";
const PROMPT_POSITIONS = ["top", "center", "bottom"] as const;
type PromptPosition = (typeof PROMPT_POSITIONS)[number];
const PROMPT_HEIGHTS = ["default", "two-lines", "one-line"] as const;
type PromptHeight = (typeof PROMPT_HEIGHTS)[number];

const WORKSPACE_APP_CATEGORY_OPTIONS = [
  ["default-app", "Default app"],
  ["file-manager", "File managers"],
  ["editor", "Editors & IDEs"],
  ["terminal", "Terminals"],
  ["other", "Other applications"],
] as const satisfies ReadonlyArray<readonly [WorkspaceAppCategory, string]>;

interface Preferences {
  promptPosition: PromptPosition;
  promptHeight: PromptHeight;
  iconPack: IconPack;
  spinnerStyle: SpinnerStyle;
  clearerHierarchy: boolean;
  hideSteerLabels: boolean;
  disableChromeAnimations: boolean;
  editorSyntaxHighlighting: boolean;
  workspaceAppCategories: WorkspaceAppCategory[];
  hiddenWorkspaceApps: string[];
}

type WorkspaceAppDiscoveryStatus =
  | "loading"
  | "ready"
  | "stale"
  | "unavailable"
  | "error";
let workspaceAppDiscoveryStatus: WorkspaceAppDiscoveryStatus = "loading";

const DEFAULT_PREFERENCES: Preferences = {
  promptPosition: "bottom",
  promptHeight: "default",
  iconPack: "default",
  spinnerStyle: "follow",
  clearerHierarchy: true,
  hideSteerLabels: false,
  disableChromeAnimations: false,
  editorSyntaxHighlighting: false,
  workspaceAppCategories: [
    "default-app",
    "file-manager",
    "editor",
    "terminal",
  ],
  hiddenWorkspaceApps: [],
};

interface OwnedTextValue {
  node: Text;
  previous: string;
  written: string;
}

interface OwnedWorkspaceAppMenuIcon {
  category: "editor" | "terminal";
  original: SVGSVGElement;
  replacement: SVGSVGElement;
}

let currentPreferences: Preferences | null = null;
const workspaceAppMenuLabelOverrides = new Map<HTMLElement, OwnedTextValue>();
const workspaceAppMenuIconOverrides = new Map<
  HTMLElement,
  OwnedWorkspaceAppMenuIcon
>();

function isPromptPosition(value: unknown): value is PromptPosition {
  return PROMPT_POSITIONS.includes(value as PromptPosition);
}

function isPromptHeight(value: unknown): value is PromptHeight {
  return PROMPT_HEIGHTS.includes(value as PromptHeight);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((item): item is string => typeof item === "string"),
    ),
  ];
}

function readWorkspaceAppCategories(value: unknown): WorkspaceAppCategory[] {
  if (!Array.isArray(value)) return DEFAULT_PREFERENCES.workspaceAppCategories;
  return [
    ...new Set(
      value.filter((item): item is WorkspaceAppCategory =>
        WORKSPACE_APP_CATEGORIES.includes(item as WorkspaceAppCategory),
      ),
    ),
  ];
}

const RETIRED_PREFERENCE_KEYS = [
  "fontSizeOffset",
  "sectionFontSizes",
  "hideSidebarToggle",
  "hidePanelToggle",
] as const;

/**
 * Remove retired preference keys while copying every other stored field
 * through unchanged. Deleting absent keys is a no-op, so this stays idempotent
 * without a migration marker.
 */
function deleteRetiredPreferences() {
  try {
    window.localStorage.removeItem(
      "bb-plugin-ui-tweaks.show-panel-toggle-migration.v1",
    );

    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) return;
    const value: unknown = JSON.parse(stored);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      return;
    }
    const record = value as Record<string, unknown>;
    const next = { ...record };
    let changed = false;
    for (const key of RETIRED_PREFERENCE_KEYS) {
      if (Object.hasOwn(next, key)) {
        delete next[key];
        changed = true;
      }
    }
    if (normalizeRetiredIconAppearance(next)) changed = true;
    if (changed) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // Storage unreadable or malformed; leave it for the normal defaults path.
  }
}

function readPersistedPreferences(): Preferences {
  deleteRetiredPreferences();

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const value = JSON.parse(stored) as Partial<Preferences>;
      return {
        promptPosition: isPromptPosition(value.promptPosition)
          ? value.promptPosition
          : DEFAULT_PREFERENCES.promptPosition,
        promptHeight: isPromptHeight(value.promptHeight)
          ? value.promptHeight
          : DEFAULT_PREFERENCES.promptHeight,
        iconPack: parseIconPack(value.iconPack),
        spinnerStyle: parseSpinnerStyle(value.spinnerStyle),
        clearerHierarchy: value.clearerHierarchy !== false,
        hideSteerLabels: value.hideSteerLabels === true,
        disableChromeAnimations: value.disableChromeAnimations === true,
        editorSyntaxHighlighting:
          (value.editorSyntaxHighlighting ??
            (value as { editorCssHighlighting?: unknown })
              .editorCssHighlighting) === true,
        workspaceAppCategories: readWorkspaceAppCategories(
          value.workspaceAppCategories,
        ),
        hiddenWorkspaceApps: readStringArray(value.hiddenWorkspaceApps),
      };
    }

    const legacyPromptPosition = window.localStorage.getItem(
      LEGACY_PROMPT_POSITION_KEY,
    );
    if (isPromptPosition(legacyPromptPosition)) {
      return {
        ...DEFAULT_PREFERENCES,
        promptPosition: legacyPromptPosition,
      };
    }
  } catch {
    // Storage can be unavailable in locked-down browser contexts.
  }

  return DEFAULT_PREFERENCES;
}

function getPreferences(): Preferences {
  if (currentPreferences === null) {
    currentPreferences = readPersistedPreferences();
  }
  return currentPreferences;
}

function reloadPersistedPreferences(): Preferences {
  currentPreferences = readPersistedPreferences();
  return currentPreferences;
}

function applyRootPreferences(
  preferences: Preferences,
  overrides: RootOverrides,
  reclaimExternal = false,
) {
  const root = document.documentElement;
  setOwnedAttribute(
    overrides,
    root,
    "data-bb-ui-prompt-position",
    preferences.promptPosition,
    reclaimExternal,
  );
  setOwnedAttribute(
    overrides,
    root,
    "data-bb-ui-prompt-height",
    preferences.promptHeight === "default" ? null : preferences.promptHeight,
    reclaimExternal,
    "private",
  );
  setOwnedAttribute(
    overrides,
    root,
    "data-bb-ui-clearer-hierarchy",
    preferences.clearerHierarchy ? "true" : null,
    reclaimExternal,
    "private",
  );
  setOwnedAttribute(
    overrides,
    root,
    "data-bb-ui-hide-steer-labels",
    preferences.hideSteerLabels ? "true" : null,
    reclaimExternal,
    "private",
  );
  setOwnedAttribute(
    overrides,
    root,
    "data-bb-ui-disable-chrome-animations",
    preferences.disableChromeAnimations ? "true" : null,
    reclaimExternal,
    "private",
  );
}

function applyDynamicDomPreferences(preferences: Preferences) {
  applyPromptContainerMarker();
  applyWorkspaceAppMenuPreferences(preferences);
}

function applyPromptContainerMarker() {
  const prompt = document.getElementById("root-compose-prompt");
  let container = prompt?.parentElement ?? null;

  while (container && container !== document.body) {
    const style = getComputedStyle(container);
    if (style.display === "flex" && style.flexDirection === "column") break;
    container = container.parentElement;
  }

  for (const marked of Array.from(
    document.querySelectorAll<HTMLElement>(`[${PROMPT_CONTAINER_MARKER}]`),
  )) {
    if (marked !== container) marked.removeAttribute(PROMPT_CONTAINER_MARKER);
  }
  if (container && container !== document.body) {
    container.setAttribute(PROMPT_CONTAINER_MARKER, "true");
  }
}

function clearPromptContainerMarker() {
  for (const marked of Array.from(
    document.querySelectorAll<HTMLElement>(`[${PROMPT_CONTAINER_MARKER}]`),
  )) {
    marked.removeAttribute(PROMPT_CONTAINER_MARKER);
  }
}

function applyPreferences(
  preferences: Preferences,
  overrides: RootOverrides,
  reclaimExternal = false,
) {
  applyRootPreferences(preferences, overrides, reclaimExternal);
  applyDynamicDomPreferences(preferences);
  setMonacoEnhancedTokenizers(preferences.editorSyntaxHighlighting);
}

function readWorkspaceAppCatalog(): WorkspaceAppCatalogItem[] {
  try {
    const stored = window.localStorage.getItem(WORKSPACE_APPS_STORAGE_KEY);
    if (!stored) return [];
    return parseStoredWorkspaceAppCatalog(JSON.parse(stored) as unknown);
  } catch {
    return [];
  }
}

function publishWorkspaceAppCatalog(apps: WorkspaceAppCatalogItem[]) {
  const serialized = JSON.stringify(apps);

  try {
    if (window.localStorage.getItem(WORKSPACE_APPS_STORAGE_KEY) === serialized) {
      return;
    }
    window.localStorage.setItem(WORKSPACE_APPS_STORAGE_KEY, serialized);
  } catch {
    // The live event still keeps this client's settings view up to date.
  }

  window.dispatchEvent(
    new CustomEvent<WorkspaceAppCatalogItem[]>(WORKSPACE_APPS_CHANGE_EVENT, {
      detail: apps,
    }),
  );
}

function publishWorkspaceAppDiscoveryStatus(
  status: WorkspaceAppDiscoveryStatus,
) {
  if (workspaceAppDiscoveryStatus === status) return;
  workspaceAppDiscoveryStatus = status;
  window.dispatchEvent(
    new CustomEvent<WorkspaceAppDiscoveryStatus>(WORKSPACE_APPS_STATUS_EVENT, {
      detail: status,
    }),
  );
}

async function fetchWorkspaceAppsFromLocalDaemon(
  signal: AbortSignal,
): Promise<WorkspaceAppCatalogItem[] | null> {
  const configResponse = await fetchWithTimeout(
    "/api/v1/system/config",
    signal,
  );
  if (!configResponse.ok) return null;

  const config = (await configResponse.json()) as unknown;
  if (
    typeof config !== "object" ||
    config === null ||
    !("hostDaemonPort" in config) ||
    typeof config.hostDaemonPort !== "number" ||
    !Number.isInteger(config.hostDaemonPort) ||
    config.hostDaemonPort < 1 ||
    config.hostDaemonPort > 65_535
  ) {
    return null;
  }

  const targetsResponse = await fetchWithTimeout(
    `http://127.0.0.1:${config.hostDaemonPort}/workspace-open-targets`,
    signal,
  );
  if (!targetsResponse.ok) return null;
  return parseWorkspaceAppsTargetsResponse(await targetsResponse.json());
}

type LocalNetworkPermissionName = "loopback-network" | "local-network-access";

async function canProbeLocalHostDaemon(): Promise<boolean> {
  const hostname = window.location.hostname.toLowerCase();
  if (
    "bbDesktop" in window ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  ) {
    return true;
  }

  if (!("permissions" in navigator) || navigator.permissions === undefined) {
    return false;
  }
  const permissions = navigator.permissions as unknown as {
    query(descriptor: {
      name: LocalNetworkPermissionName;
    }): Promise<{ state: PermissionState }>;
  };
  for (const name of [
    "loopback-network",
    "local-network-access",
  ] as const) {
    try {
      return (await permissions.query({ name })).state === "granted";
    } catch {
      // Older Chromium releases may only recognize the other permission name.
    }
  }
  return false;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  lifecycleSignal: AbortSignal,
  timeoutMs = 4_000,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(lifecycleSignal.reason);
  const timeout = window.setTimeout(
    () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
    timeoutMs,
  );
  if (lifecycleSignal.aborted) abort();
  else lifecycleSignal.addEventListener("abort", abort, { once: true });

  try {
    return await fetch(input, { signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
    lifecycleSignal.removeEventListener("abort", abort);
  }
}

function waitForWorkspaceAppDiscoveryRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const finish = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      window.removeEventListener(WORKSPACE_APPS_REFRESH_EVENT, finish);
      resolve();
    };
    const timeout = window.setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    window.addEventListener(WORKSPACE_APPS_REFRESH_EVENT, finish, { once: true });
  });
}

async function populateWorkspaceAppCatalog(signal: AbortSignal) {
  const retryDelays = [0, 500, 2_000, 10_000, 30_000, 60_000];
  let failureCount = 0;
  let nextDelay = 0;

  while (!signal.aborted) {
    if (nextDelay > 0) {
      await waitForWorkspaceAppDiscoveryRetry(nextDelay, signal);
    }
    if (signal.aborted) return;

    if (!(await canProbeLocalHostDaemon())) {
      publishWorkspaceAppDiscoveryStatus("unavailable");
      nextDelay = 60_000;
      continue;
    }

    publishWorkspaceAppDiscoveryStatus(
      readWorkspaceAppCatalog().length > 0 ? "stale" : "loading",
    );
    try {
      const apps = await fetchWorkspaceAppsFromLocalDaemon(signal);
      if (apps !== null) {
        publishWorkspaceAppCatalog(apps);
        publishWorkspaceAppDiscoveryStatus("ready");
        failureCount = 0;
        nextDelay = 5 * 60_000;
        continue;
      }
    } catch {
      if (signal.aborted) return;
    }

    failureCount += 1;
    publishWorkspaceAppDiscoveryStatus(
      readWorkspaceAppCatalog().length > 0 ? "stale" : "error",
    );
    nextDelay = retryDelays[Math.min(failureCount, retryDelays.length - 1)]!;
  }
}

const WORKSPACE_APP_MENU_TRIGGER_SELECTOR =
  `button[aria-label="${WORKSPACE_APP_MENU_TRIGGER_LABEL}"]`;
const CHAT_FILE_OPEN_SUBMENU_TRIGGER_SELECTOR =
  '[role="menuitem"][aria-haspopup="menu"]';

function addControlledMenu(menus: Set<HTMLElement>, trigger: HTMLElement) {
  const controlledId = trigger.getAttribute("aria-controls");
  if (!controlledId) return;
  const menu = document.getElementById(controlledId);
  if (menu?.getAttribute("role") === "menu") menus.add(menu);
}

function isChatFileOpenSubmenuTrigger(trigger: HTMLElement): boolean {
  if (trigger.textContent?.trim() !== CHAT_FILE_OPEN_SUBMENU_TRIGGER_LABEL) {
    return false;
  }

  const parentMenu = trigger.closest<HTMLElement>('[role="menu"]');
  if (!parentMenu) return false;
  const labels = new Set(
    Array.from(parentMenu.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .map((item) => item.textContent?.trim() ?? "")
      .filter(Boolean),
  );
  return CHAT_FILE_MENU_SIGNATURE_LABELS.every((label) => labels.has(label));
}

function findWorkspaceAppMenus(): HTMLElement[] {
  const menus = new Set<HTMLElement>();
  const dropdownTriggers = document.querySelectorAll<HTMLElement>(
    WORKSPACE_APP_MENU_TRIGGER_SELECTOR,
  );

  for (const trigger of Array.from(dropdownTriggers)) {
    addControlledMenu(menus, trigger);
  }

  const chatFileTriggers = document.querySelectorAll<HTMLElement>(
    CHAT_FILE_OPEN_SUBMENU_TRIGGER_SELECTOR,
  );
  for (const trigger of Array.from(chatFileTriggers)) {
    if (!isChatFileOpenSubmenuTrigger(trigger)) continue;
    addControlledMenu(menus, trigger);
  }

  return [...menus];
}

function containsWorkspaceAppMenuTrigger(node: Element): boolean {
  if (
    node.matches(WORKSPACE_APP_MENU_TRIGGER_SELECTOR) ||
    node.querySelector(WORKSPACE_APP_MENU_TRIGGER_SELECTOR) !== null
  ) {
    return true;
  }

  const candidates: HTMLElement[] = [];
  if (node.matches(CHAT_FILE_OPEN_SUBMENU_TRIGGER_SELECTOR)) {
    candidates.push(node as HTMLElement);
  }
  candidates.push(
    ...Array.from(
      node.querySelectorAll<HTMLElement>(
        CHAT_FILE_OPEN_SUBMENU_TRIGGER_SELECTOR,
      ),
    ),
  );
  return candidates.some(isChatFileOpenSubmenuTrigger);
}

function clearWorkspaceAppMenuMarkers() {
  for (const item of [...workspaceAppMenuIconOverrides.keys()]) {
    releaseWorkspaceAppMenuIcon(item);
  }
  for (const item of [...workspaceAppMenuLabelOverrides.keys()]) {
    releaseWorkspaceAppMenuLabel(item);
  }
  for (const item of Array.from(
    document.querySelectorAll<HTMLElement>(
      `[${WORKSPACE_APP_MENU_ITEM_MARKER}]`,
    ),
  )) {
    item.removeAttribute(WORKSPACE_APP_MENU_ITEM_MARKER);
    item.removeAttribute(WORKSPACE_APP_MENU_HIDDEN_MARKER);
  }
}

function releaseWorkspaceAppMenuIcon(item: HTMLElement) {
  const state = workspaceAppMenuIconOverrides.get(item);
  if (!state) return;
  if (item.contains(state.replacement)) {
    state.replacement.replaceWith(state.original);
  }
  workspaceAppMenuIconOverrides.delete(item);
}

function appendWorkspaceAppMenuIconElement(
  icon: SVGSVGElement,
  name: "path" | "rect",
  attributes: Record<string, string>,
) {
  const element = document.createElementNS(
    "http://www.w3.org/2000/svg",
    name,
  );
  for (const [attribute, value] of Object.entries(attributes)) {
    element.setAttribute(attribute, value);
  }
  icon.append(element);
}

function applyWorkspaceAppMenuIcon(
  item: HTMLElement,
  category: WorkspaceAppCategory,
) {
  if (category !== "editor" && category !== "terminal") {
    releaseWorkspaceAppMenuIcon(item);
    return;
  }

  const existing = workspaceAppMenuIconOverrides.get(item);
  if (
    existing?.category === category &&
    item.contains(existing.replacement)
  ) {
    return;
  }
  releaseWorkspaceAppMenuIcon(item);

  const original =
    item.querySelector<SVGSVGElement>(":scope > svg") ??
    item.querySelector<SVGSVGElement>("svg");
  if (!original) return;

  const replacement = original.cloneNode(false) as SVGSVGElement;
  replacement.classList.add("text-muted-foreground");
  replacement.setAttribute("viewBox", "0 0 24 24");
  replacement.setAttribute("fill", "none");
  replacement.setAttribute("stroke", "currentColor");
  replacement.setAttribute("stroke-width", "1.5");
  replacement.setAttribute("stroke-linecap", "round");
  replacement.setAttribute("stroke-linejoin", "round");

  if (category === "editor") {
    appendWorkspaceAppMenuIconElement(replacement, "path", {
      d: "m18 16 4-4-4-4",
    });
    appendWorkspaceAppMenuIconElement(replacement, "path", {
      d: "m6 8-4 4 4 4",
    });
    appendWorkspaceAppMenuIconElement(replacement, "path", {
      d: "m14.5 4-5 16",
    });
  } else {
    appendWorkspaceAppMenuIconElement(replacement, "rect", {
      width: "18",
      height: "18",
      x: "3",
      y: "3",
      rx: "2",
    });
    appendWorkspaceAppMenuIconElement(replacement, "path", {
      d: "m7 8 4 4-4 4",
    });
    appendWorkspaceAppMenuIconElement(replacement, "path", {
      d: "M13 16h4",
    });
  }

  original.replaceWith(replacement);
  workspaceAppMenuIconOverrides.set(item, {
    category,
    original,
    replacement,
  });
}

function releaseWorkspaceAppMenuLabel(item: HTMLElement) {
  const state = workspaceAppMenuLabelOverrides.get(item);
  if (!state) return;
  if (item.contains(state.node) && state.node.data === state.written) {
    state.node.data = state.previous;
  }
  workspaceAppMenuLabelOverrides.delete(item);
}

function trimWorkspaceAppMenuLabel(
  item: HTMLElement,
  app: WorkspaceAppCatalogItem,
) {
  const existing = workspaceAppMenuLabelOverrides.get(item);
  if (
    existing &&
    item.contains(existing.node) &&
    existing.node.data === existing.written
  ) {
    return;
  }
  releaseWorkspaceAppMenuLabel(item);

  const expectedLabel = `Open in ${workspaceAppMenuLabel(app)}`;
  if (item.textContent?.trim() !== expectedLabel) return;

  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    const written = textNode.data.replace(/^(\s*)Open in\s+/u, "$1");
    if (written !== textNode.data) {
      const previous = textNode.data;
      textNode.data = written;
      workspaceAppMenuLabelOverrides.set(item, {
        node: textNode,
        previous,
        written,
      });
      return;
    }
    node = walker.nextNode();
  }
}

function applyWorkspaceAppMenuPreferences(preferences: Preferences) {
  const menus = findWorkspaceAppMenus();
  const seenItems = new Set<HTMLElement>();
  const visibleCategories = new Set(preferences.workspaceAppCategories);
  const hiddenApps = new Set(preferences.hiddenWorkspaceApps);
  const catalog = readWorkspaceAppCatalog();

  for (const menu of menus) {
    const items = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    const resolvedApps = resolveWorkspaceMenuApps(
      items.map((item) => item.textContent?.trim() ?? ""),
      catalog,
    );

    items.forEach((item, index) => {
      const app = resolvedApps[index];
      if (!app) {
        releaseWorkspaceAppMenuIcon(item);
        item.removeAttribute(WORKSPACE_APP_MENU_ITEM_MARKER);
        item.removeAttribute(WORKSPACE_APP_MENU_HIDDEN_MARKER);
        return;
      }

      seenItems.add(item);
      item.setAttribute(WORKSPACE_APP_MENU_ITEM_MARKER, app.key);
      trimWorkspaceAppMenuLabel(item, app);
      applyWorkspaceAppMenuIcon(item, app.category);
      const legacyKey = legacyWorkspaceAppKey(app);

      if (
        visibleCategories.has(app.category) &&
        !hiddenApps.has(app.key) &&
        !hiddenApps.has(legacyKey)
      ) {
        item.removeAttribute(WORKSPACE_APP_MENU_HIDDEN_MARKER);
      } else {
        item.setAttribute(WORKSPACE_APP_MENU_HIDDEN_MARKER, "true");
      }
    });
  }

  for (const item of Array.from(
    document.querySelectorAll<HTMLElement>(
      `[${WORKSPACE_APP_MENU_ITEM_MARKER}]`,
    ),
  )) {
    if (seenItems.has(item)) continue;
    item.removeAttribute(WORKSPACE_APP_MENU_ITEM_MARKER);
    item.removeAttribute(WORKSPACE_APP_MENU_HIDDEN_MARKER);
  }
  for (const item of [...workspaceAppMenuIconOverrides.keys()]) {
    if (!seenItems.has(item)) releaseWorkspaceAppMenuIcon(item);
  }
  for (const item of [...workspaceAppMenuLabelOverrides.keys()]) {
    if (!seenItems.has(item)) releaseWorkspaceAppMenuLabel(item);
  }
}

function savePreferences(preferences: Preferences) {
  currentPreferences = preferences;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Apply the preference for this session even when storage is unavailable.
  }

  window.dispatchEvent(
    new CustomEvent<Preferences>(CHANGE_EVENT, { detail: preferences }),
  );
  pushRemotePreferences(preferences);
}

async function syncRemotePreferences(signal: AbortSignal) {
  let remote: Record<string, unknown> | null;
  try {
    remote = await fetchRemotePreferences();
  } catch {
    return;
  }
  if (signal.aborted) return;

  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }

  if (remote === null) {
    if (stored !== null) pushRemotePreferences(getPreferences());
    return;
  }

  const serialized = JSON.stringify(remote);
  if (serialized === stored) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    return;
  }
  const next = reloadPersistedPreferences();
  window.dispatchEvent(
    new CustomEvent<Preferences>(CHANGE_EVENT, { detail: next }),
  );
}

function usePreferences() {
  const [preferences, setPreferences] = useState(getPreferences);

  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<Preferences>).detail;
      currentPreferences = next;
      setPreferences(next);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        setPreferences(reloadPersistedPreferences());
      }
    };

    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const update = (next: Partial<Preferences>) => {
    const updated = { ...getPreferences(), ...next };
    setPreferences(updated);
    savePreferences(updated);
  };

  return { preferences, update };
}

function ToggleSwitch({
  ariaLabel,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const state = checked ? "checked" : "unchecked";

  return (
    <button
      aria-checked={checked}
      aria-label={ariaLabel}
      className="peer inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input shadow-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-foreground data-[state=unchecked]:bg-muted"
      data-state={state}
      disabled={disabled}
      role="switch"
      type="button"
      onClick={() => onCheckedChange(!checked)}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none block size-3 rounded-full bg-background ring-0 transition-transform data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0"
        data-state={state}
      />
    </button>
  );
}

function IconPackSettings({
  value,
  onChange,
}: {
  value: IconPack;
  onChange: (pack: IconPack) => void;
}) {
  const previews = ["Search", "Folder", "MessageSquare", "Settings"] as const;

  return (
    <fieldset>
      <legend className="text-sm font-medium text-foreground">Icon pack</legend>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Choose the artwork for BB's interface icons. Provider logos and brand
        marks are left alone.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {ICON_PACK_OPTIONS.map((option) => {
          const selected = value === option.id;
          return (
            <label
              key={option.id}
              className={`flex cursor-pointer flex-col gap-2 rounded-md border p-3 focus-within:ring-2 focus-within:ring-ring ${
                selected
                  ? "border-foreground ring-1 ring-foreground"
                  : "border-border hover:bg-muted/50"
              }`}
            >
              <input
                checked={selected}
                className="sr-only"
                name="ui-tweaks-icon-pack"
                type="radio"
                value={option.id}
                onChange={() => onChange(option.id)}
              />
              <span
                aria-hidden="true"
                className="flex items-center gap-2 text-foreground"
              >
                {previews.map((name) => (
                  <IconPackPreview
                    key={name}
                    className="size-4"
                    name={name}
                    pack={option.id}
                  />
                ))}
              </span>
              <span className="text-sm font-medium text-foreground">
                {option.label}
              </span>
              <span className="text-xs text-muted-foreground">
                {option.description}
              </span>
            </label>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Lucide,{" "}
        <UrlLink className="underline" href="https://lucide.dev">
          ISC
        </UrlLink>
        .{" "}
        <UrlLink
          className="underline"
          href="https://github.com/iconoir-icons/iconoir"
        >
          Iconoir
        </UrlLink>{" "}
        and{" "}
        <UrlLink
          className="underline"
          href="https://github.com/tabler/tabler-icons"
        >
          Tabler Icons
        </UrlLink>
        , MIT.
      </p>
    </fieldset>
  );
}

function SpinnerStyleSettings({
  value,
  onChange,
}: {
  value: SpinnerStyle;
  onChange: (style: SpinnerStyle) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-foreground">Spinner</legend>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Choose the spinner for BB's shared loading indicators. Other icons keep
        the main icon pack.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {SPINNER_STYLE_OPTIONS.map((option) => {
          const selected = value === option.id;
          return (
            <label
              key={option.id}
              className={`flex cursor-pointer flex-col gap-2 rounded-md border p-3 focus-within:ring-2 focus-within:ring-ring ${
                selected
                  ? "border-foreground ring-1 ring-foreground"
                  : "border-border hover:bg-muted/50"
              }`}
            >
              <input
                checked={selected}
                className="sr-only"
                name="ui-tweaks-spinner-style"
                type="radio"
                value={option.id}
                onChange={() => onChange(option.id)}
              />
              <span
                aria-hidden="true"
                className="flex h-6 items-center text-foreground"
              >
                <SpinnerStylePreview
                  className="size-5 animate-spin motion-reduce:animate-none"
                  name="Loading"
                  spinnerStyle={option.id}
                />
              </span>
              <span className="text-sm font-medium text-foreground">
                {option.label}
              </span>
              <span className="text-xs text-muted-foreground">
                {option.description}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function InterfaceSettings() {
  const { preferences, update } = usePreferences();
  const [workspaceApps, setWorkspaceApps] = useState(readWorkspaceAppCatalog);
  const [workspaceStatus, setWorkspaceStatus] = useState(
    workspaceAppDiscoveryStatus,
  );
  const [expandedAppCategories, setExpandedAppCategories] = useState<
    WorkspaceAppCategory[]
  >([]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === WORKSPACE_APPS_STORAGE_KEY) {
        setWorkspaceApps(readWorkspaceAppCatalog());
      }
    };
    const onWorkspaceAppsChange = (event: Event) => {
      setWorkspaceApps(
        (event as CustomEvent<WorkspaceAppCatalogItem[]>).detail,
      );
    };
    const onWorkspaceStatusChange = (event: Event) => {
      setWorkspaceStatus(
        (event as CustomEvent<WorkspaceAppDiscoveryStatus>).detail,
      );
    };

    window.addEventListener(WORKSPACE_APPS_CHANGE_EVENT, onWorkspaceAppsChange);
    window.addEventListener(
      WORKSPACE_APPS_STATUS_EVENT,
      onWorkspaceStatusChange,
    );
    window.addEventListener("storage", onStorage);
    // Reconcile after subscribing so a startup discovery that completes
    // between the initial render and this effect cannot be missed.
    setWorkspaceApps(readWorkspaceAppCatalog());
    window.dispatchEvent(new Event(WORKSPACE_APPS_REFRESH_EVENT));
    return () => {
      window.removeEventListener(
        WORKSPACE_APPS_CHANGE_EVENT,
        onWorkspaceAppsChange,
      );
      window.removeEventListener(
        WORKSPACE_APPS_STATUS_EVENT,
        onWorkspaceStatusChange,
      );
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return (
    <div className="space-y-5" data-bb-ui-tweaks-settings="">
      <div className="space-y-5 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            Disable sidebar and panel animations
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Open and close the left sidebar and the right panel instantly
            instead of sliding them.
          </p>
        </div>
        <ToggleSwitch
          ariaLabel="Disable sidebar and panel animations"
          checked={preferences.disableChromeAnimations}
          onCheckedChange={(checked) =>
            update({ disableChromeAnimations: checked })
          }
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            Clearer hierarchy
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Bolder thread titles, slightly larger chat prose, and semibold bold
            text. Other sizes and weights stay put.
          </p>
        </div>
        <ToggleSwitch
          ariaLabel="Clearer hierarchy"
          checked={preferences.clearerHierarchy}
          onCheckedChange={(checked) => update({ clearerHierarchy: checked })}
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            Hide Steer labels in chats
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Drop the Steer tag above messages you sent to steer a running
            agent. Pending and failed steers are hidden too.
          </p>
        </div>
        <ToggleSwitch
          ariaLabel="Hide Steer labels in chats"
          checked={preferences.hideSteerLabels}
          onCheckedChange={(checked) => update({ hideSteerLabels: checked })}
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            Better syntax highlighting in the File Editor
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Teaches Monaco more about CSS, TypeScript and JavaScript:
            functions, constants, operators, built-in types, @media queries
            and selectors get their own colours, closer to Zed and VS Code.
            Your theme still picks the colours.
          </p>
        </div>
        <ToggleSwitch
          ariaLabel="Better syntax highlighting in the File Editor"
          checked={preferences.editorSyntaxHighlighting}
          onCheckedChange={(checked) =>
            update({ editorSyntaxHighlighting: checked })
          }
        />
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_17rem] md:items-center">
        <div>
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="ui-tweaks-prompt-position"
          >
            Prompt box position on new threads
          </label>
          <p
            className="mt-0.5 text-xs text-muted-foreground"
            id="ui-tweaks-prompt-position-description"
          >
            Where the composer appears before a thread starts.
          </p>
        </div>
        <select
          id="ui-tweaks-prompt-position"
          aria-describedby="ui-tweaks-prompt-position-description"
          className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          value={preferences.promptPosition}
          onChange={(event) => {
            const promptPosition = event.target.value;
            if (isPromptPosition(promptPosition)) update({ promptPosition });
          }}
        >
          <option value="top">Top</option>
          <option value="center">Center</option>
          <option value="bottom">Bottom</option>
        </select>
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_17rem] md:items-center">
        <div>
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="ui-tweaks-prompt-height"
          >
            Prompt box starting height
          </label>
          <p
            className="mt-0.5 text-xs text-muted-foreground"
            id="ui-tweaks-prompt-height-description"
          >
            How tall the empty composer is. It still grows as you type.
          </p>
        </div>
        <select
          id="ui-tweaks-prompt-height"
          aria-describedby="ui-tweaks-prompt-height-description"
          className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          value={preferences.promptHeight}
          onChange={(event) => {
            const promptHeight = event.target.value;
            if (isPromptHeight(promptHeight)) update({ promptHeight });
          }}
        >
          <option value="default">Default</option>
          <option value="two-lines">Two lines</option>
          <option value="one-line">One line</option>
        </select>
      </div>
      <IconPackSettings
        value={preferences.iconPack}
        onChange={(iconPack) => update({ iconPack })}
      />
      <SpinnerStyleSettings
        value={preferences.spinnerStyle}
        onChange={(spinnerStyle) => update({ spinnerStyle })}
      />

      </div>

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Open With Filter</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Choose which workspace apps appear in Open With and chat file
            menus.
          </p>
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-card p-1">
          {WORKSPACE_APP_CATEGORY_OPTIONS.map(([category, label]) => {
            const apps = workspaceApps.filter(
              (app) => app.category === category,
            );
            const categoryEnabled =
              preferences.workspaceAppCategories.includes(category);
            const expanded = expandedAppCategories.includes(category);

            return (
              <div key={category}>
                <div className="flex min-h-12 items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-muted/50">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <ToggleSwitch
                      ariaLabel={`${categoryEnabled ? "Hide" : "Show"} ${label}`}
                      checked={categoryEnabled}
                      onCheckedChange={(checked) => {
                        const workspaceAppCategories = new Set(
                          preferences.workspaceAppCategories,
                        );
                        if (checked) {
                          workspaceAppCategories.add(category);
                        } else {
                          workspaceAppCategories.delete(category);
                        }
                        update({
                          workspaceAppCategories: [...workspaceAppCategories],
                        });
                      }}
                    />
                    <span>{label}</span>
                  </div>
                  {apps.length > 0 ? (
                    <button
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
                      className="size-7 rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      type="button"
                      onClick={() => {
                        const next = new Set(expandedAppCategories);
                        if (expanded) next.delete(category);
                        else next.add(category);
                        setExpandedAppCategories([...next]);
                      }}
                    >
                      {expanded ? "▴" : "▾"}
                    </button>
                  ) : null}
                </div>
                {expanded ? (
                  <div className="mx-5 mb-3 space-y-1 border-l border-dashed border-border py-1 pl-3">
                    {apps.map((app) => {
                      const legacyKey = legacyWorkspaceAppKey(app);
                      const appHidden =
                        preferences.hiddenWorkspaceApps.includes(app.key) ||
                        preferences.hiddenWorkspaceApps.includes(legacyKey);
                      return (
                        <div
                          className={`flex min-h-9 items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/50 ${
                            categoryEnabled
                              ? "text-foreground"
                              : "text-muted-foreground"
                          }`}
                          key={app.key}
                        >
                          <ToggleSwitch
                            ariaLabel={`${appHidden ? "Show" : "Hide"} ${app.label}`}
                            checked={categoryEnabled && !appHidden}
                            disabled={!categoryEnabled}
                            onCheckedChange={(checked) => {
                              const hiddenWorkspaceApps = new Set(
                                preferences.hiddenWorkspaceApps,
                              );
                              if (checked) {
                                hiddenWorkspaceApps.delete(app.key);
                                hiddenWorkspaceApps.delete(legacyKey);
                              } else {
                                hiddenWorkspaceApps.add(app.key);
                                hiddenWorkspaceApps.delete(legacyKey);
                              }
                              update({
                                hiddenWorkspaceApps: [...hiddenWorkspaceApps],
                              });
                            }}
                          />
                          <span className="truncate">{app.label}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
          {workspaceApps.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              {workspaceStatus === "ready"
                ? "No compatible applications were discovered."
                : workspaceStatus === "error"
                  ? "Application discovery failed; retrying automatically."
                  : workspaceStatus === "unavailable"
                    ? "Application discovery is unavailable in this BB client."
                    : "Discovering applications…"}
            </p>
          ) : null}
          {workspaceApps.length > 0 && workspaceStatus === "stale" ? (
            <p className="border-t border-border p-3 text-xs text-muted-foreground">
              Showing the last discovered applications while reconnecting.
            </p>
          ) : null}
          {workspaceApps.length > 0 && workspaceStatus === "unavailable" ? (
            <p className="border-t border-border p-3 text-xs text-muted-foreground">
              Showing saved applications; discovery is unavailable in this BB
              client.
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex justify-end">
        <button
          className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground hover:bg-muted"
          type="button"
          onClick={() =>
            update({
              promptPosition: DEFAULT_PREFERENCES.promptPosition,
              promptHeight: DEFAULT_PREFERENCES.promptHeight,
              iconPack: DEFAULT_PREFERENCES.iconPack,
              spinnerStyle: DEFAULT_PREFERENCES.spinnerStyle,
              clearerHierarchy: DEFAULT_PREFERENCES.clearerHierarchy,
              hideSteerLabels: DEFAULT_PREFERENCES.hideSteerLabels,
              disableChromeAnimations: DEFAULT_PREFERENCES.disableChromeAnimations,
              editorSyntaxHighlighting:
                DEFAULT_PREFERENCES.editorSyntaxHighlighting,
              workspaceAppCategories:
                DEFAULT_PREFERENCES.workspaceAppCategories,
              hiddenWorkspaceApps: DEFAULT_PREFERENCES.hiddenWorkspaceApps,
            })
          }
        >
          ↶ Reset to defaults
        </button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  registerIconPacks(app.experimental_icons.register);

  // Alt+1..9 selects the nth tab in the focused surface's right panel,
  // in the order bb's tab strip shows them.
  for (let n = 1; n <= 9; n += 1) {
    app.commands.register({
      id: `panel-tab-${n}`,
      title: `Right panel: switch to tab ${n}`,
      defaultShortcut: { key: String(n), alt: true },
      run: ({ experimental_panel }) => {
        const tab = experimental_panel.getTabs().tabs[n - 1];
        if (tab) experimental_panel.selectTab(tab.key);
      },
    });
  }

  app.slots.settingsSection({
    id: "preferences",
    component: InterfaceSettings,
  });

  app.contentScripts.register({
    id: "orphaned-touch-ends",
    mount: ({ signal }) => {
      forwardOrphanedTouchEnds(document, signal, dispatchWindowTouchCancel);
    },
  });

  app.contentScripts.register({
    id: "apply-preferences",
    mount: ({ signal, pluginId }) => {
      setPreferencesPluginId(pluginId);
      const overrides = createRootOverrides();
      let workspaceAppMenus = findWorkspaceAppMenus();
      let refreshFrame = 0;

      const workspaceObserver = new MutationObserver(() =>
        queueDynamicRefresh(),
      );

      const observeDynamicSurfaces = () => {
        workspaceObserver.disconnect();
        workspaceAppMenus = findWorkspaceAppMenus();
        for (const menu of workspaceAppMenus) {
          workspaceObserver.observe(menu, {
            characterData: true,
            childList: true,
            subtree: true,
          });
        }
      };

      const refreshDynamicSurfaces = () => {
        workspaceObserver.disconnect();
        applyDynamicDomPreferences(getPreferences());
        observeDynamicSurfaces();
      };
      function queueDynamicRefresh() {
        if (refreshFrame !== 0) return;
        refreshFrame = window.requestAnimationFrame(() => {
          refreshFrame = 0;
          if (!signal.aborted) refreshDynamicSurfaces();
        });
      }

      for (const stale of Array.from(
        document.querySelectorAll<HTMLStyleElement>(
          'style[data-bb-ui-tweaks-font-size]',
        ),
      )) {
        stale.remove();
      }
      document.documentElement.removeAttribute(
        "data-bb-ui-hide-sidebar-toggle",
      );
      document.documentElement.removeAttribute(
        "data-bb-ui-hide-panel-toggle",
      );
      applyPreferences(getPreferences(), overrides);
      observeDynamicSurfaces();
      void populateWorkspaceAppCatalog(signal);

      const onChange = (event: Event) => {
        const next = (event as CustomEvent<Preferences>).detail;
        currentPreferences = next;
        workspaceObserver.disconnect();
        applyPreferences(next, overrides, true);
        observeDynamicSurfaces();
      };
      const onStorage = (event: StorageEvent) => {
        if (event.key !== STORAGE_KEY && event.key !== null) return;
        const next = reloadPersistedPreferences();
        workspaceObserver.disconnect();
        applyPreferences(next, overrides, true);
        observeDynamicSurfaces();
      };

      const rootObserver = new MutationObserver((records) => {
        const shouldRefresh = records.some((record) => {
          return [
            ...Array.from(record.addedNodes),
            ...Array.from(record.removedNodes),
          ].some((node) => {
            if (!(node instanceof Element)) return false;
            const currentWorkspaceMenus = findWorkspaceAppMenus();
            return (
              workspaceAppMenus.some(
                (menu) => node === menu || node.contains(menu),
              ) ||
              currentWorkspaceMenus.some(
                (menu) => node === menu || node.contains(menu),
              ) ||
              containsWorkspaceAppMenuTrigger(node) ||
              node.matches("#root-compose-prompt") ||
              node.querySelector("#root-compose-prompt") !== null
            );
          });
        });
        if (shouldRefresh) {
          queueDynamicRefresh();
          window.dispatchEvent(new Event(WORKSPACE_APPS_REFRESH_EVENT));
        }
      });

      rootObserver.observe(document.body, { childList: true, subtree: true });
      // Reconcile once after observers attach to cover host surfaces that mount
      // between the initial application and observer registration.
      queueDynamicRefresh();

      window.addEventListener(CHANGE_EVENT, onChange, { signal });
      window.addEventListener("storage", onStorage, { signal });

      let lastRemoteSync = 0;
      const syncRemote = () => {
        if (document.visibilityState !== "visible") return;
        const now = Date.now();
        if (now - lastRemoteSync < 2000) return;
        lastRemoteSync = now;
        void syncRemotePreferences(signal);
      };
      syncRemote();
      window.addEventListener("focus", syncRemote, { signal });
      document.addEventListener("visibilitychange", syncRemote, { signal });

      return () => {
        rootObserver.disconnect();
        workspaceObserver.disconnect();
        if (refreshFrame !== 0) window.cancelAnimationFrame(refreshFrame);
        clearWorkspaceAppMenuMarkers();
        clearPromptContainerMarker();
        releaseRootOverrides(overrides, document.documentElement);
        setMonacoEnhancedTokenizers(false);
      };
    },
  });
});
