import { describe, expect, it } from "vitest";
import type { ComposerDraftSnapshot, ComposerMention } from "@get-bb/plugin-sdk/app";
import { syncModePill, type ModePill } from "./draft";

const pill: ModePill = { pluginId: "agent-pills", provider: "mode", id: "purple.abc", label: "reviewer", icon: "bb-agent-pills-mode-eye" };

function draft(text: string, mentions: ComposerMention[] = [], attachments = 0): ComposerDraftSnapshot {
  return {
    text,
    mentions,
    attachments: Array.from({ length: attachments }, (_, index) => ({ type: "localFile" as const, path: `f${index}`, name: `f${index}` })),
  };
}

const ours = (from: number, id = pill.id, label = pill.label): ComposerMention => ({
  kind: "plugin",
  pluginId: "agent-pills",
  provider: "mode",
  id,
  label,
  icon: pill.icon,
  from,
  to: from + label.length,
});

describe("syncModePill", () => {
  it("leaves an empty draft empty", () => {
    expect(syncModePill(draft(""), pill, "agent-pills", "mode")).toBeNull();
    expect(syncModePill(draft("   "), pill, "agent-pills", "mode")).toBeNull();
  });

  it("puts the pill first once the draft has content, shifting other mentions", () => {
    const thread: ComposerMention = { kind: "thread", threadId: "thr_1", label: "Other", from: 4, to: 9 };
    const next = syncModePill(draft("see Other", [thread]), pill, "agent-pills", "mode");
    expect(next?.text).toBe("reviewer see Other");
    expect(next?.mentions[0]).toMatchObject({ kind: "plugin", id: pill.id, from: 0, to: 8 });
    expect(next?.mentions[1]).toMatchObject({ kind: "thread", from: 13, to: 18 });
  });

  it("counts attachments as content", () => {
    expect(syncModePill(draft("", [], 1), pill, "agent-pills", "mode")?.text).toBe("reviewer ");
  });

  it("does nothing when the right pill is already there", () => {
    expect(syncModePill(draft("reviewer hello", [ours(0)]), pill, "agent-pills", "mode")).toBeNull();
  });

  it("replaces a stale pill after a switch", () => {
    const next = syncModePill(draft("planner hello", [ours(0, "blue.old", "planner")]), pill, "agent-pills", "mode");
    expect(next?.text).toBe("reviewer hello");
    expect(next?.mentions).toHaveLength(1);
    expect(next?.mentions[0]).toMatchObject({ id: pill.id });
  });

  it("removes the pill when the mode is cleared or the rest is deleted", () => {
    expect(syncModePill(draft("reviewer hello", [ours(0)]), null, "agent-pills", "mode")).toEqual({ text: "hello", mentions: [] });
    expect(syncModePill(draft("reviewer ", [ours(0)]), pill, "agent-pills", "mode")).toEqual({ text: "", mentions: [] });
  });

  it("ignores other plugins' mentions", () => {
    const other: ComposerMention = { kind: "plugin", pluginId: "elsewhere", provider: "mode", id: "x", label: "x", from: 0, to: 1 };
    expect(syncModePill(draft("x", [other]), null, "agent-pills", "mode")).toBeNull();
  });
});
