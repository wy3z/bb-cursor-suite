import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";

const TOGGLE_SELECTOR = [
  'form[data-promptbox] button[aria-pressed][aria-label^="Compact "][aria-label$=" tokens before sending"]',
  'form[data-promptbox] button[aria-pressed][aria-label^="Keep all "][aria-label$=" tokens of history"]',
].join(", ");

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
let present = false;

function check() {
  const next = document.querySelector(TOGGLE_SELECTOR) !== null;
  if (next === present) return;
  present = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (observer === null) {
    observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-pressed"],
    });
    check();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

export function useCompactToggleVisible(): boolean {
  return useSyncExternalStore(subscribe, () => present, () => false);
}

interface ToggleState {
  button: HTMLButtonElement;
  pressed: boolean;
  label: string;
  text: string;
}

function findToggle(from: HTMLElement | null): ToggleState | null {
  const scope = from?.closest<HTMLElement>("[data-thread-window]") ?? document;
  const button = scope.querySelector<HTMLButtonElement>(TOGGLE_SELECTOR);
  if (!button) return null;
  return {
    button,
    pressed: button.getAttribute("aria-pressed") === "true",
    label: button.getAttribute("aria-label") ?? "",
    text: (button.textContent ?? "").trim(),
  };
}

function same(a: ToggleState | null, b: ToggleState | null): boolean {
  return (
    a?.button === b?.button &&
    a?.pressed === b?.pressed &&
    a?.label === b?.label &&
    a?.text === b?.text
  );
}

export function CompactPill() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [toggle, setToggle] = useState<ToggleState | null>(null);
  const visible = useCompactToggleVisible();

  useEffect(() => {
    let frame = 0;
    const sync = () => {
      frame = 0;
      const next = findToggle(rootRef.current);
      setToggle((current) => (same(current, next) ? current : next));
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(sync);
    };
    sync();
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-pressed"],
    });
    return () => {
      mutations.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [visible]);

  return (
    <div className="bb-agent-pills" data-bb-agent-pills="" ref={rootRef}>
      {toggle ? (
        <div className="bb-agent-pills__row">
          <button
            type="button"
            className="bb-agent-pills__pill"
            data-group="compact"
            data-tone={toggle.pressed ? "compact" : undefined}
            aria-pressed={toggle.pressed}
            aria-label={toggle.label}
            title={
              toggle.pressed
                ? `${toggle.label}. Click to keep full history`
                : `${toggle.label}. Click to compact first`
            }
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => toggle.button.click()}
          >
            <Icon name="CircleArrowShrink" fallback="Minimize2" aria-hidden />
            <span className="bb-agent-pills__label">{toggle.text}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
