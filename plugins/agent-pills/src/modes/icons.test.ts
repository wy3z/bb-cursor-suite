import { describe, expect, it } from "vitest";
import { DEFAULT_MODE_ICON, modeIconOf } from "./icons";

describe("mode icons", () => {
  it("passes BB icon names through", () => {
    expect(modeIconOf("GitBranch")).toBe("GitBranch");
    expect(modeIconOf(" Eye ")).toBe("Eye");
  });

  it("maps common lowercase names to BB icons", () => {
    expect(modeIconOf("eye")).toBe("Eye");
    expect(modeIconOf("Bug".toLowerCase())).toBe("Bug");
    expect(modeIconOf("map")).toBe("Explore");
    expect(modeIconOf("book")).toBe("FileText");
    expect(modeIconOf("terminal")).toBe("ComputerTerminal01");
  });

  it("falls back to Zap", () => {
    expect(DEFAULT_MODE_ICON).toBe("Zap");
    expect(modeIconOf("not-an-icon")).toBe("Zap");
    expect(modeIconOf(null)).toBe("Zap");
    expect(modeIconOf("")).toBe("Zap");
  });
});
