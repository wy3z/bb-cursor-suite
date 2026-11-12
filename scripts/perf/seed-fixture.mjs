#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_BB_APP,
  DEFAULT_BB_CLI,
  DEFAULT_SNAPSHOT,
  HOME,
  SERVER_PORT,
  SERVER_URL,
  bb,
  cliEnv,
  sleep,
  startBbApp,
  stopBbApp,
  waitForHttp,
  waitForPortFree,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const bbApp = resolve(args.app ?? DEFAULT_BB_APP);
const bbCli = resolve(args.cli ?? DEFAULT_BB_CLI);
const snapshot = resolve(args.snapshot ?? DEFAULT_SNAPSHOT);
const staging = resolve(args.staging ?? join(HOME, "perf/fixture/staging"));
const fixtureRepo = resolve(args.repo ?? join(HOME, "perf/fixture/repo"));
const projectName = "Perf Fixture";
const boardPrefix = "FIX";
const longTitles = Array.from({ length: 5 }, (_, i) => `Fixture long thread ${String(i + 1).padStart(2, "0")}`);
const shortTitles = Array.from({ length: 25 }, (_, i) => `Fixture short thread ${String(i + 1).padStart(2, "0")}`);

await waitForPortFree(SERVER_PORT);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
rmSync(snapshot, { recursive: true, force: true });
mkdirSync(dirname(snapshot), { recursive: true });

seedRepo(fixtureRepo);

const logPath = join(dirname(snapshot), "seed-bb.log");
const child = startBbApp(bbApp, staging, logPath);
let serverPid;
try {
  await waitForHttp(SERVER_URL, 120000);
  await sleep(1000);
  bb(bbCli, ["plugin", "install", "builtin:tasks", "--yes"]);
  const project = createProject(bbCli);
  const board = createBoard(bbCli, project.id);
  createTasks(bbCli, board);
} finally {
  await stopBbApp(child, staging);
}

insertThreads(join(staging, "bb.db"));

const warm = startBbApp(bbApp, staging, logPath);
try {
  await waitForHttp(SERVER_URL, 120000);
  await sleep(45000);
} finally {
  await stopBbApp(warm, staging);
}

rmSync(snapshot, { recursive: true, force: true });
execFileSync("cp", ["-a", staging, snapshot]);
console.log(
  JSON.stringify(
    {
      snapshot,
      fixtureRepo,
      longThreads: longTitles.length,
      shortThreads: shortTitles.length,
      tasks: 100,
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

function seedRepo(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  const git = (gitArgs) => execFileSync("git", gitArgs, { cwd: path, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "user.name", "Perf Fixture"]);
  for (let i = 1; i <= 20; i++) {
    writeFileSync(join(path, `module-${String(i).padStart(2, "0")}.ts`), `export const value = ${i};\n`);
  }
  writeFileSync(join(path, "README.md"), "# Perf fixture\n\nFake repository for BB performance runs.\n");
  git(["add", "."]);
  git(["commit", "-qm", "fixture"]);
}

function createProject(cli) {
  const listed = JSON.parse(bb(cli, ["project", "list", "--json"]));
  const existing = listed.find((project) => project.name === projectName);
  if (existing) return existing;
  return JSON.parse(bb(cli, ["project", "create", "--name", projectName, "--root", fixtureRepo, "--json"]));
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

function insertThreads(dbPath) {
  const db = new DatabaseSync(dbPath);
  const projectRow = db.prepare("select id from projects where name = ?").get(projectName);
  if (!projectRow) throw new Error("Fixture project missing from database");
  const now = Date.now();
  const insertThread = db.prepare(
    "insert into threads(id, project_id, environment_id, provider_id, title, title_fallback, status, pinned_at, pin_sort_key, latest_attention_at, created_at, updated_at, visibility, parent_notifications, status_changed_at) values(?, ?, null, 'codex', ?, ?, 'idle', ?, ?, ?, ?, ?, 'visible', 'auto', ?)",
  );
  const insertEvent = db.prepare(
    "insert into events(id, thread_id, scope_kind, turn_id, sequence, type, item_kind, data, created_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.exec("begin");
  const definitions = [
    ...longTitles.map((title, i) => ({ title, kind: "long", turns: 100, index: i + 1, pinned: true })),
    ...shortTitles.map((title, i) => ({ title, kind: "short", turns: 4, index: i + 1, pinned: i < 5 })),
  ];
  let global = 0;
  for (const definition of definitions) {
    global++;
    const threadId = `thr_perf${String(global).padStart(8, "0")}`;
    const created = now - global * 60000;
    const pinned = definition.pinned ? now - global * 1000 : null;
    const pinSort = definition.pinned ? String(global).padStart(6, "0") : null;
    insertThread.run(
      threadId,
      projectRow.id,
      definition.title,
      definition.title,
      pinned,
      pinSort,
      created,
      created,
      created,
      created,
    );
    let sequence = 1;
    const emit = (type, data, itemKind = null, turnId = null, at = created) => {
      insertEvent.run(
        `ev_${threadId}_${sequence}`,
        threadId,
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
            cwd: fixtureRepo,
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
