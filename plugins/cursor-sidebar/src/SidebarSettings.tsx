import { SettingsCard, SettingsLinkButton, SettingsRow } from "@wy3z/bb-suite/settings";

export function SidebarSettings() {
  return (
    <SettingsCard>
      <SettingsRow
        label="Sidebar and header"
        description="Choose Cursor Sidebar under Sidebar thread list, and Compact or Cursor under Navigation. Pick BB's own list there to turn the sidebar off."
      >
        {({ descriptionId }) => (
          <SettingsLinkButton href="/settings/appearance" aria-describedby={descriptionId}>
            Open Appearance
          </SettingsLinkButton>
        )}
      </SettingsRow>
      <SettingsRow
        label="View options"
        description="Grouping, ordering, filters and what each row shows live in the sidebar's Customize menu, at the top of the thread list. They're saved for every device."
      />
    </SettingsCard>
  );
}
