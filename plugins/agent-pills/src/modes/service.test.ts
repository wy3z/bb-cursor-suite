import { describe, expect, it } from "vitest";
import { createModeService, pickSkills } from "./service";
import { encodeModeMention, enterText, exitText, maintainText, type ModeRef } from "./model";

const reviewer: ModeRef = { skillId: "skill_reviewer", label: "reviewer" };
const PATH = "/repo/.agents/skills/reviewer/SKILL.md";
const listing = {
  id: reviewer.skillId,
  name: "reviewer",
  description: "Careful reviews",
  filePath: PATH,
  provider: null,
  scope: "shared-project",
};

function harness(files: Record<string, string> = { [reviewer.skillId]: "---\nicon: eye\ncolor: purple\n---\nRules." }) {
  const kv = new Map<string, unknown>();
  const published: string[] = [];
  const logs: string[] = [];
  const service = createModeService({
    pluginId: "agent-pills",
    listSkills: async () => (files[reviewer.skillId] === undefined ? [] : [listing]),
    readSkill: async ({ skillId }) => {
      const content = files[skillId];
      if (content === undefined) throw new Error("missing");
      return content;
    },
    kv: {
      get: async <T,>(key: string) => kv.get(key) as T | undefined,
      set: async (key, value) => void kv.set(key, value),
      delete: async (key) => void kv.delete(key),
    },
    publish: (threadId) => published.push(threadId),
    log: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
  });
  return { service, kv, published, logs, files };
}

function blocks(transition: Parameters<typeof encodeModeMention>[0]["transition"]) {
  const itemId = `mode:purple.${encodeModeMention({ transition, projectId: "proj_1", environmentId: null })}`;
  return [{ type: "text", text: "reviewer hi", mentions: [{ start: 0, end: 8, resource: { kind: "plugin", pluginId: "agent-pills", label: "reviewer", itemId } }] }];
}

describe("mode service", () => {
  it("lists skills with frontmatter icon and color", async () => {
    const { service } = harness();
    const modes = await service.listModes({ projectId: "proj_1", environmentId: null, providerId: "claude-code" });
    expect(modes).toEqual([
      expect.objectContaining({ skillId: reviewer.skillId, label: "reviewer", icon: "eye", color: "purple", styled: true, path: PATH }),
    ]);
  });

  it("prefers the thread's provider and project skills when names collide", () => {
    const picked = pickSkills(
      [
        { ...listing, id: "a", provider: "codex", scope: "provider-user" },
        { ...listing, id: "b", provider: "claude-code", scope: "provider-user" },
        { ...listing, id: "c", name: "alpha", scope: "plugin" },
        { ...listing, id: "d", name: "zeta", scope: "provider-project" },
      ],
      "claude-code",
    );
    expect(picked.map((skill) => skill.id)).toEqual(["d", "b", "c"]);
  });

  it("resolves enter, maintain and exit text with a fresh read of the skill", async () => {
    const { service, files } = harness();
    const enter = await service.resolveMention(`purple.${encodeModeMention({ transition: { kind: "enter", mode: reviewer }, projectId: "p", environmentId: null })}`);
    expect(enter.startsWith(enterText("reviewer", PATH))).toBe(true);
    expect(enter).toContain("Rules.");
    files[reviewer.skillId] = "Rules, edited.";
    const maintain = await service.resolveMention(encodeModeMention({ transition: { kind: "maintain", mode: reviewer }, projectId: "p", environmentId: null }));
    expect(maintain.startsWith(maintainText("reviewer", PATH))).toBe(true);
    expect(maintain).toContain("Rules, edited.");
    const exit = await service.resolveMention(encodeModeMention({ transition: { kind: "exit", exited: reviewer }, projectId: "p", environmentId: null }));
    expect(exit).toBe(exitText("reviewer"));
  });

  it("carries a new-thread selection into the spawned thread on its first dispatch", async () => {
    const { service, published } = harness();
    await service.commitDispatch("thr_new", blocks({ kind: "enter", mode: reviewer }));
    expect(await service.readState("thr_new")).toEqual({ committed: reviewer, draft: reviewer, notice: null });
    expect(published).toEqual(["thr_new"]);
  });

  it("keeps the user's draft and clears the committed mode after an exit", async () => {
    const { service } = harness();
    await service.setDraft("thr_1", reviewer);
    await service.commitDispatch("thr_1", blocks({ kind: "enter", mode: reviewer }));
    await service.setDraft("thr_1", null);
    await service.commitDispatch("thr_1", blocks({ kind: "exit", exited: reviewer }));
    expect(await service.readState("thr_1")).toEqual({ committed: null, draft: null, notice: null });
  });

  it("is idempotent when a dispatch is retried", async () => {
    const { service, published } = harness();
    await service.commitDispatch("thr_1", blocks({ kind: "enter", mode: reviewer }));
    await service.commitDispatch("thr_1", blocks({ kind: "enter", mode: reviewer }));
    expect(published).toEqual(["thr_1"]);
  });

  it("drops the mode and leaves a notice when the skill file is gone", async () => {
    const { service } = harness({});
    await service.commitDispatch("thr_1", blocks({ kind: "maintain", mode: reviewer }));
    expect(await service.readState("thr_1")).toEqual({
      committed: null,
      draft: null,
      notice: "'reviewer' mode couldn't be applied — its skill file may have been renamed or removed. Message sent without it.",
    });
    expect(await service.resolveMention(encodeModeMention({ transition: { kind: "enter", mode: reviewer }, projectId: "p", environmentId: null }))).toBe("");
    await service.clearNotice("thr_1");
    expect(await service.readState("thr_1")).toEqual({ committed: null, draft: null, notice: null });
  });

  it("ignores messages without a mode pill", async () => {
    const { service, published } = harness();
    await service.commitDispatch("thr_1", [{ type: "text", text: "hi", mentions: [] }]);
    expect(published).toEqual([]);
  });
});

describe("frontmatter cache", () => {
  it("answers from the cache and refreshes stale entries in the background", async () => {
    let clock = 0;
    let reads = 0;
    const files: Record<string, string> = { [reviewer.skillId]: "---\ncolor: purple\n---\nRules." };
    const service = createModeService({
      pluginId: "agent-pills",
      listSkills: async () => [listing],
      readSkill: async ({ skillId }) => {
        reads += 1;
        return files[skillId]!;
      },
      kv: { get: async () => undefined, set: async () => undefined, delete: async () => undefined },
      publish: () => undefined,
      log: { info: () => undefined, warn: () => undefined },
      now: () => clock,
    });
    const args = { projectId: "p", environmentId: null, providerId: null };
    expect((await service.listModes(args))[0]?.color).toBe("purple");
    files[reviewer.skillId] = "---\ncolor: red\n---\nRules.";
    clock = 60_000;
    expect((await service.listModes(args))[0]?.color).toBe("purple");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await service.listModes(args))[0]?.color).toBe("red");
    expect(reads).toBe(2);
  });
});
