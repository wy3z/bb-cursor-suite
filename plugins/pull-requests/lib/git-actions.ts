import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GitActionResult } from "@wy3z/bb-suite/contracts";
import { cachedExecutable, missingToolMessage } from "@wy3z/bb-suite/git";
import { gitDriverListing, GitSession, type CliGitMode, type GitActionPolicy } from "@wy3z/bb-suite/git-safety";

class ActionError extends Error {}

interface Run {
  code: number;
  stdout: string;
  bytes: Buffer;
  stderr: string;
}

interface ExecOptions {
  input?: string | Buffer;
  env?: Record<string, string>;
  timeoutMs?: number;
}

const PROMPTS_OFF = { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_EDITOR: "true" };
const UNSAFE_CONFIG =
  "This checkout's Git config defines filter, diff, merge or hook commands that can't be switched off safely";

export const COMMIT_POLICY: GitActionPolicy = { hooks: true };
export const PUSH_POLICY: GitActionPolicy = { hooks: true };
export const APPLY_POLICY: GitActionPolicy = { hooks: false, lazyFetch: false };
export const CHANGES_POLICY: GitActionPolicy = { hooks: false, lazyFetch: false, optionalLocks: false };

function exec(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, options: ExecOptions = {}): Promise<Run> {
  return new Promise((done) => {
    const child = execFile(
      file,
      [...args],
      { cwd, env, timeout: options.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        const text = stderr.toString("utf8");
        done({ code, stdout: stdout.toString("utf8"), bytes: stdout, stderr: text || (error ? error.message : "") });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

function check(result: Run, failure: string): Run {
  if (result.code !== 0) throw new ActionError(`${failure}: ${firstLine(result.stderr || result.stdout)}`);
  return result;
}

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((part) => part.replace(/^(error|fatal|hint|remote):\s*/i, "").trim())
    .find((part) => part.length > 0);
  return line ?? "unknown error";
}

export interface Repo {
  path: string;
  git: string;
  session: GitSession;
}

export async function openRepo(path: string, source: NodeJS.ProcessEnv = process.env): Promise<Repo> {
  const git = cachedExecutable("git", source);
  if (git === null) throw new ActionError(missingToolMessage("git"));
  const options = { git, scope: "user" as const, source };
  const listing = gitDriverListing(options);
  const result = await exec(git, listing.args, path, { ...listing.env, ...PROMPTS_OFF });
  if (result.code !== 0 && result.code !== 1) throw new ActionError(`Couldn't read the Git config: ${firstLine(result.stderr)}`);
  const session = GitSession.from({ code: result.code, stdout: result.bytes }, options);
  if (session === null) throw new ActionError(UNSAFE_CONFIG);
  return { path, git, session };
}

export function readGit(repo: Repo, args: readonly string[], options: ExecOptions = {}): Promise<Run> {
  const invocation = repo.session.read(args);
  return exec(repo.git, invocation.args, repo.path, { ...invocation.env, ...PROMPTS_OFF, ...options.env }, options);
}

export function actGit(repo: Repo, args: readonly string[], policy: GitActionPolicy, options: ExecOptions = {}): Promise<Run> {
  const invocation = repo.session.action(args, policy);
  return exec(repo.git, invocation.args, repo.path, { ...invocation.env, ...PROMPTS_OFF, ...options.env }, options);
}

export function runGh(repo: Repo, args: readonly string[], mode: CliGitMode, options: ExecOptions = {}): Promise<Run> {
  const gh = cachedExecutable("gh", process.env);
  if (gh === null) return Promise.resolve({ code: 127, stdout: "", bytes: Buffer.alloc(0), stderr: missingToolMessage("gh") });
  return exec(gh, args, repo.path, { ...repo.session.cli(mode), ...PROMPTS_OFF }, options);
}

export async function topLevel(repo: Repo): Promise<string> {
  return check(await readGit(repo, ["rev-parse", "--show-toplevel"]), "Not a git checkout").stdout.trim();
}

export async function currentBranch(repo: Repo): Promise<string | null> {
  const branch = check(await readGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "Couldn't read the branch").stdout.trim();
  return branch === "HEAD" ? null : branch;
}

export async function hasChanges(repo: Repo): Promise<boolean> {
  const status = await actGit(repo, ["status", "--porcelain", "--ignore-submodules=dirty"], CHANGES_POLICY);
  return check(status, "Couldn't read git status").stdout.trim().length > 0;
}

export async function untrackedCount(repo: Repo): Promise<number> {
  const out = check(await readGit(repo, ["ls-files", "--others", "--exclude-standard", "-z"]), "Couldn't list untracked files");
  return out.stdout.split("\0").filter((item) => item !== "").length;
}

export async function hasStaged(repo: Repo): Promise<boolean> {
  return (await readGit(repo, ["diff", "--cached", "--quiet"])).code !== 0;
}

export async function head(repo: Repo): Promise<{ sha: string; subject: string }> {
  const [sha, subject] = check(await readGit(repo, ["log", "-1", "--format=%H%n%s"]), "Couldn't read the commit").stdout.split("\n");
  return { sha: sha ?? "", subject: subject ?? "" };
}

export async function commonDir(repo: Repo): Promise<string> {
  const out = check(await readGit(repo, ["rev-parse", "--git-common-dir"]), "Couldn't read the repository");
  return resolve(repo.path, out.stdout.trim());
}

export async function headSha(repo: Repo): Promise<string> {
  return check(await readGit(repo, ["rev-parse", "HEAD"]), "Couldn't read the checkout's commit").stdout.trim();
}

export async function mergeBase(repo: Repo, other: string): Promise<string> {
  return check(await readGit(repo, ["merge-base", "HEAD", other]), "No common history with this checkout").stdout.trim();
}

export async function openPullRequest(repo: Repo, branch: string): Promise<string | null> {
  const existing = await runGh(repo, ["pr", "view", branch, "--json", "url,state", "-q", "select(.state==\"OPEN\") | .url"], "read");
  const url = existing.stdout.trim();
  return existing.code === 0 && url.startsWith("https://") ? url : null;
}

interface Checkout extends Repo {
  branch: string | null;
  baseBranch: string | null;
}

async function checkout(bb: BbPluginApi, environmentId: string): Promise<Checkout> {
  const environment = await bb.sdk.environments.get({ environmentId });
  const host = await bb.sdk.hosts.get({ hostId: environment.hostId });
  if (host.machineProviderId !== null) {
    throw new ActionError("This only works for environments on the BB server's own machine");
  }
  const path = environment.path ? resolve(environment.path) : null;
  if (!path || !existsSync(path)) throw new ActionError("The environment's checkout isn't on this machine");
  const repo = await openRepo(path);
  if (resolve(await topLevel(repo)) !== path) throw new ActionError("The environment's path isn't the root of its checkout");
  return {
    ...repo,
    branch: await currentBranch(repo),
    baseBranch: environment.mergeBaseBranch ?? environment.baseBranch ?? environment.defaultBranch ?? null,
  };
}

async function guard(action: () => Promise<GitActionResult>): Promise<GitActionResult> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof ActionError ? error.message : error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

async function push(target: Checkout): Promise<string> {
  if (target.branch === null) throw new ActionError("Detached HEAD: check out a branch before pushing");
  const pushed = await actGit(target, ["push", "-u", "origin", `HEAD:refs/heads/${target.branch}`], PUSH_POLICY, {
    timeoutMs: 120_000,
  });
  check(pushed, "Push failed");
  return target.branch;
}

export function commit(bb: BbPluginApi, input: { environmentId: string; message: string; push: boolean; includeUntracked: boolean }) {
  return guard(async () => {
    const target = await checkout(bb, input.environmentId);
    if (!(await hasChanges(target))) throw new ActionError("Nothing to commit");
    const message = input.message.trim();
    const untracked = await untrackedCount(target);
    let created: { sha: string; subject: string };
    if (message === "") {
      if (untracked > 0 && !input.includeUntracked) {
        throw new ActionError(`Type a commit message: ${untracked} untracked ${untracked === 1 ? "file is" : "files are"} left out, and a generated commit could include them`);
      }
      const result = await bb.sdk.environments.commit({ environmentId: input.environmentId });
      created = { sha: result.commitSha, subject: result.commitSubject };
    } else {
      check(await actGit(target, ["add", input.includeUntracked ? "-A" : "-u"], COMMIT_POLICY), "Couldn't stage the changes");
      if (!(await hasStaged(target))) {
        throw new ActionError(untracked > 0 ? "Only untracked files changed. Tick Include untracked to commit them" : "Nothing to commit");
      }
      check(await actGit(target, ["commit", "-F", "-"], COMMIT_POLICY, { input: `${message}\n` }), "Commit failed");
      created = await head(target);
    }
    const pushed = input.push ? await push(target) : null;
    return { ok: true, sha: created.sha, subject: created.subject, branch: pushed ?? target.branch ?? undefined };
  });
}

export function pushBranch(bb: BbPluginApi, input: { environmentId: string }) {
  return guard(async () => {
    const target = await checkout(bb, input.environmentId);
    const branch = await push(target);
    return { ok: true, branch };
  });
}

export function createPullRequest(bb: BbPluginApi, input: { environmentId: string }) {
  return guard(async () => {
    const target = await checkout(bb, input.environmentId);
    if (target.branch === null) throw new ActionError("Detached HEAD: check out a branch first");
    if (target.baseBranch !== null && target.branch === target.baseBranch) {
      throw new ActionError(`You're on ${target.branch}: a pull request needs its own branch`);
    }
    if (await hasChanges(target)) throw new ActionError("Commit your changes first");
    const existing = await openPullRequest(target, target.branch);
    if (existing !== null) {
      await push(target);
      return { ok: true, url: existing, existed: true, branch: target.branch };
    }
    await push(target);
    const args = ["pr", "create", "--fill", "--head", target.branch];
    if (target.baseBranch !== null) args.push("--base", target.baseBranch);
    const out = check(await runGh(target, args, "action", { timeoutMs: 120_000 }), "Couldn't create the pull request").stdout;
    const url = out.split(/\s+/).find((part) => part.startsWith("https://github.com/"));
    if (!url) throw new ActionError("gh didn't return a pull request URL");
    return { ok: true, url, existed: false, branch: target.branch };
  });
}

export function applyLocally(bb: BbPluginApi, input: { sourceEnvironmentId: string; targetEnvironmentId: string }) {
  return guard(async () => {
    if (input.sourceEnvironmentId === input.targetEnvironmentId) throw new ActionError("Already in this checkout");
    const [source, target] = await Promise.all([
      checkout(bb, input.sourceEnvironmentId),
      checkout(bb, input.targetEnvironmentId),
    ]);
    if ((await commonDir(source)) !== (await commonDir(target))) {
      throw new ActionError("The two checkouts aren't the same repository");
    }
    const base = await mergeBase(source, await headSha(target));

    const scratch = await mkdtemp(join(tmpdir(), "bb-agent-pills-"));
    let patch: Buffer;
    try {
      const env = { GIT_INDEX_FILE: join(scratch, "index") };
      check(await actGit(source, ["read-tree", "HEAD"], APPLY_POLICY, { env }), "Couldn't read the worktree");
      check(await actGit(source, ["add", "-A"], APPLY_POLICY, { env }), "Couldn't collect the worktree's changes");
      const diff = await actGit(source, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", base], APPLY_POLICY, { env });
      patch = check(diff, "Couldn't build the patch").bytes;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    if (patch.toString("utf8").trim() === "") throw new ActionError("Nothing to apply");

    const fits = await actGit(target, ["apply", "--check", "--binary", "-"], APPLY_POLICY, { input: patch });
    if (fits.code !== 0) throw new ActionError(`Doesn't apply cleanly (already applied, or it conflicts): ${firstLine(fits.stderr)}`);
    const stat = check(await readGit(target, ["apply", "--numstat", "-"], { input: patch }), "Couldn't read the patch").stdout;
    check(await actGit(target, ["apply", "--binary", "-"], APPLY_POLICY, { input: patch }), "Apply failed");
    return { ok: true, files: stat.split("\n").filter((line) => line.trim() !== "").length };
  });
}
