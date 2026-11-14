import type { MessageDispatchHookDecision } from "@get-bb/plugin-sdk";

export const EXIT_NOTE = "No custom mode is active. Stop following earlier mode instructions.";
export const EXIT_NOTE_WAIT_REASON = "Adding the mode note";

const TAG_ATTEMPTS = 25;
const TAG_DELAY_MS = 40;

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
}

export function exitNoteBlock() {
  return { type: "text", text: EXIT_NOTE, visibility: "agent-only", mentions: [] };
}

export function hasExitNote(blocks: readonly unknown[]): boolean {
  return blocks.some((block) => {
    const value = block as { type?: unknown; text?: unknown; visibility?: unknown };
    return value.type === "text" && value.visibility === "agent-only" && value.text === EXIT_NOTE;
  });
}

export function createExitNoter(deps: ExitNoteDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tagging = new Set<string>();

  async function tag(threadId: string): Promise<void> {
    if (tagging.has(threadId)) return;
    tagging.add(threadId);
    try {
      for (let attempt = 0; attempt < TAG_ATTEMPTS; attempt += 1) {
        const rows = await deps.listQueued(threadId);
        const held = rows.find(
          (row) => row.state === "waiting" && row.waitingOn?.kind === "plugin" && row.waitingOn.pluginId === deps.pluginId,
        );
        if (held) {
          if (!hasExitNote(held.content)) {
            await deps.updateQueued({
              threadId,
              queuedMessageId: held.id,
              input: [...held.content, exitNoteBlock()],
              expectedUpdatedAt: held.updatedAt,
            });
          }
          await deps.recheck();
          return;
        }
        await sleep(TAG_DELAY_MS);
      }
      deps.log.warn(`Held a message to add the mode note, but never found it queued on ${threadId}`);
      await deps.recheck();
    } catch (cause) {
      deps.log.warn(`Could not add the mode note: ${cause instanceof Error ? cause.message : String(cause)}`);
      await deps.recheck().catch(() => undefined);
    } finally {
      tagging.delete(threadId);
    }
  }

  async function decide(dispatch: ExitNoteDispatch): Promise<MessageDispatchHookDecision> {
    if (dispatch.initiator !== "user") return { action: "proceed" };
    if (!(await deps.flag.get(dispatch.threadId))) return { action: "proceed" };
    if (dispatch.carriesMode || hasExitNote(dispatch.blocks)) {
      await deps.flag.clear(dispatch.threadId);
      return { action: "proceed" };
    }
    void tag(dispatch.threadId);
    return { action: "wait", reason: EXIT_NOTE_WAIT_REASON };
  }

  return { decide, tag };
}
