export type HostPathFlavor = "posix" | "windows";

interface ParsedHostPath {
  flavor: HostPathFlavor;
  root: string;
  segments: string[];
}

const WINDOWS_DRIVE_PATH = /^([A-Za-z]):(?:[\\/]+|$)/u;
const WINDOWS_UNC_PATH = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+|$)/u;

function collapse(segments: string[]): string[] {
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      kept.pop();
      continue;
    }
    kept.push(segment);
  }
  return kept;
}

function parseHostPath(value: string): ParsedHostPath | null {
  if (value.includes("\0")) return null;
  const drive = WINDOWS_DRIVE_PATH.exec(value);
  if (drive) {
    return {
      flavor: "windows",
      root: `${(drive[1] ?? "").toUpperCase()}:\\`,
      segments: collapse(value.slice(drive[0].length).split(/[\\/]+/u)),
    };
  }
  const unc = WINDOWS_UNC_PATH.exec(value);
  if (unc) {
    return {
      flavor: "windows",
      root: `\\\\${unc[1] ?? ""}\\${unc[2] ?? ""}\\`,
      segments: collapse(value.slice(unc[0].length).split(/[\\/]+/u)),
    };
  }
  if (value.startsWith("/"))
    return { flavor: "posix", root: "/", segments: collapse(value.split("/")) };
  return null;
}

export function hostPathFlavor(value: string): HostPathFlavor | null {
  return parseHostPath(value)?.flavor ?? null;
}

export function isAbsoluteHostPath(value: string): boolean {
  return parseHostPath(value) !== null;
}

export function normalizeWindowsHostPath(value: string): string | null {
  const parsed = parseHostPath(value);
  if (parsed?.flavor !== "windows") return null;
  return `${parsed.root}${parsed.segments.join("\\")}`;
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
  const fold = (value: string) =>
    root.flavor === "windows" ? value.toLowerCase() : value;
  if (fold(root.root) !== fold(candidate.root)) return null;
  if (candidate.segments.length <= root.segments.length) return null;
  for (const [index, segment] of root.segments.entries()) {
    if (fold(segment) !== fold(candidate.segments[index] ?? "")) return null;
  }
  return candidate.segments.slice(root.segments.length).join("/");
}
