const RELATIONS = [
  ["row-actions", ".bb-agent-pills__row-item", ".bb-agent-pills__row-actions"],
  ["thread-pill", "[data-thread-window]", '.bb-agent-pills__pill[data-group="thread"]'],
  ["compact-pill", "[data-thread-window]", '.bb-agent-pills__pill[data-group="compact"]'],
  ["status-card", "section", 'button[aria-label="Exit plan mode"], button[aria-label="Clear active Goal"], button[aria-label="Clear Goal"]'],
  ["queue-editor", 'section[aria-label="Queued messages"]', "form[data-promptbox]"],
  ["interaction", "div[data-app-composer]", 'section[data-testid="approval-banner"], section[data-testid="user-question-banner"], section[data-testid="plan-review-banner"], section[data-testid="plugin-interaction-shell"]'],
] as const;

const PREFIX = "data-bb-agent-pills-has-";

export function startRelationalMarkers(signal: AbortSignal): void {
  const marked = new Map<string, Set<Element>>();

  function update(name: string, matches: Set<Element>): void {
    const attribute = PREFIX + name;
    for (const element of marked.get(name) ?? []) {
      if (!matches.has(element)) element.removeAttribute(attribute);
    }
    for (const element of matches) {
      if (!element.hasAttribute(attribute)) element.setAttribute(attribute, "");
    }
    marked.set(name, matches);
  }

  function sync(): void {
    for (const [name, candidate, descendant] of RELATIONS) {
      update(name, new Set(Array.from(document.querySelectorAll(candidate))
        .filter((element) => element.querySelector(descendant) !== null)));
    }
    const voice = new Set<Element>();
    for (const button of document.querySelectorAll('button[aria-label="Start voice input"]')) {
      if (button.parentElement?.localName === "span") voice.add(button.parentElement);
    }
    update("voice", voice);
    const frames = new Set<Element>();
    for (const viewport of document.querySelectorAll("[data-page-scroll-viewport]")) {
      if (viewport.parentElement) frames.add(viewport.parentElement);
    }
    update("scroll-frame", frames);
  }

  const observer = new MutationObserver(sync);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "aria-label", "data-group", "data-testid", "data-thread-window", "data-app-composer", "data-promptbox", "data-page-scroll-viewport"],
  });
  const stop = () => {
    observer.disconnect();
    for (const [name, elements] of marked) {
      for (const element of elements) element.removeAttribute(PREFIX + name);
    }
    marked.clear();
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  else sync();
}
