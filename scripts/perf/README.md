# BB performance harness (BCS-115)

Measures BB thread-open and cold-load performance for the stock app and for an arm with the Cursor Suite plugins installed. Every run starts from the same pristine fake-data snapshot and runs on the same VM, with `bb-app@0.49.0` on loopback ports 39581/39582.

## Files

- `schema.json` — the run-record contract.
- `setup-vm.sh` — installs `bb-app@0.49.0`, clones the suite at a commit, runs `npm ci`, builds every plugin, installs `playwright-core`, and seeds the fixture snapshot.
- `seed-fixture.mjs` — builds the fake project, 100 tasks, and 30 threads, then stores a pristine `cp -a` snapshot.
- `run-arm.mjs` — one measured run for one arm.
- `profile-arm.mjs` — one unmeasured CDP-profiled thread open per arm, for the limiter.
- `drive.mjs` — interleaves arms, writes `results/<arm>/<run>.json`, and writes `results/summary.json` plus `results/summary.md`.

## Setup

```bash
scripts/perf/setup-vm.sh <suite-sha>
```

Defaults assume `~/perf` for everything. Override with `PERF_ROOT`, `CHROME_BIN`, or pass `--app`, `--cli`, `--snapshot`, and `--chrome` to the scripts.

## Run an arm pair

```bash
cd ~/perf/suite
node scripts/perf/drive.mjs --runs 3 --arms stock,suite
```

A single arm:

```bash
node scripts/perf/run-arm.mjs \
  --arm suite --run-index 1 --order 2 \
  --suite "$PWD" --plugins cursor-sidebar,agent-pills,filetree,projects,pull-requests,ui-tweaks,machine-boat
```

Useful flags: `--idle-seconds` (default 60), `--opens` (default 20), `--out`, `--snapshot`.

## Fixture

- One project on a throwaway git repo at `~/perf/fixture/repo`.
- A Tasks board linked to that project with 100 tasks across mixed statuses and priorities.
- 30 threads in BB's own database: 5 long threads with 100 turns each (200 user/agent messages plus reasoning, command, tool-call, and file-change items, with code blocks and tool output) and 25 short threads with 4 turns.
- The measured threads are pinned so the sidebar exposes them without scrolling.
- Thread transcripts are inserted directly into `bb.db` using BB's stored event schema. No real provider login is used or spent. Tasks are created through the real Tasks plugin CLI.

The snapshot is warmed after seeding by starting BB once and letting the migration sweeps settle, then stopping it. Runs copy the snapshot with `cp -a` and never mutate it.

## What is measured

- `navToSidebarMs` — wall time from navigation start until the fixture threads are visible in the sidebar.
- `domContentLoadedMs` — `navigation.domContentLoadedEventEnd`.
- `jsBytes` / `bootJsBytes` — transferred bytes for `Script` requests from navigation until every enabled plugin app.js has loaded (same boot boundary for every arm).
- `bootEndMs` — navigation start until that boot boundary.
- `openJsBytes`, `openJsBytesMedian` — `Script` bytes fetched inside the 20 open windows, total and per open.
- `sessionJsBytes`, `unattributedJsBytes` — whole-session `Script` bytes, and any bytes outside boot plus open windows.
- `pluginAppUrls` — every plugin app.js URL fetched in the run, mapped to its plugin id, with bytes and whether it arrived during boot.
- `requestCount` — network requests during the cold load.
- `longTaskCount`, `longTaskMs` — long tasks for the whole run (cold load plus every thread open).
- `threadOpenMs` — 20 opens alternating long and short transcripts over 5 long and 5 short threads, so every thread is opened cold once and warm once. Readiness means the last transcript message and the composer are both visible and the main thread has had no long task for 250 ms.
- `threadOpenRequests` — requests and transferred bytes fired by the first cold thread open in the run.
- `firstColdOpenMs` — the first cold open in the summary.
- `serverRssMB` — BB server RSS after the browser closes.
- `serverIdleCpuPct60s` — total BB server CPU over a 60 s idle window, as a percentage of one core.

`errors[]` holds failed requests, console errors, plugin-load failures, and harness failures. A run with a plugin-load or harness failure is invalid and excluded from the summary. The 409 from `/thread-storage/location` is expected for synthetic threads with no environment and is ignored.

## Suite arm

The suite arm installs all seven plugins from `.bb/plugins.json` from the checkout, restarts BB, waits until every requested plugin reports `running`, then measures. A missing or non-running plugin makes the run invalid and is recorded in `errors[]`.

## Smoke results

`results/summary.json` from a 1-run pair on the BCS-115 VM. Thread-open median 529 ms stock vs 1052.5 ms suite, p90 790 ms vs 3000 ms; first cold open 3731 ms vs 9058 ms. One run is not enough for a verdict: `navToSidebarMs` is dominated by provider catalog prewarm and migration timing, so use at least 3 runs per arm.
