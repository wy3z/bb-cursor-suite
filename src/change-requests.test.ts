import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  changeRequestRowSchema,
  OPEN_CHANGE_REQUEST_EVENT,
  type ChangeRequest,
  type ChangeRequestRow,
  type ChangeRequestState,
} from "@wy3z/bb-suite/change-requests";
import {
  environmentTargets,
  pluginAbsent,
  readRequestOnce,
  githubPrStatus,
  projectRequestSummary,
  requestFilterState,
  requestLabel,
  requestOpenChangeRequest,
  resolveRequest,
  resolveRequests,
  staleKeys,
  threadFilterState,
  uniqueEnvironmentIds,
  type GitHubStatusRow,
  type SidebarRequest,
  type Source,
} from "./change-requests";
import { DEFAULT_SIDEBAR_VIEW, filterOrdinaryThreads } from "./sidebar-view";

const STATES: ChangeRequestState[] = ["open", "draft", "merged", "closed"];

function mergeRequest(overrides: Partial<ChangeRequest> = {}, iid = 12): ChangeRequest {
  return {
    identity: {
      provider: "gitlab",
      instance: "https://gitlab.com",
      projectPath: "group/sub/project",
      number: iid,
      url: `https://gitlab.com/group/sub/project/-/merge_requests/${iid}`,
      projectId: 77,
    },
    title: "Ship it",
    state: "open",
    ci: { state: "passed" },
    sourceBranch: "feature",
    targetBranch: "main",
    updatedAt: null,
    fetchedAt: "2026-11-07T00:00:00.000Z",
    connection: "glab:host1",
    ...overrides,
  };
}

function githubRow(
  state: ChangeRequestState,
  extra: { attention?: string; checks?: { state: string } | null; number?: number } = {},
): GitHubStatusRow {
  const number = extra.number ?? 9;
  return {
    outcome: "available",
    pullRequest: {
      number,
      title: "GitHub change",
      url: `https://github.com/owner/repo/pull/${number}`,
      state,
      attention: extra.attention ?? "none",
      checks: extra.checks === undefined ? { state: "passing" } : extra.checks,
    },
  };
}

function githubFromPullRequests(state: ChangeRequestState, branch?: string | null): ChangeRequestRow {
  return {
    outcome: "available",
    changeRequest: {
      ...mergeRequest({ state, connection: null }),
      identity: { provider: "github", instance: "https://github.com", projectPath: "owner/repo", number: 9, url: "https://github.com/owner/repo/pull/9" },
    },
    ...(branch === undefined ? {} : { environmentBranch: branch }),
  };
}

const row = <Row,>(value: Row): Source<Row> => ({ status: "row", row: value });

function rpcError(code: string, status: number | undefined, message: string): Error {
  const error = new Error(message);
  Reflect.set(error, "code", code);
  if (status !== undefined) Reflect.set(error, "status", status);
  return error;
}
const LOADING = { status: "loading" } as const;
const MISSING = { status: "missing" } as const;

function available(status: SidebarRequest) {
  assert.equal(status.kind, "available");
  return (status as Extract<SidebarRequest, { kind: "available" }>).request;
}

function thread(id: string, environmentId: string | null, branch: string | null = "feature"): PluginSidebarThread {
  return {
    id, projectId: "p", title: id, titleFallback: null, displayTitle: id,
    parentThreadId: null, lifecycleOwnerThreadId: null, parentNotifications: "auto",
    sourceThreadId: null, sectionId: null, originKind: null, originPluginId: null,
    providerId: "codex", status: "idle", runtimeStatus: "idle", queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0 },
    indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false,
    pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null,
    href: `/threads/${id}`, isHidden: false,
    environment: environmentId === null ? null : ({ id: environmentId, name: null, branchName: branch, path: null, isWorktree: null } as unknown as PluginSidebarThread["environment"]),
    host: null,
    createdAt: 0, updatedAt: 1, lastReadAt: null, latestAttentionAt: 0,
  } as PluginSidebarThread;
}

test("each state means the same thing to the filter, the mark and the hover count, for both providers", () => {
  for (const state of STATES) {
    const lab = resolveRequest(row<ChangeRequestRow>({ outcome: "available", changeRequest: mergeRequest({ state }), environmentBranch: "feature" }), LOADING, "feature");
    const hub = resolveRequest(row(githubFromPullRequests(state, "feature")), row(githubRow(state)), "feature");
    for (const [status, provider, label] of [[lab, "gitlab", "!12"], [hub, "github", "#9"]] as const) {
      const request = available(status);
      assert.equal(request.provider, provider);
      assert.equal(request.label, label);
      assert.equal(request.state, state);
      assert.equal(requestFilterState(status), state);
      const summary = projectRequestSummary([status]);
      assert.equal(summary.known, true);
      assert.equal(summary.open.length, state === "open" || state === "draft" ? 1 : 0);
      assert.equal(summary.drafts, state === "draft" ? 1 : 0);
    }
  }
});

test("the filter, marks and project count agree over a mixed set of threads", () => {
  const targets = [
    { environmentId: "lab-open", branch: "feature" },
    { environmentId: "lab-draft", branch: "feature" },
    { environmentId: "hub-open", branch: "feature" },
    { environmentId: "hub-merged", branch: "feature" },
    { environmentId: "lab-none", branch: "feature" },
    { environmentId: "lab-auth", branch: "feature" },
    { environmentId: "pending", branch: "feature" },
  ];
  const pullRequests = {
    error: null,
    data: {
      "lab-open": { outcome: "available", changeRequest: mergeRequest({}, 1), environmentBranch: "feature" },
      "lab-draft": { outcome: "available", changeRequest: mergeRequest({ state: "draft" }, 2), environmentBranch: "feature" },
      "hub-open": githubFromPullRequests("open", "feature"),
      "hub-merged": githubFromPullRequests("merged", "feature"),
      "lab-none": { outcome: "absent", provider: "gitlab", environmentBranch: "feature" },
      "lab-auth": { outcome: "unavailable", provider: "gitlab", reason: "authentication", message: "Sign in to glab", environmentBranch: "feature" },
    } satisfies Record<string, ChangeRequestRow>,
  };
  const github = {
    error: null,
    data: {
      "hub-open": githubRow("open", { number: 4 }),
      "hub-merged": githubRow("merged", { number: 5 }),
      "lab-open": githubRow("open", { number: 99 }),
      "lab-none": githubRow("open", { number: 98 }),
      "lab-auth": githubRow("open", { number: 97 }),
    } satisfies Record<string, GitHubStatusRow>,
  };
  const statuses = resolveRequests(targets, pullRequests, github);
  const threads = targets.map((target) => thread(`t-${target.environmentId}`, target.environmentId));
  const filterState = (environmentId: string) => threadFilterState(thread("x", environmentId), statuses);

  assert.equal(filterState("lab-open"), "open");
  assert.equal(filterState("lab-draft"), "draft");
  assert.equal(filterState("hub-open"), "open");
  assert.equal(filterState("hub-merged"), "merged");
  assert.equal(filterState("lab-none"), "none");
  assert.equal(filterState("lab-auth"), undefined);
  assert.equal(filterState("pending"), undefined);
  assert.equal(threadFilterState(thread("bare", null), statuses), "none");

  const openOnly = filterOrdinaryThreads(threads, { ...DEFAULT_SIDEBAR_VIEW, prFilter: ["open", "draft"] }, {
    now: 0,
    bypass: () => false,
    prStateOf: (entry) => threadFilterState(entry, statuses),
  }).map((entry) => entry.environment?.id);
  assert.deepEqual(openOnly.sort(), ["hub-open", "lab-auth", "lab-draft", "lab-open", "pending"]);

  const marked = [...statuses.values()].filter((status) => status.kind === "available").map((status) => available(status).label).sort();
  assert.deepEqual(marked, ["!1", "!2", "#4", "#5"]);

  const summary = projectRequestSummary(targets.map((target) => statuses.get(target.environmentId)));
  assert.deepEqual(summary.open.map((request) => request.label).sort(), ["!1", "!2", "#4"]);
  assert.equal(summary.drafts, 1);
  assert.equal(summary.noun, "PR/MR");
  const openFiltered = targets.filter((target) => ["open", "draft"].includes(filterState(target.environmentId) ?? "")).length;
  assert.equal(summary.open.length, openFiltered);
});

test("the provider comes from the repository, never from GitHub's answer", () => {
  const lab = resolveRequest(row<ChangeRequestRow>({ outcome: "absent", provider: "gitlab" }), row(githubRow("open")), null);
  assert.deepEqual(lab, { kind: "absent", provider: "gitlab" });
  const auth = resolveRequest(row<ChangeRequestRow>({ outcome: "unavailable", provider: "gitlab", reason: "authentication", message: "x" }), row(githubRow("open")));
  assert.equal(auth.kind, "unavailable");
  const waiting = resolveRequest(LOADING, row(githubRow("open")));
  assert.deepEqual(waiting, { kind: "loading" });
  const hubWaiting = resolveRequest(row(githubFromPullRequests("open")), LOADING);
  assert.deepEqual(hubWaiting, { kind: "loading" });
});

test("GitHub rows keep the builtin GitHub answer, so GitHub behaviour is unchanged with Pull Requests installed", () => {
  const live = resolveRequest(row(githubFromPullRequests("open")), row(githubRow("merged", { number: 21 })));
  assert.equal(available(live).label, "#21");
  assert.equal(available(live).state, "merged");
  assert.equal(available(live).openable, null);
  const sshAlias = resolveRequest(row<ChangeRequestRow>({ outcome: "unavailable", provider: null, reason: "unsupportedHost", message: "x" }), row(githubRow("open", { number: 33 })));
  assert.equal(available(sshAlias).label, "#33");
  const builtinOff = resolveRequest(row<ChangeRequestRow>({ outcome: "unavailable", provider: "github", reason: "providerUnavailable", message: "off" }), MISSING);
  assert.equal(builtinOff.kind, "unavailable");
  assert.equal(requestFilterState(builtinOff), undefined);
});

test("a failed pipeline shows on drafts and on conflicting requests, never on finished ones", () => {
  for (const state of ["open", "draft"] as const) {
    const lab = available(resolveRequest(row<ChangeRequestRow>({ outcome: "available", changeRequest: mergeRequest({ state, ci: { state: "failed" } }) }), MISSING));
    assert.equal(lab.ciFailing, true);
    assert.equal(requestLabel(lab), `${state === "open" ? "Open" : "Draft"} merge request, pipeline failing`);
    const conflicts = available(resolveRequest(MISSING, row(githubRow(state, { attention: "conflicts", checks: { state: "failing" } }))));
    assert.equal(conflicts.ciFailing, true);
    assert.equal(requestLabel(conflicts), `${state === "open" ? "Open" : "Draft"} pull request, checks failing`);
    const draftAttention = available(resolveRequest(MISSING, row(githubRow(state, { attention: "draft", checks: { state: "failing" } }))));
    assert.equal(draftAttention.ciFailing, true);
  }
  for (const state of ["merged", "closed"] as const) {
    assert.equal(available(resolveRequest(row<ChangeRequestRow>({ outcome: "available", changeRequest: mergeRequest({ state, ci: { state: "failed" } }) }), MISSING)).ciFailing, false);
    assert.equal(available(resolveRequest(MISSING, row(githubRow(state, { checks: { state: "failing" } })))).ciFailing, false);
  }
  assert.equal(available(resolveRequest(MISSING, row(githubRow("open", { attention: "checks_failed", checks: null })))).ciFailing, true);
  assert.equal(available(resolveRequest(MISSING, row(githubRow("open", { attention: "conflicts", checks: { state: "pending" } })))).ciFailing, false);
});

test("loading, unavailable and absent stay distinct in the filter and the count", () => {
  const loading = resolveRequest(LOADING, LOADING);
  const unavailable = resolveRequest(row<ChangeRequestRow>({ outcome: "unavailable", provider: "gitlab", reason: "hostOffline", message: "offline" }), MISSING);
  const absent = resolveRequest(row<ChangeRequestRow>({ outcome: "absent", provider: "gitlab" }), MISSING);
  assert.deepEqual([loading.kind, unavailable.kind, absent.kind], ["loading", "unavailable", "absent"]);
  assert.deepEqual([requestFilterState(loading), requestFilterState(unavailable), requestFilterState(absent)], [undefined, undefined, "none"]);
  assert.equal(projectRequestSummary([loading, unavailable, undefined]).known, false);
  const known = projectRequestSummary([absent]);
  assert.equal(known.known, true);
  assert.equal(known.open.length, 0);
  assert.equal(known.noun, "MR");
});

test("repeated rows for one environment share one key and one answer", () => {
  const threads = [thread("a", "env-1"), thread("b", "env-1"), thread("c", null), thread("d", "env-2"), thread("e", "env-1")];
  const targets = environmentTargets(threads);
  assert.deepEqual(targets, [
    { environmentId: "env-1", branch: "feature" },
    { environmentId: "env-2", branch: "feature" },
  ]);
  assert.deepEqual(uniqueEnvironmentIds([...targets, ...targets]), ["env-1", "env-2"]);
  assert.equal(environmentTargets(threads, 1).length, 1);
  const statuses = resolveRequests(targets, { error: null, data: { "env-1": { outcome: "available", changeRequest: mergeRequest() } } }, { error: null, data: {} });
  for (const id of ["a", "b", "e"]) assert.equal(threadFilterState(threads.find((entry) => entry.id === id)!, statuses), "open");
  const summary = projectRequestSummary(threads.map((entry) => (entry.environment?.id ? statuses.get(entry.environment.id) : undefined)));
  assert.equal(summary.open.length, 1);
});

test("a branch switch hides the old request until Pull Requests answers for the new branch", () => {
  const old: ChangeRequestRow = { outcome: "available", changeRequest: mergeRequest(), environmentBranch: "feature" };
  assert.deepEqual(resolveRequest(row(old), MISSING, "other"), { kind: "loading" });
  assert.deepEqual(resolveRequest(row(githubFromPullRequests("open", "feature")), row(githubRow("open")), "other"), { kind: "loading" });
  assert.equal(resolveRequest(row(old), MISSING, "feature").kind, "available");
  assert.equal(resolveRequest(row<ChangeRequestRow>({ outcome: "absent", provider: null, environmentBranch: null }), MISSING, null).kind, "absent");
  assert.equal(resolveRequest(row<ChangeRequestRow>({ outcome: "available", changeRequest: mergeRequest() }), MISSING, "other").kind, "available");
  const targets = [{ environmentId: "a", branch: "other" }, { environmentId: "b", branch: "feature" }, { environmentId: "a", branch: "other" }];
  assert.deepEqual(staleKeys(targets, { error: null, data: { a: old, b: old } }), [{ environmentId: "a", branch: "other" }]);
  assert.deepEqual(staleKeys(targets, { error: new Error("gone"), data: { a: old } }), []);
  assert.equal(threadFilterState(thread("x", "a", "other"), resolveRequests(targets, { error: null, data: { a: old } }, { error: null, data: {} })), undefined);
});

test("without Pull Requests the builtin GitHub status is used exactly as before", () => {
  for (const state of STATES) {
    const status = resolveRequest(MISSING, row(githubRow(state)));
    assert.equal(available(status).label, "#9");
    assert.equal(requestFilterState(status), state);
  }
  assert.deepEqual(resolveRequest(MISSING, row({ outcome: "absent" })), { kind: "absent", provider: "github" });
  assert.deepEqual(resolveRequest(MISSING, LOADING), { kind: "loading" });
  const neither = resolveRequest(MISSING, MISSING);
  assert.equal(neither.kind, "unavailable");
  assert.equal(requestFilterState(neither), undefined);
});

test("removing Pull Requests mid-session drops its GitLab answers and falls back to GitHub", () => {
  const before = resolveRequests([{ environmentId: "e" }], { error: null, data: { e: { outcome: "available", changeRequest: mergeRequest() } } }, { error: null, data: { e: { outcome: "absent" } } });
  assert.equal(available(before.get("e")!).provider, "gitlab");
  const removed = rpcError("handler_error", 404, 'unknown plugin "pull-requests"');
  const after = resolveRequests([{ environmentId: "e" }], { error: removed, data: { e: { outcome: "available", changeRequest: mergeRequest() } } }, { error: null, data: { e: { outcome: "absent" } } });
  assert.deepEqual(after.get("e"), { kind: "absent", provider: "github" });
});

test("rows from an older Pull Requests without a branch stamp still parse and are never treated as stale", () => {
  const parsed = changeRequestRowSchema.parse({ outcome: "absent", provider: "gitlab" });
  assert.equal(parsed.environmentBranch, undefined);
  assert.equal(resolveRequest(row(parsed), MISSING, "anything").kind, "absent");
  assert.equal(changeRequestRowSchema.parse({ outcome: "absent", provider: "gitlab", environmentBranch: "x" }).environmentBranch, "x");
});

test("an unexpected checks shape from GitHub PR Status falls back to the attention summary", () => {
  const parsed = githubPrStatus.pullRequests.output.parse({ e: { outcome: "available", pullRequest: { number: 1, title: "t", url: "https://github.com/o/r/pull/1", state: "open", attention: "checks_failed", checks: "weird" } } });
  assert.equal(available(resolveRequest(MISSING, row(parsed.e!))).ciFailing, true);
});

test("only GitLab requests open in the Pull Requests tab from the mark", () => {
  assert.notEqual(available(resolveRequest(row<ChangeRequestRow>({ outcome: "available", changeRequest: mergeRequest() }), MISSING)).openable, null);
  assert.equal(available(resolveRequest(MISSING, row(githubRow("open")))).openable, null);
});

test("opening dispatches the shared cancelable event with the connection and thread", () => {
  const target = new EventTarget();
  let seen: unknown = null;
  target.addEventListener(OPEN_CHANGE_REQUEST_EVENT, (event) => {
    seen = (event as CustomEvent).detail;
    event.preventDefault();
  });
  assert.equal(requestOpenChangeRequest(target, mergeRequest({ ci: { state: "failed" } }), "thr_abc"), true);
  assert.deepEqual(seen, { url: "https://gitlab.com/group/sub/project/-/merge_requests/12", connection: "glab:host1", threadId: "thr_abc" });
});

test("without a Pull Requests handler the caller opens the URL itself", () => {
  assert.equal(requestOpenChangeRequest(new EventTarget(), mergeRequest(), null), false);
});

test("a Pull Requests read that fails for operational reasons keeps the GitLab identity and never becomes None", () => {
  const failures = [
    rpcError("transport_error", undefined, "network timeout"),
    rpcError("invalid_response", 200, "bad body"),
    rpcError("handler_error", 500, "boom"),
    rpcError("handler_error", 503, 'plugin "pull-requests" is not running (status: starting)'),
  ];
  const known: ChangeRequestRow[] = [
    { outcome: "unavailable", provider: "gitlab", reason: "authentication", message: "Sign in to glab", environmentBranch: "feature" },
    { outcome: "available", changeRequest: mergeRequest(), environmentBranch: "feature" },
  ];
  const github = { error: null, data: { e: { outcome: "absent" } satisfies GitHubStatusRow } };
  for (const error of failures) {
    assert.equal(pluginAbsent(error, "pull-requests"), false, error.message);
    for (const cached of known) {
      const status = resolveRequests([{ environmentId: "e", branch: "feature" }], { error, data: { e: cached } }, github).get("e")!;
      assert.equal(status.kind, "unavailable", error.message);
      assert.equal((status as Extract<SidebarRequest, { kind: "unavailable" }>).provider, "gitlab");
      assert.equal(threadFilterState(thread("t", "e"), new Map([["e", status]])), undefined);
    }
    const cold = resolveRequests([{ environmentId: "e" }], { error, data: {} }, github).get("e")!;
    assert.equal(cold.kind, "unavailable");
    assert.equal(requestFilterState(cold), undefined);
    const hub = resolveRequests([{ environmentId: "e" }], { error, data: {} }, { error: null, data: { e: githubRow("open") } }).get("e")!;
    assert.equal(available(hub).provider, "github");
  }
});

test("only a missing plugin, a missing method or a disabled plugin counts as Pull Requests being absent", () => {
  const absent = (error: unknown) => pluginAbsent(error, "pull-requests");
  assert.equal(absent(rpcError("handler_error", 404, 'unknown plugin "pull-requests"')), true);
  assert.equal(absent(rpcError("handler_error", 503, 'plugin "pull-requests" is not running (status: disabled)')), true);
  assert.equal(absent(rpcError("handler_error", 503, 'plugin "pull-requests" is not running (status: disabled \u2014 turned off in settings)')), true);
  assert.equal(absent(rpcError("unknown_method", 404, 'plugin "pull-requests" has no rpc method "changeRequests"')), true);
  assert.equal(absent(new Error('unknown plugin "pull-requests"')), false);
  assert.equal(absent(rpcError("handler_error", 404, 'unknown plugin "dependency"')), false);
  assert.equal(absent(rpcError("unknown_method", 404, 'plugin "dependency" has no rpc method "changeRequests"')), false);
  assert.equal(absent(rpcError("handler_error", 503, 'plugin "pull-requests" is not running (status: disabledish)')), false);
  assert.equal(absent(rpcError("handler_error", 503, 'plugin "dependency" is not running (status: disabled)')), false);
  assert.equal(absent(rpcError("not_found", 404, "environment not found")), false);
  assert.equal(absent(rpcError("handler_error", 500, 'unknown plugin "pull-requests"')), false);
  assert.equal(absent("timeout"), false);
  assert.equal(absent(null), false);
  assert.equal(pluginAbsent(rpcError("handler_error", 404, 'unknown plugin "bb--github-pr-status"'), "bb--github-pr-status"), true);
});

test("copy link keeps an operational failure distinct from a missing Pull Requests plugin", async () => {
  const fake = (pullRequests: () => unknown) => async (args: { pluginId: string }) =>
    args.pluginId === "pull-requests" ? pullRequests() : { e: { outcome: "absent" } };
  const timedOut = await readRequestOnce(fake(() => { throw rpcError("transport_error", undefined, "network timeout"); }), "e", "feature");
  assert.equal(timedOut.kind, "unavailable");
  assert.equal(requestFilterState(timedOut), undefined);
  const missing = await readRequestOnce(fake(() => { throw rpcError("handler_error", 404, 'unknown plugin "pull-requests"'); }), "e", "feature");
  assert.deepEqual(missing, { kind: "absent", provider: "github" });
  const lab = await readRequestOnce(fake(() => ({ e: { outcome: "absent", provider: "gitlab", environmentBranch: "feature" } })), "e", "feature");
  assert.deepEqual(lab, { kind: "absent", provider: "gitlab" });
});

test("GitHub's absent answer never establishes absence on a forge Pull Requests couldn't identify", () => {
  const unsupported: ChangeRequestRow = { outcome: "unavailable", provider: null, reason: "unsupportedHost", message: "git.corp.example isn't GitHub or a known GitLab instance.", environmentBranch: "feature" };
  const coldOffline: ChangeRequestRow = { outcome: "unavailable", provider: null, reason: "hostOffline", message: "Laptop is offline", environmentBranch: "feature" };
  for (const cached of [unsupported, coldOffline]) {
    const status = resolveRequest(row(cached), row({ outcome: "absent" }), "feature");
    assert.equal(status.kind, "unavailable");
    assert.equal((status as Extract<SidebarRequest, { kind: "unavailable" }>).provider, null);
    assert.equal(requestFilterState(status), undefined);
    assert.equal(projectRequestSummary([status]).known, false);
  }
  const statuses = resolveRequests([{ environmentId: "corp", branch: "feature" }], { error: null, data: { corp: unsupported } }, { error: null, data: { corp: { outcome: "absent" } } });
  const kept = filterOrdinaryThreads([thread("t-corp", "corp")], { ...DEFAULT_SIDEBAR_VIEW, prFilter: ["open"] }, {
    now: 0,
    bypass: () => false,
    prStateOf: (entry) => threadFilterState(entry, statuses),
  });
  assert.deepEqual(kept.map((entry) => entry.id), ["t-corp"]);
  const none = filterOrdinaryThreads([thread("t-corp", "corp")], { ...DEFAULT_SIDEBAR_VIEW, prFilter: ["none"] }, {
    now: 0,
    bypass: () => false,
    prStateOf: (entry) => threadFilterState(entry, statuses),
  });
  assert.deepEqual(none.map((entry) => entry.id), ["t-corp"]);
  assert.deepEqual(resolveRequest(row<ChangeRequestRow>({ outcome: "absent", provider: null }), row({ outcome: "absent" })), { kind: "absent", provider: null });
});

test("delayed BB branch metadata shows nothing until the sidebar and Pull Requests agree on the branch", () => {
  const forNew: ChangeRequestRow = { outcome: "available", changeRequest: mergeRequest({}, 2), environmentBranch: "new" };
  assert.deepEqual(resolveRequest(row(forNew), MISSING, "old"), { kind: "loading" });
  assert.equal(available(resolveRequest(row(forNew), MISSING, "new")).label, "!2");
  const forOld: ChangeRequestRow = { outcome: "available", changeRequest: mergeRequest({}, 1), environmentBranch: "old" };
  const failedStale = resolveRequest({ status: "failed", message: "timeout", row: forOld }, row({ outcome: "absent" }), "new");
  assert.equal(failedStale.kind, "unavailable");
  assert.equal(requestFilterState(failedStale), undefined);
});

const NESTED_FAILURE = 'plugin "pull-requests" is not running (status: error \u2014 HTTP 404: unknown plugin "dependency")';

test("a failed Pull Requests whose detail mentions another plugin's absence keeps the GitLab identity", () => {
  const error = rpcError("handler_error", 503, NESTED_FAILURE);
  assert.equal(pluginAbsent(error, "pull-requests"), false);
  const cached: ChangeRequestRow = { outcome: "available", changeRequest: mergeRequest(), environmentBranch: "feature" };
  const statuses = resolveRequests([{ environmentId: "e", branch: "feature" }], { error, data: { e: cached } }, { error: null, data: { e: { outcome: "absent" } } });
  const status = statuses.get("e")!;
  assert.equal(status.kind, "unavailable");
  assert.equal((status as Extract<SidebarRequest, { kind: "unavailable" }>).provider, "gitlab");
  const none = filterOrdinaryThreads([thread("t-e", "e")], { ...DEFAULT_SIDEBAR_VIEW, prFilter: ["open"] }, {
    now: 0,
    bypass: () => false,
    prStateOf: (entry) => threadFilterState(entry, statuses),
  });
  assert.deepEqual(none.map((entry) => entry.id), ["t-e"]);
});

test("copy link treats the same nested failure as Pull Requests failing, not missing", async () => {
  const status = await readRequestOnce(
    async (args) => {
      if (args.pluginId === "pull-requests") throw rpcError("handler_error", 503, NESTED_FAILURE);
      return { e: { outcome: "absent" } };
    },
    "e",
    "feature",
  );
  assert.equal(status.kind, "unavailable");
  assert.equal(requestFilterState(status), undefined);
});

test("copy link's SDK errors carry an HTTP status prefix, and only the queried plugin's own absence falls back to GitHub", async () => {
  const absent = (error: unknown) => pluginAbsent(error, "pull-requests");
  assert.equal(absent(rpcError("handler_error", 404, 'HTTP 404: unknown plugin "pull-requests"')), true);
  assert.equal(absent(rpcError("handler_error", 503, 'HTTP 503: plugin "pull-requests" is not running (status: disabled)')), true);
  assert.equal(absent(rpcError("unknown_method", 404, 'HTTP 404: plugin "pull-requests" has no rpc method "changeRequests"')), true);
  assert.equal(absent(rpcError("handler_error", 503, `HTTP 503: ${NESTED_FAILURE}`)), false);
  assert.equal(absent(rpcError("handler_error", 404, 'HTTP 503: unknown plugin "pull-requests"')), false);
  assert.equal(absent(rpcError("handler_error", 404, 'HTTP 404: HTTP 404: unknown plugin "pull-requests"')), false);
  const viaCopyLink = (error: unknown) =>
    readRequestOnce(async (args) => {
      if (args.pluginId === "pull-requests") throw error;
      return { e: { outcome: "absent" } };
    }, "e", "feature");
  assert.deepEqual(await viaCopyLink(rpcError("handler_error", 404, 'HTTP 404: unknown plugin "pull-requests"')), { kind: "absent", provider: "github" });
  assert.deepEqual(await viaCopyLink(rpcError("handler_error", 503, 'HTTP 503: plugin "pull-requests" is not running (status: disabled)')), { kind: "absent", provider: "github" });
  assert.equal((await viaCopyLink(rpcError("handler_error", 503, `HTTP 503: ${NESTED_FAILURE}`))).kind, "unavailable");
});
