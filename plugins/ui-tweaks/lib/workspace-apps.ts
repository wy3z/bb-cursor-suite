export const WORKSPACE_APP_CATEGORIES = [
  "default-app",
  "file-manager",
  "editor",
  "terminal",
  "other",
] as const;

export type WorkspaceAppCategory = (typeof WORKSPACE_APP_CATEGORIES)[number];

export interface WorkspaceAppCatalogItem {
  id: string;
  key: string;
  /** Human-facing label used in UI Tweaks settings. */
  label: string;
  /** Original BB menu label when `label` was disambiguated. */
  menuLabel?: string;
  category: WorkspaceAppCategory;
}

const WORKSPACE_EDITOR_PATTERN =
  /\b(android studio|atom|bbedit|bluefish|brackets|code - oss|code-oss|codium|cursor|eclipse|emacs|fleet|geany|gnome builder|goland|helix|intellij|kate|kdevelop|lapce|lite xl|mousepad|neovim|notepad\+\+|nova|phpstorm|pulsar|pycharm|qt creator|rider|rstudio|rustrover|scite|sublime text|text editor|textmate|vim|visual studio|vs code|vscode|vscodium|webstorm|xcode|xed|zed)\b/i;
const WORKSPACE_FILE_MANAGER_PATTERN =
  /\b(caja|dolphin|double commander|file manager|files|finder|krusader|nautilus|nemo|pcmanfm|spacefm|thunar|yazi)\b/i;
const WORKSPACE_TERMINAL_PATTERN =
  /\b(alacritty|black box|console|cool retro term|foot|ghostty|gnome terminal|hyper|iterm|kitty|konsole|ptyxis|qterminal|rio|terminal|terminator|tilix|warp|wezterm|xterm)\b/i;

export function classifyWorkspaceApp(label: string): WorkspaceAppCategory {
  if (label === "Default App") return "default-app";
  if (label === "File Manager" || WORKSPACE_FILE_MANAGER_PATTERN.test(label)) {
    return "file-manager";
  }
  if (label === "Terminal" || WORKSPACE_TERMINAL_PATTERN.test(label)) {
    return "terminal";
  }
  if (WORKSPACE_EDITOR_PATTERN.test(label)) return "editor";
  return "other";
}

export function normalizeWorkspaceAppLabel(label: string): string {
  return label.trim().toLocaleLowerCase();
}

/**
 * BB's workspace dropdown renders the target label directly, while chat file
 * link context menus may render the same target as "Open in <label>".
 */
export function workspaceAppTargetLabelFromMenuItem(label: string): string {
  const trimmed = label.trim();
  return trimmed.replace(/^Open in\s+/u, "").trim();
}

export function workspaceAppMenuLabel(app: WorkspaceAppCatalogItem): string {
  return app.menuLabel ?? app.label;
}

export function legacyWorkspaceAppKey(app: WorkspaceAppCatalogItem): string {
  return `${app.category}:${normalizeWorkspaceAppLabel(workspaceAppMenuLabel(app))}`;
}

function friendlyDesktopApplicationName(id: string): string | null {
  if (!id.startsWith("desktop-app:")) return null;
  const segments = id.slice("desktop-app:".length).split(/[./:]/);
  const raw = segments.at(-1)?.replace(/\.desktop$/i, "").trim() ?? "";
  if (!raw) return null;
  return raw
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function disambiguateWorkspaceAppLabels(
  apps: WorkspaceAppCatalogItem[],
): WorkspaceAppCatalogItem[] {
  const groups = new Map<string, WorkspaceAppCatalogItem[]>();
  for (const app of apps) {
    const key = normalizeWorkspaceAppLabel(app.label);
    const group = groups.get(key) ?? [];
    group.push(app);
    groups.set(key, group);
  }

  return apps.map((app) => {
    const group = groups.get(normalizeWorkspaceAppLabel(app.label)) ?? [];
    if (group.length < 2) return app;

    const groupIndex = group.indexOf(app);
    const candidate = friendlyDesktopApplicationName(app.id) ?? app.label;
    const priorCandidates = group
      .slice(0, groupIndex)
      .map((item) => friendlyDesktopApplicationName(item.id) ?? item.label);
    const label = priorCandidates.some(
      (item) =>
        normalizeWorkspaceAppLabel(item) ===
        normalizeWorkspaceAppLabel(candidate),
    )
      ? `${candidate} (${groupIndex + 1})`
      : candidate;

    return { ...app, label, menuLabel: app.label };
  });
}

export function parseWorkspaceAppsTargetsResponse(
  value: unknown,
): WorkspaceAppCatalogItem[] | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("targets" in value) ||
    !Array.isArray(value.targets)
  ) {
    return null;
  }

  const apps = new Map<string, WorkspaceAppCatalogItem>();
  for (const target of value.targets) {
    if (
      typeof target !== "object" ||
      target === null ||
      !("label" in target) ||
      typeof target.label !== "string" ||
      !("id" in target) ||
      typeof target.id !== "string" ||
      !target.id.trim() ||
      !target.label.trim()
    ) {
      continue;
    }

    const kind = "kind" in target ? target.kind : null;
    const category = WORKSPACE_APP_CATEGORIES.includes(
      kind as WorkspaceAppCategory,
    )
      ? (kind as WorkspaceAppCategory)
      : classifyWorkspaceApp(target.label);
    const id = target.id.trim();
    apps.set(id, { id, key: id, label: target.label.trim(), category });
  }

  return disambiguateWorkspaceAppLabels([...apps.values()]);
}

export function parseStoredWorkspaceAppCatalog(
  value: unknown,
): WorkspaceAppCatalogItem[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("id" in item) ||
      !("key" in item) ||
      !("label" in item) ||
      !("category" in item) ||
      typeof item.id !== "string" ||
      typeof item.key !== "string" ||
      typeof item.label !== "string" ||
      !WORKSPACE_APP_CATEGORIES.includes(item.category as WorkspaceAppCategory)
    ) {
      return [];
    }

    const menuLabel =
      "menuLabel" in item && typeof item.menuLabel === "string"
        ? item.menuLabel
        : undefined;
    return [
      {
        id: item.id,
        key: item.key,
        label: item.label,
        ...(menuLabel ? { menuLabel } : {}),
        category: item.category as WorkspaceAppCategory,
      },
    ];
  });
}

/**
 * Resolve rendered menu labels back to stable catalogue entries. Duplicate
 * labels are safe only when the menu and catalogue contain the same number in
 * the same daemon-provided order; otherwise the item deliberately fails open.
 */
export function resolveWorkspaceMenuApps(
  menuLabels: readonly string[],
  catalog: readonly WorkspaceAppCatalogItem[],
): Array<WorkspaceAppCatalogItem | null> {
  const catalogGroups = new Map<string, WorkspaceAppCatalogItem[]>();
  for (const app of catalog) {
    const key = normalizeWorkspaceAppLabel(workspaceAppMenuLabel(app));
    const group = catalogGroups.get(key) ?? [];
    group.push(app);
    catalogGroups.set(key, group);
  }

  const resolveMenuLabelKey = (label: string) => {
    const exactKey = normalizeWorkspaceAppLabel(label);
    if (catalogGroups.has(exactKey)) return exactKey;
    return normalizeWorkspaceAppLabel(
      workspaceAppTargetLabelFromMenuItem(label),
    );
  };

  const menuCounts = new Map<string, number>();
  for (const label of menuLabels) {
    const key = resolveMenuLabelKey(label);
    menuCounts.set(key, (menuCounts.get(key) ?? 0) + 1);
  }

  const offsets = new Map<string, number>();
  return menuLabels.map((label) => {
    const key = resolveMenuLabelKey(label);
    const matches = catalogGroups.get(key) ?? [];
    if (matches.length === 0 || menuCounts.get(key) !== matches.length) {
      return null;
    }
    const offset = offsets.get(key) ?? 0;
    offsets.set(key, offset + 1);
    return matches[offset] ?? null;
  });
}
