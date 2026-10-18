# BB UI Tweaks

Small, configurable interface improvements for BB.

## Features

- Change the size of all text with **− / +**, in 1 pt steps. **Reset** restores
  the theme default. Only text changes; spacing stays put.

- Resize text in individual sections with **− / +**, in 1 pt steps: sidebar,
  thread header, chat, prompt box, right panel, main area, menus and popovers,
  and code. All sizes are plain points and add up: global, then section, then
  code inside that section.

- Position the New thread prompt at the top, centre, or bottom.
- Shrink the empty prompt box to two lines or one line. It still grows as you type.
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

## License

[MIT](LICENSE)
