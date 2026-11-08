import { describe, expect, it } from "vitest";
import type { GitLookupProbe } from "@wy3z/bb-suite/git";
import {
  resolveTrustedGit,
  scrubbedGitEnv,
  TRUSTED_GIT_PATH,
  trustedGitDirs,
  windowsGitCandidates,
} from "./git-env.js";
function probeWith(dir: string, dirMode = 0o755): GitLookupProbe {
  return {
    stat(path) {
      if (path !== dir && path !== `${dir}/git`) return null;
      const isDir = path === dir;
      return { isFile: () => !isDir, isDirectory: () => isDir, mode: isDir ? dirMode : 0o755, uid: 0 };
    },
  };
}
describe("git spawn environment", () => {
  it("drops inherited GIT_* overrides and pins a trusted PATH", () => {
    const env = scrubbedGitEnv(
      {
        GIT_DIR: "/tmp/outside/.git",
        GIT_WORK_TREE: "/tmp/outside",
        GIT_COMMON_DIR: "/tmp/outside/.git",
        HOME: "/home/test",
        PATH: "/tmp/outside:/usr/bin",
      },
      "linux",
    );
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_COMMON_DIR).toBeUndefined();
    expect(env.GIT_CONFIG).toBe("/dev/null");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.PATH).toBe(TRUSTED_GIT_PATH);
    expect(env.HOME).toBe("/home/test");
    if (process.platform !== "win32")
      expect(resolveTrustedGit().startsWith("/")).toBe(true);
  });
  it("scrubs Windows variables case-insensitively", () => {
    const env = scrubbedGitEnv(
      {
        Git_Dir: "C:\\outside\\.git",
        git_work_tree: "C:\\outside",
        Path: "C:\\outside;C:\\Windows\\System32",
        SystemRoot: "C:\\Windows",
        USERPROFILE: "C:\\Users\\test",
      },
      "win32",
    );
    expect(Object.keys(env).filter((key) => key.toUpperCase() === "PATH")).toEqual([
      "PATH",
    ]);
    expect(env.PATH).not.toContain("outside");
    expect(env.PATH).toContain("C:\\Windows\\System32");
    expect(env.Git_Dir).toBeUndefined();
    expect(env.git_work_tree).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.USERPROFILE).toBe("C:\\Users\\test");
  });
  it("only trusts Git for Windows from install locations", () => {
    expect(
      windowsGitCandidates({
        ProgramFiles: "C:\\Program Files",
        ProgramW6432: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
        PATH: "C:\\outside",
      }),
    ).toEqual([
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      "C:\\Users\\test\\AppData\\Local\\Programs\\Git\\cmd\\git.exe",
    ]);
    expect(windowsGitCandidates({ ProgramFiles: "relative\\dir" })).toEqual([]);
  });
  it("finds git on NixOS, Nix profiles, Guix, Homebrew and Linuxbrew when the system dirs have none", () => {
    const me = { username: "u", home: "/home/u", uid: 1000 };
    for (const dir of [
      "/run/current-system/sw/bin",
      "/nix/var/nix/profiles/default/bin",
      "/etc/profiles/per-user/u/bin",
      "/run/current-system/profile/bin",
      "/home/linuxbrew/.linuxbrew/bin",
      "/home/u/.nix-profile/bin",
      "/home/u/.guix-profile/bin",
      "/home/u/.linuxbrew/bin",
    ]) {
      expect(
        resolveTrustedGit("/usr/local/bin:/usr/bin:/bin", "linux", {}, me, probeWith(dir)),
      ).toBe(`${dir}/git`);
    }
  });
  it("never falls back to the server PATH, and names every place it checked", () => {
    const me = { username: "u", home: "/home/u", uid: 1000 };
    const fromPath = () =>
      resolveTrustedGit("/usr/bin", "linux", { PATH: "/opt/tools/bin" }, me, probeWith("/opt/tools/bin"));
    expect(fromPath).toThrow("git executable was not found. Checked: /usr/bin, /usr/local/bin");
    expect(fromPath).toThrow("/run/current-system/sw/bin");
    expect(fromPath).not.toThrow("/opt/tools/bin");
    expect(trustedGitDirs("/usr/bin", me)).not.toContain("/opt/tools/bin");
  });
  it("skips a world-writable git directory", () => {
    const me = { username: "u", home: "/home/u", uid: 1000 };
    expect(() =>
      resolveTrustedGit("/usr/bin", "linux", {}, me, probeWith("/usr/bin", 0o777)),
    ).toThrow("git executable was not found");
  });
});
