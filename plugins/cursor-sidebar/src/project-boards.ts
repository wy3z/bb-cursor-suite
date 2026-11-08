import { useCallback, useEffect, useMemo, useState } from "react";
import { experimental_useRpcQuery, useSdk } from "@get-bb/plugin-sdk/app";
import { PROJECTS_PLUGIN, TASKS_PLUGIN, projectsContract, tasksContract } from "./suite-contracts";
import { serializeProjectIcon, type ProjectIcon } from "./project-icons";
import { boardIconLookup } from "./board-icon-lookup";

export interface ProjectBoard {
  id: string;
  name: string;
  prefix: string;
  bbProjectId: string | null;
  leadThreadId: string | null;
  focus: string | null;
}

export function useProjectBoards(): { boards: ProjectBoard[]; leadIds: ReadonlySet<string>; reload: () => void } {
  const projects = experimental_useRpcQuery({ pluginId: TASKS_PLUGIN, contract: tasksContract, method: "listProjects", input: {} });
  const leads = experimental_useRpcQuery({ pluginId: PROJECTS_PLUGIN, contract: projectsContract, method: "listLeads", input: {} });

  const boards = useMemo<ProjectBoard[]>(() => {
    const byProject = new Map((leads.data?.leads ?? []).map((lead) => [lead.projectId, lead]));
    return (projects.data?.projects ?? []).flatMap((project) => {
      const lead = byProject.get(project.id);
      if (!lead) return [];
      return [
        {
          id: project.id,
          name: project.name,
          prefix: project.prefix,
          bbProjectId: project.linkedBbProjectId,
          leadThreadId: lead.threadId,
          focus: lead.focus,
        },
      ];
    });
  }, [leads.data, projects.data]);

  const leadIds = useMemo(() => new Set(boards.flatMap((board) => (board.leadThreadId ? [board.leadThreadId] : []))), [boards]);
  return { boards, leadIds, reload: () => undefined };
}

export function openProjectBoard(projectId: string) {
  window.history.pushState(window.history.state, "", `/plugins/projects/projects/${encodeURIComponent(projectId)}`);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

export function useRemoveManager() {
  const sdk = useSdk();
  return (projectId: string) =>
    sdk.plugins.callRpc({
      pluginId: PROJECTS_PLUGIN,
      method: "setLead",
      input: { projectId, threadId: null },
      outputSchema: projectsContract.setLead.output,
    });
}

const BOARD_ICON_REFRESH_MS = 60_000;

export interface BoardIcons {
  available: boolean;
  iconFor: (boardId: string) => ProjectIcon | null;
  setIcon: (boardId: string, icon: ProjectIcon | null) => void;
}

export function useBoardIcons(enabled: boolean): BoardIcons {
  const sdk = useSdk();
  const query = experimental_useRpcQuery({ pluginId: PROJECTS_PLUGIN, contract: projectsContract, method: "listIcons", input: {}, enabled });
  const { refetch } = query;
  const [overrides, setOverrides] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const failed = Boolean(query.error) && !query.data;
  useEffect(() => {
    if (!enabled || failed) return;
    const again = () => {
      if (document.visibilityState === "visible") void refetch().catch(() => undefined);
    };
    const timer = window.setInterval(again, BOARD_ICON_REFRESH_MS);
    window.addEventListener("focus", again);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", again);
    };
  }, [enabled, failed, refetch]);
  useEffect(() => {
    setOverrides((current) => (current.size === 0 ? current : new Map()));
  }, [query.data]);
  const iconFor = useMemo(() => boardIconLookup(enabled ? query.data?.icons : undefined, overrides), [enabled, query.data, overrides]);
  const setIcon = useCallback(
    (boardId: string, icon: ProjectIcon | null) => {
      const stored = icon === null ? null : serializeProjectIcon(icon);
      setOverrides((current) => new Map(current).set(boardId, stored));
      sdk.plugins
        .callRpc({ pluginId: PROJECTS_PLUGIN, method: "setIcon", input: { projectId: boardId, icon: stored }, outputSchema: projectsContract.setIcon.output })
        .then(
          () => void refetch().catch(() => undefined),
          () => {
            setOverrides((current) => {
              const next = new Map(current);
              next.delete(boardId);
              return next;
            });
          },
        );
    },
    [sdk, refetch],
  );
  return useMemo(() => ({ available: enabled && !failed, iconFor, setIcon }), [enabled, failed, iconFor, setIcon]);
}
