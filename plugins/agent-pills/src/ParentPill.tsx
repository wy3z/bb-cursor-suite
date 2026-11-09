import {
  experimental_Icon as Icon,
  experimental_useSidebarThreads,
  experimental_useThreadContextKind,
  useBbNavigate,
  type ExperimentalThreadContextSegmentInput,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { usePillsEnabled } from "./preferences";

export type ParentRelationship = "parent" | "fork";

export interface ParentLink {
  threadId: string;
  title: string;
  relationship: ParentRelationship;
}

type ThreadLike = Pick<
  PluginSidebarThread,
  "id" | "projectId" | "displayTitle" | "parentThreadId" | "sourceThreadId" | "originKind" | "isArchived"
>;

const VERB: Record<ParentRelationship, string> = {
  parent: "Parent",
  fork: "Forked from",
};

const ICON: Record<ParentRelationship, "UserRound" | "Fork"> = {
  parent: "UserRound",
  fork: "Fork",
};

export function resolveParent(
  threadId: string,
  threads: readonly ThreadLike[],
): ParentLink | null {
  const thread = threads.find((candidate) => candidate.id === threadId);
  if (!thread) return null;
  const relationship: ParentRelationship = thread.originKind === "fork" ? "fork" : "parent";
  const targetId =
    thread.originKind === null
      ? thread.parentThreadId
      : (thread.sourceThreadId ?? thread.parentThreadId);
  if (!targetId || targetId === threadId) return null;
  const target = threads.find((candidate) => candidate.id === targetId);
  if (!target || target.isArchived) return null;
  if (relationship === "fork" && target.projectId !== thread.projectId) return null;
  return { threadId: target.id, title: target.displayTitle, relationship };
}

export function parentLabel(parent: ParentLink): string {
  return `${VERB[parent.relationship]} ${parent.title}`;
}

function useParent(threadId: string): ParentLink | null {
  const { threads } = experimental_useSidebarThreads();
  return resolveParent(threadId, threads);
}

export function useParentPillVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const enabled = usePillsEnabled();
  const kind = experimental_useThreadContextKind();
  const parent = useParent(threadId);
  return enabled && kind === "banner" && parent !== null;
}

export function ParentPillView({
  parent,
  onOpen,
}: {
  parent: ParentLink;
  onOpen: (threadId: string) => void;
}) {
  const label = parentLabel(parent);
  return (
    <div className="bb-agent-pills" data-bb-agent-pills="">
      <div className="bb-agent-pills__row">
        <button
          type="button"
          className="bb-agent-pills__pill"
          data-group="parent"
          aria-label={label}
          title={label}
          onClick={() => onOpen(parent.threadId)}
        >
          <Icon name={ICON[parent.relationship]} aria-hidden />
          <span className="bb-agent-pills__label">{label}</span>
        </button>
      </div>
    </div>
  );
}

export function ParentPill({ threadId }: ExperimentalThreadContextSegmentInput) {
  const parent = useParent(threadId);
  const navigate = useBbNavigate();
  if (!parent) return null;
  return <ParentPillView parent={parent} onOpen={(id) => navigate.toThread(id)} />;
}
