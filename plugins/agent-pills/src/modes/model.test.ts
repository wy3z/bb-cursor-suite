import { describe, expect, it } from "vitest";
import {
  cycleMode,
  decodeModeMention,
  encodeModeMention,
  enterText,
  exitText,
  fixedTitle,
  ownWords,
  maintainText,
  missingSkillNotice,
  modeColorOf,
  modeContext,
  modeItemId,
  pillLabel,
  splitSkill,
  transitionOf,
  type ModeRef,
} from "./model";

const reviewer: ModeRef = { skillId: "skill_reviewer", label: "reviewer" };
const planner: ModeRef = { skillId: "skill_planner", label: "planner" };
const path = "/repo/.agents/skills/reviewer/SKILL.md";
const skill = { path, body: "Hard rules: never edit files." };

describe("transitionOf", () => {
  it("is none with no mode before or after", () => {
    expect(transitionOf({ committed: null, draft: null })).toEqual({ kind: "none" });
  });

  it("enters when a mode is chosen on a thread without one", () => {
    expect(transitionOf({ committed: null, draft: reviewer })).toEqual({ kind: "enter", mode: reviewer });
  });

  it("maintains while the same mode stays chosen", () => {
    expect(transitionOf({ committed: reviewer, draft: { ...reviewer } })).toEqual({ kind: "maintain", mode: reviewer });
  });

  it("exits when the mode is cleared", () => {
    expect(transitionOf({ committed: reviewer, draft: null })).toEqual({ kind: "exit", exited: reviewer });
  });

  it("switches when another mode is chosen", () => {
    expect(transitionOf({ committed: reviewer, draft: planner })).toEqual({ kind: "switch", exited: reviewer, mode: planner });
  });

  it("walks enter, maintain, exit, then nothing", () => {
    let committed: ModeRef | null = null;
    const kinds: string[] = [];
    for (const draft of [reviewer, reviewer, null, null]) {
      kinds.push(transitionOf({ committed, draft }).kind);
      committed = draft;
    }
    expect(kinds).toEqual(["enter", "maintain", "exit", "none"]);
  });
});

describe("instruction text", () => {
  it("matches Cursor's enter text", () => {
    expect(enterText("reviewer", path)).toBe(
      'The user has entered reviewer custom mode. Follow the skill instructions in "/repo/.agents/skills/reviewer/SKILL.md" until the user exits or switches modes. Do not drift back to default agent behavior.',
    );
  });

  it("matches Cursor's maintain text", () => {
    expect(maintainText("reviewer", path)).toBe(
      "Reminder: you are still in reviewer mode. Follow that mode's skill on this turn. Do not drop it because the request looks small or you already have context. Do not drift back to default agent behavior. If you cannot state the mode's hard rules, read \"/repo/.agents/skills/reviewer/SKILL.md\" before acting.",
    );
  });

  it("matches Cursor's exit text", () => {
    expect(exitText("reviewer")).toBe(
      "The user has exited reviewer custom mode. Stop following that mode's skill. Continue without those constraints.",
    );
  });

  it("falls back to the attached skill when the path is not a SKILL.md", () => {
    expect(enterText("reviewer", "/tmp/notes.md")).toContain("Follow the attached skill until");
    expect(maintainText("reviewer", null)).toContain("read the skill before acting.");
  });

  it("attaches the skill body on enter and maintain", () => {
    const enter = modeContext({ kind: "enter", mode: reviewer }, skill);
    expect(enter.startsWith(enterText("reviewer", path))).toBe(true);
    expect(enter).toContain(`<skill name="reviewer" path="${path}">\nHard rules: never edit files.\n</skill>`);
    const maintain = modeContext({ kind: "maintain", mode: reviewer }, skill);
    expect(maintain.startsWith(maintainText("reviewer", path))).toBe(true);
    expect(maintain).toContain("Hard rules: never edit files.");
  });

  it("sends the exit note alone", () => {
    expect(modeContext({ kind: "exit", exited: reviewer }, null)).toBe(exitText("reviewer"));
  });

  it("puts the exit note before the enter text on a switch", () => {
    const text = modeContext({ kind: "switch", exited: planner, mode: reviewer }, skill);
    expect(text.startsWith(`${exitText("planner")}\n\n${enterText("reviewer", path)}\n\n<skill`)).toBe(true);
  });

  it("sends nothing for a fresh mode whose skill is gone", () => {
    expect(modeContext({ kind: "enter", mode: reviewer }, null)).toBe("");
    expect(modeContext({ kind: "none" }, skill)).toBe("");
  });

  it("drops a mode whose skill vanished mid-thread, like Cursor", () => {
    expect(modeContext({ kind: "maintain", mode: reviewer }, null)).toBe(exitText("reviewer"));
    expect(modeContext({ kind: "switch", exited: planner, mode: reviewer }, null)).toBe(exitText("planner"));
  });

  it("names the mode in the missing-skill notice", () => {
    expect(missingSkillNotice("reviewer")).toBe(
      "'reviewer' mode couldn't be applied — its skill file may have been renamed or removed. Message sent without it.",
    );
  });
});

describe("mode mentions", () => {
  it("round-trips a destination, the mode being left, the thread and a nonce", () => {
    const mentions = [
      { dest: reviewer, leaving: null, threadId: "thr_1", projectId: "proj_1", environmentId: null, nonce: "n1" },
      { dest: null, leaving: reviewer, threadId: null, projectId: "proj_1", environmentId: "env_1", nonce: "n2" },
      { dest: { skillId: "skill_ü", label: "Révision" }, leaving: planner, threadId: "thr_1", projectId: "p", environmentId: null, nonce: "n3" },
    ];
    for (const mention of mentions) {
      expect(decodeModeMention(encodeModeMention(mention))).toEqual(mention);
      expect(decodeModeMention(modeItemId("purple", mention))).toEqual(mention);
    }
  });

  it("rejects ids it did not write, including the first wire version", () => {
    expect(decodeModeMention("not-a-mode")).toBeNull();
    expect(decodeModeMention(btoa(JSON.stringify({ v: 1, k: "enter", p: "proj_1", m: ["a", "b"] })))).toBeNull();
    expect(decodeModeMention(btoa(JSON.stringify({ v: 2, d: null, x: null, t: null, p: "p", e: null, n: "" })))).toBeNull();
  });

  it("labels pills from the transition the composer expects", () => {
    expect(pillLabel({ kind: "exit", exited: reviewer })).toBe("Exit reviewer");
    expect(pillLabel({ kind: "switch", exited: planner, mode: reviewer })).toBe("reviewer");
    expect(pillLabel({ kind: "none" })).toBeNull();
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

  it("replaces a fallback or title that leads with the label, and leaves real titles alone", () => {
    expect(fixedTitle({ title: null, titleFallback: "reviewer Check" }, "reviewer", "Check")).toBe("Check");
    expect(fixedTitle({ title: null, titleFallback: "Check" }, "reviewer", "Check")).toBeNull();
    expect(fixedTitle({ title: "reviewer Check it", titleFallback: null }, "reviewer", "Check")).toBe("Check it");
    expect(fixedTitle({ title: "Review the README", titleFallback: "reviewer Check" }, "reviewer", "Check")).toBeNull();
  });
});
