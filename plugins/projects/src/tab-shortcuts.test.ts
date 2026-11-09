import { describe, expect, it } from "vitest";
import { handleTabShortcut, tabForSlot, tabShortcutSlot, type TabShortcutEvent } from "./tab-shortcuts";

function key(code: string, overrides: Partial<Omit<TabShortcutEvent, "getModifierState">> & { altGraph?: boolean } = {}) {
  const { altGraph = false, ...rest } = overrides;
  const calls = { prevented: 0, stopped: 0 };
  const event: TabShortcutEvent = {
    code,
    ctrlKey: true,
    altKey: true,
    shiftKey: false,
    metaKey: false,
    getModifierState: (name) => name === "AltGraph" && altGraph,
    preventDefault: () => void calls.prevented++,
    stopPropagation: () => void calls.stopped++,
    ...rest,
  };
  return { event, calls };
}

describe("tabShortcutSlot", () => {
  it("matches Ctrl+Alt+Digit1 to Digit9", () => {
    for (let n = 1; n <= 9; n++) expect(tabShortcutSlot(key(`Digit${n}`).event)).toBe(n);
  });

  it("ignores Digit0, numpad digits and letters", () => {
    expect(tabShortcutSlot(key("Digit0").event)).toBeNull();
    expect(tabShortcutSlot(key("Numpad1").event)).toBeNull();
    expect(tabShortcutSlot(key("KeyA").event)).toBeNull();
  });

  it("matches on the physical key, not the typed character", () => {
    expect(tabShortcutSlot({ ...key("Digit2").event, key: "é" } as TabShortcutEvent)).toBe(2);
  });

  it("needs both Ctrl and Alt", () => {
    expect(tabShortcutSlot(key("Digit1", { ctrlKey: false }).event)).toBeNull();
    expect(tabShortcutSlot(key("Digit1", { altKey: false }).event)).toBeNull();
  });

  it("skips Shift and Meta", () => {
    expect(tabShortcutSlot(key("Digit1", { shiftKey: true }).event)).toBeNull();
    expect(tabShortcutSlot(key("Digit1", { metaKey: true }).event)).toBeNull();
  });

  it("skips AltGr, which many layouts report as Ctrl+Alt", () => {
    expect(tabShortcutSlot(key("Digit2", { altGraph: true }).event)).toBeNull();
    expect(tabShortcutSlot(key("Digit7", { altGraph: true }).event)).toBeNull();
  });
});

describe("tabForSlot", () => {
  const tabs = ["lead", "a", "b"];

  it("picks the Nth tab", () => {
    expect(tabForSlot(tabs, 1)).toBe("lead");
    expect(tabForSlot(tabs, 3)).toBe("b");
  });

  it("returns nothing past the end", () => {
    expect(tabForSlot(tabs, 4)).toBeNull();
    expect(tabForSlot(tabs, 8)).toBeNull();
  });

  it("maps 9 to the last tab whatever the count", () => {
    expect(tabForSlot(tabs, 9)).toBe("b");
    expect(tabForSlot(["lead"], 9)).toBe("lead");
    expect(tabForSlot(Array.from({ length: 12 }, (_, i) => `t${i}`), 9)).toBe("t11");
  });

  it("returns nothing with no tabs", () => {
    expect(tabForSlot([], 1)).toBeNull();
    expect(tabForSlot([], 9)).toBeNull();
  });
});

describe("handleTabShortcut", () => {
  const tabs = ["lead", "a", "b"];

  function run(code: string, selectedId: string | null, list: readonly string[] = tabs, overrides: Parameters<typeof key>[1] = {}) {
    const { event, calls } = key(code, overrides);
    const selected: string[] = [];
    const handled = handleTabShortcut(event, list, selectedId, (id) => selected.push(id));
    return { handled, selected, calls };
  }

  it("selects the tab and claims the key", () => {
    const result = run("Digit2", "lead");
    expect(result.handled).toBe(true);
    expect(result.selected).toEqual(["a"]);
    expect(result.calls).toEqual({ prevented: 1, stopped: 1 });
  });

  it("selects the last tab on 9", () => {
    expect(run("Digit9", "lead").selected).toEqual(["b"]);
  });

  it("leaves the key alone when the tab is already selected", () => {
    const result = run("Digit1", "lead");
    expect(result.handled).toBe(false);
    expect(result.selected).toEqual([]);
    expect(result.calls).toEqual({ prevented: 0, stopped: 0 });
  });

  it("leaves the key alone past the last tab", () => {
    const result = run("Digit5", "lead");
    expect(result.handled).toBe(false);
    expect(result.calls.prevented).toBe(0);
  });

  it("leaves the key alone with no strip", () => {
    const result = run("Digit1", null, []);
    expect(result.handled).toBe(false);
    expect(result.calls.prevented).toBe(0);
  });

  it("lets AltGr and Shift through untouched", () => {
    for (const overrides of [{ altGraph: true }, { shiftKey: true }]) {
      const result = run("Digit2", "lead", tabs, overrides);
      expect(result.handled).toBe(false);
      expect(result.selected).toEqual([]);
      expect(result.calls).toEqual({ prevented: 0, stopped: 0 });
    }
  });
});
