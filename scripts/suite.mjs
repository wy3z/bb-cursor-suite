import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tasks = { build: ["build"], typecheck: ["typecheck"], test: ["test"], check: ["typecheck", "test", "build"], reload: [] };
const timeouts = { build: 300, typecheck: 300, test: 300 };
const shared = { id: "suite-shared", dir: "packages/suite-shared" };
const tooling = { id: "suite-scripts", dir: "scripts", scripts: { test: "test" }, root: true };

function usage(code) {
  console.log("Usage: npm run suite -- <build|typecheck|test|check|reload> [--changed | --all | <id>...] [--base <ref>]");
  process.exit(code);
}

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function workspaces() {
  const plugins = readJson(".bb/plugins.json").plugins.map((entry) => ({ id: entry.name, dir: entry.source.replace(/^\.\//, "") }));
  return [shared, ...plugins].map((ws) => {
    const pkg = readJson(join(ws.dir, "package.json"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return { ...ws, scripts: pkg.scripts ?? {}, usesShared: "@wy3z/bb-suite" in deps && ws.id !== shared.id };
  }).concat(tooling);
}

function baseRef(explicit) {
  if (explicit) return explicit;
  for (const ref of ["origin/main", "main"]) {
    try {
      return git(["merge-base", "HEAD", ref]);
    } catch {}
  }
  return "HEAD";
}

function changedIds(all, base) {
  const files = new Set([
    ...git(["diff", "--name-only", base]).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ].filter(Boolean));
  const ids = new Set();
  for (const file of files) {
    const owner = all.find((ws) => file.startsWith(`${ws.dir}/`));
    if (owner) {
      ids.add(owner.id);
      if (owner.id === shared.id) all.filter((ws) => ws.usesShared).forEach((ws) => ids.add(ws.id));
    } else if (!file.includes("/") && /^package(-lock)?\.json$/.test(file)) {
      all.forEach((ws) => ids.add(ws.id));
    }
  }
  return all.filter((ws) => ids.has(ws.id));
}

function guarded(cmd, seconds) {
  if (process.env.SUITE_NO_GUARD === "1" || spawnSync("systemd-run", ["--version"], { stdio: "ignore" }).status !== 0) {
    return ["timeout", [String(seconds), ...cmd]];
  }
  return ["systemd-run", ["--user", "--scope", "-q", "-p", "MemoryMax=2G", "-p", "MemorySwapMax=0", "timeout", String(seconds), ...cmd]];
}

function runStep(ws, step) {
  if (!ws.scripts[step]) return "skip";
  const command = ws.root ? ["npm", "run", step] : ["npm", "run", step, "-w", ws.dir];
  const [bin, args] = guarded(command, timeouts[step]);
  console.log(`\n== ${ws.id}: ${step}`);
  const result = spawnSync(bin, args, { cwd: root, stdio: "inherit" });
  return result.status === 0 ? "ok" : "FAIL";
}

function reloadPlugin(ws) {
  if (ws.id === shared.id || ws.root) return "skip";
  let source;
  try {
    source = JSON.parse(execFileSync("bb", ["plugin", "source", ws.id, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return "not installed";
  }
  const resolved = String(source.resolved ?? "");
  if (!resolved.startsWith("path:")) return "not a path install";
  const target = resolved.slice(5);
  const here = realpathSync(join(root, ws.dir));
  let there;
  try {
    there = realpathSync(target);
  } catch {
    return "path missing";
  }
  if (there !== here && !there.startsWith(here + sep)) return `elsewhere: ${relative(root, there)}`;
  const result = spawnSync("bb", ["plugin", "reload", ws.id], { stdio: "inherit" });
  return result.status === 0 ? "ok" : "FAIL";
}

const argv = process.argv.slice(2);
const task = argv.shift();
if (!task || task === "--help" || task === "-h") usage(task ? 0 : 1);
if (!(task in tasks)) usage(1);

let mode = "changed";
let base;
const named = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--all") mode = "all";
  else if (arg === "--changed") mode = "changed";
  else if (arg === "--base") base = argv[++i];
  else if (arg.startsWith("-")) usage(1);
  else named.push(arg);
}

const all = workspaces();
let selected;
if (named.length) {
  const unknown = named.filter((id) => !all.some((ws) => ws.id === id));
  if (unknown.length) {
    console.error(`Unknown workspace: ${unknown.join(", ")}. Known: ${all.map((ws) => ws.id).join(", ")}`);
    process.exit(1);
  }
  selected = all.filter((ws) => named.includes(ws.id));
} else if (mode === "all") {
  selected = all;
} else {
  selected = changedIds(all, baseRef(base));
}

if (!selected.length) {
  console.log("Nothing changed.");
  process.exit(0);
}

if (!existsSync(join(root, "node_modules")) && task !== "reload") {
  console.error("Run npm ci at the repository root first.");
  process.exit(1);
}

const rows = [];
for (const ws of selected) {
  if (task === "reload") rows.push([ws.id, "reload", reloadPlugin(ws)]);
  else for (const step of tasks[task]) rows.push([ws.id, step, runStep(ws, step)]);
}

const width = Math.max(...rows.map((row) => row[0].length));
console.log("\nSummary");
for (const [id, step, status] of rows) console.log(`  ${id.padEnd(width)}  ${step.padEnd(9)}  ${status}`);
process.exit(rows.some((row) => row[2] === "FAIL") ? 1 : 0);
