import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries(globals)) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
process.env.RTL_SKIP_AUTO_CLEANUP = "true";
const { act, cleanup, render, renderHook } = await import("@testing-library/react");
const { createElement, useRef } = await import("react");
const { clearFocusVisibleWithin, syncFocusVisibleWithin, useFocusVisibleWithin } = await import(
  "./focus-visible-within"
);
const { useSidebarRootMarker } = await import("./root-marker");

const WITHIN_ATTRIBUTE = "data-focus-visible-within";
const ROOT_ATTRIBUTE = "data-cursor-sidebar-active";
const alwaysVisible = () => true;

afterEach(() => {
  cleanup();
  dom.window.document.body.innerHTML = "";
});
after(() => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  dom.window.close();
});

function containerWith(html: string): HTMLElement {
  const container = dom.window.document.createElement("div");
  container.innerHTML = html;
  dom.window.document.body.append(container);
  return container;
}

test("keyboard focus inside a row marks the row and not the focused element", () => {
  const container = containerWith('<div class="group/row" id="row"><button id="target">Open</button></div>');
  const target = container.querySelector<HTMLElement>("#target")!;
  const row = container.querySelector<HTMLElement>("#row")!;
  target.focus();
  syncFocusVisibleWithin(container, new Set(), alwaysVisible);
  assert.equal(row.getAttribute(WITHIN_ATTRIBUTE), "");
  assert.equal(target.getAttribute(WITHIN_ATTRIBUTE), null);
});

test("focus that is not visible marks nothing", () => {
  const container = containerWith('<div class="group/row" id="row"><button id="target">Open</button></div>');
  container.querySelector<HTMLElement>("#target")!.focus();
  syncFocusVisibleWithin(container, new Set(), () => false);
  assert.equal(container.querySelector(`[${WITHIN_ATTRIBUTE}]`), null);
});

test("focus leaving the row clears the marker", () => {
  const container = containerWith('<div class="group/row" id="row"><button id="target">Open</button></div>');
  const outside = dom.window.document.createElement("button");
  outside.id = "outside";
  dom.window.document.body.append(outside);
  const marked = new Set<Element>();
  container.querySelector<HTMLElement>("#target")!.focus();
  syncFocusVisibleWithin(container, marked, alwaysVisible);
  const row = container.querySelector<HTMLElement>("#row")!;
  assert.equal(row.getAttribute(WITHIN_ATTRIBUTE), "");
  outside.focus();
  syncFocusVisibleWithin(container, marked, alwaysVisible);
  assert.equal(row.getAttribute(WITHIN_ATTRIBUTE), null);
  assert.equal(marked.size, 0);
});

test("clearFocusVisibleWithin removes every marker it is given", () => {
  const one = containerWith('<div class="group/row"></div>').firstElementChild as HTMLElement;
  const two = containerWith('<div class="group/section"></div>').firstElementChild as HTMLElement;
  const marked = new Set<Element>();
  for (const element of [one, two]) {
    element.setAttribute(WITHIN_ATTRIBUTE, "");
    marked.add(element);
  }
  clearFocusVisibleWithin(marked);
  assert.equal(one.hasAttribute(WITHIN_ATTRIBUTE), false);
  assert.equal(two.hasAttribute(WITHIN_ATTRIBUTE), false);
  assert.equal(marked.size, 0);
});

test("an element outside any named group marks nothing", () => {
  const container = containerWith('<div class="plain"><button id="target">Open</button></div>');
  container.querySelector<HTMLElement>("#target")!.focus();
  syncFocusVisibleWithin(container, new Set(), alwaysVisible);
  assert.equal(container.querySelector(`[${WITHIN_ATTRIBUTE}]`), null);
});

test("two nested groups are both marked", () => {
  const container = containerWith(
    '<div class="group/row" id="outer"><div class="group/section" id="inner"><button id="target">Open</button></div></div>',
  );
  container.querySelector<HTMLElement>("#target")!.focus();
  syncFocusVisibleWithin(container, new Set(), alwaysVisible);
  assert.equal(container.querySelector<HTMLElement>("#outer")!.getAttribute(WITHIN_ATTRIBUTE), "");
  assert.equal(container.querySelector<HTMLElement>("#inner")!.getAttribute(WITHIN_ATTRIBUTE), "");
});

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  useFocusVisibleWithin(ref);
  return createElement(
    "div",
    { ref, id: "container" },
    createElement(
      "div",
      { className: "group/row", id: "row" },
      createElement("button", { id: "target" }, "Open"),
    ),
  );
}

test("the hook tracks focusin and focusout on its container", () => {
  const prototype = dom.window.Element.prototype;
  const originalMatches = prototype.matches;
  let visible: Element | null = null;
  prototype.matches = function (this: Element, selectors: string): boolean {
    if (selectors === ":focus-visible") return this === visible;
    return originalMatches.call(this, selectors);
  };
  try {
    const { container } = render(createElement(Harness));
    const target = container.querySelector<HTMLElement>("#target")!;
    const row = container.querySelector<HTMLElement>("#row")!;
    visible = target;
    act(() => target.focus());
    assert.equal(row.getAttribute(WITHIN_ATTRIBUTE), "");
    visible = null;
    act(() => target.blur());
    assert.equal(row.getAttribute(WITHIN_ATTRIBUTE), null);
  } finally {
    prototype.matches = originalMatches;
  }
});

test("the root marker stays while any sidebar is mounted", () => {
  const root = dom.window.document.documentElement;
  const first = renderHook(() => useSidebarRootMarker());
  const second = renderHook(() => useSidebarRootMarker());
  assert.equal(root.getAttribute(ROOT_ATTRIBUTE), "");
  first.unmount();
  assert.equal(root.getAttribute(ROOT_ATTRIBUTE), "");
  second.unmount();
  assert.equal(root.getAttribute(ROOT_ATTRIBUTE), null);
});
