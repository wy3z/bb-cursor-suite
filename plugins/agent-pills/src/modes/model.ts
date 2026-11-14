export interface ModeRef {
  skillId: string;
  label: string;
}

export function sameMode(left: ModeRef | null, right: ModeRef | null): boolean {
  if (left === null || right === null) return left === right;
  return left.skillId === right.skillId || left.label === right.label;
}

export function skillPathPhrase(path: string | null): string | null {
  const trimmed = path?.trim() ?? "";
  if (trimmed.length === 0 || !/(?:^|[/\\])SKILL\.md$/.test(trimmed)) return null;
  return JSON.stringify(trimmed);
}

export function modeText(label: string, path: string | null): string {
  const quoted = skillPathPhrase(path) ?? "the skill";
  return `You are in ${label} mode. Follow that mode's skill on this turn. Do not drop it because the request looks small or you already have context. Do not drift back to default agent behavior. If you cannot state the mode's hard rules, read ${quoted} before acting.`;
}

export interface LoadedSkill {
  path: string | null;
  body: string;
}

export function skillBlock(label: string, skill: LoadedSkill): string {
  const where = skill.path === null ? "" : ` path=${JSON.stringify(skill.path)}`;
  return `<skill name=${JSON.stringify(label)}${where}>\n${skill.body}\n</skill>`;
}

export function modeContext(mode: ModeRef, skill: LoadedSkill | null): string {
  if (skill === null) return "";
  return [modeText(mode.label, skill.path), skillBlock(mode.label, skill)].join("\n\n");
}

export function missingSkillNotice(label: string): string {
  return `'${label}' mode couldn't be applied — its skill file may have been renamed or removed. Message sent without it.`;
}

export function cycleMode(options: readonly ModeRef[], current: ModeRef | null, direction: 1 | -1 = 1): ModeRef | null {
  const ring: (ModeRef | null)[] = [null, ...options];
  const index = ring.findIndex((entry) => sameMode(entry, current));
  const from = index === -1 ? 0 : index;
  return ring[(from + direction + ring.length) % ring.length] ?? null;
}

export interface ModeMention {
  mode: ModeRef;
  rev: number;
  threadId: string | null;
  projectId: string;
  environmentId: string | null;
  nonce: string;
}

interface WireMention {
  v: 3;
  m: [string, string];
  r: number;
  t: string | null;
  p: string;
  e: string | null;
  n: string;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeModeMention(mention: ModeMention): string {
  const wire: WireMention = {
    v: 3,
    m: [mention.mode.skillId, mention.mode.label],
    r: mention.rev,
    t: mention.threadId,
    p: mention.projectId,
    e: mention.environmentId,
    n: mention.nonce,
  };
  return toBase64Url(JSON.stringify(wire));
}

export function modeItemId(tone: string, mention: ModeMention): string {
  return `${tone}.${encodeModeMention(mention)}`;
}

function refOf(pair: unknown): ModeRef | null {
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  const [skillId, label] = pair as unknown[];
  if (typeof skillId !== "string" || typeof label !== "string" || skillId.length === 0 || label.length === 0) return null;
  return { skillId, label };
}

export function decodeModeMention(itemId: string): ModeMention | null {
  const payload = itemId.slice(itemId.lastIndexOf(".") + 1);
  let wire: Partial<WireMention>;
  try {
    wire = JSON.parse(fromBase64Url(payload)) as Partial<WireMention>;
  } catch {
    return null;
  }
  if (wire === null || typeof wire !== "object" || wire.v !== 3) return null;
  if (typeof wire.p !== "string" || typeof wire.n !== "string" || wire.n.length === 0) return null;
  const mode = refOf(wire.m);
  if (mode === null) return null;
  return {
    mode,
    rev: typeof wire.r === "number" && Number.isInteger(wire.r) && wire.r >= 0 ? wire.r : 0,
    threadId: typeof wire.t === "string" ? wire.t : null,
    projectId: wire.p,
    environmentId: typeof wire.e === "string" ? wire.e : null,
    nonce: wire.n,
  };
}

export function newNonce(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface SkillFrontmatter {
  name: string | null;
  description: string | null;
  icon: string | null;
  color: string | null;
  mode: boolean;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function splitSkill(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const empty: SkillFrontmatter = { name: null, description: null, icon: null, color: null, mode: false };
  const normalized = content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { frontmatter: empty, body: normalized.trim() };
  const frontmatter = { ...empty };
  for (const line of match[1]!.split("\n")) {
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1]!;
    const value = unquote(pair[2]!);
    if (value.length === 0 || value === "|" || value === ">") continue;
    if (key === "name" || key === "description" || key === "icon" || key === "color") frontmatter[key] = value;
    if (key === "mode") frontmatter.mode = /^(?:true|yes|on)$/i.test(value);
  }
  return { frontmatter, body: normalized.slice(match[0].length).trim() };
}

export const MODE_COLORS = ["default", "green", "cyan", "blue", "purple", "magenta", "orange", "yellow", "red", "brand"] as const;
export type ModeColor = (typeof MODE_COLORS)[number];

export function modeColorOf(value: string | null | undefined): ModeColor {
  const wanted = value?.trim().toLowerCase() ?? "";
  return (MODE_COLORS as readonly string[]).includes(wanted) ? (wanted as ModeColor) : "default";
}

export const TITLE_MAX_LENGTH = 80;

export function ownWords(text: string, label: string): string | null {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed.startsWith(`${label} `)) return null;
  const rest = collapsed.slice(label.length + 1).trim();
  if (rest.length === 0) return null;
  return rest.length > TITLE_MAX_LENGTH ? `${rest.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…` : rest;
}

export function fixedTitle(thread: { title: string | null; titleFallback: string | null }, contaminated: string, own: string): string | null {
  if (thread.title !== null) return null;
  return thread.titleFallback === contaminated ? own : null;
}
