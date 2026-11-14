import { decodeModeMention, type ModeRef } from "./model";

export const LEDGER_EVENT_TYPES = [
  "client/turn/requested",
  "client/turn/rejected",
  "system/operation",
  "thread/context/cleared",
] as const;

export interface LedgerEvent {
  seq: number;
  type: string;
  data: unknown;
}

export interface DeliveredMode {
  seq: number;
  requestId: string | null;
  nonce: string | null;
  committed: ModeRef | null;
}

export interface Ledger {
  lastSeq: number;
  entries: DeliveredMode[];
  seen: string[];
}

export const EMPTY_LEDGER: Ledger = { lastSeq: 0, entries: [], seen: [] };
const SEEN_LIMIT = 200;

const MODE_ITEM_PREFIX = "mode:";

interface InputBlock {
  type?: unknown;
  text?: unknown;
  visibility?: unknown;
  mentions?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function deliveredModeOf(input: unknown, pluginId: string): { nonce: string; dest: ModeRef | null; applied: boolean } | null {
  if (!Array.isArray(input)) return null;
  let found: { nonce: string; dest: ModeRef | null } | null = null;
  for (const block of input as InputBlock[]) {
    if (!Array.isArray(block?.mentions)) continue;
    for (const mention of block.mentions as unknown[]) {
      const resource = record(record(mention)?.resource);
      if (resource?.kind !== "plugin" || resource.pluginId !== pluginId || typeof resource.itemId !== "string") continue;
      if (!resource.itemId.startsWith(MODE_ITEM_PREFIX)) continue;
      const decoded = decodeModeMention(resource.itemId.slice(MODE_ITEM_PREFIX.length));
      if (decoded) found = { nonce: decoded.nonce, dest: decoded.dest };
    }
  }
  if (found === null) return null;
  const marker = `(resolved by plugin ${JSON.stringify(pluginId)})`;
  const applied = (input as InputBlock[]).some(
    (block) =>
      block?.visibility === "agent-only" &&
      typeof block.text === "string" &&
      block.text.includes(marker) &&
      block.text.includes("<skill name="),
  );
  return { ...found, applied };
}

export function applyLedgerEvents(ledger: Ledger, events: readonly LedgerEvent[], pluginId: string): Ledger {
  let entries = ledger.entries;
  let lastSeq = ledger.lastSeq;
  let seen = ledger.seen;
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.seq <= lastSeq) continue;
    lastSeq = event.seq;
    const data = record(event.data);
    if (event.type === "client/turn/requested") {
      const delivered = deliveredModeOf(data?.input, pluginId);
      if (!delivered) continue;
      const requestId = typeof data?.requestId === "string" ? data.requestId : null;
      seen = [...seen, delivered.nonce].slice(-SEEN_LIMIT);
      entries = [...entries, { seq: event.seq, requestId, nonce: delivered.nonce, committed: delivered.dest !== null && delivered.applied ? delivered.dest : null }];
    } else if (event.type === "client/turn/rejected") {
      const requestId = data?.requestId;
      if (typeof requestId === "string") entries = entries.filter((entry) => entry.requestId !== requestId);
    } else if (event.type === "system/operation") {
      const metadata = record(data?.metadata);
      if (data?.operation !== "edit_message" || data?.status !== "completed" || typeof metadata?.cutoffSequence !== "number") continue;
      const cutoff = metadata.cutoffSequence;
      const end = typeof metadata.oldMaxSequence === "number" ? metadata.oldMaxSequence : event.seq;
      entries = entries.filter((entry) => entry.seq < cutoff || entry.seq > end);
    } else if (event.type === "thread/context/cleared") {
      entries = [{ seq: event.seq, requestId: null, nonce: null, committed: null }];
    }
  }
  return { lastSeq, entries, seen };
}

export function committedOf(ledger: Ledger): ModeRef | null {
  return ledger.entries.at(-1)?.committed ?? null;
}

export function seenNonces(ledger: Ledger): Set<string> {
  return new Set(ledger.seen);
}
