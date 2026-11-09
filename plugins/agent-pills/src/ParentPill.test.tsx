import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ParentPillView, parentLabel, resolveParent } from "./ParentPill";

const runtime = globalThis as unknown as { __bbPluginRuntime?: unknown };
runtime.__bbPluginRuntime = {
  react: React,
  pluginSdkApp: {
    experimental_Icon: ({ name }: { name: string }) => React.createElement("span", { "data-icon": name }),
  },
};

type Thread = Parameters<typeof resolveParent>[1][number];

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: "proj_a",
    displayTitle: `Title ${id}`,
    parentThreadId: null,
    sourceThreadId: null,
    originKind: null,
    isArchived: false,
    ...overrides,
  };
}

const lead = thread("thr_lead", { displayTitle: "Plan the launch" });

describe("resolveParent", () => {
  it("links a spawned child to its parent", () => {
    const child = thread("thr_child", { parentThreadId: "thr_lead" });
    expect(resolveParent("thr_child", [lead, child])).toEqual({
      threadId: "thr_lead",
      title: "Plan the launch",
      relationship: "parent",
    });
  });

  it("links a parent in another project", () => {
    const child = thread("thr_child", { parentThreadId: "thr_lead", projectId: "proj_b" });
    expect(resolveParent("thr_child", [lead, child])?.threadId).toBe("thr_lead");
  });

  it("links a fork to its source thread", () => {
    const source = thread("thr_source", { displayTitle: "Original" });
    const fork = thread("thr_fork", {
      parentThreadId: "thr_lead",
      sourceThreadId: "thr_source",
      originKind: "fork",
    });
    expect(resolveParent("thr_fork", [lead, source, fork])).toEqual({
      threadId: "thr_source",
      title: "Original",
      relationship: "fork",
    });
  });

  it("falls back to the parent for a fork without a source", () => {
    const fork = thread("thr_fork", { parentThreadId: "thr_lead", originKind: "fork" });
    expect(resolveParent("thr_fork", [lead, fork])?.relationship).toBe("fork");
    expect(resolveParent("thr_fork", [lead, fork])?.threadId).toBe("thr_lead");
  });

  it("drops a fork whose source is in another project", () => {
    const source = thread("thr_source", { projectId: "proj_b" });
    const fork = thread("thr_fork", { sourceThreadId: "thr_source", originKind: "fork" });
    expect(resolveParent("thr_fork", [source, fork])).toBeNull();
  });

  it("returns null for a root thread", () => {
    expect(resolveParent("thr_lead", [lead])).toBeNull();
  });

  it("returns null when the thread or its parent is not listed", () => {
    const child = thread("thr_child", { parentThreadId: "thr_gone" });
    expect(resolveParent("thr_child", [child])).toBeNull();
    expect(resolveParent("thr_missing", [lead])).toBeNull();
  });

  it("returns null when the parent is archived", () => {
    const archived = thread("thr_lead", { isArchived: true });
    const child = thread("thr_child", { parentThreadId: "thr_lead" });
    expect(resolveParent("thr_child", [archived, child])).toBeNull();
  });

  it("ignores a thread that names itself as parent", () => {
    const loop = thread("thr_loop", { parentThreadId: "thr_loop" });
    expect(resolveParent("thr_loop", [loop])).toBeNull();
  });
});

describe("ParentPillView", () => {
  it("labels the pill with the relationship and title", () => {
    expect(parentLabel({ threadId: "thr_lead", title: "Plan the launch", relationship: "parent" })).toBe(
      "Parent Plan the launch",
    );
    expect(parentLabel({ threadId: "thr_lead", title: "Original", relationship: "fork" })).toBe(
      "Forked from Original",
    );
  });

  it("renders one pill and never the raw banner body", () => {
    const html = renderToStaticMarkup(
      <ParentPillView
        parent={{ threadId: "thr_lead", title: "Plan the launch", relationship: "parent" }}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('data-group="parent"');
    expect(html).toContain('aria-label="Parent Plan the launch"');
    expect(html).toContain('data-icon="UserRound"');
    expect(html).toContain(">Parent Plan the launch</span>");
    expect(html).not.toContain("This thread is a child of");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("uses the fork icon for a fork", () => {
    const html = renderToStaticMarkup(
      <ParentPillView parent={{ threadId: "thr_s", title: "Original", relationship: "fork" }} onOpen={() => undefined} />,
    );
    expect(html).toContain('data-icon="Fork"');
  });
});
