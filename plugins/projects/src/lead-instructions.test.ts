import { describe, expect, it } from "vitest";
import { leadInstructions, workerInstructions } from "./lead-instructions";

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

  it("tells the lead to steer workers with a tell and queue only when their turn should finish", () => {
    const text = leadInstructions("BCS");
    expect(text).toContain("Message workers with `bb thread tell <worker>`, which steers");
    expect(text).toContain("add `--mode queue` only when the worker's current turn should finish first");
  });

  it("tells the lead when to run a worker in the cloud and what it costs, leaving the syntax to the skill", () => {
    const text = leadInstructions("BCS");
    expect(text).toContain("A local worktree by default");
    expect(text).toContain("A cloud worker only when the user asks");
    expect(text).toContain("Cloud costs money");
    expect(text).not.toContain("--environment-inputs");
  });

  it("groups the rules under headings", () => {
    const text = leadInstructions("BCS");
    const headings = text.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(["## Statuses", "## Workers", "## Proof", "## Talking to the user", "## Landing"]);
  });

  it("tells the lead that a spawn or tell succeeding is not a result", () => {
    const text = leadInstructions("BCS");
    expect(text).toContain("A spawn or a tell that succeeded is not a result");
    expect(text).toContain("Check the worker's thread before you tell the user it is still working or has finished");
  });

  it("tells the lead how to talk to the user", () => {
    const text = leadInstructions("BCS");
    expect(text).toContain("Lead with the answer, the result or the blocker");
    expect(text).toContain('with one marked "(Recommended)"');
    expect(text).toContain("Don't act on an assumed answer");
  });

  it("tells the lead that workers are muted and it must escalate", () => {
    const text = leadInstructions("BCS");
    expect(text).toContain("Workers you spawned are muted once attached to your cards");
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

describe("workerInstructions", () => {
  it("tells a worker it is not the lead and who the lead is", () => {
    const text = workerInstructions("BCS", "thr_lead1");
    expect(text).toContain("You work on a card of the BCS board for its lead, thread thr_lead1");
    expect(text).toContain("You are not the lead");
    expect(text).toContain("The lead owns card statuses, the project notes and everything said to the user");
  });

  it("asks for the result last, proof on the task and no chatter", () => {
    const text = workerInstructions("BCS", "thr_lead1");
    expect(text).toContain("End your last turn with the result");
    expect(text).toContain("bb tasks attachment add <task> --file <path>");
    expect(text).toContain("No progress chatter");
    expect(text).toContain("bb thread tell thr_lead1 --mode queue --image/--file");
    expect(text).toContain("Never merge, and never commit to the default branch, unless your brief says so");
  });

  it("wraps the rules in the project's tag", () => {
    const text = workerInstructions("BCS", "thr_lead1");
    expect(text.startsWith('<project_worker_instructions project="BCS">')).toBe(true);
    expect(text.endsWith("</project_worker_instructions>")).toBe(true);
  });
});
