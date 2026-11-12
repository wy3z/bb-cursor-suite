#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_BB_APP,
  DEFAULT_BB_CLI,
  HOME,
  SERVER_PORT,
  SERVER_URL,
  bb,
  sleep,
  startBbApp,
  stopBbApp,
  waitForHttp,
  waitForPortFree,
} from "./lib.mjs";

const require = createRequire(import.meta.url);
const { prs } = require("./fakegh/data.cjs");

const args = parseArgs(process.argv.slice(2));
const bbApp = resolve(args.app ?? DEFAULT_BB_APP);
const bbCli = resolve(args.cli ?? DEFAULT_BB_CLI);
const perfRoot = resolve(process.env.PERF_ROOT ?? join(HOME, "perf"));
const fixtureRoot = resolve(args.fixture ?? join(perfRoot, "fixture"));
const snapshot = resolve(args.snapshot ?? join(fixtureRoot, "snapshot"));
const staging = resolve(args.staging ?? join(fixtureRoot, "staging"));
const reposRoot = join(fixtureRoot, "repos");
const worktreesRoot = join(fixtureRoot, "worktrees");
const gitconfigPath = join(fixtureRoot, "gitconfig");
const projectDefs = [
  { projectName: "acme/web", repoName: "acme-web", gitSlug: "acme/web" },
  { projectName: "acme/api", repoName: "acme-api", gitSlug: "acme/api" },
  { projectName: "acme/orbit", repoName: "acme-orbit", gitSlug: "acme/orbit" },
];
const boardPrefix = "FIX";
const longTitles = Array.from({ length: 5 }, (_, i) => `Fixture long thread ${String(i + 1).padStart(2, "0")}`);
const shortTitles = Array.from({ length: 25 }, (_, i) => `Fixture short thread ${String(i + 1).padStart(2, "0")}`);
const fillerTitles = Array.from({ length: 270 }, (_, i) => `Fixture filler thread ${String(i + 1).padStart(3, "0")}`);

await waitForPortFree(SERVER_PORT);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
rmSync(snapshot, { recursive: true, force: true });
mkdirSync(dirname(snapshot), { recursive: true });

seedRepos();

const logPath = join(dirname(snapshot), "seed-bb.log");
const child = startBbApp(bbApp, staging, logPath);
let projectIds = {};
try {
  await waitForHttp(SERVER_URL, 120000);
  await sleep(1000);
  bb(bbCli, ["plugin", "install", "builtin:tasks", "--yes"]);
  projectIds = createProjects(bbCli);
  const board = createBoard(bbCli, projectIds["acme/web"]);
  createTasks(bbCli, board);
} finally {
  await stopBbApp(child, staging);
}

const seeder = prepareEnvironments(join(staging, "bb.db"));
insertThreads(join(staging, "bb.db"), seeder);

const warm = startBbApp(bbApp, staging, logPath);
try {
  await waitForHttp(SERVER_URL, 120000);
  await sleep(60000);
} finally {
  await stopBbApp(warm, staging);
}

rmSync(snapshot, { recursive: true, force: true });
execFileSync("cp", ["-a", staging, snapshot]);
writeFileSync(join(snapshot, "fixture.json"), `${JSON.stringify({ fixtureVersion: 2 }, null, 2)}\n`);
const db = new DatabaseSync(join(snapshot, "bb.db"));
const counts = {
  projects: db.prepare("select count(*) c from projects where kind = 'standard'").get().c,
  threads: db.prepare("select count(*) c from threads").get().c,
  environments: db.prepare("select count(*) c from environments").get().c,
  remoteUrls: db.prepare("select name, git_remote_url from projects where kind = 'standard'").all(),
};
db.close();
console.log(
  JSON.stringify(
    {
      snapshot,
      fixtureRoot,
      fixtureVersion: 2,
      projects: projectDefs.map((project) => project.projectName),
      longThreads: longTitles.length,
      shortThreads: shortTitles.length,
      fillerThreads: fillerTitles.length,
      tasks: 100,
      counts,
    },
    null,
    2,
  ),
);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    out[arg.slice(2)] = argv[++i];
  }
  return out;
}

function git(cwd, gitArgs, env) {
  return execFileSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: gitconfigPath, ...env },
  });
}

function seedRepos() {
  rmSync(reposRoot, { recursive: true, force: true });
  rmSync(worktreesRoot, { recursive: true, force: true });
  mkdirSync(reposRoot, { recursive: true });
  const config = [];
  for (const definition of projectDefs) {
    const repo = join(reposRoot, definition.repoName);
    const bare = `${repo}.origin.git`;
    config.push(`[url "${bare}"]\n\tinsteadOf = https://github.com/${definition.gitSlug}.git`);
  }
  writeFileSync(gitconfigPath, `${config.join("\n")}\n`);
  for (const definition of projectDefs) {
    seedRepo(definition);
  }
}

function seedRepo(definition) {
  const repo = join(reposRoot, definition.repoName);
  const bare = `${repo}.origin.git`;
  rmSync(repo, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "user.name", "Perf Fixture"]);
  writeRepoFiles(repo, definition.repoName);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture"]);
  git(repo, ["init", "--bare", "-q", bare]);
  git(repo, ["remote", "add", "origin", `https://github.com/${definition.gitSlug}.git`]);
  git(repo, ["remote", "add", "github", `ssh://git@github.com/${definition.gitSlug}.git`]);
  const repoPrs = prs.filter((pr) => pr.repo === definition.gitSlug);
  for (const pr of repoPrs) {
    createPrBranch(repo, pr);
  }
  git(repo, ["push", "-q", bare, "main", ...repoPrs.map((pr) => pr.head)]);
  git(repo, ["fetch", "-q", "origin"]);
}

function writeRepoFiles(repo, repoName) {
  const prefix = repoName.split("-")[1] ?? "app";
  for (let i = 1; i <= 12; i++) {
    const fileName = `module-${String(i).padStart(2, "0")}.ts`;
    writeFileSync(join(repo, fileName), `export const ${prefix}Value = ${i};\n`);
  }
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "index.ts"), `export * from "../module-01.ts";\n`);
  writeFileSync(join(repo, "README.md"), `# ${repoName}\n\nFake repository for BB performance runs.\n`);
}

function createPrBranch(repo, pr) {
  git(repo, ["branch", "-f", pr.head, "main"]);
  const worktree = join(reposRoot, `.pr-${pr.number}-${pr.head}`);
  rmSync(worktree, { recursive: true, force: true });
  git(repo, ["worktree", "add", "-q", worktree, pr.head]);
  const target = join(worktree, `pr-${pr.number}.txt`);
  writeFileSync(target, `${pr.title}\n`);
  git(worktree, ["add", "."]);
  git(worktree, ["commit", "-qm", `PR ${pr.number}: ${pr.title}`]);
  git(repo, ["worktree", "remove", "--force", worktree]);
}

function createProjects(cli) {
  const listed = JSON.parse(bb(cli, ["project", "list", "--json"]));
  const ids = {};
  for (const definition of projectDefs) {
    const repo = join(reposRoot, definition.repoName);
    const existing = listed.find((project) => project.name === definition.projectName);
    const project = existing ?? JSON.parse(bb(cli, ["project", "create", "--name", definition.projectName, "--root", repo, "--json"]));
    ids[definition.projectName] = project.id;
  }
  return ids;
}

function createBoard(cli, projectId) {
  const listed = JSON.parse(bb(cli, ["tasks", "project", "list", "--json"]));
  const existing = listed.projects?.find((project) => project.prefix === boardPrefix);
  if (existing) return existing;
  return JSON.parse(
    bb(cli, [
      "tasks",
      "project",
      "create",
      "--name",
      "Fixture Board",
      "--prefix",
      boardPrefix,
      "--link-bb-project",
      projectId,
      "--json",
    ]),
  ).project;
}

function createTasks(cli, board) {
  const statuses = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"];
  const priorities = ["urgent", "high", "medium", "low", "none"];
  for (let i = 1; i <= 100; i++) {
    const title = `Fixture task ${String(i).padStart(3, "0")}`;
    const created = JSON.parse(
      bb(cli, [
        "tasks",
        "create",
        "--project",
        board.prefix ?? board.id,
        "--title",
        title,
        "--description",
        `Synthetic work item ${i} for the BB performance fixture.`,
        "--priority",
        priorities[i % priorities.length],
        "--json",
      ]),
    );
    if (i % 7 === 0) {
      bb(cli, ["tasks", "update", created.task.key, "--status", statuses[(i / 7) % statuses.length], "--json"]);
    }
  }
}

function prepareEnvironments(dbPath) {
  const db = new DatabaseSync(dbPath);
  const host = db.prepare("select id from hosts order by created_at limit 1").get();
  if (!host) throw new Error("Fixture host missing from database");
  for (const definition of projectDefs) {
    db.prepare("update projects set git_remote_url = ? where name = ?").run(`https://github.com/${definition.gitSlug}.git`, definition.projectName);
  }
  const byName = new Map(projectDefs.map((definition) => [definition.projectName, definition]));
  const measured = [];
  for (let i = 0; i < 5; i++) {
    measured.push({ title: longTitles[i], pr: prs[i], index: i + 1 });
  }
  for (let i = 0; i < 5; i++) {
    measured.push({ title: shortTitles[i], pr: prs[5 + i], index: 6 + i });
  }
  const environments = [];
  for (const item of measured) {
    const definition = byName.get(item.pr.repo);
    const threadId = threadIdForTitle(item.title);
    const path = join(worktreesRoot, `${threadId}-1`, definition.repoName);
    const repo = join(reposRoot, definition.repoName);
    rmSync(path, { recursive: true, force: true });
    mkdirSync(dirname(path), { recursive: true });
    git(repo, ["worktree", "add", "-q", path, item.pr.head]);
    environments.push(environmentRow(db, host.id, definition, threadId, path, item.pr.head));
  }
  for (let filler = 1; filler <= 40; filler++) {
    const title = fillerTitles[filler - 1];
    const definition = projectDefs[(filler - 1) % projectDefs.length];
    const threadId = threadIdForTitle(title);
    const path = join(worktreesRoot, `${threadId}-1`, definition.repoName);
    const repo = join(reposRoot, definition.repoName);
    const branch = `filler-${String(filler).padStart(3, "0")}`;
    rmSync(path, { recursive: true, force: true });
    mkdirSync(dirname(path), { recursive: true });
    git(repo, ["worktree", "add", "-q", "-b", branch, path, "main"]);
    environments.push(environmentRow(db, host.id, definition, threadId, path, branch));
  }
  db.exec("begin");
  const insert = db.prepare(
    "insert into environments(id, project_id, host_id, path, is_git_repo, is_worktree, branch_name, default_branch, merge_base_branch, status, created_at, updated_at, environment_provider_id, environment_provider_plugin_id, provider_owns_path, environment_provider_instance_key, environment_provider_selection) values(?, ?, ?, ?, 1, 1, ?, 'main', 'origin/main', 'ready', ?, ?, 'git-worktree', 'environment-git-worktree', 1, ?, ?)",
  );
  const now = Date.now();
  const mapping = new Map();
  for (const environment of environments) {
    insert.run(
      environment.id,
      environment.projectId,
      environment.hostId,
      environment.path,
      environment.branch,
      now,
      now,
      environment.instanceKey,
      environment.selection,
    );
    mapping.set(environment.threadId, environment);
  }
  db.exec("commit");
  db.close();
  return { host, mapping };
}

function environmentRow(db, hostId, definition, threadId, path, branch) {
  const project = db.prepare("select id from projects where name = ?").get(definition.projectName);
  if (!project) throw new Error(`Missing project ${definition.projectName}`);
  return {
    id: `env_${threadId}`,
    projectId: project.id,
    hostId,
    threadId,
    path,
    branch,
    instanceKey: `${threadId}-1`,
    selection: JSON.stringify({
      machine: { type: "existing", hostId },
      inputs: { branch: { kind: "named", name: "main" } },
    }),
  };
}

function threadIdForTitle(title) {
  const all = [...longTitles, ...shortTitles, ...fillerTitles];
  return `thr_perf${String(all.indexOf(title) + 1).padStart(8, "0")}`;
}

function insertThreads(dbPath, seeder) {
  const db = new DatabaseSync(dbPath);
  const projects = new Map(
    db.prepare("select id, name from projects where kind = 'standard'").all().map((row) => [row.name, row.id]),
  );
  const webProject = projects.get("acme/web");
  if (!webProject) throw new Error("Fixture project missing from database");
  const now = Date.now();
  const day = 86400000;
  const insertThread = db.prepare(
    "insert into threads(id, project_id, environment_id, provider_id, title, title_fallback, status, parent_thread_id, pinned_at, pin_sort_key, latest_attention_at, created_at, updated_at, visibility, parent_notifications, status_changed_at) values(?, ?, ?, 'codex', ?, ?, 'idle', ?, ?, ?, ?, ?, ?, 'visible', 'auto', ?)",
  );
  const insertEvent = db.prepare(
    "insert into events(id, thread_id, environment_id, scope_kind, turn_id, sequence, type, item_kind, data, created_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const definitions = [];
  const measuredPrForTitle = new Map();
  for (let i = 0; i < 5; i++) measuredPrForTitle.set(longTitles[i], prs[i]);
  for (let i = 0; i < 5; i++) measuredPrForTitle.set(shortTitles[i], prs[5 + i]);
  for (const title of longTitles) {
    const pr = measuredPrForTitle.get(title);
    definitions.push({
      title,
      kind: "long",
      turns: 100,
      projectId: projects.get(pr.repo),
      environmentId: `env_${threadIdForTitle(title)}`,
      pinned: true,
      createdAt: now - (definitions.length + 1) * 60000,
    });
  }
  for (let i = 0; i < shortTitles.length; i++) {
    const title = shortTitles[i];
    const pr = measuredPrForTitle.get(title);
    definitions.push({
      title,
      kind: "short",
      turns: 4,
      projectId: pr ? projects.get(pr.repo) : webProject,
      environmentId: pr ? `env_${threadIdForTitle(title)}` : null,
      pinned: i < 5,
      createdAt: now - (definitions.length + 1) * 60000,
    });
  }
  for (let i = 0; i < fillerTitles.length; i++) {
    const title = fillerTitles[i];
    const definition = projectDefs[i % projectDefs.length];
    const created = now - Math.round(((i + 1) / (fillerTitles.length + 1)) * 30 * day);
    definitions.push({
      title,
      kind: "filler",
      turns: 2,
      projectId: projects.get(definition.projectName),
      environmentId: i < 40 ? `env_${threadIdForTitle(title)}` : null,
      parentTitle: (i + 1) % 3 === 0 ? fillerTitles[i - 1] : null,
      pinned: false,
      createdAt: created,
      updatedAt: Math.min(now, created + 3600000),
    });
  }

  const threadIds = new Map();
  for (const definition of definitions) {
    threadIds.set(definition.title, threadIdForTitle(definition.title));
  }

  db.exec("begin");
  let global = 0;
  for (const definition of definitions) {
    global++;
    const threadId = threadIds.get(definition.title);
    const created = definition.createdAt ?? now - global * 60000;
    const updated = definition.updatedAt ?? created;
    const pinned = definition.pinned ? now - global * 1000 : null;
    const pinSort = definition.pinned ? String(global).padStart(6, "0") : null;
    insertThread.run(
      threadId,
      definition.projectId,
      definition.environmentId,
      definition.title,
      definition.title,
      definition.parentTitle ? threadIds.get(definition.parentTitle) : null,
      pinned,
      pinSort,
      updated,
      created,
      updated,
      created,
    );
    let sequence = 1;
    const emit = (type, data, itemKind = null, turnId = null, at = created) => {
      insertEvent.run(
        `ev_${threadId}_${sequence}`,
        threadId,
        definition.environmentId,
        turnId ? "turn" : "thread",
        turnId,
        sequence,
        type,
        itemKind,
        JSON.stringify(data),
        at,
      );
      sequence++;
    };
    emit("thread/started", {});
    for (let turn = 1; turn <= definition.turns; turn++) {
      const turnId = `turn_${threadId}_${turn}`;
      const itemPrefix = `${threadId}_${turn}`;
      emit("turn/started", { providerThreadId: threadId }, null, turnId);
      emit(
        "item/completed",
        {
          providerThreadId: threadId,
          item: {
            type: "userMessage",
            id: `user_${itemPrefix}`,
            content: [{ type: "text", text: `Work item ${turn} for ${definition.title}. Read the module and update it.` }],
          },
        },
        "userMessage",
        turnId,
      );
      emit(
        "item/completed",
        {
          providerThreadId: threadId,
          item: {
            type: "reasoning",
            id: `reasoning_${itemPrefix}`,
            summary: [`Inspecting module ${turn}`],
            content: [`The change touches module-${String(turn % 20).padStart(2, "0")}.ts and its tests.`],
          },
        },
        "reasoning",
        turnId,
      );
      emit(
        "item/completed",
        {
          providerThreadId: threadId,
          item: {
            type: "commandExecution",
            id: `command_${itemPrefix}`,
            command: `rg "value = ${turn}" src`,
            cwd: seeder.mapping.get(threadId)?.path ?? join(reposRoot, "acme-web"),
            status: "completed",
            approvalStatus: null,
            aggregatedOutput: `src/module-${String(turn % 20).padStart(2, "0")}.ts:1:export const value = ${turn};`,
            exitCode: 0,
            durationMs: 18,
          },
        },
        "commandExecution",
        turnId,
      );
      emit(
        "item/completed",
        {
          providerThreadId: threadId,
          item: {
            type: "toolCall",
            id: `tool_${itemPrefix}`,
            server: "filesystem",
            tool: "read_file",
            arguments: { path: `src/module-${String(turn % 20).padStart(2, "0")}.ts` },
            status: "completed",
            result: `export const value = ${turn};`,
            durationMs: 7,
          },
        },
        "toolCall",
        turnId,
      );
      if (turn % 3 === 0) {
        emit(
          "item/completed",
          {
            providerThreadId: threadId,
            item: {
              type: "fileChange",
              id: `file_${itemPrefix}`,
              changes: [
                {
                  path: `src/module-${String(turn % 20).padStart(2, "0")}.ts`,
                  kind: "update",
                  diff: `-export const value = ${turn - 1};\n+export const value = ${turn};`,
                },
              ],
              status: "completed",
              approvalStatus: null,
            },
          },
          "fileChange",
          turnId,
        );
      }
      const final = turn === definition.turns;
      const text = [
        `Updated module ${turn} for ${definition.title}.`,
        "",
        "```ts",
        `export function feature${turn}(input: string) {`,
        `  return input.repeat(${turn});`,
        "}",
        "```",
        "",
        final ? `END-OF-TRANSCRIPT ${definition.title}` : "Next I will run the tests.",
      ].join("\n");
      emit(
        "item/completed",
        {
          providerThreadId: threadId,
          item: { type: "agentMessage", id: `agent_${itemPrefix}`, text },
        },
        "agentMessage",
        turnId,
      );
      emit("turn/completed", { providerThreadId: threadId, status: "completed" }, null, turnId, created + turn);
    }
  }
  db.prepare("insert into app_settings_values(key, value, updated_at) values('onboardingCompletedAt', ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at").run(JSON.stringify(new Date(now).toISOString()), now);
  db.exec("commit");
  db.exec("pragma wal_checkpoint(truncate)");
  db.close();
}
