import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useSdk, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { isWorking } from "./activity";
import { HoverCard, HoverCardFacts, HoverCardStatus, HoverCardTitle, type HoverFact } from "./HoverCard";
import type { ProjectIcon } from "./project-icons";
import { ProjectIconMark } from "./ProjectIconMark";
import { environmentTargets, projectRequestSummary, useSidebarRequests } from "./change-requests";
import { relativeTimeLabel } from "./relative-time";
import { THREAD_STATUS_LABEL, aggregateSectionStatus, type ThreadStatusKind } from "./status";
import { PROJECTS_PLUGIN, TASKS_PLUGIN, projectsContract, tasksContract } from "./suite-contracts";

const CACHE_MS = 30_000;
const PR_KEY_LIMIT = 40;
const BOARD_ORDER = [
  ["backlog", "backlog"],
  ["todo", "todo"],
  ["in_progress", "in progress"],
  ["in_review", "in review"],
  ["done", "done"],
] as const;

type Sdk = ReturnType<typeof useSdk>;

interface RepoFacts {
  path: string | null;
  remote: string | null;
  branch: string | null;
  dirty: boolean;
}

interface BoardFacts {
  name: string;
  prefix: string;
  counts: Record<string, number>;
  focus: string | null;
}

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

function runningPlugins(sdk: Sdk): Promise<ReadonlySet<string>> {
  return cached("plugins", async () => {
    const result = await sdk.plugins.list();
    return new Set(result.plugins.filter((plugin) => plugin.enabled && plugin.status === "running").map((plugin) => plugin.id));
  });
}

function loadRepo(sdk: Sdk, projectId: string): Promise<RepoFacts> {
  return cached(`repo:${projectId}`, async () => {
    const project = await sdk.projects.get({ projectId });
    const source = project.sources.find((entry) => entry.isDefault) ?? project.sources[0] ?? null;
    let branch: string | null = null;
    let dirty = false;
    if (source !== null) {
      try {
        const branches = await sdk.projects.branches({ projectId, hostId: source.hostId, limit: "1" });
        if (branches.checkout.kind === "branch") branch = branches.checkout.branchName;
        else if (branches.checkout.kind === "detached") branch = branches.checkout.headSha ? `detached ${branches.checkout.headSha.slice(0, 7)}` : "detached";
        dirty = branches.hasUncommittedChanges;
      } catch {
        branch = null;
      }
    }
    return { path: source?.path ?? null, remote: project.gitRemoteUrl, branch, dirty };
  });
}

function loadBoard(sdk: Sdk, target: { boardId: string } | { projectId: string }): Promise<BoardFacts | null> {
  const key = "boardId" in target ? `board:${target.boardId}` : `board-of:${target.projectId}`;
  return cached(key, async () => {
    const running = await runningPlugins(sdk);
    if (!running.has(PROJECTS_PLUGIN) || !running.has(TASKS_PLUGIN)) return null;
    const listed = await sdk.plugins.callRpc({
      pluginId: TASKS_PLUGIN,
      method: "listProjects",
      input: {},
      outputSchema: tasksContract.listProjects.output,
    });
    const board = listed.projects.find((entry) =>
      "boardId" in target ? entry.id === target.boardId : entry.linkedBbProjectId === target.projectId,
    );
    if (!board) return null;
    const [tasks, meta] = await Promise.all([
      sdk.plugins.callRpc({
        pluginId: TASKS_PLUGIN,
        method: "listAllTasks",
        input: { projectId: board.id },
        outputSchema: tasksContract.listAllTasks.output,
      }),
      sdk.plugins
        .callRpc({
          pluginId: PROJECTS_PLUGIN,
          method: "getMeta",
          input: { projectId: board.id },
          outputSchema: projectsContract.getMeta.output,
        })
        .catch(() => null),
    ]);
    const counts: Record<string, number> = {};
    for (const task of tasks.tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
    return { name: board.name, prefix: board.prefix, counts, focus: meta?.focus?.trim() || null };
  });
}

function useLoaded<T>(load: (() => Promise<T>) | null): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (load === null) return;
    let live = true;
    load().then(
      (next) => {
        if (live) setValue(next);
      },
      () => {
        if (live) setValue(null);
      },
    );
    return () => {
      live = false;
    };
  }, [load]);
  return value;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function tidyRemote(remote: string): string {
  return remote.replace(/^git@([^:]+):/, "$1/").replace(/^[a-z+]+:\/\//, "").replace(/\.git$/, "");
}

const TONE: Record<ThreadStatusKind, string> = {
  input: "bg-warning-text",
  failed: "bg-destructive",
  working: "bg-timeline-accent",
  unread: "bg-muted-foreground/65",
  idle: "bg-muted-foreground/30",
};

function ProjectHoverBody({
  name,
  projectId,
  icon,
  personal,
  boardId = null,
  threads,
  now,
}: {
  name: string;
  projectId: string | null;
  boardId?: string | null;
  icon: ProjectIcon | null;
  personal: boolean;
  threads: () => readonly PluginSidebarThread[];
  now: number;
}) {
  const sdk = useSdk();
  const members = threads();
  const live = useMemo(() => members.filter((thread) => !thread.isArchived), [members]);
  const status = aggregateSectionStatus(live).status;
  const repoLoad = useMemo(() => (projectId === null || personal ? null : () => loadRepo(sdk, projectId)), [personal, projectId, sdk]);
  const boardLoad = useMemo(
    () =>
      boardId !== null
        ? () => loadBoard(sdk, { boardId })
        : projectId === null || personal
          ? null
          : () => loadBoard(sdk, { projectId }),
    [boardId, personal, projectId, sdk],
  );
  const repo = useLoaded(repoLoad);
  const board = useLoaded(boardLoad);

  const prTargets = useMemo(
    () =>
      environmentTargets(
        [...live].sort((left, right) => right.updatedAt - left.updatedAt),
        PR_KEY_LIMIT,
      ).sort((left, right) => left.environmentId.localeCompare(right.environmentId)),
    [live],
  );
  const prs = useSidebarRequests(prTargets);

  let working = 0;
  let input = 0;
  let failed = 0;
  let agents = 0;
  let lastActivity = 0;
  for (const thread of live) {
    if (isWorking(thread)) working += 1;
    if (thread.hasPendingInteraction) input += 1;
    if (thread.indicator === "unread-error") failed += 1;
    agents += thread.activity.backgroundAgents;
    lastActivity = Math.max(lastActivity, thread.updatedAt);
  }

  const requests = projectRequestSummary(prTargets.map((target) => prs.get(target.environmentId)));

  const counts = [
    plural(live.length, "thread"),
    working > 0 ? `${working} working` : null,
    input > 0 ? `${input} need${input === 1 ? "s" : ""} input` : null,
    failed > 0 ? `${failed} failed` : null,
  ].filter((part): part is string => part !== null);

  const ago = (timestamp: number) => {
    const label = relativeTimeLabel(timestamp, now);
    return label === "now" ? "just now" : `${label} ago`;
  };

  const facts: HoverFact[] = [
    ...(repo?.path ? [{ icon: "FolderGit" as const, key: "repo", text: repo.remote ? tidyRemote(repo.remote) : "Local repository", detail: repo.path }] : []),
    ...(repo?.branch
      ? [{ icon: "GitBranch" as const, key: "branch", text: <span className="font-mono">{repo.branch}{repo.dirty ? <span className="font-sans opacity-75"> · uncommitted changes</span> : null}</span> }]
      : []),
    { icon: "MessageSquare", key: "threads", text: counts.join(" · ") },
    ...(agents > 0 ? [{ icon: "Bot" as const, key: "agents", text: `${plural(agents, "agent")} running` }] : []),
    ...(requests.open.length > 0
      ? [{ icon: "GitPullRequest" as const, key: "prs", text: `${plural(requests.open.length, `open ${requests.noun}`)}${requests.drafts > 0 ? `, ${requests.drafts} draft` : ""}`, detail: requests.open.map((request) => request.label).join(" ") }]
      : requests.known
        ? [{ icon: "GitPullRequest" as const, key: "prs", text: `No open ${requests.noun}s` }]
        : []),
    ...(lastActivity > 0 ? [{ icon: "Clock" as const, key: "activity", text: `Last activity ${ago(lastActivity)}` }] : []),
  ];

  const boardParts = board
    ? BOARD_ORDER.flatMap(([key, label]) => ((board.counts[key] ?? 0) > 0 ? [`${board.counts[key]} ${label}`] : []))
    : [];

  return (
    <>
      <HoverCardTitle>
        <span className="flex min-w-0 items-center gap-2">
          <ProjectIconMark icon={personal ? null : icon} fallback={personal ? "MessageSquare" : "Folder"} className="size-4 shrink-0" mutedClassName="text-muted-foreground" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
        </span>
      </HoverCardTitle>
      <HoverCardStatus>
        <span className="flex size-3.5 items-center justify-center">
          <span className={cn("size-2 rounded-full", TONE[status])} />
        </span>
        <span>{THREAD_STATUS_LABEL[status]}</span>
      </HoverCardStatus>
      <HoverCardFacts facts={facts} />
      {board ? (
        <div className="grid gap-1 border-t border-border pt-2 text-xs text-muted-foreground">
          <div className="flex min-w-0 items-start gap-2">
            <Icon name="ListTodo" className="mt-px size-3.5 shrink-0 opacity-70" />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className="text-foreground/85">{board.prefix} board</span>
              <span className="block opacity-75">{boardParts.length > 0 ? boardParts.join(" · ") : "No tasks"}</span>
            </span>
          </div>
          {board.focus ? <p className="truncate pl-5.5 italic opacity-75">{board.focus}</p> : null}
        </div>
      ) : null}
    </>
  );
}

export function ProjectHoverCard({
  disabled,
  name,
  projectId,
  icon,
  personal,
  boardId = null,
  threads,
  now,
  children,
}: {
  disabled: boolean;
  name: string;
  projectId: string | null;
  boardId?: string | null;
  icon: ProjectIcon | null;
  personal: boolean;
  threads: () => readonly PluginSidebarThread[];
  now: number;
  children: ReactElement;
}) {
  return (
    <HoverCard
      disabled={disabled}
      focusSelector="[data-project-focus-id]"
      className="cs-project-hover"
      content={
        <ProjectHoverBody
          name={name}
          projectId={projectId}
          icon={icon}
          personal={personal}
          boardId={boardId}
          threads={threads}
          now={now}
        />
      }
    >
      {children}
    </HoverCard>
  );
}
