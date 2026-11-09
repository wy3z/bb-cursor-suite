UI Tweaks collects the small interface changes BB doesn't offer as settings: type hierarchy, icon packs, prompt placement, Open With filtering and more.
Everything sits under Settings → Plugins → UI Tweaks, in the Interface, Icons and Open With sections, and most changes apply as you toggle them.
It adds no CLI commands or agent tools.

## For agents

### CLI, agent tools and MCP

None.

### Keyboard commands

`panel-tab-1` to `panel-tab-9`, titled **Right panel: switch to tab N**, bound to Alt+1 to Alt+9 by default. They switch to the Nth tab of the focused surface's right panel, in the order BB's tab strip shows them.

### RPC (plugin id `ui-tweaks`)

| Method | Input | Output |
|---|---|---|
| `getPreferences` | none (`null`, `undefined` or `{}`) | `{ preferences: object \| null }`. `null` until someone saves |
| `setPreferences` | `{ preferences: object }` | `{ ok: true }`. Replaces the stored object |

The stored object is kept under the key `preferences` in the plugin's key-value store. The app writes this shape; unknown or missing fields fall back to the defaults shown:

| Field | Values | Default |
|---|---|---|
| `promptPosition` | `"top"`, `"center"`, `"bottom"` | `"bottom"` |
| `promptHeight` | `"default"`, `"two-lines"`, `"one-line"` | `"default"` |
| `iconPack` | `"default"`, `"lucide"`, `"iconoir"`, `"tabler"` | `"default"` |
| `spinnerStyle` | `"follow"`, `"default"`, `"lucide"`, `"iconoir"`, `"tabler"` | `"follow"` |
| `clearerHierarchy` | boolean | `true` |
| `hideSteerLabels` | boolean | `false` |
| `disableChromeAnimations` | boolean | `false` |
| `editorSyntaxHighlighting` | boolean | `false` |
| `workspaceAppCategories` | `"default-app"`, `"file-manager"`, `"editor"`, `"terminal"`, `"other"` | the first four |
| `hiddenWorkspaceApps` | app keys hidden inside enabled categories | `[]` |

Change these through the settings page rather than `setPreferences`: the call replaces the whole object, and open clients only pick it up when they load or regain focus.

```ts
await sdk.plugins.callRpc({
  pluginId: "ui-tweaks",
  method: "getPreferences",
  input: {},
  outputSchema: z.object({ preferences: z.record(z.string(), z.unknown()).nullable() }),
});
```

## Reference

**Clearer hierarchy.** Bolder thread titles, slightly larger chat prose and semibold bold text. Headings, code, and other sizes and weights stay put. On by default.

**Hide Steer labels.** Removes the Steer tag on messages that steered a running agent, including pending and failed ones. Off by default.

**Better syntax highlighting.** Optional File Editor tokenizers. CSS understands `@media`, nested rules, pseudo-classes, attribute selectors, value keywords and functions. TypeScript and JavaScript tell functions, constants, operators, built-in types and `null`/`this` apart. Off by default; turning it off restores Monaco's own tokenizers.

**Prompt placement.** The New thread composer at the top, center or bottom of the empty thread, and its starting height: standard, two lines or one line. Cursor Composer respects the height setting.

**Icon packs.** BB Default, Lucide, Iconoir and Tabler Outline. Applies live and lasts across reloads. Provider logos and brand marks are left alone. Icon artwork ships inside the plugin as a small set of SVG bodies, so nothing is downloaded at runtime.

**Spinner.** The shared Loading and Spinner icons can follow the icon pack or use their own style. Every other icon keeps the main pack.

**Open With.** Hide workspace apps from the Open With menu and chat file-link context menus, by category or one at a time. Hidden apps stay in the list so you can bring them back. Apps are discovered from BB's local host daemon on loopback.

**Sidebar animation.** Always on: the left sidebar moves like the right panel. **Disable sidebar and panel animations** makes both instant.

**Reset to defaults.** Restores every setting.

Settings are saved on the BB server and shared by every device signed in to the same BB. Each client keeps a local copy so the interface applies instantly. The plugin sends no data to an external service.

### Requirements

BB `>=0.49` and plugin SDK `>=0.6.132 <0.7`. No external service, account or separate install.

---

Not affiliated with, endorsed by or sponsored by Anysphere, Inc. Cursor is a trademark of Anysphere, Inc.
