import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MergeMethod } from "@/lib/merge-method";
import { mergeAction, PrimaryActionButton } from "./primary-action";

const runtime = globalThis as unknown as { __bbPluginRuntime?: unknown };
runtime.__bbPluginRuntime = {
  react: React,
  pluginSdkApp: {
    experimental_Icon: ({ name }: { name: string }) => React.createElement("span", { "data-icon": name }),
  },
};

function recorder() {
  const calls: MergeMethod[] = [];
  return { calls, merge: (method: MergeMethod) => void calls.push(method) };
}

describe("the merge action", () => {
  it("merges with the repository default and lists only the other allowed methods", () => {
    const { calls, merge } = recorder();
    const action = mergeAction({ allowed: ["merge", "rebase"], defaultMethod: "merge" }, merge, undefined);
    expect(action.label).toBe("Merge");
    expect(action.title).toBeUndefined();
    expect(action.menu?.map((option) => option.label)).toEqual(["Rebase and merge"]);
    action.run();
    action.menu?.[0]?.run();
    expect(calls).toEqual(["merge", "rebase"]);
  });

  it("offers a merge commit in the menu as Create a merge commit", () => {
    const action = mergeAction({ allowed: ["merge", "squash"], defaultMethod: "squash" }, () => undefined, undefined);
    expect(action.label).toBe("Squash and merge");
    expect(action.menu?.map((option) => option.label)).toEqual(["Create a merge commit"]);
  });

  it("labels itself by the default method", () => {
    const { merge } = recorder();
    expect(mergeAction({ allowed: ["merge", "squash", "rebase"], defaultMethod: "squash" }, merge, undefined).label).toBe("Squash and merge");
    expect(mergeAction({ allowed: ["merge", "squash", "rebase"], defaultMethod: "rebase" }, merge, undefined).label).toBe("Rebase and merge");
  });

  it("does not squash when the repository settings are unknown", () => {
    const { calls, merge } = recorder();
    const action = mergeAction(null, merge, undefined);
    action.run();
    expect(action.label).toBe("Merge");
    expect(action.title).toBe("Couldn’t read this repo’s merge settings");
    expect(calls).toEqual(["merge"]);
    expect(action.menu?.map((option) => option.label)).toEqual(["Squash and merge", "Rebase and merge"]);
  });

  it("prefers the blocked reason over the unknown-settings tooltip", () => {
    expect(mergeAction(null, () => undefined, "Conflicts").title).toBe("Conflicts");
  });

  it("carries the reason it is blocked", () => {
    const action = mergeAction({ allowed: ["squash"], defaultMethod: "squash" }, () => undefined, "Conflicts");
    expect(action.disabled).toBe(true);
    expect(action.title).toBe("Conflicts");
    expect(action.menu).toEqual([]);
  });
});

describe("the primary action button", () => {
  it("shows the method label with a menu trigger for the other methods", () => {
    const action = mergeAction({ allowed: ["merge", "squash", "rebase"], defaultMethod: "rebase" }, () => undefined, undefined);
    const html = renderToStaticMarkup(<PrimaryActionButton action={action} busy={null} />);
    expect(html).toContain(">Rebase and merge</button>");
    expect(html).toContain('aria-label="Other merge methods"');
    expect(html).not.toContain("Merge pull request");
  });

  it("drops the menu trigger when only one method is allowed", () => {
    const action = mergeAction({ allowed: ["squash"], defaultMethod: "squash" }, () => undefined, undefined);
    const html = renderToStaticMarkup(<PrimaryActionButton action={action} busy={null} />);
    expect(html).toContain(">Squash and merge</button>");
    expect(html).not.toContain("Other merge methods");
  });

  it("explains the fallback when the repository settings are unknown", () => {
    const html = renderToStaticMarkup(<PrimaryActionButton action={mergeAction(null, () => undefined, undefined)} busy={null} />);
    expect(html).toContain('title="Couldn’t read this repo’s merge settings"');
    expect(html).toContain(">Merge</button>");
  });

  it("shows the busy label and disables both halves while merging", () => {
    const action = mergeAction({ allowed: ["merge", "squash"], defaultMethod: "merge" }, () => undefined, undefined);
    const html = renderToStaticMarkup(<PrimaryActionButton action={action} busy="merge" />);
    expect(html).toContain("Merging…");
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });
});
