import { describe, expect, it } from "vitest";
import { leadInstructions } from "./lead-instructions";

describe("leadInstructions", () => {
  it("tells the lead to answer a blocked worker's question instead of queueing a tell", () => {
    const text = leadInstructions("BCS");
    expect(text).toContain("Blocked on user question");
    expect(text).toContain("bb thread interactions answer <interaction> <thread> --choice <questionId>=<value>");
    expect(text).toContain("`bb thread tell` only queues behind it");
  });

  it("asks for proof on the task and queued files instead of a steering tell", () => {
    const text = leadInstructions("BCS");
    expect(text).toContain("bb tasks attachment add <task> --file <path>");
    expect(text).toContain("Send back a visual change reported without proof");
    expect(text).toContain("bb thread tell <lead> --mode queue --image/--file");
    expect(text).toContain("never a plain tell");
  });

  it("wraps the rules in the project's tag", () => {
    const text = leadInstructions("BCS");
    expect(text.startsWith('<project_lead_instructions project="BCS">')).toBe(true);
    expect(text.endsWith("</project_lead_instructions>")).toBe(true);
  });
});
