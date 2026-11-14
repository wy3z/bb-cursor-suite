import { sameMode, type ModeRef } from "./model";
import type { ThreadModeState } from "./rpc";

export interface DraftWriteResult {
  ok: boolean;
  state: ThreadModeState;
}

export interface DraftWriterOptions {
  write(mode: ModeRef | null, rev: number): Promise<DraftWriteResult>;
  settled(state: ThreadModeState): void;
  failed(): void;
  maxConflicts?: number;
}

export function createDraftWriter(options: DraftWriterOptions) {
  const maxConflicts = options.maxConflicts ?? 3;
  let wanted: { mode: ModeRef | null } | null = null;
  let running = false;
  let rev = 0;

  async function run(): Promise<void> {
    running = true;
    let conflicts = 0;
    try {
      while (wanted !== null) {
        const target = wanted.mode;
        let result: DraftWriteResult;
        try {
          result = await options.write(target, rev);
        } catch {
          wanted = null;
          options.failed();
          return;
        }
        rev = result.state.rev;
        const latest = wanted;
        if (result.ok) {
          conflicts = 0;
          if (latest !== null && sameMode(latest.mode, target) && latest.mode?.label === target?.label) {
            wanted = null;
            options.settled(result.state);
          }
          continue;
        }
        conflicts += 1;
        if (conflicts >= maxConflicts) {
          wanted = null;
          options.settled(result.state);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    know(state: ThreadModeState): void {
      if (!running) rev = state.rev;
    },
    choose(mode: ModeRef | null): Promise<void> | void {
      wanted = { mode };
      if (!running) return run();
    },
    get pending(): ModeRef | null | undefined {
      return wanted === null ? undefined : wanted.mode;
    },
    get busy(): boolean {
      return running;
    },
  };
}
