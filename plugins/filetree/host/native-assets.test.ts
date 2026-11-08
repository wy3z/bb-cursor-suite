import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  attestedCommits,
  buildInputs,
  buildInputsAt,
  matchingAttestation,
} from "../scripts/native-assets.mjs";
const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "native-assets.mjs",
);
describe("embedded native addons", () => {
  it("carries a build of the current C source for every supported platform", () => {
    let output = "";
    let failure = "";
    try {
      output = execFileSync(process.execPath, [script, "--check"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      failure = String((error as { stderr?: unknown }).stderr ?? error).trim();
    }
    expect(failure).toBe("");
    expect(output).toContain("OK");
  });
});
const attestation = (sourceRepositoryDigest: unknown) => ({
  verificationResult: { signature: { certificate: { sourceRepositoryDigest } } },
});
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const commitC = "c".repeat(64);
describe("native addon provenance", () => {
  it("reads each distinct source commit from the verified attestations", () => {
    expect(
      attestedCommits([
        attestation(commitA),
        attestation(commitB),
        attestation(commitA),
        attestation(commitC),
        attestation("refs/heads/main"),
        attestation(`${commitA}\n`),
        attestation(42),
        {},
      ]),
    ).toEqual([commitA, commitB, commitC]);
    expect(attestedCommits({})).toEqual([]);
  });
  it("accepts a build only when every build input matches HEAD", () => {
    const inputs = ["workflow", "script", "native", "lock"];
    const head = ["1", "2", "3", "4"].map((digit) => digit.repeat(40));
    const trees: Record<string, string[]> = {
      [commitA]: [head[0], "9".repeat(40), head[2], head[3]] as string[],
      [commitB]: head,
    };
    const inputsAt = (commit: string) => trees[commit] ?? null;
    const results = [attestation(commitA), attestation(commitB), attestation(commitC)];
    expect(matchingAttestation(results, inputs, head, inputsAt)).toEqual({
      commit: commitB,
      commits: [commitA, commitB, commitC],
      mismatches: [{ commit: commitA, differing: ["script"] }],
    });
    expect(
      matchingAttestation([attestation(commitA), attestation(commitC)], inputs, head, inputsAt),
    ).toEqual({
      commit: null,
      commits: [commitA, commitC],
      mismatches: [
        { commit: commitA, differing: ["script"] },
        { commit: commitC, differing: inputs },
      ],
    });
    expect(matchingAttestation([], inputs, head, inputsAt)).toEqual({
      commit: null,
      commits: [],
      mismatches: [],
    });
  });
  it("names the workflow, script, native source and lockfile as build inputs", () => {
    expect(buildInputs()).toEqual([
      ".github/workflows/files-native.yml",
      "plugins/filetree/scripts/native-assets.mjs",
      "plugins/filetree/host/native",
      "package-lock.json",
    ]);
  });
  it("resolves a local commit's build inputs without the network", () => {
    const cwd = join(dirname(script), "..");
    const rev = (value: string) =>
      execFileSync("git", ["rev-parse", value], { cwd, encoding: "utf8" }).trim();
    const head = rev("HEAD");
    expect(buildInputsAt(head)).toEqual(buildInputs().map((input) => rev(`HEAD:${input}`)));
  });
});
