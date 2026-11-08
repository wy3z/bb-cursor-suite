import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginAvailability } from "@wy3z/bb-suite/plugin-availability";
import { CommitBar } from "./CommitBar";
import { AgentRow, type TrayItem } from "./pills/AgentsTray";

const calls: string[] = [];
const runtime = globalThis as unknown as { __bbPluginRuntime?: unknown };
runtime.__bbPluginRuntime = {
  react: React,
  pluginSdkApp: {
    experimental_Icon: ({ name }: { name: string }) => React.createElement("span", { "data-icon": name }),
    experimental_ThreadStatusGlyph: () => React.createElement("span", { "data-glyph": "" }),
    useSdk: () => ({
      plugins: {
        callRpc: async ({ method }: { method: string }) => {
          calls.push(method);
          throw new Error("No plugin pull-requests");
        },
      },
    }),
    useBbNavigate: () => ({ toThread: () => undefined }),
  },
};

interface Control {
  text: string;
  label: string | null;
  title: string | null;
  disabled: boolean;
}

const decode = (text: string) => text.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const attribute = (attrs: string, name: string) => {
  const match = attrs.match(new RegExp(` ${name}="([^"]*)"`));
  return match ? decode(match[1]!) : null;
};

function controls(html: string, tag: "button" | "textarea" | "input"): Control[] {
  const pattern = tag === "input" ? /<input([^>]*)\/?>()/g : new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)</${tag}>`, "g");
  return [...html.matchAll(pattern)].map(([, attrs = "", inner = ""]) => ({
    text: decode(inner.replace(/<[^>]+>/g, "")),
    label: attribute(attrs, "aria-label"),
    title: attribute(attrs, "title"),
    disabled: / disabled=""/.test(attrs),
  }));
}

function bar(gitActions: PluginAvailability, uncommitted = true): string {
  return renderToStaticMarkup(<CommitBar environmentId="env_1" uncommitted={uncommitted} untracked={1} gitActions={gitActions} />);
}

const buttons = (html: string) => controls(html, "button");
const note = (html: string) => html.match(/<div[^>]*role="note"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? null;

const child: TrayItem = {
  type: "thread",
  key: "thread:thr_1",
  state: "done",
  title: "Worker",
  model: null,
  startedAt: 0,
  thread: { threadId: "thr_1", title: "Worker", state: "done", model: null, createdAt: 0, environmentId: "env_2", isWorktree: true },
};

function row(gitActions: PluginAvailability): string {
  return renderToStaticMarkup(
    <AgentRow item={child} now={0} canApply gitActions={gitActions} apply={undefined} onOpen={() => undefined} onClose={() => undefined} onApply={() => undefined} />,
  );
}

const applyButton = (html: string) => buttons(html).find((button) => button.label === "Apply Worker locally");

describe("commit bar with Pull Requests enabled", () => {
  it("offers Commit, Commit & Push and Create PR", () => {
    const html = bar("available");
    expect(buttons(html).map((button) => button.text)).toEqual(["Commit", "Commit & Push", "Create PR"]);
    expect(buttons(html).every((button) => !button.disabled)).toBe(true);
    expect(controls(html, "textarea")[0]?.disabled).toBe(false);
    expect(html).not.toContain("Needs Pull Requests");
  });

  it("offers Push and Create PR on a clean tree", () => {
    const html = bar("available", false);
    expect(buttons(html).map((button) => button.text)).toEqual(["Push", "Create PR"]);
    expect(buttons(html).every((button) => !button.disabled)).toBe(true);
  });
});

describe("commit bar without Pull Requests", () => {
  it("disables every git action and says it needs Pull Requests", () => {
    for (const uncommitted of [true, false]) {
      const html = bar("unavailable", uncommitted);
      expect(buttons(html).length).toBeGreaterThan(0);
      for (const button of buttons(html)) {
        expect(button.disabled).toBe(true);
        expect(button.title).toBe("Needs Pull Requests");
      }
      expect(note(html)).toContain("Needs Pull Requests");
    }
    expect(controls(bar("unavailable"), "textarea")[0]?.disabled).toBe(true);
    expect(controls(bar("unavailable"), "input")[0]?.disabled).toBe(true);
  });

  it("stays disabled without the note while availability is still loading", () => {
    const html = bar("unknown");
    expect(buttons(html).every((button) => button.disabled)).toBe(true);
    expect(note(html)).toBeNull();
  });

  it("never calls pull-requests", () => {
    bar("unavailable");
    bar("unknown");
    expect(calls).toEqual([]);
  });
});

describe("Apply locally in the Agents tray", () => {
  it("is enabled with Pull Requests", () => {
    const button = applyButton(row("available"));
    expect(button?.disabled).toBe(false);
    expect(button?.title).not.toContain("Needs Pull Requests");
  });

  it("is disabled and labelled without Pull Requests", () => {
    const button = applyButton(row("unavailable"));
    expect(button?.disabled).toBe(true);
    expect(button?.title).toContain("Needs Pull Requests");
    expect(applyButton(row("unknown"))?.disabled).toBe(true);
  });
});
