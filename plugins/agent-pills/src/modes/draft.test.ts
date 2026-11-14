import { describe, expect, it } from "vitest";
import type { ComposerDraftSnapshot, ComposerMention } from "@get-bb/plugin-sdk/app";
import { newSkillMentionIndex, skillMentionIn, skillMentionKeys, syncModePill, withoutMention, type ModePill } from "./draft";

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

describe("Alt+Enter skill detection", () => {
  const skill = (from: number, name: string): ComposerMention => ({
    kind: "command",
    trigger: "/",
    name,
    source: "skill",
    origin: "user",
    argumentHint: null,
    label: name,
    from,
    to: from + name.length + 1,
  });

  it("finds a picked skill and whether anything else would be sent", () => {
    expect(skillMentionIn(draft("/reviewer check the README", [skill(0, "reviewer")]))).toEqual({ index: 0, name: "reviewer", hasOtherContent: true });
    expect(skillMentionIn(draft("/reviewer", [skill(0, "reviewer")]))).toEqual({ index: 0, name: "reviewer", hasOtherContent: false });
    expect(skillMentionIn(draft("/reviewer ", [skill(0, "reviewer")]), )?.hasOtherContent).toBe(false);
    expect(skillMentionIn(draft("/reviewer", [skill(0, "reviewer")], 1))?.hasOtherContent).toBe(true);
  });

  it("ignores slash commands that aren't skills", () => {
    const command: ComposerMention = { kind: "command", trigger: "/", name: "compact", source: "command", origin: "builtin", argumentHint: null, label: "compact", from: 0, to: 8 };
    expect(skillMentionIn(draft("/compact", [command]))).toBeNull();
    expect(skillMentionIn(draft("hello"))).toBeNull();
  });

  it("removes the skill mention and shifts the mentions after it", () => {
    const thread: ComposerMention = { kind: "thread", threadId: "thr_1", label: "Other", from: 21, to: 26 };
    expect(withoutMention(draft("/reviewer check with Other", [skill(0, "reviewer"), thread]), 0)).toEqual({
      text: "check with Other",
      mentions: [{ ...thread, from: 11, to: 16 }],
    });
  });

  it("does not count an existing mode pill as content", () => {
    expect(skillMentionIn(draft("alpha /reviewer", [ours(0, pill.id, "alpha"), skill(6, "reviewer")]))?.hasOtherContent).toBe(false);
  });
});

describe("Alt+Enter from the open skill menu", () => {
  const skill = (from: number, name: string): ComposerMention => ({
    kind: "command",
    trigger: "$",
    name,
    source: "skill",
    origin: "user",
    argumentHint: null,
    label: name,
    from,
    to: from + name.length + 1,
  });

  it("finds the skill BB just inserted, not one that was already there", () => {
    const before = draft("$planner hello $debu", [skill(0, "planner")]);
    const after = draft("$planner hello $debugger ", [skill(0, "planner"), skill(15, "debugger")]);
    expect(newSkillMentionIndex(skillMentionKeys(before), after)).toBe(1);
    expect(skillMentionIn(after, 1)).toEqual({ index: 1, name: "debugger", hasOtherContent: true });
  });

  it("reports nothing new when the menu closed without inserting", () => {
    const before = draft("hello $zzz");
    expect(newSkillMentionIndex(skillMentionKeys(before), before)).toBe(-1);
  });

  it("decides send or switch on what is left once the picked skill is removed", () => {
    expect(skillMentionIn(draft("$debugger ", [skill(0, "debugger")]), 0)?.hasOtherContent).toBe(false);
    expect(skillMentionIn(draft("fix this $debugger ", [skill(9, "debugger")]), 0)?.hasOtherContent).toBe(true);
  });
});
