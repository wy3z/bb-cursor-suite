export type HostPathFlavor = "posix" | "windows";

interface ParsedHostPath {
  flavor: HostPathFlavor;
  drive: boolean;
  root: string;
  segments: string[];
}

const WINDOWS_DRIVE_PATH = /^([A-Za-z]):[\\/]+/u;
const WINDOWS_UNC_PATH = /^\\\\([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+|$)/u;

function parseHostPath(value: string): ParsedHostPath | null {
  if (value.includes("\0")) return null;
  const drive = WINDOWS_DRIVE_PATH.exec(value);
  if (drive) {
    return {
      flavor: "windows",
      drive: true,
      root: `${(drive[1] ?? "").toUpperCase()}:\\`,
      segments: value.slice(drive[0].length).split(/[\\/]/u),
    };
  }
  const unc = WINDOWS_UNC_PATH.exec(value);
  if (unc) {
    const server = unc[1] ?? "";
    if (server === "?" || server === ".") return null;
    return {
      flavor: "windows",
      drive: false,
      root: `\\\\${server}\\${unc[2] ?? ""}\\`,
      segments: value.slice(unc[0].length).split(/[\\/]/u),
    };
  }
  if (value.startsWith("/"))
    return {
      flavor: "posix",
      drive: false,
      root: "/",
      segments: value.slice(1).split("/"),
    };
  return null;
}

function rootSegments(parsed: ParsedHostPath): string[] | null {
  const segments = parsed.segments.filter((segment) => segment.length > 0);
  return segments.some((segment) => segment === "." || segment === "..")
    ? null
    : segments;
}

export function hostPathFlavor(value: string): HostPathFlavor | null {
  return parseHostPath(value)?.flavor ?? null;
}

export function isAbsoluteHostPath(value: string): boolean {
  return parseHostPath(value) !== null;
}

export function isWindowsDriveHostPath(value: string): boolean {
  return parseHostPath(value)?.drive ?? false;
}

export function normalizeWindowsHostPath(value: string): string | null {
  const parsed = parseHostPath(value);
  if (!parsed?.drive) return null;
  const segments = rootSegments(parsed);
  return segments === null ? null : `${parsed.root}${segments.join("\\")}`;
}

export function joinHostPath(rootPath: string, relativePath: string): string {
  if (relativePath === "") return rootPath;
  if (hostPathFlavor(rootPath) === "windows") {
    const separator = /[\\/]$/u.test(rootPath) ? "" : "\\";
    return `${rootPath}${separator}${relativePath.split("/").join("\\")}`;
  }
  return rootPath.endsWith("/")
    ? `${rootPath}${relativePath}`
    : `${rootPath}/${relativePath}`;
}

export function relativeHostPath(
  rootPath: string,
  candidatePath: string,
): string | null {
  const root = parseHostPath(rootPath);
  const candidate = parseHostPath(candidatePath);
  if (root === null || candidate === null || root.flavor !== candidate.flavor)
    return null;
  const base = rootSegments(root);
  if (base === null) return null;
  if (
    candidate.segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    return null;
  const fold = (value: string) =>
    root.flavor === "windows" ? value.toLowerCase() : value;
  if (fold(root.root) !== fold(candidate.root)) return null;
  if (candidate.segments.length <= base.length) return null;
  for (const [index, segment] of base.entries()) {
    if (fold(segment) !== fold(candidate.segments[index] ?? "")) return null;
  }
  return candidate.segments.slice(base.length).join("/");
}
