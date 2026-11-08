import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Commit } from "./reconcile";

const FIELD = "\x1f";
const RECORD = "\x1e";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function commitUrl(remote: string | null | undefined, sha: string): string | null {
  if (!remote) return null;
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}/commit/${sha}` : null;
}

export async function upstreamRef(cwd: string): Promise<string | null> {
  try {
    const head = (await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).trim();
    if (head) return head.replace(/^refs\/remotes\//, "");
  } catch {}
  for (const ref of ["origin/main", "origin/master"]) {
    try {
      await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
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
  const ref = await upstreamRef(cwd);
  if (!ref) return [];
  const output = await git(cwd, [
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
