import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MARKER_PREFIX = "pwned-";

export const HOOK_NAMES = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "post-index-change",
  "pre-push",
  "reference-transaction",
  "post-checkout",
  "post-rewrite",
  "pre-auto-gc",
] as const;

export const READ_MARKERS = [
  "fsmonitor",
  "clean",
  "smudge",
  "textconv",
  "diff-command",
  "diff-external",
  "merge-driver",
  "gpg",
  "config-hook",
  ...HOOK_NAMES.map((name) => `hook-${name}`),
];

export interface HostileRepoOptions {
  worktree?: boolean;
  remote?: boolean;
  partialClone?: boolean;
}

export interface HostileRepo {
  base: string;
  root: string;
  home: string;
  worktree: string | null;
  remote: string | null;
  configHooks: boolean;
  env: NodeJS.ProcessEnv;
  git(args: readonly string[], cwd?: string): Promise<string>;
  marker(name: string): string;
  writes(name: string): string;
  markers(): Promise<string[]>;
  clearMarkers(): Promise<void>;
  stale(...names: string[]): Promise<void>;
  cleanup(): Promise<void>;
}

function plainEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = home;
  env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

async function gitVersion(): Promise<[number, number]> {
  const { stdout } = await execFileAsync("git", ["--version"]);
  const match = /(\d+)\.(\d+)/u.exec(stdout);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

export async function createHostileRepo(options: HostileRepoOptions = {}): Promise<HostileRepo> {
  const base = await mkdtemp(join(tmpdir(), "bb-hostile-git-"));
  const root = join(base, "repo");
  const home = join(base, "home");
  const hooks = join(base, "hooks-evil");
  await mkdir(root);
  await mkdir(home);
  await mkdir(hooks);
  await writeFile(
    join(home, ".gitconfig"),
    "[user]\n\tname = Hostile Test\n\temail = hostile@example.com\n[init]\n\tdefaultBranch = main\n",
  );
  const env = plainEnv(home);
  const git = async (args: readonly string[], cwd: string = root) =>
    (await execFileAsync("git", [...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const marker = (name: string) => join(base, `${MARKER_PREFIX}${name}`);
  const writes = (name: string) => `echo ran > '${marker(name)}'`;
  const [major, minor] = await gitVersion();
  const configHooks = major > 2 || (major === 2 && minor >= 54);

  await git(["init", "-q", "-b", "main"]);
  await writeFile(join(root, "a.txt"), "alpha\n");
  await writeFile(join(root, "b.txt"), "beta\n");
  await writeFile(join(root, ".gitattributes"), "a.txt filter=evil diff=evil merge=evil\n");
  await git(["add", "a.txt", "b.txt", ".gitattributes"]);
  await git(["commit", "-qm", "BCS-1 initial"]);
  const tree = (await git(["rev-parse", "HEAD^{tree}"])).trim();
  const parent = (await git(["rev-parse", "HEAD"])).trim();
  const now = Math.floor(Date.now() / 1000);
  const forged = [
    `tree ${tree}`,
    `parent ${parent}`,
    `author Hostile Test <hostile@example.com> ${now} +0000`,
    `committer Hostile Test <hostile@example.com> ${now} +0000`,
    "gpgsig -----BEGIN PGP SIGNATURE-----",
    " ",
    " forged",
    " -----END PGP SIGNATURE-----",
    "",
    "BCS-2 signed",
    "",
  ].join("\n");
  const signedPath = join(base, "forged-commit");
  await writeFile(signedPath, forged);
  const signed = (await git(["hash-object", "-t", "commit", "-w", signedPath])).trim();
  await rm(signedPath);
  await git(["update-ref", "HEAD", signed]);
  await git(["update-ref", "refs/remotes/origin/main", signed]);
  await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

  let worktree: string | null = null;
  if (options.worktree) {
    worktree = join(base, "linked");
    await git(["worktree", "add", "-q", "-b", "feature", worktree]);
  }
  let remote: string | null = null;
  if (options.remote) {
    remote = join(base, "remote.git");
    await git(["init", "-q", "--bare", remote], base);
    await git(["remote", "add", "origin", remote]);
    await git(["push", "-q", "origin", "main"]);
  }

  const hook = `#!/bin/sh\necho ran > '${join(base, MARKER_PREFIX)}hook-'"$(basename "$0")"\ncat > /dev/null\nexit 0\n`;
  for (const name of HOOK_NAMES) {
    await writeFile(join(hooks, name), hook);
    await chmod(join(hooks, name), 0o755);
  }
  const gpg = join(base, "evil-gpg");
  await writeFile(gpg, `#!/bin/sh\n${writes("gpg")}\nexit 1\n`);
  await chmod(gpg, 0o755);
  const entries: [string, string][] = [
    ["core.fsmonitor", writes("fsmonitor")],
    ["core.hooksPath", hooks],
    ["filter.evil.clean", `${writes("clean")}; cat`],
    ["filter.evil.smudge", `${writes("smudge")}; cat`],
    ["filter.evil.required", "true"],
    ["diff.evil.textconv", `${writes("textconv")}; cat`],
    ["diff.evil.command", writes("diff-command")],
    ["diff.external", writes("diff-external")],
    ["merge.evil.driver", writes("merge-driver")],
    ["log.showSignature", "true"],
    ["gpg.program", gpg],
  ];
  if (configHooks) entries.push(["hook.evil.command", writes("config-hook")]);
  for (const [key, value] of entries) await git(["config", key, value]);
  if (configHooks) {
    await git(["config", "--add", "hook.evil.event", "post-index-change"]);
    await git(["config", "--add", "hook.evil.event", "pre-commit"]);
  }
  if (options.partialClone) {
    const object = join(root, ".git", "objects", signed.slice(0, 2), signed.slice(2));
    await chmod(object, 0o644);
    await rm(object);
    const fetchEntries: [string, string][] = [
      ["core.repositoryformatversion", "1"],
      ["extensions.partialClone", "origin"],
      ["remote.origin.promisor", "true"],
      ["remote.origin.url", `ext::sh -c echo% ran% >% ${marker("fetch")}`],
      ["protocol.ext.allow", "always"],
      ["protocol.allow", "always"],
    ];
    for (const [key, value] of fetchEntries) await git(["config", key, value]);
  }

  const stale = async (...names: string[]) => {
    const later = new Date(Date.now() + 3_600_000);
    for (const name of names.length > 0 ? names : ["a.txt", "b.txt"]) {
      await utimes(join(root, name), later, later);
      if (worktree !== null) await utimes(join(worktree, name), later, later);
    }
  };
  await stale();

  return {
    base,
    root,
    home,
    worktree,
    remote,
    configHooks,
    env,
    git,
    marker,
    writes,
    async markers() {
      return (await readdir(base))
        .filter((name) => name.startsWith(MARKER_PREFIX))
        .map((name) => name.slice(MARKER_PREFIX.length))
        .sort();
    },
    async clearMarkers() {
      for (const name of await readdir(base)) {
        if (name.startsWith(MARKER_PREFIX)) await rm(join(base, name), { force: true });
      }
    },
    stale,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

export async function plainGitRunsCode(repo: HostileRepo): Promise<string[]> {
  await repo.clearMarkers();
  await repo.git(["status", "--porcelain"]).catch(() => "");
  await repo.git(["log", "-1", "--format=%H"]).catch(() => "");
  const seen = await repo.markers();
  await repo.clearMarkers();
  await repo.stale();
  return seen;
}
