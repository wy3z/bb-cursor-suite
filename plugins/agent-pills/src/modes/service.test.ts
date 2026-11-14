import { describe, expect, it } from "vitest";
import { createModeService, createTitleFixer, pickSkills, type SkillListing } from "./service";
import { enterText, exitText, maintainText, modeItemId, type ModeMention, type ModeRef } from "./model";
import type { LedgerEvent } from "./ledger";

const A: ModeRef = { skillId: "skill_a", label: "alpha" };
const B: ModeRef = { skillId: "skill_b", label: "beta" };
const PATH_A = "/repo/.agents/skills/alpha/SKILL.md";
const PATH_B = "/repo/.agents/skills/beta/SKILL.md";

function listingOf(ref: ModeRef, path: string, scope = "shared-project"): SkillListing {
  return { id: ref.skillId, name: ref.label, description: null, filePath: path, provider: null, scope };
}

interface Options {
  files?: Record<string, string>;
  slowDraftRead?: Promise<void>;
  extraSkills?: SkillListing[];
}

function core(options: Options = {}) {
  const files: Record<string, string> = options.files ?? { [A.skillId]: "---\nicon: eye\ncolor: purple\n---\nAlpha rules.", [B.skillId]: "Beta rules." };
  const kv = new Map<string, unknown>();
  const logs = new Map<string, LedgerEvent[]>();
  const published: string[] = [];
  const modesPublished: string[] = [];
  const reads: Array<{ environmentId: string | null; skillId: string }> = [];
  let clock = 0;
  let requests = 0;
  let slow = options.slowDraftRead;
  const places = new Map<string, { projectId: string; environmentId: string | null }>();

  const service = createModeService({
    pluginId: "agent-pills",
    listSkills: async () => [
      ...[listingOf(A, PATH_A), listingOf(B, PATH_B)].filter((skill) => files[skill.id] !== undefined),
      ...(options.extraSkills ?? []),
    ],
    readSkill: async ({ skillId, environmentId }) => {
      reads.push({ environmentId, skillId });
      const content = files[skillId];
      if (content === undefined) throw new Error("missing");
      return content;
    },
    readEvents: async ({ threadId, afterSeq, limit }) => (logs.get(threadId) ?? []).filter((event) => event.seq > afterSeq).slice(0, limit),
    threadPlace: async (threadId) => places.get(threadId) ?? { projectId: "proj_1", environmentId: null },
    kv: {
      get: async <T,>(key: string) => {
        const value = kv.get(key) as T | undefined;
        if (slow && key.startsWith("draft:")) {
          const wait = slow;
          slow = undefined;
          await wait;
        }
        return value;
      },
      set: async (key, value) => void kv.set(key, value),
      delete: async (key) => void kv.delete(key),
    },
    publish: (threadId) => published.push(threadId),
    publishModes: (projectId) => modesPublished.push(projectId),
    log: { info: () => undefined, warn: () => undefined },
    now: () => clock,
  });

  function append(threadId: string, type: string, data: unknown): number {
    const log = logs.get(threadId) ?? [];
    const seq = (log.at(-1)?.seq ?? 0) + 1;
    log.push({ seq, type, data });
    logs.set(threadId, log);
    return seq;
  }

  let nonces = 0;
  function pill(threadId: string | null, dest: ModeRef | null, leaving: ModeRef | null = null): ModeMention {
    nonces += 1;
    return { dest, leaving, threadId, projectId: "proj_1", environmentId: "env_hint", nonce: `n${nonces}` };
  }

  function blocksOf(mention: ModeMention | null, text = "hello") {
    const label = mention === null ? "" : (mention.dest?.label ?? `Exit ${mention.leaving?.label ?? ""}`);
    return [
      {
        type: "text",
        text: mention === null ? text : `${label} ${text}`,
        mentions:
          mention === null
            ? []
            : [{ start: 0, end: label.length, resource: { kind: "plugin", pluginId: "agent-pills", label, itemId: `mode:${modeItemId("default", mention)}` } }],
      },
    ];
  }

  async function resolveOnly(mention: ModeMention): Promise<string> {
    return service.resolveMention(modeItemId("default", mention));
  }

  function log(threadId: string, mention: ModeMention | null, context: string, extra: { reject?: boolean } = {}): void {
    requests += 1;
    const requestId = `creq_${requests}`;
    const input: unknown[] = blocksOf(mention);
    if (context.length > 0 && mention !== null) {
      input.push({ type: "text", visibility: "agent-only", mentions: [], text: `Context for @x (resolved by plugin "agent-pills"):\n\n${context}` });
    }
    append(threadId, "client/turn/requested", { requestId, input });
    if (extra.reject) append(threadId, "client/turn/rejected", { requestId, reason: "x", message: "x" });
  }

  async function send(threadId: string, mention: ModeMention | null, extra: { reject?: boolean; skipHook?: boolean; resolvedThread?: string | null } = {}): Promise<string> {
    if (!extra.skipHook) await service.admit(threadId, blocksOf(mention));
    const context = mention === null ? "" : await resolveOnly(mention);
    log(threadId, mention, context, extra);
    return context;
  }

  return {
    service,
    kv,
    logs,
    files,
    reads,
    places,
    published,
    modesPublished,
    append,
    pill,
    send,
    resolveOnly,
    log,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("P1: transitions are owned by the server and follow delivery", () => {
  it("an exit that is admitted but rejected does not consume the exit", async () => {
    const t = core();
    await t.send("thr", t.pill("thr", A));
    await t.service.setDraft("thr", null, 0);
    await t.send("thr", t.pill("thr", null, A), { reject: true });
    expect((await t.service.readState("thr")).committed).toEqual(A);
    expect(await t.send("thr", t.pill("thr", null, A))).toBe(exitText("alpha"));
    expect((await t.service.readState("thr")).committed).toBeNull();
  });

  it("a message held by the hook and never delivered changes nothing", async () => {
    const t = core();
    await t.send("thr", t.pill("thr", A));
    await t.service.admit("thr", [{ type: "text", text: "x", mentions: [] }]);
    expect((await t.service.readState("thr")).committed).toEqual(A);
  });

  it("Send now, which skips the dispatch hook, still gets its transition at delivery", async () => {
    const t = core();
    await t.send("thr", t.pill("thr", A), { skipHook: true });
    const context = await t.send("thr", t.pill("thr", A), { skipHook: true });
    expect(context.startsWith(maintainText("alpha", PATH_A))).toBe(true);
  });

  it("a queued message is judged against the mode in force when it is delivered, not when it was typed", async () => {
    const t = core();
    await t.send("thr", t.pill("thr", A));
    const queued = t.pill("thr", A, A);
    await t.send("thr", t.pill("thr", B, A));
    const context = await t.send("thr", queued);
    expect(context.startsWith(`${exitText("beta")}\n\n${enterText("alpha", PATH_A)}`)).toBe(true);
    expect((await t.service.readState("thr")).committed).toEqual(A);
  });

  it("two tabs sending the same exit deliver it once", async () => {
    const t = core();
    await t.send("thr", t.pill("thr", A));
    const first = t.pill("thr", null, A);
    const second = t.pill("thr", null, A);
    expect(await t.send("thr", first)).toBe(exitText("alpha"));
    expect(await t.send("thr", second)).toBe("");
  });

  it("two resolutions racing ahead of the log still see each other in order", async () => {
    const t = core();
    await t.send("thr", t.pill("thr", A));
    const switchToB = t.pill("thr", B, A);
    const backToA = t.pill("thr", A, A);
    const [first, second] = await Promise.all([t.resolveOnly(switchToB), t.resolveOnly(backToA)]);
    expect(first.startsWith(exitText("alpha"))).toBe(true);
    expect(second.startsWith(exitText("beta"))).toBe(true);
    t.log("thr", switchToB, first);
    t.log("thr", backToA, second);
    expect((await t.service.readState("thr")).committed).toEqual(A);
  });

  it("an in-flight resolution that never reaches the log expires", async () => {
    const t = core();
    await t.send("thr", t.pill("thr", A));
    await t.resolveOnly(t.pill("thr", null, A));
    t.tick(30_000);
    expect((await t.service.readState("thr")).committed).toEqual(A);
  });

  it("a slow draft write with a stale revision is refused and cannot touch the committed mode", async () => {
    let release!: () => void;
    const t = core({ slowDraftRead: new Promise<void>((resolve) => (release = resolve)) });
    const write = t.service.setDraft("thr", B, 0);
    const other = t.service.setDraft("thr", A, 0);
    release();
    const [slowResult, otherResult] = await Promise.all([write, other]);
    expect(slowResult.ok).toBe(true);
    expect(otherResult.ok).toBe(false);
    expect(otherResult.state).toMatchObject({ draft: B, rev: 1 });
    await t.send("thr", t.pill("thr", B));
    expect((await t.service.readState("thr")).committed).toEqual(B);
  });
});

describe("P2: forks, edits, handoff, environments", () => {
  it("a fork inherits the mode from its copied log, and None then sends the exit", async () => {
    const t = core();
    await t.send("thr", t.pill("thr", A));
    t.logs.set("fork", [...(t.logs.get("thr") ?? [])]);
    expect(await t.service.readState("fork")).toMatchObject({ committed: A, draft: A, rev: 0 });
    await t.service.setDraft("fork", null, 0);
    expect(await t.send("fork", t.pill("fork", null, A))).toBe(exitText("alpha"));
  });

  it("an edit that rewinds history rewinds the mode", async () => {
    const t = core();
    await t.send("thr", t.pill("thr", A));
    await t.send("thr", t.pill("thr", B, A));
    const cutoff = t.logs.get("thr")!.at(-1)!.seq;
    t.append("thr", "system/operation", { operation: "edit_message", status: "completed", metadata: { cutoffSequence: cutoff, oldMaxSequence: cutoff } });
    expect((await t.service.readState("thr")).committed).toEqual(A);
  });

  it("clearing the context drops the mode", async () => {
    const t = core();
    await t.send("thr", t.pill("thr", A));
    t.append("thr", "thread/context/cleared", {});
    expect((await t.service.readState("thr")).committed).toBeNull();
    const context = await t.send("thr", t.pill("thr", A, A));
    expect(context.startsWith(enterText("alpha", PATH_A))).toBe(true);
  });

  it("carries a new-thread choice over through the first message's handoff", async () => {
    const t = core();
    await t.send("thr_new", t.pill(null, A));
    expect(await t.service.readState("thr_new")).toMatchObject({ committed: A, draft: A, rev: 1 });
  });

  it("a None chosen before the first dispatch is kept, not resurrected by the handoff", async () => {
    const t = core();
    await t.service.setDraft("thr_new", null, 0);
    await t.send("thr_new", t.pill(null, A));
    expect(await t.service.readState("thr_new")).toMatchObject({ draft: null, rev: 1 });
  });

  it("an exit that empties the state never lets an old message bring the mode back", async () => {
    const t = core();
    await t.send("thr", t.pill(null, A));
    await t.service.setDraft("thr", null, 1);
    await t.send("thr", t.pill("thr", null, A));
    await t.service.admit("thr", [{ type: "text", text: "x", mentions: [] }]);
    expect(await t.service.readState("thr")).toMatchObject({ committed: null, draft: null });
  });

  it("reads the skill from the thread's own environment, not the one the pill was typed against", async () => {
    const t = core();
    t.places.set("thr", { projectId: "proj_1", environmentId: "env_cloud" });
    await t.send("thr", t.pill("thr", A));
    expect(t.reads.at(-1)).toEqual({ environmentId: "env_cloud", skillId: A.skillId });
  });

  it("re-binds a skill by name when the thread's host lists it under another id", async () => {
    const t = core();
    await t.send("thr", t.pill("thr", A));
    const elsewhere: ModeRef = { skillId: "skill_a_on_vm", label: "alpha" };
    t.files[elsewhere.skillId] = t.files[A.skillId]!;
    const context = await t.send("thr", t.pill("thr", elsewhere, A));
    expect(context.startsWith(maintainText("alpha", PATH_A))).toBe(true);
  });

  it("leaves user skills out for a host that can't load them", async () => {
    const t = core({ extraSkills: [listingOf({ skillId: "skill_u", label: "mine" }, "/home/u/.agents/skills/mine/SKILL.md", "shared-user")] });
    const local = await t.service.listModes({ projectId: "p", environmentId: null, providerId: null });
    const remote = await t.service.listModes({ projectId: "p", environmentId: null, providerId: null, excludeUserSkills: true });
    expect(local.map((option) => option.label)).toContain("mine");
    expect(remote.map((option) => option.label)).not.toContain("mine");
  });
});

describe("missing skill files", () => {
  it("drops the mode, sends the exit once, and leaves a notice", async () => {
    const t = core();
    await t.send("thr", t.pill("thr", A));
    delete t.files[A.skillId];
    expect(await t.send("thr", t.pill("thr", A, A))).toBe(exitText("alpha"));
    expect(await t.service.readState("thr")).toMatchObject({
      committed: null,
      draft: null,
      notice: "'alpha' mode couldn't be applied — its skill file may have been renamed or removed. Message sent without it.",
    });
    await t.service.clearNotice("thr");
    expect((await t.service.readState("thr")).notice).toBeNull();
  });

  it("hands a new thread's missing-skill notice to the thread once it exists", async () => {
    const t = core({ files: {} });
    const mention = t.pill(null, A);
    expect(await t.resolveOnly(mention)).toBe("");
    await t.service.admit("thr_new", [
      { type: "text", text: "alpha x", mentions: [{ resource: { kind: "plugin", pluginId: "agent-pills", label: "alpha", itemId: `mode:${modeItemId("x", mention)}` } }] },
    ]);
    expect(await t.service.readState("thr_new")).toMatchObject({ draft: null, notice: expect.stringContaining("'alpha' mode") });
  });
});

describe("skill listing", () => {
  it("answers at once from what it knows, then fills in frontmatter in the background", async () => {
    const t = core();
    const args = { projectId: "proj_1", environmentId: null, providerId: "claude-code" };
    expect((await t.service.listModes(args))[0]).toMatchObject({ label: "alpha", icon: "lightning", color: "default", styled: false });
    await t.service.settled();
    expect(t.modesPublished).toEqual(["proj_1"]);
    expect((await t.service.listModes(args))[0]).toMatchObject({ label: "alpha", icon: "eye", color: "purple", styled: true, path: PATH_A });
  });

  it("starts warm from the frontmatter saved in plugin storage", async () => {
    const first = core();
    await first.service.listModes({ projectId: "p", environmentId: null, providerId: null });
    await first.service.settled();
    const second = core();
    second.kv.set("frontmatter:v1", first.kv.get("frontmatter:v1"));
    expect((await second.service.listModes({ projectId: "p", environmentId: null, providerId: null }))[0]).toMatchObject({ color: "purple" });
  });

  it("lists mode-flagged skills first", async () => {
    const t = core({ files: { [A.skillId]: "---\nname: alpha\n---\n", [B.skillId]: "---\nmode: true\n---\n" } });
    const args = { projectId: "p", environmentId: null, providerId: null };
    await t.service.listModes(args);
    await t.service.settled();
    expect((await t.service.listModes(args)).map((option) => [option.label, option.mode])).toEqual([
      ["beta", true],
      ["alpha", false],
    ]);
  });

  it("serves stale entries and refreshes them in the background", async () => {
    const t = core();
    const args = { projectId: "p", environmentId: null, providerId: null };
    await t.service.listModes(args);
    await t.service.settled();
    t.files[A.skillId] = "---\ncolor: red\n---\nAlpha rules.";
    t.tick(60_000);
    expect((await t.service.listModes(args))[0]?.color).toBe("purple");
    await t.service.settled();
    expect((await t.service.listModes(args))[0]?.color).toBe("red");
  });

  it("prefers the thread's provider and project skills when names collide", () => {
    const base = listingOf(A, PATH_A);
    const picked = pickSkills(
      [
        { ...base, id: "a", provider: "codex", scope: "provider-user" },
        { ...base, id: "b", provider: "claude-code", scope: "provider-user" },
        { ...base, id: "c", name: "zeta", scope: "plugin" },
        { ...base, id: "d", name: "beta", scope: "provider-project" },
      ],
      "claude-code",
    );
    expect(picked.map((skill) => skill.id)).toEqual(["d", "b", "c"]);
  });
});

describe("thread titles", () => {
  it("notices a first message whose fallback title starts with the mode pill", () => {
    const t = core();
    const mention = t.pill(null, A);
    const blocks = [{ type: "text", text: "alpha The cart", mentions: [{ resource: { kind: "plugin", pluginId: "agent-pills", label: "alpha", itemId: `mode:${modeItemId("x", mention)}` } }] }];
    const thread = { id: "thr_1", title: null, titleFallback: "alpha The cart" };
    const withContext = [...blocks, { type: "text", visibility: "agent-only", text: "Context for @alpha (resolved by plugin \"agent-pills\"):\n\nRules." }];
    expect(t.service.titleFixFor(thread, withContext)).toEqual({ threadId: "thr_1", label: "alpha", own: "The cart" });
    expect(t.service.titleFixFor({ ...thread, title: "Named" }, blocks)).toBeNull();
    expect(t.service.titleFixFor({ ...thread, titleFallback: "Hello" }, blocks)).toBeNull();
  });

  it("sets the user's own words once the first turn settles, unless a real title arrived", async () => {
    const titles: Record<string, { title: string | null; titleFallback: string | null }> = {
      thr_1: { title: null, titleFallback: "alpha The cart" },
      thr_2: { title: "Fix cart rounding", titleFallback: "alpha The cart" },
      thr_3: { title: "alpha The cart", titleFallback: "alpha The cart" },
    };
    const set: Array<[string, string]> = [];
    const fixer = createTitleFixer({
      getThread: async (threadId) => titles[threadId]!,
      setTitle: async (threadId, title) => void set.push([threadId, title]),
      log: { info: () => undefined, warn: () => undefined },
      delayMs: 60_000,
    });
    for (const threadId of ["thr_1", "thr_2", "thr_3"]) {
      fixer.track({ threadId, label: "alpha", own: "The cart" });
      await fixer.apply(threadId);
    }
    await fixer.apply("thr_1");
    fixer.dispose();
    expect(set).toEqual([
      ["thr_1", "The cart"],
      ["thr_3", "The cart"],
    ]);
  });
});
