import { useState } from "react";

export const NAVIGATION_NOTICE_KEY = "bb-plugin-cursor-sidebar:navigation-notice:v1";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(NAVIGATION_NOTICE_KEY) === "dismissed";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(NAVIGATION_NOTICE_KEY, "dismissed");
  } catch {}
}

export function NavigationNotice({ layout }: { layout: "Compact" | "Cursor" }) {
  const [dismissed, setDismissed] = useState(() => typeof window === "undefined" || readDismissed());
  if (dismissed) return null;
  return (
    <div
      role="note"
      aria-label="Cursor Sidebar navigation"
      data-cursor-navigation-notice=""
      className="cs-row-inset shrink-0 pb-1 pt-2"
    >
      <div className="rounded-md border border-sidebar-border bg-sidebar-accent/40 px-2.5 py-2 text-xs leading-snug text-sidebar-foreground">
        <p>
          Cursor Sidebar has switched the sidebar navigation to its {layout} layout.
        </p>
        <p className="mt-1 text-muted-foreground">
          To use BB&apos;s own, pick Rail or Top list under Settings → Appearance → Navigation.
        </p>
        <button
          type="button"
          className="mt-1.5 rounded px-1.5 py-0.5 text-xs font-medium text-sidebar-foreground outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => {
            writeDismissed();
            setDismissed(true);
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
