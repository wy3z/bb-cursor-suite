/**
 * Small pieces the pills and their popovers share: elapsed labels, the status
 * dot and the two glyphs BB uses for background work.
 */
import { useEffect, useState } from "react";
import type { PillState } from "../pill-data";

export function formatElapsed(startedAt: number, now: number): string {
  return formatDuration(Math.max(0, Math.round((now - startedAt) / 1000)));
}

/** "45s", "12m", "2h 5m", "3d 4h" — the same ladder BB's cards use. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "1.2k" for token counts, plain below a thousand. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 100_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${Math.round(tokens / 1000)}k`;
}

/** "opencode-go/deepseek-v4.1-flash" -> "deepseek-v4.1-flash". */
export function shortModel(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function StateDot({ state }: { state: PillState }) {
  return <span className="bb-agent-pills__dot" data-state={state} aria-hidden="true" />;
}

export function AgentIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 12.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
      <path d="M4.5 20c.8-3.1 3.8-5 7.5-5s6.7 1.9 7.5 5" />
    </svg>
  );
}

export function CommandIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m5.5 7.5 4.5 4.5-4.5 4.5" />
      <path d="M12.5 16.5h6" />
    </svg>
  );
}
