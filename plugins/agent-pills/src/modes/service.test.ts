import { describe, expect, it } from "vitest";
import { createModeService, createTitleFixer, pickSkills, type SkillListing } from "./service";
import { modeItemId, modeText, type ModeMention, type ModeRef } from "./model";

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
  const published: string[] = [];
  const modesPublished: string[] = [];
  const reads: Array<{ environmentId: string | null; skillId: string }> = [];
  let clock = 0;
  let slow = options.slowDraftRead;
  const places = new Map<string, { projectId: string; environmentId: string | null } | null>();

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
    threadPlace: async (threadId) => (places.has(threadId) ? places.get(threadId)! : { projectId: "proj_1", environmentId: "env_thread" }),
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

  let nonces = 0;
  function pill(threadId: string | null, mode: ModeRef, rev = 0): ModeMention {
    nonces += 1;
    return { mode, rev, threadId, projectId: "proj_1", environmentId: "env_hint", nonce: `n${nonces}` };
  }

  function blocksOf(mention: ModeMention) {
    const label = mention.mode.label;
    return [
      {
        type: "text",
        text: `${label} hello`,
        mentions: [{ start: 0, end: label.length, resource: { kind: "plugin", pluginId: "agent-pills", label, itemId: `mode:${modeItemId("default", mention)}` } }],
      },
    ];
  }

  async function send(threadId: string, mention: ModeMention): Promise<string> {
    await service.admit(threadId, blocksOf(mention));
    return service.resolveMention(modeItemId("default", mention));
  }

  return {
    service,
    kv,
    files,
    reads,
    places,
    published,
    modesPublished,
    pill,
    blocksOf,
    send,
    resolve: (mention: ModeMention) => service.resolveMention(modeItemId("default", mention)),
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("a message sent in a mode", () => {
  it("gets the fixed mode line and the fresh SKILL.md, on the first message and every later one", async () => {
    const t = core();
    const first = await t.send("thr", t.pill("thr", A));
    expect(first).toBe(`${modeText("alpha", PATH_A)}\n\n<skill name="alpha" path="${PATH_A}">\nAlpha rules.\n</skill>`);
    t.files[A.skillId] = "Alpha rules, edited.";
    expect(await t.send("thr", t.pill("thr", A))).toContain("Alpha rules, edited.");
  });

  it("depends only on its own pill, so order, queues, tabs and failed sends don't matter", async () => {
    const t = core();
    const queued = t.pill("thr", A);
    await t.send("thr", t.pill("thr", B));
    expect((await t.resolve(queued)).startsWith(modeText("alpha", PATH_A))).toBe(true);
    expect((await t.resolve(queued)).startsWith(modeText("alpha", PATH_A))).toBe(true);
  });

  it("reads the skill from the thread's own environment, not the one the pill was typed against", async () => {
    const t = core();
    t.places.set("thr", { projectId: "proj_1", environmentId: "env_cloud" });
    await t.send("thr", t.pill("thr", A));
    expect(t.reads.at(-1)).toEqual({ environmentId: "env_cloud", skillId: A.skillId });
  });

  it("falls back to the pill's workspace while the thread's environment isn't ready", async () => {
    const t = core();
    t.places.set("thr", null);
    await t.send("thr", t.pill("thr", A));
    expect(t.reads.at(-1)).toEqual({ environmentId: "env_hint", skillId: A.skillId });
  });

  it("re-binds a skill by name when the thread's host lists it under another id", async () => {
    const t = core();
    const elsewhere: ModeRef = { skillId: "skill_a_on_vm", label: "alpha" };
    expect((await t.send("thr", t.pill("thr", elsewhere))).startsWith(modeText("alpha", PATH_A))).toBe(true);
  });
});

describe("draft selection", () => {
  it("starts at None and refuses a write against a stale revision", async () => {
    let release!: () => void;
    const t = core({ slowDraftRead: new Promise<void>((resolve) => (release = resolve)) });
    const write = t.service.setDraft("thr", B, 0);
    const other = t.service.setDraft("thr", A, 0);
    release();
    const [slowResult, otherResult] = await Promise.all([write, other]);
    expect(slowResult.ok).toBe(true);
    expect(otherResult).toMatchObject({ ok: false, state: { draft: B, rev: 1 } });
    expect(await core().service.readState("thr_fresh")).toEqual({ draft: null, rev: 0, notice: null });
  });
});

describe("first-message pills", () => {
  it("carry a new-thread choice over to the created thread", async () => {
    const t = core();
    await t.send("thr_new", t.pill(null, A));
    expect(await t.service.readState("thr_new")).toMatchObject({ draft: A, rev: 1 });
  });

  it("don't override a choice already recorded for the thread", async () => {
    const t = core();
    await t.service.setDraft("thr_new", null, 0);
    await t.send("thr_new", t.pill(null, A));
    expect(await t.service.readState("thr_new")).toMatchObject({ draft: null, rev: 1 });
  });

  it("are bound to the created thread, so a later resolution without admission reads from that thread's ready environment", async () => {
    const t = core();
    const first = t.pill(null, A);
    await t.resolve(first);
    expect(t.reads.at(-1)?.environmentId).toBe("env_hint");
    await t.service.admit("thr_new", t.blocksOf(first));
    t.places.set("thr_new", { projectId: "proj_1", environmentId: "env_ready" });
    t.tick(120_000);
    await t.resolve(first);
    expect(t.reads.at(-1)).toEqual({ environmentId: "env_ready", skillId: A.skillId });
  });

  it("keep their first binding when admitted again", async () => {
    const t = core();
    const first = t.pill(null, A);
    await t.send("thr_new", first);
    await t.service.admit("thr_other", t.blocksOf(first));
    expect(t.kv.get(`pill:${first.nonce}`)).toBe("thr_new");
  });
});

describe("missing skill files", () => {
  it("send nothing, clear the mode it was sent under and leave a notice", async () => {
    const t = core();
    await t.service.setDraft("thr", A, 0);
    delete t.files[A.skillId];
    expect(await t.send("thr", t.pill("thr", A, 1))).toBe("");
    expect(await t.service.readState("thr")).toEqual({
      draft: null,
      rev: 2,
      notice: "'alpha' mode couldn't be applied — its skill file may have been renamed or removed. Message sent without it.",
    });
    expect(await t.service.exitFlag.get("thr")).toBe(true);
    await t.service.clearNotice("thr");
    expect((await t.service.readState("thr")).notice).toBeNull();
  });

  it("leave a newer healthy selection alone when an old message's skill is gone", async () => {
    const t = core();
    await t.service.setDraft("thr", A, 0);
    const old = t.pill("thr", A, 1);
    await t.service.setDraft("thr", B, 1);
    delete t.files[A.skillId];
    expect(await t.send("thr", old)).toBe("");
    expect(await t.service.readState("thr")).toMatchObject({ draft: B, rev: 2, notice: expect.stringContaining("'alpha' mode") });
  });

  it("hand a new thread's notice to the thread once it exists", async () => {
    const t = core({ files: {} });
    const mention = t.pill(null, A);
    expect(await t.resolve(mention)).toBe("");
    await t.service.admit("thr_new", t.blocksOf(mention));
    expect(await t.service.readState("thr_new")).toMatchObject({ draft: null, notice: expect.stringContaining("'alpha' mode") });
  });
});

describe("delivery target", () => {
  it("resolves a replayed pill against the thread that is actually receiving it", async () => {
    const t = core();
    t.places.set("thr_parent", { projectId: "proj_1", environmentId: "env_parent" });
    t.places.set("thr_fork", { projectId: "proj_1", environmentId: "env_fork" });
    const inherited = t.pill("thr_parent", A);
    await t.send("thr_parent", inherited);
    expect(t.reads.at(-1)?.environmentId).toBe("env_parent");
    await t.send("thr_fork", inherited);
    expect(t.reads.at(-1)?.environmentId).toBe("env_fork");
  });

  it("overrides a first-message binding when the pill is delivered elsewhere", async () => {
    const t = core();
    t.places.set("thr_fork", { projectId: "proj_1", environmentId: "env_fork" });
    const first = t.pill(null, A);
    await t.resolve(first);
    await t.service.admit("thr_new", t.blocksOf(first));
    await t.send("thr_fork", first);
    expect(t.reads.at(-1)?.environmentId).toBe("env_fork");
  });

  it("falls back to the pill's thread once the delivery record is old", async () => {
    const t = core();
    t.places.set("thr_a", { projectId: "proj_1", environmentId: "env_a" });
    t.places.set("thr_b", { projectId: "proj_1", environmentId: "env_b" });
    const mention = t.pill("thr_a", A);
    await t.send("thr_b", mention);
    t.tick(120_000);
    await t.resolve(mention);
    expect(t.reads.at(-1)?.environmentId).toBe("env_a");
  });
});

describe("exit flag", () => {
  it("is set when a thread goes from a mode to None and cleared when a mode is picked again", async () => {
    const t = core();
    await t.service.setDraft("thr", null, 0);
    expect(await t.service.exitFlag.get("thr")).toBe(false);
    await t.service.setDraft("thr", A, 1);
    await t.service.setDraft("thr", null, 2);
    expect(await t.service.exitFlag.get("thr")).toBe(true);
    await t.service.setDraft("thr", B, 3);
    expect(await t.service.exitFlag.get("thr")).toBe(false);
  });
});

describe("skill listing", () => {
  it("leaves out this computer's own user skills for another host, but keeps BB's user skills, which BB ships there", async () => {
    const t = core({
      extraSkills: [
        listingOf({ skillId: "skill_u", label: "mine" }, "/home/u/.agents/skills/mine/SKILL.md", "shared-user"),
        listingOf({ skillId: "skill_p", label: "provider-mine" }, "/home/u/.claude/skills/x/SKILL.md", "provider-user"),
        listingOf({ skillId: "skill_bb", label: "bb-mine" }, "/home/u/.bb/skills/bb-mine/SKILL.md", "bb-user"),
      ],
    });
    const local = await t.service.listModes({ projectId: "p", environmentId: null, providerId: null });
    const remote = await t.service.listModes({ projectId: "p", environmentId: null, providerId: null, excludeUserSkills: true });
    expect(local.map((option) => option.label)).toEqual(expect.arrayContaining(["mine", "provider-mine", "bb-mine"]));
    expect(remote.map((option) => option.label)).not.toContain("mine");
    expect(remote.map((option) => option.label)).not.toContain("provider-mine");
    expect(remote.map((option) => option.label)).toContain("bb-mine");
  });

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
    expect(t.service.titleFixFor(thread, withContext)).toEqual({ threadId: "thr_1", contaminated: "alpha The cart", own: "The cart" });
    expect(t.service.titleFixFor({ ...thread, title: "Named" }, blocks)).toBeNull();
    expect(t.service.titleFixFor({ ...thread, titleFallback: "Hello" }, blocks)).toBeNull();
  });

  it("repairs only the exact contaminated fallback of a still-untitled thread", async () => {
    const titles: Record<string, { title: string | null; titleFallback: string | null }> = {
      thr_1: { title: null, titleFallback: "alpha The cart" },
      thr_2: { title: "Fix cart rounding", titleFallback: "alpha The cart" },
      thr_3: { title: "alpha Centauri project", titleFallback: "alpha The cart" },
      thr_4: { title: null, titleFallback: "alpha The cart, edited" },
    };
    const set: Array<[string, string]> = [];
    const fixer = createTitleFixer({
      getThread: async (threadId) => titles[threadId]!,
      setTitle: async (threadId, title) => void set.push([threadId, title]),
      log: { info: () => undefined, warn: () => undefined },
      delayMs: 60_000,
    });
    for (const threadId of ["thr_1", "thr_2", "thr_3", "thr_4"]) {
      fixer.track({ threadId, contaminated: "alpha The cart", own: "The cart" });
      await fixer.apply(threadId);
    }
    await fixer.apply("thr_1");
    fixer.dispose();
    expect(set).toEqual([["thr_1", "The cart"]]);
  });

});
