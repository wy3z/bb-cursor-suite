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
export const GIT_SAFETY_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: "none",
};
export const GIT_SAFETY_ARGS: readonly string[] = [
  "--no-optional-locks",
  "--no-pager",
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.useBuiltinFSMonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "diff.external=",
  "-c",
  "submodule.recurse=false",
];
export function safeGitArgs(args: readonly string[]): string[] {
  return [...GIT_SAFETY_ARGS, ...args];
}
export const GIT_DRIVER_QUERY: readonly string[] = [
  "config",
  "--null",
  "--name-only",
  "--get-regexp",
  "^(filter|diff|merge)\\.",
];
const DRIVER_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  filter: ["clean=", "smudge=", "process=", "required=false"],
  diff: ["textconv=", "command="],
  merge: ["driver="],
};
const DRIVER_LIMIT = 64;
const DRIVER_ARGS_LIMIT = 16384;
export function gitDriverOverrides(output: string): string[] | null {
  const drivers = new Set<string>();
  for (const name of output.split("\0")) {
    if (name.length === 0) continue;
    const first = name.indexOf(".");
    const last = name.lastIndexOf(".");
    if (first <= 0 || last <= first) continue;
    const section = name.slice(0, first);
    const subsection = name.slice(first + 1, last);
    if (!(section in DRIVER_COMMANDS)) continue;
    if (/[=\n]/u.test(subsection)) return null;
    drivers.add(`${section}.${subsection}`);
  }
  if (drivers.size > DRIVER_LIMIT) return null;
  const args: string[] = [];
  for (const driver of [...drivers].sort()) {
    const section = driver.slice(0, driver.indexOf("."));
    for (const setting of DRIVER_COMMANDS[section] ?? [])
      args.push("-c", `${driver}.${setting}`);
  }
  if (args.reduce((total, arg) => total + arg.length + 1, 0) > DRIVER_ARGS_LIMIT)
    return null;
  return args;
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
  Object.assign(env, GIT_SAFETY_ENV);
  return env;
}
export function scrubbedGitEnvPairs(
  source: NodeJS.ProcessEnv = process.env,
): string[] {
  return Object.entries(scrubbedGitEnv(source)).flatMap(([key, value]) =>
    value === undefined ? [] : [`${key}=${value}`],
  );
}
