import { useEffect, useRef, type RefObject } from "react";

const ITEM = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
const NATIVELY_FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]';
const TEXT_ENTRY = 'textarea, select, [contenteditable=""], [contenteditable="true"], input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"])';

export function findMenu(root: HTMLElement, surface = '[role="menu"]'): HTMLElement | null {
  return root.matches(surface) ? root : root.querySelector<HTMLElement>(surface);
}

export function menuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM)).filter(
    (item) =>
      !menu.contains(item.parentElement?.closest(ITEM) ?? null) &&
      item.getAttribute("aria-disabled") !== "true" &&
      !(item as HTMLButtonElement).disabled &&
      item.closest("[hidden]") === null,
  );
}

export function focusMenuItem(item: HTMLElement | undefined): void {
  if (!item) return;
  if (!item.matches(NATIVELY_FOCUSABLE)) item.setAttribute("tabindex", "-1");
  item.focus();
}

export function nextMenuItem(
  items: readonly HTMLElement[],
  active: Element | null,
  key: string,
): HTMLElement | undefined {
  if (items.length === 0) return undefined;
  const index = active ? items.findIndex((item) => item === active || item.contains(active)) : -1;
  switch (key) {
    case "ArrowDown":
      return items[index < 0 ? 0 : (index + 1) % items.length];
    case "ArrowUp":
      return items[index <= 0 ? items.length - 1 : index - 1];
    case "Home":
      return items[0];
    case "End":
      return items[items.length - 1];
    default:
      return undefined;
  }
}

let modality: "keyboard" | "pointer" = "pointer";
let tracking = false;

function trackModality(): void {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener("keydown", () => (modality = "keyboard"), true);
  document.addEventListener("pointerdown", () => (modality = "pointer"), true);
}

function triggerFor(root: HTMLElement, menu: HTMLElement, opener: Element | null): HTMLElement | null {
  if (opener instanceof HTMLElement && opener !== document.body && !menu.contains(opener)) return opener;
  return (
    Array.from(root.querySelectorAll<HTMLElement>('[aria-expanded="true"]')).find((element) => !menu.contains(element)) ??
    null
  );
}

export function useMenuKeyboard(
  rootRef: RefObject<HTMLElement | null>,
  open: unknown,
  close: () => void,
  surface = '[role="menu"]',
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  trackModality();

  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const menu = root ? findMenu(root, surface) : null;
    if (!root || !menu) return;
    const trigger = triggerFor(root, menu, document.activeElement);
    let focusInside = false;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(TEXT_ENTRY)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      const next = nextMenuItem(menuItems(menu), document.activeElement, event.key);
      if (!next) return;
      event.preventDefault();
      focusMenuItem(next);
    };
    const onFocusIn = () => {
      focusInside = true;
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node) focusInside = menu.contains(event.relatedTarget);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !menu.contains(event.target)) focusInside = false;
    };

    menu.addEventListener("keydown", onKeyDown);
    menu.addEventListener("focusin", onFocusIn);
    menu.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", onPointerDown, true);
    if (!menu.contains(document.activeElement)) {
      const first = modality === "keyboard" ? menuItems(menu)[0] : undefined;
      if (first) focusMenuItem(first);
      else {
        if (!menu.hasAttribute("tabindex")) menu.setAttribute("tabindex", "-1");
        menu.focus({ preventScroll: true });
      }
    }

    return () => {
      menu.removeEventListener("keydown", onKeyDown);
      menu.removeEventListener("focusin", onFocusIn);
      menu.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onPointerDown, true);
      const active = document.activeElement;
      const lost = active === null || active === document.body || menu.contains(active) || !active.isConnected;
      if (focusInside && lost && trigger?.isConnected) trigger.focus();
    };
  }, [open, rootRef, surface]);
}
