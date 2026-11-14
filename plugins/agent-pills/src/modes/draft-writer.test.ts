import { describe, expect, it } from "vitest";
import { createDraftWriter, type DraftWriteResult } from "./draft-writer";
import type { ModeRef } from "./model";
import type { ThreadModeState } from "./rpc";

const A: ModeRef = { skillId: "skill_a", label: "alpha" };
const B: ModeRef = { skillId: "skill_b", label: "beta" };
const C: ModeRef = { skillId: "skill_c", label: "gamma" };

function server(initial: ThreadModeState = { committed: null, draft: null, rev: 0, notice: null }) {
  let state = initial;
  const calls: Array<[string | null, number]> = [];
  const gates: Array<() => void> = [];
  return {
    calls,
    get state() {
      return state;
    },
    otherTab(mode: ModeRef | null) {
      state = { ...state, draft: mode, rev: state.rev + 1 };
    },
    release() {
      gates.shift()?.();
    },
    write: (mode: ModeRef | null, rev: number): Promise<DraftWriteResult> =>
      new Promise((resolve) => {
        gates.push(() => {
          calls.push([mode?.label ?? null, rev]);
          if (rev !== state.rev) return resolve({ ok: false, state });
          state = { ...state, draft: mode, rev: state.rev + 1 };
          resolve({ ok: true, state });
        });
      }),
  };
}

async function drain(fake: ReturnType<typeof server>, run: Promise<void> | void) {
  for (let index = 0; index < 10; index += 1) {
    fake.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await run;
}

describe("draft writer", () => {
  it("coalesces rapid choices and lands the latest one", async () => {
    const fake = server();
    const settled: ThreadModeState[] = [];
    const writer = createDraftWriter({ write: fake.write, settled: (state) => settled.push(state), failed: () => undefined });
    const run = writer.choose(A);
    writer.choose(B);
    writer.choose(C);
    await drain(fake, run);
    expect(fake.calls).toEqual([
      ["alpha", 0],
      ["gamma", 1],
    ]);
    expect(fake.state).toMatchObject({ draft: C, rev: 2 });
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ draft: C });
  });

  it("retries the latest choice against the revision a conflict returns", async () => {
    const fake = server();
    fake.otherTab(A);
    const settled: ThreadModeState[] = [];
    const writer = createDraftWriter({ write: fake.write, settled: (state) => settled.push(state), failed: () => undefined });
    const run = writer.choose(B);
    await drain(fake, run);
    expect(fake.calls).toEqual([
      ["beta", 0],
      ["beta", 1],
    ]);
    expect(settled.at(-1)).toMatchObject({ draft: B, rev: 2 });
  });

  it("gives up after repeated conflicts and shows what the server has", async () => {
    const fake = server();
    const settled: ThreadModeState[] = [];
    const writer = createDraftWriter({
      write: async (mode, rev) => {
        fake.otherTab(A);
        return fake.write(mode, rev).then((result) => result);
      },
      settled: (state) => settled.push(state),
      failed: () => undefined,
      maxConflicts: 2,
    });
    const run = writer.choose(B);
    await drain(fake, run);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.draft).toEqual(A);
  });

  it("reports a failed write so the caller can reload", async () => {
    let failed = 0;
    const writer = createDraftWriter({
      write: async () => {
        throw new Error("offline");
      },
      settled: () => undefined,
      failed: () => {
        failed += 1;
      },
    });
    await writer.choose(A);
    expect(failed).toBe(1);
    expect(writer.busy).toBe(false);
  });
});
