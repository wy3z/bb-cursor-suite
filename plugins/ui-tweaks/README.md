# BB UI Tweaks

Small, configurable interface improvements for BB.

## Features

- Adjust the active theme’s global base font size with **− / +**, in 1 pt steps.
  The saved offset follows theme changes; **Reset** restores the theme default.
  Rem-based text and spacing scale with the base size; fixed-pixel content is unchanged.

- Position the New thread prompt at the top, centre, or bottom.
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
