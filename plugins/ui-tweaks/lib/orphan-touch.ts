export interface OrphanTouchTarget {
  readonly isConnected: boolean;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface OrphanTouchHost {
  addEventListener(
    type: "touchstart",
    listener: (event: Event) => void,
    options: { capture: boolean; passive: boolean; signal: AbortSignal },
  ): void;
}

export function forwardOrphanedTouchEnds(
  document: OrphanTouchHost,
  signal: AbortSignal,
  cancel: (ending: Event) => void,
): void {
  document.addEventListener(
    "touchstart",
    (event) => {
      const target = event.target as OrphanTouchTarget | null;
      if (target === null || typeof target.addEventListener !== "function") return;
      const settle = (ending: Event) => {
        target.removeEventListener("touchend", settle);
        target.removeEventListener("touchcancel", settle);
        if (target.isConnected || signal.aborted) return;
        cancel(ending);
      };
      target.addEventListener("touchend", settle);
      target.addEventListener("touchcancel", settle);
    },
    { capture: true, passive: true, signal },
  );
}

export function dispatchWindowTouchCancel(ending: Event): void {
  if (typeof TouchEvent === "undefined") return;
  const touches = (ending as TouchEvent).changedTouches;
  window.dispatchEvent(
    new TouchEvent("touchcancel", {
      bubbles: true,
      cancelable: false,
      touches: [],
      targetTouches: [],
      changedTouches: touches ? Array.from(touches) : [],
    }),
  );
}
