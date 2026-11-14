import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { findProjectIconName } from "@wy3z/bb-suite/project-icon";
import {
  DEFAULT_MODE_ICON,
  decodeModeMention,
  fixedTitle,
  missingSkillNotice,
  modeColorOf,
  modeContext,
  ownWords,
  pillLabel,
  splitSkill,
  transitionOf,
  type LoadedSkill,
  type ModeMention,
  type ModeRef,
} from "./model";
import { EMPTY_LEDGER, LEDGER_EVENT_TYPES, applyLedgerEvents, committedOf, seenNonces, type Ledger, type LedgerEvent } from "./ledger";
import type { ModeOption, ThreadModeState } from "./rpc";
import { MODE_CHANNEL, MODE_MENTION_PROVIDER, MODES_CHANNEL } from "./channel";

export { MODE_CHANNEL, MODE_MENTION_PROVIDER, MODES_CHANNEL };

const FRONTMATTER_TTL_MS = 30_000;
const READ_CONCURRENCY = 8;
const FRONTMATTER_KEY = "frontmatter:v1";
const FRONTMATTER_LIMIT = 2000;
const TITLE_FIX_DELAY_MS = 20_000;
const PENDING_TTL_MS = 20_000;
const EVENT_PAGE = 100;
const MODE_ITEM_PREFIX = `${MODE_MENTION_PROVIDER}:`;

export interface SkillListing {
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
  mode: boolean;
}

export interface TitleFix {
  threadId: string;
  label: string;
  own: string;
}

export interface ModeLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface ThreadPlace {
  projectId: string;
  environmentId: string | null;
}

export interface ModeDeps {
  pluginId: string;
  listSkills(args: { projectId: string; environmentId: string | null }): Promise<SkillListing[]>;
  readSkill(args: { projectId: string; environmentId: string | null; skillId: string }): Promise<string>;
  readEvents(args: { threadId: string; afterSeq: number; limit: number }): Promise<LedgerEvent[]>;
  threadPlace(threadId: string): Promise<ThreadPlace | null>;
  kv: Pick<BbPluginApi["storage"]["kv"], "get" | "set" | "delete">;
  publish(threadId: string): void;
  publishModes(projectId: string): void;
  log: ModeLog;
  now?: () => number;
}

export function modeDepsFrom(bb: BbPluginApi): ModeDeps {
  return {
    pluginId: bb.pluginId,
    listSkills: async (args) => (await bb.sdk.skills.list(args)).skills,
    readSkill: async ({ projectId, environmentId, skillId }) =>
      (await bb.sdk.skills.getContent({ projectId, environmentId, skillId, path: "SKILL.md" })).content,
    readEvents: async ({ threadId, afterSeq, limit }) =>
      (
        await bb.sdk.threads.events.list({
          threadId,
          afterSeq: String(afterSeq),
          limit: String(limit),
          order: "asc",
          types: [...LEDGER_EVENT_TYPES],
        })
      ).map((row) => ({ seq: row.seq, type: row.type, data: row.data })),
    threadPlace: async (threadId) => {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        return { projectId: thread.projectId, environmentId: thread.environmentId };
      } catch {
        return null;
      }
    },
    kv: bb.storage.kv,
    publish: (threadId) => bb.realtime.publish(MODE_CHANNEL, { threadId }),
    publishModes: (projectId) => bb.realtime.publish(MODES_CHANNEL, { projectId }),
    log: { info: (message) => bb.log.info(message), warn: (message) => bb.log.warn(message) },
  };
}

interface StoredDraft {
  draft: ModeRef | null;
  rev: number;
}

interface Pending {
  nonce: string;
  committed: ModeRef | null;
  at: number;
}

function draftKey(threadId: string): string {
  return `draft:${threadId}`;
}

function noticeKey(threadId: string): string {
  return `notice:${threadId}`;
}

function sameRef(left: ModeRef | null, right: ModeRef | null): boolean {
  if (left === null || right === null) return left === right;
  return left.skillId === right.skillId && left.label === right.label;
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
  const refreshing = new Map<string, Promise<void>>();
  let loaded: Promise<void> | null = null;

  function frontmatterKey(skill: SkillListing): string {
    return `${skill.id}\u0000${skill.filePath}`;
  }

  function ensureLoaded(): Promise<void> {
    loaded ??= deps.kv
      .get<Record<string, CachedFrontmatter>>(FRONTMATTER_KEY)
      .then((stored) => {
        for (const [key, entry] of Object.entries(stored ?? {})) {
          if (!frontmatter.has(key)) frontmatter.set(key, { ...entry, at: 0 });
        }
      })
      .catch(() => undefined);
    return loaded;
  }

  async function persist(): Promise<void> {
    const entries = [...frontmatter.entries()].slice(-FRONTMATTER_LIMIT);
    await deps.kv.set(FRONTMATTER_KEY, Object.fromEntries(entries)).catch(() => undefined);
  }

  async function readFrontmatter(projectId: string, environmentId: string | null, skill: SkillListing): Promise<CachedFrontmatter> {
    try {
      const parsed = splitSkill(await deps.readSkill({ projectId, environmentId, skillId: skill.id })).frontmatter;
      return { at: now(), icon: parsed.icon, color: parsed.color, description: parsed.description, mode: parsed.mode };
    } catch {
      return { at: now(), icon: null, color: null, description: null, mode: false };
    }
  }

  function sameMeta(left: CachedFrontmatter | undefined, right: CachedFrontmatter): boolean {
    return left !== undefined && left.icon === right.icon && left.color === right.color && left.description === right.description && left.mode === right.mode;
  }

  function refreshFrontmatter(projectId: string, environmentId: string | null, skills: readonly SkillListing[]): Promise<void> {
    const workspace = `${projectId}\u0000${environmentId ?? ""}`;
    const running = refreshing.get(workspace);
    if (running) return running;
    const run = (async () => {
      let changed = false;
      await mapLimited(skills, READ_CONCURRENCY, async (skill) => {
        const key = frontmatterKey(skill);
        const next = await readFrontmatter(projectId, environmentId, skill);
        if (!sameMeta(frontmatter.get(key), next)) changed = true;
        frontmatter.set(key, next);
      });
      if (changed) {
        await persist();
        deps.publishModes(projectId);
      }
    })().finally(() => refreshing.delete(workspace));
    refreshing.set(workspace, run);
    return run;
  }

  function optionOf(skill: SkillListing): ModeOption {
    const meta = frontmatter.get(frontmatterKey(skill));
    const icon = meta?.icon ?? null;
    const color = meta?.color ?? null;
    return {
      skillId: skill.id,
      label: skill.name,
      description: skill.description ?? meta?.description ?? null,
      path: skill.filePath,
      scope: skill.scope,
      icon: (icon ? findProjectIconName(icon) : null) ?? DEFAULT_MODE_ICON,
      color: modeColorOf(color),
      styled: icon !== null || color !== null,
      mode: meta?.mode ?? false,
    };
  }

  async function listModes(args: {
    projectId: string;
    environmentId: string | null;
    providerId: string | null;
    excludeUserSkills?: boolean;
  }): Promise<ModeOption[]> {
    await ensureLoaded();
    const listed = await deps.listSkills({ projectId: args.projectId, environmentId: args.environmentId });
    const skills = pickSkills(
      args.excludeUserSkills ? listed.filter((skill) => !skill.scope.endsWith("-user")) : listed,
      args.providerId,
    );
    const stale = skills.filter((skill) => {
      const cached = frontmatter.get(frontmatterKey(skill));
      return cached === undefined || now() - cached.at >= FRONTMATTER_TTL_MS;
    });
    if (stale.length > 0) void refreshFrontmatter(args.projectId, args.environmentId, stale).catch(() => undefined);
    const options = skills.map(optionOf);
    return [...options.filter((option) => option.mode), ...options.filter((option) => !option.mode)];
  }

  async function settled(): Promise<void> {
    while (refreshing.size > 0) await Promise.all(refreshing.values());
  }

  const ledgers = new Map<string, Ledger>();
  const pending = new Map<string, Pending[]>();
  const queues = new Map<string, Promise<unknown>>();
  const handoffNotices = new Map<string, string>();

  function serial<T>(threadId: string, run: () => Promise<T>): Promise<T> {
    const previous = queues.get(threadId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settledNext = next.catch(() => undefined);
    queues.set(threadId, settledNext);
    void settledNext.then(() => {
      if (queues.get(threadId) === settledNext) queues.delete(threadId);
    });
    return next;
  }

  async function catchUp(threadId: string): Promise<Ledger> {
    let ledger = ledgers.get(threadId) ?? EMPTY_LEDGER;
    for (;;) {
      const events = await deps.readEvents({ threadId, afterSeq: ledger.lastSeq, limit: EVENT_PAGE });
      ledger = applyLedgerEvents(ledger, events, deps.pluginId);
      if (events.length < EVENT_PAGE) break;
    }
    ledgers.set(threadId, ledger);
    const logged = seenNonces(ledger);
    const live = (pending.get(threadId) ?? []).filter((entry) => !logged.has(entry.nonce) && now() - entry.at < PENDING_TTL_MS);
    if (live.length > 0) pending.set(threadId, live);
    else pending.delete(threadId);
    return ledger;
  }

  function committedNow(threadId: string, ledger: Ledger, exceptNonce?: string): ModeRef | null {
    const inFlight = (pending.get(threadId) ?? []).filter((entry) => entry.nonce !== exceptNonce);
    return inFlight.length > 0 ? inFlight.at(-1)!.committed : committedOf(ledger);
  }

  async function loadSkill(place: ThreadPlace, mode: ModeRef): Promise<LoadedSkill | null> {
    try {
      const skills = await deps.listSkills(place);
      const listed = skills.find((skill) => skill.id === mode.skillId) ?? skills.find((skill) => skill.name === mode.label);
      if (!listed) return null;
      const content = await deps.readSkill({ ...place, skillId: listed.id });
      return { path: listed.filePath, body: splitSkill(content).body };
    } catch {
      return null;
    }
  }

  async function storedDraft(threadId: string): Promise<StoredDraft | undefined> {
    return deps.kv.get<StoredDraft>(draftKey(threadId));
  }

  async function readState(threadId: string): Promise<ThreadModeState> {
    return serial(threadId, async () => {
      const ledger = await catchUp(threadId);
      const committed = committedNow(threadId, ledger);
      const stored = await storedDraft(threadId);
      const notice = (await deps.kv.get<string>(noticeKey(threadId))) ?? null;
      return { committed, draft: stored ? stored.draft : committed, rev: stored?.rev ?? 0, notice };
    });
  }

  async function writeDraft(threadId: string, draft: ModeRef | null, rev: number): Promise<void> {
    await deps.kv.set(draftKey(threadId), { draft, rev } satisfies StoredDraft);
  }

  async function setDraft(threadId: string, draft: ModeRef | null, expectedRev: number): Promise<{ ok: boolean; state: ThreadModeState }> {
    const ok = await serial(threadId, async () => {
      const current = (await storedDraft(threadId))?.rev ?? 0;
      if (current !== expectedRev) return false;
      await writeDraft(threadId, draft, current + 1);
      return true;
    });
    if (ok) deps.publish(threadId);
    return { ok, state: await readState(threadId) };
  }

  async function clearNotice(threadId: string): Promise<void> {
    await deps.kv.delete(noticeKey(threadId));
  }

  async function dropMissingMode(threadId: string, label: string): Promise<void> {
    const current = await storedDraft(threadId);
    await writeDraft(threadId, null, (current?.rev ?? 0) + 1);
    await deps.kv.set(noticeKey(threadId), missingSkillNotice(label));
  }

  async function contextFor(mention: ModeMention, committed: ModeRef | null, place: ThreadPlace) {
    const transition = transitionOf({ committed, draft: mention.dest });
    const skill = mention.dest === null || transition.kind === "none" ? null : await loadSkill(place, mention.dest);
    const context = modeContext(transition, skill);
    const after = mention.dest !== null && skill !== null ? mention.dest : null;
    const missing = mention.dest !== null && skill === null ? mention.dest : null;
    const instruction = context.split("\n\n<skill ")[0] ?? "";
    deps.log.info(`mode ${transition.kind}${missing ? " (skill missing)" : ""}: ${instruction}${skill ? ` [+ ${skill.path ?? "skill"}, ${skill.body.length} chars]` : ""}`);
    return { context, after, missing };
  }

  async function resolveMention(itemId: string): Promise<string> {
    const mention = decodeModeMention(itemId);
    if (mention === null) return "";
    const threadId = mention.threadId;
    if (threadId === null) {
      const { context, missing } = await contextFor(mention, null, { projectId: mention.projectId, environmentId: mention.environmentId });
      if (missing) handoffNotices.set(mention.nonce, missing.label);
      return context;
    }
    const result = await serial(threadId, async () => {
      const ledger = await catchUp(threadId).catch((cause) => {
        deps.log.warn(`Could not read the thread log before resolving its mode: ${cause instanceof Error ? cause.message : String(cause)}`);
        return ledgers.get(threadId) ?? EMPTY_LEDGER;
      });
      const committed = committedNow(threadId, ledger, mention.nonce);
      const place = (await deps.threadPlace(threadId)) ?? { projectId: mention.projectId, environmentId: mention.environmentId };
      const outcome = await contextFor(mention, committed, place);
      const others = (pending.get(threadId) ?? []).filter((entry) => entry.nonce !== mention.nonce);
      pending.set(threadId, [...others, { nonce: mention.nonce, committed: outcome.after, at: now() }]);
      if (outcome.missing) await dropMissingMode(threadId, outcome.missing.label);
      return outcome;
    });
    deps.publish(threadId);
    return result.context;
  }

  function mentionsIn(blocks: readonly unknown[]): ModeMention[] {
    const found: ModeMention[] = [];
    for (const block of blocks) {
      const mentions = (block as { mentions?: unknown }).mentions;
      if (!Array.isArray(mentions)) continue;
      for (const entry of mentions) {
        const resource = (entry as { resource?: { kind?: unknown; pluginId?: unknown; itemId?: unknown } }).resource;
        if (resource?.kind !== "plugin" || resource.pluginId !== deps.pluginId || typeof resource.itemId !== "string") continue;
        const itemId = resource.itemId.startsWith(MODE_ITEM_PREFIX) ? resource.itemId.slice(MODE_ITEM_PREFIX.length) : resource.itemId;
        const decoded = decodeModeMention(itemId);
        if (decoded) found.push(decoded);
      }
    }
    return found;
  }

  async function admit(threadId: string, blocks: readonly unknown[]): Promise<void> {
    const handoff = mentionsIn(blocks).find((mention) => mention.threadId === null);
    if (!handoff) return;
    const changed = await serial(threadId, async () => {
      const notice = handoffNotices.get(handoff.nonce);
      handoffNotices.delete(handoff.nonce);
      if (notice !== undefined) {
        await deps.kv.set(noticeKey(threadId), missingSkillNotice(notice));
        if ((await storedDraft(threadId)) === undefined) await writeDraft(threadId, null, 1);
        return true;
      }
      if ((await storedDraft(threadId)) !== undefined) return false;
      await writeDraft(threadId, handoff.dest, 1);
      return true;
    });
    if (changed) deps.publish(threadId);
  }

  async function observe(threadId: string): Promise<void> {
    if (!ledgers.has(threadId)) return;
    const changed = await serial(threadId, async () => {
      const before = committedNow(threadId, ledgers.get(threadId)!);
      const ledger = await catchUp(threadId);
      return !sameRef(before, committedNow(threadId, ledger));
    });
    if (changed) deps.publish(threadId);
  }

  function titleFixFor(thread: { id: string; title: string | null; titleFallback: string | null }, blocks: readonly unknown[]): TitleFix | null {
    if (thread.title !== null) return null;
    const text = blocks
      .filter((block) => {
        const value = block as { type?: unknown; visibility?: unknown };
        return value.type === "text" && value.visibility !== "agent-only";
      })
      .map((block) => String((block as { text?: unknown }).text ?? "").trim())
      .join(" ");
    const mention = mentionsIn(blocks)[0];
    if (!mention) return null;
    const label = pillLabel(transitionOf({ committed: mention.leaving, draft: mention.dest }));
    if (label === null || !thread.titleFallback?.startsWith(`${label} `)) return null;
    const own = ownWords(text, label);
    return own === null ? null : { threadId: thread.id, label, own };
  }

  return { listModes, settled, readState, setDraft, clearNotice, resolveMention, admit, observe, titleFixFor };
}

export interface TitleFixDeps {
  getThread(threadId: string): Promise<{ title: string | null; titleFallback: string | null }>;
  setTitle(threadId: string, title: string): Promise<void>;
  log: ModeLog;
  delayMs?: number;
}

export function createTitleFixer(deps: TitleFixDeps) {
  const pending = new Map<string, { fix: TitleFix; timer: ReturnType<typeof setTimeout> }>();

  async function apply(threadId: string): Promise<void> {
    const entry = pending.get(threadId);
    if (!entry) return;
    pending.delete(threadId);
    clearTimeout(entry.timer);
    try {
      const title = fixedTitle(await deps.getThread(threadId), entry.fix.label, entry.fix.own);
      if (title !== null) await deps.setTitle(threadId, title);
    } catch (cause) {
      deps.log.warn(`Could not keep the mode pill out of the thread title: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  function track(fix: TitleFix): void {
    if (pending.has(fix.threadId)) return;
    const timer = setTimeout(() => void apply(fix.threadId), deps.delayMs ?? TITLE_FIX_DELAY_MS);
    pending.set(fix.threadId, { fix, timer });
  }

  function dispose(): void {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
  }

  return { track, apply, dispose };
}
