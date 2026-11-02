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

const HIDE_PANEL = "data-bb-ui-hide-panel-toggle";
const HIDE_SIDEBAR = "data-bb-ui-hide-sidebar-toggle";
const PROMPT_POSITION = "data-bb-ui-prompt-position";
const PROMPT_HEIGHT = "data-bb-ui-prompt-height";

test("hide-on writes the marker and cleanup restores visibility", () => {
  const root = new FakeRoot();
  root.setAttribute(HIDE_PANEL, "true");
  const overrides = createRootOverrides();

  setOwnedAttribute(overrides, root, HIDE_PANEL, "true", false, "private");
  assert.equal(root.getAttribute(HIDE_PANEL), "true");

  releaseRootOverrides(overrides, root);
  assert.equal(root.getAttribute(HIDE_PANEL), null);
});

test("hide-off clears a stale marker without an ownership record", () => {
  const root = new FakeRoot();
  root.setAttribute(HIDE_PANEL, "true");
  const overrides = createRootOverrides();

  setOwnedAttribute(overrides, root, HIDE_PANEL, null, false, "private");
  assert.equal(root.getAttribute(HIDE_PANEL), null);
});

test("false preferences clear stale hide markers for both toggles", () => {
  const root = new FakeRoot();
  root.setAttribute(HIDE_PANEL, "true");
  root.setAttribute(HIDE_SIDEBAR, "true");
  const overrides = createRootOverrides();

  setOwnedAttribute(overrides, root, HIDE_PANEL, null, false, "private");
  setOwnedAttribute(overrides, root, HIDE_SIDEBAR, null, false, "private");
  assert.equal(root.getAttribute(HIDE_PANEL), null);
  assert.equal(root.getAttribute(HIDE_SIDEBAR), null);
});

test("hide then unhide works across a reload", () => {
  const root = new FakeRoot();
  const first = createRootOverrides();
  setOwnedAttribute(first, root, HIDE_PANEL, "true", false, "private");
  assert.equal(root.getAttribute(HIDE_PANEL), "true");
  releaseRootOverrides(first, root);
  assert.equal(root.getAttribute(HIDE_PANEL), null);

  const second = createRootOverrides();
  setOwnedAttribute(second, root, HIDE_PANEL, null, false, "private");
  assert.equal(root.getAttribute(HIDE_PANEL), null);
  setOwnedAttribute(second, root, HIDE_PANEL, "true", false, "private");
  assert.equal(root.getAttribute(HIDE_PANEL), "true");
  setOwnedAttribute(second, root, HIDE_PANEL, null, false, "private");
  assert.equal(root.getAttribute(HIDE_PANEL), null);
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
