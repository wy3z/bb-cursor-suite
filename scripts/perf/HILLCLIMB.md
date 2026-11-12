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

## Decision log

| id | hypothesis | change | before | after | delta | gate | verdict | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
