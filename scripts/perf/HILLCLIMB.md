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
- Never measure on a VM that has been suspended and resumed. Boat serves a resumed disk through a lazy filesystem process, which slows every arm unevenly (R7, and the BCS-115 baseline).
- The fixture lives outside `/home/user` (`PERF_ROOT=/var/tmp/bcs117`). Boat sweeps the home directory with `find` and `git status`.
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
| H1 | cursor-sidebar's `:root:has([data-cursor-sidebar-root])` and `group-has-[:focus-visible]` rules force a whole-document style recalc on every open | Root marker attribute set by a hook, focus marker attribute kept by delegated listeners. Measured as 96ee0ec, shipped as baa11ae (same tree), PR #59 | suite 967.5 ms (840 to 1729.5), gap to stock +319 (209 to 983.5), 6/6 | h1 676 ms (596.5 to 810.5), gap to stock +73 (-157 to 125.5), 5/6 | -291.8 ms paired (-919 to -208), faster 6/6 | check cursor-sidebar green, 95 to 103 tests | kept | R3, fixture v1, 6 interleaved runs per arm, 18/18 valid. Style recalc per open 405 to 105 ms (stock 72). Sidebar pixel-identical in default, hover and keyboard-focus states. Raw data `bcs-117-r3.tar.gz` |
| H3a | agent-pills mounts `useActivity` in three components, so each open sends `threadActivity` three or four times and the server reads the whole timeline each time | Module-level store shared by the three callers, one request per key, refreshes coalesced per tick. 7a51185 on `bcs-117-h3a-activity-store`, measured as 560b731 on top of H1 | h1 1059.75 ms (826 to 1313) | h1 plus H3a 1026.25 ms (849.5 to 1322) | +9.8 ms paired (-81 to +144), slower 4/6 | check agent-pills green, 87 to 93 tests | reverted, not shipped | R8, fixture v2, 6 interleaved runs per arm, 24/24 valid. Requests per open 35 to 32.5. Script, style and long tasks per open unchanged. Bounded in advance by R6: removing agent-pills entirely moves the median -7 ms. The -379.5 ms seen in R7 came from a resumed VM and is void |

## Fixture v2 (realistic workload)

James has about 300 live threads with environments and PRs. Fixture v1 has 30 threads and neither. Fixture v2 (branch `bcs-117-fixture`): 3 projects, 300 threads, 50 environments on real worktrees, a fake `gh` serving 10 acme PRs. PR lookups are proven to run (fake `gh` call counts per run).

R2 on fixture v2, main, 6 interleaved pairs, 12/12 valid: stock 1071.5 ms (719.5 to 1306) vs suite 2796.5 ms (1641.5 to 4094), paired +1640.5 ms (839.5 to 3105), 6/6. Style recalc per open 128 ms vs 1240 ms. Script per open 454 ms vs 865 ms. The VM ran at load 4 to 8 on 2 cores, so the spread is wide. Raw data `bcs-117-r2.tar.gz`.

### H1 on fixture v2

| run | harness | stock ms (range) | suite ms (range) | H1 ms (range) | H1 minus suite, paired | H1 minus stock, paired |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| R4, VM 1 | d68329f plus fake-gh fix, fixture under `/home/user` | 925.8 (669.5 to 1276) | 2355 (1571.5 to 3849.5) | 1451.5 (1103 to 3475) | -499.8 (-1481.5 to +164.5), faster 5/6 | +528.5 (126.5 to 2319.5), 6/6 |
| R5, VM 2 | 6b245e7, fixture under `/var/tmp`, settle wait | 633 (585 to 851.5) | 1573 (1285.5 to 1933) | 986.75 (843.5 to 1323) | -526.8 (-745 to -312), faster 6/6 | +387.5 (166.5 to 560.5), 6/6 |

- R4 ran at load 5 to 7 on 2 cores. Boat's own tooling sweeps `/home/user` with `find` and `git status`, and fixture v2 put 50 worktrees there. R5 moved the fixture to `/var/tmp` and waits for the BB process tree to go quiet before navigating, which is closer to a long-running BB. R5 is the number to quote.
- R5 per open, H1 minus stock: script +197 ms (81 to 292), style +95 ms (45 to 136), layout +9 ms, all 6/6. Requests per open 34.5 vs 17.
- The predicate is not met on fixture v2. On fixture v1 the gap after H1 (+73 ms, -157 to +125.5) sits inside the stock range.

## Harness changes after R1

- a55cfe7: per-open CPU and layout counters, arms from other checkouts, paired deltas, native-to-caller profile attribution.
- 77d05ff to f44e96a: fixture v2 and the fake `gh`.
- 6b245e7: every path under `PERF_ROOT`, settle wait, server CPU per open. Frozen here for fixture v2.

## Diagnostics that did not become a change

| what | evidence (local rig on H1 unless noted) | decision |
| --- | --- | --- |
| The 38 remaining `:has()` rules in the suite | Each deleted alone: long tasks per switch 78.5 to 95 ms against controls of 78.5 to 88.5. All deleted together: 94 to 69 ms | Not pursued. No rule has a cost of its own |
| Selector matching per stylesheet | Blink selector stats, 4 switches: every plugin stylesheet costs 13 to 38 ms, built-in ones included. BB scopes plugin CSS with `:where([data-bb-plugin="x"], [data-bb-plugin-root]:not([data-bb-plugin])) .util`, and about two thirds of match attempts miss the fast reject | BB core design. Upstream issue material |
| Duplicate RPCs per open | agent-pills `threadActivity` x3 to 4, pull-requests `subscriptions_list` x3 to 4 and `linked_list` x2 for the same thread. Each hook is mounted by the slot's `useVisible` and by two renderers. pull-requests also calls both once per descendant thread | Candidate, sized by R6 |
| `ThreadRow` re-render on every switch | No `memo` in `ThreadTree.tsx`, `activeThreadId` sits in the row context. Sidebar DOM changes 6 attributes per switch. v2 profile bills cursor-sidebar about 43 ms per open after H1 | Candidate, sized by R6 |

## Fixture artifact fixed before R6 (a931aa1)

The fake `gh` re-derived every PR's SHA and file list on each call, about 40 `git` processes per call (20 calls took 1851 ms, 480 ms after the fix, identical output). Real `gh` spawns none. Arms with more PR lookups paid server CPU a real machine would not. Numbers from R2, R4 and R5 carry that artifact in every arm that has environments. H1's delta is style recalculation and does not depend on it.

## R6: leave one plugin out on top of H1 (VM 2, harness a931aa1, fixture v2, 5 runs per arm, 40/40 valid)

| arm | thread-open median ms (range) | vs stock, paired | vs H1, paired | requests per open |
| --- | ---: | ---: | ---: | ---: |
| stock | 620.5 (580.5 to 688) | | | 16 |
| H1, all seven plugins | 823 (806.5 to 862) | +202.5 (118 to 252), 5/5 | | 34.5 |
| H1 without cursor-sidebar | 778.5 (704 to 1022.5) | +123.5 (40 to 413), 5/5 | -79 (-113 to +160), slower 2/5 | 35.5 |
| H1 without agent-pills | 855 (718 to 1001) | +222 (98 to 330), 5/5 | -7 (-105 to +142), slower 2/5 | 26.5 |
| H1 without pull-requests | 908.5 (759.5 to 1486) | +299 (179 to 816), 5/5 | +46.5 (-58 to +626), slower 4/5 | 25.5 |
| H1 without filetree | 1049 (1008 to 2024) | +431 (387 to 1353), 5/5 | +232 (178 to 1164), slower 5/5 | 35 |
| H1 without projects | 994 (896 to 1084) | +381 (306 to 426), 5/5 | +187.5 (80 to 224), slower 5/5 | 34.5 |
| H1 without ui-tweaks | 898 (784 to 1237) | +288.5 (96 to 566), 5/5 | +36 (-23 to +378), slower 3/5 | 33.5 |

- After H1 the gap on fixture v2 is +202.5 ms (118 to 252). Per open: script +104 ms, style +62 ms, long tasks +115 ms, server CPU +47 ms.
- No single plugin owns the remainder. Removing a whole plugin recovers at most 79 ms (cursor-sidebar, and that is inside its own spread). Any fix inside one plugin is bounded by that plugin's row.
- Removing filetree or projects makes opens slower, 5/5 each. Not explained. Without projects, cursor-sidebar's `listLeads` call fails with a 404 on every open.

## R7 is void

VM 1 was resumed from suspend for R7 (H1 against H1 plus H3a). Its H1 arm read 2559 ms against 835 ms for stock, with single opens of 4 to 11 seconds, while the same commit on VM 2 reads 823 ms. A lazy filesystem process held 627 MB and the VM was swapping. H3a is re-measured in R8 on VM 2.

## R8: final before and after (VM 2, harness a931aa1, fixture v2, 6 runs per arm, 24/24 valid, 480/480 opens)

| arm | thread-open median ms (range) | p90 ms | style recalc ms per open | long-task ms per run | vs stock, paired |
| --- | ---: | ---: | ---: | ---: | ---: |
| stock | 648.75 (620 to 770.5) | 943 | 84 | 6879.5 | |
| suite on main | 1730 (1368.5 to 2414.5) | 2613.5 | 974 | 33232.5 | +1068.5 (748.5 to 1777.5), 6/6 |
| H1 | 1059.75 (826 to 1313) | 1278.5 | 183 | 14112 | +344.2 (87 to 676), 6/6 |
| H1 plus H3a | 1026.25 (849.5 to 1322) | 1510 | 186 | 15666.5 | +331 (97.5 to 686.5), 6/6 |

- H1 minus suite: -670.2 ms paired (-1167 to -471), faster 6/6. First cold open 4477 ms to 2754 ms. Boot JS bytes unchanged (3,521,263 vs 2,043,536 stock).
- H1 minus stock over the 11 pairs measured with the final harness (R6 and R8): +236.5 ms (87 to 676), slower 11/11. Stock 637 ms (580.5 to 770.5), H1 859.5 ms (806.5 to 1313).
- Limiter of what is left, from the per-open counters: script +104 to +171 ms, style +62 to +86 ms. The R8 h1 profile was taken without plugins by mistake and is not used. The earlier v2 profile (`bcs-117-prof-v2.tar.gz`) bills cursor-sidebar about 43 ms per open and agent-pills about 12 ms under the profiler.

## Verdict

- Fixture v1 (30 threads): gap +319 ms to +73 ms (-157 to +125.5). Inside the stock range. Predicate met.
- Fixture v2 (300 threads, environments, PRs): gap +1068.5 ms to +236.5 ms (87 to 676). Outside the stock range (580.5 to 770.5). Predicate not met.
- Stopped because the remaining ideas are bounded below what the harness can resolve. R6 shows no single plugin owns more than 79 ms, and the one in-plugin fix tried after H1 (H3a) measured nothing.
- Attempts: 2 measured changes (H1 kept, H3a reverted), 6 leave-one-out bounds, 3 rig diagnostics that did not become changes.

## Next ideas, best first

1. The other 38 `:has()` rules across the five stylesheets. Together they are worth about a quarter of the remaining long-task time on the local rig (94 to 69 ms), though none matters alone. Each needs its own like-for-like rewrite and a parity check.
2. Upstream to BB: plugin CSS scoping (`:where([data-bb-plugin="x"], [data-bb-plugin-root]:not([data-bb-plugin])) .util`) makes every plugin's utility rules a slow-path match for every element. That is most of the +62 to +86 ms of style that is left, and stock's built-in plugins pay it too.
3. cursor-sidebar's row tree has no `memo` and carries `activeThreadId` in its context. Bounded by R6 at 79 ms.
4. pull-requests calls `linked_list` and `subscriptions_list` once per descendant thread, three times over. No measured thread in the fixture has children, so this is unmeasured. A lead thread with many workers would show it.
5. Boot JS bytes (secondary metric, untouched): the hugeicons table is bundled twice, filetree inlines a 1.2 MB icon table and 783 KB of worker source, zod is bundled six times.

