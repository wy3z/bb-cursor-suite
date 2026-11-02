# BB UI Tweaks

Small, configurable interface improvements for BB.

## Features

- Match the left sidebar's open and close animation to the right panel.

- Change the size of all text with **− / +**, in 1 pt steps. **Reset** restores
  the theme default. Only text changes; spacing stays put.

- Resize text in individual sections with **− / +**, in 1 pt steps: sidebar,
  thread header, chat, prompt box, right panel, main area, menus and popovers,
  and code. All sizes are plain points and add up: global, then section, then
  code inside that section.

- Position the New thread prompt at the top, centre, or bottom.
- Shrink the empty prompt box to two lines or one line. It still grows as you type.
- Switch BB's interface icons between **BB Default**, **Solar Linear**, and
  **Lucide**. The choice applies live and persists. Provider logos and brand
  marks are unchanged.
- Filter workspace applications from the **Open With** menu and chat file-link
  context menus.

Configure everything under **Settings → Plugins → UI Tweaks**.

Sidebar footer buttons are no longer handled here. BB 0.46 does this itself
under **More → Customize footer**.

## Installation

```sh
bb plugin install git:https://github.com/wy3z/bb-plugin-ui-tweaks.git
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

- [Solar Icons](https://github.com/480-Design/Solar-Icon-Set) by 480 Design,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The Solar Linear
  pack uses these glyphs.
- [Lucide](https://lucide.dev), [ISC](https://lucide.dev/license).

Full notices ship in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE)
