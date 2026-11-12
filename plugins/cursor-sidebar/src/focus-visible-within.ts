import { useEffect, type RefObject } from "react";

const WITHIN_ATTRIBUTE = "data-focus-visible-within";
const GROUP_CLASS_PREFIX = "group/";

export type FocusVisibleMatcher = (element: Element) => boolean;

function isNamedGroup(element: Element): boolean {
  return Array.from(element.classList).some((name) => name.startsWith(GROUP_CLASS_PREFIX));
}

export function clearFocusVisibleWithin(marked: Set<Element>): void {
  for (const element of marked) {
    element.removeAttribute(WITHIN_ATTRIBUTE);
  }
  marked.clear();
}

export function syncFocusVisibleWithin(
  container: Element,
  marked: Set<Element>,
  isFocusVisible: FocusVisibleMatcher = (element) => element.matches(":focus-visible"),
): void {
  const active = document.activeElement;
  clearFocusVisibleWithin(marked);
  if (active === null || active === container || !container.contains(active)) return;
  if (!isFocusVisible(active)) return;
  let ancestor = active.parentElement;
  while (ancestor !== null && ancestor !== container) {
    if (isNamedGroup(ancestor)) {
      ancestor.setAttribute(WITHIN_ATTRIBUTE, "");
      marked.add(ancestor);
    }
    ancestor = ancestor.parentElement;
  }
}

export function useFocusVisibleWithin(ref: RefObject<Element | null>): void {
  useEffect(() => {
    const container = ref.current;
    if (container === null) return;
    const marked = new Set<Element>();
    const sync = () => syncFocusVisibleWithin(container, marked);
    const clear = () => clearFocusVisibleWithin(marked);
    container.addEventListener("focusin", sync);
    container.addEventListener("focusout", clear);
    container.addEventListener("keydown", sync);
    return () => {
      container.removeEventListener("focusin", sync);
      container.removeEventListener("focusout", clear);
      container.removeEventListener("keydown", sync);
      clearFocusVisibleWithin(marked);
    };
  }, [ref]);
}
