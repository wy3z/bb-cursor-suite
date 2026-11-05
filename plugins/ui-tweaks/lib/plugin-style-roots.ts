const OWNER_ATTRIBUTE = "data-bb-plugin";
const STYLE_ROOT_PREFIX = "data-bb-ui-style-owner-";
const STYLE_ROOT_ATTRIBUTE = "data-bb-ui-style-root";

export function createPluginStyleRoots() {
  const nativeSetAttribute = Element.prototype.setAttribute;
  const nativeRemoveAttribute = Element.prototype.removeAttribute;
  const roots = new Map<Element, string>();
  const names = new Map<string, string>();
  const encoder = new TextEncoder();
  let stopped = false;

  function nameFor(owner: string): string {
    const cached = names.get(owner);
    if (cached !== undefined) return cached;
    const name = STYLE_ROOT_PREFIX + Array.from(
      encoder.encode(owner),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    names.set(owner, name);
    return name;
  }

  function update(root: Element): void {
    const owner = root.getAttribute(OWNER_ATTRIBUTE);
    const name = owner === null ? null : nameFor(owner);
    if (
      name !== null &&
      roots.get(root) === name &&
      root.hasAttribute(name) &&
      root.hasAttribute(STYLE_ROOT_ATTRIBUTE)
    ) {
      return;
    }
    for (const attribute of Array.from(root.attributes)) {
      if (attribute.name.startsWith(STYLE_ROOT_PREFIX) && attribute.name !== name) {
        nativeRemoveAttribute.call(root, attribute.name);
      }
    }
    if (name === null) {
      nativeRemoveAttribute.call(root, STYLE_ROOT_ATTRIBUTE);
      roots.delete(root);
    } else {
      nativeSetAttribute.call(root, name, "");
      nativeSetAttribute.call(root, STYLE_ROOT_ATTRIBUTE, "");
      roots.set(root, name);
    }
  }

  function setAttribute(this: Element, name: string, value: string): void {
    nativeSetAttribute.call(this, name, value);
    if (
      !stopped &&
      (typeof name !== "string" || name.toLowerCase() === OWNER_ATTRIBUTE)
    ) update(this);
  }

  function removeAttribute(this: Element, name: string): void {
    nativeRemoveAttribute.call(this, name);
    if (
      !stopped &&
      (typeof name !== "string" || name.toLowerCase() === OWNER_ATTRIBUTE)
    ) update(this);
  }

  Element.prototype.setAttribute = setAttribute;
  Element.prototype.removeAttribute = removeAttribute;

  function refresh(): void {
    if (stopped) return;
    for (const root of Array.from(document.querySelectorAll(
      `[${OWNER_ATTRIBUTE}], [${STYLE_ROOT_ATTRIBUTE}]`,
    ))) {
      update(root);
    }
    for (const [root, name] of roots) {
      if (root.isConnected) continue;
      nativeRemoveAttribute.call(root, name);
      nativeRemoveAttribute.call(root, STYLE_ROOT_ATTRIBUTE);
      roots.delete(root);
    }
  }

  function stop(): void {
    stopped = true;
    if (Element.prototype.setAttribute === setAttribute) {
      Element.prototype.setAttribute = nativeSetAttribute;
    }
    if (Element.prototype.removeAttribute === removeAttribute) {
      Element.prototype.removeAttribute = nativeRemoveAttribute;
    }
    const marked = new Set([
      ...roots.keys(),
      ...Array.from(document.querySelectorAll(`[${STYLE_ROOT_ATTRIBUTE}]`)),
    ]);
    for (const root of marked) {
      for (const attribute of Array.from(root.attributes)) {
        if (
          attribute.name.startsWith(STYLE_ROOT_PREFIX) ||
          attribute.name === STYLE_ROOT_ATTRIBUTE
        ) nativeRemoveAttribute.call(root, attribute.name);
      }
    }
    roots.clear();
    names.clear();
  }

  return {
    refresh,
    selectorFor: (owner: string): string => `[${nameFor(owner)}]`,
    stop,
  };
}
