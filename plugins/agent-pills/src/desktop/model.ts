import type { DesktopControl, DesktopStatus } from "@wy3z/bb-suite/desktop";

export type ControlView = "agent" | "you" | "elsewhere";

export const DESKTOP_TAB = { id: "desktop", context: { kind: "thread" }, availability: "fixed" } as const;

export function controlView(control: DesktopControl | null | undefined, clientId: string): ControlView {
  if (!control || control.holder === "agent") return "agent";
  return control.clientId === clientId ? "you" : "elsewhere";
}

export const CONTROL_LABEL: Record<ControlView, string> = {
  agent: "Agent has control",
  you: "You have control",
  elsewhere: "You have control in another window",
};

export function pillVisible(status: DesktopStatus | null | undefined): boolean {
  return status?.state === "ready" || status?.state === "starting";
}

export function statusMessage(status: DesktopStatus): string {
  if (status.message) return status.message;
  switch (status.state) {
    case "starting":
      return "The desktop is starting.";
    case "stopped":
      return "The machine is paused. Resume it to see its desktop.";
    case "unavailable":
      return "This machine has no desktop.";
    default:
      return "";
  }
}

export function urlExpired(view: { expiresAt: number } | null, now: number): boolean {
  return view === null || now >= view.expiresAt;
}

export function newClientId(random: () => number = Math.random): string {
  let id = "";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = typeof crypto !== "undefined" && "getRandomValues" in crypto ? crypto.getRandomValues(new Uint8Array(20)) : null;
  for (let index = 0; index < 20; index += 1) {
    const value = bytes ? bytes[index]! : Math.floor(random() * 256);
    id += alphabet[value % alphabet.length];
  }
  return `bbd_${id}`;
}

export function preferredTheme(root: { classList: { contains(name: string): boolean } } | null, scheme: string | null): "light" | "dark" | null {
  if (root?.classList.contains("dark")) return "dark";
  if (scheme === null) return null;
  if (/\bdark\b/.test(scheme)) return "dark";
  if (/\blight\b/.test(scheme)) return "light";
  return null;
}
