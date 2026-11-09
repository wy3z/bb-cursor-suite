import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export interface DesktopProviderEntry {
  machineProviderId: string;
  pluginId: string;
  displayName: string;
}

export const DESKTOP_PROVIDERS: readonly DesktopProviderEntry[] = [
  { machineProviderId: "boat-sandbox", pluginId: "machine-boat", displayName: "Boat Sandbox" },
];

export function desktopProviderFor(
  machineProviderId: string | null | undefined,
  providers: readonly DesktopProviderEntry[] = DESKTOP_PROVIDERS,
): DesktopProviderEntry | null {
  const id = machineProviderId?.trim();
  if (!id) return null;
  return providers.find((entry) => entry.machineProviderId === id) ?? null;
}

export const DESKTOP_LEASE_MS = 120_000;
export const DESKTOP_RENEW_MS = 30_000;
export const DESKTOP_URL_MS = 10 * 60_000;
export const DESKTOP_FRAME_ALLOW = "autoplay; fullscreen; clipboard-read; clipboard-write; keyboard-map; pointer-lock";

const threadId = z.string().min(1).max(200);
export const desktopClientId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const desktopControlSchema = z.object({
  holder: z.enum(["agent", "user"]),
  clientId: z.string().nullable(),
  since: z.number().nullable(),
  expiresAt: z.number().nullable(),
});
export type DesktopControl = z.output<typeof desktopControlSchema>;

export const DESKTOP_STATES = ["ready", "starting", "stopped", "unavailable"] as const;
export type DesktopState = (typeof DESKTOP_STATES)[number];

export const desktopStatusSchema = z.object({
  providerId: z.string(),
  hostId: z.string(),
  state: z.enum(DESKTOP_STATES),
  message: z.string().nullable(),
  interactive: z.boolean(),
  pausesAgent: z.boolean(),
  control: desktopControlSchema,
});
export type DesktopStatus = z.output<typeof desktopStatusSchema>;

export const desktopViewSchema = z.object({
  url: z
    .string()
    .max(4096)
    .refine((value) => isViewUrl(value), "not an https URL"),
  expiresAt: z.number(),
});
export type DesktopView = z.output<typeof desktopViewSchema>;

export const desktopRpcContract = defineRpcContract({
  "desktop.status": {
    input: z.object({ threadId }).strict(),
    output: desktopStatusSchema,
  },
  "desktop.view": {
    input: z.object({ threadId, theme: z.enum(["light", "dark"]).nullable().optional() }).strict(),
    output: desktopViewSchema,
  },
  "desktop.control": {
    input: z.object({ threadId, clientId: desktopClientId, action: z.enum(["take", "renew", "release"]) }).strict(),
    output: desktopControlSchema,
  },
});
export type DesktopRpcContract = typeof desktopRpcContract;

export const AGENT_CONTROL: DesktopControl = { holder: "agent", clientId: null, since: null, expiresAt: null };

export function isViewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function viewOrigin(value: string): string | null {
  try {
    return isViewUrl(value) ? new URL(value).origin : null;
  } catch {
    return null;
  }
}
