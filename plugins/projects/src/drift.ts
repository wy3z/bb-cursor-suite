import { describeDrift, type Drift } from "./reconcile";

export const DRIFT_CHECK_MS = 5 * 60_000;
export const DRIFT_GRACE_MS = 10 * 60_000;
export const DRIFT_REPEAT_MS = 2 * 60 * 60_000;
export const DRIFT_MIN_GAP_MS = 60 * 60_000;

export interface DriftState {
  firstSeen: Record<string, number>;
  pinged: Record<string, number>;
  lastPingAt: number | null;
}

export const EMPTY_DRIFT_STATE: DriftState = { firstSeen: {}, pinged: {}, lastPingAt: null };

export function driftSignature(drift: Pick<Drift, "key" | "suggested">): string {
  return `${drift.key}>${drift.suggested}`;
}

export function planDriftPing(
  state: DriftState,
  drifts: readonly Drift[],
  now: number,
  options: { graceMs?: number; repeatMs?: number; minGapMs?: number } = {},
): { ping: Drift[] | null; state: DriftState } {
  const graceMs = options.graceMs ?? DRIFT_GRACE_MS;
  const repeatMs = options.repeatMs ?? DRIFT_REPEAT_MS;
  const minGapMs = options.minGapMs ?? DRIFT_MIN_GAP_MS;
  const firstSeen: Record<string, number> = {};
  const pinged: Record<string, number> = {};
  for (const drift of drifts) {
    const signature = driftSignature(drift);
    firstSeen[signature] = state.firstSeen[signature] ?? now;
    if (state.pinged[signature] !== undefined) pinged[signature] = state.pinged[signature]!;
  }
  const ripe = drifts.filter((drift) => now - firstSeen[driftSignature(drift)]! >= graceMs);
  const due = ripe.filter((drift) => {
    const last = pinged[driftSignature(drift)];
    return last === undefined || now - last >= repeatMs;
  });
  const tooSoon = state.lastPingAt !== null && now - state.lastPingAt < minGapMs;
  if (due.length === 0 || tooSoon) return { ping: null, state: { firstSeen, pinged, lastPingAt: state.lastPingAt } };
  for (const drift of ripe) pinged[driftSignature(drift)] = now;
  return { ping: ripe, state: { firstSeen, pinged, lastPingAt: now } };
}

export function driftPrompt(prefix: string, drifts: readonly Drift[]): string {
  const applicable = drifts.some((drift) => drift.applicable);
  return [
    `[Board drift] ${prefix}`,
    "",
    `${drifts.length} card${drifts.length === 1 ? "" : "s"} on the ${prefix} board disagree${drifts.length === 1 ? "s" : ""} with the evidence:`,
    ...drifts.map((drift) => `- ${describeDrift(drift)}`),
    "",
    `Check each one and write the status now. If the stored status is right, comment "Holding: <why>" on the card: that holds it until the evidence changes. Other comments don't. Done is yours to write after you check the evidence.`,
    applicable ? `\`bb projects reconcile ${prefix} --apply\` applies the roll-up and idle moves; the rest are yours to write.` : "",
    "Don't notify the user unless something needs them.",
  ]
    .filter((line, index, all) => line !== "" || (index > 0 && all[index - 1] !== ""))
    .join("\n")
    .trim();
}
