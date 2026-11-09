export const COMPOSER_ROOT = "[data-app-composer]";
export const PRIMARY_COMPOSER = '[data-app-composer][data-app-composer-role="primary"]';
export const PANE = "[data-split-pane-id]";
export const HEADER_ACTIONS = "[data-thread-header-workflow-actions]";
export const RESPONSIVE_ACTION = "[data-thread-header-responsive-action]";
export const OPEN_PREFIX = "Open workspace in ";
export const CHOOSER_LABEL = "Choose another app to open workspace";
export const HIDDEN_ATTRIBUTE = "data-bb-agent-pills-open-in-hidden";
export const THREAD_ACTIONS_LABEL = "Thread actions";
const OPEN_TRIGGER = `button[aria-label="${THREAD_ACTIONS_LABEL}"][aria-expanded="true"]`;
const SEPARATOR = 'hr, [role="separator"]';

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
  const found = findThreadPane(anchor);
  if (found === null) return null;
  const { pane, header } = found;
  if (buttons(pane, isOpen).length !== 1 || buttons(pane, isChooser).length !== 1) return null;
  const actions = Array.from(header.querySelectorAll<HTMLElement>(RESPONSIVE_ACTION)).filter(
    (action) => action.parentElement === header && buttons(action, isOpen).length === 1 && buttons(action, isChooser).length === 1,
  );
  if (actions.length !== 1) return null;
  const [action] = actions;
  if (buttons(action!, () => true).length !== 2) return null;
  return { pane, header, action: action! };
}

function related(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  const selector = `${HEADER_ACTIONS}, ${PRIMARY_COMPOSER}, button[aria-label="${THREAD_ACTIONS_LABEL}"]`;
  return element.matches(selector) || element.closest(HEADER_ACTIONS) !== null || element.querySelector(selector) !== null;
}

export function touchesOpenButton(record: Pick<MutationRecord, "target" | "addedNodes" | "removedNodes">): boolean {
  return related(record.target) || Array.from(record.addedNodes).some(related) || Array.from(record.removedNodes).some(related);
}


function isSeparator(element: Element | null): boolean {
  return element !== null && element.matches(SEPARATOR);
}

function threadActionsSurfaces(document: Document, trigger: HTMLElement): HTMLElement[] {
  const drawers = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][data-persistent-drawer-content][data-state="open"]')).filter((drawer) => {
    const labelId = drawer.getAttribute("aria-labelledby");
    const label = labelId ? document.getElementById(labelId) : null;
    return label !== null && drawer.contains(label) && label.textContent?.trim() === THREAD_ACTIONS_LABEL;
  });
  const menus =
    trigger.id === ""
      ? []
      : Array.from(document.querySelectorAll<HTMLElement>('[role="menu"][data-state="open"]')).filter((menu) => menu.getAttribute("aria-labelledby") === trigger.id);
  return [...drawers, ...menus];
}

function isOpenItem(element: Element): boolean {
  return (
    element.getAttribute("role") === "menuitem" &&
    isOpen(element.textContent?.trim() ?? "") &&
    element.querySelector('[data-icon="FolderOpen"]') !== null
  );
}

export function findBbOpenMenuItems(anchor: Element | null): HTMLElement[] | null {
  const found = findThreadPane(anchor);
  if (found === null) return null;
  const document = found.pane.ownerDocument;
  const triggers = document.querySelectorAll<HTMLElement>(OPEN_TRIGGER);
  if (triggers.length !== 1) return null;
  const [trigger] = triggers;
  const header = found.header.closest("header");
  if (header === null || !header.contains(trigger!) || !found.pane.contains(header)) return null;
  const surfaces = threadActionsSurfaces(document, trigger!);
  if (surfaces.length !== 1) return null;
  const items = Array.from(surfaces[0]!.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(isOpenItem);
  if (items.length === 0) return null;
  const parent = items[0]!.parentElement;
  if (parent === null || items.some((item) => item.parentElement !== parent)) return null;
  for (let index = 1; index < items.length; index += 1) {
    if (items[index - 1]!.nextElementSibling !== items[index]) return null;
  }
  const before = items[0]!.previousElementSibling;
  if (before !== null && !isSeparator(before)) return null;
  const after = items[items.length - 1]!.nextElementSibling;
  if (after !== null && !isSeparator(after)) return null;
  const separator = (after ?? before) as HTMLElement | null;
  return separator === null ? items : [...items, separator];
}

function findThreadPane(anchor: Element | null): { pane: HTMLElement; header: HTMLElement } | null {
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
  return { pane, header: header! };
}

export function watchBbOpenButton(anchor: HTMLElement): () => void {
  const document = anchor.ownerDocument;
  let hidden: HTMLElement[] = [];
  let portal: MutationObserver | null = null;
  const release = () => {
    for (const element of hidden) element.removeAttribute(HIDDEN_ATTRIBUTE);
    hidden = [];
  };
  const targets = (): HTMLElement[] => {
    const button = findBbOpenButton(anchor);
    const items = findBbOpenMenuItems(anchor) ?? [];
    return button === null ? items : [button.action, ...items];
  };
  const watchPortal = () => {
    const open = findThreadPane(anchor)?.header.closest("header")?.querySelector(OPEN_TRIGGER) ?? null;
    if (open !== null && portal === null) {
      portal = new MutationObserver(() => sync());
      portal.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
    } else if (open === null && portal !== null) {
      portal.disconnect();
      portal = null;
    }
  };
  const sync = () => {
    watchPortal();
    const next = targets();
    if (next.length === hidden.length && next.every((element, index) => element === hidden[index] && element.hasAttribute(HIDDEN_ATTRIBUTE))) return;
    release();
    for (const element of next) element.setAttribute(HIDDEN_ATTRIBUTE, "");
    hidden = next;
  };
  sync();
  const observer = new MutationObserver((records) => {
    if (records.some(touchesOpenButton)) sync();
  });
  observer.observe(anchor.closest(PANE) ?? document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-label", "aria-expanded", "data-app-composer-role"],
  });
  return () => {
    observer.disconnect();
    portal?.disconnect();
    portal = null;
    release();
  };
}
