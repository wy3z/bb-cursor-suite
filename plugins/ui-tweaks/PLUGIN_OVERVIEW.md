UI Tweaks collects the small interface changes that BB does not expose as
settings. Everything sits in one section under **Settings → Plugins → UI
Tweaks**, and most changes apply as you toggle them.

## What you get

**Clearer hierarchy.** Bolder thread titles, slightly larger chat prose, and
semibold bold text. Headings, code, and other sizes and weights stay put. This
is on by default.

**Hide Steer labels.** Optionally removes the Steer tag on messages that
steered a running agent. Off by default.

**Better syntax highlighting.** Optional File Editor tokenizers for CSS,
TypeScript and JavaScript that tell functions, constants, operators, built-in
types, selectors and `@media` queries apart, so code looks closer to Zed or VS
Code. Off by default; your theme picks the colours.

**Prompt placement.** Put the New thread composer at the top, center, or bottom
of the empty thread. Set its starting height to default, two lines, or one
line. It still grows as you type.

**Icon packs.** Switch BB's interface icons between BB Default, Lucide, Iconoir,
and Tabler Outline. The change applies live and lasts across reloads. Provider
logos and brand marks are left alone.

**Spinner.** Give the shared Loading and Spinner icons their own style, or let
them follow the icon pack. Every other icon keeps the main pack.

**Open With filter.** Hide workspace apps from the Open With menu and chat file
link context menus. Switch off a whole category (Default app, File managers,
Editors & IDEs, Terminals, Other applications), or expand one and hide single
apps. Hidden apps stay in the list so you can bring them back.

**Sidebar animation.** The left sidebar opens and closes with the same motion as
the right panel. This is always on. A separate switch, **Disable sidebar and
panel animations**, makes both open and close instantly.

**Reset to defaults.** One button restores every setting.

## How it works

Settings are saved on the BB server, so every device signed in to the same BB
(desktop, browser, phone) shares them. Each client keeps a local copy so the
interface applies instantly, and picks up changes from other devices when it
loads or regains focus. Icon
artwork ships inside the plugin as a small set of SVG bodies, so no icon
package is downloaded at runtime.

Workspace apps are discovered from BB's local host daemon on loopback. A client
that cannot reach the daemon keeps showing the last saved list and marks
discovery as unavailable. The plugin sends no data to an external service.

## Requirements

BB `>=0.49 <0.50` and Plugin SDK `>=0.6.132 <0.7`. No external service, account, or
separate install is needed.

---

Not affiliated with, endorsed by or sponsored by Anysphere, Inc. Cursor is a trademark of Anysphere, Inc.
