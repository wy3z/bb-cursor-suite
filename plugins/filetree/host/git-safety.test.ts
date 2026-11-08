import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  createLinuxProcFdPrimitive,
  type OpenatPrimitive,
} from "./confinement.js";
import { GIT_SAFETY_ENV, resolveTrustedGit } from "./git-env.js";
import { loadNativeFilesAddon, prepareNativeAddon } from "./native-addon.js";
import { NativeFileHostService } from "./service.js";
const execFileAsync = promisify(execFile);
await prepareNativeAddon(await mkdtemp(join(tmpdir(), "files-git-safety-addon-")));
const addon = loadNativeFilesAddon();
const bases: string[] = [];
const MARKER_PREFIX = "pwned-";
function shellPath(path: string): string {
  return path.replace(/\\/gu, "/");
}
async function plainGitEnv(base: string): Promise<NodeJS.ProcessEnv> {
  const home = join(base, "home");
  await mkdir(home, { recursive: true });
  const globalConfig = join(home, "gitconfig");
  await writeFile(globalConfig, "");
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = home;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = globalConfig;
  return env;
}
async function plainGit(base: string, cwd: string, args: string[]) {
  return await execFileAsync(
    resolveTrustedGit(),
    ["-c", "user.name=Files", "-c", "user.email=files@example.com", ...args],
    { cwd, env: await plainGitEnv(base) },
  );
}
async function plainStatus(base: string, root: string): Promise<void> {
  await plainGit(base, root, [
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
  ]).catch(() => undefined);
}
async function markers(base: string): Promise<string[]> {
  return (await readdir(base))
    .filter((name) => name.startsWith(MARKER_PREFIX))
    .sort();
}
function marker(base: string, name: string): string {
  return shellPath(join(base, `${MARKER_PREFIX}${name}`));
}
function writes(base: string, name: string): string {
  return `echo ran > '${marker(base, name)}'`;
}
async function committedRepo(): Promise<{ base: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "files-git-safety-"));
  bases.push(base);
  const root = join(base, "repo");
  await mkdir(root);
  await plainGit(base, root, ["init", "-q"]);
  await writeFile(join(root, "a.txt"), "alpha\n");
  await writeFile(join(root, "b.txt"), "beta\n");
  await plainGit(base, root, ["add", "a.txt", "b.txt"]);
  await plainGit(base, root, ["commit", "-qm", "initial"]);
  return { base, root };
}
async function configure(
  base: string,
  root: string,
  entries: [string, string][],
): Promise<void> {
  for (const [key, value] of entries)
    await plainGit(base, root, ["config", key, value]);
}
async function staleWorktree(root: string): Promise<void> {
  const later = new Date(Date.now() + 3_600_000);
  for (const name of ["a.txt", "b.txt"])
    await utimes(join(root, name), later, later);
}
async function hostileHelpersRepo() {
  const { base, root } = await committedRepo();
  await writeFile(
    join(root, ".gitattributes"),
    "a.txt filter=evil diff=evil merge=evil\n",
  );
  await mkdir(join(root, "hooks-evil"));
  const hook = join(root, "hooks-evil", "post-index-change");
  await writeFile(hook, `#!/bin/sh\n${writes(base, "hook")}\n`);
  await chmod(hook, 0o755);
  await configure(base, root, [
    ["core.fsmonitor", writes(base, "fsmonitor")],
    ["core.hooksPath", "hooks-evil"],
    ["filter.evil.clean", `${writes(base, "clean")}; cat`],
    ["filter.evil.smudge", `${writes(base, "smudge")}; cat`],
    ["filter.evil.required", "true"],
    ["diff.evil.textconv", `${writes(base, "textconv")}; cat`],
    ["diff.evil.command", writes(base, "diff-command")],
    ["diff.external", writes(base, "diff-external")],
    ["merge.evil.driver", writes(base, "merge-driver")],
  ]);
  await staleWorktree(root);
  return { base, root };
}
async function hostileProcessFilterRepo() {
  const { base, root } = await committedRepo();
  await writeFile(join(root, ".gitattributes"), "a.txt filter=evilproc\n");
  await configure(base, root, [
    ["filter.evilproc.process", writes(base, "process")],
  ]);
  await staleWorktree(root);
  return { base, root };
}
async function hostilePartialCloneRepo() {
  const { base, root } = await committedRepo();
  const { stdout } = await plainGit(base, root, ["rev-parse", "HEAD^{tree}"]);
  const tree = stdout.trim();
  const object = join(root, ".git", "objects", tree.slice(0, 2), tree.slice(2));
  await chmod(object, 0o644);
  await rm(object);
  await configure(base, root, [
    ["core.repositoryformatversion", "1"],
    ["extensions.partialClone", "origin"],
    ["remote.origin.promisor", "true"],
    ["remote.origin.url", `ext::sh -c echo% ran% >% ${marker(base, "fetch")}`],
    ["protocol.ext.allow", "always"],
    ["protocol.allow", "always"],
  ]);
  return { base, root };
}
async function unoverridableDriverRepo() {
  const { base, root } = await committedRepo();
  await writeFile(join(root, ".gitattributes"), "a.txt filter=a=b\n");
  await configure(base, root, [
    ["filter.a=b.clean", `${writes(base, "equals-clean")}; cat`],
  ]);
  await staleWorktree(root);
  return { base, root };
}
const services: NativeFileHostService[] = [];
afterAll(async () => {
  await Promise.all(services.splice(0).map((entry) => entry.dispose()));
  await Promise.all(
    bases.map((base) =>
      rm(base, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
});
async function filesStatus(root: string, primitive?: OpenatPrimitive) {
  const host = new NativeFileHostService(
    {},
    primitive ? { primitive } : { nativeAddon: addon },
  );
  services.push(host);
  const binding = await host.bindRoot(root);
  return await host.gitStatus(binding.rootBindingId, `git-safety-${services.length}`);
}
const spawnPaths: [string, () => OpenatPrimitive | undefined][] = [
  ["the native addon", () => undefined],
];
if (process.platform === "linux")
  spawnPaths.push(["the procfs spawn path", () => createLinuxProcFdPrimitive()]);
describe.runIf(addon !== null)("Git status in a hostile repository", () => {
  it("shows that the fixtures run code under plain git status", async () => {
    const helpers = await hostileHelpersRepo();
    const indexBefore = await readFile(join(helpers.root, ".git", "index"));
    await plainStatus(helpers.base, helpers.root);
    expect(await markers(helpers.base)).toEqual(
      expect.arrayContaining([
        `${MARKER_PREFIX}clean`,
        `${MARKER_PREFIX}fsmonitor`,
        `${MARKER_PREFIX}hook`,
      ]),
    );
    expect(await readFile(join(helpers.root, ".git", "index"))).not.toEqual(
      indexBefore,
    );
    const processFilter = await hostileProcessFilterRepo();
    await plainStatus(processFilter.base, processFilter.root);
    expect(await markers(processFilter.base)).toEqual([`${MARKER_PREFIX}process`]);
    const partialClone = await hostilePartialCloneRepo();
    await plainStatus(partialClone.base, partialClone.root);
    expect(await markers(partialClone.base)).toEqual([`${MARKER_PREFIX}fetch`]);
    const equals = await unoverridableDriverRepo();
    await plainStatus(equals.base, equals.root);
    expect(await markers(equals.base)).toEqual([`${MARKER_PREFIX}equals-clean`]);
  });
  describe.each(spawnPaths)("through %s", (_label, primitive) => {
    it("runs no repository helper, filter or hook and leaves the index untouched", async () => {
      const { base, root } = await hostileHelpersRepo();
      const index = join(root, ".git", "index");
      const indexBefore = await readFile(index);
      const result = await filesStatus(root, primitive());
      expect(await markers(base)).toEqual([]);
      expect(await readFile(index)).toEqual(indexBefore);
      await expect(readFile(`${index}.lock`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(result.kind).toBe("ready");
      if (result.kind === "ready")
        expect(result.changes.map((change) => change.path)).toEqual(
          expect.arrayContaining([".gitattributes", "hooks-evil/post-index-change"]),
        );
    });
    it("starts no long-running filter process", async () => {
      const { base, root } = await hostileProcessFilterRepo();
      const result = await filesStatus(root, primitive());
      expect(await markers(base)).toEqual([]);
      expect(result.kind).toBe("ready");
    });
    it("fetches no missing object through a repository transport", async () => {
      const { base, root } = await hostilePartialCloneRepo();
      await filesStatus(root, primitive());
      expect(await markers(base)).toEqual([]);
    });
    it("refuses a driver name it can't override", async () => {
      const { base, root } = await unoverridableDriverRepo();
      const result = await filesStatus(root, primitive());
      expect(await markers(base)).toEqual([]);
      expect(result).toMatchObject({ kind: "unavailable" });
    });
  });
});
describe.runIf(addon !== null && process.platform !== "win32")(
  "native Git environment",
  () => {
    it("pins the Git safety variables whatever the caller passes", async () => {
      if (addon === null) throw new Error("addon missing");
      const base = await mkdtemp(join(tmpdir(), "files-git-safety-env-"));
      bases.push(base);
      const fake = join(base, "fake-git");
      await writeFile(fake, "#!/bin/sh\nenv\n");
      await chmod(fake, 0o755);
      const fd = addon.open(
        base,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
      );
      try {
        const started = addon.gitStatusAt(fd, fake, [], 5000, 65536, [
          "PATH=/usr/bin:/bin",
          "GIT_ALLOW_PROTOCOL=ext:file",
          "GIT_OPTIONAL_LOCKS=1",
          "GIT_NO_LAZY_FETCH=0",
          "GIT_CONFIG_GLOBAL=/tmp/attacker",
        ]);
        const result = await started.promise;
        const lines = result.stdout.toString("utf8").split("\n");
        for (const [key, value] of Object.entries(GIT_SAFETY_ENV))
          expect(lines).toContain(`${key}=${value}`);
        expect(lines.filter((line) => line.startsWith("GIT_")).sort()).toEqual(
          Object.entries(GIT_SAFETY_ENV)
            .map(([key, value]) => `${key}=${value}`)
            .sort(),
        );
      } finally {
        addon.close(fd);
      }
    });
  },
);
