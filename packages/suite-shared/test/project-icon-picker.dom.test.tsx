import { afterAll, describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
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
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map<string, PropertyDescriptor | undefined>();

for (const [name, value] of Object.entries(globals)) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
process.env.RTL_SKIP_AUTO_CLEANUP = "true";
const React = await import("react");
const { act, cleanup, fireEvent } = await import("@testing-library/react");
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { ProjectIconPicker } = await import("../src/project-icon-picker");
const { serveProjectIconGlyphs } = await import("../src/project-icon-glyph-server");

afterAll(() => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  dom.window.close();
});

describe("anchored picker", () => {
  it("closes when its anchor is clicked and stays closed", async () => {
    function Demo() {
      const ref = React.useRef<HTMLButtonElement>(null);
      const [open, setOpen] = React.useState(false);
      return (
        <div>
          <button type="button" ref={ref} onClick={() => setOpen((value) => !value)}>
            Board
          </button>
          <button type="button">Elsewhere</button>
          <ProjectIconPicker anchor={ref.current} open={open} onOpenChange={setOpen} value={null} onChange={() => undefined} />
        </div>
      );
    }

    const view = renderSlot({ component: Demo }, {}, { rpc: { iconGlyphs: (input: { names: string[] | null }) => serveProjectIconGlyphs(input) } as never });
    const anchor = view.getByText("Board");
    const popover = () => document.querySelector(".bbs-icon-picker-popover");
    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

    await act(async () => fireEvent.click(anchor));
    await settle();
    expect(popover()).not.toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search icons");

    await act(async () => {
      fireEvent.pointerDown(anchor);
      anchor.focus();
      fireEvent.click(anchor);
    });
    await settle();
    expect(popover()).toBeNull();

    await act(async () => fireEvent.click(anchor));
    await settle();
    expect(popover()).not.toBeNull();
    await act(async () => view.getByText("Elsewhere").focus());
    await settle();
    expect(popover()).toBeNull();
    view.unmount();
    cleanup();
  });
});
