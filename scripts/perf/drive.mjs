#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_BB_APP,
  DEFAULT_BB_CLI,
  DEFAULT_CHROME,
  DEFAULT_PLAYWRIGHT,
  DEFAULT_SNAPSHOT,
  median,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const suiteRoot = resolve(args.suite ?? process.cwd());
const bbApp = resolve(args.bbapp ?? DEFAULT_BB_APP);
const bbCli = resolve(args.cli ?? DEFAULT_BB_CLI);
const snapshot = resolve(args.snapshot ?? DEFAULT_SNAPSHOT);
const outRoot = resolve(args.out ?? join(suiteRoot, "results"));
const runs = Number(args.runs ?? 1);
const idleSeconds = Number(args["idle-seconds"] ?? 60);
const opens = Number(args.opens ?? 20);
const chrome = args.chrome ?? DEFAULT_CHROME;
const playwright = args.playwright ?? DEFAULT_PLAYWRIGHT;
const arms = (args.arms ?? "stock,suite").split(",").filter(Boolean);
const suitePlugins = (args["suite-plugins"] ?? defaultPlugins(suiteRoot)).split(",").filter(Boolean);
const runArm = join(import.meta.dirname, "run-arm.mjs");
const seedFixture = join(import.meta.dirname, "seed-fixture.mjs");

if (!existsSync(`${snapshot}/bb.db`)) {
  console.error(`Seeding fixture snapshot at ${snapshot}`);
  execFileSync(
    process.execPath,
    [seedFixture, "--app", bbApp, "--cli", bbCli, "--snapshot", snapshot],
    { stdio: "inherit" },
  );
}

mkdirSync(outRoot, { recursive: true });
let order = 0;
for (let runIndex = 1; runIndex <= runs; runIndex++) {
  const sequence = runIndex % 2 === 1 ? arms : [...arms].reverse();
  for (const arm of sequence) {
    order++;
    const plugins = arm === "stock" ? [] : arm === "suite" ? suitePlugins : (args[`${arm}-plugins`] ?? "").split(",").filter(Boolean);
    console.error(`run ${runIndex} order ${order} arm ${arm}${plugins.length ? ` (${plugins.length} plugins)` : ""}`);
    execFileSync(
      process.execPath,
      [
        runArm,
        "--arm",
        arm,
        "--run-index",
        String(runIndex),
        "--order",
        String(order),
        "--suite",
        suiteRoot,
        "--bbapp",
        bbApp,
        "--cli",
        bbCli,
        "--snapshot",
        snapshot,
        "--out",
        outRoot,
        "--chrome",
        chrome,
        "--playwright",
        playwright,
        "--idle-seconds",
        String(idleSeconds),
        "--opens",
        String(opens),
        "--plugins",
        plugins.join(","),
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  }
}

const summary = buildSummary(outRoot, arms);
writeFileSync(join(outRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(outRoot, "summary.md"), renderMarkdown(summary));
process.stdout.write(`${renderText(summary)}\n`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    out[arg.slice(2)] = argv[++i];
  }
  return out;
}

function defaultPlugins(root) {
  const manifest = JSON.parse(readFileSync(join(root, ".bb/plugins.json"), "utf8"));
  return manifest.plugins.map((plugin) => plugin.name).join(",");
}

function buildSummary(root, armNames) {
  const results = {};
  for (const arm of armNames) {
    const dir = join(root, arm);
    if (!existsSync(dir)) continue;
    const files = execFileSync("ls", ["-1", dir], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((name) => name.endsWith(".json"));
    const records = files.map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")));
    results[arm] = records;
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    suiteSha: Object.values(results)[0]?.[0]?.suiteSha ?? "",
    runs: runs,
    arms: {},
    comparison: {},
  };
  const metricsOf = (record) => {
    const m = record.metrics;
    return {
      navToSidebarMs: m.navToSidebarMs,
      domContentLoadedMs: m.domContentLoadedMs,
      jsBytes: m.jsBytes,
      requestCount: m.requestCount,
      longTaskCount: m.longTaskCount,
      longTaskMs: m.longTaskMs,
      threadOpenMedianMs: m.threadOpenMs.median,
      threadOpenP90Ms: m.threadOpenMs.p90,
      threadOpenRequests: m.threadOpenRequests.requests,
      threadOpenBytes: m.threadOpenRequests.bytes,
      serverRssMB: m.serverRssMB,
      serverIdleCpuPct60s: m.serverIdleCpuPct60s,
    };
  };
  for (const [arm, records] of Object.entries(results)) {
    const valid = records.filter((record) => record.valid);
    const all = records;
    const values = {};
    const keys = Object.keys(metricsOf(valid[0] ?? records[0]));
    for (const key of keys) {
      const series = valid.map((record) => metricsOf(record)[key]).filter((value) => Number.isFinite(value));
      const fallback = all.map((record) => metricsOf(record)[key]).filter((value) => Number.isFinite(value));
      const chosen = series.length ? series : fallback;
      values[key] = {
        median: round(median(chosen)),
        min: round(chosen.length ? Math.min(...chosen) : 0),
        max: round(chosen.length ? Math.max(...chosen) : 0),
      };
    }
    summary.arms[arm] = {
      runs: records.length,
      valid: valid.length,
      invalid: records.length - valid.length,
      metrics: values,
    };
  }
  const stock = summary.arms.stock;
  const suite = summary.arms.suite;
  if (stock && suite) {
    for (const key of Object.keys(stock.metrics)) {
      const base = stock.metrics[key].median;
      const value = suite.metrics[key].median;
      summary.comparison[key] = {
        stock: base,
        suite: value,
        deltaPct: base > 0 ? round(((value - base) / base) * 100) : null,
      };
    }
  }
  return summary;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function renderText(summary) {
  const lines = [`suiteSha ${summary.suiteSha}`, `runs per arm ${summary.runs}`];
  for (const [arm, value] of Object.entries(summary.arms)) {
    lines.push(`${arm}: ${value.valid}/${value.runs} valid`);
  }
  if (Object.keys(summary.comparison).length) {
    lines.push("");
    lines.push("metric                      stock      suite      delta");
    for (const [key, value] of Object.entries(summary.comparison)) {
      const delta = value.deltaPct === null ? "n/a" : `${value.deltaPct > 0 ? "+" : ""}${value.deltaPct}%`;
      lines.push(`${key.padEnd(26)} ${String(value.stock).padStart(8)} ${String(value.suite).padStart(10)} ${delta.padStart(10)}`);
    }
  }
  return lines.join("\n");
}

function renderMarkdown(summary) {
  const lines = [`# BB performance summary`, "", `suiteSha: ${summary.suiteSha}`, ""];
  lines.push("| metric | stock | suite | delta |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [key, value] of Object.entries(summary.comparison)) {
    const delta = value.deltaPct === null ? "n/a" : `${value.deltaPct > 0 ? "+" : ""}${value.deltaPct}%`;
    lines.push(`| ${key} | ${value.stock} | ${value.suite} | ${delta} |`);
  }
  lines.push("");
  for (const [arm, value] of Object.entries(summary.arms)) {
    lines.push(`## ${arm}`, "", `valid ${value.valid}/${value.runs}`, "");
    lines.push("| metric | median | min | max |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const [key, stats] of Object.entries(value.metrics)) {
      lines.push(`| ${key} | ${stats.median} | ${stats.min} | ${stats.max} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
