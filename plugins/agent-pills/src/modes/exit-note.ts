import type { MessageDispatchHookDecision } from "@get-bb/plugin-sdk";

export const EXIT_NOTE = "No custom mode is active. Stop following earlier mode instructions.";
export const EXIT_NOTE_WAIT_REASON = "Adding the mode note";
export const MODE_CONTEXT_WAIT_REASON = "Adding the mode's skill";

const TAG_ATTEMPTS = 25;
const TAG_DELAY_MS = 40;
const RELEASED_LIMIT = 200;

export interface QueuedRow {
  id: string;
  state: string;
  updatedAt: number;
  content: readonly unknown[];
  waitingOn: { kind: string; pluginId?: string } | null;
}

export interface ExitNoteDeps {
  pluginId: string;
  flag: {
    get(threadId: string): Promise<boolean>;
    clear(threadId: string): Promise<void>;
  };
  activeMode(threadId: string): Promise<unknown | null>;
  modeContext(threadId: string): Promise<string | null>;
  listQueued(threadId: string): Promise<QueuedRow[]>;
  updateQueued(args: { threadId: string; queuedMessageId: string; input: unknown[]; expectedUpdatedAt: number }): Promise<void>;
  recheck(): Promise<void>;
  log: { warn(message: string): void };
  sleep?: (ms: number) => Promise<void>;
}

export interface ExitNoteDispatch {
  threadId: string;
  initiator: string;
  blocks: readonly unknown[];
  carriesMode: boolean;
  queuedIds?: readonly string[];
}

type NoteKind = "exit" | "mode";

export function exitNoteBlock() {
  return { type: "text", text: EXIT_NOTE, visibility: "agent-only", mentions: [] };
}

export function modeContextBlock(context: string) {
  return { type: "text", text: context, visibility: "agent-only", mentions: [] };
}

function agentOnlyTexts(blocks: readonly unknown[]): string[] {
  return blocks.flatMap((block) => {
    const value = block as { type?: unknown; text?: unknown; visibility?: unknown };
    return value.type === "text" && value.visibility === "agent-only" && typeof value.text === "string" ? [value.text] : [];
  });
}

export function hasExitNote(blocks: readonly unknown[]): boolean {
  return agentOnlyTexts(blocks).some((text) => text === EXIT_NOTE);
}

export function hasModeContext(blocks: readonly unknown[]): boolean {
  return agentOnlyTexts(blocks).some((text) => text.startsWith("You are in ") && text.includes("<skill name="));
}

export function createExitNoter(deps: ExitNoteDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tagging = new Set<string>();
  const released: string[] = [];

  async function blocksFor(threadId: string, kind: NoteKind): Promise<unknown[]> {
    if (kind === "exit") return [exitNoteBlock()];
    const context = await deps.modeContext(threadId);
    return context ? [modeContextBlock(context)] : [];
  }

  async function tag(threadId: string, kind: NoteKind = "exit"): Promise<void> {
    if (tagging.has(threadId)) return;
    tagging.add(threadId);
    try {
      for (let attempt = 0; attempt < TAG_ATTEMPTS; attempt += 1) {
        const rows = await deps.listQueued(threadId);
        const held = rows.find(
          (row) => row.state === "waiting" && row.waitingOn?.kind === "plugin" && row.waitingOn.pluginId === deps.pluginId,
        );
        if (held) {
          const already = kind === "exit" ? hasExitNote(held.content) : hasModeContext(held.content);
          const added = already ? [] : await blocksFor(threadId, kind);
          if (added.length > 0) {
            await deps.updateQueued({
              threadId,
              queuedMessageId: held.id,
              input: [...held.content, ...added],
              expectedUpdatedAt: held.updatedAt,
            });
          }
          released.push(held.id);
          if (released.length > RELEASED_LIMIT) released.splice(0, released.length - RELEASED_LIMIT);
          if (kind === "exit") await deps.flag.clear(threadId);
          await deps.recheck();
          return;
        }
        await sleep(TAG_DELAY_MS);
      }
      deps.log.warn(`Held a message to add mode context, but never found it queued on ${threadId}`);
      await deps.recheck();
    } catch (cause) {
      deps.log.warn(`Could not add mode context: ${cause instanceof Error ? cause.message : String(cause)}`);
      await deps.recheck().catch(() => undefined);
    } finally {
      tagging.delete(threadId);
    }
  }

  async function decide(dispatch: ExitNoteDispatch): Promise<MessageDispatchHookDecision> {
    if (dispatch.initiator !== "user") return { action: "proceed" };
    if (dispatch.carriesMode) {
      await deps.flag.clear(dispatch.threadId);
      return { action: "proceed" };
    }
    const releasedHere = (dispatch.queuedIds ?? []).filter((id) => released.includes(id));
    if (releasedHere.length > 0 || hasExitNote(dispatch.blocks) || hasModeContext(dispatch.blocks)) {
      for (const id of releasedHere) released.splice(released.indexOf(id), 1);
      if (hasExitNote(dispatch.blocks)) await deps.flag.clear(dispatch.threadId);
      return { action: "proceed" };
    }
    if (await deps.flag.get(dispatch.threadId)) {
      void tag(dispatch.threadId, "exit");
      return { action: "wait", reason: EXIT_NOTE_WAIT_REASON };
    }
    if ((await deps.activeMode(dispatch.threadId)) !== null) {
      void tag(dispatch.threadId, "mode");
      return { action: "wait", reason: MODE_CONTEXT_WAIT_REASON };
    }
    return { action: "proceed" };
  }

  return { decide, tag };
}
