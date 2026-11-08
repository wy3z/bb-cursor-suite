import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  attestedCommits,
  matchingAttestation,
  nativeTreeAt,
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
  it("accepts a build only when its source commit has HEAD's host/native tree", () => {
    const trees: Record<string, string> = {
      [commitA]: "1".repeat(40),
      [commitB]: "2".repeat(40),
    };
    const treeAt = (commit: string) => trees[commit] ?? null;
    const results = [attestation(commitA), attestation(commitB), attestation(commitC)];
    expect(matchingAttestation(results, "2".repeat(40), treeAt)).toEqual({
      commit: commitB,
      commits: [commitA, commitB, commitC],
    });
    expect(matchingAttestation(results, "3".repeat(40), treeAt)).toEqual({
      commit: null,
      commits: [commitA, commitB, commitC],
    });
    expect(matchingAttestation([], "1".repeat(40), treeAt)).toEqual({
      commit: null,
      commits: [],
    });
  });
  it("resolves a local commit's host/native tree without the network", () => {
    const cwd = join(dirname(script), "..");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["rev-parse", "HEAD:./host/native"], {
      cwd,
      encoding: "utf8",
    }).trim();
    expect(nativeTreeAt(head)).toBe(tree);
  });
});
