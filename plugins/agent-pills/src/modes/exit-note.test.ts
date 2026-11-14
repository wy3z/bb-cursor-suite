import { describe, expect, it } from "vitest";
import { EXIT_NOTE, createExitNoter, exitNoteBlock, hasExitNote, type QueuedRow } from "./exit-note";

function setup(options: { flagged?: boolean; rowsAfter?: number } = {}) {
  let flagged = options.flagged ?? true;
  let lists = 0;
  const rows: QueuedRow[] = [
    {
      id: "q1",
      state: "waiting",
      updatedAt: 5,
      content: [{ type: "text", text: "Are you still in a mode?", mentions: [] }],
      waitingOn: { kind: "plugin", pluginId: "agent-pills" },
    },
  ];
  const updates: Array<{ queuedMessageId: string; input: unknown[]; expectedUpdatedAt: number }> = [];
  let rechecks = 0;
  const noter = createExitNoter({
    pluginId: "agent-pills",
    flag: {
      get: async () => flagged,
      clear: async () => {
        flagged = false;
      },
    },
    listQueued: async () => {
      lists += 1;
      return lists > (options.rowsAfter ?? 0) ? rows : [];
    },
    updateQueued: async ({ queuedMessageId, input, expectedUpdatedAt }) => void updates.push({ queuedMessageId, input, expectedUpdatedAt }),
    recheck: async () => {
      rechecks += 1;
    },
    log: { warn: () => undefined },
    sleep: async () => undefined,
  });
  return { noter, updates, get rechecks() { return rechecks; }, get flagged() { return flagged; } };
}

const plain = [{ type: "text", text: "Are you still in a mode?", mentions: [] }];

describe("exit note", () => {
  it("holds the first message after a mode is left, adds the agent-only note and releases it", async () => {
    const t = setup({ rowsAfter: 2 });
    const decision = await t.noter.decide({ threadId: "thr", initiator: "user", blocks: plain, carriesMode: false });
    expect(decision).toEqual({ action: "wait", reason: "Adding the mode note" });
    for (let index = 0; index < 20 && t.rechecks === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.updates).toEqual([{ queuedMessageId: "q1", input: [...plain, exitNoteBlock()], expectedUpdatedAt: 5 }]);
    expect(t.rechecks).toBe(1);
    expect(t.flagged).toBe(true);
  });

  it("lets the noted message through and sends the note only once", async () => {
    const t = setup();
    const noted = [...plain, exitNoteBlock()];
    expect(await t.noter.decide({ threadId: "thr", initiator: "user", blocks: noted, carriesMode: false })).toEqual({ action: "proceed" });
    expect(t.flagged).toBe(false);
    expect(await t.noter.decide({ threadId: "thr", initiator: "user", blocks: plain, carriesMode: false })).toEqual({ action: "proceed" });
  });

  it("drops the note when the next message goes back into a mode", async () => {
    const t = setup();
    expect(await t.noter.decide({ threadId: "thr", initiator: "user", blocks: plain, carriesMode: true })).toEqual({ action: "proceed" });
    expect(t.flagged).toBe(false);
  });

  it("ignores agent and system messages", async () => {
    const t = setup();
    expect(await t.noter.decide({ threadId: "thr", initiator: "system", blocks: plain, carriesMode: false })).toEqual({ action: "proceed" });
    expect(t.flagged).toBe(true);
  });

  it("does nothing without a pending note", async () => {
    const t = setup({ flagged: false });
    expect(await t.noter.decide({ threadId: "thr", initiator: "user", blocks: plain, carriesMode: false })).toEqual({ action: "proceed" });
  });

  it("is plain agent-only text with no mention", () => {
    expect(exitNoteBlock()).toEqual({ type: "text", text: EXIT_NOTE, visibility: "agent-only", mentions: [] });
    expect(EXIT_NOTE).toBe("No custom mode is active. Stop following earlier mode instructions.");
    expect(hasExitNote([{ type: "text", text: EXIT_NOTE }])).toBe(false);
    expect(hasExitNote([exitNoteBlock()])).toBe(true);
  });
});
