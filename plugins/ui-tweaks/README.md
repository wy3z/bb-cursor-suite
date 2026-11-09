# BB UI Tweaks

Small, configurable interface improvements for BB that BB doesn't offer as settings: a clearer type hierarchy, icon packs, prompt placement, Open With filtering and a few more.

## Who it's for

Anyone who uses BB every day and wants it to feel a little more like their own. Each tweak is a switch or a select, and **Reset to defaults** undoes them all.

## What it looks like

- **Clearer hierarchy** (on by default): bolder thread titles, slightly larger chat prose, semibold bold text, and quieter page-header and side-panel icons.
- **Hide Steer labels in threads** (off by default): removes the Steer tag on messages that steered a running agent.
- **Better syntax highlighting in the File Editor** (off by default): richer CSS, TypeScript and JavaScript tokenizers. Your theme still picks the colours.
- **Prompt placement:** put the New thread prompt at the **Top**, **Center** or **Bottom** (the default).
- **Prompt height:** **Standard**, **Two lines** or **One line**. It still grows as you type.
- **Icon packs:** **BB Default**, **Lucide**, **Iconoir** or **Tabler Outline**, applied live. Provider logos and brand marks are unchanged.
- **Spinner:** follow the icon pack, or pick its own style.
- **Open With filtering:** hide whole categories (Default app, File managers, Editors & IDEs, Terminals, Other applications) or single apps from the Open With menu and chat file-link menus.
- **Alt+1 to Alt+9** switch to the first nine tabs of the focused right panel. Rebind them under BB's keyboard shortcuts as **Right panel: switch to tab N**.
- **Sidebar animation:** the left sidebar opens and closes with the same motion as the right panel. A switch, **Disable sidebar and panel animations**, makes both instant.

![UI Tweaks settings: animations, Clearer hierarchy, Steer labels, syntax highlighting, prompt position and height](https://raw.githubusercontent.com/wy3z/bb-cursor-suite/main/docs/media/ui-tweaks-settings.png)

![The icon pack cards (BB Default, Lucide, Iconoir, Tabler Outline) and the spinner options](https://raw.githubusercontent.com/wy3z/bb-cursor-suite/main/docs/media/ui-tweaks-icon-packs.png)

Configure everything under **Settings → Plugins → UI Tweaks**. Settings are saved on the BB server, so every device signed in to the same BB shares them.

## Install

```sh
bb marketplace add git:github.com/wy3z/bb-cursor-suite@main --subdirectory marketplace
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.30.1 --plugin ui-tweaks --tag-prefix ui-tweaks/
```

Needs BB `>=0.49` and plugin SDK `>=0.6.132 <0.7`. Workspace app discovery uses BB's local host daemon. In a client that can't reach it, the filter shows the last saved app list and says discovery is unavailable.

## For agents

UI Tweaks adds no CLI commands or agent tools. Its two RPC methods and the stored preferences shape are in [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md#for-agents).

## Development

```sh
npm install
npm run check
bb plugin install . --yes
```

`lib/icon-data.ts` is generated from `scripts/icon-map.mjs` with
`npm run generate:icons`. Only mapped SVG bodies are checked in; the full icon
packs stay in dev dependencies.

## Icon artwork

- [Lucide](https://lucide.dev), [ISC](https://lucide.dev/license).
- [Iconoir](https://github.com/iconoir-icons/iconoir) and
  [Tabler Icons](https://github.com/tabler/tabler-icons), MIT.

Full notices ship in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Licence

[MIT](LICENSE)

---

Not affiliated with, endorsed by or sponsored by Anysphere, Inc. Cursor is a trademark of Anysphere, Inc.
