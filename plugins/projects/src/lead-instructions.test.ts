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
    expect(text).toContain("bb tasks attachment get");
    expect(text).toContain("show them inline in your reply, never just a link or path");
  });

  it("tells the lead when to run a worker in the cloud and what it costs", () => {
    const text = leadInstructions("BCS");
    expect(text).toContain("A cloud worker only when the user asks");
    expect(text).toContain("bb environment providers --json");
    expect(text).toContain("machineProviderId set");
    expect(text).toContain("`--environment-inputs` branch JSON");
    expect(text).toContain("otherwise a local worktree");
    expect(text).toContain("Cloud costs money");
  });

  it("tells the lead that workers are muted and it must escalate", () => {
    const text = leadInstructions("BCS");
    expect(text).toContain("Workers attached to your cards are muted");
    expect(text).toContain("Escalate anything a worker can't resolve");
    expect(text).toContain("moving the card to For Review with its Needs comment");
    expect(text).toContain("don't send your own notification for a card move");
  });

  it("wraps the rules in the project's tag", () => {
    const text = leadInstructions("BCS");
    expect(text.startsWith('<project_lead_instructions project="BCS">')).toBe(true);
    expect(text.endsWith("</project_lead_instructions>")).toBe(true);
  });
});
