import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const store = new Map<string, string>();
const host = globalThis as { window?: unknown };
const previous = host.window;
host.window = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
};
const { NavigationNotice, NAVIGATION_NOTICE_KEY } = await import("./NavigationNotice");

afterEach(() => store.clear());
after(() => {
  host.window = previous;
});

test("the notice names the layout and how to switch back to BB's navigation", () => {
  const html = renderToStaticMarkup(<NavigationNotice layout="Compact" />);
  assert.match(html, /role="note"/);
  assert.match(html, /its Compact layout/);
  assert.match(html, /Settings → Appearance → Navigation/);
  assert.match(html, /Rail or Top list/);
  assert.match(html, /Got it/);
});

test("a dismissed notice stays gone", () => {
  store.set(NAVIGATION_NOTICE_KEY, "dismissed");
  assert.equal(renderToStaticMarkup(<NavigationNotice layout="Cursor" />), "");
});
