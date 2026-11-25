import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { factoryResumeSettings } from "../shared/settings.js";
import { AutosaveInput, SettingsSaveError, useAutosave } from "./settings-autosave.js";
import { wholeNumber } from "./settings-edit.js";

const SECTION_TITLE = "Resume";

export function ResumeSettingsSection() {
  const { state, change, errors } = useAutosave(factoryResumeSettings);

  return (
    <SettingsSection title={SECTION_TITLE}>
      <SettingsCard>
        {state.status === "ready" ? (
          <AutosaveInput
            label="Recently active (hours)"
            hint="A steer counts as recently active if its last turn ended within this window. Default 24."
            stored={String(state.values.recentHours)}
            save={change(SECTION_TITLE)}
            edit={(text) => {
              const recentHours = wholeNumber(text);
              if (!Number.isSafeInteger(recentHours) || recentHours < 1) return "Enter a whole number of hours, at least 1.";
              return (current) => ({ ...current, recentHours });
            }}
          />
        ) : state.status === "loading" ? (
          <SettingsRow label="Loading resume settings…" />
        ) : (
          <SettingsAction label="Resume settings" error={state.error} actionLabel="Reload" onPress={() => void state.reload()} />
        )}
        <SettingsSaveError error={errors[SECTION_TITLE]} />
      </SettingsCard>
    </SettingsSection>
  );
}
