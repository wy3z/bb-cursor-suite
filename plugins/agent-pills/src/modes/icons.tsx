import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import { PROJECT_ICON_NAMES } from "@wy3z/bb-suite/project-icon";
import { ProjectIconGlyph } from "@wy3z/bb-suite/project-icon/picker";

const PREFIX = "bb-agent-pills-mode-";

export function modeIconName(icon: string): string {
  return `${PREFIX}${icon}`;
}

export function registerModeIcons(app: PluginAppBuilder): void {
  for (const name of PROJECT_ICON_NAMES) {
    app.experimental_icons.register({
      name: modeIconName(name),
      component: ({ className }) => <ProjectIconGlyph name={name} className={className} strokeWidth={2} />,
    });
  }
}
