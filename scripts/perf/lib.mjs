import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SERVER_PORT = 39581;
export const DAEMON_PORT = 39582;
export const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

export const HOME = homedir();
export const DEFAULT_BB_APP = join(HOME, "perf/bb/node_modules/.bin/bb-app");
export const DEFAULT_BB_CLI = join(HOME, "perf/bb/node_modules/.bin/bb");
export const DEFAULT_SNAPSHOT = join(HOME, "perf/fixture/snapshot");
export const DEFAULT_CHROME = "/usr/bin/google-chrome";
export const DEFAULT_PLAYWRIGHT = join(HOME, "perf/tools/node_modules/playwright-core/index.mjs");
export const FAKEGH_DIR = join(import.meta.dirname, "fakegh");
export const PERF_ROOT = process.env.PERF_ROOT ?? join(HOME, "perf");

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function machineInfo() {
  const nproc = Number(execFileSync("nproc", { encoding: "utf8" }).trim());
  const memKB = Number(/MemTotal:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))[1]);
  const loadavg = readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/).slice(0, 3).map(Number);
  return { nproc, memMB: Math.round(memKB / 1024), loadavg };
}

export function cliEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    "BB_PROJECT_ID",
    "BB_THREAD_ID",
    "BB_ENVIRONMENT_ID",
    "BB_THREAD_STORAGE",
    "BB_CLI",
    "BB_HOST_DAEMON_PORT",
  ]) delete env[key];
  env.BB_SERVER_URL = SERVER_URL;
  env.BB_HOST_DAEMON_PORT = String(DAEMON_PORT);
  return { ...env, ...extra };
}

export function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: cliEnv(),
    ...options,
  });
}

export function bb(cli, args, options = {}) {
  return run(cli, args, options);
}

export async function waitForHttp(url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.status < 500) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message}`);
}

export async function waitForPortFree(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(700) });
    } catch {
      return;
    }
    await sleep(400);
  }
  throw new Error(`Port ${port} is still in use`);
}

export function startBbApp(bbApp, dataDir, logPath) {
  const out = logPath ? openSync(logPath, "a") : "ignore";
  const ghConfigDir = join(dataDir, "gh-config");
  mkdirSync(ghConfigDir, { recursive: true });
  const child = spawn(
    bbApp,
    [
      "--bundled",
      "--no-in-app-updates",
      "--data-dir",
      dataDir,
      "--server-port",
      String(SERVER_PORT),
      "--host-daemon-port",
      String(DAEMON_PORT),
    ],
    {
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        BB_CLI: "",
        PATH: `${FAKEGH_DIR}:${process.env.PATH ?? ""}`,
        FAKEGH_DIR,
        FAKEGH_REPOS: join(PERF_ROOT, "fixture", "repos"),
        FAKEGH_LOG: join(dataDir, "fakegh-calls.log"),
        GIT_CONFIG_GLOBAL: join(PERF_ROOT, "fixture", "gitconfig"),
        GH_CONFIG_DIR: ghConfigDir,
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  return child;
}

export async function stopBbApp(child, dataDir) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    await sleep(300);
  }
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  const lock = join(dataDir, "daemon.lock");
  if (existsSync(lock)) {
    for (const pid of descendantPids(child.pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  await waitForPortFree(SERVER_PORT).catch(() => {});
}

export function procChildren() {
  const map = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      const ppid = Number(fields[1]);
      if (!map.has(ppid)) map.set(ppid, []);
      map.get(ppid).push(Number(entry));
    } catch {}
  }
  return map;
}

export function descendantPids(rootPid) {
  const children = procChildren();
  const out = [];
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    for (const child of children.get(pid) ?? []) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

export function findServerPid(rootPid) {
  for (const pid of descendantPids(rootPid)) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (cmdline.includes("server/dist/index.js")) return pid;
    } catch {}
  }
  return null;
}

export function readRssMB(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
  return match ? Number(match[1]) / 1024 : 0;
}

export function readCpuTicks(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).split(" ");
  return Number(fields[11]) + Number(fields[12]);
}

export function clockTicks() {
  try {
    return Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  } catch {
    return 100;
  }
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

export async function loadPlaywright(path = DEFAULT_PLAYWRIGHT) {
  const module = await import(pathToFileURL(resolve(path)).href);
  return module.chromium;
}

export function startChrome(chromePath, profileDir, port) {
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ];
  return spawn(chromePath, args, { stdio: "ignore", detached: true });
}

export async function connectChrome(chromium, port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`Timed out connecting to Chrome on ${port}: ${lastError?.message}`);
}

export function stopChrome(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

export async function getPlugins() {
  const response = await fetch(`${SERVER_URL}/api/v1/plugins`);
  if (!response.ok) throw new Error(`Plugin list failed: HTTP ${response.status}`);
  return response.json();
}

