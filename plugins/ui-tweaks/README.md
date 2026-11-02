# BB UI Tweaks

Small, configurable interface improvements for BB.

## Features

- Match the left sidebar's open and close animation to the right panel.

- **Clearer hierarchy** (on by default): bolder thread titles, slightly larger
  chat prose, and semibold bold text. This is the typography option; no manual
  size sliders.

- Position the New thread prompt at the top, centre, or bottom.
- Shrink the empty prompt box to two lines or one line. It still grows as you type.
- Switch BB's interface icons between **BB Default**, **Lucide**, **Iconoir**,
  and **Tabler Outline**. The choice applies live and persists. Provider logos
  and brand marks are unchanged.
- Pick a separate spinner style, or let it follow the icon pack.
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

- [Lucide](https://lucide.dev), [ISC](https://lucide.dev/license).
- [Iconoir](https://github.com/iconoir-icons/iconoir) and
  [Tabler Icons](https://github.com/tabler/tabler-icons), MIT.

Full notices ship in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE)
