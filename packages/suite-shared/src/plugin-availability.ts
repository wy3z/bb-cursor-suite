import { useSyncExternalStore } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { pluginAvailability, type PluginAvailability, type PluginListing } from "./plugin-status";

export { NEEDS_PULL_REQUESTS, pluginAvailability, type PluginAvailability, type PluginListing } from "./plugin-status";

export const LIST_TIMEOUT_MS = 10_000;

type Sdk = ReturnType<typeof useSdk>;

interface AvailabilityStore {
  subscribe: (listener: () => void) => () => void;
  read: (pluginId: string) => PluginAvailability;
}

const stores = new WeakMap<object, AvailabilityStore>();

function createStore(sdk: Sdk): AvailabilityStore {
  const listeners = new Set<() => void>();
  let listings: readonly PluginListing[] | "failed" | null = null;
  let generation = 0;
  let detach: (() => void) | null = null;

  const notify = () => listeners.forEach((listener) => listener());
  const giveUp = (current: number) => {
    if (current !== generation || listings !== null) return;
    listings = "failed";
    notify();
  };
  const refresh = () => {
    const current = ++generation;
    const timer = setTimeout(() => giveUp(current), LIST_TIMEOUT_MS);
    sdk.plugins.list().then(
      (result) => {
        clearTimeout(timer);
        if (current !== generation) return;
        listings = result.plugins.map(({ id, enabled, status }) => ({ id, enabled, status }));
        notify();
      },
      () => {
        clearTimeout(timer);
        giveUp(current);
      },
    );
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (detach === null) {
        const offSystem = sdk.subscribe({
          event: "system:changed",
          callback: (event) => {
            if (event.changes.includes("plugins-changed")) refresh();
          },
        });
        const offConnection = sdk.subscribe({
          event: "realtime:connection",
          callback: (event) => {
            if (event.state === "connected" && event.reconnected) refresh();
          },
        });
        detach = () => {
          offSystem();
          offConnection();
        };
        refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && detach !== null) {
          detach();
          detach = null;
          generation++;
        }
      };
    },
    read(pluginId) {
      if (listings === null) return "unknown";
      if (listings === "failed") return "available";
      return pluginAvailability(listings, pluginId);
    },
  };
}

function storeFor(sdk: Sdk): AvailabilityStore {
  let store = stores.get(sdk);
  if (store === undefined) {
    store = createStore(sdk);
    stores.set(sdk, store);
  }
  return store;
}

export function usePluginAvailability(pluginId: string): PluginAvailability {
  const store = storeFor(useSdk());
  return useSyncExternalStore(
    store.subscribe,
    () => store.read(pluginId),
    () => "unknown",
  );
}
