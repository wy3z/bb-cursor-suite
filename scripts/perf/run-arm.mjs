#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const screenshotPath = args.screenshot ? resolve(args.screenshot) : null;
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
let fixtureVersion = 0;
try {
  fixtureVersion = Number(JSON.parse(readFileSync(join(runDir, "fixture.json"), "utf8")).fixtureVersion ?? 0);
} catch {}
if (fixtureVersion !== 2) {
  errors.push({ kind: "harness", message: `fixture.json missing fixtureVersion 2 (got ${fixtureVersion})` });
  invalidReasons.push("fixture-version");
}

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

  let installedPlugins = [];
  {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const installed = await getPlugins();
      installedPlugins = installed.plugins;
      const byId = new Map(installedPlugins.map((plugin) => [plugin.id, plugin]));
      if (plugins.every((id) => byId.get(id)?.status === "running")) break;
      await sleep(1000);
    }
    const byId = new Map(installedPlugins.map((plugin) => [plugin.id, plugin]));
    for (const id of plugins) {
      const plugin = byId.get(id);
      if (!plugin || plugin.status !== "running") {
        errors.push({ kind: "plugin-load", message: `${id}: ${plugin?.status ?? "missing"}` });
        invalidReasons.push(`plugin-load ${id}`);
      }
    }
  }
  const expectedAppBundles = installedPlugins
    .filter((plugin) => plugin.enabled && plugin.app?.hasApp && plugin.app.bundle?.jsUrl)
    .map((plugin) => ({
      id: plugin.id,
      url: plugin.app.bundle.jsUrl,
      declaredBytes: plugin.app.bundle.jsBytes ?? 0,
    }));

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
  const perfSession = await context.newCDPSession(page);
  await perfSession.send("Performance.enable");
  tracker.reset();
  const navStart = Date.now();
  await page.goto(SERVER_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForSidebar(page, 120000);
  const navToSidebarMs = Date.now() - navStart;
  await dismissOverlays(page);
  const bootWait = await tracker.waitForScripts(
    expectedAppBundles.map((bundle) => bundle.url),
    45000,
  );
  for (const missing of bootWait.missing) {
    const bundle = expectedAppBundles.find((item) => pathMatches(item.url, missing));
    const id = bundle?.id ?? missing;
    errors.push({ kind: "plugin-load", message: `${id}: app.js not fetched during boot` });
    invalidReasons.push(`plugin-load ${id}`);
  }
  const sidebarThreadRows = await countSidebarThreadRows(page);
  const domContentLoadedMs = await page.evaluate(
    () => performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd ?? 0,
  );
  const bootNetwork = tracker.markBootEnd();

  const samples = [];
  const seen = new Set();
  for (let index = 0; index < plan.length; index++) {
    const item = plan[index];
    const cold = !seen.has(item.title);
    seen.add(item.title);
    const before = await readLongTasks(page);
    const perfBefore = await readPerfMetrics(perfSession);
    tracker.startWindow();
    const started = Date.now();
    let ms = 0;
    let windowStats = { requests: 0, bytes: 0, jsBytes: 0 };
    let perfAfter;
    try {
      await openThread(page, item.title);
      await waitForThreadReady(page, `END-OF-TRANSCRIPT ${item.title}`);
      perfAfter = await readPerfMetrics(perfSession);
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
      jsBytes: windowStats.jsBytes,
      longTaskCount: longTasks.length,
      longTaskMs: longTasks.reduce((sum, entry) => sum + entry.duration, 0),
      ...perfDelta(perfBefore, perfAfter),
    });
  }

  let prTextVisible = false;
  try {
    await openThread(page, longTitles[0]);
    await waitForThreadReady(page, `END-OF-TRANSCRIPT ${longTitles[0]}`);
    prTextVisible = await page.evaluate(() => {
      const text = document.body.innerText;
      return text.includes("#142") || text.includes("142");
    });
    if (screenshotPath) {
      mkdirSync(dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath });
    }
  } catch (error) {
    errors.push({ kind: "harness", message: `post-run open ${longTitles[0]}: ${error.message}`.slice(0, 500) });
    invalidReasons.push(`post-run open ${longTitles[0]}`);
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

  const openJsSamples = samples.map((sample) => sample.jsBytes);
  const openJsBytes = openJsSamples.reduce((sum, value) => sum + value, 0);
  const sessionJsBytes = tracker.sessionScriptBytes();
  const pluginAppUrls = tracker.pluginAppAssetList().map((asset) => {
    const bundle = expectedAppBundles.find((item) => pathMatches(item.url, asset.path));
    return {
      id: bundle?.id ?? "unknown",
      url: asset.path,
      bytes: asset.bytes,
      expected: Boolean(bundle),
      boot: asset.boot,
    };
  });
  record.metrics = {
    fixtureVersion,
    navToSidebarMs,
    domContentLoadedMs,
    jsBytes: bootNetwork.jsBytes,
    bootJsBytes: bootNetwork.jsBytes,
    bootRequestCount: bootNetwork.requests,
    bootEndMs: bootNetwork.bootEndMs,
    openJsBytes,
    openJsBytesMedian: round(median(openJsSamples)),
    sessionJsBytes,
    unattributedJsBytes: Math.max(0, sessionJsBytes - bootNetwork.jsBytes - openJsBytes),
    pluginAppUrls,
    requestCount: bootNetwork.requests,
    longTaskCount: allLongTasks.entries.length,
    longTaskMs: allLongTasks.entries.reduce((sum, entry) => sum + entry.duration, 0),
    threadOpenMs: {
      median: round(median(openTimes)),
      p90: round(percentile(openTimes, 90)),
      samples,
    },
    threadOpenByKind: {
      longCold: round(median(openTimesOf(samples, "long", true))),
      longWarm: round(median(openTimesOf(samples, "long", false))),
      shortCold: round(median(openTimesOf(samples, "short", true))),
      shortWarm: round(median(openTimesOf(samples, "short", false))),
    },
    openTaskMsMedian: round(median(samples.map((sample) => sample.taskMs))),
    openScriptMsMedian: round(median(samples.map((sample) => sample.scriptMs))),
    openLayoutMsMedian: round(median(samples.map((sample) => sample.layoutMs))),
    openStyleMsMedian: round(median(samples.map((sample) => sample.styleMs))),
    openLayoutCountMedian: round(median(samples.map((sample) => sample.layoutCount))),
    openStyleCountMedian: round(median(samples.map((sample) => sample.styleCount))),
    openLongTaskMsMedian: round(median(samples.map((sample) => sample.longTaskMs))),
    opensExpected: plan.length,
    opensCompleted: samples.length,
    threadOpenRequests: {
      requests: firstCold?.requests ?? 0,
      bytes: firstCold?.bytes ?? 0,
      threadId: firstCold?.threadId ?? "",
      cold: firstCold?.cold ?? true,
    },
    serverRssMB: round(serverRssMB),
    serverIdleCpuPct60s: round(idleCpu),
    fakeGhCalls: countLines(join(runDir, "fakegh-calls.log")),
    sidebarThreadRows,
    prTextVisible,
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
  if (record.metrics) record.metrics.fakeGhCalls = countLines(join(runDir, "fakegh-calls.log"));
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
    fixtureVersion: 0,
    navToSidebarMs: 0,
    domContentLoadedMs: 0,
    jsBytes: 0,
    bootJsBytes: 0,
    bootRequestCount: 0,
    bootEndMs: 0,
    openJsBytes: 0,
    openJsBytesMedian: 0,
    sessionJsBytes: 0,
    unattributedJsBytes: 0,
    pluginAppUrls: [],
    requestCount: 0,
    longTaskCount: 0,
    longTaskMs: 0,
    threadOpenMs: { median: 0, p90: 0, samples: [] },
    threadOpenByKind: { longCold: 0, longWarm: 0, shortCold: 0, shortWarm: 0 },
    openTaskMsMedian: 0,
    openScriptMsMedian: 0,
    openLayoutMsMedian: 0,
    openStyleMsMedian: 0,
    openLayoutCountMedian: 0,
    openStyleCountMedian: 0,
    openLongTaskMsMedian: 0,
    opensExpected: 0,
    opensCompleted: 0,
    threadOpenRequests: { requests: 0, bytes: 0, threadId: "", cold: true },
    serverRssMB: 0,
    serverIdleCpuPct60s: 0,
    fakeGhCalls: 0,
    sidebarThreadRows: 0,
    prTextVisible: false,
  };
}

function countLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function countSidebarThreadRows(page) {
  return page.evaluate(() => {
    const root =
      document.querySelector('[data-testid="app-sidebar-body"]') ??
      document.querySelector('[data-testid="nav-rail-sidebar-body"]') ??
      document.body;
    const seen = new Set();
    for (const element of root.querySelectorAll("*")) {
      if (element.children.length) continue;
      const text = (element.textContent ?? "").trim();
      if (text.startsWith("Fixture ")) seen.add(text);
    }
    return seen.size;
  });
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

async function readPerfMetrics(session) {
  const { metrics } = await session.send("Performance.getMetrics");
  const map = {};
  for (const entry of metrics) map[entry.name] = entry.value;
  return map;
}

function perfDelta(before, after) {
  const diff = (name) => (after[name] ?? 0) - (before[name] ?? 0);
  return {
    taskMs: round(diff("TaskDuration") * 1000),
    scriptMs: round(diff("ScriptDuration") * 1000),
    layoutMs: round(diff("LayoutDuration") * 1000),
    styleMs: round(diff("RecalcStyleDuration") * 1000),
    layoutCount: round(diff("LayoutCount")),
    styleCount: round(diff("RecalcStyleCount")),
  };
}

function openTimesOf(samples, kind, cold) {
  return samples.filter((sample) => sample.kind === kind && sample.cold === cold).map((sample) => sample.ms);
}

async function idleCpuPercent(pid, seconds, ticksPerSecond) {
  const before = readCpuTicks(pid);
  const started = Date.now();
  await sleep(seconds * 1000);
  const after = readCpuTicks(pid);
  const elapsed = (Date.now() - started) / 1000;
  return ((after - before) / ticksPerSecond / elapsed) * 100;
}

function normalizePath(url) {
  try {
    return new URL(url, SERVER_URL).pathname;
  } catch {
    return url;
  }
}

function pathMatches(a, b) {
  return normalizePath(a) === normalizePath(b);
}

function isPluginAppAsset(path) {
  return /^\/api\/v1\/(?:plugins\/[^/]+\/assets|plugin-app-assets\/[a-f0-9]{16})\/app\.js$/.test(path);
}

async function createTracker(context, page) {
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  const requests = new Map();
  const loadedScripts = new Set();
  const pluginAssets = new Map();
  let totalRequests = 0;
  let totalBytes = 0;
  let sessionJsBytes = 0;
  let bootJsBytes = 0;
  let bootRequests = 0;
  let bootEndMs = 0;
  let bootOpen = false;
  let window = null;
  let sessionStart = 0;
  session.on("Network.requestWillBeSent", (event) => {
    const path = normalizePath(event.request.url);
    totalRequests++;
    if (bootOpen) bootRequests++;
    const request = { type: event.type, url: event.request.url, path, boot: bootOpen, window, bytes: 0 };
    requests.set(event.requestId, request);
    if (window) {
      window.requests++;
      window.ids.add(event.requestId);
    }
  });
  session.on("Network.loadingFinished", (event) => {
    const bytes = event.encodedDataLength ?? 0;
    totalBytes += bytes;
    const request = requests.get(event.requestId);
    if (!request) return;
    request.bytes += bytes;
    if (request.type === "Script") {
      sessionJsBytes += bytes;
      loadedScripts.add(request.path);
      if (request.boot) bootJsBytes += bytes;
    }
    if (request.window) {
      request.window.bytes += bytes;
      if (request.type === "Script") request.window.jsBytes += bytes;
    }
    if (isPluginAppAsset(request.path)) {
      pluginAssets.set(request.path, {
        path: request.path,
        bytes: (pluginAssets.get(request.path)?.bytes ?? 0) + bytes,
        boot: request.boot,
      });
    }
  });
  return {
    reset() {
      totalRequests = 0;
      totalBytes = 0;
      sessionJsBytes = 0;
      bootJsBytes = 0;
      bootRequests = 0;
      bootEndMs = 0;
      bootOpen = true;
      sessionStart = Date.now();
      requests.clear();
      loadedScripts.clear();
      pluginAssets.clear();
    },
    sessionScriptBytes() {
      return sessionJsBytes;
    },
    pluginAppAssetList() {
      return [...pluginAssets.values()];
    },
    markBootEnd() {
      bootOpen = false;
      bootEndMs = Date.now() - sessionStart;
      return {
        requests: bootRequests,
        bytes: totalBytes,
        jsBytes: bootJsBytes,
        bootEndMs,
        pluginAssets: [...pluginAssets.values()],
      };
    },
    async waitForScripts(urls, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const pending = () => urls.filter((url) => !loadedScripts.has(normalizePath(url)));
      while (Date.now() < deadline && pending().length) {
        await sleep(100);
      }
      return { missing: pending() };
    },
    startWindow() {
      window = { requests: 0, bytes: 0, jsBytes: 0, ids: new Set() };
    },
    endWindow() {
      const result = window
        ? { requests: window.requests, bytes: window.bytes, jsBytes: window.jsBytes }
        : { requests: 0, bytes: 0, jsBytes: 0 };
      window = null;
      return result;
    },
  };
}
