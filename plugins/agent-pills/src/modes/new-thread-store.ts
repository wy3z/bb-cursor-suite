import type { ModeRef } from "./model";

const PREFIX = "bb-plugin-agent-pills.new-thread-mode.v1:";

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readNewThreadMode(key: string): ModeRef | null {
  try {
    const raw = storage()?.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ModeRef> | null;
    return parsed && typeof parsed.skillId === "string" && typeof parsed.label === "string"
      ? { skillId: parsed.skillId, label: parsed.label }
      : null;
  } catch {
    return null;
  }
}

export function writeNewThreadMode(key: string, mode: ModeRef | null): void {
  try {
    if (mode === null) storage()?.removeItem(PREFIX + key);
    else storage()?.setItem(PREFIX + key, JSON.stringify(mode));
  } catch {
    return;
  }
}
