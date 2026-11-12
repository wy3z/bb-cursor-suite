const fs = require("fs");
const { execFileSync } = require("child_process");
const { viewer, prs, ago } = require("./data.cjs");
const args = process.argv.slice(2);
let input = "";
if (args.includes("--input")) { const src = args[args.indexOf("--input") + 1]; try { input = fs.readFileSync(src === "-" ? 0 : src, "utf8"); } catch {} }
const log = (extra) => { try { if (process.env.FAKEGH_LOG) fs.appendFileSync(process.env.FAKEGH_LOG, JSON.stringify({ t: new Date().toISOString(), cwd: process.cwd(), args, ...extra }) + "\n"); } catch {} };
log({ start: true });
const out = (v) => { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); process.exit(0); };
const fail = (msg, code = 1) => { log({ fail: msg }); process.stderr.write(msg + "\n"); process.exit(code); };
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const byUrl = (u) => prs.find((p) => p.url === String(u).replace(/\/$/, ""));
const byRepoNum = (repo, n) => prs.find((p) => p.repo === repo && p.number === Number(n));
const currentBranch = () => { try { return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(); } catch { return ""; } };
const login = (l) => ({ login: l, id: 1000001, email: null, name: { adapark: "Ada Park", theobrandt: "Theo Brandt", rinokafor: "Rin Okafor" }[l] ?? l, is_bot: false });
const rollupState = (p) => p.ci;
const LOCAL = { "acme/web": "acme-web", "acme/api": "acme-api", "acme/orbit": "acme-orbit" };
const localRepo = (p) => require("path").join(process.env.FAKEGH_REPOS || "", LOCAL[p.repo] || "x");
const gitOut = (p, a) => { try { return execFileSync("git", ["-C", localRepo(p), ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
const realBranch = (p) => gitOut(p, ["rev-parse", "--verify", "-q", "refs/heads/" + p.head]) !== null;
const realFiles = (p) => {
  if (!realBranch(p)) return null;
  const out = gitOut(p, ["diff", "--numstat", "main..." + p.head]);
  if (!out) return null;
  return out.trim().split("\n").filter(Boolean).map((l) => { const [a, d, path] = l.split("\t"); return [path, Number(a) || 0, Number(d) || 0]; });
};
for (const p of prs) { const sha = realBranch(p) ? (gitOut(p, ["rev-parse", "refs/heads/" + p.head]) || "").trim() : ""; if (sha) p.oid = sha; const f = realFiles(p); if (f && f.length) { p.files = f; p.add = f.reduce((n, x) => n + x[1], 0); p.del = f.reduce((n, x) => n + x[2], 0); } }
const field = (p, f) => {
  switch (f) {
    case "number": return p.number;
    case "title": return p.title;
    case "url": return p.url;
    case "state": return p.state;
    case "isDraft": return p.isDraft;
    case "reviewDecision": return p.review;
    case "mergeable": return p.mergeable;
    case "mergeStateStatus": return p.mergeable === "CONFLICTING" ? "DIRTY" : p.ci === "FAILURE" ? "UNSTABLE" : "CLEAN";
    case "headRefOid": return p.oid;
    case "headRefName": return p.head;
    case "baseRefName": return "main";
    case "statusCheckRollup": return p.checks.map((c) => ({ ...c, startedAt: ago(p.updated + 4), completedAt: ago(p.updated + 1), workflowName: "ci" }));
    case "author": return login(p.author);
    case "createdAt": return ago(p.created);
    case "updatedAt": return ago(p.updated);
    case "closedAt": return p.state === "OPEN" ? null : ago(p.updated);
    case "mergedAt": return p.state === "MERGED" ? ago(p.updated) : null;
    case "additions": return p.add;
    case "deletions": return p.del;
    case "changedFiles": return p.files.length;
    case "body": return p.body;
    case "files": return p.files.map(([path, additions, deletions]) => ({ path, additions, deletions }));
    case "comments": return p.comments.map((c, i) => ({ id: `IC_${p.number}_${i}`, author: login(c.author), body: c.body, createdAt: ago(c.at), url: `${p.url}#issuecomment-${p.number}${i}`, authorAssociation: "MEMBER" }));
    case "reviews": return p.reviews.map((r, i) => ({ id: `PRR_${p.number}_${i}`, author: login(r.author), body: r.body, state: r.state, submittedAt: ago(r.at) }));
    case "commits": return [{ oid: p.oid, messageHeadline: p.title, messageBody: "", authoredDate: ago(p.updated + 2), committedDate: ago(p.updated + 2), authors: [{ login: p.author, name: login(p.author).name, email: "" }] }];
    case "labels": return [];
    case "assignees": return [];
    case "isCrossRepository": return false;
    case "headRepositoryOwner": return { login: p.repo.split("/")[0] };
    case "headRepository": return { name: p.repo.split("/")[1] };
    case "baseRepository": return { name: p.repo.split("/")[1], owner: { login: p.repo.split("/")[0] } };
    case "id": return `PR_${p.number}`;
    case "reviewRequests": return p.requested ? [{ login: viewer }] : [];
    case "latestReviews": return field(p, "reviews");
    default: return null;
  }
};
const project = (p, fields) => Object.fromEntries(fields.split(",").map((f) => [f, field(p, f)]));
const diffFor = (p) => (realBranch(p) && gitOut(p, ["diff", "main..." + p.head])) || p.files.map(([path, a, d]) => {
  const minus = Array.from({ length: Math.min(d, 6) }, (_, i) => `-  old line ${i + 1}`);
  const plus = Array.from({ length: Math.min(a, 10) }, (_, i) => `+  new line ${i + 1}`);
  return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,${minus.length + 2} +1,${plus.length + 2} @@\n context\n${[...minus, ...plus].join("\n")}\n context\n`;
}).join("");
const rollupNode = (p) => ({
  commit: { oid: p.oid },
  state: rollupState(p),
  contexts: {
    totalCount: p.checks.length,
    nodes: p.checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion || null, detailsUrl: c.detailsUrl })),
    checkRunCountsByState: Object.entries(p.checks.reduce((m, c) => { const s = c.status === "COMPLETED" ? c.conclusion : c.status; m[s] = (m[s] || 0) + 1; return m; }, {})).map(([state, count]) => ({ state, count })),
    statusContextCountsByState: [],
  },
});
const searchNode = (p) => ({
  author: { login: p.author }, headRefOid: p.oid, viewerDidAuthor: p.author === viewer,
  viewerLatestReviewRequest: p.requested ? { id: "RR_1" } : null,
  reviewRequests: { nodes: p.requested ? [{ id: "RR_1" }] : [], pageInfo: { hasNextPage: false } },
  statusCheckRollup: rollupNode(p), number: p.number, title: p.title, url: p.url, state: p.state, isDraft: p.isDraft,
  mergeable: p.mergeable, reviewDecision: p.review, createdAt: ago(p.created), updatedAt: ago(p.updated),
  additions: p.add, deletions: p.del, repository: { nameWithOwner: p.repo },
});

if (args[0] === "--version" || args[0] === "version") out("gh version 2.83.0 (2026-10-20)\n");
if (args[0] === "auth") {
  if (args[1] === "status") { process.stdout.write(`github.com\n  ✓ Logged in to github.com account ${viewer} (keyring)\n  - Active account: true\n`); process.exit(0); }
  if (args[1] === "token") out("demo-not-a-real-token\n");
}
if (args[0] === "api" && args[1] === "graphql") {
  let body = {};
  try { body = JSON.parse(input || "{}"); } catch {}
  const fIdx = args.indexOf("-f");
  const q = body.query || (args.find((a) => a.startsWith("query=")) || "").slice(6);
  const v = body.variables || {};
  if (/search\(/.test(q)) {
    const s = String(v.search || "");
    const repo = (s.match(/repo:(\S+)/) || [])[1] || `${v.owner}/${v.name}`;
    let list = prs.filter((p) => p.repo === repo && (/is:open/.test(s) ? p.state === "OPEN" : true));
    if (/author:@me/.test(s)) list = list.filter((p) => p.author === viewer);
    if (/review-requested:@me/.test(s)) list = list.filter((p) => p.requested);
    log({ ok: "search" });
    out({ data: { repository: { nameWithOwner: repo }, search: { issueCount: list.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: list.map(searchNode) } } });
  }
  if (/pullRequests\(headRefName:/.test(q)) {
    const data = {};
    const re = /(\w+):\s*repository\(owner:\s*"([^"]+)",\s*name:\s*"([^"]+)"\)\s*\{[\s\S]*?pullRequests\(headRefName:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(q))) {
      const [, alias, owner, name, head] = m;
      const list = prs.filter((x) => x.repo === `${owner}/${name}` && x.head === head);
      data[alias] = { defaultBranchRef: { name: "main" }, pullRequests: { nodes: list.map((x) => ({
        number: x.number, title: x.title, state: x.state, url: x.url, isDraft: x.isDraft, autoMergeRequest: null, isInMergeQueue: false,
        baseRefName: "main", headRefName: x.head, headRefOid: x.oid, updatedAt: ago(x.updated), reviewDecision: x.review,
        reviewRequests: { totalCount: x.requested ? 1 : 0 }, mergeStateStatus: field(x, "mergeStateStatus"), mergeable: x.mergeable,
        isCrossRepository: false, headRepositoryOwner: { login: owner },
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: x.checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion || null, detailsUrl: c.detailsUrl || null, startedAt: ago(x.updated + 3), checkSuite: { workflowRun: { runNumber: 41, event: "pull_request", workflow: { databaseId: 1 } } } })), pageInfo: { hasNextPage: false, endCursor: null } } } } }] },
      })) } };
    }
    log({ ok: "headRef" });
    out({ data: { ...data, rateLimit: { remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() } } });
  }
  if (/mergeCommitAllowed/.test(q)) out({ data: { repository: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false, viewerDefaultMergeMethod: "SQUASH" } } });
  const repoName = `${v.owner}/${v.name || v.repo}`;
  const p = v.number ? byRepoNum(repoName, v.number) : null;
  if (/reviewThreads/.test(q)) {
    const nodes = p && p.number === 142 ? [{ id: "PRRT_1", isResolved: true, isOutdated: false, path: "src/lib/money.ts", line: 4, originalLine: 4, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "PRRC_1", url: p.url, body: "Should this round half to even? Banks do.", createdAt: ago(80), author: { login: "theobrandt" }, viewerDidAuthor: false, replyTo: null }, { id: "PRRC_2", url: p.url, body: "Kept half-up to match the receipts; added a test that pins it.", createdAt: ago(70), author: { login: "adapark" }, viewerDidAuthor: true, replyTo: { id: "PRRC_1" } }] } }] : [];
    out({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } });
  }
  if (/node\(id:/.test(q)) out({ data: { node: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
  if (/SubscriptionPR/.test(q) && p) {
    out({ data: { repository: { pullRequest: { title: p.title, state: p.state, isDraft: p.isDraft, updatedAt: ago(p.updated), headRefOid: p.oid, reviewDecision: p.review, assignees: { nodes: [] }, labels: { nodes: [] }, comments: { totalCount: p.comments.length, nodes: p.comments.slice(-1).map((c) => ({ updatedAt: ago(c.at), author: { login: c.author } })) }, reviews: { totalCount: p.reviews.length, nodes: p.reviews.slice(-1).map((r) => ({ state: r.state, submittedAt: ago(r.at), author: { login: r.author } })) }, commits: { nodes: [{ commit: { statusCheckRollup: { state: p.ci } } }] } } } } });
  }
  if (/viewer\s*\{\s*login/.test(q) && /pullRequest\(number/.test(q) && p) {
    out({ data: { viewer: { login: viewer }, repository: { pullRequest: { ...searchNode(p), statusCheckRollup: rollupNode(p) } } } });
  }
  if (/viewer\s*\{\s*login\s*\}/.test(q) && !/repository/.test(q)) out({ data: { viewer: { login: viewer } } });
  fail("fakegh: unsupported graphql");
}
if (args[0] === "api") {
  const rest = args.slice(1); let path = "";
  for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith("-")) { if (["--hostname", "--method", "-X", "--input", "-H", "--header", "-f", "-F", "--jq", "-q"].includes(rest[i])) i++; continue; } path = rest[i]; break; }
  if (path === "user") out(login(viewer));
  if (/^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(path)) out({ id: 1, html_url: "https://github.com/acme/web" });
  fail("fakegh: unsupported api " + path);
}
if (args[0] === "pr") {
  const sub = args[1];
  const target = args[2] && !args[2].startsWith("-") ? args[2] : null;
  const repoFlag = flag("--repo") || flag("-R");
  const find = () => {
    if (target && /^https:/.test(target)) return byUrl(target);
    if (target && /^\d+$/.test(target)) return prs.find((p) => (!repoFlag || p.repo === repoFlag) && p.number === Number(target));
    const branch = target || currentBranch();
    return prs.find((p) => p.head === branch && (!repoFlag || p.repo === repoFlag));
  };
  if (sub === "view") {
    const p = find();
    if (!p) fail("no pull requests found for branch", 1);
    const q = flag("-q") || flag("--jq");
    if (q && /select\(\.state==\"OPEN\"\)/.test(q)) out(p.state === "OPEN" ? p.url + "\n" : "");
    if (q) out(String(field(p, q.replace(/^\./, ""))) + "\n");
    const fields = flag("--json");
    log({ ok: "view" });
    if (fields) out(project(p, fields));
    out(`${p.title} ${p.repo}#${p.number}\n`);
  }
  if (sub === "list") {
    const head = flag("--head");
    const state = (flag("--state") || "open").toUpperCase();
    let list = prs.filter((p) => (!repoFlag || p.repo === repoFlag) && (!head || p.head === head) && (state === "ALL" || p.state === state));
    const fields = flag("--json");
    if (fields) out(list.map((p) => project(p, fields)));
    out(list.map((p) => `${p.number}\t${p.title}\t${p.head}\t${p.state}`).join("\n") + "\n");
  }
  if (sub === "diff") { const p = find(); if (!p) fail("not found"); out(diffFor(p)); }
  if (sub === "checks") { const p = find(); if (!p) fail("not found"); out(p.checks.map((c) => `${c.name}\t${c.conclusion === "FAILURE" ? "fail" : c.status === "COMPLETED" ? "pass" : "pending"}\t1m2s\t${c.detailsUrl}`).join("\n") + "\n"); }
  if (sub === "create") { const head = flag("--head") || currentBranch(); const p = prs.find((x) => x.head === head); if (p) { log({ ok: "create" }); out(p.url + "\n"); } }
  if (["edit", "ready", "merge", "close", "reopen", "create", "comment"].includes(sub)) fail("fakegh: the demo is read-only");
}
if (args[0] === "repo" && args[1] === "view") {
  const fields = flag("--json");
  const r = args[2] && !args[2].startsWith("-") ? args[2] : "acme/web";
  if (fields) out(Object.fromEntries(fields.split(",").map((f) => [f, f === "nameWithOwner" ? r : f === "defaultBranchRef" ? { name: "main" } : f === "url" ? `https://github.com/${r}` : f === "name" ? r.split("/")[1] : f === "owner" ? { login: r.split("/")[0] } : null])));
}
fail("fakegh: unsupported");
