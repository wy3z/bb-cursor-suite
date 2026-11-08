import { describe, expect, it } from "vitest";
import {
  GIT_SAFETY_ARGS,
  gitDriverOverrides,
  resolveTrustedGit,
  safeGitArgs,
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
    expect(env.GIT_CONFIG).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(env.GIT_NO_LAZY_FETCH).toBe("1");
    expect(env.GIT_ALLOW_PROTOCOL).toBe("none");
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
  it("puts the safety options before every Git command", () => {
    expect(safeGitArgs(["rev-parse", "--show-prefix"])).toEqual([
      ...GIT_SAFETY_ARGS,
      "rev-parse",
      "--show-prefix",
    ]);
    expect(GIT_SAFETY_ARGS.slice(0, 2)).toEqual(["--no-optional-locks", "--no-pager"]);
    expect(GIT_SAFETY_ARGS).toContain("core.fsmonitor=");
  });
  it("switches off every filter, diff and merge driver the repository defines", () => {
    const output = [
      "filter.lfs.clean",
      "filter.lfs.process",
      "filter.My Driver.v2.smudge",
      "diff.evil.textconv",
      "diff.external",
      "diff.renames",
      "merge.ours.driver",
      "core.fsmonitor",
      "",
    ].join("\0");
    expect(gitDriverOverrides(output)).toEqual([
      "-c",
      "diff.evil.textconv=",
      "-c",
      "diff.evil.command=",
      "-c",
      "filter.My Driver.v2.clean=",
      "-c",
      "filter.My Driver.v2.smudge=",
      "-c",
      "filter.My Driver.v2.process=",
      "-c",
      "filter.My Driver.v2.required=false",
      "-c",
      "filter.lfs.clean=",
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.required=false",
      "-c",
      "merge.ours.driver=",
    ]);
    expect(gitDriverOverrides("")).toEqual([]);
  });
  it("refuses driver names a -c override can't express", () => {
    expect(gitDriverOverrides("filter.a=b.clean\0")).toBeNull();
    expect(gitDriverOverrides("filter.a\nb.clean\0")).toBeNull();
    const many = Array.from({ length: 65 }, (_, index) => `filter.d${index}.clean`);
    expect(gitDriverOverrides(many.join("\0"))).toBeNull();
    expect(gitDriverOverrides(`filter.${"x".repeat(5000)}.clean\0`)).toBeNull();
  });
});
