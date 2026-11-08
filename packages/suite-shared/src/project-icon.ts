import { LEGACY_PROJECT_ICON_NAMES, PROJECT_ICON_CATALOG } from "./project-icon-catalog";

export { PROJECT_ICON_CATALOG } from "./project-icon-catalog";

export type ProjectIconShape = readonly (readonly [string, { readonly [key: string]: string | number }])[];

export const PROJECT_ICON_COLORS = [
  { id: "default", label: "Default" },
  { id: "green", label: "Green" },
  { id: "cyan", label: "Cyan" },
  { id: "blue", label: "Blue" },
  { id: "purple", label: "Purple" },
  { id: "magenta", label: "Magenta" },
  { id: "orange", label: "Orange" },
  { id: "yellow", label: "Yellow" },
  { id: "red", label: "Red" },
  { id: "brand", label: "Brand" },
] as const;

export type ProjectIconPickerColor = (typeof PROJECT_ICON_COLORS)[number]["id"];

export const LEGACY_PROJECT_ICON_COLORS = [
  "gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
] as const;

export type ProjectIconColor = ProjectIconPickerColor | (typeof LEGACY_PROJECT_ICON_COLORS)[number];

const COLOR_SET: ReadonlySet<string> = new Set([...PROJECT_ICON_COLORS.map((color) => color.id), ...LEGACY_PROJECT_ICON_COLORS]);
const PICKER_COLOR_SET: ReadonlySet<string> = new Set(PROJECT_ICON_COLORS.map((color) => color.id));

export function isProjectIconColor(value: string): value is ProjectIconColor {
  return COLOR_SET.has(value);
}

export function isProjectIconPickerColor(value: string): value is ProjectIconPickerColor {
  return PICKER_COLOR_SET.has(value);
}

export function projectIconColorClass(color: ProjectIconColor): string {
  return `bbs-pi-${color}`;
}

export const PROJECT_ICON_NAMES: readonly string[] = PROJECT_ICON_CATALOG.map(([name]) => name);
const CATALOG_SET: ReadonlySet<string> = new Set(PROJECT_ICON_NAMES);
const LEGACY_SET: ReadonlySet<string> = new Set(LEGACY_PROJECT_ICON_NAMES);

export function isProjectIconName(name: string): boolean {
  return CATALOG_SET.has(name) || LEGACY_SET.has(name);
}

export function isCatalogIconName(name: string): boolean {
  return CATALOG_SET.has(name);
}

export type ProjectIcon =
  | { kind: "glyph"; name: string; color?: ProjectIconColor }
  | { kind: "emoji"; emoji: string }
  | { kind: "monogram"; text: string; color: ProjectIconColor }
  | { kind: "image"; src: string };

export const PROJECT_ICON_MAX_LENGTH = 256 * 1024;
export const PROJECT_ICON_IMAGE_EDGE = 64;

const IMAGE_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
const GLYPH_PREFIX = "glyph:";
const EMOJI_PREFIX = "emoji:";
const MONOGRAM_PREFIX = "monogram:";

export function isPngDataUrl(value: string): boolean {
  return value.length <= PROJECT_ICON_MAX_LENGTH && IMAGE_PATTERN.test(value);
}

function splitColor(rest: string): { value: string; color: string } | null {
  const at = rest.lastIndexOf(":");
  return at === -1 ? null : { value: rest.slice(0, at), color: rest.slice(at + 1) };
}

export function parseProjectIcon(stored: string): ProjectIcon | null {
  if (stored.length > PROJECT_ICON_MAX_LENGTH) return null;
  if (stored.startsWith("data:")) return isPngDataUrl(stored) ? { kind: "image", src: stored } : null;
  if (stored.startsWith(GLYPH_PREFIX)) {
    const parts = splitColor(stored.slice(GLYPH_PREFIX.length));
    return parts && isProjectIconName(parts.value) && isProjectIconColor(parts.color)
      ? { kind: "glyph", name: parts.value, color: parts.color }
      : null;
  }
  if (stored.startsWith(EMOJI_PREFIX)) {
    const emoji = stored.slice(EMOJI_PREFIX.length);
    return emoji.length > 0 && emoji.length <= 32 ? { kind: "emoji", emoji } : null;
  }
  if (stored.startsWith(MONOGRAM_PREFIX)) {
    const parts = splitColor(stored.slice(MONOGRAM_PREFIX.length));
    if (!parts) return null;
    const text = normalizeMonogram(parts.value);
    return isValidMonogram(text) && isProjectIconColor(parts.color) ? { kind: "monogram", text, color: parts.color } : null;
  }
  return isProjectIconName(stored) ? { kind: "glyph", name: stored } : null;
}

export function serializeProjectIcon(icon: ProjectIcon): string {
  switch (icon.kind) {
    case "glyph":
      return icon.color === undefined ? icon.name : `${GLYPH_PREFIX}${icon.name}:${icon.color}`;
    case "emoji":
      return `${EMOJI_PREFIX}${icon.emoji}`;
    case "monogram":
      return `${MONOGRAM_PREFIX}${icon.text}:${icon.color}`;
    case "image":
      return icon.src;
  }
}

export function normalizeMonogram(text: string): string {
  return text.normalize("NFKC").trim().toUpperCase();
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function isValidMonogram(text: string): boolean {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}\p{M}‌‍]*$/u.test(text)) return false;
  return Array.from(graphemes.segment(text)).length <= 2;
}

const SEARCH_TEXT: ReadonlyMap<string, string> = new Map(
  PROJECT_ICON_CATALOG.map(([name, aliases]) => [name, `${name} ${aliases}`.trim().toLowerCase()]),
);

export function searchTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/[\s/_]+/).filter(Boolean);
}

export function filterProjectIconNames(query: string, current?: string): string[] {
  const tokens = searchTokens(query);
  const list = current !== undefined && !CATALOG_SET.has(current) && isProjectIconName(current) ? [current, ...PROJECT_ICON_NAMES] : [...PROJECT_ICON_NAMES];
  if (tokens.length === 0) return list;
  return list.filter((name) => {
    const text = SEARCH_TEXT.get(name) ?? name.toLowerCase();
    return tokens.every((token) => text.includes(token));
  });
}

export function describeProjectIcon(icon: ProjectIcon): string {
  switch (icon.kind) {
    case "glyph":
      return `glyph ${icon.name}${icon.color === undefined ? "" : ` (${icon.color})`}`;
    case "emoji":
      return `emoji ${icon.emoji}`;
    case "monogram":
      return `monogram ${icon.text} (${icon.color})`;
    case "image":
      return "uploaded image";
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const PROJECT_ICON_PNG_MAX_BYTES = 192 * 1024;
export const PROJECT_ICON_PNG_MAX_EDGE = 1024;

export function checkPngBytes(bytes: Uint8Array): string | null {
  if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return "That file is not a PNG.";
  if (bytes.length > PROJECT_ICON_PNG_MAX_BYTES) {
    return `That PNG is ${Math.round(bytes.length / 1024)}KB; keep it under ${PROJECT_ICON_PNG_MAX_BYTES / 1024}KB (64 to 256px is plenty).`;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width > PROJECT_ICON_PNG_MAX_EDGE || height > PROJECT_ICON_PNG_MAX_EDGE) {
    return `That PNG is ${width}x${height}; keep each side at ${PROJECT_ICON_PNG_MAX_EDGE}px or less (64 to 256px is plenty).`;
  }
  return null;
}

export function findProjectIconName(value: string): string | null {
  const wanted = value.trim().toLowerCase();
  return PROJECT_ICON_NAMES.find((name) => name.toLowerCase() === wanted) ?? LEGACY_PROJECT_ICON_NAMES.find((name) => name.toLowerCase() === wanted) ?? null;
}
