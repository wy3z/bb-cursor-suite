#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_BB_APP,
  DEFAULT_BB_CLI,
  DEFAULT_CHROME,
  DEFAULT_PLAYWRIGHT,
  DEFAULT_SNAPSHOT,
  SERVER_URL,
  bb,
  clockTicks,
  connectChrome,
  findServerPid,
  getPlugins,
  loadPlaywright,
  machineInfo,
  median,
  percentile,
  readCpuTicks,
  readRssMB,
  sleep,
  startBbApp,
  startChrome,
  stopBbApp,
  stopChrome,
  waitForHttp,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const arm = required("arm");
const runIndex = Number(required("run-index"));
const order = Number(required("order"));
const suiteRoot = resolve(required("suite"));
const plugins = (args.plugins ?? "").split(",").filter(Boolean);
const bbApp = resolve(args.bbapp ?? DEFAULT_BB_APP);
const bbCli = resolve(args.cli ?? DEFAULT_BB_CLI);
const snapshot = resolve(args.snapshot ?? DEFAULT_SNAPSHOT);
const outRoot = resolve(args.out ?? join(suiteRoot, "results"));
const chromePath = args.chrome ?? DEFAULT_CHROME;
const playwrightPath = args.playwright ?? DEFAULT_PLAYWRIGHT;
const idleSeconds = Number(args["idle-seconds"] ?? 60);
const openCount = Number(args.opens ?? 20);
const runDir = resolve(args["run-dir"] ?? join(suiteRoot, "runs", `${arm}-${runIndex}`));
const resultPath = join(outRoot, arm, `${runIndex}.json`);
const errors = [];
const invalidReasons = [];
const suiteSha = execFileSync("git", ["-C", suiteRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const bbVersion = execFileSync(bbCli, ["--version"], { encoding: "utf8", env: cleanEnv() }).trim();
const longTitles = Array.from({ length: 5 }, (_, i) => `Fixture long thread ${String(i + 1).padStart(2, "0")}`);
const shortTitles = Array.from({ length: 5 }, (_, i) => `Fixture short thread ${String(i + 1).padStart(2, "0")}`);
const openPlan = [];
for (let round = 0; round < Math.ceil(openCount / 10); round++) {
  for (let i = 0; i < 5; i++) {
    openPlan.push({ title: longTitles[i], kind: "long" });
    openPlan.push({ title: shortTitles[i], kind: "short" });
  }
}
const plan = openPlan.slice(0, openCount);

rmSync(runDir, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });
mkdirSync(runDir, { recursive: true });
execFileSync("cp", ["-a", `${snapshot}/.`, runDir]);

const record = {
  arm,
  plugins,
  suiteSha,
  bbVersion,
  machine: machineInfo(),
  runIndex,
  order,
  cold: true,
  valid: true,
  invalidReasons,
  metrics: null,
  errors,
};

let bbProcess;
let chrome;
let browser;
let serverPid;
try {
  bbProcess = startBbApp(bbApp, runDir, join(runDir, "run-bb.log"));
  await waitForHttp(SERVER_URL, 120000);
  await sleep(1200);

  for (const id of plugins) {
    let installed = false;
    let detail = "";
    for (let attempt = 1; attempt <= 3 && !installed; attempt++) {
      try {
        bb(bbCli, ["plugin", "install", join(suiteRoot, "plugins", id), "--yes"]);
        installed = true;
      } catch (error) {
        detail = error.message;
        await sleep(1500);
      }
    }
    if (!installed) {
      errors.push({ kind: "harness", message: `install ${id}: ${detail}`.slice(0, 500) });
      invalidReasons.push(`install ${id}`);
    }
  }
  await sleep(1000);
  await stopBbApp(bbProcess, runDir);
  bbProcess = null;

  bbProcess = startBbApp(bbApp, runDir, join(runDir, "run-bb.log"));
  await waitForHttp(SERVER_URL, 120000);
  serverPid = await waitForServerPid(bbProcess.pid);
  await sleep(1500);

  if (plugins.length) {
    const deadline = Date.now() + 90000;
    let byId = new Map();
    while (Date.now() < deadline) {
      const installed = await getPlugins();
      byId = new Map(installed.plugins.map((plugin) => [plugin.id, plugin]));
      if (plugins.every((id) => byId.get(id)?.status === "running")) break;
      await sleep(1000);
    }
    for (const id of plugins) {
      const plugin = byId.get(id);
      if (!plugin || plugin.status !== "running") {
        errors.push({ kind: "plugin-load", message: `${id}: ${plugin?.status ?? "missing"}` });
        invalidReasons.push(`plugin-load ${id}`);
      }
    }
  }

  const chromium = await loadPlaywright(playwrightPath);
  const chromePort = 9300 + ((process.pid + runIndex) % 500);
  const profileDir = join("/tmp", `bb-perf-chrome-${process.pid}-${runIndex}`);
  rmSync(profileDir, { recursive: true, force: true });
  chrome = startChrome(chromePath, profileDir, chromePort);
  browser = await connectChrome(chromium, chromePort);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("bb.onboarding.seen", "1");
    window.__perfLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perfLongTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: "longtask", buffered: true });
  });

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    const location = message.location()?.url ?? "";
    if (text.includes("thread-storage/location") || location.includes("thread-storage/location")) return;
    errors.push({ kind: "console", message: text.slice(0, 500) });
  });
  page.on("requestfailed", (request) => {
    if (request.url().includes("thread-storage/location")) return;
    if (request.failure()?.errorText?.includes("ERR_ABORTED")) return;
    errors.push({ kind: "request", message: `${request.url()} ${request.failure()?.errorText ?? ""}`.slice(0, 500) });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    if (response.url().includes("thread-storage/location")) return;
    errors.push({ kind: "request", message: `HTTP ${response.status()} ${response.url()}`.slice(0, 500) });
  });

  const tracker = await createTracker(context, page);
  tracker.reset();
  const navStart = Date.now();
  await page.goto(SERVER_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForSidebar(page, 120000);
  const navToSidebarMs = Date.now() - navStart;
  await dismissOverlays(page);
  const domContentLoadedMs = await page.evaluate(
    () => performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd ?? 0,
  );
  const coldNetwork = tracker.snapshot();

  const samples = [];
  const seen = new Set();
  for (let index = 0; index < plan.length; index++) {
    const item = plan[index];
    const cold = !seen.has(item.title);
    seen.add(item.title);
    const before = await readLongTasks(page);
    tracker.startWindow();
    const started = Date.now();
    let ms = 0;
    let windowStats = { requests: 0, bytes: 0 };
    try {
      await openThread(page, item.title);
      await waitForThreadReady(page, `END-OF-TRANSCRIPT ${item.title}`);
      ms = Date.now() - started;
      windowStats = tracker.endWindow();
    } catch (error) {
      tracker.endWindow();
      errors.push({ kind: "harness", message: `open ${item.title}: ${error.message}`.slice(0, 500) });
      invalidReasons.push(`open ${item.title}`);
      continue;
    }
    const after = await readLongTasks(page);
    const longTasks = after.entries.slice(before.entries.length);
    const threadId = await currentThreadId(page, item.title);
    samples.push({
      threadId,
      title: item.title,
      kind: item.kind,
      cold,
      ms,
      requests: windowStats.requests,
      bytes: windowStats.bytes,
      longTaskCount: longTasks.length,
      longTaskMs: longTasks.reduce((sum, entry) => sum + entry.duration, 0),
    });
  }

  const openTimes = samples.map((sample) => sample.ms);
  const allLongTasks = await readLongTasks(page);
  const firstCold = samples.find((sample) => sample.cold) ?? samples[0];

  await page.close();
  await browser.close();
  browser = null;
  stopChrome(chrome);
  chrome = null;
  await sleep(3000);

  const serverRssMB = readRssMB(serverPid);
  const idleCpu = await idleCpuPercent(serverPid, idleSeconds, clockTicks());

  record.metrics = {
    navToSidebarMs,
    domContentLoadedMs,
    jsBytes: coldNetwork.jsBytes,
    requestCount: coldNetwork.requests,
    longTaskCount: allLongTasks.entries.length,
    longTaskMs: allLongTasks.entries.reduce((sum, entry) => sum + entry.duration, 0),
    threadOpenMs: {
      median: round(median(openTimes)),
      p90: round(percentile(openTimes, 90)),
      samples,
    },
    threadOpenRequests: {
      requests: firstCold?.requests ?? 0,
      bytes: firstCold?.bytes ?? 0,
      threadId: firstCold?.threadId ?? "",
      cold: firstCold?.cold ?? true,
    },
    serverRssMB: round(serverRssMB),
    serverIdleCpuPct60s: round(idleCpu),
  };
  record.valid = invalidReasons.length === 0;
} catch (error) {
  errors.push({ kind: "harness", message: String(error.stack ?? error.message).slice(0, 2000) });
  invalidReasons.push("harness");
  record.valid = false;
  record.metrics ??= emptyMetrics();
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
  if (chrome) stopChrome(chrome);
  await stopBbApp(bbProcess, runDir);
}

mkdirSync(dirname(resultPath), { recursive: true });
writeFileSync(resultPath, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(record)}\n`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    out[arg.slice(2)] = argv[++i];
  }
  return out;
}

function required(name) {
  const value = args[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of ["BB_PROJECT_ID", "BB_THREAD_ID", "BB_ENVIRONMENT_ID", "BB_THREAD_STORAGE", "BB_CLI"]) {
    delete env[key];
  }
  return env;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function emptyMetrics() {
  return {
    navToSidebarMs: 0,
    domContentLoadedMs: 0,
    jsBytes: 0,
    requestCount: 0,
    longTaskCount: 0,
    longTaskMs: 0,
    threadOpenMs: { median: 0, p90: 0, samples: [] },
    threadOpenRequests: { requests: 0, bytes: 0, threadId: "", cold: true },
    serverRssMB: 0,
    serverIdleCpuPct60s: 0,
  };
}

async function waitForServerPid(rootPid) {
  for (let i = 0; i < 100; i++) {
    const pid = findServerPid(rootPid);
    if (pid) return pid;
    await sleep(200);
  }
  throw new Error("Could not find bb server process");
}

async function waitForSidebar(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await page.getByText(/Fixture (long|short) thread 01/).count();
    if (count > 0) return;
    await sleep(250);
  }
  throw new Error("Sidebar did not render fixture threads");
}

async function dismissOverlays(page) {
  for (let i = 0; i < 10; i++) {
    const gotIt = page.getByRole("button", { name: "Got it" });
    if (await gotIt.count()) {
      await gotIt.first().click().catch(() => {});
      await sleep(200);
      continue;
    }
    const body = await page.locator("body").innerText();
    if (/Connect a coding agent|Add your projects|Make bb yours|Use bb/.test(body)) {
      const next = page.getByRole("button", { name: /Continue|Start using bb/ });
      if (await next.count()) {
        await next.first().click().catch(() => {});
        await sleep(400);
        continue;
      }
    }
    break;
  }
}

async function threadLocator(page, title) {
  const sidebar = page.locator('[data-testid="app-sidebar-body"]');
  const scoped = sidebar.getByText(title, { exact: true });
  if ((await scoped.count()) > 0) return scoped.first();
  const rail = page.locator('[data-testid="nav-rail-sidebar-body"]');
  const railScoped = rail.getByText(title, { exact: true });
  if ((await railScoped.count()) > 0) return railScoped.first();
  return page.getByText(title, { exact: true }).first();
}

async function openThread(page, title) {
  const locator = await threadLocator(page, title);
  await locator.waitFor({ state: "visible", timeout: 30000 });
  await locator.click({ timeout: 60000 }).catch(() => locator.click({ timeout: 60000, force: true }));
}

async function waitForThreadReady(page, lastText) {
  await page.getByText(lastText, { exact: false }).last().waitFor({ state: "visible", timeout: 120000 });
  await page
    .locator('[role="textbox"][aria-label^="Ask for a follow-up"], [role="textbox"][aria-label^="Ask anything"]')
    .last()
    .waitFor({ state: "visible", timeout: 30000 });
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const started = performance.now();
        const base = window.__perfLongTasks.length;
        let frames = 0;
        const tick = () => {
          frames++;
          const recent = window.__perfLongTasks.slice(base);
          const lastEnd = recent.length
            ? Math.max(...recent.map((entry) => entry.start + entry.duration))
            : started;
          const quietFor = performance.now() - Math.max(started, lastEnd);
          if (frames >= 2 && quietFor >= 250) return resolve();
          if (performance.now() - started > 5000) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

async function currentThreadId(page, title) {
  return page.evaluate((threadTitle) => {
    const location = window.location.href;
    const match = /threads\/(thr_[A-Za-z0-9]+)/.exec(location);
    if (match) return match[1];
    return `title:${threadTitle}`;
  }, title);
}

async function readLongTasks(page) {
  const entries = await page.evaluate(() => window.__perfLongTasks ?? []);
  return { entries };
}

async function idleCpuPercent(pid, seconds, ticksPerSecond) {
  const before = readCpuTicks(pid);
  const started = Date.now();
  await sleep(seconds * 1000);
  const after = readCpuTicks(pid);
  const elapsed = (Date.now() - started) / 1000;
  return ((after - before) / ticksPerSecond / elapsed) * 100;
}

async function createTracker(context, page) {
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  const requests = new Map();
  let totalRequests = 0;
  let totalBytes = 0;
  let totalJsBytes = 0;
  let window = null;
  session.on("Network.requestWillBeSent", (event) => {
    totalRequests++;
    requests.set(event.requestId, { type: event.type, url: event.request.url });
    if (window) {
      window.requests++;
      window.ids.add(event.requestId);
    }
  });
  session.on("Network.loadingFinished", (event) => {
    const bytes = event.encodedDataLength ?? 0;
    totalBytes += bytes;
    const request = requests.get(event.requestId);
    if (request?.type === "Script") totalJsBytes += bytes;
    if (window && window.ids.has(event.requestId)) window.bytes += bytes;
  });
  return {
    reset() {
      totalRequests = 0;
      totalBytes = 0;
      totalJsBytes = 0;
      requests.clear();
    },
    snapshot() {
      return { requests: totalRequests, bytes: totalBytes, jsBytes: totalJsBytes };
    },
    startWindow() {
      window = { requests: 0, bytes: 0, ids: new Set() };
    },
    endWindow() {
      const result = window ? { requests: window.requests, bytes: window.bytes } : { requests: 0, bytes: 0 };
      window = null;
      return result;
    },
  };
}
