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
const armRoots = parseArmRoots(args["arm-roots"]);
const baselineArm = args["baseline-arm"] ?? "stock";
const runArm = join(import.meta.dirname, "run-arm.mjs");
const seedFixture = join(import.meta.dirname, "seed-fixture.mjs");
const tableKeys = [
  "threadOpenMedianMs",
  "threadOpenShortWarmMs",
  "threadOpenLongWarmMs",
  "threadOpenShortColdMs",
  "threadOpenLongColdMs",
  "threadOpenP90Ms",
  "firstColdOpenMs",
  "openTaskMsMedian",
  "openLayoutCountMedian",
  "openLongTaskMsMedian",
  "longTaskMs",
  "bootJsBytes",
];

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
    const armRoot = rootFor(arm);
    const plugins = pluginsFor(arm);
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
        armRoot,
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
  return manifest.plugins.map((plugin) => plugin.name);
}

function parseArmRoots(value) {
  const out = {};
  if (!value) return out;
  for (const part of value.split(",")) {
    if (!part.trim()) continue;
    const eq = part.indexOf("=");
    if (eq < 0) throw new Error(`--arm-roots entry needs name=/abs/path: ${part}`);
    out[part.slice(0, eq).trim()] = resolve(part.slice(eq + 1).trim());
  }
  return out;
}

function rootFor(arm) {
  return armRoots[arm] ?? suiteRoot;
}

function pluginsFor(arm) {
  if (arm === "stock") return [];
  const explicit = args[`${arm}-plugins`];
  if (explicit !== undefined) return explicit.split(",").filter(Boolean);
  return defaultPlugins(rootFor(arm));
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
    baselineArm: baselineArm,
    arms: {},
    paired: {},
    comparison: {},
  };
  const metricsOf = (record) => {
    const m = record.metrics;
    return {
      navToSidebarMs: m.navToSidebarMs,
      domContentLoadedMs: m.domContentLoadedMs,
      jsBytes: m.jsBytes,
      bootJsBytes: m.bootJsBytes,
      bootEndMs: m.bootEndMs,
      openJsBytes: m.openJsBytes,
      openJsBytesMedian: m.openJsBytesMedian,
      sessionJsBytes: m.sessionJsBytes,
      unattributedJsBytes: m.unattributedJsBytes,
      requestCount: m.requestCount,
      longTaskCount: m.longTaskCount,
      longTaskMs: m.longTaskMs,
      threadOpenMedianMs: m.threadOpenMs.median,
      threadOpenP90Ms: m.threadOpenMs.p90,
      threadOpenLongColdMs: m.threadOpenByKind.longCold,
      threadOpenLongWarmMs: m.threadOpenByKind.longWarm,
      threadOpenShortColdMs: m.threadOpenByKind.shortCold,
      threadOpenShortWarmMs: m.threadOpenByKind.shortWarm,
      openTaskMsMedian: m.openTaskMsMedian,
      openScriptMsMedian: m.openScriptMsMedian,
      openLayoutMsMedian: m.openLayoutMsMedian,
      openStyleMsMedian: m.openStyleMsMedian,
      openLayoutCountMedian: m.openLayoutCountMedian,
      openStyleCountMedian: m.openStyleCountMedian,
      openLongTaskMsMedian: m.openLongTaskMsMedian,
      firstColdOpenMs: m.threadOpenMs.samples.find((sample) => sample.cold)?.ms ?? 0,
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
      errors: records.reduce((sum, record) => sum + (record.errors?.length ?? 0), 0),
      opensCompleted: records.reduce((sum, record) => sum + (record.metrics?.opensCompleted ?? 0), 0),
      opensExpected: records.reduce((sum, record) => sum + (record.metrics?.opensExpected ?? 0), 0),
      metrics: values,
    };
  }
  const baseline = (results[baselineArm] ?? []).filter((record) => record.valid);
  const baselineByIndex = new Map(baseline.map((record) => [record.runIndex, metricsOf(record)]));
  for (const [arm, records] of Object.entries(results)) {
    if (arm === baselineArm) continue;
    const paired = {};
    for (const key of ["threadOpenMedianMs", "threadOpenShortWarmMs", "openTaskMsMedian"]) {
      const deltas = [];
      for (const record of records.filter((item) => item.valid)) {
        const base = baselineByIndex.get(record.runIndex);
        if (!base) continue;
        const armValue = metricsOf(record)[key];
        const baseValue = base[key];
        if (!Number.isFinite(armValue) || !Number.isFinite(baseValue)) continue;
        deltas.push(armValue - baseValue);
      }
      paired[key] = {
        n: deltas.length,
        medianDelta: round(median(deltas)),
        minDelta: round(deltas.length ? Math.min(...deltas) : 0),
        maxDelta: round(deltas.length ? Math.max(...deltas) : 0),
        armSlowerCount: deltas.filter((delta) => delta > 0).length,
      };
    }
    summary.paired[arm] = paired;
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

function cell(stats) {
  return `${stats.median} (${stats.min} to ${stats.max})`;
}

function renderText(summary) {
  const lines = [`suiteSha ${summary.suiteSha}`, `runs per arm ${summary.runs}`];
  for (const [arm, value] of Object.entries(summary.arms)) {
    lines.push(
      `${arm}: ${value.valid}/${value.runs} valid, ${value.opensCompleted}/${value.opensExpected} opens, errors ${value.errors}`,
    );
  }
  const arms = Object.keys(summary.arms);
  lines.push("");
  lines.push(["arm", ...tableKeys].join("\t"));
  for (const arm of arms) {
    lines.push([arm, ...tableKeys.map((key) => cell(summary.arms[arm].metrics[key]))].join("\t"));
  }
  if (Object.keys(summary.paired).length) {
    lines.push("");
    lines.push(`paired vs ${summary.baselineArm ?? "stock"}`);
    lines.push(["arm", "metric", "n", "medianDelta", "minDelta", "maxDelta", "armSlowerCount"].join("\t"));
    for (const [arm, paired] of Object.entries(summary.paired)) {
      for (const [key, value] of Object.entries(paired)) {
        lines.push(
          [arm, key, value.n, value.medianDelta, value.minDelta, value.maxDelta, value.armSlowerCount].join("\t"),
        );
      }
    }
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
  for (const [arm, value] of Object.entries(summary.arms)) {
    lines.push(
      `${arm}: ${value.valid}/${value.runs} valid, ${value.opensCompleted}/${value.opensExpected} opens, errors ${value.errors}`,
    );
  }
  lines.push("");
  lines.push(`| arm | ${tableKeys.join(" | ")} |`);
  lines.push(`| --- | ${tableKeys.map(() => "---:").join(" | ")} |`);
  for (const [arm, value] of Object.entries(summary.arms)) {
    lines.push(`| ${arm} | ${tableKeys.map((key) => cell(value.metrics[key])).join(" | ")} |`);
  }
  lines.push("");
  if (Object.keys(summary.paired).length) {
    lines.push(`## Paired vs ${summary.baselineArm ?? "stock"}`, "");
    lines.push("| arm | metric | n | medianDelta | minDelta | maxDelta | armSlowerCount |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
    for (const [arm, paired] of Object.entries(summary.paired)) {
      for (const [key, value] of Object.entries(paired)) {
        lines.push(
          `| ${arm} | ${key} | ${value.n} | ${value.medianDelta} | ${value.minDelta} | ${value.maxDelta} | ${value.armSlowerCount} |`,
        );
      }
    }
    lines.push("");
  }
  lines.push("## Stock versus suite", "");
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
