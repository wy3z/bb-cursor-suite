import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";

installTestPluginRuntime();
const { ProjectStatusGlyph } = await import("./ProjectStatusGlyph");

const spins = (html: string) => html.includes("animate-spin");

test("a repo row with hidden work keeps its folder and adds a corner spinner", () => {
  const html = renderToStaticMarkup(<ProjectStatusGlyph open label="Repo" status="working" hiddenWork />);
  assert.equal(spins(html), true);
  assert.match(html, /data-badge="working"/);
  assert.match(html, /data-activity="working"/);
  assert.match(html, /data-icon="FolderOpen"|FolderOpen|<svg/);
  assert.equal((html.match(/animate-spin/g) ?? []).length, 1);
});

test("a repo row whose working thread is on screen shows no spinner", () => {
  const html = renderToStaticMarkup(<ProjectStatusGlyph open={false} label="Repo" status="working" hiddenWork={false} />);
  assert.equal(spins(html), false);
  assert.match(html, /data-activity="inactive"/);
});

test("a collapsed repo never swaps its folder for a full spinner", () => {
  const html = renderToStaticMarkup(<ProjectStatusGlyph open={false} label="Repo" status="working" hiddenWork />);
  assert.match(html, /data-badge="working"/);
  assert.doesNotMatch(html, /class="size-4 animate-spin/);
});

test("needs-input still outranks the working badge", () => {
  const html = renderToStaticMarkup(<ProjectStatusGlyph open={false} label="Repo" status="input" hiddenWork />);
  assert.equal(spins(html), false);
  assert.match(html, /data-activity="attention"/);
});

test("a board row keeps its own full spinner", () => {
  const html = renderToStaticMarkup(<ProjectStatusGlyph open={false} label="Board" status="working" fallback="board" />);
  assert.match(html, /size-4 animate-spin/);
  assert.doesNotMatch(html, /data-badge="working"/);
});
