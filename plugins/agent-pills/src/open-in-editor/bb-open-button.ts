export const COMPOSER_ROOT = "[data-app-composer]";
export const PRIMARY_COMPOSER = '[data-app-composer][data-app-composer-role="primary"]';
export const PANE = "[data-split-pane-id]";
export const HEADER_ACTIONS = "[data-thread-header-workflow-actions]";
export const RESPONSIVE_ACTION = "[data-thread-header-responsive-action]";
export const OPEN_PREFIX = "Open workspace in ";
export const CHOOSER_LABEL = "Choose another app to open workspace";
export const HIDDEN_ATTRIBUTE = "data-bb-agent-pills-open-in-hidden";

export interface BbOpenButton {
  pane: HTMLElement;
  header: HTMLElement;
  action: HTMLElement;
}

function buttons(root: Element, match: (label: string) => boolean): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("button[aria-label]")).filter((button) => match(button.getAttribute("aria-label") ?? ""));
}

const isOpen = (label: string) => label.startsWith(OPEN_PREFIX) && label.length > OPEN_PREFIX.length;
const isChooser = (label: string) => label === CHOOSER_LABEL;

export function findBbOpenButton(anchor: Element | null): BbOpenButton | null {
  const composer = anchor?.closest<HTMLElement>(COMPOSER_ROOT) ?? null;
  if (composer === null || !composer.matches(PRIMARY_COMPOSER)) return null;
  const pane = composer.closest<HTMLElement>(PANE);
  if (pane === null) return null;
  const composers = pane.querySelectorAll(PRIMARY_COMPOSER);
  if (composers.length !== 1 || composers[0] !== composer) return null;
  const headers = pane.querySelectorAll<HTMLElement>(HEADER_ACTIONS);
  if (headers.length !== 1) return null;
  const [header] = headers;
  if (header!.contains(composer)) return null;
  if (buttons(pane, isOpen).length !== 1 || buttons(pane, isChooser).length !== 1) return null;
  const actions = Array.from(header!.querySelectorAll<HTMLElement>(RESPONSIVE_ACTION)).filter(
    (action) => action.parentElement === header && buttons(action, isOpen).length === 1 && buttons(action, isChooser).length === 1,
  );
  if (actions.length !== 1) return null;
  const [action] = actions;
  if (buttons(action!, () => true).length !== 2) return null;
  return { pane, header: header!, action: action! };
}

function related(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  const selector = `${HEADER_ACTIONS}, ${PRIMARY_COMPOSER}`;
  return element.matches(selector) || element.closest(HEADER_ACTIONS) !== null || element.querySelector(selector) !== null;
}

export function touchesOpenButton(record: Pick<MutationRecord, "target" | "addedNodes" | "removedNodes">): boolean {
  return related(record.target) || Array.from(record.addedNodes).some(related) || Array.from(record.removedNodes).some(related);
}

export function watchBbOpenButton(anchor: HTMLElement): () => void {
  let hidden: HTMLElement | null = null;
  const release = () => {
    hidden?.removeAttribute(HIDDEN_ATTRIBUTE);
    hidden = null;
  };
  const sync = () => {
    const found = findBbOpenButton(anchor);
    if (found !== null && found.action === hidden && hidden.hasAttribute(HIDDEN_ATTRIBUTE)) return;
    release();
    if (found === null) return;
    found.action.setAttribute(HIDDEN_ATTRIBUTE, "");
    hidden = found.action;
  };
  sync();
  const observer = new MutationObserver((records) => {
    if (records.some(touchesOpenButton)) sync();
  });
  observer.observe(anchor.closest(PANE) ?? anchor.ownerDocument.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-label", "data-app-composer-role"],
  });
  return () => {
    observer.disconnect();
    release();
  };
}
