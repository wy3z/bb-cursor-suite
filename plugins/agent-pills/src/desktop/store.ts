import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { usePluginAvailability } from "@wy3z/bb-suite/plugin-availability";
import {
  DESKTOP_ROUTES,
  desktopProviderFor,
  desktopRouteUrl,
  type DesktopControl,
  type DesktopProviderEntry,
  type DesktopRoute,
  type DesktopStatus,
  type DesktopView,
} from "@wy3z/bb-suite/desktop";
import { newClientId } from "./model";

type Sdk = ReturnType<typeof useSdk>;

export const STATUS_POLL_MS = 10_000;
const TARGET_TTL_MS = 5 * 60_000;

export interface DesktopTarget {
  provider: DesktopProviderEntry;
  hostId: string;
}

let clientId: string | null = null;
export function desktopClientId(): string {
  clientId ??= newClientId();
  return clientId;
}

const targets = new Map<string, { at: number; value: Promise<DesktopTarget | null> }>();

export function resolveTarget(sdk: Sdk, environmentId: string, now = Date.now()): Promise<DesktopTarget | null> {
  const cached = targets.get(environmentId);
  if (cached !== undefined && now - cached.at < TARGET_TTL_MS) return cached.value;
  const value = (async () => {
    try {
      const environment = await sdk.environments.get({ environmentId });
      const host = await sdk.hosts.get({ hostId: environment.hostId });
      const provider = desktopProviderFor(host.machineProviderId);
      return provider === null ? null : { provider, hostId: host.id };
    } catch {
      targets.delete(environmentId);
      return null;
    }
  })();
  targets.set(environmentId, { at: now, value });
  return value;
}

interface Keyed<T> {
  value: T;
  listeners: Set<() => void>;
}

const targetState = new Map<string, Keyed<DesktopTarget | null | undefined>>();

function keyed<T>(map: Map<string, Keyed<T>>, key: string, initial: T): Keyed<T> {
  let entry = map.get(key);
  if (entry === undefined) {
    entry = { value: initial, listeners: new Set() };
    map.set(key, entry);
  }
  return entry;
}

export function useDesktopTarget(environmentId: string | null | undefined): DesktopTarget | null | undefined {
  const sdk = useSdk();
  const key = environmentId ?? "";
  const entry = keyed(targetState, key, environmentId ? undefined : null);
  const value = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
      [entry],
    ),
    () => entry.value,
    () => undefined,
  );
  useEffect(() => {
    if (!environmentId) return;
    let live = true;
    void resolveTarget(sdk, environmentId).then((target) => {
      if (!live || entry.value === target) return;
      entry.value = target;
      entry.listeners.forEach((listener) => listener());
    });
    return () => {
      live = false;
    };
  }, [sdk, environmentId, entry]);
  return value;
}

export function useDesktopProvider(environmentId: string | null | undefined): DesktopTarget | null {
  const target = useDesktopTarget(environmentId);
  const availability = usePluginAvailability(target?.provider.pluginId ?? "");
  if (!target || availability !== "available") return null;
  return target;
}

export interface StatusSnapshot {
  status: DesktopStatus | null;
  error: boolean;
  loaded: boolean;
}

interface StatusEntry {
  snapshot: StatusSnapshot;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  inflight: Promise<void> | null;
  generation: number;
}

const statuses = new Map<string, StatusEntry>();
const EMPTY: StatusSnapshot = { status: null, error: false, loaded: false };

function statusKey(pluginId: string, threadId: string): string {
  return `${pluginId}\u0000${threadId}`;
}

function statusEntry(key: string): StatusEntry {
  let entry = statuses.get(key);
  if (entry === undefined) {
    entry = { snapshot: EMPTY, listeners: new Set(), timer: null, inflight: null, generation: 0 };
    statuses.set(key, entry);
  }
  return entry;
}

type DesktopOutputs = { status: DesktopStatus; view: DesktopView; control: DesktopControl };

export async function callDesktop<R extends DesktopRoute>(pluginId: string, route: R, input: Record<string, unknown>): Promise<DesktopOutputs[R]> {
  const response = await fetch(desktopRouteUrl(pluginId, route), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  type Envelope = { ok?: boolean; result?: unknown; error?: { message?: unknown } };
  let body: Envelope | null;
  try {
    body = (await response.json()) as Envelope;
  } catch {
    body = null;
  }
  if (!response.ok || body?.ok !== true) {
    const message = typeof body?.error?.message === "string" ? body.error.message : `The desktop request failed (${response.status}).`;
    throw new Error(message);
  }
  return DESKTOP_ROUTES[route].output.parse(body.result) as DesktopOutputs[R];
}

function refreshStatus(pluginId: string, threadId: string, entry: StatusEntry): Promise<void> {
  if (entry.inflight !== null) return entry.inflight;
  const generation = entry.generation;
  const request: Promise<void> = callDesktop(pluginId, "status", { threadId, clientId: desktopClientId() })
    .then(
      (status) => ({ status, error: false, loaded: true }),
      () => ({ status: null, error: true, loaded: true }),
    )
    .then((snapshot: StatusSnapshot) => {
      if (entry.inflight === request) entry.inflight = null;
      if (generation !== entry.generation) return;
      entry.snapshot = snapshot;
      entry.listeners.forEach((listener) => listener());
    });
  entry.inflight = request;
  return request;
}

export function setStatusControl(pluginId: string, threadId: string, control: DesktopControl): void {
  const entry = statuses.get(statusKey(pluginId, threadId));
  if (entry === undefined || entry.snapshot.status === null) return;
  entry.generation += 1;
  entry.inflight = null;
  entry.snapshot = { ...entry.snapshot, status: { ...entry.snapshot.status, control } };
  entry.listeners.forEach((listener) => listener());
}

export function useDesktopStatus(threadId: string, target: DesktopTarget | null): StatusSnapshot & { refresh: () => Promise<void> } {
  const pluginId = target?.provider.pluginId ?? null;
  const entry = useMemo(() => (pluginId === null ? null : statusEntry(statusKey(pluginId, threadId))), [pluginId, threadId]);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (entry === null || pluginId === null) return () => undefined;
      entry.listeners.add(listener);
      if (entry.timer === null) {
        void refreshStatus(pluginId, threadId, entry);
        entry.timer = setInterval(() => {
          if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
          void refreshStatus(pluginId, threadId, entry);
        }, STATUS_POLL_MS);
      }
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0 && entry.timer !== null) {
          clearInterval(entry.timer);
          entry.timer = null;
        }
      };
    },
    [entry, pluginId, threadId],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => entry?.snapshot ?? EMPTY,
    () => EMPTY,
  );
  const refresh = useCallback(async () => {
    if (entry === null || pluginId === null) return;
    entry.inflight = null;
    entry.generation += 1;
    await refreshStatus(pluginId, threadId, entry);
  }, [entry, pluginId, threadId]);
  return { ...snapshot, refresh };
}

export function resetDesktopStores(): void {
  for (const entry of statuses.values()) if (entry.timer !== null) clearInterval(entry.timer);
  statuses.clear();
  targets.clear();
  targetState.clear();
  clientId = null;
}
