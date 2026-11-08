import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nativeAssets } from "../generated/native-assets.js";
import { prepareNativeAddon } from "./native-addon.js";
const platform = `${process.platform}-${process.arch}`;
describe.runIf(platform in nativeAssets)("native addon preparation", () => {
  const created: string[] = [];
  afterAll(async () => {
    await Promise.all(
      created.map((dir) =>
        rm(dir, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  });
  it("retries after a failure to write or load the addon", async () => {
    const base = await mkdtemp(join(tmpdir(), "files-addon-retry-"));
    created.push(base);
    const failed = await prepareNativeAddon(join(base, "missing", "worker"));
    expect(failed).toMatchObject({ kind: "unsupported", platform });
    if (failed.kind === "unsupported")
      expect(failed.reason).toContain("couldn't load its native module");
    expect(await prepareNativeAddon(base)).toEqual({ kind: "supported" });
    expect(await prepareNativeAddon(join(base, "missing", "worker"))).toEqual({
      kind: "supported",
    });
  });
});
