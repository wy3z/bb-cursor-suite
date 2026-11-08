import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { serializeProjectIcon, type ProjectIcon } from "@wy3z/bb-suite/project-icon";
import { ProjectIconArt } from "@wy3z/bb-suite/project-icon/picker";
import { BOARD_ICONS_CHANGED, projectsContract } from "./meta";
import { ProjectGlyph } from "./glyphs";
import { boardIconFor } from "./board-icons";

export function useBoardIcons() {
  const rpc = useRpc<typeof projectsContract>();
  const connection = useRealtimeConnectionState();
  const [rows, setRows] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const apply = useCallback((icons: { projectId: string; icon: string }[]) => setRows(new Map(icons.map((row) => [row.projectId, row.icon]))), []);
  const load = useCallback(() => {
    rpc.call("listIcons", {}).then((result) => apply(result.icons), () => undefined);
  }, [rpc, apply]);
  useEffect(load, [load, connection]);
  useRealtime(BOARD_ICONS_CHANGED, load);
  const setIcon = useCallback(
    (projectId: string, icon: ProjectIcon | null) => {
      const stored = icon === null ? null : serializeProjectIcon(icon);
      setRows((current) => {
        const next = new Map(current);
        if (stored === null) next.delete(projectId);
        else next.set(projectId, stored);
        return next;
      });
      setError(null);
      rpc.call("setIcon", { projectId, icon: stored }).then(
        (result) => apply(result.icons),
        (cause: unknown) => {
          setError(`Couldn't save the board icon: ${cause instanceof Error ? cause.message : String(cause)}`);
          load();
        },
      );
    },
    [rpc, apply, load],
  );
  const iconFor = useCallback((projectId: string | null) => boardIconFor(rows, projectId), [rows]);
  const clearError = useCallback(() => setError(null), []);
  return useMemo(() => ({ iconFor, setIcon, error, clearError }), [iconFor, setIcon, error, clearError]);
}

export function BoardIconArt({ icon, className }: { icon: ProjectIcon | null; className?: string }) {
  return <ProjectIconArt icon={icon} className={className} fallback={<ProjectGlyph className={className} />} />;
}

export function boardIconKind(icon: ProjectIcon | null): string {
  return icon === null ? "default" : icon.kind;
}

export function boardIconColorClass(icon: ProjectIcon | null): string | undefined {
  if (icon === null) return undefined;
  if (icon.kind === "glyph") return icon.color === undefined ? undefined : `bbs-pi-${icon.color}`;
  if (icon.kind === "monogram") return `bbs-pi-${icon.color}`;
  return undefined;
}
