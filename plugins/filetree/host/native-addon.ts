import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { nativeAssets } from "../generated/native-assets.js";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export interface NativeAddonStat {
  device: string;
  inode: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  mtimeMs: number;
  size: number;
}
export interface NativeAddonDirent {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  name: string;
}
export interface NativeAddonGitResult {
  code: number;
  stderr: Buffer;
  stdout: Buffer;
}
export interface NativeFilesAddon {
  cancelGit(id: number): void;
  canonicalPath(fd: number): string;
  close(fd: number): void;
  dirClose(dirId: number): void;
  dirOpen(fd: number): number;
  dirRead(dirId: number): NativeAddonDirent | null;
  dup(fd: number): number;
  fstat?(fd: number): NativeAddonStat;
  gitStatusAt(
    dirfd: number,
    file: string,
    args: string[],
    timeoutMs: number,
    maxBytes: number,
    env: string[],
  ): {
    id: number;
    promise: Promise<NativeAddonGitResult>;
  };
  open(path: string, flags: number): number;
  openat(dirfd: number, name: string, flags: number): number;
  read?(fd: number, size: number): Buffer;
  supportsOpenat2(): boolean;
}
export type NativeAddonSupport =
  | { kind: "supported" }
  | { kind: "unsupported"; platform: string; reason: string };
const here = dirname(fileURLToPath(import.meta.url));
const ADDON_CANDIDATES = [
  join(here, "native", "build", "Release", "host_native_files.node"),
  join(here, "native", "build", "Debug", "host_native_files.node"),
  join(here, "host_native_files.node"),
  join(here, "..", "..", "..", "dist", "host_native_files.node"),
];
export function nativeFilesAddonCandidates(): readonly string[] {
  return ADDON_CANDIDATES;
}
function loadCandidate(candidate: string): NativeFilesAddon {
  const require = createRequire(import.meta.url);
  return require(candidate) as NativeFilesAddon;
}
export function loadNativeFilesAddon(): NativeFilesAddon | null {
  for (const candidate of ADDON_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    try {
      return loadCandidate(candidate);
    } catch {
      continue;
    }
  }
  return null;
}
function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function unsupported(platform: string, reason: string): NativeAddonSupport {
  return { kind: "unsupported", platform, reason };
}
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split(/\r?\n/u)[0] ?? "").trim().slice(0, 300);
}
async function extract(target: string, bytes: Buffer, digest: string) {
  const existing = await readFile(target).catch(() => null);
  if (existing !== null && sha256(existing) === digest) return;
  await writeFile(target, bytes, { mode: 0o600 });
}
let prepared: Promise<NativeAddonSupport> | null = null;
export function prepareNativeAddon(
  tempDir: string,
): Promise<NativeAddonSupport> {
  prepared ??= (async (): Promise<NativeAddonSupport> => {
    const platform = `${process.platform}-${process.arch}`;
    const asset = nativeAssets[platform];
    if (!asset)
      return unsupported(
        platform,
        `Files runs on macOS, Linux (x64 and Arm) and Windows x64. It can't browse this machine (${platform}) yet.`,
      );
    const bytes = Buffer.from(asset.base64, "base64");
    if (sha256(bytes) !== asset.sha256)
      return unsupported(
        platform,
        `Files' native module for ${platform} is damaged. Reinstall the plugin.`,
      );
    const target = join(tempDir, `files-${asset.sha256}.node`);
    try {
      await extract(target, bytes, asset.sha256);
      loadCandidate(target);
    } catch (error) {
      return unsupported(
        platform,
        `Files couldn't load its native module on this machine (${platform}): ${firstLine(error)}`,
      );
    }
    ADDON_CANDIDATES.unshift(target);
    return { kind: "supported" };
  })();
  return prepared;
}
