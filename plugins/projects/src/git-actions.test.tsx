import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginAvailability } from "@wy3z/bb-suite/plugin-availability";
import { GitActionItems } from "./Card";

const runtime = globalThis as unknown as { __bbPluginRuntime?: unknown };
runtime.__bbPluginRuntime = {
  react: React,
  pluginSdkApp: {
    experimental_Icon: ({ name }: { name: string }) => React.createElement("span", { "data-icon": name }),
  },
};

interface Item {
  text: string;
  title: string | null;
  disabled: boolean;
}

function items(gitActions: PluginAvailability, canApply = true, canCreatePr = true): Item[] {
  const html = renderToStaticMarkup(
    <GitActionItems gitActions={gitActions} canApply={canApply} canCreatePr={canCreatePr} onApply={() => undefined} onCreatePr={() => undefined} />,
  );
  return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs = "", inner = ""]) => ({
    text: inner.replace(/<[^>]+>/g, ""),
    title: attrs.match(/ title="([^"]*)"/)?.[1] ?? null,
    disabled: / disabled=""/.test(attrs),
  }));
}

describe("card menu git actions", () => {
  it("are enabled with Pull Requests", () => {
    expect(items("available")).toEqual([
      { text: "Apply locally", title: null, disabled: false },
      { text: "Create PR", title: null, disabled: false },
    ]);
  });

  it("are disabled and say they need Pull Requests without it", () => {
    expect(items("unavailable")).toEqual([
      { text: "Apply locallyNeeds Pull Requests", title: "Needs Pull Requests", disabled: true },
      { text: "Create PRNeeds Pull Requests", title: "Needs Pull Requests", disabled: true },
    ]);
  });

  it("stay disabled without the reason while availability loads", () => {
    expect(items("unknown").map((item) => item.disabled)).toEqual([true, true]);
    expect(items("unknown").every((item) => item.title === null)).toBe(true);
  });

  it("keep the card's own conditions", () => {
    expect(items("available", false, true).map((item) => item.text)).toEqual(["Create PR"]);
    expect(items("unavailable", true, false).map((item) => item.text)).toEqual(["Apply locallyNeeds Pull Requests"]);
    expect(items("available", false, false)).toEqual([]);
  });
});
