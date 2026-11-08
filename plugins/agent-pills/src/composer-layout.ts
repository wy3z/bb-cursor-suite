/**
 * The permission control lives in BB's thin footer, but the Cursor layout puts
 * it inside the box, immediately left of the model name. Rather than moving
 * the node (React owns it), keep it in place and pin it over the box: the
 * position is measured from the model button, which is the one anchor whose
 * width changes with the model name.
 */
import { readComposerRestyle } from "./preferences";
import { startRelationalMarkers } from "./relational-markers";
import { startSendContextMenu } from "./send-context-menu";

const PINNED = new WeakMap<
  HTMLElement,
  { permission: HTMLElement; right: string; top: string }
>();

const observedForms = new WeakSet<HTMLElement>();
let resizeObserver: ResizeObserver | null = null;

function rootOf(element: Element | null): HTMLElement | null {
  return element instanceof Element
    ? element.closest<HTMLElement>("[data-follow-up-composer], [data-app-composer]")
    : null;
}

function clear(entry: { permission: HTMLElement; right: string; top: string }) {
  if (entry.permission.style.right === entry.right) {
    entry.permission.style.removeProperty("right");
  }
  if (entry.permission.style.top === entry.top) {
    entry.permission.style.removeProperty("top");
  }
}


const MULTILINE = "data-bb-agent-pills-multiline";
const CONTEXT_SEGMENT = "data-bb-agent-pills-context-segment";

function syncContextSegments(): void {
  for (const segment of document.querySelectorAll<HTMLElement>(
    'section[aria-label="Thread context before sending"] > div:first-child > :is(div, button)',
  )) {
    const native =
      !segment.hasAttribute("data-bb-plugin-root") &&
      !segment.hasAttribute("data-bb-agent-pills") &&
      segment.querySelector("[data-bb-agent-pills]") === null;
    if (segment.hasAttribute(CONTEXT_SEGMENT) !== native) {
      segment.toggleAttribute(CONTEXT_SEGMENT, native);
    }
  }
}

/** Typing inside a composer, watched per form rather than across the page. */
let formWatcher: MutationObserver | null = null;
let watchedForms = new WeakSet<HTMLElement>();

/**
 * Zeron's box is one centred row until the draft wraps or holds an
 * attachment; then the text takes the full width and the controls drop to a
 * bottom row. It only returns to one row once the draft is empty again, so it
 * cannot flicker at the wrap point (the wider multi-line editor would unwrap
 * the text that triggered it).
 */
function syncMultiline(enabled: boolean): void {
  for (const form of document.querySelectorAll<HTMLElement>("form[data-promptbox]")) {
    if (!enabled) {
      form.removeAttribute(MULTILINE);
      continue;
    }
    if (formWatcher && !watchedForms.has(form)) {
      watchedForms.add(form);
      formWatcher.observe(form, { childList: true, subtree: true, characterData: true });
    }
    const content = form.querySelector<HTMLElement>("[data-promptbox-editor-content]");
    const textbox = form.querySelector<HTMLElement>('[role="textbox"]');
    // Attachment tiles render in an expanded-only row of their own, a direct
    // child of the main grid.
    const attachments = Array.from(
      form.querySelectorAll<HTMLElement>(
        "[data-promptbox-main] > [data-promptbox-expanded-only]",
      ),
    ).some((row) => row.offsetHeight > 0);
    const wraps = (content?.offsetHeight ?? 0) > 30;
    const empty = (textbox?.textContent ?? "").trim() === "" && !attachments;
    const multi = form.hasAttribute(MULTILINE) ? !empty : wraps || attachments;
    if (multi) form.setAttribute(MULTILINE, "");
    else form.removeAttribute(MULTILINE);
  }
}

export function syncComposerLayout(enabled: boolean): void {
  syncMultiline(enabled);
  if (!enabled) {
    for (const root of document.querySelectorAll<HTMLElement>(
      "[data-follow-up-composer], [data-app-composer]",
    )) {
      const previous = PINNED.get(root);
      if (previous) {
        clear(previous);
        PINNED.delete(root);
      }
      root.style.removeProperty("--bb-agent-pills-perm-width");
    }
    return;
  }

  for (const permission of document.querySelectorAll<HTMLElement>(
    'button[aria-label="Permission mode"]',
  )) {
    const root = permission.closest<HTMLElement>(
      "[data-follow-up-composer], [data-app-composer]",
    );
    if (!root) continue;

    const form = root.querySelector<HTMLElement>("form[data-promptbox]");
    const model = form?.querySelector<HTMLElement>(
      'button[aria-label^="Provider, model and reasoning"]',
    );
    if (!form || !model) continue;

    const formRect = form.getBoundingClientRect();
    const modelRect = model.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    if (formRect.width === 0 || modelRect.width === 0) continue;

    root.style.setProperty(
      "--bb-agent-pills-perm-width",
      `${permission.offsetWidth}px`,
    );

    const right = `${Math.max(6, rootRect.right - modelRect.left + 6)}px`;
    const top = `${
      modelRect.top -
      rootRect.top +
      Math.max(0, (modelRect.height - permission.offsetHeight) / 2)
    }px`;
    permission.style.right = right;
    permission.style.top = top;
    PINNED.set(root, { permission, right, top });

    if (!observedForms.has(form) && resizeObserver) {
      observedForms.add(form);
      resizeObserver.observe(form);
    }
  }
}

export function startComposerLayout(signal: AbortSignal): () => void {
  startRelationalMarkers(signal);
  startSendContextMenu(signal);
  if (resizeObserver === null && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => schedule());
  }

  let frame = 0;
  function schedule() {
    if (frame !== 0) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (!signal.aborted) syncComposerLayout(readComposerRestyle());
    });
  }

  const mutations = new MutationObserver(() => {
    syncContextSegments();
    schedule();
  });
  mutations.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-bb-plugin-root", "data-bb-agent-pills"],
  });
  formWatcher = new MutationObserver(schedule);
  watchedForms = new WeakSet<HTMLElement>();
  window.addEventListener("resize", schedule);
  syncContextSegments();
  schedule();

  signal.addEventListener("abort", () => {
    mutations.disconnect();
    formWatcher?.disconnect();
    formWatcher = null;
    window.removeEventListener("resize", schedule);
    if (frame !== 0) window.cancelAnimationFrame(frame);
    resizeObserver?.disconnect();
    resizeObserver = null;
    syncComposerLayout(false);
    for (const segment of document.querySelectorAll(`[${CONTEXT_SEGMENT}]`)) {
      segment.removeAttribute(CONTEXT_SEGMENT);
    }
  });

  return schedule;
}
