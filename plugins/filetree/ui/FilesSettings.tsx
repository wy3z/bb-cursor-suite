import { SettingsCard, SettingsRow } from "@wy3z/bb-suite/settings";
import "@wy3z/bb-suite/settings.css";

export function FilesSettings() {
  return (
    <SettingsCard>
      <SettingsRow
        label="Nothing to set"
        description="Files works as soon as it's installed. Open it from the Files tab in a thread's right panel."
      />
    </SettingsCard>
  );
}
