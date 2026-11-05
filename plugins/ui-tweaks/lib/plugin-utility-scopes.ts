import { createPluginStyleRoots } from "./plugin-style-roots.js";

const LEGACY_ROOT = "[data-bb-plugin-root]:not([data-bb-plugin])";
const OWNER_SCOPE =
  /:where\(\[data-bb-plugin="([^"]+)"\],\s*\[data-bb-plugin-root\]:not\(\[data-bb-plugin\]\)\)/g;

function restoreSelectors(selectors: Map<CSSStyleRule, string>): void {
  for (const [rule, selector] of selectors) rule.selectorText = selector;
}

function optimizeRules(
  rules: CSSRuleList,
  originals: Map<CSSStyleRule, string>,
  selectorFor: (owner: string) => string,
): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      const original = rule.selectorText;
      const optimized = original.replace(
        OWNER_SCOPE,
        (_, owner: string) => `:where(${selectorFor(owner)})`,
      );
      if (optimized !== original) {
        originals.set(rule, original);
        rule.selectorText = optimized;
      }
    }
    if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList) {
      optimizeRules(rule.cssRules, originals, selectorFor);
    }
  }
}

export function startPluginUtilityScopeOptimization(
  signal: AbortSignal,
): () => void {
  const sheets = new Map<CSSStyleSheet, Map<CSSStyleRule, string>>();
  const roots = createPluginStyleRoots();
  let stopped = false;
  let scheduled = false;

  function restore(): void {
    for (const selectors of sheets.values()) restoreSelectors(selectors);
    sheets.clear();
  }

  function refresh(): void {
    if (stopped) return;
    roots.refresh();
    if (document.querySelector(LEGACY_ROOT) !== null) {
      restore();
      return;
    }
    const active = new Set<CSSStyleSheet>();
    for (const sheet of Array.from(document.styleSheets)) {
      if (
        !(sheet.ownerNode instanceof Element) ||
        !sheet.ownerNode.hasAttribute("data-bb-plugin-css")
      ) continue;
      active.add(sheet);
      if (sheets.has(sheet)) continue;
      const originals = new Map<CSSStyleRule, string>();
      optimizeRules(sheet.cssRules, originals, roots.selectorFor);
      sheets.set(sheet, originals);
    }
    for (const [sheet, selectors] of sheets) {
      if (active.has(sheet)) continue;
      restoreSelectors(selectors);
      sheets.delete(sheet);
    }
  }

  function schedule(): void {
    if (stopped || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      refresh();
    });
  }

  const bodyObserver = new MutationObserver(schedule);
  bodyObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-bb-plugin-root", "data-bb-plugin"],
  });
  const headObserver = new MutationObserver(schedule);
  headObserver.observe(document.head, { childList: true, subtree: true });
  const onLoad = (event: Event) => {
    if (
      event.target instanceof Element &&
      event.target.hasAttribute("data-bb-plugin-css")
    ) schedule();
  };
  document.addEventListener("load", onLoad, true);

  const stop = () => {
    stopped = true;
    bodyObserver.disconnect();
    headObserver.disconnect();
    document.removeEventListener("load", onLoad, true);
    restore();
    roots.stop();
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  else refresh();
  return stop;
}
