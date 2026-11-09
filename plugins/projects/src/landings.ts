import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitBinary, missingToolMessage } from "@wy3z/bb-suite/git";
import { gitDriverListing, GitSession, type GitInvocation } from "@wy3z/bb-suite/git-safety";
import type { Commit } from "./reconcile";

const FIELD = "\x1f";
const RECORD = "\x1e";
const UNSAFE_CONFIG = "This checkout's Git config defines filter, diff, merge or hook commands that can't be switched off, so its commits aren't read";

type Read = (args: string[]) => Promise<string>;

function exec(git: string, cwd: string, invocation: GitInvocation): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      git,
      invocation.args,
      { cwd, env: invocation.env, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, encoding: "buffer" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

export async function openReader(cwd: string, source: NodeJS.ProcessEnv = process.env): Promise<Read> {
  const git = gitBinary();
  if (git === null) throw new Error(missingToolMessage("git"));
  const options = { git, scope: "isolated" as const, source };
  const session = GitSession.from({ code: 0, stdout: await exec(git, cwd, gitDriverListing(options)) }, options);
  if (session === null) throw new Error(UNSAFE_CONFIG);
  return async (args) => (await exec(git, cwd, session.read(args))).toString("utf8");
}

export function commitUrl(remote: string | null | undefined, sha: string): string | null {
  if (!remote) return null;
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}/commit/${sha}` : null;
}

export async function upstreamRef(git: Read): Promise<string | null> {
  try {
    const head = (await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).trim();
    if (head) return head.replace(/^refs\/remotes\//, "");
  } catch {}
  for (const ref of ["origin/main", "origin/master"]) {
    try {
      await git(["rev-parse", "--verify", "--quiet", ref]);
      return ref;
    } catch {}
  }
  return null;
}

export function parseLog(output: string, ref: string, remote: string | null): Commit[] {
  return output
    .split(RECORD)
    .map((record) => record.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((record) => {
      const [sha = "", at = "", subject = "", body = ""] = record.split(FIELD);
      return { sha: sha.trim(), at: at.trim(), message: `${subject}\n${body}`.trim(), ref: ref.replace(/^origin\//, ""), url: commitUrl(remote, sha.trim()) };
    })
    .filter((commit) => /^[0-9a-f]{7,40}$/.test(commit.sha) && !Number.isNaN(Date.parse(commit.at)));
}

export async function commitsMentioning(cwd: string, prefix: string, sinceIso: string, remote: string | null): Promise<Commit[]> {
  if (!existsSync(join(cwd, ".git"))) return [];
  const git = await openReader(cwd);
  const ref = await upstreamRef(git);
  if (!ref) return [];
  const output = await git([
    "log",
    ref,
    `--since=${sinceIso}`,
    "-i",
    "-E",
    `--grep=${prefix}-[0-9]+`,
    "-n",
    "500",
    `--format=%H${FIELD}%cI${FIELD}%s${FIELD}%b${RECORD}`,
  ]);
  return parseLog(output, ref, remote);
}
