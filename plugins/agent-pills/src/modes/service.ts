import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { findProjectIconName } from "@wy3z/bb-suite/project-icon";
import {
  DEFAULT_MODE_ICON,
  EMPTY_MODE_STATE,
  committedAfter,
  decodeModeMention,
  missingSkillNotice,
  modeColorOf,
  modeContext,
  splitSkill,
  type LoadedSkill,
  type ModeMention,
  type ModeRef,
  type ModeState,
} from "./model";
import type { ModeOption, StoredModeState } from "./rpc";
import { MODE_CHANNEL, MODE_MENTION_PROVIDER } from "./channel";

export { MODE_CHANNEL, MODE_MENTION_PROVIDER };

const FRONTMATTER_TTL_MS = 30_000;
const READ_CONCURRENCY = 8;

interface SkillListing {
  id: string;
  name: string;
  description: string | null;
  filePath: string;
  provider: string | null;
  scope: string;
}

interface CachedFrontmatter {
  at: number;
  icon: string | null;
  color: string | null;
  description: string | null;
}

export interface ModeLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface ModeDeps {
  pluginId: string;
  listSkills(args: { projectId: string; environmentId: string | null }): Promise<SkillListing[]>;
  readSkill(args: { projectId: string; environmentId: string | null; skillId: string }): Promise<string>;
  kv: Pick<BbPluginApi["storage"]["kv"], "get" | "set" | "delete">;
  publish(threadId: string): void;
  log: ModeLog;
  now?: () => number;
}

export function modeDepsFrom(bb: BbPluginApi): ModeDeps {
  return {
    pluginId: bb.pluginId,
    listSkills: async (args) => (await bb.sdk.skills.list(args)).skills,
    readSkill: async ({ projectId, environmentId, skillId }) =>
      (await bb.sdk.skills.getContent({ projectId, environmentId, skillId, path: "SKILL.md" })).content,
    kv: bb.storage.kv,
    publish: (threadId) => bb.realtime.publish(MODE_CHANNEL, { threadId }),
    log: { info: (message) => bb.log.info(message), warn: (message) => bb.log.warn(message) },
  };
}

function stateKey(threadId: string): string {
  return `mode:${threadId}`;
}

function rank(skill: SkillListing, providerId: string | null): number {
  if (providerId !== null && skill.provider === providerId) return 0;
  if (skill.provider === null) return 1;
  return 2;
}

function scopeRank(scope: string): number {
  if (scope.endsWith("-project")) return 0;
  if (scope.endsWith("-user")) return 1;
  return 2;
}

export function pickSkills(skills: readonly SkillListing[], providerId: string | null): SkillListing[] {
  const byName = new Map<string, SkillListing>();
  for (const skill of skills) {
    const current = byName.get(skill.name);
    if (current === undefined || rank(skill, providerId) < rank(current, providerId)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((left, right) => scopeRank(left.scope) - scopeRank(right.scope) || left.name.localeCompare(right.name));
}

async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createModeService(deps: ModeDeps) {
  const now = deps.now ?? Date.now;
  const frontmatter = new Map<string, CachedFrontmatter>();
  const refreshing = new Set<string>();

  async function fetchFrontmatter(key: string, projectId: string, environmentId: string | null, skill: SkillListing): Promise<CachedFrontmatter> {
    let entry: CachedFrontmatter;
    try {
      const parsed = splitSkill(await deps.readSkill({ projectId, environmentId, skillId: skill.id })).frontmatter;
      entry = { at: now(), icon: parsed.icon, color: parsed.color, description: parsed.description };
    } catch {
      entry = { at: now(), icon: null, color: null, description: null };
    }
    frontmatter.set(key, entry);
    return entry;
  }

  async function readFrontmatter(projectId: string, environmentId: string | null, skill: SkillListing): Promise<CachedFrontmatter> {
    const key = `${skill.id}\u0000${skill.filePath}`;
    const cached = frontmatter.get(key);
    if (cached === undefined) return fetchFrontmatter(key, projectId, environmentId, skill);
    if (now() - cached.at >= FRONTMATTER_TTL_MS && !refreshing.has(key)) {
      refreshing.add(key);
      void fetchFrontmatter(key, projectId, environmentId, skill).finally(() => refreshing.delete(key));
    }
    return cached;
  }

  async function listModes(args: { projectId: string; environmentId: string | null; providerId: string | null }): Promise<ModeOption[]> {
    const skills = pickSkills(await deps.listSkills({ projectId: args.projectId, environmentId: args.environmentId }), args.providerId);
    return mapLimited(skills, READ_CONCURRENCY, async (skill) => {
      const meta = await readFrontmatter(args.projectId, args.environmentId, skill);
      return {
        skillId: skill.id,
        label: skill.name,
        description: skill.description ?? meta.description,
        path: skill.filePath,
        scope: skill.scope,
        icon: (meta.icon ? findProjectIconName(meta.icon) : null) ?? DEFAULT_MODE_ICON,
        color: modeColorOf(meta.color),
        styled: meta.icon !== null || meta.color !== null,
      };
    });
  }

  async function loadSkill(mention: ModeMention, mode: ModeRef): Promise<LoadedSkill | null> {
    try {
      const skills = await deps.listSkills({ projectId: mention.projectId, environmentId: mention.environmentId });
      const listed = skills.find((skill) => skill.id === mode.skillId);
      if (!listed) return null;
      const content = await deps.readSkill({ projectId: mention.projectId, environmentId: mention.environmentId, skillId: mode.skillId });
      return { path: listed.filePath, body: splitSkill(content).body };
    } catch {
      return null;
    }
  }

  async function readState(threadId: string): Promise<StoredModeState> {
    const stored = await deps.kv.get<StoredModeState>(stateKey(threadId));
    return stored ?? { ...EMPTY_MODE_STATE, notice: null };
  }

  async function writeState(threadId: string, state: StoredModeState): Promise<void> {
    if (state.committed === null && state.draft === null && state.notice === null) await deps.kv.delete(stateKey(threadId));
    else await deps.kv.set(stateKey(threadId), state);
    deps.publish(threadId);
  }

  async function setDraft(threadId: string, draft: ModeRef | null): Promise<StoredModeState> {
    const current = await readState(threadId);
    const next = { ...current, draft };
    await writeState(threadId, next);
    return next;
  }

  async function clearNotice(threadId: string): Promise<void> {
    const current = await readState(threadId);
    if (current.notice !== null) await writeState(threadId, { ...current, notice: null });
  }

  async function resolveMention(itemId: string): Promise<string> {
    const mention = decodeModeMention(itemId);
    if (mention === null) return "";
    const { transition } = mention;
    const skill = transition.kind === "exit" ? null : await loadSkill(mention, transition.mode);
    const context = modeContext(transition, skill);
    const instruction = context.split("\n\n<skill ")[0] ?? "";
    deps.log.info(`mode ${transition.kind}: ${instruction}${skill ? ` [+ ${skill.path ?? "skill"}, ${skill.body.length} chars]` : ""}`);
    return context;
  }

  function mentionsIn(blocks: readonly unknown[]): ModeMention[] {
    const found: ModeMention[] = [];
    for (const block of blocks) {
      const mentions = (block as { mentions?: unknown }).mentions;
      if (!Array.isArray(mentions)) continue;
      for (const entry of mentions) {
        const resource = (entry as { resource?: { kind?: unknown; pluginId?: unknown; itemId?: unknown } }).resource;
        if (resource?.kind !== "plugin" || resource.pluginId !== deps.pluginId || typeof resource.itemId !== "string") continue;
        const prefix = `${MODE_MENTION_PROVIDER}:`;
        const itemId = resource.itemId.startsWith(prefix) ? resource.itemId.slice(prefix.length) : resource.itemId;
        const decoded = decodeModeMention(itemId);
        if (decoded) found.push(decoded);
      }
    }
    return found;
  }

  async function commitDispatch(threadId: string, blocks: readonly unknown[]): Promise<void> {
    const mention = mentionsIn(blocks).at(-1);
    if (!mention) return;
    const { transition } = mention;
    let committed = committedAfter(transition);
    let notice: string | null = null;
    if (committed !== null && (await loadSkill(mention, committed)) === null) {
      notice = missingSkillNotice(committed.label);
      committed = null;
    }
    const stored = await deps.kv.get<StoredModeState>(stateKey(threadId));
    const current = stored ?? { ...EMPTY_MODE_STATE, notice: null };
    const next: ModeState & { notice: string | null } = {
      committed,
      draft: notice !== null ? null : stored === undefined ? committed : current.draft,
      notice: notice ?? current.notice,
    };
    if (sameRef(next.committed, current.committed) && sameRef(next.draft, current.draft) && next.notice === current.notice) return;
    await writeState(threadId, next);
  }

  return { listModes, readState, setDraft, clearNotice, resolveMention, commitDispatch };
}

function sameRef(left: ModeRef | null, right: ModeRef | null): boolean {
  if (left === null || right === null) return left === right;
  return left.skillId === right.skillId && left.label === right.label;
}

export type ModeService = ReturnType<typeof createModeService>;
