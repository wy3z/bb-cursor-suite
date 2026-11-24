const SURFACE = "--bbs-composer-surface";
const EDGE = "--bbs-composer-border";

function visible(color: string): boolean {
  return color !== "" && color !== "transparent" && color !== "rgba(0, 0, 0, 0)";
}

function write(root: HTMLElement, name: string, value: string): void {
  if (!visible(value)) {
    if (root.style.getPropertyValue(name) !== "") root.style.removeProperty(name);
    return;
  }
  if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
}

function composerForm(): HTMLElement | null {
  const forms = Array.from(document.querySelectorAll<HTMLElement>("form[data-promptbox]")).filter(
    (form) => form.offsetWidth > 0,
  );
  return forms.find((form) => !form.matches(":focus-within")) ?? forms[0] ?? null;
}

let resync: (() => void) | null = null;

export function syncComposerSurface(): void {
  const form = composerForm();
  if (!form) return;
  const moving = form.getAnimations();
  if (moving.length > 0) {
    void Promise.allSettled(moving.map((animation) => animation.finished)).then(() => resync?.());
    return;
  }
  const root = document.documentElement;
  const style = getComputedStyle(form);
  write(root, SURFACE, style.backgroundColor);
  if (!form.matches(":focus-within")) write(root, EDGE, style.borderTopColor);
}

export function clearComposerSurface(): void {
  const root = document.documentElement;
  root.style.removeProperty(SURFACE);
  root.style.removeProperty(EDGE);
}

export function startComposerSurface(signal: AbortSignal, schedule: () => void): void {
  resync = schedule;
  const theme = new MutationObserver(schedule);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  theme.observe(document.head, { childList: true, subtree: true, characterData: true });
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", schedule);
  document.addEventListener("focusout", schedule, true);
  signal.addEventListener("abort", () => {
    theme.disconnect();
    scheme.removeEventListener("change", schedule);
    document.removeEventListener("focusout", schedule, true);
    resync = null;
    clearComposerSurface();
  });
}
