import { describe, expect, it } from "bun:test";
import { findGit, gitSearchDirs } from "../src/git-binary.ts";

describe("git lookup", () => {
  it("prefers the server PATH and skips relative entries", () => {
    const dirs = gitSearchDirs({ PATH: "relative/bin:/custom/bin:.", HOME: "/home/u", USER: "u" });
    expect(dirs[0]).toBe("/custom/bin");
    expect(dirs).not.toContain("relative/bin");
    expect(dirs).not.toContain(".");
  });

  it("finds git on NixOS when the server PATH is only the FHS dirs", () => {
    const found = findGit(
      { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/u", USER: "u" },
      "linux",
      (path) => path === "/run/current-system/sw/bin/git",
    );
    expect(found).toBe("/run/current-system/sw/bin/git");
  });

  it("finds a per-user Nix profile and Homebrew on Linux", () => {
    const env = { PATH: "", HOME: "/home/u", USER: "u" };
    expect(findGit(env, "linux", (path) => path === "/etc/profiles/per-user/u/bin/git")).toBe("/etc/profiles/per-user/u/bin/git");
    expect(findGit(env, "linux", (path) => path === "/home/u/.nix-profile/bin/git")).toBe("/home/u/.nix-profile/bin/git");
    expect(findGit(env, "linux", (path) => path === "/home/linuxbrew/.linuxbrew/bin/git")).toBe("/home/linuxbrew/.linuxbrew/bin/git");
  });

  it("uses the PATH git on macOS, then Homebrew when PATH has none", () => {
    const found = findGit(
      { PATH: "/usr/bin:/bin" },
      "darwin",
      (path) => path === "/opt/homebrew/bin/git" || path === "/usr/bin/git",
    );
    expect(found).toBe("/usr/bin/git");
    expect(findGit({ PATH: "" }, "darwin", (path) => path === "/opt/homebrew/bin/git" || path === "/usr/bin/git")).toBe("/opt/homebrew/bin/git");
  });

  it("returns null when git is nowhere, and leaves Windows to PATH", () => {
    expect(findGit({ PATH: "/usr/bin" }, "linux", () => false)).toBeNull();
    expect(findGit({ PATH: "C:\\Git\\cmd" }, "win32", () => true)).toBeNull();
  });
});
