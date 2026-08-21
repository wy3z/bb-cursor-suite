import { useEffect, useRef, useState } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mergeRetainedItems } from "./lib/footer-actions.js";
import {
  WORKSPACE_APP_CATEGORIES,
  legacyWorkspaceAppKey,
  parseStoredWorkspaceAppCatalog,
  parseWorkspaceAppsTargetsResponse,
  resolveWorkspaceMenuApps,
  type WorkspaceAppCatalogItem,
  type WorkspaceAppCategory,
} from "./lib/workspace-apps.js";
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
const WORKSPACE_APP_MENU_ITEM_MARKER =
  "data-bb-ui-tweaks-workspace-app-menu-item";
const WORKSPACE_APP_MENU_HIDDEN_MARKER =
  "data-bb-ui-tweaks-workspace-app-menu-hidden";
const PROMPT_CONTAINER_MARKER = "data-bb-ui-tweaks-prompt-container";
const PROMPT_POSITIONS = ["top", "center", "bottom"] as const;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 48;
const CSS_GENERIC_FONT_FAMILIES = new Set([
  "cursive",
  "emoji",
  "fangsong",
  "fantasy",
  "math",
  "monospace",
  "sans-serif",
  "serif",
  "system-ui",
  "ui-monospace",
  "ui-rounded",
  "ui-sans-serif",
  "ui-serif",
]);
const UI_TEXT_TOKENS = {
  "--text-2xs": 10,
  "--text-xs": 12,
  "--text-sm": 13,
  "--text-base": 15,
  "--text-lg": 18,
  "--text-xl": 20,
  "--text-2xl": 24,
  "--text-2xs--line-height": 14,
  "--text-base--line-height": 22,
} as const;
type PromptPosition = (typeof PROMPT_POSITIONS)[number];

const WORKSPACE_APP_CATEGORY_OPTIONS = [
  ["default-app", "Default app"],
  ["file-manager", "File managers"],
  ["editor", "Editors & IDEs"],
  ["terminal", "Terminals"],
  ["other", "Other applications"],
] as const satisfies ReadonlyArray<readonly [WorkspaceAppCategory, string]>;

interface Preferences {
  promptPosition: PromptPosition;
  uiFontFamily: string;
  uiFontSize: number | null;
  codeFontFamily: string;
  codeFontSize: number | null;
  workspaceAppCategories: WorkspaceAppCategory[];
  hiddenWorkspaceApps: string[];
  hiddenFooterActions: string[];
}

interface StoredPreferences extends Partial<Preferences> {
  editorFontFamily?: unknown;
  editorFontSize?: unknown;
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
  promptPosition: "bottom",
  uiFontFamily: "",
  uiFontSize: null,
  codeFontFamily: "",
  codeFontSize: null,
  workspaceAppCategories: [
    "default-app",
    "file-manager",
    "editor",
    "terminal",
  ],
  hiddenWorkspaceApps: [],
  hiddenFooterActions: [],
};

interface InlineStyleValue {
  value: string;
  priority: string;
}

interface OwnedStyleValue {
  previous: InlineStyleValue;
  written: InlineStyleValue;
}

interface OwnedAttributeValue {
  previous: string | null;
  written: string | null;
}

interface RootOverrides {
  styles: Map<string, OwnedStyleValue>;
  attributes: Map<string, OwnedAttributeValue>;
}

let activeRootOverrides: RootOverrides | null = null;
let currentPreferences: Preferences | null = null;

function createRootOverrides(): RootOverrides {
  return { styles: new Map(), attributes: new Map() };
}

function readInlineStyle(property: string): InlineStyleValue {
  const style = document.documentElement.style;
  return {
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority(property),
  };
}

function writeInlineStyle(property: string, next: InlineStyleValue) {
  const style = document.documentElement.style;
  if (next.value) style.setProperty(property, next.value, next.priority);
  else style.removeProperty(property);
}

function inlineStylesEqual(left: InlineStyleValue, right: InlineStyleValue) {
  return left.value === right.value && left.priority === right.priority;
}

function setOwnedStyle(
  overrides: RootOverrides,
  property: string,
  value: string | null,
  reclaimExternal = false,
) {
  const existing = overrides.styles.get(property);
  const current = readInlineStyle(property);

  if (value === null) {
    if (!existing) return;
    if (inlineStylesEqual(current, existing.written)) {
      writeInlineStyle(property, existing.previous);
    }
    overrides.styles.delete(property);
    return;
  }

  const next = { value, priority: "" };
  if (!existing) {
    writeInlineStyle(property, next);
    overrides.styles.set(property, { previous: current, written: next });
    return;
  }

  if (!inlineStylesEqual(current, existing.written)) {
    if (!reclaimExternal) return;
    existing.previous = current;
  }
  writeInlineStyle(property, next);
  existing.written = next;
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
  for (const [property, state] of overrides.styles) {
    if (inlineStylesEqual(readInlineStyle(property), state.written)) {
      writeInlineStyle(property, state.previous);
    }
  }
  overrides.styles.clear();

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

function readFontFamily(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeFontFamily(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const firstCharacter = trimmed.at(0);
  const isQuoted =
    (firstCharacter === '"' || firstCharacter === "'") &&
    trimmed.at(-1) === firstCharacter;
  const isAdvancedValue =
    trimmed.includes(",") || isQuoted || /^var\(.+\)$/.test(trimmed);

  if (
    isAdvancedValue ||
    CSS_GENERIC_FONT_FAMILIES.has(trimmed.toLowerCase())
  ) {
    return trimmed;
  }

  const escaped = trimmed
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\n\r\f]/g, " ");
  return `"${escaped}"`;
}

function readPrimaryFontName(fontStack: string): string {
  const trimmed = fontStack.trim();
  const quote = trimmed.at(0);

  if (quote === '"' || quote === "'") {
    let escaped = false;
    for (let index = 1; index < trimmed.length; index += 1) {
      const character = trimmed[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        return trimmed
          .slice(1, index)
          .replace(/\\(["'\\])/g, "$1");
      }
    }
  }

  return trimmed.split(",", 1)[0]?.trim() ?? "";
}

function readFontSize(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_FONT_SIZE &&
    value <= MAX_FONT_SIZE
    ? value
    : null;
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
      const value = JSON.parse(stored) as StoredPreferences;
      return {
        promptPosition: isPromptPosition(value.promptPosition)
          ? value.promptPosition
          : DEFAULT_PREFERENCES.promptPosition,
        uiFontFamily: readFontFamily(value.uiFontFamily),
        uiFontSize: readFontSize(value.uiFontSize),
        codeFontFamily: readFontFamily(
          value.codeFontFamily ?? value.editorFontFamily,
        ),
        codeFontSize: readFontSize(value.codeFontSize ?? value.editorFontSize),
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

  const uiFontFamily = normalizeFontFamily(preferences.uiFontFamily);
  if (uiFontFamily) {
    const themeUiFontFamily = readThemeFontFamily("--font-sans");
    setOwnedStyle(
      overrides,
      "--font-sans",
      `${uiFontFamily}, ${themeUiFontFamily || "sans-serif"}`,
      reclaimExternal,
    );
  } else {
    setOwnedStyle(overrides, "--font-sans", null);
  }

  if (preferences.uiFontSize === null) {
    setOwnedAttribute(overrides, "data-bb-ui-font-size", null);
    setOwnedStyle(overrides, "--bb-ui-tweaks-ui-font-size", null);
    for (const property of Object.keys(UI_TEXT_TOKENS)) {
      setOwnedStyle(overrides, property, null);
    }
  } else {
    const themeTokenSizes = new Map(
      Object.entries(UI_TEXT_TOKENS).map(([property, fallback]) => [
        property,
        readThemeLengthPixels(property) ?? fallback,
      ]),
    );
    const themeBaseSize =
      themeTokenSizes.get("--text-base") ?? UI_TEXT_TOKENS["--text-base"];
    const scale = preferences.uiFontSize / themeBaseSize;
    setOwnedAttribute(
      overrides,
      "data-bb-ui-font-size",
      "true",
      reclaimExternal,
    );
    setOwnedStyle(
      overrides,
      "--bb-ui-tweaks-ui-font-size",
      `${preferences.uiFontSize}px`,
      reclaimExternal,
    );
    for (const [property, baseSize] of themeTokenSizes) {
      setOwnedStyle(
        overrides,
        property,
        `${baseSize * scale}px`,
        reclaimExternal,
      );
    }
  }

  const codeFontFamily = normalizeFontFamily(preferences.codeFontFamily);
  if (codeFontFamily) {
    const themeCodeFontFamily = readThemeFontFamily("--font-mono");
    setOwnedStyle(
      overrides,
      "--font-mono",
      `${codeFontFamily}, ${themeCodeFontFamily || "monospace"}`,
      reclaimExternal,
    );
  } else {
    setOwnedStyle(overrides, "--font-mono", null);
  }

  if (preferences.codeFontSize === null) {
    setOwnedAttribute(overrides, "data-bb-ui-code-font-size", null);
    setOwnedStyle(overrides, "--bb-ui-tweaks-code-font-size", null);
  } else {
    setOwnedAttribute(
      overrides,
      "data-bb-ui-code-font-size",
      "true",
      reclaimExternal,
    );
    setOwnedStyle(
      overrides,
      "--bb-ui-tweaks-code-font-size",
      `${preferences.codeFontSize}px`,
      reclaimExternal,
    );
  }
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

function withUnderlyingStyleProperty<T>(property: string, read: () => T): T {
  const overrides = activeRootOverrides;
  const state = overrides?.styles.get(property);
  if (!overrides || !state) return read();

  const current = readInlineStyle(property);
  if (!inlineStylesEqual(current, state.written)) return read();

  writeInlineStyle(property, state.previous);
  try {
    return read();
  } finally {
    const exposed = readInlineStyle(property);
    if (inlineStylesEqual(exposed, state.previous)) {
      writeInlineStyle(property, state.written);
    } else {
      overrides.styles.delete(property);
    }
  }
}

function readThemeFontFamily(property: "--font-sans" | "--font-mono"): string {
  const root = document.documentElement;
  return withUnderlyingStyleProperty(property, () =>
    getComputedStyle(root).getPropertyValue(property).trim(),
  );
}

function readThemeLengthPixels(property: string): number | null {
  const probe = document.createElement("span");
  probe.style.position = "fixed";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  const isLineHeight = property.endsWith("--line-height");
  if (isLineHeight) {
    probe.style.fontSize = "16px";
    probe.style.lineHeight = `var(${property})`;
  } else {
    probe.style.fontSize = `var(${property})`;
  }

  return withUnderlyingStyleProperty(property, () => {
    document.body.append(probe);
    try {
      const computed = getComputedStyle(probe);
      const pixels = Number.parseFloat(
        isLineHeight ? computed.lineHeight : computed.fontSize,
      );
      return Number.isFinite(pixels) && pixels > 0 ? pixels : null;
    } finally {
      probe.remove();
    }
  });
}

function readThemeFontSize(): string {
  const root = document.documentElement;
  const property = "--text-base";
  const probe = document.createElement("span");

  probe.style.position = "fixed";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.fontSize = `var(${property})`;

  return withUnderlyingStyleProperty(property, () => {
    document.body.append(probe);
    try {
      const pixels = Number.parseFloat(getComputedStyle(probe).fontSize);
      return Number.isFinite(pixels) ? `${Number(pixels.toFixed(2))}` : "";
    } finally {
      probe.remove();
    }
  });
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

function findWorkspaceAppMenus(): HTMLElement[] {
  const menus = new Set<HTMLElement>();
  const triggers = document.querySelectorAll<HTMLButtonElement>(
    `button[aria-label="${WORKSPACE_APP_MENU_TRIGGER_LABEL}"]`,
  );

  for (const trigger of Array.from(triggers)) {
    const controlledId = trigger.getAttribute("aria-controls");
    if (!controlledId) continue;
    const menu = document.getElementById(controlledId);
    if (menu?.getAttribute("role") === "menu") menus.add(menu);
  }

  return [...menus];
}

function clearWorkspaceAppMenuMarkers() {
  for (const item of Array.from(
    document.querySelectorAll<HTMLElement>(
      `[${WORKSPACE_APP_MENU_ITEM_MARKER}]`,
    ),
  )) {
    item.removeAttribute(WORKSPACE_APP_MENU_ITEM_MARKER);
    item.removeAttribute(WORKSPACE_APP_MENU_HIDDEN_MARKER);
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
        item.removeAttribute(WORKSPACE_APP_MENU_ITEM_MARKER);
        item.removeAttribute(WORKSPACE_APP_MENU_HIDDEN_MARKER);
        return;
      }

      seenItems.add(item);
      item.setAttribute(WORKSPACE_APP_MENU_ITEM_MARKER, app.key);
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

interface FontSizeInputProps {
  id: string;
  label: string;
  placeholder: string;
  value: number | null;
  onValueChange: (value: number | null) => void;
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

function FontSizeInput({
  id,
  label,
  placeholder,
  value,
  onValueChange,
}: FontSizeInputProps) {
  const [draft, setDraft] = useState(value === null ? "" : `${value}`);

  useEffect(() => {
    setDraft(value === null ? "" : `${value}`);
  }, [value]);

  const restoreInvalidDraft = () => {
    if (draft.trim() && readFontSize(Number(draft)) === null) {
      setDraft(value === null ? "" : `${value}`);
    }
  };

  const stepValue = (amount: number) => {
    const themeValue = Number.parseFloat(placeholder);
    const current = value ?? (Number.isFinite(themeValue) ? themeValue : 15);
    const next = readFontSize(current + amount);
    if (next !== null) onValueChange(next);
  };

  return (
    <div>
      <div className="flex h-9 overflow-hidden rounded-md border border-border bg-background">
        <input
          id={id}
          aria-label={label}
          className="min-w-0 flex-1 bg-transparent px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          inputMode="decimal"
          max={MAX_FONT_SIZE}
          min={MIN_FONT_SIZE}
          placeholder={placeholder}
          step="0.5"
          type="number"
          value={draft}
          onBlur={restoreInvalidDraft}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);

            if (!next.trim()) {
              onValueChange(null);
              return;
            }

            const parsed = readFontSize(Number(next));
            if (parsed !== null) onValueChange(parsed);
          }}
        />
        <button
          aria-label={`Decrease ${label.toLowerCase()}`}
          className="w-8 border-l border-border text-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          type="button"
          onClick={() => stepValue(-0.5)}
        >
          −
        </button>
        <button
          aria-label={`Increase ${label.toLowerCase()}`}
          className="w-8 border-l border-border text-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          type="button"
          onClick={() => stepValue(0.5)}
        >
          +
        </button>
      </div>
    </div>
  );
}

function TypographySettings() {
  const { preferences, update } = usePreferences();
  const [themeUiFontFamily] = useState(() =>
    readThemeFontFamily("--font-sans"),
  );
  const [themeCodeFontFamily] = useState(() =>
    readThemeFontFamily("--font-mono"),
  );
  const [themeFontSize] = useState(readThemeFontSize);

  return (
    <div
      className="ui-tweaks-typography w-full space-y-3"
      data-ui-tweaks-settings=""
    >
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background">
        <div className="ui-tweaks-typography-row p-3">
          <div>
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="ui-tweaks-ui-font-family"
            >
              UI font
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Interface text.
            </p>
          </div>
          <div className="ui-tweaks-font-controls">
            <input
              id="ui-tweaks-ui-font-family"
              className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
              placeholder={
                readPrimaryFontName(themeUiFontFamily) || "Theme default"
              }
              value={preferences.uiFontFamily}
              onChange={(event) =>
                update({ uiFontFamily: event.target.value })
              }
            />
            <FontSizeInput
              id="ui-tweaks-ui-font-size"
              label="UI font size"
              placeholder={themeFontSize || "Default"}
              value={preferences.uiFontSize}
              onValueChange={(uiFontSize) => update({ uiFontSize })}
            />
          </div>
        </div>

        <div className="ui-tweaks-typography-row p-3">
          <div>
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="ui-tweaks-code-font-family"
            >
              Code font
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Code and monospace text.
            </p>
          </div>
          <div className="ui-tweaks-font-controls">
            <input
              id="ui-tweaks-code-font-family"
              className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
              placeholder={
                readPrimaryFontName(themeCodeFontFamily) || "Theme default"
              }
              value={preferences.codeFontFamily}
              onChange={(event) =>
                update({ codeFontFamily: event.target.value })
              }
            />
            <FontSizeInput
              id="ui-tweaks-code-font-size"
              label="Code font size"
              placeholder={themeFontSize || "Default"}
              value={preferences.codeFontSize}
              onValueChange={(codeFontSize) => update({ codeFontSize })}
            />
          </div>
        </div>
      </div>
      <div className="flex justify-end">
        <button
          className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground hover:bg-muted"
          type="button"
          onClick={() =>
            update({
              uiFontFamily: DEFAULT_PREFERENCES.uiFontFamily,
              uiFontSize: DEFAULT_PREFERENCES.uiFontSize,
              codeFontFamily: DEFAULT_PREFERENCES.codeFontFamily,
              codeFontSize: DEFAULT_PREFERENCES.codeFontSize,
            })
          }
        >
          ↶ Reset to defaults
        </button>
      </div>
    </div>
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
      <div className="grid gap-4 border-b border-border pb-5 md:grid-cols-[minmax(0,1fr)_17rem] md:items-center">
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

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Open With Filter</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Choose which workspace apps appear in the Open With menu.
          </p>
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background">
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
        className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background"
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
    id: "fonts",
    title: "Fonts",
    component: TypographySettings,
  });

  app.slots.settingsSection({
    id: "preferences",
    title: "Interface preferences",
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
      activeRootOverrides = overrides;
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
        observeDynamicSurfaces();
      };
      const onStorage = (event: StorageEvent) => {
        if (event.key !== STORAGE_KEY && event.key !== null) return;
        const next = reloadPersistedPreferences();
        footerObserver.disconnect();
        workspaceObserver.disconnect();
        applyPreferences(next, overrides, true);
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
              node.matches(
                `button[aria-label="${WORKSPACE_APP_MENU_TRIGGER_LABEL}"]`,
              ) ||
              node.querySelector(
                `button[aria-label="${WORKSPACE_APP_MENU_TRIGGER_LABEL}"]`,
              ) !== null ||
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
        footerObserver.disconnect();
        workspaceObserver.disconnect();
        if (refreshFrame !== 0) window.cancelAnimationFrame(refreshFrame);
        clearFooterActionMarkers();
        clearWorkspaceAppMenuMarkers();
        clearPromptContainerMarker();
        releaseRootOverrides(overrides);
        if (activeRootOverrides === overrides) activeRootOverrides = null;
      };
    },
  });
});
