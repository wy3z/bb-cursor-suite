import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createHostileRepo,
  HOOK_NAMES,
  plainGitRunsCode,
  READ_MARKERS,
  type HostileRepo,
  type HostileRepoOptions,
} from "@wy3z/bb-suite/testing/hostile-git";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { glabGet, inspectCheckout, runProcess } from "../host";
import { ghProcess } from "./gh-process";
import {
  applyLocally,
  commit,
  commonDir,
  createPullRequest,
  currentBranch,
  hasChanges,
  hasStaged,
  head,
  headSha,
  mergeBase,
  openPullRequest,
  openRepo,
  pushBranch,
  readGit,
  topLevel,
  untrackedCount,
} from "./git-actions";

const execFileAsync = promisify(execFile);
const repos: HostileRepo[] = [];
const originalEnv = { ...process.env };
let fakeBin: string;
let ghLog: string;

const fakeCli = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$FAKE_CLI_LOG"',
  'git rev-parse --show-toplevel >> "$FAKE_CLI_LOG" 2>&1',
  "git status --porcelain > /dev/null 2>&1",
  "git log -1 --format=%H > /dev/null 2>&1",
  "git remote -v > /dev/null 2>&1",
  "git config --get-regexp '^remote\\..*\\.gh-resolved$' > /dev/null 2>&1",
  'case "$1 $2" in',
  '  "pr view") exit 1 ;;',
  '  "pr create") echo "https://github.com/o/r/pull/7" ;;',
  '  "api --hostname") printf "HTTP/2.0 200 OK\\r\\n\\r\\n[]" ;;',
  "esac",
  "",
].join("\n");

beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), "bb-pr-fake-cli-"));
  ghLog = join(fakeBin, "cli.log");
  for (const name of ["gh", "glab"]) {
    writeFileSync(join(fakeBin, name), fakeCli);
    chmodSync(join(fakeBin, name), 0o755);
  }
  process.env.PATH = `${fakeBin}:${originalEnv.PATH ?? ""}`;
  process.env.FAKE_CLI_LOG = ghLog;
});

beforeEach(() => {
  writeFileSync(ghLog, "");
});

afterAll(async () => {
  process.env = originalEnv;
  rmSync(fakeBin, { recursive: true, force: true });
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
});

async function hostile(options: HostileRepoOptions = {}): Promise<HostileRepo> {
  const repo = await createHostileRepo(options);
  repos.push(repo);
  process.env.HOME = repo.home;
  process.env.XDG_CONFIG_HOME = repo.home;
  return repo;
}

function fakeBb(environments: Record<string, { path: string; baseBranch?: string }>): BbPluginApi {
  return {
    sdk: {
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({
          hostId: "local",
          path: environments[environmentId]!.path,
          mergeBaseBranch: null,
          baseBranch: environments[environmentId]!.baseBranch ?? null,
          defaultBranch: null,
        }),
        commit: async () => {
          throw new Error("BB's own commit isn't part of these tests");
        },
      },
      hosts: { get: async () => ({ machineProviderId: null }) },
    },
  } as unknown as BbPluginApi;
}

function without(markers: string[], allowed: readonly string[]): string[] {
  return markers.filter((name) => !allowed.includes(name));
}

describe("read-only git in a hostile checkout", () => {
  it("uses a fixture whose config runs code under plain git", async () => {
    const repo = await hostile();
    expect(await plainGitRunsCode(repo)).toEqual(expect.arrayContaining(["clean", "fsmonitor", "gpg"]));
  });

  it("inspects a checkout without running anything", async () => {
    const repo = await hostile();
    const result = await inspectCheckout(runProcess, repo.root);
    expect(result).toMatchObject({ ok: true, branch: "main" });
    expect(await repo.markers()).toEqual([]);
  });

  it("inspects a partial clone without fetching through its transport", async () => {
    const repo = await hostile({ partialClone: true });
    await inspectCheckout(runProcess, repo.root);
    expect(await repo.markers()).toEqual([]);
  });

  it("runs every read behind the git actions without running anything", async () => {
    const repo = await hostile();
    const opened = await openRepo(repo.root);
    expect(await topLevel(opened)).toBe(repo.root);
    expect(await currentBranch(opened)).toBe("main");
    expect(await untrackedCount(opened)).toBe(0);
    expect(await hasStaged(opened)).toBe(false);
    expect((await head(opened)).subject).toBe("BCS-2 signed");
    expect(await commonDir(opened)).toBe(join(repo.root, ".git"));
    const sha = await headSha(opened);
    expect(await mergeBase(opened, sha)).toBe(sha);
    const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-alpha\n+omega\n";
    expect((await readGit(opened, ["apply", "--numstat", "-"], { input: patch })).stdout).toBe("1\t1\ta.txt\n");
    expect(await repo.markers()).toEqual([]);
  });

  it("checks for uncommitted changes with the filters on and nothing else", async () => {
    const repo = await hostile();
    const index = join(repo.root, ".git", "index");
    const before = await readFile(index);
    expect(await hasChanges(await openRepo(repo.root))).toBe(false);
    expect(await repo.markers()).toEqual(["clean"]);
    expect(await readFile(index)).toEqual(before);
  });

  it("sees no changes in a stat-dirty file whose filter changes its bytes", async () => {
    const repo = await hostile();
    await repo.git(["config", "--unset", "core.hooksPath"]);
    await repo.git(["config", "--unset", "core.fsmonitor"]);
    await writeFile(join(repo.home, ".gitconfig"), "[filter \"pointer\"]\n\tclean = sed s/^/pointer:/\n\tsmudge = sed s/^pointer://\n\trequired = true\n", { flag: "a" });
    await repo.git(["config", "filter.crypt.clean", "tr a-z n-za-m"]);
    await repo.git(["config", "filter.crypt.smudge", "tr a-z n-za-m"]);
    await repo.git(["config", "filter.crypt.required", "true"]);
    await writeFile(join(repo.root, ".gitattributes"), "secret.txt filter=crypt\nlarge.bin filter=pointer\n");
    await writeFile(join(repo.root, "secret.txt"), "hidden\n");
    await writeFile(join(repo.root, "large.bin"), "payload\n");
    await repo.git(["add", ".gitattributes", "secret.txt", "large.bin"]);
    await repo.git(["commit", "-qm", "BCS-6 filtered"]);
    expect(await repo.git(["cat-file", "-p", "HEAD:secret.txt"])).toBe("uvqqra\n");
    expect(await repo.git(["cat-file", "-p", "HEAD:large.bin"])).toBe("pointer:payload\n");
    await repo.stale("secret.txt", "large.bin");
    expect(await repo.git(["--no-optional-locks", "status", "--porcelain"])).toBe("");
    await repo.stale("secret.txt", "large.bin");
    expect(await hasChanges(await openRepo(repo.root))).toBe(false);
  });

  it("gives gh's own git calls no way to run repository code when it looks up a pull request", async () => {
    const repo = await hostile();
    expect(await openPullRequest(await openRepo(repo.root), "main")).toBeNull();
    expect(readFileSync(ghLog, "utf8")).toContain("pr view main --json url,state");
    expect(await repo.markers()).toEqual([]);
  });

  it("runs server-side gh from a neutral folder whose git can't open any repository", async () => {
    const repo = await hostile();
    const gh = ghProcess();
    expect(gh).not.toBeNull();
    expect(gh!.cwd).toBe(tmpdir());
    await execFileAsync(gh!.file, ["pr", "view", "https://github.com/o/r/pull/1"], { cwd: repo.root, env: gh!.env }).catch(() => undefined);
    expect(readFileSync(ghLog, "utf8")).toMatch(/not a git repository/u);
    expect(await repo.markers()).toEqual([]);
  });

  it("runs glab with a git that can't open the checkout it starts in", async () => {
    const repo = await hostile();
    expect(await glabGet(runProcess, "gitlab.com", "projects/1/merge_requests", repo.root)).toMatchObject({ ok: true, status: 200 });
    expect(readFileSync(ghLog, "utf8")).toMatch(/not a git repository/u);
    expect(await repo.markers()).toEqual([]);
  });
});

describe("git actions the user asks for", () => {
  it("commits with the user's identity and the hooks and filters git runs on commit, and nothing else", async () => {
    const repo = await hostile();
    await writeFile(join(repo.root, "a.txt"), "alpha\nmore\n");
    const result = await commit(fakeBb({ e: { path: repo.root } }), {
      environmentId: "e",
      message: "BCS-3 change",
      push: false,
      includeUntracked: false,
    });
    expect(result).toMatchObject({ ok: true, subject: "BCS-3 change" });
    expect((await repo.git(["log", "-1", "--format=%an <%ae>"])).trim()).toBe("Hostile Test <hostile@example.com>");
    const seen = await repo.markers();
    expect(seen).toEqual(
      expect.arrayContaining([
        "clean",
        "hook-pre-commit",
        "hook-prepare-commit-msg",
        "hook-commit-msg",
        "hook-post-commit",
        ...(repo.configHooks ? ["config-hook"] : []),
      ]),
    );
    expect(without(seen, ["clean", "config-hook", ...HOOK_NAMES.map((name) => `hook-${name}`)])).toEqual([]);
  });

  it("signs commits the way the user's config says, even with a repository's own gpg.program", async () => {
    const repo = await hostile();
    const signer = join(repo.base, "signer");
    await writeFile(
      signer,
      [
        "#!/bin/sh",
        repo.writes("gpg-sign"),
        "cat > /dev/null",
        "printf '\\n[GNUPG:] SIG_CREATED D 1 8 00 1700000000 0000\\n' >&2",
        "printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'",
        "",
      ].join("\n"),
    );
    chmodSync(signer, 0o755);
    await repo.git(["config", "gpg.program", signer]);
    await repo.git(["config", "commit.gpgSign", "true"]);
    await writeFile(join(repo.root, "b.txt"), "beta\nmore\n");
    const result = await commit(fakeBb({ e: { path: repo.root } }), { environmentId: "e", message: "BCS-4 signed", push: false, includeUntracked: false });
    expect(result).toMatchObject({ ok: true });
    expect(await repo.git(["cat-file", "commit", "HEAD"])).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
    expect(await repo.markers()).toContain("gpg-sign");
  });

  it("pushes with the push hooks and the remote's own settings, and nothing else", async () => {
    const repo = await hostile({ remote: true });
    await repo.git(["commit", "--allow-empty", "-qm", "BCS-5 push"]);
    await repo.clearMarkers();
    await repo.git(["config", "remote.origin.receivepack", `${repo.writes("receivepack")}; git-receive-pack`]);
    const result = await pushBranch(fakeBb({ e: { path: repo.root } }), { environmentId: "e" });
    expect(result).toEqual({ ok: true, branch: "main" });
    const seen = await repo.markers();
    expect(seen).toEqual(expect.arrayContaining(["hook-pre-push", "receivepack"]));
    expect(without(seen, ["receivepack", ...HOOK_NAMES.map((name) => `hook-${name}`)])).toEqual([]);
    expect(seen).not.toContain("hook-pre-commit");
  });

  it("refuses an ext:: remote even when the repository allows it", async () => {
    const repo = await hostile();
    await repo.git(["remote", "add", "origin", `ext::sh -c echo% ran% >% ${repo.marker("ext")}`]);
    await repo.git(["config", "protocol.ext.allow", "always"]);
    const result = await pushBranch(fakeBb({ e: { path: repo.root } }), { environmentId: "e" });
    expect(result).toMatchObject({ ok: false });
    expect(await repo.markers()).toEqual([]);
  });

  it("creates a pull request with push hooks only, and gh's git runs no repository code", async () => {
    const repo = await hostile({ remote: true, worktree: true });
    const result = await createPullRequest(fakeBb({ e: { path: repo.worktree!, baseBranch: "main" } }), { environmentId: "e" });
    expect(result).toEqual({ ok: true, url: "https://github.com/o/r/pull/7", existed: false, branch: "feature" });
    expect(readFileSync(ghLog, "utf8")).toContain("pr create --fill --head feature --base main");
    const seen = await repo.markers();
    expect(seen).toContain("hook-pre-push");
    expect(without(seen, ["clean", "hook-pre-push", "hook-reference-transaction"])).toEqual([]);
  });

  it("applies another checkout's changes with filters but no hooks, drivers or fsmonitor", async () => {
    const repo = await hostile({ worktree: true });
    await writeFile(join(repo.worktree!, "a.txt"), "alpha\napplied\n");
    const result = await applyLocally(fakeBb({ source: { path: repo.worktree! }, target: { path: repo.root } }), {
      sourceEnvironmentId: "source",
      targetEnvironmentId: "target",
    });
    expect(result).toEqual({ ok: true, files: 1 });
    expect(readFileSync(join(repo.root, "a.txt"), "utf8")).toBe("alpha\napplied\n");
    const seen = await repo.markers();
    expect(seen).toEqual(expect.arrayContaining(["clean", "smudge"]));
    expect(without(seen, ["clean", "smudge"])).toEqual([]);
    expect(READ_MARKERS.filter((name) => seen.includes(name))).toEqual(["clean", "smudge"]);
  });

  it("won't lazily fetch a missing base object while building the patch to apply", async () => {
    const repo = await hostile({ remote: true, worktree: true });
    const blob = (await repo.git(["rev-parse", "HEAD:a.txt"])).trim();
    const object = join(repo.root, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    chmodSync(object, 0o644);
    rmSync(object);
    for (const [key, value] of [
      ["core.repositoryformatversion", "1"],
      ["extensions.partialClone", "origin"],
      ["remote.origin.promisor", "true"],
      ["remote.origin.uploadpack", `${repo.writes("uploadpack")}; git-upload-pack`],
    ]) {
      await repo.git(["config", key!, value!]);
    }
    await writeFile(join(repo.worktree!, "a.txt"), "alpha\napplied\n");
    const result = await applyLocally(fakeBb({ source: { path: repo.worktree! }, target: { path: repo.root } }), {
      sourceEnvironmentId: "source",
      targetEnvironmentId: "target",
    });
    expect(result).toMatchObject({ ok: false });
    expect(await repo.markers()).not.toContain("uploadpack");
    await repo.git(["cat-file", "-e", blob]);
    expect(await repo.markers()).toContain("uploadpack");
  });
});
