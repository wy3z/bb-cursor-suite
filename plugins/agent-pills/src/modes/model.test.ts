import { describe, expect, it } from "vitest";
import {
  cycleMode,
  decodeModeMention,
  encodeModeMention,
  fixedTitle,
  missingSkillNotice,
  modeColorOf,
  modeContext,
  modeItemId,
  modeText,
  ownWords,
  sameMode,
  splitSkill,
  type ModeRef,
} from "./model";

const reviewer: ModeRef = { skillId: "skill_reviewer", label: "reviewer" };
const planner: ModeRef = { skillId: "skill_planner", label: "planner" };
const path = "/repo/.agents/skills/reviewer/SKILL.md";
const skill = { path, body: "Hard rules: never edit files." };

describe("mode text", () => {
  it("is Cursor's maintain reminder, worded so it works on the first message too", () => {
    expect(modeText("reviewer", path)).toBe(
      "You are in reviewer mode. Follow that mode's skill on this turn. Do not drop it because the request looks small or you already have context. Do not drift back to default agent behavior. If you cannot state the mode's hard rules, read \"/repo/.agents/skills/reviewer/SKILL.md\" before acting.",
    );
  });

  it("falls back to 'the skill' when the path is not a SKILL.md", () => {
    expect(modeText("reviewer", "/tmp/notes.md")).toContain("read the skill before acting.");
    expect(modeText("reviewer", null)).toContain("read the skill before acting.");
  });

  it("attaches the skill body after the line", () => {
    expect(modeContext(reviewer, skill)).toBe(
      `${modeText("reviewer", path)}\n\n<skill name="reviewer" path="${path}">\nHard rules: never edit files.\n</skill>`,
    );
  });

  it("attaches nothing when the skill is gone", () => {
    expect(modeContext(reviewer, null)).toBe("");
  });

  it("names the mode in the missing-skill notice", () => {
    expect(missingSkillNotice("reviewer")).toBe(
      "'reviewer' mode couldn't be applied — its skill file may have been renamed or removed. Message sent without it.",
    );
  });
});

describe("mode mentions", () => {
  it("round-trips the mode, thread, workspace hints and nonce", () => {
    const mentions = [
      { mode: reviewer, threadId: "thr_1", projectId: "proj_1", environmentId: null, nonce: "n1" },
      { mode: { skillId: "skill_ü", label: "Révision" }, threadId: null, projectId: "p", environmentId: "env_1", nonce: "n2" },
    ];
    for (const mention of mentions) {
      expect(decodeModeMention(encodeModeMention(mention))).toEqual(mention);
      expect(decodeModeMention(modeItemId("purple", mention))).toEqual(mention);
    }
  });

  it("rejects ids it did not write, including earlier wire versions", () => {
    expect(decodeModeMention("not-a-mode")).toBeNull();
    expect(decodeModeMention(btoa(JSON.stringify({ v: 2, d: ["a", "b"], x: null, t: null, p: "p", e: null, n: "n" })))).toBeNull();
    expect(decodeModeMention(btoa(JSON.stringify({ v: 3, m: null, t: null, p: "p", e: null, n: "n" })))).toBeNull();
  });

  it("treats the same skill name as the same mode", () => {
    expect(sameMode(reviewer, { skillId: "other_id", label: "reviewer" })).toBe(true);
    expect(sameMode(reviewer, planner)).toBe(false);
    expect(sameMode(null, null)).toBe(true);
  });
});

describe("cycleMode", () => {
  it("goes None, then each skill, then back to None", () => {
    const options = [planner, reviewer];
    expect(cycleMode(options, null)).toEqual(planner);
    expect(cycleMode(options, planner)).toEqual(reviewer);
    expect(cycleMode(options, reviewer)).toBeNull();
    expect(cycleMode(options, null, -1)).toEqual(reviewer);
  });
});

describe("splitSkill", () => {
  it("reads icon and color from frontmatter and trims the body", () => {
    const parsed = splitSkill('---\nname: reviewer\ndescription: "Careful reviews"\nicon: eye\ncolor: purple\n---\n\n# Reviewer\n\nRules.\n');
    expect(parsed.frontmatter).toEqual({ name: "reviewer", description: "Careful reviews", icon: "eye", color: "purple", mode: false });
    expect(parsed.body).toBe("# Reviewer\n\nRules.");
  });

  it("keeps a file without frontmatter whole", () => {
    expect(splitSkill("Just rules.").body).toBe("Just rules.");
  });

  it("falls back to the default color", () => {
    expect(modeColorOf("Purple")).toBe("purple");
    expect(modeColorOf("teal")).toBe("default");
    expect(modeColorOf(null)).toBe("default");
  });
});

describe("mode flag", () => {
  it("reads mode: true from frontmatter", () => {
    expect(splitSkill("---\nmode: true\n---\nx").frontmatter.mode).toBe(true);
    expect(splitSkill("---\nmode: yes\n---\nx").frontmatter.mode).toBe(true);
    expect(splitSkill("---\nmode: false\n---\nx").frontmatter.mode).toBe(false);
    expect(splitSkill("x").frontmatter.mode).toBe(false);
  });
});

describe("titles", () => {
  it("keeps only the user's words after the pill label", () => {
    expect(ownWords("reviewer  Check the\nREADME", "reviewer")).toBe("Check the README");
    expect(ownWords("Check the README", "reviewer")).toBeNull();
    expect(ownWords("reviewer ", "reviewer")).toBeNull();
    expect(ownWords(`reviewer ${"word ".repeat(40)}`, "reviewer")?.length).toBe(80);
  });

  it("repairs only an untitled thread whose fallback is exactly the contaminated one", () => {
    expect(fixedTitle({ title: null, titleFallback: "reviewer Check" }, "reviewer Check", "Check")).toBe("Check");
    expect(fixedTitle({ title: null, titleFallback: "reviewer Check again" }, "reviewer Check", "Check")).toBeNull();
    expect(fixedTitle({ title: "reviewer Check", titleFallback: "reviewer Check" }, "reviewer Check", "Check")).toBeNull();
    expect(fixedTitle({ title: "reviewer Centauri", titleFallback: "reviewer Check" }, "reviewer Check", "Check")).toBeNull();
  });

});
