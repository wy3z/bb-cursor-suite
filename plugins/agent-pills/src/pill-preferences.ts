/**
 * Pills that can be dismissed keep the dismissal in this browser only, like
 * the composer restyle: no server row, just localStorage per thread plus an
 * event so every mounted pill row re-reads without a reload.
 */
import { useCallback, useEffect, useState } from "react";
import { FALLBACK_DISMISS_EVENT, FALLBACK_DISMISS_KEY } from "./channels";

type Dismissals = Record<string, number>;

function readAll(): Dismissals {
  try {
    const raw = window.localStorage.getItem(FALLBACK_DISMISS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const out: Dismissals = {};
    for (const [threadId, seq] of Object.entries(parsed as Dismissals)) {
      if (typeof seq === "number" && Number.isFinite(seq)) out[threadId] = seq;
    }
    return out;
  } catch {
    return {};
  }
}

/** The fallback sequence this thread's reader has already dismissed. */
export function readDismissedFallback(threadId: string): number | null {
  return readAll()[threadId] ?? null;
}

export function writeDismissedFallback(threadId: string, sourceSeq: number): void {
  const next = { ...readAll(), [threadId]: sourceSeq };
  try {
    window.localStorage.setItem(FALLBACK_DISMISS_KEY, JSON.stringify(next));
  } catch {
    // A blocked storage partition only loses persistence, not the live look.
  }
  window.dispatchEvent(new CustomEvent(FALLBACK_DISMISS_EVENT));
}

/** The dismissed sequence for one thread, kept in step across mounted rows. */
export function useFallbackDismissal(threadId: string): [number | null, (seq: number) => void] {
  const [seq, setSeq] = useState<number | null>(() => readDismissedFallback(threadId));

  useEffect(() => {
    setSeq(readDismissedFallback(threadId));
    const sync = () => setSeq(readDismissedFallback(threadId));
    const onStorage = (event: StorageEvent) => {
      if (event.key === FALLBACK_DISMISS_KEY || event.key === null) sync();
    };
    window.addEventListener(FALLBACK_DISMISS_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(FALLBACK_DISMISS_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, [threadId]);

  const dismiss = useCallback(
    (next: number) => {
      writeDismissedFallback(threadId, next);
      setSeq(next);
    },
    [threadId],
  );

  return [seq, dismiss];
}
