# BB UI Tweaks

Small, configurable interface improvements for BB.

## Features

- Match the left sidebar's open and close animation to the right panel. This
  is always on and has no setting.

- **Disable sidebar and panel animations** (off by default): the left sidebar
  and the right panel open and close instantly instead of sliding.

- **Clearer hierarchy** (on by default): bolder thread titles, slightly larger
  chat prose, and semibold bold text. Other sizes and weights stay put.

- **Hide Steer labels in chats** (off by default): removes the Steer tag
  shown on messages that steered a running agent, including pending and
  failed ones.

- **Better syntax highlighting in the File Editor** (off by default): teaches
  Monaco more about CSS, TypeScript and JavaScript. CSS gets a tokenizer that
  understands `@media`, nested rules, pseudo-classes, attribute selectors,
  value keywords and functions; TypeScript and JavaScript tell functions,
  constants, operators, built-in types and `null`/`this` apart. Your BB theme
  still picks the colours. Turning it off restores Monaco's own tokenizers.

- Put the New thread prompt at the **Top**, **Center**, or **Bottom**. Bottom
  is the default.

- Set the empty prompt box to the **Default** height, **Two lines**, or **One
  line**. It still grows as you type.

- Switch BB's interface icons between **BB Default**, **Lucide**, **Iconoir**,
  and **Tabler Outline**. The choice applies live and persists. Provider logos
  and brand marks are unchanged.

- Set the spinner separately: **Follow icon pack**, **BB Default**, **Lucide**,
  **Iconoir**, or **Tabler Outline**. The spinner setting applies to the
  shared Loading and Spinner icons only.

- Filter workspace apps from the **Open With** menu and chat file-link context
  menus. Turn whole categories on or off, or expand a category and hide single
  apps. The categories are Default app, File managers, Editors & IDEs,
  Terminals, and Other applications. The first four are on by default.

- **Alt+1** to **Alt+9** switch to the first nine tabs of the focused
  surface's right panel, in the order BB's tab strip shows them. Rebind them
  under BB's keyboard shortcuts as **Right panel: switch to tab N**.

- **Reset to defaults** restores every setting above.

Configure everything under **Settings → Plugins → UI Tweaks**.

## Requirements

- BB `>=0.49`.
- Plugin SDK `>=0.6.132 <0.7`.

Workspace app discovery uses BB's local host daemon. In a client that cannot
reach the daemon, the filter shows the last saved app list and says discovery
is unavailable.

## Installation

```sh
bb marketplace add git:github.com/wy3z/bb-cursor-suite@main --subdirectory marketplace
bb plugin install git:https://github.com/wy3z/bb-cursor-suite.git@^0.30.1 --plugin ui-tweaks --tag-prefix ui-tweaks/
```

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

## License

[MIT](LICENSE)

---

Not affiliated with, endorsed by or sponsored by Anysphere, Inc. Cursor is a trademark of Anysphere, Inc.
