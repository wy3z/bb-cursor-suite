import { describe, expect, it } from "vitest";
import { leadInstructions } from "./lead-instructions";

describe("leadInstructions", () => {
  it("tells the lead to answer a blocked worker's question instead of queueing a tell", () => {
    const text = leadInstructions("BCS");
    expect(text).toContain("Blocked on user question");
    expect(text).toContain("bb thread interactions answer <interaction> <thread> --choice <questionId>=<value>");
    expect(text).toContain("`bb thread tell` only queues behind it");
  });

  it("wraps the rules in the project's tag", () => {
    const text = leadInstructions("BCS");
    expect(text.startsWith('<project_lead_instructions project="BCS">')).toBe(true);
    expect(text.endsWith("</project_lead_instructions>")).toBe(true);
  });
});
