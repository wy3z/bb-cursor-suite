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
const arm = args.arm ?? "stock";
const suiteRoot = resolve(args.suite ?? process.cwd());
const plugins = (args.plugins ?? "").split(",").filter(Boolean);
const bbApp = resolve(args.bbapp ?? DEFAULT_BB_APP);
const bbCli = resolve(args.cli ?? DEFAULT_BB_CLI);
const snapshot = resolve(args.snapshot ?? DEFAULT_SNAPSHOT);
const chromePath = args.chrome ?? DEFAULT_CHROME;
const playwrightPath = args.playwright ?? DEFAULT_PLAYWRIGHT;
const outPath = resolve(args.out ?? join(suiteRoot, "runs", `profile-${arm}.json`));
const title = args.thread ?? "Fixture long thread 01";
const warm = Boolean(args.warm);
const runDir = resolve(args["run-dir"] ?? join(suiteRoot, "runs", `profile-${arm}`));

rmSync(runDir, { recursive: true, force: true });
mkdirSync(runDir, { recursive: true });
execFileSync("cp", ["-a", `${snapshot}/.`, runDir]);

const result = { arm, plugins, machine: machineInfo(), thread: title, samples: 0, durationUs: 0, top: [] };
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
  await sleep(1500);

  const pluginById = new Map();
  const urlToPlugin = new Map();
  for (const plugin of (await getPlugins()).plugins) pluginById.set(plugin.id, plugin);
  if (plugins.length) {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const installed = await getPlugins();
      for (const plugin of installed.plugins) pluginById.set(plugin.id, plugin);
      if (plugins.every((id) => pluginById.get(id)?.status === "running")) break;
      await sleep(1000);
    }
  }
  for (const plugin of pluginById.values()) {
    const jsUrl = plugin.app?.bundle?.jsUrl;
    if (jsUrl) urlToPlugin.set(new URL(jsUrl, SERVER_URL).href, plugin.id);
  }

  const chromium = await loadPlaywright(playwrightPath);
  const chromePort = 9800 + (process.pid % 100);
  const profileDir = join("/tmp", `bb-perf-profile-${process.pid}`);
  rmSync(profileDir, { recursive: true, force: true });
  chrome = startChrome(chromePath, profileDir, chromePort);
  browser = await connectChrome(chromium, chromePort);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("bb.onboarding.seen", "1");
  });
  await page.goto(SERVER_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForSidebar(page, 120000);
  await dismissOverlays(page);
  await sleep(500);

  if (warm) {
    await openThread(page, title);
    await waitForThreadReady(page, `END-OF-TRANSCRIPT ${title}`);
    await page.getByText("Fixture long thread 02", { exact: true }).first().click().catch(() => {});
    await sleep(600);
  }

  const session = await context.newCDPSession(page);
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 1000 });
  await session.send("Profiler.start");
  await openThread(page, title);
  await waitForThreadReady(page, `END-OF-TRANSCRIPT ${title}`);
  const { profile } = await session.send("Profiler.stop");

  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  let totalUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    const us = profile.timeDeltas[i] ?? 0;
    totalUs += us;
    self.set(id, (self.get(id) ?? 0) + us);
  }
  const rows = [];
  for (const [id, us] of self.entries()) {
    const node = nodes.get(id);
    const frame = node?.callFrame ?? {};
    const url = frame.url ?? "";
    const key = { functionName: frame.functionName || "(anonymous)", url, line: frame.lineNumber ?? 0 };
    rows.push({ ...key, us, category: categoryOf(url, urlToPlugin) });
  }
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.category}|${row.functionName}|${row.url}|${row.line}`;
    const current = grouped.get(key);
    if (current) current.us += row.us;
    else grouped.set(key, { ...row });
  }
  result.samples = profile.samples.length;
  result.durationUs = totalUs;
  result.top = [...grouped.values()]
    .sort((a, b) => b.us - a.us)
    .slice(0, 25)
    .map((row) => ({ ...row, ms: round(row.us / 1000), pct: round((row.us / totalUs) * 100) }));

  await page.close();
  await browser.close();
  browser = null;
  stopChrome(chrome);
  chrome = null;
} catch (error) {
  result.error = String(error.stack ?? error.message);
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
  if (chrome) stopChrome(chrome);
  await stopBbApp(bbProcess, runDir);
}

mkdirSync(resolve(outPath, ".."), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
for (const row of result.top) {
  console.log(`${String(row.ms).padStart(8)}ms ${String(row.pct).padStart(5)}% ${row.category.padEnd(22)} ${row.functionName} @ ${row.url}:${row.line + 1}`);
}
if (result.error) console.error(result.error);

function categoryOf(url, map) {
  if (!url) return "native/unknown";
  if (url.startsWith("extensions::")) return "native/unknown";
  if (map.has(url)) return map.get(url);
  if (url.startsWith(SERVER_URL)) return "bb-core";
  return "other";
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    if (arg === "--warm") {
      out.warm = true;
      continue;
    }
    out[arg.slice(2)] = argv[++i];
  }
  return out;
}

function round(value) {
  return Math.round(value * 100) / 100;
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
        const base = window.__perfLongTasks?.length ?? 0;
        let frames = 0;
        const tick = () => {
          frames++;
          const recent = (window.__perfLongTasks ?? []).slice(base);
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
