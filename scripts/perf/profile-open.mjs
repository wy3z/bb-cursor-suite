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
const arm = args.arm ?? "stock";
const plugins = (args.plugins ?? "").split(",").filter(Boolean);
const suiteRoot = resolve(args.suite ?? process.cwd());
const snapshot = resolve(args.snapshot ?? DEFAULT_SNAPSHOT);
const bbApp = resolve(args.bbapp ?? DEFAULT_BB_APP);
const bbCli = resolve(args.cli ?? DEFAULT_BB_CLI);
const chromePath = args.chrome ?? DEFAULT_CHROME;
const playwrightPath = args.playwright ?? DEFAULT_PLAYWRIGHT;
const title = args.title ?? "Fixture long thread 01";
const runDir = resolve(args["run-dir"] ?? join(suiteRoot, "runs", `profile-${arm}`));
const outPath = resolve(args.out ?? join(suiteRoot, "results", `profile-${arm}.json`));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
  return out;
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of ["BB_PROJECT_ID", "BB_THREAD_ID", "BB_ENVIRONMENT_ID", "BB_THREAD_STORAGE", "BB_CLI"]) delete env[key];
  return env;
}

async function waitForSidebar(page) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await page.getByText(/Fixture (long|short) thread 01/).count()) return;
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

function pluginUrlMap(installed) {
  const map = new Map();
  for (const plugin of installed.plugins) {
    const jsUrl = plugin.app?.bundle?.jsUrl;
    if (jsUrl) map.set(new URL(jsUrl, SERVER_URL).href, plugin.id);
  }
  return map;
}

function ownerOf(url, byUrl) {
  if (!url) return "native";
  if (byUrl.has(url)) return `plugin:${byUrl.get(url)}`;
  if (/^https?:\/\/127\.0\.0\.1:39581\//.test(url)) {
    if (/\/api\/v1\/plugin-app-assets\//.test(url)) return "plugin:unmapped";
    return "bb-core";
  }
  if (url.startsWith("chrome-extension://") || url.startsWith("extensions::")) return "chrome-extension";
  return url;
}

function aggregate(profile, byUrl) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map();
  let totalUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i] ?? 0;
    totalUs += dt;
    const node = nodes.get(profile.samples[i]);
    if (!node) continue;
    const frame = node.callFrame;
    const key = `${frame.functionName || "(anonymous)"}\t${frame.url}\t${frame.lineNumber}:${frame.columnNumber}`;
    totals.set(key, (totals.get(key) ?? 0) + dt);
  }
  const rows = [...totals.entries()]
    .map(([key, us]) => {
      const [functionName, url, line] = key.split("\t");
      return {
        functionName,
        url,
        line,
        selfMs: Math.round(us / 100) / 10,
        owner: ownerOf(url, byUrl),
        pctOfSamples: Math.round((us / totalUs) * 1000) / 10,
      };
    })
    .sort((a, b) => b.selfMs - a.selfMs);
  return { totalSampledMs: Math.round(totalUs / 100) / 10, rows };
}

rmSync(runDir, { recursive: true, force: true });
mkdirSync(runDir, { recursive: true });
mkdirSync(resolve(outPath, ".."), { recursive: true });
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
  await (async () => {
    for (let i = 0; i < 100; i++) {
      if (findServerPid(bbProcess.pid)) return;
      await sleep(200);
    }
    throw new Error("Could not find bb server process");
  })();
  await sleep(1500);
  let installed = await getPlugins();
  if (plugins.length) {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      installed = await getPlugins();
      if (plugins.every((id) => installed.plugins.find((plugin) => plugin.id === id)?.status === "running")) break;
      await sleep(1000);
    }
    const notRunning = plugins.filter((id) => installed.plugins.find((plugin) => plugin.id === id)?.status !== "running");
    if (notRunning.length) throw new Error(`Plugins not running: ${notRunning.join(",")}`);
  }
  const byUrl = pluginUrlMap(installed);

  const chromium = await loadPlaywright(playwrightPath);
  const chromePort = 9300 + ((process.pid + 1) % 500);
  const profileDir = join("/tmp", `bb-perf-profile-chrome-${process.pid}`);
  rmSync(profileDir, { recursive: true, force: true });
  chrome = startChrome(chromePath, profileDir, chromePort);
  browser = await connectChrome(chromium, chromePort);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("bb.onboarding.seen", "1"));
  await page.goto(SERVER_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForSidebar(page);
  await dismissOverlays(page);
  await sleep(2000);

  const session = await context.newCDPSession(page);
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 100 });
  const started = Date.now();
  await session.send("Profiler.start");
  const locator = page.getByText(title, { exact: true }).first();
  await locator.waitFor({ state: "visible", timeout: 30000 });
  await locator.click({ timeout: 60000 }).catch(() => locator.click({ timeout: 60000, force: true }));
  await page.getByText(`END-OF-TRANSCRIPT ${title}`, { exact: false }).last().waitFor({ state: "visible", timeout: 120000 });
  await page
    .locator('[role="textbox"][aria-label^="Ask for a follow-up"], [role="textbox"][aria-label^="Ask anything"]')
    .last()
    .waitFor({ state: "visible", timeout: 30000 });
  const openMs = Date.now() - started;
  await sleep(500);
  const { profile } = await session.send("Profiler.stop");
  const { totalSampledMs, rows } = aggregate(profile, byUrl);

  const record = {
    arm,
    plugins,
    title,
    openMs,
    samplingIntervalUs: 100,
    totalSampledMs,
    machine: machineInfo(),
    pluginBundles: [...byUrl.entries()].map(([url, id]) => ({ url, id })),
    topSelfTime: rows.slice(0, Number(args.top ?? 40)),
  };
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ arm, openMs, totalSampledMs, top: record.topSelfTime.slice(0, 15) }, null, 2)}\n`,
  );
  await page.close();
  await browser.close();
  browser = null;
  stopChrome(chrome);
  chrome = null;
  await sleep(1000);
  await stopBbApp(bbProcess, runDir);
  bbProcess = null;
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
  if (chrome) stopChrome(chrome);
  if (bbProcess) await stopBbApp(bbProcess, runDir);
}
