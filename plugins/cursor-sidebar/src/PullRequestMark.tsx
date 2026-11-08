import type { MouseEvent } from "react";
import type { ChangeRequest } from "@wy3z/bb-suite/change-requests";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { requestLabel, requestOpenChangeRequest, useSidebarRequest, type RequestView } from "./change-requests";

type PullRequestState = "open" | "draft" | "merged" | "closed";

interface Presentation {
  icon: IconName;
  tone: string;
}

/**
 * The leading mark for a real pull request, in Dray's open/draft/merged/closed
 * vocabulary. A failing check recolours the mark rather than adding a second
 * one: a broken build is a fact about this PR, and a merged or closed PR's
 * checks are history. No PR means no mark — nothing is fabricated.
 */
export const PRESENTATION: Record<PullRequestState, Presentation> = {
  open: { icon: "GitPullRequest", tone: "text-success" },
  draft: { icon: "GitPullRequestDraft", tone: "text-muted-foreground" },
  merged: { icon: "GitMerge", tone: "text-pr-merged" },
  closed: { icon: "GitPullRequestClosed", tone: "text-destructive" },
};

export function PullRequestMark({
  environmentId,
  branch,
  threadId = null,
}: {
  environmentId: string | null;
  branch?: string | null;
  threadId?: string | null;
}) {
  const status = useSidebarRequest(environmentId, branch);
  if (status?.kind !== "available") return null;
  const request = status.request;
  if (request.openable) return <MergeRequestMark request={request} changeRequest={request.openable} threadId={threadId} />;

  const presentation = PRESENTATION[request.state];
  const label = requestLabel(request);

  return (
    <span
      role="img"
      aria-label={label}
      title={`${request.label} · ${label.toLowerCase()}`}
      className="mr-1 flex size-3.5 shrink-0 items-center justify-center"
    >
      <Icon
        name={presentation.icon}
        className={cn("size-3.5", request.ciFailing ? "text-destructive" : presentation.tone)}
      />
    </span>
  );
}

function openInBrowser(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function MergeRequestMark({
  request,
  changeRequest,
  threadId,
}: {
  request: RequestView;
  changeRequest: ChangeRequest;
  threadId: string | null;
}) {
  const presentation = PRESENTATION[request.state];
  const failing = request.ciFailing;
  const label = requestLabel(request);
  const number = request.label;
  const url = request.url;

  const open = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      openInBrowser(url);
      return;
    }
    if (!requestOpenChangeRequest(event.currentTarget, changeRequest, threadId)) openInBrowser(url);
  };

  return (
    <button
      type="button"
      aria-label={`${label} ${number}, open`}
      title={`${number} · ${label.toLowerCase()}`}
      className="pointer-events-auto relative z-10 mr-1 flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={open}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        openInBrowser(url);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
    >
      <Icon
        name={presentation.icon}
        className={cn("size-3.5", failing ? "text-destructive" : presentation.tone)}
      />
    </button>
  );
}
