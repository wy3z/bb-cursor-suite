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
export const GIT_SAFETY_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: "none",
};
export function gitNowhere(
  git: string | null = null,
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== "win32") return "/dev/null";
  const anchor =
    git ??
    win32.join(
      absoluteWindowsDirectory(envValue(source, "SystemRoot")) ?? "C:\\Windows",
      "System32",
      "cmd.exe",
    );
  return win32.join(anchor, "nonexistent");
}
export function gitSafetyArgs(
  git: string | null = null,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [
    "--no-optional-locks",
    "--no-pager",
    "-c",
    "core.fsmonitor=",
    "-c",
    "core.useBuiltinFSMonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    `core.hooksPath=${gitNowhere(git, platform)}`,
    "-c",
    "credential.helper=",
    "-c",
    "diff.external=",
    "-c",
    "submodule.recurse=false",
  ];
}
export function safeGitArgs(
  args: readonly string[],
  git: string | null = null,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [...gitSafetyArgs(git, platform), ...args];
}
export const GIT_DRIVER_QUERY: readonly string[] = [
  "config",
  "--null",
  "--name-only",
  "--list",
];
const DRIVER_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  filter: ["clean=", "smudge=", "process=", "required=false"],
  diff: ["textconv=", "command="],
  merge: ["driver="],
  hook: ["enabled=false"],
};
const DRIVER_LIMIT = 64;
const DRIVER_ARGS_LIMIT = 16384;
export function gitDriverOverrides(output: Uint8Array): string[] | null {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const bytes = Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  const drivers = new Set<string>();
  for (let start = 0; start < bytes.length; ) {
    const terminator = bytes.indexOf(0, start);
    const end = terminator < 0 ? bytes.length : terminator;
    const entry = bytes.subarray(start, end);
    start = end + 1;
    const sectionEnd = entry.indexOf(0x2e);
    if (sectionEnd <= 0) continue;
    const section = entry.subarray(0, sectionEnd).toString("latin1");
    if (!Object.hasOwn(DRIVER_COMMANDS, section)) continue;
    let name: string;
    try {
      name = decoder.decode(entry);
    } catch {
      return null;
    }
    const last = name.lastIndexOf(".");
    if (last <= sectionEnd) continue;
    const subsection = name.slice(sectionEnd + 1, last);
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
const PINNED_ENV_NAMES = new Set(["PATH", "HOME", "XDG_CONFIG_HOME"]);
export function scrubbedGitEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  gitPath: string | null = null,
): NodeJS.ProcessEnv {
  const windows = platform === "win32";
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const name = windows ? key.toUpperCase() : key;
    if (name.startsWith("GIT_")) continue;
    if (PINNED_ENV_NAMES.has(name)) continue;
    env[key] = value;
  }
  const git = windows ? (gitPath ?? resolveWindowsGit(source, fsProbe)) : null;
  env.PATH = windows ? windowsTrustedPath(git, source) : posixTrustedPath();
  const nowhere = gitNowhere(git, platform, source);
  env.HOME = nowhere;
  env.XDG_CONFIG_HOME = nowhere;
  Object.assign(env, GIT_SAFETY_ENV);
  return env;
}
export function scrubbedGitEnvPairs(
  source: NodeJS.ProcessEnv = process.env,
  gitPath: string | null = null,
): string[] {
  return Object.entries(scrubbedGitEnv(source, process.platform, gitPath)).flatMap(
    ([key, value]) => (value === undefined ? [] : [`${key}=${value}`]),
  );
}
