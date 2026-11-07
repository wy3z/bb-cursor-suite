import assert from "node:assert/strict";
import { test } from "node:test";
import { OPEN_CHANGE_REQUEST_EVENT, type ChangeRequest, type ChangeRequestRow } from "@wy3z/bb-suite/change-requests";
import { gitLabRead, requestOpenChangeRequest } from "./change-requests";

const mergeRequest: ChangeRequest = {
  identity: {
    provider: "gitlab",
    instance: "https://gitlab.com",
    projectPath: "group/sub/project",
    number: 12,
    url: "https://gitlab.com/group/sub/project/-/merge_requests/12",
    projectId: 77,
  },
  title: "Ship it",
  state: "open",
  ci: { state: "failed" },
  sourceBranch: "feature",
  targetBranch: "main",
  updatedAt: null,
  fetchedAt: "2026-11-07T00:00:00.000Z",
  connection: "glab:host1",
};

test("a GitLab MR from Pull Requests is shown", () => {
  assert.deepEqual(gitLabRead({ outcome: "available", changeRequest: mergeRequest }), { kind: "gitlab", changeRequest: mergeRequest });
});

test("a GitLab auth or ambiguity failure shows no mark and never falls back to GitHub", () => {
  const rows: ChangeRequestRow[] = [
    { outcome: "unavailable", provider: "gitlab", reason: "authentication", message: "sign in" },
    { outcome: "unavailable", provider: "gitlab", reason: "ambiguous", message: "two", candidates: 2 },
    { outcome: "absent", provider: "gitlab" },
  ];
  for (const row of rows) assert.deepEqual(gitLabRead(row), { kind: "gitlab", changeRequest: null });
});

test("GitHub, unknown providers, loading and a missing Pull Requests plugin keep the builtin GitHub path", () => {
  const github: ChangeRequestRow = {
    outcome: "available",
    changeRequest: { ...mergeRequest, identity: { provider: "github", instance: "https://github.com", projectPath: "o/r", number: 1, url: "https://github.com/o/r/pull/1" } },
  };
  assert.deepEqual(gitLabRead(github), { kind: "notGitLab" });
  assert.deepEqual(gitLabRead({ outcome: "unavailable", provider: null, reason: "unsupportedHost", message: "x" }), { kind: "notGitLab" });
  assert.deepEqual(gitLabRead({ outcome: "absent", provider: "github" }), { kind: "notGitLab" });
  assert.deepEqual(gitLabRead(undefined), { kind: "notGitLab" });
});

test("opening dispatches the shared cancelable event with the connection and thread", () => {
  const target = new EventTarget();
  let seen: unknown = null;
  target.addEventListener(OPEN_CHANGE_REQUEST_EVENT, (event) => {
    seen = (event as CustomEvent).detail;
    event.preventDefault();
  });
  assert.equal(requestOpenChangeRequest(target, mergeRequest, "thr_abc"), true);
  assert.deepEqual(seen, { url: mergeRequest.identity.url, connection: "glab:host1", threadId: "thr_abc" });
});

test("without a Pull Requests handler the caller opens the URL itself", () => {
  assert.equal(requestOpenChangeRequest(new EventTarget(), mergeRequest, null), false);
});
