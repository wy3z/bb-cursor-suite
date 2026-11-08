import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export function gitSearchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME;
  const user = env.USER ?? env.LOGNAME;
  const dirs = [
    ...(env.PATH ?? "").split(delimiter),
    "/run/current-system/sw/bin",
    user ? `/etc/profiles/per-user/${user}/bin` : "",
    home ? join(home, ".nix-profile/bin") : "",
    "/nix/var/nix/profiles/default/bin",
    "/opt/homebrew/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    home ? join(home, ".linuxbrew/bin") : "",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  return [...new Set(dirs.filter((dir) => dir !== "" && isAbsolute(dir)))];
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findGit(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isExecutable: (path: string) => boolean = executable,
): string | null {
  if (platform === "win32") return null;
  for (const dir of gitSearchDirs(env)) {
    const candidate = join(dir, "git");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

let cached: string | null = null;

export function gitBinary(): string {
  cached ??= findGit();
  return cached ?? "git";
}
