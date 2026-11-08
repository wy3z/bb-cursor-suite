import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import type { NativeFileRootsResponse } from "../contracts/api";
import { nativeFilePathSchema } from "../contracts/model";
import { isAbsoluteHostPath, relativeHostPath } from "../contracts/host-path";
import type { NativeFilesSelection } from "./native-files-ui-types";

export function resolveFileOpenerTarget(
  path: string,
  source: PluginFileOpenerSource,
  response: NativeFileRootsResponse,
): NativeFilesSelection | null {
  if (
    source.threadId === null ||
    response.threadId !== source.threadId ||
    response.kind !== "ready" ||
    source.kind === "thread-storage"
  )
    return null;
  if (source.kind === "workspace") {
    const parsed = nativeFilePathSchema.safeParse(path);
    if (!parsed.success || source.environmentId === null) return null;
    const root = response.roots.find(
      (candidate) =>
        candidate.navigationRoot.kind === "workspace" &&
        candidate.navigationRoot.environmentId === source.environmentId &&
        (source.projectId === null ||
          candidate.projectId === source.projectId) &&
        (source.experimental_hostId === undefined ||
          candidate.hostId === source.experimental_hostId),
    );
    return root ? { root, path: parsed.data } : null;
  }
  if (!isAbsoluteHostPath(path)) return null;
  const hostId =
    source.experimental_hostId ??
    response.roots.find(
      (root) =>
        root.isActiveEnvironment &&
        (source.environmentId === null ||
          (root.navigationRoot.kind === "workspace" &&
            root.navigationRoot.environmentId === source.environmentId)),
    )?.hostId;
  if (hostId === undefined) return null;
  const roots = response.roots
    .filter((root) => root.hostId === hostId)
    .sort((left, right) => right.rootPath.length - left.rootPath.length);
  for (const root of roots) {
    const relative = relativeHostPath(root.rootPath, path);
    if (relative === null) continue;
    const parsed = nativeFilePathSchema.safeParse(relative);
    if (parsed.success) return { root, path: parsed.data };
  }
  return null;
}
