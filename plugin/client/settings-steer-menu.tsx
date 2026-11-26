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
  "Brief delivery for new steers and chat history for automatic actions.";

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
          label="Initialize new steer"
          hint="Send delivers the brief at once. Composer places it in the Paseo composer (goes out with the next own prompt; falls back to sending when no composer tab is open). Later leaves the composer empty for the steer menu."
          value={values.initializeNewSteer}
          options={[
            { label: "Send the brief at once", value: "send" },
            { label: "Place the brief in the composer (default)", value: "composer" },
            { label: "Leave the composer empty", value: "later" },
          ]}
          onValueChange={(initializeNewSteer) =>
            void save((current) => ({ ...current, initializeNewSteer }))
          }
        />
        <SettingsSwitch
          label="Keep chat history"
          hint="Preserve steer chats during automatic delivery and cleanup, using native compaction when needed and supported."
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
