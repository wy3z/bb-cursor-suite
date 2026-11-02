import assert from "node:assert/strict";
import test from "node:test";

import { ICON_BODIES } from "../lib/icon-data.ts";
import {
  ICON_PACK_OPTIONS,
  isIconPack,
  parseIconPack,
} from "../lib/icon-pack-preference.ts";

const TAG_PATTERN = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/gu;
const FORBIDDEN_PATTERN =
  /<script[\s>]|<foreignObject[\s>]|<image[\s>]|\son[a-z]+\s*=|javascript:|(?:href|src|xlink:href)\s*=/iu;

function assertWellFormedSvg(name: string, body: string) {
  assert.notEqual(body.trim(), "", `${name} has artwork`);
  assert.doesNotMatch(body, FORBIDDEN_PATTERN, `${name} has no active content`);
  assert.match(body, /currentColor/u, `${name} inherits the current colour`);

  const stack: string[] = [];
  let cursor = 0;
  for (const match of body.matchAll(TAG_PATTERN)) {
    assert.equal(match.index, cursor, `${name} has no text outside tags`);
    cursor += match[0].length;

    const [, closing, tag, , selfClosing] = match;
    if (closing === "/") {
      assert.equal(stack.pop(), tag, `${name} closes ${tag}`);
    } else if (selfClosing !== "/") {
      stack.push(tag);
    }
  }

  assert.equal(cursor, body.length, `${name} ends with a tag`);
  assert.deepEqual(stack, [], `${name} has balanced tags`);
}

test("generated pack artwork is safe, coloured, and well formed", () => {
  const solar = Object.entries(ICON_BODIES.solar);
  const lucide = Object.entries(ICON_BODIES.lucide);

  assert.ok(solar.length >= 150, "solar covers the shared interface icons");
  assert.ok(lucide.length >= 170, "lucide covers the shared interface icons");

  for (const [name, body] of [...solar, ...lucide]) {
    assertWellFormedSvg(`solar:${name}`, body);
  }
});

test("both packs map the same BB icon names", () => {
  for (const name of Object.keys(ICON_BODIES.solar)) {
    assert.ok(
      Object.hasOwn(ICON_BODIES.lucide, name),
      `${name} has a lucide fallback`,
    );
  }
});

test("parses stored icon packs and falls back to BB Default", () => {
  assert.deepEqual(
    ICON_PACK_OPTIONS.map((option) => option.id),
    ["default", "solar", "lucide"],
  );

  for (const option of ICON_PACK_OPTIONS) {
    assert.equal(parseIconPack(option.id), option.id);
    assert.equal(isIconPack(option.id), true);
  }

  for (const value of [undefined, null, "", "solar-linear", 0, {}, []]) {
    assert.equal(parseIconPack(value), "default");
    assert.equal(isIconPack(value), false);
  }
});
