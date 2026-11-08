import { useEffect, useMemo } from "react";
import { experimental_useRpcKeyedQuery } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import {
  CHANGE_REQUEST_KEY_LIMIT,
  CHANGE_REQUESTS_PLUGIN,
  changeRequestLabel,
  changeRequestNoun,
  changeRequestsContract,
  OPEN_CHANGE_REQUEST_EVENT,
  rowProvider,
  type ChangeRequest,
  type ChangeRequestProvider,
  type ChangeRequestRow,
  type ChangeRequestState,
} from "@wy3z/bb-suite/change-requests";

export const GITHUB_PR_STATUS_PLUGIN = "bb--github-pr-status";

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
            checks: z.object({ state: z.string() }).nullish().catch(null),
          }),
        }),
        z.object({ outcome: z.literal("absent") }),
        z.object({ outcome: z.literal("unavailable"), message: z.string() }),
      ]),
    ),
  },
} as const;

export type GitHubStatusRow = z.infer<typeof githubPrStatus.pullRequests.output>[string];

export type Source<Row> =
  | { status: "missing" }
  | { status: "loading" }
  | { status: "row"; row: Row }
  | { status: "failed"; message: string; row?: Row };

export interface RequestView {
  provider: ChangeRequestProvider;
  key: string;
  label: string;
  noun: string;
  title: string;
  url: string;
  state: ChangeRequestState;
  ciFailing: boolean;
  openable: ChangeRequest | null;
}

export type SidebarRequest =
  | { kind: "loading" }
  | { kind: "absent"; provider: ChangeRequestProvider | null }
  | { kind: "unavailable"; provider: ChangeRequestProvider | null; message: string }
  | { kind: "available"; request: RequestView };

export type RequestFilterState = ChangeRequestState | "none";

const LOADING: SidebarRequest = { kind: "loading" };
const NO_SOURCE: SidebarRequest = {
  kind: "unavailable",
  provider: null,
  message: "Neither Pull Requests nor GitHub PR Status is available to read this branch.",
};

function active(state: ChangeRequestState): boolean {
  return state === "open" || state === "draft";
}

export function fromGitHubStatus(row: GitHubStatusRow): SidebarRequest {
  if (row.outcome === "absent") return { kind: "absent", provider: "github" };
  if (row.outcome === "unavailable") return { kind: "unavailable", provider: "github", message: row.message };
  const pr = row.pullRequest;
  const failing = pr.checks ? pr.checks.state === "failing" : pr.attention === "checks_failed";
  return {
    kind: "available",
    request: {
      provider: "github",
      key: `github:${pr.url}`,
      label: `#${pr.number}`,
      noun: changeRequestNoun("github"),
      title: pr.title,
      url: pr.url,
      state: pr.state,
      ciFailing: failing && active(pr.state),
      openable: null,
    },
  };
}

export function fromChangeRequestRow(row: ChangeRequestRow): SidebarRequest {
  if (row.outcome === "absent") return { kind: "absent", provider: row.provider };
  if (row.outcome === "unavailable") return { kind: "unavailable", provider: row.provider, message: row.message };
  const changeRequest = row.changeRequest;
  const { provider, url } = changeRequest.identity;
  return {
    kind: "available",
    request: {
      provider,
      key: `${provider}:${url}`,
      label: changeRequestLabel(changeRequest.identity),
      noun: changeRequestNoun(provider),
      title: changeRequest.title,
      url,
      state: changeRequest.state,
      ciFailing: changeRequest.ci.state === "failed" && active(changeRequest.state),
      openable: provider === "gitlab" ? changeRequest : null,
    },
  };
}

export function isStale(row: ChangeRequestRow, branch: string | null | undefined): boolean {
  return row.environmentBranch !== undefined && branch !== undefined && row.environmentBranch !== branch;
}

function githubRowOf(github: Source<GitHubStatusRow>): GitHubStatusRow | undefined {
  if (github.status === "row") return github.row;
  return github.status === "failed" ? github.row : undefined;
}

function githubOnly(github: Source<GitHubStatusRow>): SidebarRequest {
  const row = githubRowOf(github);
  if (row !== undefined) return fromGitHubStatus(row);
  if (github.status === "loading") return LOADING;
  if (github.status === "failed") return { kind: "unavailable", provider: "github", message: github.message };
  return NO_SOURCE;
}

function onGitHub(github: Source<GitHubStatusRow>, fallback: SidebarRequest): SidebarRequest {
  const row = githubRowOf(github);
  if (row !== undefined) return fromGitHubStatus(row);
  return github.status === "loading" ? LOADING : fallback;
}

function onUnidentifiedForge(github: Source<GitHubStatusRow>, fallback: SidebarRequest): SidebarRequest {
  const row = githubRowOf(github);
  if (row?.outcome === "available") return fromGitHubStatus(row);
  return github.status === "loading" ? LOADING : fallback;
}

function unreachable(provider: ChangeRequestProvider | null, message: string): SidebarRequest {
  return { kind: "unavailable", provider, message: `Pull Requests couldn't be reached: ${message}` };
}

export function resolveRequest(
  pullRequests: Source<ChangeRequestRow>,
  github: Source<GitHubStatusRow>,
  branch?: string | null,
): SidebarRequest {
  if (pullRequests.status === "missing") return githubOnly(github);
  if (pullRequests.status === "loading") return LOADING;
  if (pullRequests.status === "failed") {
    const known = pullRequests.row !== undefined && !isStale(pullRequests.row, branch) ? rowProvider(pullRequests.row) : null;
    const failure = unreachable(known, pullRequests.message);
    if (known === "gitlab") return failure;
    if (known === "github") return onGitHub(github, failure);
    return onUnidentifiedForge(github, failure);
  }
  const row = pullRequests.row;
  if (isStale(row, branch)) return LOADING;
  const provider = rowProvider(row);
  if (provider === "gitlab") return fromChangeRequestRow(row);
  if (provider === "github") return onGitHub(github, fromChangeRequestRow(row));
  return onUnidentifiedForge(github, fromChangeRequestRow(row));
}

const STATE_LABELS: Record<ChangeRequestProvider, Record<ChangeRequestState, string>> = {
  github: {
    open: "Open pull request",
    draft: "Draft pull request",
    merged: "Merged pull request",
    closed: "Closed pull request",
  },
  gitlab: {
    open: "Open merge request",
    draft: "Draft merge request",
    merged: "Merged merge request",
    closed: "Closed merge request",
  },
};

export function requestLabel(request: Pick<RequestView, "provider" | "state" | "ciFailing">): string {
  const base = STATE_LABELS[request.provider][request.state];
  if (!request.ciFailing) return base;
  return `${base}, ${request.provider === "gitlab" ? "pipeline" : "checks"} failing`;
}

export function requestFailureNote(request: Pick<RequestView, "provider" | "ciFailing">): string {
  if (!request.ciFailing) return "";
  return request.provider === "gitlab" ? " · pipeline failing" : " · checks failing";
}

export function threadFilterState(
  thread: { environment?: { id: string | null } | null },
  statuses: ReadonlyMap<string, SidebarRequest>,
): RequestFilterState | undefined {
  const environmentId = thread.environment?.id;
  if (!environmentId) return "none";
  const status = statuses.get(environmentId);
  return status === undefined ? undefined : requestFilterState(status);
}

export function requestFilterState(request: SidebarRequest): RequestFilterState | undefined {
  if (request.kind === "available") return request.request.state;
  if (request.kind === "absent") return "none";
  return undefined;
}

export interface ProjectRequestSummary {
  open: RequestView[];
  drafts: number;
  known: boolean;
  noun: string;
}

export function projectRequestSummary(statuses: Iterable<SidebarRequest | undefined>): ProjectRequestSummary {
  const open = new Map<string, RequestView>();
  const providers = new Set<ChangeRequestProvider>();
  let known = false;
  for (const status of statuses) {
    if (status?.kind === "available") {
      known = true;
      providers.add(status.request.provider);
      if (active(status.request.state)) open.set(status.request.key, status.request);
    } else if (status?.kind === "absent") {
      known = true;
      if (status.provider) providers.add(status.provider);
    }
  }
  const list = [...open.values()];
  const noun = providers.has("gitlab") ? (providers.has("github") ? "PR/MR" : "MR") : "PR";
  return { open: list, drafts: list.filter((request) => request.state === "draft").length, known, noun };
}

export interface RequestTarget {
  environmentId: string;
  branch?: string | null;
}

interface QueryLike<Row> {
  data: Record<string, Row> | undefined;
  error: unknown;
}

function quoted(pluginId: string): string {
  return `plugin "${pluginId}"`;
}

export function pluginAbsent(error: unknown, pluginId: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  const status = Reflect.get(error, "status");
  const message = Reflect.get(error, "message");
  if (typeof status !== "number" || typeof message !== "string") return false;
  if (status === 404 && code === "unknown_method") return message.startsWith(`${quoted(pluginId)} has no rpc method "`);
  if (status === 404) return message === `unknown plugin "${pluginId}"`;
  if (status !== 503) return false;
  const disabled = `${quoted(pluginId)} is not running (status: disabled`;
  return message === `${disabled})` || message.startsWith(`${disabled} \u2014 `);
}

export function errorSource<Row>(error: unknown, pluginId: string, row: Row | undefined): Source<Row> {
  if (pluginAbsent(error, pluginId)) return { status: "missing" };
  const message = error instanceof Error && error.message ? error.message : "the read failed";
  return row === undefined ? { status: "failed", message } : { status: "failed", message, row };
}

export function requestNounOf(provider: ChangeRequestProvider | null): string {
  return provider === null ? "pull or merge request" : changeRequestNoun(provider);
}

type CallRpc = (args: { pluginId: string; method: string; input: { keys: string[] }; outputSchema: unknown }) => Promise<unknown>;

async function readOnce<Row>(callRpc: CallRpc, pluginId: string, method: string, outputSchema: unknown, environmentId: string): Promise<Source<Row>> {
  try {
    const result = (await callRpc({ pluginId, method, input: { keys: [environmentId] }, outputSchema })) as Record<string, Row>;
    const row = result[environmentId];
    return row === undefined ? { status: "failed", message: "no answer for this environment" } : { status: "row", row };
  } catch (error) {
    return errorSource<Row>(error, pluginId, undefined);
  }
}

export async function readRequestOnce(callRpc: CallRpc, environmentId: string, branch: string | null): Promise<SidebarRequest> {
  const [pullRequests, github] = await Promise.all([
    readOnce<ChangeRequestRow>(callRpc, CHANGE_REQUESTS_PLUGIN, "changeRequests", changeRequestsContract.changeRequests.output, environmentId),
    readOnce<GitHubStatusRow>(callRpc, GITHUB_PR_STATUS_PLUGIN, "pullRequests", githubPrStatus.pullRequests.output, environmentId),
  ]);
  return resolveRequest(pullRequests, github, branch);
}

export function sourceOf<Row>(query: QueryLike<Row>, pluginId: string, key: string): Source<Row> {
  const row = query.data?.[key];
  if (query.error) return errorSource(query.error, pluginId, row);
  return row === undefined ? { status: "loading" } : { status: "row", row };
}

export function resolveRequests(
  targets: readonly RequestTarget[],
  pullRequests: QueryLike<ChangeRequestRow>,
  github: QueryLike<GitHubStatusRow>,
): Map<string, SidebarRequest> {
  const results = new Map<string, SidebarRequest>();
  for (const { environmentId, branch } of targets) {
    if (results.has(environmentId)) continue;
    const pullRequestsSource = sourceOf(pullRequests, CHANGE_REQUESTS_PLUGIN, environmentId);
    const githubSource = sourceOf(github, GITHUB_PR_STATUS_PLUGIN, environmentId);
    results.set(environmentId, resolveRequest(pullRequestsSource, githubSource, branch));
  }
  return results;
}

export function staleKeys(targets: readonly RequestTarget[], pullRequests: QueryLike<ChangeRequestRow>): RequestTarget[] {
  if (pullRequests.error) return [];
  const seen = new Set<string>();
  const stale: RequestTarget[] = [];
  for (const target of targets) {
    if (seen.has(target.environmentId)) continue;
    seen.add(target.environmentId);
    const row = pullRequests.data?.[target.environmentId];
    if (row !== undefined && isStale(row, target.branch)) stale.push(target);
  }
  return stale;
}

const refreshed = new Set<string>();

function claimRefresh(target: RequestTarget): boolean {
  const key = `${target.environmentId}\n${target.branch ?? ""}`;
  if (refreshed.has(key)) return false;
  if (refreshed.size >= 500) refreshed.clear();
  refreshed.add(key);
  return true;
}

interface ThreadEnvironment {
  environment?: { id: string | null; branchName: string | null } | null;
}

export function environmentTargets(threads: Iterable<ThreadEnvironment>, limit = CHANGE_REQUEST_KEY_LIMIT): RequestTarget[] {
  const targets: RequestTarget[] = [];
  const seen = new Set<string>();
  for (const thread of threads) {
    if (targets.length >= limit) break;
    const environmentId = thread.environment?.id;
    if (!environmentId || seen.has(environmentId)) continue;
    seen.add(environmentId);
    targets.push({ environmentId, branch: thread.environment?.branchName ?? null });
  }
  return targets;
}

export function uniqueEnvironmentIds(targets: readonly RequestTarget[]): string[] {
  return [...new Set(targets.map((target) => target.environmentId))];
}

export function useSidebarRequests(targets: readonly RequestTarget[], enabled = true): Map<string, SidebarRequest> {
  const signature = targets.map((target) => `${target.environmentId}\u0000${target.branch === undefined ? "\u0001" : (target.branch ?? "\u0002")}`).join("\u0003");
  const stableTargets = useMemo(() => targets, [signature]);
  const keys = useMemo(() => uniqueEnvironmentIds(stableTargets), [stableTargets]);
  const on = enabled && keys.length > 0;
  const pullRequests = experimental_useRpcKeyedQuery({
    pluginId: CHANGE_REQUESTS_PLUGIN,
    contract: changeRequestsContract,
    method: "changeRequests",
    keys,
    enabled: on,
  });
  const github = experimental_useRpcKeyedQuery({
    pluginId: GITHUB_PR_STATUS_PLUGIN,
    contract: githubPrStatus,
    method: "pullRequests",
    keys,
    enabled: on,
  });
  const { refetchKeys } = pullRequests;
  const pullRequestsView = useMemo(() => ({ data: pullRequests.data, error: pullRequests.error }), [pullRequests.data, pullRequests.error]);
  const githubView = useMemo(() => ({ data: github.data, error: github.error }), [github.data, github.error]);
  useEffect(() => {
    if (!on) return;
    const claimed = staleKeys(stableTargets, pullRequestsView).filter(claimRefresh);
    if (claimed.length > 0) void refetchKeys(claimed.map((target) => target.environmentId));
  }, [on, stableTargets, pullRequestsView, refetchKeys]);
  return useMemo(
    () => (on ? resolveRequests(stableTargets, pullRequestsView, githubView) : new Map<string, SidebarRequest>()),
    [on, stableTargets, pullRequestsView, githubView],
  );
}

export function useSidebarRequest(environmentId: string | null, branch?: string | null): SidebarRequest | null {
  const targets = useMemo(
    () => (environmentId === null ? [] : [{ environmentId, branch }]),
    [environmentId, branch],
  );
  const results = useSidebarRequests(targets);
  return environmentId === null ? null : (results.get(environmentId) ?? LOADING);
}

export function requestOpenChangeRequest(
  target: EventTarget,
  changeRequest: Pick<ChangeRequest, "identity" | "connection">,
  threadId: string | null,
): boolean {
  const detail = {
    url: changeRequest.identity.url,
    ...(changeRequest.connection ? { connection: changeRequest.connection } : {}),
    ...(threadId ? { threadId } : {}),
  };
  const event = new CustomEvent(OPEN_CHANGE_REQUEST_EVENT, { bubbles: true, cancelable: true, detail });
  return !target.dispatchEvent(event);
}
