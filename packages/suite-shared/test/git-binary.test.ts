import { describe, expect, it } from "bun:test";
import { findGit, knownGitDirs, windowsGitCandidates, type GitLookupIdentity, type GitLookupProbe } from "../src/git-binary.ts";

const me: GitLookupIdentity = { username: "u", home: "/home/u", uid: 1000 };

type Entry = { kind: "dir" | "file"; mode: number; uid: number };

function probe(entries: Record<string, Partial<Entry> & { kind: Entry["kind"] }>): GitLookupProbe {
  return {
    stat(path) {
      const entry = entries[path];
      if (!entry) return null;
      const mode = entry.mode ?? 0o755;
      const uid = entry.uid ?? 0;
      return { isFile: () => entry.kind === "file", isDirectory: () => entry.kind === "dir", mode, uid };
    },
  };
}

function gitAt(dir: string, dirEntry: Partial<Entry> = {}, fileEntry: Partial<Entry> = {}) {
  return { [dir]: { kind: "dir" as const, ...dirEntry }, [`${dir}/git`]: { kind: "file" as const, ...fileEntry } };
}

describe("git lookup", () => {
  it("prefers a PATH git owned by root or the current user", () => {
    const fs = probe({ ...gitAt("/custom/bin", { uid: 1000 }, { uid: 1000 }), ...gitAt("/usr/bin") });
    expect(findGit({ PATH: "/custom/bin:/usr/bin" }, "linux", me, fs)).toBe("/custom/bin/git");
  });

  it("skips relative, empty, group-writable, world-writable and foreign-owned PATH entries", () => {
    const fs = probe({
      ...gitAt("relative"),
      ...gitAt("/tmp", { mode: 0o1777 }),
      ...gitAt("/shared/bin", { mode: 0o775 }),
      ...gitAt("/other/bin", { uid: 1001 }),
      ...gitAt("/loose/bin", {}, { mode: 0o777 }),
      ...gitAt("/usr/bin"),
    });
    expect(findGit({ PATH: "relative::.:/tmp:/shared/bin:/other/bin:/loose/bin" }, "linux", me, fs)).toBe("/usr/bin/git");
  });

  it("finds git on NixOS, Nix profiles, Guix and Linuxbrew when PATH has none", () => {
    for (const dir of [
      "/run/current-system/sw/bin",
      "/nix/var/nix/profiles/default/bin",
      "/etc/profiles/per-user/u/bin",
      "/run/current-system/profile/bin",
      "/home/linuxbrew/.linuxbrew/bin",
      "/home/u/.nix-profile/bin",
      "/home/u/.guix-profile/bin",
    ]) {
      expect(findGit({ PATH: "/usr/bin:/bin" }, "linux", me, probe(gitAt(dir)))).toBe(`${dir}/git`);
    }
  });

  it("accepts Homebrew's group-writable prefix from the known list but not from PATH", () => {
    const fs = probe(gitAt("/opt/homebrew/bin", { mode: 0o775, uid: 501 }));
    expect(findGit({ PATH: "/opt/homebrew/bin" }, "darwin", { ...me, uid: 501 }, fs)).toBe("/opt/homebrew/bin/git");
    expect(findGit({ PATH: "" }, "darwin", me, probe(gitAt("/opt/homebrew/bin", { mode: 0o777 })))).toBeNull();
  });

  it("returns null instead of a bare git when nothing qualifies", () => {
    expect(findGit({ PATH: "/usr/bin" }, "linux", me, probe({}))).toBeNull();
  });

  it("builds per-user dirs only from a safe username and an absolute home", () => {
    expect(knownGitDirs({ username: null, home: null, uid: 1000 }).some((dir) => dir.includes("per-user"))).toBe(false);
    expect(knownGitDirs(me)).toContain("/etc/profiles/per-user/u/bin");
  });

  it("on Windows tries Git for Windows install dirs, then absolute PATH entries, never the working directory", () => {
    const env = { ProgramFiles: "C:\\Program Files", PATH: "relative;C:\\Tools;." };
    expect(findGit(env, "win32", me, probe({ "C:\\Program Files\\Git\\cmd\\git.exe": { kind: "file" } }))).toBe(
      "C:\\Program Files\\Git\\cmd\\git.exe",
    );
    expect(findGit(env, "win32", me, probe({ "C:\\Tools\\git.exe": { kind: "file" } }))).toBe("C:\\Tools\\git.exe");
    expect(findGit(env, "win32", me, probe({ "relative\\git.exe": { kind: "file" }, "git.exe": { kind: "file" } }))).toBeNull();
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
});
