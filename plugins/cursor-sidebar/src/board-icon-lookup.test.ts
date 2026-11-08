import assert from "node:assert/strict";
import { test } from "node:test";
import { boardIconLookup } from "./board-icon-lookup";

const rows = [
  { projectId: "proj_abc", icon: "glyph:rocket:blue" },
  { projectId: "proj_img", icon: "data:image/png;base64,iVBORw0KGgo=" },
  { projectId: "proj_bad", icon: "glyph:retired:blue" },
];

test("board rows wear each board's own icon from Projects", () => {
  const iconFor = boardIconLookup(rows, new Map());
  assert.deepEqual(iconFor("proj_abc"), { kind: "glyph", name: "rocket", color: "blue" });
  assert.deepEqual(iconFor("proj_img"), { kind: "image", src: "data:image/png;base64,iVBORw0KGgo=" });
});

test("an unset, unparseable or unreadable board icon falls back to the board glyph", () => {
  assert.equal(boardIconLookup(rows, new Map())("proj_none"), null);
  assert.equal(boardIconLookup(rows, new Map())("proj_bad"), null);
  assert.equal(boardIconLookup(undefined, new Map())("proj_abc"), null);
});

test("pending writes apply over the last read", () => {
  const iconFor = boardIconLookup(rows, new Map<string, string | null>([["proj_abc", null], ["proj_new", "emoji:🧪"]]));
  assert.equal(iconFor("proj_abc"), null);
  assert.deepEqual(iconFor("proj_new"), { kind: "emoji", emoji: "🧪" });
});
