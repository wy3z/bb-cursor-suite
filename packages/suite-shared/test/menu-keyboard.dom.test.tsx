import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  FocusEvent: dom.window.FocusEvent,
  PointerEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries(globals)) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
process.env.RTL_SKIP_AUTO_CLEANUP = "true";
const React = await import("react");
const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { nextMenuItem, useMenuKeyboard } = await import("../src/menu-keyboard");

afterEach(() => cleanup());
afterAll(() => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  dom.window.close();
});

function Demo({ disabledSecond = false }: { disabledSecond?: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  useMenuKeyboard(ref, open, () => setOpen(false));
  return (
    <div ref={ref}>
      <button type="button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}>
        Actions
      </button>
      {open ? (
        <div role="menu">
          <button type="button">Header</button>
          <button type="button" role="menuitem" onClick={() => setOpen(false)}>
            First
          </button>
          <button type="button" role="menuitem" disabled={disabledSecond}>
            Second
          </button>
          <div role="menuitem" aria-disabled="true">
            Note
          </div>
          <div role="menuitem" tabIndex={0}>
            Third
            <button type="button">Stop</button>
          </div>
        </div>
      ) : null}
      <button type="button">After</button>
    </div>
  );
}

const active = () => document.activeElement?.textContent?.trim();

function openWithKeyboard() {
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  act(() => trigger.click());
  return trigger;
}

describe("menu keyboard", () => {
  it("moves through enabled items with arrows, Home and End, wrapping at the ends", () => {
    render(<Demo />);
    openWithKeyboard();
    expect(active()).toBe("First");
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(active()).toBe("Second");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(active()).toBe("ThirdStop");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(active()).toBe("Header");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(active()).toBe("ThirdStop");
    fireEvent.keyDown(menu, { key: "Home" });
    expect(active()).toBe("Header");
    fireEvent.keyDown(menu, { key: "End" });
    expect(active()).toBe("ThirdStop");
  });

  it("skips disabled items", () => {
    render(<Demo disabledSecond />);
    openWithKeyboard();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(active()).toBe("ThirdStop");
  });

  it("reaches a row's own buttons with ArrowRight and ArrowLeft", () => {
    render(<Demo />);
    openWithKeyboard();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(active()).toBe("Stop");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(active()).toBe("ThirdStop");
  });

  it("is one tab stop: items leave the tab order, and Tab closes the menu", () => {
    render(<Demo />);
    const trigger = openWithKeyboard();
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(Array.from(menu.querySelectorAll("button, [tabindex]")).every((element) => element.getAttribute("tabindex") === "-1")).toBe(true);
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(<Demo />);
    const trigger = openWithKeyboard();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the trigger after an item closes the menu", () => {
    render(<Demo />);
    const trigger = openWithKeyboard();
    act(() => (document.activeElement as HTMLButtonElement).click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("focuses the menu, not an item, when opened with the pointer", () => {
    render(<Demo />);
    const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    fireEvent.pointerDown(trigger);
    trigger.focus();
    act(() => trigger.click());
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(document.activeElement).toBe(menu);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(active()).toBe("First");
  });

  it("picks the next item from wherever focus sits inside an item", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    const inner = document.createElement("button");
    b.append(inner);
    expect(nextMenuItem([a, b], inner, "ArrowDown")).toBe(a);
    expect(nextMenuItem([a, b], null, "ArrowUp")).toBe(b);
    expect(nextMenuItem([a, b], a, "Tab")).toBeUndefined();
    expect(nextMenuItem([], a, "ArrowDown")).toBeUndefined();
  });
});
