import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { factorySteerMenuSettings } from "../shared/settings.js";
import { SettingsSaveError, useAutosave } from "./settings-autosave.js";

const SECTION_TITLE = "Steer menu";
const SECTION_INFO =
  "Post-reset continuation and chat history for steers.";

export function SteerMenuSettingsSection() {
  const { state, change, errors } = useAutosave(factorySteerMenuSettings);
  if (state.status !== "ready") {
    return (
      <SettingsSection title={SECTION_TITLE} info={SECTION_INFO}>
        <SettingsCard>
          {state.status === "loading" ? (
            <SettingsRow label="Loading steer menu settings…" />
          ) : (
            <SettingsAction
              label="Steer menu settings"
              error={state.error}
              actionLabel="Reload"
              onPress={() => void state.reload()}
            />
          )}
        </SettingsCard>
      </SettingsSection>
    );
  }

  const values = state.values;
  const save = change(SECTION_TITLE);

  return (
    <SettingsSection title={SECTION_TITLE} info={SECTION_INFO}>
      <SettingsCard>
        <SettingsSelect
          label="After reset"
          hint="Choose what happens to assigned open work after Reset Steer. Handover continues automatically on confirmation."
          value={values.afterReset}
          options={[
            { label: "Continue assigned open work", value: "continue" },
            { label: "Place brief in composer", value: "composer" },
            { label: "Wait", value: "wait" },
          ]}
          onValueChange={(afterReset) =>
            void save((current) => ({ ...current, afterReset }))
          }
        />
        <SettingsSwitch
          label="Keep chat history"
          hint="Preserve steer chats during automatic delivery and cleanup. Reset Steer is unavailable on Paseo versions that require discarding messages."
          value={values.keepChatHistory}
          onValueChange={(keepChatHistory) =>
            void save((current) => ({ ...current, keepChatHistory }))
          }
        />
        <SettingsSaveError error={errors[SECTION_TITLE]} />
      </SettingsCard>
    </SettingsSection>
  );
}
