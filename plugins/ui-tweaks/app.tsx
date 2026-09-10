import { useEffect, useRef, useState } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mergeRetainedItems } from "./lib/footer-actions.js";
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
import { mountFontSizeModifier, readFontSizeOffset } from "./lib/font-size.js";
import "./app.css";

const STORAGE_KEY = "bb-plugin-ui-tweaks.preferences.v1";
const FOOTER_ACTIONS_STORAGE_KEY =
  "bb-plugin-ui-tweaks.sidebar-footer-actions.v2";
const LEGACY_FOOTER_ACTIONS_STORAGE_KEY =
  "bb-plugin-ui-tweaks.sidebar-footer-actions.v1";
const WORKSPACE_APPS_STORAGE_KEY = "bb-plugin-ui-tweaks.workspace-apps.v3";
const LEGACY_PROMPT_POSITION_KEY = "bb-plugin-prompt-box-position";
const CHANGE_EVENT = "bb:ui-tweaks-preferences-change";
const FOOTER_ACTIONS_CHANGE_EVENT = "bb:ui-tweaks-footer-actions-change";
const WORKSPACE_APPS_CHANGE_EVENT = "bb:ui-tweaks-workspace-apps-change";
const WORKSPACE_APPS_REFRESH_EVENT = "bb:ui-tweaks-workspace-apps-refresh";
const WORKSPACE_APPS_STATUS_EVENT = "bb:ui-tweaks-workspace-apps-status";
const FOOTER_ACTION_TEST_ID_PREFIX = "plugin-sidebar-footer-action-";
const FOOTER_ACTION_MARKER = "data-bb-ui-tweaks-footer-action";
const FOOTER_ACTION_HIDDEN_MARKER =
  "data-bb-ui-tweaks-footer-action-hidden";
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

const WORKSPACE_APP_CATEGORY_OPTIONS = [
  ["default-app", "Default app"],
  ["file-manager", "File managers"],
  ["editor", "Editors & IDEs"],
  ["terminal", "Terminals"],
  ["other", "Other applications"],
] as const satisfies ReadonlyArray<readonly [WorkspaceAppCategory, string]>;

interface Preferences {
  fontSizeOffset: number;
  promptPosition: PromptPosition;
  workspaceAppCategories: WorkspaceAppCategory[];
  hiddenWorkspaceApps: string[];
  hiddenFooterActions: string[];
}

type FooterActionGlyph =
  | { kind: "mask"; url: string }
  | { kind: "svg"; markup: string };

interface FooterAction {
  key: string;
  label: string;
  glyph: FooterActionGlyph | null;
}

let footerActionCatalogSnapshot: FooterAction[] = [];

type WorkspaceAppDiscoveryStatus =
  | "loading"
  | "ready"
  | "stale"
  | "unavailable"
  | "error";
let workspaceAppDiscoveryStatus: WorkspaceAppDiscoveryStatus = "loading";

const DEFAULT_PREFERENCES: Preferences = {
  fontSizeOffset: 0,
  promptPosition: "bottom",
  workspaceAppCategories: [
    "default-app",
    "file-manager",
    "editor",
    "terminal",
  ],
  hiddenWorkspaceApps: [],
  hiddenFooterActions: [],
};

interface OwnedAttributeValue {
  previous: string | null;
  written: string | null;
}

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

interface RootOverrides {
  attributes: Map<string, OwnedAttributeValue>;
}

let currentPreferences: Preferences | null = null;
const workspaceAppMenuLabelOverrides = new Map<HTMLElement, OwnedTextValue>();
const workspaceAppMenuIconOverrides = new Map<
  HTMLElement,
  OwnedWorkspaceAppMenuIcon
>();

function createRootOverrides(): RootOverrides {
  return { attributes: new Map() };
}

function setOwnedAttribute(
  overrides: RootOverrides,
  attribute: string,
  value: string | null,
  reclaimExternal = false,
) {
  const root = document.documentElement;
  const existing = overrides.attributes.get(attribute);
  const current = root.getAttribute(attribute);

  if (value === null) {
    if (!existing) return;
    if (current === existing.written) {
      if (existing.previous === null) root.removeAttribute(attribute);
      else root.setAttribute(attribute, existing.previous);
    }
    overrides.attributes.delete(attribute);
    return;
  }

  if (!existing) {
    root.setAttribute(attribute, value);
    overrides.attributes.set(attribute, { previous: current, written: value });
    return;
  }
  if (current !== existing.written) {
    if (!reclaimExternal) return;
    existing.previous = current;
  }
  root.setAttribute(attribute, value);
  existing.written = value;
}

function releaseRootOverrides(overrides: RootOverrides) {
  const root = document.documentElement;
  for (const [attribute, state] of overrides.attributes) {
    if (root.getAttribute(attribute) !== state.written) continue;
    if (state.previous === null) root.removeAttribute(attribute);
    else root.setAttribute(attribute, state.previous);
  }
  overrides.attributes.clear();
}

function isPromptPosition(value: unknown): value is PromptPosition {
  return PROMPT_POSITIONS.includes(value as PromptPosition);
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

function readPersistedPreferences(): Preferences {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const value = JSON.parse(stored) as Partial<Preferences>;
      return {
        fontSizeOffset: readFontSizeOffset(value.fontSizeOffset),
        promptPosition: isPromptPosition(value.promptPosition)
          ? value.promptPosition
          : DEFAULT_PREFERENCES.promptPosition,
        workspaceAppCategories: readWorkspaceAppCategories(
          value.workspaceAppCategories,
        ),
        hiddenWorkspaceApps: readStringArray(value.hiddenWorkspaceApps),
        hiddenFooterActions: readStringArray(value.hiddenFooterActions),
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
  setOwnedAttribute(
    overrides,
    "data-bb-ui-prompt-position",
    preferences.promptPosition,
    reclaimExternal,
  );
}

function applyDynamicDomPreferences(preferences: Preferences) {
  applyPromptContainerMarker();
  applyFooterActionPreferences(preferences);
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
}

function readFooterActionCatalog(): FooterAction[] {
  if (footerActionCatalogSnapshot.length > 0) {
    return footerActionCatalogSnapshot;
  }

  try {
    const stored =
      window.localStorage.getItem(FOOTER_ACTIONS_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_FOOTER_ACTIONS_STORAGE_KEY);
    if (!stored) return [];
    const value = JSON.parse(stored) as unknown;
    if (!Array.isArray(value)) return [];

    footerActionCatalogSnapshot = value.flatMap((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        !("key" in item) ||
        !("label" in item) ||
        typeof item.key !== "string" ||
        typeof item.label !== "string"
      ) {
        return [];
      }
      if (
        item.key === "bb:settings" ||
        item.key === "ui-tweaks:layout-switcher"
      ) {
        return [];
      }

      let glyph: FooterActionGlyph | null = null;
      if ("glyph" in item && typeof item.glyph === "object" && item.glyph) {
        if (
          "kind" in item.glyph &&
          item.glyph.kind === "mask" &&
          "url" in item.glyph &&
          typeof item.glyph.url === "string"
        ) {
          const url = readSameOriginAssetUrl(item.glyph.url);
          if (url) glyph = { kind: "mask", url };
        } else if (
          "kind" in item.glyph &&
          item.glyph.kind === "svg" &&
          "markup" in item.glyph &&
          typeof item.glyph.markup === "string"
        ) {
          const svg = sanitizeSvg(item.glyph.markup);
          if (svg) glyph = { kind: "svg", markup: svg.outerHTML };
        }
      }
      return [{ key: item.key, label: item.label, glyph }];
    });
    try {
      window.localStorage.setItem(
        FOOTER_ACTIONS_STORAGE_KEY,
        JSON.stringify(footerActionCatalogSnapshot),
      );
      window.localStorage.removeItem(LEGACY_FOOTER_ACTIONS_STORAGE_KEY);
    } catch {
      // The sanitized in-memory catalog remains usable for this session.
    }
    return footerActionCatalogSnapshot;
  } catch {
    return [];
  }
}

function publishFooterActionCatalog(
  actions: FooterAction[],
  retainMissingKeys: ReadonlySet<string> = new Set(),
) {
  const nextActions = mergeRetainedItems(
    actions,
    readFooterActionCatalog(),
    retainMissingKeys,
  );

  if (
    nextActions.length === footerActionCatalogSnapshot.length &&
    nextActions.every((action, index) => {
      const previous = footerActionCatalogSnapshot[index];
      return (
        previous?.key === action.key &&
        previous.label === action.label &&
        JSON.stringify(previous.glyph) === JSON.stringify(action.glyph)
      );
    })
  ) return;

  footerActionCatalogSnapshot = nextActions;

  try {
    window.localStorage.setItem(
      FOOTER_ACTIONS_STORAGE_KEY,
      JSON.stringify(nextActions),
    );
  } catch {
    // The live event still keeps this client's settings view up to date.
  }

  window.dispatchEvent(
    new CustomEvent<FooterAction[]>(FOOTER_ACTIONS_CHANGE_EVENT, {
      detail: nextActions,
    }),
  );
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

function findSidebarFooterMenu(): HTMLUListElement | null {
  const reportBug = document.querySelector<HTMLElement>(
    '[aria-label="Report a bug"]',
  );
  const menu = reportBug?.closest("ul");

  return menu?.querySelector('[aria-label^="Settings"]') ? menu : null;
}

function readFooterAction(control: HTMLElement): FooterAction | null {
  const testId = control.dataset.testid;
  const ariaLabel = control.getAttribute("aria-label")?.trim() ?? "";
  const glyph = captureFooterActionGlyph(control);

  if (testId?.startsWith(FOOTER_ACTION_TEST_ID_PREFIX)) {
    return {
      key: `plugin:${testId.slice(FOOTER_ACTION_TEST_ID_PREFIX.length)}`,
      label: ariaLabel || "Plugin action",
      glyph,
    };
  }
  if (ariaLabel === "Report a bug") {
    return { key: "bb:report-a-bug", label: "Report a bug", glyph };
  }
  if (ariaLabel === "Settings" || ariaLabel.startsWith("Settings (")) {
    return { key: "bb:settings", label: "Settings", glyph };
  }
  return null;
}

const SAFE_SVG_ELEMENTS = new Set([
  "circle",
  "ellipse",
  "g",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "svg",
]);
const SAFE_SVG_ATTRIBUTES = new Set([
  "aria-hidden",
  "cx",
  "cy",
  "d",
  "fill",
  "fill-opacity",
  "fill-rule",
  "height",
  "points",
  "preserveaspectratio",
  "r",
  "rx",
  "ry",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "transform",
  "viewbox",
  "width",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
]);

function readSameOriginAssetUrl(value: string): string | null {
  if (!value || value.length > 4_096) return null;
  try {
    const url = new URL(value, window.location.href);
    return url.origin === window.location.origin &&
      (url.protocol === "http:" || url.protocol === "https:")
      && url.pathname.startsWith("/api/v1/plugins/")
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function sanitizeSvg(markup: string): SVGSVGElement | null {
  if (!markup || markup.length > 50_000) return null;
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const source = parsed.documentElement;
  if (source.localName !== "svg" || parsed.querySelector("parsererror")) {
    return null;
  }

  for (const element of [source, ...Array.from(source.querySelectorAll("*"))]) {
    if (!SAFE_SVG_ELEMENTS.has(element.localName)) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (
        !SAFE_SVG_ATTRIBUTES.has(name) ||
        /url\s*\(|javascript:|data:/i.test(attribute.value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  source.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return source as unknown as SVGSVGElement;
}

function captureFooterActionGlyph(control: HTMLElement): FooterActionGlyph | null {
  const mask = control.querySelector<HTMLElement>(
    ":scope > [data-plugin-icon-asset]",
  );
  const maskUrl = readSameOriginAssetUrl(mask?.dataset.pluginIconAsset ?? "");
  if (maskUrl) return { kind: "mask", url: maskUrl };

  const svg = control.querySelector<SVGSVGElement>(":scope > svg");
  const sanitized = svg ? sanitizeSvg(svg.outerHTML) : null;
  return sanitized ? { kind: "svg", markup: sanitized.outerHTML } : null;
}

function clearFooterActionMarkers() {
  for (const item of Array.from(
    document.querySelectorAll<HTMLElement>(`[${FOOTER_ACTION_MARKER}]`),
  )) {
    item.removeAttribute(FOOTER_ACTION_MARKER);
    item.removeAttribute(FOOTER_ACTION_HIDDEN_MARKER);
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

function applyFooterActionPreferences(preferences: Preferences) {
  const menu = findSidebarFooterMenu();
  if (!menu) return;

  const hiddenActions = new Set(preferences.hiddenFooterActions);
  const seenItems = new Set<HTMLElement>();
  const actions: FooterAction[] = [];

  for (const child of Array.from(menu.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.getAttribute("aria-hidden") === "true") break;

    const control = child.querySelector<HTMLElement>(
      ":scope > a, :scope > button",
    );
    if (!control) continue;

    const action = readFooterAction(control);
    if (!action) continue;

    if (action.key === "bb:settings") {
      child.removeAttribute(FOOTER_ACTION_MARKER);
      child.removeAttribute(FOOTER_ACTION_HIDDEN_MARKER);
      continue;
    }

    seenItems.add(child);
    actions.push(action);
    child.setAttribute(FOOTER_ACTION_MARKER, action.key);
    if (hiddenActions.has(action.key)) {
      child.setAttribute(FOOTER_ACTION_HIDDEN_MARKER, "true");
    } else {
      child.removeAttribute(FOOTER_ACTION_HIDDEN_MARKER);
    }
  }

  for (const item of Array.from(
    document.querySelectorAll<HTMLElement>(`[${FOOTER_ACTION_MARKER}]`),
  )) {
    if (seenItems.has(item)) continue;
    item.removeAttribute(FOOTER_ACTION_MARKER);
    item.removeAttribute(FOOTER_ACTION_HIDDEN_MARKER);
  }
  publishFooterActionCatalog(actions, hiddenActions);
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
    <div className="space-y-5">
      <div className="space-y-5 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">Global font size</h3>
          <p className="mt-0.5 text-xs text-muted-foreground" id="ui-tweaks-font-description">
            Adjust the active theme’s base font size by 1 pt per press.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2" role="group" aria-label="Global font size" aria-describedby="ui-tweaks-font-description">
          <button type="button" className="size-9 rounded-md border border-border hover:bg-muted disabled:opacity-50"
            aria-label="Decrease font size by 1 pt" disabled={preferences.fontSizeOffset <= -6}
            onClick={() => update({ fontSizeOffset: readFontSizeOffset(getPreferences().fontSizeOffset - 1) })}>−</button>
          <output className="min-w-12 text-center text-sm" aria-live="polite">
            {preferences.fontSizeOffset > 0 ? "+" : ""}{preferences.fontSizeOffset} pt
          </output>
          <button type="button" className="size-9 rounded-md border border-border hover:bg-muted disabled:opacity-50"
            aria-label="Increase font size by 1 pt" disabled={preferences.fontSizeOffset >= 18}
            onClick={() => update({ fontSizeOffset: readFontSizeOffset(getPreferences().fontSizeOffset + 1) })}>+</button>
          <button type="button" className="h-9 rounded-md border border-border px-3 text-sm hover:bg-muted"
            onClick={() => update({ fontSizeOffset: 0 })}>Reset</button>
        </div>
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
              fontSizeOffset: DEFAULT_PREFERENCES.fontSizeOffset,
              promptPosition: DEFAULT_PREFERENCES.promptPosition,
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

function FooterActionGlyphView({ glyph }: { glyph: FooterActionGlyph | null }) {
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();

    if (glyph?.kind === "mask") {
      const assetUrl = readSameOriginAssetUrl(glyph.url);
      if (!assetUrl) return;
      const icon = document.createElement("span");
      icon.className = "inline-block size-5 shrink-0";
      icon.style.backgroundColor = "currentColor";
      icon.style.maskImage = `url("${assetUrl}")`;
      icon.style.maskPosition = "center";
      icon.style.maskRepeat = "no-repeat";
      icon.style.maskSize = "contain";
      icon.style.webkitMaskImage = `url("${assetUrl}")`;
      icon.style.webkitMaskPosition = "center";
      icon.style.webkitMaskRepeat = "no-repeat";
      icon.style.webkitMaskSize = "contain";
      container.append(icon);
    } else if (glyph?.kind === "svg") {
      const source = sanitizeSvg(glyph.markup);
      if (source) {
        const icon = document.importNode(source, true);
        icon.removeAttribute("class");
        icon.removeAttribute("height");
        icon.removeAttribute("width");
        icon.classList.add("size-5", "shrink-0");
        icon.setAttribute("aria-hidden", "true");
        container.append(icon);
      }
    }

    return () => container.replaceChildren();
  }, [glyph]);

  return (
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
      ref={containerRef}
    />
  );
}

function FooterSettings() {
  const { preferences, update } = usePreferences();
  const [footerActions, setFooterActions] = useState(readFooterActionCatalog);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === FOOTER_ACTIONS_STORAGE_KEY ||
        event.key === LEGACY_FOOTER_ACTIONS_STORAGE_KEY
      ) {
        footerActionCatalogSnapshot = [];
        setFooterActions(readFooterActionCatalog());
      }
    };
    const onFooterActionsChange = (event: Event) => {
      setFooterActions((event as CustomEvent<FooterAction[]>).detail);
    };

    window.addEventListener(
      FOOTER_ACTIONS_CHANGE_EVENT,
      onFooterActionsChange,
    );
    window.addEventListener("storage", onStorage);
    setFooterActions(readFooterActionCatalog());
    return () => {
      window.removeEventListener(
        FOOTER_ACTIONS_CHANGE_EVENT,
        onFooterActionsChange,
      );
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Choose which buttons appear at the bottom of the sidebar.
      </p>
      <div
        className="overflow-hidden rounded-lg border border-border bg-card p-1"
        role="list"
      >
        {footerActions.map((action) => (
          <div
            className="flex min-h-12 items-center gap-3 px-3 py-2 text-sm text-foreground hover:bg-muted/50"
            key={action.key}
            role="listitem"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <ToggleSwitch
                ariaLabel={`${
                  preferences.hiddenFooterActions.includes(action.key)
                    ? "Show"
                    : "Hide"
                } ${action.label}`}
                checked={!preferences.hiddenFooterActions.includes(action.key)}
                onCheckedChange={(checked) => {
                  const hiddenFooterActions = new Set(
                    preferences.hiddenFooterActions,
                  );
                  if (checked) {
                    hiddenFooterActions.delete(action.key);
                  } else {
                    hiddenFooterActions.add(action.key);
                  }
                  update({ hiddenFooterActions: [...hiddenFooterActions] });
                }}
              />
              <FooterActionGlyphView glyph={action.glyph} />
              <span className="truncate">{action.label}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <button
          className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground hover:bg-muted"
          type="button"
          onClick={() =>
            update({
              hiddenFooterActions: DEFAULT_PREFERENCES.hiddenFooterActions,
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
  app.slots.settingsSection({
    id: "preferences",
    component: InterfaceSettings,
  });

  app.slots.settingsSection({
    id: "footer-buttons",
    title: "Sidebar Footer",
    component: FooterSettings,
  });

  app.contentScripts.register({
    id: "apply-preferences",
    mount: ({ signal }) => {
      const overrides = createRootOverrides();
      const fontSize = mountFontSizeModifier(() => getPreferences().fontSizeOffset);
      let footerMenu = findSidebarFooterMenu();
      let workspaceAppMenus = findWorkspaceAppMenus();
      let refreshFrame = 0;

      const footerObserver = new MutationObserver(() => queueDynamicRefresh());
      const workspaceObserver = new MutationObserver(() =>
        queueDynamicRefresh(),
      );

      const observeDynamicSurfaces = () => {
        footerObserver.disconnect();
        workspaceObserver.disconnect();
        footerMenu = findSidebarFooterMenu();
        workspaceAppMenus = findWorkspaceAppMenus();
        if (footerMenu) {
          footerObserver.observe(footerMenu, {
            attributes: true,
            attributeFilter: [
              "aria-label",
              "data-plugin-icon-asset",
              "data-testid",
            ],
            characterData: true,
            childList: true,
            subtree: true,
          });
        }
        for (const menu of workspaceAppMenus) {
          workspaceObserver.observe(menu, {
            characterData: true,
            childList: true,
            subtree: true,
          });
        }
      };

      const refreshDynamicSurfaces = () => {
        footerObserver.disconnect();
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

      applyPreferences(getPreferences(), overrides);
      observeDynamicSurfaces();
      void populateWorkspaceAppCatalog(signal);

      const onChange = (event: Event) => {
        const next = (event as CustomEvent<Preferences>).detail;
        currentPreferences = next;
        footerObserver.disconnect();
        workspaceObserver.disconnect();
        applyPreferences(next, overrides, true);
        fontSize.refresh();
        observeDynamicSurfaces();
      };
      const onStorage = (event: StorageEvent) => {
        if (event.key !== STORAGE_KEY && event.key !== null) return;
        const next = reloadPersistedPreferences();
        footerObserver.disconnect();
        workspaceObserver.disconnect();
        applyPreferences(next, overrides, true);
        fontSize.refresh();
        observeDynamicSurfaces();
      };

      const footerControlSelector =
        `[data-testid^="${FOOTER_ACTION_TEST_ID_PREFIX}"], ` +
        '[aria-label="Report a bug"]';
      const rootObserver = new MutationObserver((records) => {
        const shouldRefresh = records.some((record) => {
          return [
            ...Array.from(record.addedNodes),
            ...Array.from(record.removedNodes),
          ].some((node) => {
            if (!(node instanceof Element)) return false;
            const currentWorkspaceMenus = findWorkspaceAppMenus();
            return (
              node === footerMenu ||
              (footerMenu !== null && node.contains(footerMenu)) ||
              workspaceAppMenus.some(
                (menu) => node === menu || node.contains(menu),
              ) ||
              currentWorkspaceMenus.some(
                (menu) => node === menu || node.contains(menu),
              ) ||
              node.matches(footerControlSelector) ||
              node.querySelector(footerControlSelector) !== null ||
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

      return () => {
        rootObserver.disconnect();
        fontSize.dispose();
        footerObserver.disconnect();
        workspaceObserver.disconnect();
        if (refreshFrame !== 0) window.cancelAnimationFrame(refreshFrame);
        clearFooterActionMarkers();
        clearWorkspaceAppMenuMarkers();
        clearPromptContainerMarker();
        releaseRootOverrides(overrides);
      };
    },
  });
});
