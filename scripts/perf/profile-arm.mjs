#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_BB_APP,
  DEFAULT_BB_CLI,
  DEFAULT_CHROME,
  DEFAULT_PLAYWRIGHT,
  DEFAULT_SNAPSHOT,
  SERVER_URL,
  bb,
  connectChrome,
  findServerPid,
  getPlugins,
  loadPlaywright,
  machineInfo,
  sleep,
  startBbApp,
  startChrome,
  stopBbApp,
  stopChrome,
  waitForHttp,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const arm = required("arm");
const suiteRoot = resolve(required("suite"));
const plugins = (args.plugins ?? "").split(",").filter(Boolean);
const bbApp = resolve(args.bbapp ?? DEFAULT_BB_APP);
const bbCli = resolve(args.cli ?? DEFAULT_BB_CLI);
const snapshot = resolve(args.snapshot ?? DEFAULT_SNAPSHOT);
const outRoot = resolve(args.out ?? join(suiteRoot, "results", "profile"));
const chromePath = args.chrome ?? DEFAULT_CHROME;
const playwrightPath = args.playwright ?? DEFAULT_PLAYWRIGHT;
const titles = (
  args.titles ??
  "Fixture long thread 01,Fixture short thread 01,Fixture long thread 02,Fixture short thread 02,Fixture long thread 01,Fixture short thread 01"
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const warmupTitle = args.warmup ?? "Fixture short thread 25";
const runDir = resolve(args["run-dir"] ?? join(suiteRoot, "runs", `profile-${arm}`));

rmSync(runDir, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });
mkdirSync(runDir, { recursive: true });
execFileSync("cp", ["-a", `${snapshot}/.`, runDir]);

let bbProcess;
let chrome;
let browser;
try {
  bbProcess = startBbApp(bbApp, runDir, join(runDir, "run-bb.log"));
  await waitForHttp(SERVER_URL, 120000);
  await sleep(1200);
  for (const id of plugins) {
    bb(bbCli, ["plugin", "install", join(suiteRoot, "plugins", id), "--yes"]);
  }
  await sleep(1000);
  await stopBbApp(bbProcess, runDir);
  bbProcess = null;

  bbProcess = startBbApp(bbApp, runDir, join(runDir, "run-bb.log"));
  await waitForHttp(SERVER_URL, 120000);
  await waitForServerPid(bbProcess.pid);
  await sleep(1500);

  let installedPlugins = [];
  for (let i = 0; i < 90; i++) {
    installedPlugins = (await getPlugins()).plugins;
    const byId = new Map(installedPlugins.map((plugin) => [plugin.id, plugin]));
    if (plugins.every((id) => byId.get(id)?.status === "running")) break;
    await sleep(1000);
  }
  const pluginByHash = new Map();
  for (const plugin of installedPlugins) {
    if (plugin.app?.bundle?.hash) pluginByHash.set(plugin.app.bundle.hash, plugin.id);
  }
  const expected = installedPlugins
    .filter((plugin) => plugin.enabled && plugin.app?.hasApp && plugin.app.bundle?.jsUrl)
    .map((plugin) => new URL(plugin.app.bundle.jsUrl, SERVER_URL).pathname);

  const chromium = await loadPlaywright(playwrightPath);
  const chromePort = 9900 + (process.pid % 300);
  const profileDir = join("/tmp", `bb-perf-profile-${process.pid}`);
  rmSync(profileDir, { recursive: true, force: true });
  chrome = startChrome(chromePath, profileDir, chromePort);
  browser = await connectChrome(chromium, chromePort);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("bb.onboarding.seen", "1"));

  const loaded = new Set();
  const requests = new Map();
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 250 });
  session.on("Network.requestWillBeSent", (event) => {
    const path = new URL(event.request.url, SERVER_URL).pathname;
    requests.set(event.requestId, { path, type: event.type, start: event.timestamp, end: null });
  });
  session.on("Network.loadingFinished", (event) => {
    const request = requests.get(event.requestId);
    if (!request) return;
    request.end = event.timestamp;
    request.bytes = event.encodedDataLength ?? 0;
    if (request.type === "Script") loaded.add(request.path);
  });

  await page.goto(SERVER_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForSidebar(page, 120000);
  await dismissOverlays(page);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && expected.some((path) => !loaded.has(path))) {
    await sleep(100);
  }

  if (warmupTitle) {
    const warmLocator = await threadLocator(page, warmupTitle);
    await warmLocator.waitFor({ state: "visible", timeout: 30000 });
    await warmLocator.click({ timeout: 60000 }).catch(() => warmLocator.click({ timeout: 60000, force: true }));
    await waitForThreadReady(page, `END-OF-TRANSCRIPT ${warmupTitle}`);
    await sleep(1000);
  }

  const beforeIds = new Set(requests.keys());
  const windowStart = Date.now();
  await session.send("Profiler.start");
  for (const title of titles) {
    const locator = await threadLocator(page, title);
    await locator.waitFor({ state: "visible", timeout: 30000 });
    await locator.click({ timeout: 60000 }).catch(() => locator.click({ timeout: 60000, force: true }));
    await waitForThreadReady(page, `END-OF-TRANSCRIPT ${title}`);
  }
  const wallMs = Date.now() - windowStart;
  const { profile } = await session.send("Profiler.stop");
  const threadId = await currentThreadId(page, titles.at(-1) ?? "");

  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parentOf = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parentOf.set(child, node.id);
  }
  const selfByNode = new Map();
  for (let i = 0; i < samples.length; i++) {
    const duration = (deltas[i] ?? 0) / 1000;
    selfByNode.set(samples[i], (selfByNode.get(samples[i]) ?? 0) + duration);
  }
  const rows = [];
  let totalMs = 0;
  let scriptMs = 0;
  let idleMs = 0;
  for (const [id, ms] of selfByNode) {
    const node = nodes.get(id);
    if (!node) continue;
    const frame = node.callFrame;
    const name = frame.functionName || "(anonymous)";
    const url = frame.url || "";
    totalMs += ms;
    if (name === "(idle)") idleMs += ms;
    else if (name === "(program)" || name === "(root)") continue;
    else scriptMs += ms;
    rows.push({
      functionName: name,
      url,
      lineNumber: frame.lineNumber ?? 0,
      columnNumber: frame.columnNumber ?? 0,
      selfMs: round(ms),
      category: classify(url, pluginByHash),
    });
  }
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.functionName}|${row.url}|${row.lineNumber}|${row.columnNumber}`;
    const existing = grouped.get(key);
    if (existing) existing.selfMs = round(existing.selfMs + row.selfMs);
    else grouped.set(key, { ...row });
  }
  const top = [...grouped.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 40);
  const scriptSelfByCategoryMs = {};
  for (const row of rows) {
    if (!row.url) continue;
    scriptSelfByCategoryMs[row.category] = round((scriptSelfByCategoryMs[row.category] ?? 0) + row.selfMs);
  }
  const nativeByCallerCategoryMs = {};
  const nativeCallers = new Map();
  for (const [id, ms] of selfByNode) {
    const node = nodes.get(id);
    if (!node) continue;
    const frame = node.callFrame;
    const name = frame.functionName || "(anonymous)";
    if (frame.url || ["(idle)", "(program)", "(root)", "(garbage collector)"].includes(name)) continue;
    let ancestorId = parentOf.get(id);
    let caller = null;
    while (ancestorId !== undefined) {
      const ancestor = nodes.get(ancestorId);
      if (!ancestor) break;
      if (ancestor.callFrame.url) {
        caller = ancestor;
        break;
      }
      ancestorId = parentOf.get(ancestorId);
    }
    const category = caller ? classify(caller.callFrame.url, pluginByHash) : "none";
    nativeByCallerCategoryMs[category] = round((nativeByCallerCategoryMs[category] ?? 0) + ms);
    const callerFunction = caller ? caller.callFrame.functionName || "(anonymous)" : "(none)";
    const callerUrl = caller?.callFrame.url ?? "";
    const lineNumber = caller?.callFrame.lineNumber ?? 0;
    const columnNumber = caller?.callFrame.columnNumber ?? 0;
    const key = `${name}|${callerFunction}|${callerUrl}|${lineNumber}|${columnNumber}`;
    const existing = nativeCallers.get(key);
    if (existing) existing.ms = round(existing.ms + ms);
    else nativeCallers.set(key, { native: name, callerFunction, callerUrl, lineNumber, columnNumber, category, ms: round(ms) });
  }
  const topNativeCallers = [...nativeCallers.values()].sort((a, b) => b.ms - a.ms).slice(0, 40);
  const attributedByCategoryMs = { ...scriptSelfByCategoryMs };
  for (const [category, ms] of Object.entries(nativeByCallerCategoryMs)) {
    attributedByCategoryMs[category] = round((attributedByCategoryMs[category] ?? 0) + ms);
  }

  const windowRequests = [...requests.entries()]
    .filter(([id]) => !beforeIds.has(id))
    .map(([, request]) => request);
  const intervals = windowRequests
    .filter((request) => request.end !== null)
    .map((request) => [request.start, request.end])
    .sort((a, b) => a[0] - b[0]);
  let networkBusyMs = 0;
  let cursor = null;
  for (const [start, end] of intervals) {
    if (!cursor) cursor = [start, end];
    else if (start <= cursor[1]) cursor[1] = Math.max(cursor[1], end);
    else {
      networkBusyMs += cursor[1] - cursor[0];
      cursor = [start, end];
    }
  }
  if (cursor) networkBusyMs += cursor[1] - cursor[0];
  const windowJsBytes = windowRequests
    .filter((request) => request.type === "Script")
    .reduce((sum, request) => sum + (request.bytes ?? 0), 0);

  const result = {
    arm,
    plugins,
    threadId,
    titles,
    warmupTitle,
    wallMs: round(wallMs),
    opens: titles.length,
    profileSampledMs: round(totalMs),
    scriptSelfMs: round(scriptMs),
    idleMs: round(idleMs),
    networkBusyMs: round(networkBusyMs * 1000),
    networkRequests: windowRequests.length,
    windowJsBytes,
    topSelfFunctions: top,
    scriptSelfByCategoryMs,
    nativeByCallerCategoryMs,
    attributedByCategoryMs,
    topNativeCallers,
    pluginBundlesLoadedBeforeOpen: loaded.size,
    machine: machineInfo(),
  };
  writeFileSync(join(outRoot, `${arm}.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  await page.close();
  await browser.close();
  browser = null;
  stopChrome(chrome);
  chrome = null;
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
  if (chrome) stopChrome(chrome);
  await stopBbApp(bbProcess, runDir);
}

function classify(url, pluginByHash) {
  if (!url) return "native";
  const asset = /plugin-app-assets\/([a-f0-9]{16})\//.exec(url);
  if (asset) return pluginByHash.get(asset[1]) ?? `plugin:${asset[1]}`;
  const named = /\/api\/v1\/plugins\/([^/]+)\/assets\//.exec(url);
  if (named) return named[1];
  if (url.startsWith(SERVER_URL)) return "bb-core";
  if (url.startsWith("http")) return "other";
  return "native";
}

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

function round(value) {
  return Math.round(value * 100) / 100;
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
        let last = started;
        let frames = 0;
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) last = Math.max(last, entry.startTime + entry.duration);
        });
        observer.observe({ type: "longtask" });
        const tick = () => {
          frames++;
          if (frames >= 2 && performance.now() - last >= 250) {
            observer.disconnect();
            return resolve();
          }
          if (performance.now() - started > 5000) {
            observer.disconnect();
            return resolve();
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

async function currentThreadId(page, title) {
  return page.evaluate((threadTitle) => {
    const match = /threads\/(thr_[A-Za-z0-9]+)/.exec(window.location.href);
    return match ? match[1] : `title:${threadTitle}`;
  }, title);
}
