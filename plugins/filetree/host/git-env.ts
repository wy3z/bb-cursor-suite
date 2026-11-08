import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  currentIdentity,
  knownGitDirs,
  trustworthyExecutable,
  windowsGitCandidates,
  type GitLookupIdentity,
  type GitLookupProbe,
} from "@wy3z/bb-suite/git";
export { windowsGitCandidates };
export const TRUSTED_GIT_PATH =
  process.platform === "darwin"
    ? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    : "/usr/local/bin:/usr/bin:/bin";
const fsProbe: GitLookupProbe = {
  stat(path) {
    try {
      return statSync(path);
    } catch {
      return null;
    }
  },
};
function envValue(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(source).find(
    (candidate) => candidate.toUpperCase() === name.toUpperCase(),
  );
  return key === undefined ? undefined : source[key];
}
function absoluteWindowsDirectory(value: string | undefined): string | null {
  if (value === undefined || !/^[A-Za-z]:[\\/]/u.test(value)) return null;
  return win32.normalize(value);
}
function windowsTrustedPath(
  git: string | null,
  source: NodeJS.ProcessEnv,
): string {
  const systemRoot =
    absoluteWindowsDirectory(envValue(source, "SystemRoot")) ?? "C:\\Windows";
  const dirs = [win32.join(systemRoot, "System32"), systemRoot];
  if (git !== null) dirs.push(win32.dirname(git));
  return dirs.join(";");
}
function resolveWindowsGit(
  source: NodeJS.ProcessEnv,
  probe: GitLookupProbe,
): string | null {
  for (const candidate of windowsGitCandidates(source)) {
    if (probe.stat(candidate)?.isFile()) return candidate;
  }
  return null;
}
export function trustedGitDirs(
  pathValue: string = TRUSTED_GIT_PATH,
  identity: GitLookupIdentity = currentIdentity(),
): string[] {
  const dirs = [
    ...pathValue.split(":").filter((dir) => dir.startsWith("/")),
    ...knownGitDirs(identity),
  ];
  return [...new Set(dirs)];
}
export function resolveTrustedGit(
  pathValue: string = TRUSTED_GIT_PATH,
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
  identity: GitLookupIdentity = currentIdentity(),
  probe: GitLookupProbe = fsProbe,
): string {
  if (platform === "win32") {
    const git = resolveWindowsGit(source, probe);
    if (git !== null) return git;
    throw new Error(
      `git executable was not found. Checked: ${windowsGitCandidates(source).join(", ") || "no Git for Windows install folders"}`,
    );
  }
  const dirs = trustedGitDirs(pathValue, identity);
  for (const dir of dirs) {
    const candidate = posix.join(dir, "git");
    if (trustworthyExecutable(dir, candidate, identity, probe, false))
      return candidate;
  }
  throw new Error(`git executable was not found. Checked: ${dirs.join(", ")}`);
}
function posixTrustedPath(): string {
  try {
    const dir = posix.dirname(resolveTrustedGit(TRUSTED_GIT_PATH, "linux"));
    return TRUSTED_GIT_PATH.split(":").includes(dir)
      ? TRUSTED_GIT_PATH
      : `${TRUSTED_GIT_PATH}:${dir}`;
  } catch {
    return TRUSTED_GIT_PATH;
  }
}
export function scrubbedGitEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const windows = platform === "win32";
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const name = windows ? key.toUpperCase() : key;
    if (name.startsWith("GIT_")) continue;
    if (name === "PATH") continue;
    env[key] = value;
  }
  env.PATH = windows
    ? windowsTrustedPath(resolveWindowsGit(source, fsProbe), source)
    : posixTrustedPath();
  env.GIT_CONFIG = "/dev/null";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}
export function scrubbedGitEnvPairs(
  source: NodeJS.ProcessEnv = process.env,
): string[] {
  return Object.entries(scrubbedGitEnv(source)).flatMap(([key, value]) =>
    value === undefined ? [] : [`${key}=${value}`],
  );
}
