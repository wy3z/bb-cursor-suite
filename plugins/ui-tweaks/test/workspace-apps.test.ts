import assert from "node:assert/strict";
import test from "node:test";

import {
  legacyWorkspaceAppKey,
  parseStoredWorkspaceAppCatalog,
  parseWorkspaceAppsTargetsResponse,
  resolveWorkspaceMenuApps,
  type WorkspaceAppCatalogItem,
} from "../lib/workspace-apps.ts";

test("rejects malformed workspace target responses", () => {
  assert.equal(parseWorkspaceAppsTargetsResponse(null), null);
  assert.equal(parseWorkspaceAppsTargetsResponse({}), null);
  assert.equal(parseWorkspaceAppsTargetsResponse({ targets: "invalid" }), null);
});

test("uses daemon categories and disambiguates duplicate desktop labels", () => {
  const apps = parseWorkspaceAppsTargetsResponse({
    targets: [
      { id: "default", kind: "default-app", label: "Default App" },
      {
        id: "desktop-app:org.gnome.Evince",
        kind: "other",
        label: "Document Viewer",
      },
      {
        id: "desktop-app:org.gnome.Papers",
        kind: "other",
        label: "Document Viewer",
      },
    ],
  });

  assert.deepEqual(apps, [
    {
      id: "default",
      key: "default",
      label: "Default App",
      category: "default-app",
    },
    {
      id: "desktop-app:org.gnome.Evince",
      key: "desktop-app:org.gnome.Evince",
      label: "Evince",
      menuLabel: "Document Viewer",
      category: "other",
    },
    {
      id: "desktop-app:org.gnome.Papers",
      key: "desktop-app:org.gnome.Papers",
      label: "Papers",
      menuLabel: "Document Viewer",
      category: "other",
    },
  ]);
});

test("resolves duplicate rendered labels in daemon order", () => {
  const catalog = parseWorkspaceAppsTargetsResponse({
    targets: [
      {
        id: "desktop-app:org.gnome.Evince",
        kind: "other",
        label: "Document Viewer",
      },
      {
        id: "desktop-app:org.gnome.Papers",
        kind: "other",
        label: "Document Viewer",
      },
    ],
  });
  assert.ok(catalog);

  assert.deepEqual(
    resolveWorkspaceMenuApps(["Document Viewer", "Document Viewer"], catalog),
    catalog,
  );
});

test("fails open when duplicate menu and catalogue counts do not match", () => {
  const catalog = parseWorkspaceAppsTargetsResponse({
    targets: [
      {
        id: "desktop-app:org.gnome.Evince",
        kind: "other",
        label: "Document Viewer",
      },
      {
        id: "desktop-app:org.gnome.Papers",
        kind: "other",
        label: "Document Viewer",
      },
    ],
  });
  assert.ok(catalog);

  assert.deepEqual(resolveWorkspaceMenuApps(["Document Viewer"], catalog), [
    null,
  ]);
});

test("preserves the original menu label in stored catalogues and legacy keys", () => {
  const stored = parseStoredWorkspaceAppCatalog([
    {
      id: "desktop-app:org.gnome.Evince",
      key: "desktop-app:org.gnome.Evince",
      label: "Evince",
      menuLabel: "Document Viewer",
      category: "other",
    },
  ]);

  assert.equal(stored[0]?.menuLabel, "Document Viewer");
  assert.equal(
    legacyWorkspaceAppKey(stored[0] as WorkspaceAppCatalogItem),
    "other:document viewer",
  );
});
