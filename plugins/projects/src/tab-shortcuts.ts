export interface TabShortcutKey {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  getModifierState(key: string): boolean;
}

export interface TabShortcutEvent extends TabShortcutKey {
  preventDefault(): void;
  stopPropagation(): void;
}

const DIGIT_CODE = /^Digit([1-9])$/;
const LAST_SLOT = 9;

export function tabShortcutSlot(event: TabShortcutKey): number | null {
  if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return null;
  if (event.getModifierState("AltGraph")) return null;
  const match = DIGIT_CODE.exec(event.code);
  return match ? Number(match[1]) : null;
}

export function tabForSlot(tabs: readonly string[], slot: number): string | null {
  if (slot === LAST_SLOT) return tabs.at(-1) ?? null;
  return tabs[slot - 1] ?? null;
}

export function handleTabShortcut(event: TabShortcutEvent, tabs: readonly string[], selectedId: string | null, select: (id: string) => void): boolean {
  const slot = tabShortcutSlot(event);
  if (slot === null) return false;
  const target = tabForSlot(tabs, slot);
  if (target === null || target === selectedId) return false;
  select(target);
  event.preventDefault();
  event.stopPropagation();
  return true;
}
