import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/settings/plugins/demo" });
const globals: Record<string, unknown> = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLSelectElement: dom.window.HTMLSelectElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  PopStateEvent: dom.window.PopStateEvent,
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
const { SettingsCard, SettingsLinkButton, SettingsRow, SettingsSelectRow, SettingsToggleRow } = await import("../src/settings");

afterEach(() => cleanup());

afterAll(() => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  dom.window.close();
});

describe("settings rows", () => {
  it("toggle row is a labelled switch that flips", async () => {
    function Demo() {
      const [on, setOn] = React.useState(false);
      return (
        <SettingsCard>
          <SettingsToggleRow label="Cursor-style composer" description="On by default." checked={on} onCheckedChange={setOn} />
        </SettingsCard>
      );
    }
    const view = render(<Demo />);
    const toggle = view.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(document.getElementById(toggle.getAttribute("aria-labelledby")!)?.textContent).toBe("Cursor-style composer");
    expect(document.getElementById(toggle.getAttribute("aria-describedby")!)?.textContent).toBe("On by default.");
    await act(async () => fireEvent.click(toggle));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("data-state")).toBe("checked");
  });

  it("select row only reports known values", async () => {
    const seen: string[] = [];
    const view = render(
      <SettingsSelectRow
        label="Position"
        value="top"
        options={[
          { value: "top", label: "Top" },
          { value: "bottom", label: "Bottom" },
        ]}
        onChange={(value) => seen.push(value)}
      />,
    );
    const select = view.getByRole("combobox") as HTMLSelectElement;
    expect(document.getElementById(select.getAttribute("aria-labelledby")!)?.textContent).toBe("Position");
    expect(select.getAttribute("aria-describedby")).toBeNull();
    await act(async () => fireEvent.change(select, { target: { value: "bottom" } }));
    expect(seen).toEqual(["bottom"]);
  });

  it("a row without a control renders only its text", () => {
    const view = render(<SettingsRow label="Nothing to set" description="Options live in the panel." />);
    expect(view.container.querySelector(".bbs-settings-row__control")).toBeNull();
    expect(view.getByText("Options live in the panel.")).toBeTruthy();
  });

  it("link button routes in-app on a plain click and leaves modified clicks alone", async () => {
    let pops = 0;
    window.addEventListener("popstate", () => (pops += 1));
    const view = render(<SettingsLinkButton href="/settings/appearance">Open Appearance</SettingsLinkButton>);
    const link = view.getByText("Open Appearance");
    await act(async () => fireEvent.click(link, { ctrlKey: true }));
    expect(window.location.pathname).toBe("/settings/plugins/demo");
    await act(async () => fireEvent.click(link));
    expect(window.location.pathname).toBe("/settings/appearance");
    expect(pops).toBe(1);
  });
});
