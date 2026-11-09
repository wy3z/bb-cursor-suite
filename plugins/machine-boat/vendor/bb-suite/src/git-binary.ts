import { statSync, type Stats } from "node:fs";
import { homedir, userInfo } from "node:os";
import { posix, win32 } from "node:path";

export interface GitLookupIdentity {
  username: string | null;
  home: string | null;
  uid: number | null;
}

export interface GitLookupProbe {
  stat(path: string): Pick<Stats, "isFile" | "isDirectory" | "mode" | "uid"> | null;
}

const realProbe: GitLookupProbe = {
  stat(path) {
    try {
      return statSync(path);
    } catch {
      return null;
    }
  },
};

export function currentIdentity(): GitLookupIdentity {
  let username: string | null = null;
  let uid: number | null = null;
  try {
    const info = userInfo();
    username = info.username;
    uid = info.uid >= 0 ? info.uid : null;
  } catch {}
  let home: string | null = null;
  try {
    home = homedir();
  } catch {}
  if (username !== null && (username === "" || username === "." || username === ".." || /[/\\]/u.test(username)))
    username = null;
  if (home !== null && !posix.isAbsolute(home)) home = null;
  return { username, home, uid };
}

export function knownGitDirs(identity: GitLookupIdentity = currentIdentity()): string[] {
  const { username, home } = identity;
  return [
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/run/current-system/sw/bin",
    "/nix/var/nix/profiles/default/bin",
    ...(username ? [`/etc/profiles/per-user/${username}/bin`] : []),
    "/run/current-system/profile/bin",
    "/opt/homebrew/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    ...(home
      ? [posix.join(home, ".nix-profile/bin"), posix.join(home, ".guix-profile/bin"), posix.join(home, ".linuxbrew/bin")]
      : []),
  ];
}

function absoluteWindowsDirectory(value: string | undefined): string | null {
  if (value === undefined || !/^[A-Za-z]:[\\/]/u.test(value)) return null;
  return win32.normalize(value);
}

function envValue(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(source).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : source[key];
}

export function windowsGitCandidates(source: NodeJS.ProcessEnv = process.env): string[] {
  const installRoots = [
    absoluteWindowsDirectory(envValue(source, "ProgramW6432")),
    absoluteWindowsDirectory(envValue(source, "ProgramFiles")),
    absoluteWindowsDirectory(envValue(source, "ProgramFiles(x86)")),
  ];
  const localAppData = absoluteWindowsDirectory(envValue(source, "LOCALAPPDATA"));
  if (localAppData !== null) installRoots.push(win32.join(localAppData, "Programs"));
  const candidates: string[] = [];
  for (const root of installRoots) {
    if (root === null) continue;
    const candidate = win32.join(root, "Git", "cmd", "git.exe");
    if (!candidates.some((seen) => seen.toLowerCase() === candidate.toLowerCase())) candidates.push(candidate);
  }
  return candidates;
}

const GROUP_OR_WORLD_WRITABLE = 0o022;
const WORLD_WRITABLE = 0o002;

function safeOwner(uid: number, identity: GitLookupIdentity): boolean {
  return uid === 0 || (identity.uid !== null && uid === identity.uid);
}

export function trustworthyExecutable(
  dir: string,
  candidate: string,
  identity: GitLookupIdentity,
  probe: GitLookupProbe,
  strict: boolean,
): boolean {
  const folder = probe.stat(dir);
  const file = probe.stat(candidate);
  if (!folder?.isDirectory() || !file?.isFile()) return false;
  if ((file.mode & 0o111) === 0) return false;
  const writable = strict ? GROUP_OR_WORLD_WRITABLE : WORLD_WRITABLE;
  if ((folder.mode & writable) !== 0 || (file.mode & writable) !== 0) return false;
  return !strict || (safeOwner(folder.uid, identity) && safeOwner(file.uid, identity));
}

export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  identity: GitLookupIdentity = currentIdentity(),
  probe: GitLookupProbe = realProbe,
): string | null {
  if (!/^[A-Za-z0-9._-]+$/u.test(name) || name === "." || name === "..") return null;
  if (platform === "win32") {
    const exe = name.toLowerCase().endsWith(".exe") ? name : `${name}.exe`;
    const fromPath = (envValue(env, "PATH") ?? "")
      .split(";")
      .map((dir) => absoluteWindowsDirectory(dir.trim()))
      .filter((dir): dir is string => dir !== null)
      .map((dir) => win32.join(dir, exe));
    const installed = name === "git" ? windowsGitCandidates(env) : [];
    for (const candidate of [...installed, ...fromPath]) {
      if (probe.stat(candidate)?.isFile()) return candidate;
    }
    return null;
  }
  const fromPath = (env.PATH ?? "").split(":").filter((dir) => posix.isAbsolute(dir));
  for (const dir of fromPath) {
    const candidate = posix.join(dir, name);
    if (trustworthyExecutable(dir, candidate, identity, probe, true)) return candidate;
  }
  for (const dir of knownGitDirs(identity)) {
    const candidate = posix.join(dir, name);
    if (trustworthyExecutable(dir, candidate, identity, probe, false)) return candidate;
  }
  return null;
}

export function findGit(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  identity: GitLookupIdentity = currentIdentity(),
  probe: GitLookupProbe = realProbe,
): string | null {
  return findExecutable("git", env, platform, identity, probe);
}

const MISSING_RETRY_MS = 30_000;
const lookups = new Map<string, { path: string | null; at: number }>();

export function cachedExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
  find: (name: string, env: NodeJS.ProcessEnv) => string | null = findExecutable,
): string | null {
  const key = `${name}\0${envValue(env, "PATH") ?? ""}`;
  const hit = lookups.get(key);
  if (hit !== undefined && (hit.path !== null || now - hit.at < MISSING_RETRY_MS)) return hit.path;
  const path = find(name, env);
  lookups.set(key, { path, at: now });
  return path;
}

export function gitBinary(now: number = Date.now()): string | null {
  return cachedExecutable("git", process.env, now);
}

export function missingToolMessage(name: string): string {
  return `Couldn't find ${name}. Install it, or put it on the BB server's PATH in a directory only you or root can write to.`;
}
