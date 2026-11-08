import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { join, win32 } from "node:path";
export const TRUSTED_GIT_PATH =
  process.platform === "darwin"
    ? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    : "/usr/local/bin:/usr/bin:/bin";
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
export function windowsGitCandidates(
  source: NodeJS.ProcessEnv = process.env,
): string[] {
  const installRoots = [
    absoluteWindowsDirectory(envValue(source, "ProgramW6432")),
    absoluteWindowsDirectory(envValue(source, "ProgramFiles")),
    absoluteWindowsDirectory(envValue(source, "ProgramFiles(x86)")),
  ];
  const localAppData = absoluteWindowsDirectory(
    envValue(source, "LOCALAPPDATA"),
  );
  if (localAppData !== null) installRoots.push(win32.join(localAppData, "Programs"));
  const candidates: string[] = [];
  for (const root of installRoots) {
    if (root === null) continue;
    const candidate = win32.join(root, "Git", "cmd", "git.exe");
    if (!candidates.some((seen) => seen.toLowerCase() === candidate.toLowerCase()))
      candidates.push(candidate);
  }
  return candidates;
}
function windowsTrustedPath(
  git: string | null,
  source: NodeJS.ProcessEnv,
): string {
  const systemRoot =
    absoluteWindowsDirectory(envValue(source, "SystemRoot")) ?? "C:\\Windows";
  const dirs = [win32.join(systemRoot, "System32"), systemRoot];
  if (git !== null) dirs.unshift(win32.dirname(git));
  return dirs.join(";");
}
function resolveWindowsGit(source: NodeJS.ProcessEnv): string | null {
  for (const candidate of windowsGitCandidates(source)) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}
export function resolveTrustedGit(
  pathValue: string = TRUSTED_GIT_PATH,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const git = resolveWindowsGit(process.env);
    if (git !== null) return git;
    throw new Error("git executable was not found in the trusted path");
  }
  for (const dir of pathValue.split(":")) {
    if (!dir.startsWith("/")) continue;
    const candidate = join(dir, "git");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("git executable was not found in the trusted path");
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
    ? windowsTrustedPath(resolveWindowsGit(source), source)
    : TRUSTED_GIT_PATH;
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
