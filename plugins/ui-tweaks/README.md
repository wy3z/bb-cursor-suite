# BB UI Tweaks

Small, configurable improvements to BB's interface, collected in one plugin.
Every tweak is optional, stored per browser, and designed to leave BB unchanged
when the relevant interface cannot be identified safely.

## Features

### Fonts

- Set the interface font used by BB's navigation, messages, dialogs, and plugin
  UI.
- Set the code font used for code blocks and monospace text independently.
- Enter ordinary font names such as `Inter Variable` or
  `FiraCode Nerd Font Mono`; CSS syntax is not required.
- Adjust interface and code font sizes separately.
- Leave a field empty to inherit the active theme. A custom font automatically
  keeps the theme font as its fallback.

### New-thread prompt position

Place the composer at the top, centre, or bottom of the empty New thread view.
This only changes the initial prompt position and does not reorder prompt-adjacent
content or keyboard navigation.

### Open With Filter

- Show or hide application groups in BB's workspace **Open With** menu:
  default app, file managers, editors and IDEs, terminals, and other
  applications.
- Expand a group to control individual discovered applications.
- Distinguish desktop applications that share a display label, such as Evince
  and Papers both reporting themselves as “Document Viewer”.
- Leave unknown or ambiguous live menu entries visible rather than risk hiding
  the wrong command.

The complete launcher list is supplied by BB's local host service and is
primarily available on Linux. macOS can expose a shorter, workspace-specific
list. A browser client only contacts that local service when BB's local-network
access is already available; this plugin never prompts for that permission.

### Sidebar Footer

- Show or hide supported buttons at the bottom-left of the thread sidebar,
  including actions contributed by other plugins.
- See each action with the same glyph used in the footer.
- Keep a hidden plugin action in settings so it can still be restored after BB
  restarts or the contributing plugin reloads.
- Keep BB's Settings action and host-defined ordering intact.

## Configuration

Open **Settings → Plugins → UI Tweaks**. Each section has its own
**Reset to defaults** button.

Preferences are stored in the current browser profile, allowing different BB
clients to use different fonts and interface choices. UI Tweaks does not send
preferences or application inventory to an external service.

## Deliberate limits

UI Tweaks only includes changes that can be delivered as a plugin without
patching BB. Window transparency and frameless-window changes are therefore not
included. Sidebar layouts remain under **Settings → Appearance → Sidebar**;
UI Tweaks does not import or execute other plugins to discover their layouts.

## Compatibility

Version 0.16 supports BB 0.39 and plugin SDK 0.4.x. The range is intentionally
bounded because prompt placement, Open With filtering, and footer customization
use guarded BB 0.39 interface hooks. If a supported hook is absent, UI Tweaks
leaves that part of the interface alone.

## Installation

Once listed in the BB Community marketplace:

```sh
bb plugin install ui-tweaks@bb-community
```

For local development:

```sh
git clone https://github.com/wy3z/bb-plugin-ui-tweaks.git
cd bb-plugin-ui-tweaks
npm install
npm run check
bb plugin install . --yes
```

## Development

- `npm test` runs the focused regression tests.
- `npm run typecheck` validates the TypeScript sources against BB's plugin SDK.
- `npm run build` creates the BB bundles in `dist/`.
- `npm run check` runs the same test, typecheck, and build sequence as CI.

## License

[MIT](LICENSE)
