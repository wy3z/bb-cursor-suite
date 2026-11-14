export interface ModeRef {
  skillId: string;
  label: string;
}

export interface ModeState {
  committed: ModeRef | null;
  draft: ModeRef | null;
}

export const EMPTY_MODE_STATE: ModeState = { committed: null, draft: null };

export type ModeTransition =
  | { kind: "none" }
  | { kind: "enter"; mode: ModeRef }
  | { kind: "maintain"; mode: ModeRef }
  | { kind: "exit"; exited: ModeRef }
  | { kind: "switch"; exited: ModeRef; mode: ModeRef };

export function sameMode(left: ModeRef | null, right: ModeRef | null): boolean {
  if (left === null || right === null) return left === right;
  return left.skillId === right.skillId;
}

export function transitionOf({ committed, draft }: ModeState): ModeTransition {
  if (draft === null) return committed === null ? { kind: "none" } : { kind: "exit", exited: committed };
  if (committed === null) return { kind: "enter", mode: draft };
  if (sameMode(committed, draft)) return { kind: "maintain", mode: draft };
  return { kind: "switch", exited: committed, mode: draft };
}

export function committedAfter(transition: ModeTransition): ModeRef | null {
  switch (transition.kind) {
    case "none":
    case "exit":
      return null;
    default:
      return transition.mode;
  }
}

export function skillPathPhrase(path: string | null): string | null {
  const trimmed = path?.trim() ?? "";
  if (trimmed.length === 0 || !/(?:^|[/\\])SKILL\.md$/.test(trimmed)) return null;
  return JSON.stringify(trimmed);
}

export function enterText(label: string, path: string | null): string {
  const quoted = skillPathPhrase(path);
  const follow = quoted === null ? "Follow the attached skill" : `Follow the skill instructions in ${quoted}`;
  return `The user has entered ${label} custom mode. ${follow} until the user exits or switches modes. Do not drift back to default agent behavior.`;
}

export function maintainText(label: string, path: string | null): string {
  const quoted = skillPathPhrase(path) ?? "the skill";
  return `Reminder: you are still in ${label} mode. Follow that mode's skill on this turn. Do not drop it because the request looks small or you already have context. Do not drift back to default agent behavior. If you cannot state the mode's hard rules, read ${quoted} before acting.`;
}

export function exitText(label: string): string {
  return `The user has exited ${label} custom mode. Stop following that mode's skill. Continue without those constraints.`;
}

export interface LoadedSkill {
  path: string | null;
  body: string;
}

export function skillBlock(label: string, skill: LoadedSkill): string {
  const where = skill.path === null ? "" : ` path=${JSON.stringify(skill.path)}`;
  return `<skill name=${JSON.stringify(label)}${where}>\n${skill.body}\n</skill>`;
}

export function modeContext(transition: ModeTransition, skill: LoadedSkill | null): string {
  switch (transition.kind) {
    case "none":
      return "";
    case "exit":
      return exitText(transition.exited.label);
    case "enter":
      if (skill === null) return "";
      return [enterText(transition.mode.label, skill.path), skillBlock(transition.mode.label, skill)].join("\n\n");
    case "maintain":
      if (skill === null) return exitText(transition.mode.label);
      return [maintainText(transition.mode.label, skill.path), skillBlock(transition.mode.label, skill)].join("\n\n");
    case "switch":
      if (skill === null) return exitText(transition.exited.label);
      return [
        exitText(transition.exited.label),
        enterText(transition.mode.label, skill.path),
        skillBlock(transition.mode.label, skill),
      ].join("\n\n");
  }
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
  transition: Exclude<ModeTransition, { kind: "none" }>;
  projectId: string;
  environmentId: string | null;
}

interface WireMention {
  v: 1;
  k: ModeMention["transition"]["kind"];
  m?: [string, string];
  x?: [string, string];
  p: string;
  e: string | null;
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
  const { transition } = mention;
  const wire: WireMention = { v: 1, k: transition.kind, p: mention.projectId, e: mention.environmentId };
  if (transition.kind !== "exit") wire.m = [transition.mode.skillId, transition.mode.label];
  if (transition.kind === "exit" || transition.kind === "switch") wire.x = [transition.exited.skillId, transition.exited.label];
  return toBase64Url(JSON.stringify(wire));
}

function refOf(pair: unknown): ModeRef | null {
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  const [skillId, label] = pair as unknown[];
  if (typeof skillId !== "string" || typeof label !== "string" || skillId.length === 0 || label.length === 0) return null;
  return { skillId, label };
}

export function modeItemId(tone: string, mention: ModeMention): string {
  return `${tone}.${encodeModeMention(mention)}`;
}

export function decodeModeMention(itemId: string): ModeMention | null {
  const payload = itemId.slice(itemId.lastIndexOf(".") + 1);
  let wire: Partial<WireMention>;
  try {
    wire = JSON.parse(fromBase64Url(payload)) as Partial<WireMention>;
  } catch {
    return null;
  }
  if (wire === null || typeof wire !== "object" || wire.v !== 1 || typeof wire.p !== "string") return null;
  const environmentId = typeof wire.e === "string" ? wire.e : null;
  const mode = refOf(wire.m);
  const exited = refOf(wire.x);
  const base = { projectId: wire.p, environmentId };
  switch (wire.k) {
    case "enter":
      return mode ? { ...base, transition: { kind: "enter", mode } } : null;
    case "maintain":
      return mode ? { ...base, transition: { kind: "maintain", mode } } : null;
    case "exit":
      return exited ? { ...base, transition: { kind: "exit", exited } } : null;
    case "switch":
      return mode && exited ? { ...base, transition: { kind: "switch", exited, mode } } : null;
    default:
      return null;
  }
}

export function mentionLabel(transition: ModeMention["transition"]): string {
  return transition.kind === "exit" ? `Exit ${transition.exited.label}` : transition.mode.label;
}

export interface SkillFrontmatter {
  name: string | null;
  description: string | null;
  icon: string | null;
  color: string | null;
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
  const empty: SkillFrontmatter = { name: null, description: null, icon: null, color: null };
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
  }
  return { frontmatter, body: normalized.slice(match[0].length).trim() };
}

export const MODE_COLORS = ["default", "green", "cyan", "blue", "purple", "magenta", "orange", "yellow", "red", "brand"] as const;
export type ModeColor = (typeof MODE_COLORS)[number];
export const DEFAULT_MODE_ICON = "lightning";

export function modeColorOf(value: string | null | undefined): ModeColor {
  const wanted = value?.trim().toLowerCase() ?? "";
  return (MODE_COLORS as readonly string[]).includes(wanted) ? (wanted as ModeColor) : "default";
}
