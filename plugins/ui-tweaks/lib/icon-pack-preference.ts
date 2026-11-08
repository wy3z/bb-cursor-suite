export const ICON_PACK_OPTIONS = [
  {
    id: "default",
    label: "BB Default",
    description: "BB's built-in icon set.",
  },
  {
    id: "lucide",
    label: "Lucide",
    description: "Lucide's outline icons.",
  },
  {
    id: "iconoir",
    label: "Iconoir",
    description: "Iconoir's outline icons.",
  },
  {
    id: "tabler",
    label: "Tabler Outline",
    description: "Tabler Icons' outline set.",
  },
] as const;

export type IconPack = (typeof ICON_PACK_OPTIONS)[number]["id"];

const ICON_PACK_IDS: ReadonlySet<string> = new Set(
  ICON_PACK_OPTIONS.map((option) => option.id),
);

export function isIconPack(value: unknown): value is IconPack {
  return typeof value === "string" && ICON_PACK_IDS.has(value);
}

export function parseIconPack(value: unknown): IconPack {
  return isIconPack(value) ? value : "default";
}

export const SPINNER_STYLE_OPTIONS = [
  {
    id: "follow",
    label: "Follow icon pack",
    description: "Use the selected icon pack.",
  },
  {
    id: "default",
    label: "BB Default",
    description: "BB's built-in spinner.",
  },
  {
    id: "lucide",
    label: "Lucide",
    description: "Lucide's outline spinner.",
  },
  {
    id: "iconoir",
    label: "Iconoir",
    description: "Iconoir's outline spinner.",
  },
  {
    id: "tabler",
    label: "Tabler Outline",
    description: "Tabler's outline spinner.",
  },
] as const;

export type SpinnerStyle = (typeof SPINNER_STYLE_OPTIONS)[number]["id"];

const SPINNER_STYLE_IDS: ReadonlySet<string> = new Set(
  SPINNER_STYLE_OPTIONS.map((option) => option.id),
);

export function isSpinnerStyle(value: unknown): value is SpinnerStyle {
  return typeof value === "string" && SPINNER_STYLE_IDS.has(value);
}

const RETIRED_SPINNER_STYLES: ReadonlySet<string> = new Set([
  "solar",
  "phosphor",
]);
const RETIRED_ICON_PACKS: ReadonlySet<string> = new Set(["solar", "phosphor"]);

export function parseSpinnerStyle(value: unknown): SpinnerStyle {
  if (RETIRED_SPINNER_STYLES.has(typeof value === "string" ? value : "")) {
    return "default";
  }
  return isSpinnerStyle(value) ? value : "follow";
}

export function normalizeRetiredIconAppearance(record: Record<string, unknown>) {
  let changed = false;
  if (RETIRED_ICON_PACKS.has(String(record.iconPack))) {
    record.iconPack = "default";
    changed = true;
  }
  if (RETIRED_SPINNER_STYLES.has(String(record.spinnerStyle))) {
    record.spinnerStyle = "default";
    changed = true;
  }
  return changed;
}

export interface IconAppearance {
  readonly iconPack: IconPack;
  readonly spinnerStyle: SpinnerStyle;
}

const SPINNER_ICON_NAMES = ["Loading", "Spinner"] as const;

function isSpinnerIconName(name: string): boolean {
  return (SPINNER_ICON_NAMES as readonly string[]).includes(name);
}

/** Resolve the pack used for one icon, including settings preview overrides. */
export function resolveIconPackForName(
  appearance: IconAppearance,
  name: string,
  preview: {
    previewPack?: IconPack | null;
    previewSpinnerStyle?: SpinnerStyle | null;
  } = {},
): IconPack {
  // An explicit icon-pack preview outranks the separate spinner setting.
  if (preview.previewPack !== undefined && preview.previewPack !== null) {
    return preview.previewPack;
  }
  if (!isSpinnerIconName(name)) return appearance.iconPack;

  const style = preview.previewSpinnerStyle ?? appearance.spinnerStyle;
  return style === "follow" ? appearance.iconPack : style;
}
