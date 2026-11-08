import { describe, expect, it } from "vitest";
import type { GitLookupProbe } from "@wy3z/bb-suite/git";
import {
  gitDriverOverrides,
  gitNowhere,
  gitSafetyArgs,
  resolveTrustedGit,
  safeGitArgs,
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
        XDG_CONFIG_HOME: "/home/test/.config",
        LANG: "C.UTF-8",
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
    expect(env.HOME).toBe("/dev/null");
    expect(env.XDG_CONFIG_HOME).toBe("/dev/null");
    expect(env.LANG).toBe("C.UTF-8");
    if (process.platform !== "win32")
      expect(resolveTrustedGit().startsWith("/")).toBe(true);
  });
  it("scrubs Windows variables case-insensitively", () => {
    const env = scrubbedGitEnv(
      {
        Git_Dir: "C:\\outside\\.git",
        git_work_tree: "C:\\outside",
        Path: "C:\\outside;C:\\Windows\\System32",
        Home: "D:\\repo-drive",
        xdg_config_home: "D:\\repo-drive\\.config",
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
    expect(env.Home).toBeUndefined();
    expect(env.xdg_config_home).toBeUndefined();
    expect(env.HOME).toBe("C:\\Windows\\System32\\cmd.exe\\nonexistent");
    expect(env.XDG_CONFIG_HOME).toBe(env.HOME);
    const pinned = scrubbedGitEnv(
      { SystemRoot: "C:\\Windows" },
      "win32",
      "C:\\Program Files\\Git\\cmd\\git.exe",
    );
    expect(pinned.HOME).toBe("C:\\Program Files\\Git\\cmd\\git.exe\\nonexistent");
    expect(pinned.PATH?.split(";")).toContain("C:\\Program Files\\Git\\cmd");
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
    const git = "/usr/bin/git";
    expect(safeGitArgs(["rev-parse", "--show-prefix"], git, "linux")).toEqual([
      ...gitSafetyArgs(git, "linux"),
      "rev-parse",
      "--show-prefix",
    ]);
    expect(gitSafetyArgs(git, "linux").slice(0, 2)).toEqual([
      "--no-optional-locks",
      "--no-pager",
    ]);
    expect(gitSafetyArgs(git, "linux")).toContain("core.fsmonitor=");
    expect(gitSafetyArgs(git, "linux")).toContain("core.hooksPath=/dev/null");
  });
  it("points Windows hooks and home under the git.exe file, not a drive-relative path", () => {
    const git = "C:\\Program Files\\Git\\cmd\\git.exe";
    expect(gitNowhere(git, "win32")).toBe(`${git}\\nonexistent`);
    expect(gitSafetyArgs(git, "win32")).toContain(
      `core.hooksPath=${git}\\nonexistent`,
    );
    expect(gitNowhere(null, "win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\cmd.exe\\nonexistent",
    );
    expect(gitNowhere(null, "darwin")).toBe("/dev/null");
  });
  it("switches off every filter, diff, merge and hook the repository defines", () => {
    const output = [
      "filter.lfs.clean",
      "filter.lfs.process",
      "filter.My Driver.v2.smudge",
      "diff.evil.textconv",
      "diff.external",
      "diff.renames",
      "merge.ours.driver",
      "hook.lint.command",
      "hook.lint.event",
      "hook.post-index-change.enabled",
      "core.fsmonitor",
      "",
    ].join("\0");
    expect(gitDriverOverrides(Buffer.from(output))).toEqual([
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
      "hook.lint.enabled=false",
      "-c",
      "hook.post-index-change.enabled=false",
      "-c",
      "merge.ours.driver=",
    ]);
    expect(gitDriverOverrides(Buffer.from("filter.caf\u00e9.clean\0"))).toEqual([
      "-c",
      "filter.caf\u00e9.clean=",
      "-c",
      "filter.caf\u00e9.smudge=",
      "-c",
      "filter.caf\u00e9.process=",
      "-c",
      "filter.caf\u00e9.required=false",
    ]);
    expect(gitDriverOverrides(Buffer.alloc(0))).toEqual([]);
    expect(
      gitDriverOverrides(
        Buffer.concat([
          Buffer.from("branch."),
          Buffer.from([0xff]),
          Buffer.from(".remote\0core.bare\0merge.ours.driver\0"),
        ]),
      ),
    ).toEqual(["-c", "merge.ours.driver="]);
  });
  it("refuses driver names a -c override can't express", () => {
    const refuse = (bytes: Buffer) => expect(gitDriverOverrides(bytes)).toBeNull();
    refuse(Buffer.from("filter.a=b.clean\0"));
    refuse(Buffer.from("filter.a\nb.clean\0"));
    refuse(Buffer.concat([Buffer.from("filter."), Buffer.from([0xff]), Buffer.from(".clean\0")]));
    refuse(Buffer.concat([Buffer.from("filter."), Buffer.from([0xc0, 0xae]), Buffer.from(".clean\0")]));
    refuse(Buffer.concat([Buffer.from("hook."), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from(".command\0")]));
    const many = Array.from({ length: 65 }, (_, index) => `filter.d${index}.clean`);
    refuse(Buffer.from(many.join("\0")));
    refuse(Buffer.from(`filter.${"x".repeat(5000)}.clean\0`));
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
