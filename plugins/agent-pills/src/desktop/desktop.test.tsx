import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopControl, DesktopStatus } from "@wy3z/bb-suite/desktop";
import {
  CONTROL_LABEL,
  controlView,
  lostControlNote,
  newClientId,
  pillVisible,
  preferredTheme,
  shouldRenew,
  statusMessage,
  urlExpired,
  viewInput,
} from "./model";

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

const agent: DesktopControl = { holder: "agent", mine: false, agentPaused: false, since: null, expiresAt: null };

function status(overrides: Partial<DesktopStatus> = {}): DesktopStatus {
  return {
    providerId: "boat-sandbox",
    state: "ready",
    message: null,
    interactive: true,
    pausesAgent: true,
    control: agent,
    ...overrides,
  };
}

describe("controlView", () => {
  it("tells this window, another window and the agent apart", () => {
    expect(controlView(null)).toBe("agent");
    expect(controlView(agent)).toBe("agent");
    expect(controlView({ holder: "user", mine: true, agentPaused: true, since: 1, expiresAt: 2 })).toBe("you");
    expect(controlView({ holder: "user", mine: false, agentPaused: true, since: 1, expiresAt: 2 })).toBe("elsewhere");
    expect(CONTROL_LABEL.agent).toBe("Agent has control");
    expect(CONTROL_LABEL.you).toBe("You have control");
  });

  it("explains where lost control went", () => {
    expect(lostControlNote("agent")).toBe("Control went back to the agent.");
    expect(lostControlNote("elsewhere")).toBe("You took control in another window.");
    expect(lostControlNote("you")).toBeNull();
  });
});

describe("renewal", () => {
  it("stops once the page has been hidden for the limit", () => {
    expect(shouldRenew(null, 100_000, 30_000)).toBe(true);
    expect(shouldRenew(80_000, 100_000, 30_000)).toBe(true);
    expect(shouldRenew(70_000, 100_000, 30_000)).toBe(false);
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
  it("asks for the vendor's touch viewer only on a coarse pointer", () => {
    expect(viewInput("thr_1", "dark", true)).toEqual({ threadId: "thr_1", theme: "dark", touch: true });
    expect(viewInput("thr_1", null, false)).toEqual({ threadId: "thr_1", theme: null });
  });

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
