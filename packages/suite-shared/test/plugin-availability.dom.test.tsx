import { afterAll, describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
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
const { act, cleanup } = await import("@testing-library/react");
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { pluginAvailability, usePluginAvailability } = await import("../src/plugin-availability");

afterAll(() => {
  cleanup();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  dom.window.close();
});

type Listing = { id: string; enabled: boolean; status: string };
type Callback = (event: Record<string, unknown>) => void;

function fakeHost(initial: Listing[] | Error) {
  const state = { plugins: initial, listCalls: 0, callbacks: new Map<string, Set<Callback>>() };
  const sdk = {
    plugins: {
      list: async () => {
        state.listCalls++;
        if (state.plugins instanceof Error) throw state.plugins;
        return { plugins: state.plugins };
      },
    },
    subscribe: ({ event, callback }: { event: string; callback: Callback }) => {
      const set = state.callbacks.get(event) ?? new Set<Callback>();
      set.add(callback);
      state.callbacks.set(event, set);
      return () => set.delete(callback);
    },
  };
  const emit = async (event: string, payload: Record<string, unknown>) => {
    await act(async () => {
      for (const callback of state.callbacks.get(event) ?? []) callback(payload);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  return { state, sdk, emit };
}

function Probe({ pluginId }: { pluginId: string }) {
  return <output data-testid={pluginId}>{usePluginAvailability(pluginId)}</output>;
}

function Pair() {
  return (
    <>
      <Probe pluginId="pull-requests" />
      <Probe pluginId="tasks" />
    </>
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const running = (id: string): Listing => ({ id, enabled: true, status: "running" });

describe("pluginAvailability", () => {
  it("is available only when the plugin is installed, enabled and running or degraded", () => {
    expect(pluginAvailability([running("pull-requests")], "pull-requests")).toBe("available");
    expect(pluginAvailability([{ id: "pull-requests", enabled: true, status: "degraded" }], "pull-requests")).toBe("available");
    expect(pluginAvailability([], "pull-requests")).toBe("unavailable");
    expect(pluginAvailability([{ id: "pull-requests", enabled: false, status: "disabled" }], "pull-requests")).toBe("unavailable");
    expect(pluginAvailability([{ id: "pull-requests", enabled: true, status: "error" }], "pull-requests")).toBe("unavailable");
    expect(pluginAvailability([{ id: "pull-requests", enabled: true, status: "incompatible" }], "pull-requests")).toBe("unavailable");
  });
});

describe("usePluginAvailability", () => {
  it("starts unknown, then reports the installed state", async () => {
    const host = fakeHost([running("pull-requests")]);
    const view = renderSlot({ component: Probe }, { pluginId: "pull-requests" }, { sdk: host.sdk as never });
    expect(view.getByTestId("pull-requests").textContent).toBe("unknown");
    await settle();
    expect(view.getByTestId("pull-requests").textContent).toBe("available");
    view.unmount();
  });

  it("reports a missing plugin as unavailable", async () => {
    const host = fakeHost([running("tasks")]);
    const view = renderSlot({ component: Probe }, { pluginId: "pull-requests" }, { sdk: host.sdk as never });
    await settle();
    expect(view.getByTestId("pull-requests").textContent).toBe("unavailable");
    view.unmount();
  });

  it("follows the plugin being disabled and enabled without a reload", async () => {
    const host = fakeHost([running("pull-requests")]);
    const view = renderSlot({ component: Probe }, { pluginId: "pull-requests" }, { sdk: host.sdk as never });
    await settle();
    expect(view.getByTestId("pull-requests").textContent).toBe("available");

    host.state.plugins = [{ id: "pull-requests", enabled: false, status: "disabled" }];
    await host.emit("system:changed", { entity: "system", type: "changed", changes: ["plugins-changed"] });
    expect(view.getByTestId("pull-requests").textContent).toBe("unavailable");

    host.state.plugins = [running("pull-requests")];
    await host.emit("system:changed", { entity: "system", type: "changed", changes: ["config-changed"] });
    expect(view.getByTestId("pull-requests").textContent).toBe("unavailable");

    await host.emit("system:changed", { entity: "system", type: "changed", changes: ["plugins-changed"] });
    expect(view.getByTestId("pull-requests").textContent).toBe("available");
    view.unmount();
  });

  it("rereads the list after the realtime connection comes back", async () => {
    const host = fakeHost([running("pull-requests")]);
    const view = renderSlot({ component: Probe }, { pluginId: "pull-requests" }, { sdk: host.sdk as never });
    await settle();
    host.state.plugins = [];
    await host.emit("realtime:connection", { state: "connected", reconnected: false, reconnectDelayMs: null });
    expect(view.getByTestId("pull-requests").textContent).toBe("available");
    await host.emit("realtime:connection", { state: "connected", reconnected: true, reconnectDelayMs: null });
    expect(view.getByTestId("pull-requests").textContent).toBe("unavailable");
    view.unmount();
  });

  it("shares one list call between callers and stops listening when the last one unmounts", async () => {
    const host = fakeHost([running("pull-requests")]);
    const view = renderSlot({ component: Pair }, {}, { sdk: host.sdk as never });
    await settle();
    expect(view.getByTestId("pull-requests").textContent).toBe("available");
    expect(view.getByTestId("tasks").textContent).toBe("unavailable");
    expect(host.state.listCalls).toBe(1);
    view.unmount();
    expect(host.state.callbacks.get("system:changed")?.size ?? 0).toBe(0);
    expect(host.state.callbacks.get("realtime:connection")?.size ?? 0).toBe(0);
  });

  it("falls back to available when the plugin list can't be read", async () => {
    const host = fakeHost(new Error("forbidden"));
    const view = renderSlot({ component: Probe }, { pluginId: "pull-requests" }, { sdk: host.sdk as never });
    await settle();
    expect(view.getByTestId("pull-requests").textContent).toBe("available");
    view.unmount();
  });
});
