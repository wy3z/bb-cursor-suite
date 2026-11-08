import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Status } from "./contracts";
import { StatusGlyph } from "./glyphs";

const runtime = globalThis as unknown as { __bbPluginRuntime?: unknown };
runtime.__bbPluginRuntime = {
  react: React,
  pluginSdkApp: {
    experimental_Icon: ({ name }: { name: string }) => React.createElement("span", { "data-icon": name, "data-icon-root": "" }),
  },
};

function markup(status: Status): string {
  return renderToStaticMarkup(<StatusGlyph status={status} />);
}

describe("status glyphs", () => {
  it("draws in progress as BB's static Loading spinner", () => {
    const html = markup("in_progress");
    expect(html).toContain('class="bbp-status"');
    expect(html).toContain('data-status="in_progress"');
    expect(html).toContain('data-icon="Loading"');
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain("<svg");
  });

  it("keeps the drawn mark for every other column", () => {
    for (const status of ["backlog", "todo", "in_review", "done", "canceled"] as const) {
      const html = markup(status);
      expect(html).toContain("<svg");
      expect(html).toContain('class="bbp-status"');
      expect(html).not.toContain('data-icon="Loading"');
    }
  });
});
