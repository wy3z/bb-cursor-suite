import assert from "node:assert/strict";
import test from "node:test";

import {
  SPINNER_STYLE_OPTIONS,
  isSpinnerStyle,
  parseSpinnerStyle,
  resolveIconPackForName,
} from "../lib/icon-pack-preference.ts";

test("parses spinner styles and falls back to Follow icon pack", () => {
  assert.deepEqual(
    SPINNER_STYLE_OPTIONS.map((option) => option.id),
    ["follow", "default", "lucide", "iconoir", "tabler"],
  );

  for (const option of SPINNER_STYLE_OPTIONS) {
    assert.equal(parseSpinnerStyle(option.id), option.id);
    assert.equal(isSpinnerStyle(option.id), true);
  }

  for (const value of [undefined, null, "", "BB Default", "solar-linear", 0, {}, []]) {
    assert.equal(parseSpinnerStyle(value), "follow");
    assert.equal(isSpinnerStyle(value), false);
  }

  for (const retired of ["solar", "phosphor"]) {
    assert.equal(parseSpinnerStyle(retired), "default");
    assert.equal(isSpinnerStyle(retired), false);
  }
});

test("only Loading and Spinner follow the separate spinner choice", () => {
  const appearance = { iconPack: "iconoir", spinnerStyle: "lucide" } as const;

  assert.equal(resolveIconPackForName(appearance, "Loading"), "lucide");
  assert.equal(resolveIconPackForName(appearance, "Spinner"), "lucide");
  assert.equal(resolveIconPackForName(appearance, "Search"), "iconoir");
  assert.equal(
    resolveIconPackForName(appearance, "ArrowReloadHorizontal"),
    "iconoir",
  );
  assert.equal(resolveIconPackForName(appearance, "Folder"), "iconoir");
});

test("new icon packs work with an independent spinner choice", () => {
  assert.equal(
    resolveIconPackForName(
      { iconPack: "iconoir", spinnerStyle: "tabler" },
      "Loading",
    ),
    "tabler",
  );
  assert.equal(
    resolveIconPackForName(
      { iconPack: "iconoir", spinnerStyle: "tabler" },
      "Search",
    ),
    "iconoir",
  );
});

test("Follow icon pack resolves spinners to the current icon pack", () => {
  assert.equal(
    resolveIconPackForName(
      { iconPack: "lucide", spinnerStyle: "follow" },
      "Loading",
    ),
    "lucide",
  );
});

test("an explicit icon-pack preview outranks the spinner choice", () => {
  const appearance = { iconPack: "iconoir", spinnerStyle: "lucide" } as const;

  assert.equal(
    resolveIconPackForName(appearance, "Loading", { previewPack: "default" }),
    "default",
  );
  assert.equal(
    resolveIconPackForName(appearance, "Spinner", { previewPack: "tabler" }),
    "tabler",
  );
});

test("spinner previews override only the spinner names", () => {
  const appearance = { iconPack: "iconoir", spinnerStyle: "follow" } as const;

  assert.equal(
    resolveIconPackForName(appearance, "Loading", {
      previewSpinnerStyle: "lucide",
    }),
    "lucide",
  );
  assert.equal(
    resolveIconPackForName(appearance, "Search", {
      previewSpinnerStyle: "lucide",
    }),
    "iconoir",
  );
  assert.equal(
    resolveIconPackForName(appearance, "Loading", {
      previewSpinnerStyle: "follow",
    }),
    "iconoir",
  );
});
