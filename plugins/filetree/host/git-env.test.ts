import { describe, expect, it } from "vitest";
import {
  fallbackGitDirs,
  resolveTrustedGit,
  scrubbedGitEnv,
  TRUSTED_GIT_PATH,
  windowsGitCandidates,
} from "./git-env.js";
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
  it("finds git on NixOS and Homebrew when the system dirs have none", () => {
    const env = { HOME: "/home/u", USER: "u", PATH: "/usr/bin:/bin" };
    for (const git of [
      "/run/current-system/sw/bin/git",
      "/etc/profiles/per-user/u/bin/git",
      "/home/u/.nix-profile/bin/git",
      "/home/linuxbrew/.linuxbrew/bin/git",
    ]) {
      expect(
        resolveTrustedGit("/usr/local/bin:/usr/bin:/bin", "linux", env, (candidate) => candidate === git),
      ).toBe(git);
    }
  });
  it("falls back to absolute server PATH entries only after the system dirs", () => {
    const env = { PATH: "relative:/opt/tools/bin" };
    expect(fallbackGitDirs(env)).toContain("/opt/tools/bin");
    expect(fallbackGitDirs(env)).not.toContain("relative");
    expect(
      resolveTrustedGit("/usr/bin", "linux", env, (candidate) =>
        candidate === "/opt/tools/bin/git" || candidate === "/usr/bin/git",
      ),
    ).toBe("/usr/bin/git");
    expect(
      resolveTrustedGit("/usr/bin", "linux", env, (candidate) => candidate === "/opt/tools/bin/git"),
    ).toBe("/opt/tools/bin/git");
    expect(() => resolveTrustedGit("/usr/bin", "linux", env, () => false)).toThrow(
      "git executable was not found in the trusted path",
    );
  });
});
