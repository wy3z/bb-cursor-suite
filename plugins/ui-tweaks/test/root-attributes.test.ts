import assert from "node:assert/strict";
import test from "node:test";

import {
  createRootOverrides,
  releaseRootOverrides,
  setOwnedAttribute,
  type AttributeRoot,
} from "../lib/root-attributes.ts";

class FakeRoot implements AttributeRoot {
  readonly attributes = new Map<string, string>();

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

const HIERARCHY = "data-bb-ui-clearer-hierarchy";
const PROMPT_POSITION = "data-bb-ui-prompt-position";
const PROMPT_HEIGHT = "data-bb-ui-prompt-height";

test("private marker on writes and cleanup removes it", () => {
  const root = new FakeRoot();
  root.setAttribute(HIERARCHY, "true");
  const overrides = createRootOverrides();

  setOwnedAttribute(overrides, root, HIERARCHY, "true", false, "private");
  assert.equal(root.getAttribute(HIERARCHY), "true");

  releaseRootOverrides(overrides, root);
  assert.equal(root.getAttribute(HIERARCHY), null);
});

test("private marker off clears a stale value without ownership", () => {
  const root = new FakeRoot();
  root.setAttribute(HIERARCHY, "true");
  const overrides = createRootOverrides();

  setOwnedAttribute(overrides, root, HIERARCHY, null, false, "private");
  assert.equal(root.getAttribute(HIERARCHY), null);
});

test("private marker on/off works across a reload", () => {
  const root = new FakeRoot();
  const first = createRootOverrides();
  setOwnedAttribute(first, root, HIERARCHY, "true", false, "private");
  assert.equal(root.getAttribute(HIERARCHY), "true");
  releaseRootOverrides(first, root);
  assert.equal(root.getAttribute(HIERARCHY), null);

  const second = createRootOverrides();
  setOwnedAttribute(second, root, HIERARCHY, null, false, "private");
  assert.equal(root.getAttribute(HIERARCHY), null);
  setOwnedAttribute(second, root, HIERARCHY, "true", false, "private");
  assert.equal(root.getAttribute(HIERARCHY), "true");
  setOwnedAttribute(second, root, HIERARCHY, null, false, "private");
  assert.equal(root.getAttribute(HIERARCHY), null);
});

test("ordinary attributes keep the previous owner's value", () => {
  const root = new FakeRoot();
  root.setAttribute(PROMPT_POSITION, "center");
  const overrides = createRootOverrides();

  setOwnedAttribute(overrides, root, PROMPT_POSITION, "top");
  assert.equal(root.getAttribute(PROMPT_POSITION), "top");
  releaseRootOverrides(overrides, root);
  assert.equal(root.getAttribute(PROMPT_POSITION), "center");

  root.setAttribute(PROMPT_HEIGHT, "two-lines");
  setOwnedAttribute(overrides, root, PROMPT_HEIGHT, null);
  assert.equal(root.getAttribute(PROMPT_HEIGHT), "two-lines");
});
