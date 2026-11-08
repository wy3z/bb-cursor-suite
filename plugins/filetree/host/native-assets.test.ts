import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
