import { describe, expect, it } from "vitest";
import {
  hostPathFlavor,
  isAbsoluteHostPath,
  isWindowsDriveHostPath,
  joinHostPath,
  normalizeWindowsHostPath,
  relativeHostPath,
} from "./host-path";

describe("host paths", () => {
  it("recognises POSIX, drive and UNC roots and nothing else", () => {
    expect(hostPathFlavor("/home/me/repo")).toBe("posix");
    expect(hostPathFlavor("C:\\Users\\me\\repo")).toBe("windows");
    expect(hostPathFlavor("c:/Users/me/repo")).toBe("windows");
    expect(hostPathFlavor("\\\\server\\share\\repo")).toBe("windows");
    expect(hostPathFlavor("//home/u/p")).toBe("posix");
    for (const value of [
      "repo",
      "C:",
      "C:repo",
      "\\repo",
      "",
      "/tmp\0x",
      "\\\\?\\C:\\repo",
      "\\\\?\\GLOBALROOT\\Device",
      "\\\\.\\pipe\\x",
    ])
      expect(isAbsoluteHostPath(value)).toBe(false);
  });

  it("only treats drive paths as local Windows roots", () => {
    expect(isWindowsDriveHostPath("C:\\Users\\me")).toBe(true);
    expect(isWindowsDriveHostPath("\\\\server\\share\\repo")).toBe(false);
    expect(isWindowsDriveHostPath("/home/me")).toBe(false);
  });

  it("normalises Windows roots the way BB stores them", () => {
    expect(normalizeWindowsHostPath("c:/Users//me/repo/")).toBe(
      "C:\\Users\\me\\repo",
    );
    expect(normalizeWindowsHostPath("C:\\")).toBe("C:\\");
    expect(normalizeWindowsHostPath("C:\\a\\..\\b")).toBeNull();
    expect(normalizeWindowsHostPath("C:\\a\\.\\b")).toBeNull();
    expect(normalizeWindowsHostPath("\\\\server\\share\\repo")).toBeNull();
    expect(normalizeWindowsHostPath("/home/me")).toBeNull();
  });

  it("joins a workspace-relative path with the host's separator", () => {
    expect(joinHostPath("/home/me/repo", "src/app.ts")).toBe(
      "/home/me/repo/src/app.ts",
    );
    expect(joinHostPath("/", "etc")).toBe("/etc");
    expect(joinHostPath("C:\\Users\\me\\repo", "src/app.ts")).toBe(
      "C:\\Users\\me\\repo\\src\\app.ts",
    );
    expect(joinHostPath("C:\\", "repo")).toBe("C:\\repo");
  });

  it("maps an absolute path back under a root", () => {
    expect(relativeHostPath("/home/me/repo", "/home/me/repo/src/a.ts")).toBe(
      "src/a.ts",
    );
    expect(relativeHostPath("/home/me/repo", "/home/me/repository/a.ts")).toBeNull();
    expect(relativeHostPath("/home/me/repo", "/home/me/repo")).toBeNull();
    expect(relativeHostPath("/root", "/root/a/../b")).toBeNull();
    expect(relativeHostPath("/root", "/root/./b")).toBeNull();
    expect(relativeHostPath("/root", "/root//b")).toBeNull();
    expect(relativeHostPath("/home/me/repo/", "/home/me/repo/a.ts")).toBe("a.ts");
    expect(
      relativeHostPath("C:\\Users\\me\\repo", "c:/users/ME/repo/src/A.ts"),
    ).toBe("src/A.ts");
    expect(relativeHostPath("C:\\repo", "D:\\repo\\a.ts")).toBeNull();
    expect(relativeHostPath("/repo", "C:\\repo\\a.ts")).toBeNull();
  });
});
