import { shortAge } from "@wy3z/bb-suite/time";
import type { Priority, Status } from "./contracts";
import { columnOf, type Column } from "./status";

export const STATUS_LABEL: Record<Status, string> = {
  backlog: "Queued",
  todo: "Queued",
  in_progress: "In Progress",
  in_review: "For Review",
  done: "Done",
  canceled: "Canceled",
};

const RING = { cx: 8, cy: 8, r: 6.25, fill: "none", stroke: "currentColor", strokeWidth: 1.4 } as const;

function StatusMark({ column }: { column: Column }) {
  if (column === "todo") return <circle {...RING} strokeDasharray="2.4 2.5" />;
  if (column === "in_review") return <circle {...RING} />;
  if (column === "in_progress") {
    return (
      <>
        <circle {...RING} />
        <path d="M8 4.25a3.75 3.75 0 0 1 0 7.5z" fill="currentColor" />
      </>
    );
  }
  if (column === "done") {
    return (
      <>
        <circle {...RING} />
        <path d="M5.3 8.2l1.8 1.8 3.6-3.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </>
    );
  }
  return (
    <>
      <circle {...RING} />
      <path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  );
}

export function StatusGlyph({ status }: { status: Status }) {
  const column = columnOf(status);
  return (
    <svg className="bbp-status" data-status={column} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <StatusMark column={column} />
    </svg>
  );
}

export function PriorityGlyph({ priority }: { priority: Priority }) {
  if (priority === "none") return null;
  if (priority === "urgent") {
    return (
      <svg className="bbp-priority" data-priority="urgent" viewBox="0 0 14 14" aria-label="Urgent" role="img">
        <rect x="1.5" y="1.5" width="11" height="11" rx="3" fill="currentColor" />
        <path d="M7 4v3.6" stroke="var(--bbp-glyph-ink)" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="7" cy="9.9" r="0.95" fill="var(--bbp-glyph-ink)" />
      </svg>
    );
  }
  const bars = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return (
    <svg className="bbp-priority" data-priority={priority} viewBox="0 0 14 14" aria-label={`${priority} priority`} role="img">
      {[0, 1, 2].map((index) => (
        <rect
          key={index}
          x={2 + index * 3.6}
          y={9.5 - index * 2.8}
          width="2.4"
          height={2.5 + index * 2.8}
          rx="0.8"
          fill="currentColor"
          opacity={index < bars ? 1 : 0.28}
        />
      ))}
    </svg>
  );
}

export function Dot({ tone }: { tone: "working" | "input" | "failed" | "idle" }) {
  if (tone === "working") return <span className="bbs-live-orb" aria-hidden="true" />;
  return <span className="bbp-dot" data-tone={tone} aria-hidden="true" />;
}

export function formatElapsed(fromIso: string | number, now: number): string {
  return shortAge(fromIso, now);
}

export function ProjectGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true" focusable="false">
      <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2.5" />
      <path d="M5 4.75v6.5M8 4.75v3M11 4.75v5" />
    </svg>
  );
}

export function FilterIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M2.5 4.5h11" />
      <path d="M4.5 8h7" />
      <path d="M6.5 11.5h3" />
    </svg>
  );
}

export function CommitGlyph() {
  return (
    <svg className="bbp-commit-glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="2.6" />
      <path d="M1 8h4.4M10.6 8H15" strokeLinecap="round" />
    </svg>
  );
}

export function ProgressRing({ value }: { value: number }) {
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <svg className="bbp-progress-ring" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={`${circumference * clamped} ${circumference}`}
        strokeLinecap="round"
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
