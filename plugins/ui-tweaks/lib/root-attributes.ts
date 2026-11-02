export interface AttributeRoot {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface OwnedAttributeValue {
  previous: string | null;
  written: string | null;
  private: boolean;
}

export interface RootOverrides {
  attributes: Map<string, OwnedAttributeValue>;
}

/**
 * `private` attributes belong entirely to this plugin: a false/null value
 * clears any marker, even a stale one left by a previous load, and cleanup
 * always restores visibility instead of restoring an earlier hidden state.
 * Ordinary attributes keep the previous owner's value.
 */
export type AttributeMode = "owned" | "private";

export function createRootOverrides(): RootOverrides {
  return { attributes: new Map() };
}

export function setOwnedAttribute(
  overrides: RootOverrides,
  root: AttributeRoot,
  attribute: string,
  value: string | null,
  reclaimExternal = false,
  mode: AttributeMode = "owned",
) {
  const existing = overrides.attributes.get(attribute);
  const current = root.getAttribute(attribute);

  if (value === null) {
    if (!existing) {
      // A private marker can outlive the load that wrote it. Clear it even
      // when this module has no ownership record.
      if (mode === "private") root.removeAttribute(attribute);
      return;
    }
    if (current === existing.written) {
      if (existing.private || existing.previous === null) {
        root.removeAttribute(attribute);
      } else {
        root.setAttribute(attribute, existing.previous);
      }
    }
    overrides.attributes.delete(attribute);
    return;
  }

  if (!existing) {
    root.setAttribute(attribute, value);
    overrides.attributes.set(attribute, {
      previous: mode === "private" ? null : current,
      written: value,
      private: mode === "private",
    });
    return;
  }
  if (current !== existing.written) {
    if (!reclaimExternal) return;
    existing.previous = existing.private ? null : current;
  }
  root.setAttribute(attribute, value);
  existing.written = value;
}

export function releaseRootOverrides(
  overrides: RootOverrides,
  root: AttributeRoot,
) {
  for (const [attribute, state] of overrides.attributes) {
    if (root.getAttribute(attribute) !== state.written) continue;
    if (state.private || state.previous === null) {
      root.removeAttribute(attribute);
    } else {
      root.setAttribute(attribute, state.previous);
    }
  }
  overrides.attributes.clear();
}
