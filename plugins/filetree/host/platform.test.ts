import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createFilesHostEntry } from "../host.js";
import { NativeFileHostService } from "./service.js";
import { nativeAssets } from "../generated/native-assets.js";
const execFileAsync = promisify(execFile);
const platform = `${process.platform}-${process.arch}`;
const createHarness = (dataDir: string, tempDir: string) =>
  experimental_createHostEntryHarness(createFilesHostEntry(), {
    experimental_paths: { dataDir, tempDir },
  });
type Harness = ReturnType<typeof createHarness>;
describe.runIf(platform in nativeAssets)(
  `Files host with the embedded ${platform} addon`,
  () => {
    let base = "";
    let workspace = "";
    let plain = "";
    let harness: Harness | undefined;
    const call = (method: string, input: unknown) => {
      if (!harness) throw new Error("Harness is not ready");
      return harness.experimental_call(method as never, input as never);
    };
    beforeAll(async () => {
      base = await mkdtemp(join(tmpdir(), "files-platform-"));
      workspace = join(base, "workspace");
      plain = join(base, "plain");
      await mkdir(join(workspace, "src"), { recursive: true });
      await mkdir(plain);
      await writeFile(join(workspace, "src", "hello.txt"), "hello");
      await writeFile(join(workspace, "README.md"), "readme");
      await writeFile(join(plain, "notes.txt"), "notes");
      await mkdir(join(base, "outside"));
      await writeFile(join(base, "outside", "secret.txt"), "secret");
      await symlink(join(base, "outside"), join(workspace, "escape"), "junction");
      await execFileAsync("git", ["init", "-q"], { cwd: workspace });
      const worker = join(base, "worker");
      await mkdir(worker);
      harness = createHarness(base, worker);
    });
    afterAll(async () => {
      await harness?.experimental_dispose();
      await rm(base, { recursive: true, force: true }).catch(() => undefined);
    });
    it("loads the addon", async () => {
      expect(await call("support", {})).toEqual({ kind: "supported" });
    });
    it("lists a directory and hides a link that leaves the root", async () => {
      const listing = (await call("directory", {
        rootPath: workspace,
        path: "",
      })) as { entries: { name: string; kind: string }[] };
      expect(listing.entries.map((entry) => [entry.name, entry.kind])).toEqual([
        ["src", "directory"],
        ["README.md", "file"],
      ]);
      const nested = (await call("directory", {
        rootPath: workspace,
        path: "src",
      })) as { entries: { name: string }[] };
      expect(nested.entries.map((entry) => entry.name)).toEqual(["hello.txt"]);
    });
    it("interleaves listings of one directory on a single binding", async () => {
      const service = new NativeFileHostService();
      try {
        const { rootBindingId } = await service.bindRoot(workspace);
        const [first, second] = await Promise.all([
          service.listDirectory(rootBindingId, ""),
          service.listDirectory(rootBindingId, ""),
        ]);
        expect(first.entries.map((entry) => entry.name)).toEqual([
          "src",
          "README.md",
        ]);
        expect(second).toEqual(first);
      } finally {
        await service.dispose();
      }
    });
    it("refuses to walk through a link that leaves the root", async () => {
      await expect(
        call("directory", { rootPath: workspace, path: "escape" }),
      ).rejects.toThrow();
    });
    it("searches file names", async () => {
      const result = (await call("search", {
        rootPath: workspace,
        query: "hello",
        limit: 20,
      })) as { matches: { path: string }[] };
      expect(result.matches.map((match) => match.path)).toEqual([
        "src/hello.txt",
      ]);
    });
    it("reads Git status from the bound root", async () => {
      const result = (await call("gitStatus", { rootPath: workspace })) as {
        kind: string;
        changes?: { path: string }[];
        reason?: string;
      };
      expect(result.reason ?? "").toBe("");
      expect(result.kind).toBe("ready");
      expect(result.changes?.map((change) => change.path)).toEqual(
        expect.arrayContaining(["README.md", "src/hello.txt"]),
      );
    });
    it("reports a folder outside any repository", async () => {
      const result = (await call("gitStatus", { rootPath: plain })) as {
        kind: string;
      };
      expect(result.kind).toBe("not-repository");
    });
    it.runIf(process.platform === "win32")(
      "rejects a POSIX root on Windows",
      async () => {
        await expect(
          call("directory", { rootPath: "/tmp", path: "" }),
        ).rejects.toThrow();
      },
    );
  },
);
