import { describe, expect, it } from "vitest";
import { EXIT_NOTE, createExitNoter, exitNoteBlock, hasExitNote, hasModeContext, modeContextBlock, type QueuedRow } from "./exit-note";

const MODE_TEXT = 'You are in reviewer mode. Follow that mode\'s skill on this turn.\n\n<skill name="reviewer">\nRules.\n</skill>';

function setup(options: { flagged?: boolean; mode?: boolean; context?: string | null; rowsAfter?: number } = {}) {
  let flagged = options.flagged ?? false;
  let lists = 0;
  const rows: QueuedRow[] = [
    {
      id: "q1",
      state: "waiting",
      updatedAt: 5,
      content: [{ type: "text", text: "hello", mentions: [] }],
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
    activeMode: async () => (options.mode ? { skillId: "s", label: "reviewer" } : null),
    modeContext: async () => (options.context === undefined ? MODE_TEXT : options.context),
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
  return {
    noter,
    updates,
    get rechecks() {
      return rechecks;
    },
    get flagged() {
      return flagged;
    },
  };
}

const plain = [{ type: "text", text: "hello", mentions: [] }];

async function settle(t: { rechecks: number }) {
  for (let index = 0; index < 20 && t.rechecks === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("exit note", () => {
  it("holds the first message after a mode is left, adds the agent-only note and releases it once", async () => {
    const t = setup({ flagged: true, rowsAfter: 2 });
    expect(await t.noter.decide({ threadId: "thr", initiator: "user", blocks: plain, carriesMode: false })).toEqual({ action: "wait", reason: "Adding the mode note" });
    await settle(t);
    expect(t.updates).toEqual([{ queuedMessageId: "q1", input: [...plain, exitNoteBlock()], expectedUpdatedAt: 5 }]);
    expect(t.flagged).toBe(false);
    expect(await t.noter.decide({ threadId: "thr", initiator: "user", blocks: [...plain, exitNoteBlock()], carriesMode: false, queuedIds: ["q1"] })).toEqual({ action: "proceed" });
    expect(await t.noter.decide({ threadId: "thr", initiator: "user", blocks: plain, carriesMode: false })).toEqual({ action: "proceed" });
  });

  it("drops the note when the next message goes back into a mode", async () => {
    const t = setup({ flagged: true });
    expect(await t.noter.decide({ threadId: "thr", initiator: "user", blocks: plain, carriesMode: true })).toEqual({ action: "proceed" });
    expect(t.flagged).toBe(false);
  });

  it("ignores agent and system messages", async () => {
    const t = setup({ flagged: true, mode: true });
    expect(await t.noter.decide({ threadId: "thr", initiator: "system", blocks: plain, carriesMode: false })).toEqual({ action: "proceed" });
    expect(t.flagged).toBe(true);
  });

  it("is plain agent-only text with no mention", () => {
    expect(exitNoteBlock()).toEqual({ type: "text", text: EXIT_NOTE, visibility: "agent-only", mentions: [] });
    expect(hasExitNote([{ type: "text", text: EXIT_NOTE }])).toBe(false);
    expect(hasExitNote([exitNoteBlock()])).toBe(true);
  });
});

describe("mode context for messages sent without the pill", () => {
  it("holds a user message in an active mode, appends the mode line and skill, and releases it", async () => {
    const t = setup({ mode: true });
    expect(await t.noter.decide({ threadId: "thr", initiator: "user", blocks: plain, carriesMode: false })).toEqual({ action: "wait", reason: "Adding the mode's skill" });
    await settle(t);
    expect(t.updates).toEqual([{ queuedMessageId: "q1", input: [...plain, modeContextBlock(MODE_TEXT)], expectedUpdatedAt: 5 }]);
    expect(await t.noter.decide({ threadId: "thr", initiator: "user", blocks: [...plain, modeContextBlock(MODE_TEXT)], carriesMode: false, queuedIds: ["q1"] })).toEqual({ action: "proceed" });
  });

  it("lets a message that already carries the mode pill straight through", async () => {
    const t = setup({ mode: true });
    expect(await t.noter.decide({ threadId: "thr", initiator: "user", blocks: plain, carriesMode: true })).toEqual({ action: "proceed" });
    expect(t.updates).toEqual([]);
  });

  it("releases the message unchanged when the skill is gone", async () => {
    const t = setup({ mode: true, context: "" });
    await t.noter.decide({ threadId: "thr", initiator: "user", blocks: plain, carriesMode: false });
    await settle(t);
    expect(t.updates).toEqual([]);
    expect(t.rechecks).toBe(1);
    expect(await t.noter.decide({ threadId: "thr", initiator: "user", blocks: plain, carriesMode: false, queuedIds: ["q1"] })).toEqual({ action: "proceed" });
  });

  it("does nothing without an active mode", async () => {
    const t = setup();
    expect(await t.noter.decide({ threadId: "thr", initiator: "user", blocks: plain, carriesMode: false })).toEqual({ action: "proceed" });
  });

  it("recognises its own context block", () => {
    expect(hasModeContext([modeContextBlock(MODE_TEXT)])).toBe(true);
    expect(hasModeContext([{ type: "text", text: MODE_TEXT }])).toBe(false);
  });
});
