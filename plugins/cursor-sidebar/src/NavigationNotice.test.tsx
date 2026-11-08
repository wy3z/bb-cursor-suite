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
const { act, cleanup, render } = await import("@testing-library/react");
const { NavigationNotice, NAVIGATION_NOTICE_KEY } = await import("./NavigationNotice");

afterEach(() => {
  cleanup();
  dom.window.localStorage.clear();
});
after(() => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  dom.window.close();
});

test("the notice names the layout and how to switch back to BB's navigation", () => {
  const { container } = render(<NavigationNotice layout="Compact" />);
  const note = container.querySelector('[role="note"]');
  assert.ok(note);
  assert.match(note.textContent ?? "", /Cursor Sidebar's Compact layout/);
  assert.match(note.textContent ?? "", /Rail or Top list under Settings → Appearance → Navigation/);
});

test("Got it hides the notice and remembers it", () => {
  const { container } = render(<NavigationNotice layout="Cursor" />);
  const button = Array.from(container.querySelectorAll("button")).find((element) => element.textContent === "Got it");
  assert.ok(button);
  act(() => button.click());
  assert.equal(container.querySelector('[role="note"]'), null);
  assert.equal(dom.window.localStorage.getItem(NAVIGATION_NOTICE_KEY), "dismissed");
  cleanup();
  const again = render(<NavigationNotice layout="Cursor" />);
  assert.equal(again.container.querySelector('[role="note"]'), null);
});
