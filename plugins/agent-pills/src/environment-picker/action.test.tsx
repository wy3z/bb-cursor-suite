import { afterEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
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
  PointerEvent: dom.window.MouseEvent,
  FocusEvent: dom.window.FocusEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
process.env.RTL_SKIP_AUTO_CLEANUP = "true";

const { act, cleanup, fireEvent } = await import("@testing-library/react");
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { EnvironmentPickerAction } = await import("./EnvironmentPicker");
const { REPLACED_ATTRIBUTE, SLOT_ATTRIBUTE } = await import("./bb-picker");

const providers = [
  { id: "project-checkout", displayName: "Project checkout", description: null, icon: null, logoUrl: null, machineProviderId: null, availability: null, machineAvailability: { host_local: { status: "available" } } },
  { id: "git-worktree", displayName: "Worktree", description: null, icon: null, logoUrl: null, machineProviderId: null, availability: null, machineAvailability: { host_local: { status: "available" } } },
  { id: "modal-sandbox", displayName: "Modal Sandbox", description: null, icon: null, logoUrl: null, machineProviderId: "modal-sandbox", availability: null, machineAvailability: {} },
];

const host = (id: string, status = "connected") => ({ id, name: id === "host_local" ? "laptop" : "build-box", status });

function mountFooter(): HTMLElement {
  document.body.innerHTML = `
    <div data-app-composer="">
      <form data-promptbox=""><div data-promptbox-action-row="" id="actions"></div></form>
      <div data-new-thread-footer="">
        <div>
          <button type="button" aria-label="Project: demo" data-promptbox-project-control="">demo</button>
          <button type="button" id="bb-env" aria-label="Environment" data-promptbox-shrinkable-control=""><span data-promptbox-full-label="">Project checkout</span></button>
        </div>
      </div>
    </div>`;
  return document.getElementById("actions")!;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function render(hosts: ReturnType<typeof host>[]) {
  const actions = mountFooter();
  const slot = renderSlot(
    { component: EnvironmentPickerAction },
    {},
    {
      composer: {
        scope: { kind: "new-thread", projectId: "proj_demo" },
        selection: {
          projectId: "proj_demo",
          environment: { type: "provider", environmentProviderId: "project-checkout", inputs: null, machine: { type: "existing", hostId: "host_local" } },
        },
      },
      environmentProviders: { status: "ready", providers: providers.map((entry) => ({ ...entry, pluginId: "test" })) },
      sdk: {
        environments: { listProviders: async () => providers as never, list: async () => [] },
        system: { config: async () => ({ primaryHostId: "host_local" }) as never },
        hosts: { list: async () => hosts as never },
      },
    },
  );
  actions.appendChild(slot.container);
  return slot;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("EnvironmentPickerAction", () => {
  it("replaces BB's button and selecting Cloud only changes the selection", async () => {
    const slot = render([host("host_local")]);
    await settle();
    expect(document.getElementById("bb-env")?.hasAttribute(REPLACED_ATTRIBUTE)).toBe(true);
    const trigger = document.querySelector<HTMLButtonElement>(`[${SLOT_ATTRIBUTE}] .bb-agent-pills-env__trigger`);
    expect(trigger?.getAttribute("aria-label")).toBe("This Computer, select environment");

    await act(async () => fireEvent.click(trigger!));
    await settle();
    const cloud = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role^="menuitem"]')].find(
      (row) => row.textContent?.trim() === "Cloud",
    );
    await act(async () => fireEvent.click(cloud!));
    await settle();

    expect(slot.inspection.composer.selections.at(-1)?.environment).toEqual({
      type: "provider",
      environmentProviderId: "modal-sandbox",
      inputs: null,
    });
    expect(slot.inspection.composer.submits).toEqual([]);
    expect(slot.inspection.sdkCalls.map((call) => call.method).filter((method) => method.startsWith("threads."))).toEqual([]);
  });

  it("leaves BB's picker alone when a second machine is connected", async () => {
    render([host("host_local"), host("host_remote")]);
    await settle();
    expect(document.getElementById("bb-env")?.hasAttribute(REPLACED_ATTRIBUTE)).toBe(false);
    expect(document.querySelector(`[${SLOT_ATTRIBUTE}]`)).toBeNull();
    expect(document.querySelector("#actions .bb-agent-pills-env__trigger")).not.toBeNull();
  });

  it("counts only connected machines", async () => {
    render([host("host_local"), host("host_remote", "disconnected")]);
    await settle();
    expect(document.getElementById("bb-env")?.hasAttribute(REPLACED_ATTRIBUTE)).toBe(true);
  });
});
