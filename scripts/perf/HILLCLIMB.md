# Thread-open hill-climb (BCS-117)

Goal: opening a thread in BB should feel snappy. This log tracks the part the suite controls, the extra thread-open time the seven plugins add over stock BB.

## Metric

- Primary: thread-open median, full suite minus stock BB. Paired, interleaved runs on one boat VM, same fixture snapshot, `bb-app@0.49.0`.
- Secondary: p90, first cold open, long-task ms, boot JS bytes, per-open main-thread task ms and layout count.
- Better is lower.
- Stop when the paired median gap sits inside the stock arm's run-to-run range on the same VM over at least 5 pairs, and at least 6 hypotheses have been measured. Also stop when the remaining ideas cost more than they return.

## Rules

- One change, one measurement, keep or revert.
- At least 5 runs per arm, interleaved. Report median and range.
- The limiter comes from a profiled run that is not reported.
- A run with a plugin-load or harness error is invalid.
- Boat suspends a sandbox after 15 idle minutes, so a measurement worker polls at least every 4 minutes.

## Starting evidence (BCS-115, not trusted as a baseline)

- thr_tj7b9s2843: stock 676 ms vs suite 996.5 ms median, 7 pairs, contaminated by a mid-run suspend.
- Same data split by open kind, pre-suspend runs: warm reopen of a 4-turn thread is about 450 ms stock vs 700 to 800 ms suite. Long tasks per open are about 100 to 200 ms stock vs 400 to 500 ms suite. The suite cost is a fixed charge per thread switch, not a function of transcript length.
- Single profiled open: `setAttribute` 25 ms to 127 ms, `getBoundingClientRect` 53 ms to 161 ms, one cursor-sidebar function 60 ms self.
- Add-one-plugin slices: agent-pills +64 ms, pull-requests +40 ms, both inside noise.

## Baseline, re-measured (R1, harness a55cfe7, fixture v1)

One boat VM (2 vCPU, 3916 MB), 8 arms interleaved, 5 runs per arm, 20 opens per run, 40/40 runs valid, 800/800 opens. Raw data: `bcs-117-r1.tar.gz` on BCS-117.

| arm | thread-open median ms (range) | paired vs stock (range), slower | style recalc ms per open | long-task ms per open |
| --- | ---: | ---: | ---: | ---: |
| stock | 511 (501.5 to 612.5) | | 51 | 99 |
| suite | 824.5 (813 to 909.5) | +313.5 (247 to 372), 5/5 | 346 | 409.5 |
| suite without cursor-sidebar | 604 (597 to 679.5) | +98.5 (-15.5 to 172), 4/5 | 82 | 160 |
| suite without ui-tweaks | 856 (794.5 to 905.5) | +306 (257 to 385.5), 5/5 | 320 | 403 |
| suite without filetree | 887.5 (806.5 to 960) | +340 (273 to 458.5), 5/5 | 360 | 460 |
| suite without pull-requests | 829 (787 to 924) | +311.5 (263 to 387.5), 5/5 | 329 | 388.5 |
| suite without projects | 857.5 (778.5 to 955) | +342.5 (241 to 402.5), 5/5 | 335 | 432 |
| suite without agent-pills | 811.5 (781 to 983.5) | +283.5 (199 to 482), 5/5 | 328 | 386.5 |

- The gap is +313.5 ms and it is style recalculation: `RecalcStyleDuration` per open is 51 ms stock and 346 ms suite, a +295 ms difference.
- cursor-sidebar owns about 215 ms of the gap. No other single plugin moves the median outside the suite arm's range.
- Limiter (profiled run, not reported, 6 opens): `setAttribute("contenteditable")` in BB's composer is 41 ms stock and 980 ms suite. That call forces the pending style flush, so it is where the recalculation is billed.
- agent-pills adds 8 layouts per open (20 with, 12 without) at about 4 ms of layout time.

## Mechanism (local headless rig on a fake-data BB, diagnostic only)

- Long-task time per thread switch: about 309 to 337 ms as shipped, about 80 ms with every `:has()` rule in cursor-sidebar's stylesheet deleted.
- Two families carry it, and either alone keeps the cost near 280 ms: `:root:has([data-cursor-sidebar-root])` (39 lines of `app.css`, 17 compiled rules) and Tailwind `group-has-[:focus-visible]` (7 class strings, 4 compiled rules).
- The sidebar DOM changes 6 attributes per switch. It is not re-mounting.

## Decision log

| id | hypothesis | change | before | after | delta | gate | verdict | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
