import type { MouseEvent } from "react";
import { experimental_useRpcKeyedQuery } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { changeRequestLabel, type ChangeRequest } from "@wy3z/bb-suite/change-requests";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { requestOpenChangeRequest, useGitLabChangeRequest } from "./change-requests";

/**
 * The bundled GitHub PR Status plugin's `pullRequests` read, copied from
 * references/frontend-pull-requests.md. Keys are environment ids, so rows
 * sharing a worktree share one read.
 *
 * A plain object, not `defineRpcContract`: that lives in the server SDK root,
 * which a clean install does not provide to the frontend bundle.
 */
export const githubPrStatus = {
  pullRequests: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(
      z.string(),
      z.discriminatedUnion("outcome", [
        z.object({
          outcome: z.literal("available"),
          pullRequest: z.object({
            number: z.number(),
            title: z.string(),
            url: z.string(),
            state: z.enum(["draft", "open", "merged", "closed"]),
            attention: z.string(),
          }),
        }),
        z.object({ outcome: z.literal("absent") }),
        z.object({ outcome: z.literal("unavailable"), message: z.string() }),
      ]),
    ),
  },
} as const;

type PullRequestState = "open" | "draft" | "merged" | "closed";

interface Presentation {
  icon: IconName;
  tone: string;
  label: string;
}

/**
 * The leading mark for a real pull request, in Dray's open/draft/merged/closed
 * vocabulary. A failing check recolours the mark rather than adding a second
 * one: a broken build is a fact about this PR, and a merged or closed PR's
 * checks are history. No PR means no mark — nothing is fabricated.
 */
export const PRESENTATION: Record<PullRequestState, Presentation> = {
  open: { icon: "GitPullRequest", tone: "text-success", label: "Open pull request" },
  draft: {
    icon: "GitPullRequestDraft",
    tone: "text-muted-foreground",
    label: "Draft pull request",
  },
  merged: { icon: "GitMerge", tone: "text-pr-merged", label: "Merged pull request" },
  closed: {
    icon: "GitPullRequestClosed",
    tone: "text-destructive",
    label: "Closed pull request",
  },
};

/**
 * Reads the GitHub PR Status plugin's cached pull-request state for one row's
 * environment. The host owns the polling and staleness rules; a query error,
 * `absent` and `unavailable` all mean "nothing to show", never an error.
 */
export function PullRequestMark({
  environmentId,
  threadId = null,
}: {
  environmentId: string | null;
  threadId?: string | null;
}) {
  const { data } = experimental_useRpcKeyedQuery({
    pluginId: "bb--github-pr-status",
    contract: githubPrStatus,
    method: "pullRequests",
    keys: environmentId === null ? [] : [environmentId],
  });
  const gitlab = useGitLabChangeRequest(environmentId);
  if (gitlab.kind === "gitlab") {
    return gitlab.changeRequest ? <MergeRequestMark changeRequest={gitlab.changeRequest} threadId={threadId} /> : null;
  }
  const row = environmentId === null ? undefined : data?.[environmentId];
  if (row?.outcome !== "available") return null;
  const pullRequest = row.pullRequest;

  const presentation = PRESENTATION[pullRequest.state];
  const failing =
    pullRequest.attention === "checks_failed" &&
    pullRequest.state !== "merged" &&
    pullRequest.state !== "closed";
  const label = failing ? `${presentation.label}, checks failing` : presentation.label;

  return (
    <span
      role="img"
      aria-label={label}
      title={`#${pullRequest.number} · ${label.toLowerCase()}`}
      className="mr-1 flex size-3.5 shrink-0 items-center justify-center"
    >
      <Icon
        name={presentation.icon}
        className={cn("size-3.5", failing ? "text-destructive" : presentation.tone)}
      />
    </span>
  );
}

const MERGE_REQUEST_LABEL: Record<PullRequestState, string> = {
  open: "Open merge request",
  draft: "Draft merge request",
  merged: "Merged merge request",
  closed: "Closed merge request",
};

function openInBrowser(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function MergeRequestMark({ changeRequest, threadId }: { changeRequest: ChangeRequest; threadId: string | null }) {
  const state = changeRequest.state;
  const presentation = PRESENTATION[state];
  const failing = changeRequest.ci.state === "failed" && state !== "merged" && state !== "closed";
  const label = failing ? `${MERGE_REQUEST_LABEL[state]}, pipeline failing` : MERGE_REQUEST_LABEL[state];
  const number = changeRequestLabel(changeRequest.identity);
  const url = changeRequest.identity.url;

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
