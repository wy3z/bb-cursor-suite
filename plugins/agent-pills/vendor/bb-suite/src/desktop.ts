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
export const DESKTOP_HIDDEN_STOP_MS = 30_000;
export const DESKTOP_MAX_HOLD_MS = 30 * 60_000;
export const DESKTOP_URL_MS = 10 * 60_000;
export const DESKTOP_FRAME_ALLOW = "autoplay; fullscreen; keyboard-map; pointer-lock";
export const DESKTOP_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-pointer-lock";

const threadId = z.string().min(1).max(200);
export const desktopClientId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const desktopControlSchema = z.object({
  holder: z.enum(["agent", "user"]),
  mine: z.boolean(),
  agentPaused: z.boolean(),
  since: z.number().nullable(),
  expiresAt: z.number().nullable(),
});
export type DesktopControl = z.output<typeof desktopControlSchema>;

export const DESKTOP_STATES = ["ready", "starting", "stopped", "unavailable"] as const;
export type DesktopState = (typeof DESKTOP_STATES)[number];

export const desktopStatusSchema = z.object({
  providerId: z.string(),
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

export const desktopStatusInput = z.object({ threadId, clientId: desktopClientId }).strict();
export const desktopViewInput = z
  .object({ threadId, theme: z.enum(["light", "dark"]).nullable().optional(), touch: z.boolean().optional() })
  .strict();
export const desktopControlInput = z.object({ threadId, clientId: desktopClientId, action: z.enum(["take", "renew", "release"]) }).strict();

export const DESKTOP_ROUTES = {
  status: { path: "/desktop/status", input: desktopStatusInput, output: desktopStatusSchema },
  view: { path: "/desktop/view", input: desktopViewInput, output: desktopViewSchema },
  control: { path: "/desktop/control", input: desktopControlInput, output: desktopControlSchema },
} as const;
export type DesktopRoute = keyof typeof DESKTOP_ROUTES;

export function desktopRouteUrl(pluginId: string, route: DesktopRoute): string {
  return `/api/v1/plugins/${encodeURIComponent(pluginId)}/http${DESKTOP_ROUTES[route].path}`;
}

export const AGENT_CONTROL: DesktopControl = { holder: "agent", mine: false, agentPaused: false, since: null, expiresAt: null };

export function isViewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export type DesktopRequestHeaders = (name: string) => string | undefined | null;

export function browserRequestRefusal(header: DesktopRequestHeaders): string | null {
  const gate = header("x-bb-gate-auth")?.trim().toLowerCase();
  if (gate === "machine") return "machine credentials can't use another machine's desktop";
  if (gate === "oauth") return "connected apps can't use the desktop";
  if (gate !== undefined && gate !== "" && gate !== "session") return "only a signed-in BB app session can use the desktop";
  if (header("sec-fetch-site")?.trim().toLowerCase() !== "same-origin") return "only the BB app can use the desktop";
  const mode = header("sec-fetch-mode")?.trim().toLowerCase();
  if (mode !== "cors" && mode !== "same-origin") return "only the BB app can use the desktop";
  if (!header("origin")) return "only the BB app can use the desktop";
  return null;
}
