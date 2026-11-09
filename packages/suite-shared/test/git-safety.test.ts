import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "bun:test";
import type { GitLookupProbe } from "../src/git-binary.ts";
import {
  cliGitEnv,
  driverArgs,
  gitActionArgs,
  gitActionEnv,
  gitConfigParameters,
  gitDriverListing,
  GitSession,
  parseGitDrivers,
  gitDriverOverrides,
  gitNowhere,
  gitSafetyArgs,
  resolveTrustedGit,
  safeGitArgs,
  scrubbedGitEnv,
  TRUSTED_GIT_PATH,
  trustedGitDirs,
  windowsGitCandidates,
} from "../src/git-safety.ts";
import { createHostileRepo, plainGitRunsCode, type HostileRepo } from "./hostile-git.ts";
const execFileAsync = promisify(execFile);
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
    expect(gitSafetyArgs(git, "linux")).toContain("log.showSignature=false");
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
const listing = (entries: string[]) => Buffer.from(entries.map((entry) => `${entry}\0`).join(""));
describe("driver sections", () => {
  it("lists each driver once and builds overrides per section", () => {
    const drivers = parseGitDrivers(
      listing(["filter.lfs.clean", "filter.lfs.process", "diff.evil.textconv", "merge.ours.driver", "hook.lint.command"]),
    );
    expect(drivers).toEqual(["diff.evil", "filter.lfs", "hook.lint", "merge.ours"]);
    expect(driverArgs(drivers ?? [], ["diff", "merge"])).toEqual([
      "-c",
      "diff.evil.textconv=",
      "-c",
      "diff.evil.command=",
      "-c",
      "merge.ours.driver=",
    ]);
    expect(driverArgs(drivers ?? [], ["hook"])).toEqual(["-c", "hook.lint.enabled=false"]);
  });
});
describe("user action arguments", () => {
  const drivers = ["diff.evil", "filter.lfs", "hook.lint", "merge.ours"];
  it("keeps hooks and filters for actions whose hooks the user expects", () => {
    const args = gitActionArgs(drivers, { hooks: true }, "/usr/bin/git", "linux");
    expect(args[0]).toBe("--no-pager");
    expect(args).toContain("core.fsmonitor=");
    expect(args).toContain("diff.external=");
    expect(args).toContain("protocol.ext.allow=never");
    expect(args).toContain("log.showSignature=false");
    expect(args).toContain("diff.evil.textconv=");
    expect(args).toContain("merge.ours.driver=");
    expect(args.some((arg) => arg.startsWith("core.hooksPath="))).toBe(false);
    expect(args.some((arg) => arg.startsWith("filter.") || arg.startsWith("hook."))).toBe(false);
    expect(args).not.toContain("credential.helper=");
  });
  it("switches hooks off, but not filters, for actions that run no hook", () => {
    const args = gitActionArgs(drivers, { hooks: false }, "/usr/bin/git", "linux");
    expect(args).toContain("core.hooksPath=/dev/null");
    expect(args).toContain("hook.lint.enabled=false");
    expect(args.some((arg) => arg.startsWith("filter."))).toBe(false);
  });
  it("keeps the user's environment and credentials but drops repository overrides and relative PATH entries", () => {
    const env = gitActionEnv(
      {
        HOME: "/home/u",
        PATH: "/usr/bin:.:node_modules/.bin::/home/u/.local/bin",
        SSH_AUTH_SOCK: "/run/agent",
        GIT_DIR: "/elsewhere/.git",
        GIT_WORK_TREE: "/elsewhere",
        GIT_INDEX_FILE: "/elsewhere/index",
        GIT_CONFIG_PARAMETERS: "'core.hooksPath=/evil'",
        GIT_CONFIG_COUNT: "1",
        GIT_EXEC_PATH: "/evil",
        GIT_EXTERNAL_DIFF: "/evil",
        GIT_SSH_COMMAND: "ssh -i /home/u/.ssh/work",
        GIT_ASKPASS: "/usr/bin/ksshaskpass",
        GIT_AUTHOR_NAME: "U",
        GIT_COMMITTER_EMAIL: "u@example.com",
        GIT_SSL_CAINFO: "/etc/ca.pem",
      },
      "linux",
    );
    expect(env).toEqual({
      HOME: "/home/u",
      PATH: "/usr/bin:/home/u/.local/bin",
      SSH_AUTH_SOCK: "/run/agent",
      GIT_SSH_COMMAND: "ssh -i /home/u/.ssh/work",
      GIT_ASKPASS: "/usr/bin/ksshaskpass",
      GIT_AUTHOR_NAME: "U",
      GIT_COMMITTER_EMAIL: "u@example.com",
      GIT_SSL_CAINFO: "/etc/ca.pem",
    });
    expect(gitActionEnv({ Path: "C:\\Git\\cmd;.\\bin;D:\\tools", Git_Dir: "D:\\x" }, "win32")).toEqual({
      Path: "C:\\Git\\cmd;D:\\tools",
    });
  });
});
describe("read-only environment with the user's config", () => {
  it("keeps home and global config but still blocks transports and lazy fetches", () => {
    const env = scrubbedGitEnv(
      { HOME: "/home/u", XDG_CONFIG_HOME: "/home/u/.config", PATH: "/tmp/evil:/usr/bin", GIT_DIR: "/x" },
      "linux",
      "/opt/git/bin/git",
      "user",
    );
    expect(env.HOME).toBe("/home/u");
    expect(env.XDG_CONFIG_HOME).toBe("/home/u/.config");
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(env.GIT_CONFIG_NOSYSTEM).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_ALLOW_PROTOCOL).toBe("none");
    expect(env.GIT_NO_LAZY_FETCH).toBe("1");
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(env.PATH).toBe(`${TRUSTED_GIT_PATH}:/opt/git/bin`);
  });
});
describe("git config through the environment", () => {
  it("quotes values the way git's own parser expects", async () => {
    const parameters = gitConfigParameters(["--no-pager", "-c", "core.hooksPath=/tmp/it's here!", "-c", "diff.external="]);
    expect(parameters).toBe(`'core.hooksPath=/tmp/it'\\''s here'\\!'' 'diff.external='`);
    const { stdout } = await execFileAsync("git", ["config", "--get", "core.hooksPath"], {
      env: { ...process.env, GIT_CONFIG_PARAMETERS: parameters, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(stdout).toBe("/tmp/it's here!\n");
  });
  it("gives a CLI with no repository a git that can't open one", () => {
    const env = cliGitEnv({ git: "/usr/bin/git", repository: false, source: { HOME: "/home/u", PATH: "/usr/bin" }, platform: "linux" });
    expect(env.GIT_DIR).toBe("/dev/null");
    expect(env.HOME).toBe("/home/u");
    expect(env.GIT_CONFIG_PARAMETERS).toContain("'core.hooksPath=/dev/null'");
    expect(env.GIT_CONFIG_PARAMETERS).toContain("'credential.helper='");
    expect(env.GIT_ALLOW_PROTOCOL).toBe("none");
  });
  it("lets a CLI action fetch with the user's credentials, and nothing else", () => {
    const env = cliGitEnv({
      git: "/usr/bin/git",
      mode: "action",
      drivers: ["filter.lfs"],
      repository: true,
      source: { HOME: "/home/u", PATH: "/usr/bin:.", GIT_DIR: "/x" },
      platform: "linux",
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GIT_ALLOW_PROTOCOL).toBeUndefined();
    expect(env.GIT_NO_LAZY_FETCH).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).not.toContain("credential.helper");
    expect(env.GIT_CONFIG_PARAMETERS).toContain("'protocol.ext.allow=never'");
    expect(env.GIT_CONFIG_PARAMETERS).toContain("'filter.lfs.clean='");
    expect(env.GIT_CONFIG_PARAMETERS).toContain("'core.hooksPath=/dev/null'");
  });
  it("refuses a session whose config can't be neutralised", () => {
    const options = { git: "/usr/bin/git", scope: "isolated" as const };
    expect(GitSession.from({ code: 0, stdout: listing(["filter.a=b.clean"]) }, options)).toBeNull();
    expect(GitSession.from({ code: 128, stdout: Buffer.alloc(0) }, options)).toBeNull();
    expect(GitSession.from({ code: 0, stdout: listing(["diff.evil.textconv"]) }, options)?.drivers).toEqual(["diff.evil"]);
  });
});
const repos: HostileRepo[] = [];
afterAll(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
});
async function hostile(options: Parameters<typeof createHostileRepo>[0] = {}) {
  const repo = await createHostileRepo(options);
  repos.push(repo);
  return repo;
}
async function session(repo: HostileRepo, scope: "isolated" | "user") {
  const git = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
  const options = { git, scope, source: { ...process.env, HOME: repo.home, XDG_CONFIG_HOME: repo.home } };
  const list = gitDriverListing(options);
  const result = await execFileAsync(git, list.args, { cwd: repo.root, env: list.env, encoding: "buffer" });
  const opened = GitSession.from({ code: 0, stdout: result.stdout }, options);
  if (opened === null) throw new Error("session refused");
  return {
    git,
    opened,
    run: (args: string[]) => {
      const invocation = opened.read(args);
      return execFileAsync(git, invocation.args, { cwd: repo.root, env: invocation.env }).catch((error: { stdout?: string }) => ({
        stdout: error.stdout ?? "",
      }));
    },
  };
}
describe("a hostile repository", () => {
  it("runs code under plain git status and log", async () => {
    const repo = await hostile();
    expect(await plainGitRunsCode(repo)).toEqual(expect.arrayContaining(["clean", "fsmonitor", "gpg"]));
  });
  for (const scope of ["isolated", "user"] as const) {
    it(`runs nothing through a read-only session with ${scope} config`, async () => {
      const repo = await hostile();
      const { run } = await session(repo, scope);
      await run(["status", "--porcelain", "--ignore-submodules=dirty"]);
      await run(["log", "-1", "--format=%H%n%s"]);
      await run(["ls-files", "--others", "--exclude-standard", "-z"]);
      await run(["diff", "HEAD"]);
      await run(["diff", "--cached", "--quiet"]);
      expect(await repo.markers()).toEqual([]);
    });
  }
  it("lets a CLI outside any repository open nothing, even from inside the hostile one", async () => {
    const repo = await hostile();
    const env = cliGitEnv({ git: null, repository: false, source: { ...process.env, HOME: repo.home } });
    const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: repo.root, env }).catch((error: { stderr: string }) => error);
    expect("stderr" in status ? status.stderr : "").toMatch(/not a git repository/u);
    await execFileAsync("git", ["log", "-1"], { cwd: repo.root, env }).catch(() => undefined);
    expect(await repo.markers()).toEqual([]);
  });
  it("neutralises the git a CLI runs in the checkout through the environment alone", async () => {
    const repo = await hostile();
    const { opened } = await session(repo, "user");
    for (const mode of ["read", "action"] as const) {
      const env = opened.cli(mode);
      await execFileAsync("git", ["status", "--porcelain"], { cwd: repo.root, env });
      await execFileAsync("git", ["log", "-1", "--format=%H"], { cwd: repo.root, env });
      await execFileAsync("git", ["remote", "-v"], { cwd: repo.root, env });
      expect(await repo.markers()).toEqual([]);
    }
  });
  it("fetches no missing object through a repository transport", async () => {
    const repo = await hostile({ partialClone: true });
    await repo.git(["log", "--format=%H", "HEAD~1"]).catch(() => "");
    expect(await repo.markers()).toEqual(["fetch"]);
    await repo.clearMarkers();
    const { run } = await session(repo, "isolated");
    await run(["log", "--format=%H", "HEAD~1"]);
    await run(["rev-parse", "-q", "--verify", "HEAD~1"]);
    expect(await repo.markers()).toEqual([]);
  });
});
