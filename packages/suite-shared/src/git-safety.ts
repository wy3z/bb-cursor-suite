import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  currentIdentity,
  knownGitDirs,
  trustworthyExecutable,
  windowsGitCandidates,
  type GitLookupIdentity,
  type GitLookupProbe,
} from "./git-binary";

export { windowsGitCandidates };

export const TRUSTED_GIT_PATH =
  process.platform === "darwin" ? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" : "/usr/local/bin:/usr/bin:/bin";

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
  const key = Object.keys(source).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : source[key];
}

function absoluteWindowsDirectory(value: string | undefined): string | null {
  if (value === undefined || !/^[A-Za-z]:[\\/]/u.test(value)) return null;
  return win32.normalize(value);
}

function windowsTrustedPath(git: string | null, source: NodeJS.ProcessEnv): string {
  const systemRoot = absoluteWindowsDirectory(envValue(source, "SystemRoot")) ?? "C:\\Windows";
  const dirs = [win32.join(systemRoot, "System32"), systemRoot];
  if (git !== null) dirs.push(win32.dirname(git));
  return dirs.join(";");
}

function resolveWindowsGit(source: NodeJS.ProcessEnv, probe: GitLookupProbe): string | null {
  for (const candidate of windowsGitCandidates(source)) {
    if (probe.stat(candidate)?.isFile()) return candidate;
  }
  return null;
}

export function trustedGitDirs(
  pathValue: string = TRUSTED_GIT_PATH,
  identity: GitLookupIdentity = currentIdentity(),
): string[] {
  const dirs = [...pathValue.split(":").filter((dir) => dir.startsWith("/")), ...knownGitDirs(identity)];
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
    if (trustworthyExecutable(dir, candidate, identity, probe, false)) return candidate;
  }
  throw new Error(`git executable was not found. Checked: ${dirs.join(", ")}`);
}

function posixTrustedPath(gitPath: string | null): string {
  let dir: string;
  try {
    dir = posix.dirname(
      gitPath !== null && posix.isAbsolute(gitPath) ? gitPath : resolveTrustedGit(TRUSTED_GIT_PATH, "linux"),
    );
  } catch {
    return TRUSTED_GIT_PATH;
  }
  return TRUSTED_GIT_PATH.split(":").includes(dir) ? TRUSTED_GIT_PATH : `${TRUSTED_GIT_PATH}:${dir}`;
}

export const GIT_EXEC_SAFETY_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: "none",
};

export const GIT_SAFETY_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  ...GIT_EXEC_SAFETY_ENV,
};

export function gitNowhere(
  git: string | null = null,
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== "win32") return "/dev/null";
  const anchor =
    git ?? win32.join(absoluteWindowsDirectory(envValue(source, "SystemRoot")) ?? "C:\\Windows", "System32", "cmd.exe");
  return win32.join(anchor, "nonexistent");
}

function gitSafetyConfig(git: string | null, platform: NodeJS.Platform): string[] {
  return [
    "core.fsmonitor=",
    "core.useBuiltinFSMonitor=false",
    "core.untrackedCache=false",
    `core.hooksPath=${gitNowhere(git, platform)}`,
    "credential.helper=",
    "diff.external=",
    "submodule.recurse=false",
    "log.showSignature=false",
  ];
}

function configArgs(entries: readonly string[]): string[] {
  return entries.flatMap((entry) => ["-c", entry]);
}

export function gitSafetyArgs(git: string | null = null, platform: NodeJS.Platform = process.platform): string[] {
  return ["--no-optional-locks", "--no-pager", ...configArgs(gitSafetyConfig(git, platform))];
}

export function safeGitArgs(
  args: readonly string[],
  git: string | null = null,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [...gitSafetyArgs(git, platform), ...args];
}

export const GIT_DRIVER_QUERY: readonly string[] = ["config", "--null", "--name-only", "--list"];

export type GitDriverSection = "filter" | "diff" | "merge" | "hook";

const DRIVER_COMMANDS: Readonly<Record<GitDriverSection, readonly string[]>> = {
  filter: ["clean=", "smudge=", "process=", "required=false"],
  diff: ["textconv=", "command="],
  merge: ["driver="],
  hook: ["enabled=false"],
};

const ALL_DRIVER_SECTIONS: readonly GitDriverSection[] = ["filter", "diff", "merge", "hook"];
const DRIVER_LIMIT = 64;
const DRIVER_ARGS_LIMIT = 16384;

export function driverArgs(
  drivers: readonly string[],
  sections: readonly GitDriverSection[] = ALL_DRIVER_SECTIONS,
): string[] {
  const args: string[] = [];
  for (const driver of drivers) {
    const section = driver.slice(0, driver.indexOf(".")) as GitDriverSection;
    if (!sections.includes(section)) continue;
    for (const setting of DRIVER_COMMANDS[section] ?? []) args.push("-c", `${driver}.${setting}`);
  }
  return args;
}

export function parseGitDrivers(output: Uint8Array): string[] | null {
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
  const sorted = [...drivers].sort();
  if (driverArgs(sorted).reduce((total, arg) => total + arg.length + 1, 0) > DRIVER_ARGS_LIMIT) return null;
  return sorted;
}

export function gitDriverOverrides(output: Uint8Array): string[] | null {
  const drivers = parseGitDrivers(output);
  return drivers === null ? null : driverArgs(drivers);
}

export type GitConfigScope = "isolated" | "user";

const PINNED_ENV_NAMES = new Set(["HOME", "XDG_CONFIG_HOME"]);
const USER_CONFIG_VARIABLE = /^GIT_CONFIG_(GLOBAL|SYSTEM|NOSYSTEM)$/u;

export function scrubbedGitEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  gitPath: string | null = null,
  scope: GitConfigScope = "isolated",
): NodeJS.ProcessEnv {
  const windows = platform === "win32";
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const name = windows ? key.toUpperCase() : key;
    if (name === "PATH") continue;
    if (name.startsWith("GIT_") && (scope === "isolated" || !USER_CONFIG_VARIABLE.test(name))) continue;
    if (scope === "isolated" && PINNED_ENV_NAMES.has(name)) continue;
    env[key] = value;
  }
  const git = windows ? (gitPath ?? resolveWindowsGit(source, fsProbe)) : gitPath;
  env.PATH = windows ? windowsTrustedPath(git, source) : posixTrustedPath(git);
  if (scope === "isolated") {
    const nowhere = gitNowhere(git, platform, source);
    env.HOME = nowhere;
    env.XDG_CONFIG_HOME = nowhere;
    Object.assign(env, GIT_SAFETY_ENV);
  } else {
    Object.assign(env, GIT_EXEC_SAFETY_ENV);
  }
  return env;
}

export function scrubbedGitEnvPairs(source: NodeJS.ProcessEnv = process.env, gitPath: string | null = null): string[] {
  return Object.entries(scrubbedGitEnv(source, process.platform, gitPath)).flatMap(([key, value]) =>
    value === undefined ? [] : [`${key}=${value}`],
  );
}

const USER_GIT_VARIABLE = /^GIT_(AUTHOR_|COMMITTER_|SSH($|_)|ASKPASS$|SSL_|HTTP_|PROXY_|CONFIG_(GLOBAL|SYSTEM|NOSYSTEM)$)/u;

function absolutePathEntries(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32")
    return value
      .split(";")
      .filter((dir) => absoluteWindowsDirectory(dir.trim()) !== null)
      .join(";");
  return value
    .split(":")
    .filter((dir) => posix.isAbsolute(dir))
    .join(":");
}

export function gitActionEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const windows = platform === "win32";
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const name = windows ? key.toUpperCase() : key;
    if (name.startsWith("GIT_") && !USER_GIT_VARIABLE.test(name)) continue;
    env[key] = name === "PATH" ? absolutePathEntries(value, platform) : value;
  }
  return env;
}

export interface GitActionPolicy {
  hooks: boolean;
  lazyFetch?: boolean;
  optionalLocks?: boolean;
}

function gitActionPolicyEnv(policy: GitActionPolicy): Record<string, string> {
  return {
    ...(policy.lazyFetch === false ? { GIT_NO_LAZY_FETCH: "1" } : {}),
    ...(policy.optionalLocks === false ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
  };
}

export function gitActionArgs(
  drivers: readonly string[],
  policy: GitActionPolicy,
  git: string | null = null,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [
    ...(policy.optionalLocks === false ? ["--no-optional-locks"] : []),
    "--no-pager",
    ...configArgs([
      "core.fsmonitor=",
      "core.useBuiltinFSMonitor=false",
      "diff.external=",
      "protocol.ext.allow=never",
      "log.showSignature=false",
      ...(policy.hooks ? [] : [`core.hooksPath=${gitNowhere(git, platform)}`]),
    ]),
    ...driverArgs(drivers, policy.hooks ? ["diff", "merge"] : ["diff", "merge", "hook"]),
  ];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''").replace(/!/gu, "'\\!'")}'`;
}

export function gitConfigParameters(args: readonly string[]): string {
  const pairs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "-c" && index + 1 < args.length) pairs.push(args[++index]!);
  }
  return pairs.map(shellQuote).join(" ");
}

export type CliGitMode = "read" | "action";

export interface CliGitOptions {
  git: string | null;
  mode?: CliGitMode;
  drivers?: readonly string[];
  repository: boolean;
  source?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function cliGitEnv({
  git,
  mode = "read",
  drivers = [],
  repository,
  source = process.env,
  platform = process.platform,
}: CliGitOptions): NodeJS.ProcessEnv {
  const read = mode === "read";
  const config = gitSafetyConfig(git, platform);
  const env = read ? scrubbedGitEnv(source, platform, git, "user") : gitActionEnv(source, platform);
  env.GIT_CONFIG_PARAMETERS = gitConfigParameters([
    ...configArgs(read ? config : [...config.filter((entry) => entry !== "credential.helper="), "protocol.ext.allow=never"]),
    ...driverArgs(drivers),
  ]);
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  if (!repository) env.GIT_DIR = gitNowhere(git, platform, source);
  return env;
}

export interface GitInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface GitSessionOptions {
  git: string;
  scope: GitConfigScope;
  source?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function gitDriverListing({
  git,
  scope,
  source = process.env,
  platform = process.platform,
}: GitSessionOptions): GitInvocation {
  return { args: safeGitArgs(GIT_DRIVER_QUERY, git, platform), env: scrubbedGitEnv(source, platform, git, scope) };
}

export class GitSession {
  private constructor(
    readonly drivers: readonly string[],
    private readonly git: string,
    private readonly scope: GitConfigScope,
    private readonly source: NodeJS.ProcessEnv,
    private readonly platform: NodeJS.Platform,
  ) {}

  static from(listing: { code: number | null; stdout: Uint8Array }, options: GitSessionOptions): GitSession | null {
    if (listing.code !== 0 && listing.code !== 1) return null;
    const drivers = parseGitDrivers(listing.stdout);
    if (drivers === null) return null;
    return new GitSession(
      drivers,
      options.git,
      options.scope,
      options.source ?? process.env,
      options.platform ?? process.platform,
    );
  }

  read(args: readonly string[]): GitInvocation {
    return {
      args: safeGitArgs([...driverArgs(this.drivers), ...args], this.git, this.platform),
      env: scrubbedGitEnv(this.source, this.platform, this.git, this.scope),
    };
  }

  action(args: readonly string[], policy: GitActionPolicy): GitInvocation {
    return {
      args: [...gitActionArgs(this.drivers, policy, this.git, this.platform), ...args],
      env: { ...gitActionEnv(this.source, this.platform), ...gitActionPolicyEnv(policy) },
    };
  }

  cli(mode: CliGitMode): NodeJS.ProcessEnv {
    return cliGitEnv({
      git: this.git,
      mode,
      drivers: this.drivers,
      repository: true,
      source: this.source,
      platform: this.platform,
    });
  }
}
