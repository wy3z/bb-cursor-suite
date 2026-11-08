import { BOARD_ICON_MAX_LENGTH, type BoardIconRow } from "@wy3z/bb-suite/contracts";
import {
  PROJECT_ICON_COLORS,
  checkPngBytes,
  findProjectIconName,
  isProjectIconColor,
  parseProjectIcon,
  serializeProjectIcon,
  type ProjectIcon,
} from "@wy3z/bb-suite/project-icon";

export const ICON_PREFIX = "icon:";

export type IconKv = {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
};

export class BoardIconError extends Error {}

export function validateStoredIcon(icon: string): string {
  if (icon.length > BOARD_ICON_MAX_LENGTH) throw new BoardIconError("That icon is too large.");
  const parsed = parseProjectIcon(icon);
  if (parsed === null) throw new BoardIconError(`Unrecognised icon value ${JSON.stringify(icon.length > 60 ? `${icon.slice(0, 60)}…` : icon)}.`);
  return serializeProjectIcon(parsed);
}

export function createBoardIcons(kv: IconKv, onChange: (projectId: string) => void) {
  const key = (projectId: string) => `${ICON_PREFIX}${projectId}`;

  async function get(projectId: string): Promise<string | null> {
    const stored = await kv.get<string>(key(projectId));
    return typeof stored === "string" && parseProjectIcon(stored) !== null ? stored : null;
  }

  async function list(): Promise<BoardIconRow[]> {
    const rows: BoardIconRow[] = [];
    for (const storageKey of (await kv.list(ICON_PREFIX)).sort()) {
      const stored = await kv.get<string>(storageKey);
      if (typeof stored === "string" && parseProjectIcon(stored) !== null) rows.push({ projectId: storageKey.slice(ICON_PREFIX.length), icon: stored });
    }
    return rows;
  }

  async function set(projectId: string, icon: string | null): Promise<string | null> {
    const next = icon === null ? null : validateStoredIcon(icon);
    if (next === null) await kv.delete(key(projectId));
    else await kv.set(key(projectId), next);
    onChange(projectId);
    return next;
  }

  return { get, list, set };
}

export type IconArgument = { kind: "value"; icon: string } | { kind: "file"; path: string };

export function iconArgument(value: string, color: string | undefined): IconArgument {
  const trimmed = value.trim();
  if (color !== undefined && !isProjectIconColor(color)) {
    throw new BoardIconError(`Unknown colour "${color}". Use one of: ${PROJECT_ICON_COLORS.map((option) => option.id).join(", ")}.`);
  }
  if (/^(glyph|emoji|monogram):/.test(trimmed) || trimmed.startsWith("data:")) {
    if (color !== undefined) throw new BoardIconError("--color only applies to a glyph name.");
    return { kind: "value", icon: validateStoredIcon(trimmed) };
  }
  const name = findProjectIconName(trimmed);
  if (name !== null) return { kind: "value", icon: `glyph:${name}:${color ?? "default"}` };
  if (/\.png$/i.test(trimmed) || trimmed.includes("/")) return { kind: "file", path: trimmed };
  throw new BoardIconError(`Unknown icon "${value}". Run \`bb projects icon --list\` for glyph names, or pass a stored value or a PNG path.`);
}

export function pngToIcon(bytes: Uint8Array): string {
  const problem = checkPngBytes(bytes);
  if (problem !== null) throw new BoardIconError(problem);
  return validateStoredIcon(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
}

export function boardIconFor(rows: ReadonlyMap<string, string>, projectId: string | null): ProjectIcon | null {
  if (projectId === null) return null;
  const stored = rows.get(projectId);
  return stored === undefined ? null : parseProjectIcon(stored);
}
