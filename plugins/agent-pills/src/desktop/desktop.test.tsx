import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopStatus } from "@wy3z/bb-suite/desktop";
import { CONTROL_LABEL, controlView, newClientId, pillVisible, preferredTheme, statusMessage, urlExpired } from "./model";

const runtime = globalThis as unknown as { __bbPluginRuntime?: unknown };
runtime.__bbPluginRuntime = {
  react: React,
  pluginSdkApp: {
    experimental_Icon: ({ name }: { name: string }) => React.createElement("span", { "data-icon": name }),
    experimental_useAppPanel: () => ({ openTab: () => true }),
    useSdk: () => ({}),
  },
};

const { DesktopPillView } = await import("./DesktopPill");

function status(overrides: Partial<DesktopStatus> = {}): DesktopStatus {
  return {
    providerId: "boat-sandbox",
    hostId: "host_1",
    state: "ready",
    message: null,
    interactive: true,
    pausesAgent: true,
    control: { holder: "agent", clientId: null, since: null, expiresAt: null },
    ...overrides,
  };
}

describe("controlView", () => {
  it("tells this window, another window and the agent apart", () => {
    expect(controlView(null, "bbd_me")).toBe("agent");
    expect(controlView({ holder: "agent", clientId: null, since: null, expiresAt: null }, "bbd_me")).toBe("agent");
    expect(controlView({ holder: "user", clientId: "bbd_me", since: 1, expiresAt: 2 }, "bbd_me")).toBe("you");
    expect(controlView({ holder: "user", clientId: "bbd_other", since: 1, expiresAt: 2 }, "bbd_me")).toBe("elsewhere");
    expect(CONTROL_LABEL.agent).toBe("Agent has control");
    expect(CONTROL_LABEL.you).toBe("You have control");
  });
});

describe("pill visibility", () => {
  it("shows for a running or starting desktop only", () => {
    expect(pillVisible(status())).toBe(true);
    expect(pillVisible(status({ state: "starting" }))).toBe(true);
    expect(pillVisible(status({ state: "stopped" }))).toBe(false);
    expect(pillVisible(status({ state: "unavailable" }))).toBe(false);
    expect(pillVisible(null)).toBe(false);
  });

  it("falls back to a plain message per state", () => {
    expect(statusMessage(status({ state: "stopped" }))).toContain("paused");
    expect(statusMessage(status({ state: "unavailable" }))).toBe("This machine has no desktop.");
    expect(statusMessage(status({ state: "starting", message: "Booting." }))).toBe("Booting.");
  });
});

describe("helpers", () => {
  it("treats a missing or old URL as expired", () => {
    expect(urlExpired(null, 5)).toBe(true);
    expect(urlExpired({ expiresAt: 10 }, 5)).toBe(false);
    expect(urlExpired({ expiresAt: 10 }, 10)).toBe(true);
  });

  it("makes client ids the server accepts", () => {
    const id = newClientId();
    expect(id).toMatch(/^bbd_[a-z0-9]{20}$/);
    expect(newClientId()).not.toBe(id);
  });

  it("reads BB's light or dark theme", () => {
    const root = (dark: boolean) => ({ classList: { contains: (name: string) => dark && name === "dark" } });
    expect(preferredTheme(root(true), null)).toBe("dark");
    expect(preferredTheme(root(false), "light dark")).toBe("dark");
    expect(preferredTheme(root(false), "light")).toBe("light");
    expect(preferredTheme(root(false), "normal")).toBeNull();
  });
});

describe("DesktopPillView", () => {
  it("reads Desktop, and says when you hold control", () => {
    const idle = renderToStaticMarkup(<DesktopPillView control="agent" onOpen={() => undefined} />);
    expect(idle).toContain('aria-label="Desktop"');
    expect(idle).toContain('data-icon="ComputerCloud"');
    expect(idle).not.toContain('data-state="control"');
    const held = renderToStaticMarkup(<DesktopPillView control="you" onOpen={() => undefined} />);
    expect(held).toContain('aria-label="Desktop, you have control"');
    expect(held).toContain('data-state="control"');
  });
});
