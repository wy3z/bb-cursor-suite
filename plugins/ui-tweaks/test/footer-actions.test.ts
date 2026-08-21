import assert from "node:assert/strict";
import test from "node:test";

import { mergeRetainedItems } from "../lib/footer-actions.ts";

interface Item {
  key: string;
  label: string;
}

test("retains a hidden footer action that is temporarily absent", () => {
  const previous: Item[] = [
    { key: "settings", label: "Settings" },
    { key: "notify", label: "Enable OS notifications" },
  ];

  assert.deepEqual(
    mergeRetainedItems(
      [{ key: "settings", label: "Settings" }],
      previous,
      new Set(["notify"]),
    ),
    previous,
  );
});

test("uses the current discovered item and does not duplicate retained items", () => {
  assert.deepEqual(
    mergeRetainedItems(
      [{ key: "notify", label: "Disable OS notifications" }],
      [{ key: "notify", label: "Enable OS notifications" }],
      new Set(["notify"]),
    ),
    [{ key: "notify", label: "Disable OS notifications" }],
  );
});

test("drops missing items that are not hidden", () => {
  assert.deepEqual(
    mergeRetainedItems(
      [],
      [{ key: "remote", label: "Remote access" }],
      new Set(),
    ),
    [],
  );
});
