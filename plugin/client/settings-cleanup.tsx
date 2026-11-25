import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { factoryCleanupSettings } from "../shared/settings.js";
import { AutosaveInput, SettingsSaveError, useAutosave } from "./settings-autosave.js";
import { commaSeparated, wholeNumber } from "./settings-edit.js";

const SECTION_TITLE = "Idle agents";
const SECTION_INFO =
  "Long-idle agents lose their provider cache. The next message can then use a large share of quota. Cleanup keeps the agent tab so it can continue from its checkpoint with /factory resume.";

export function CleanupSettingsSection() {
  const { state, change, errors } = useAutosave(factoryCleanupSettings);
  if (state.status !== "ready") {
    return (
      <SettingsSection title={SECTION_TITLE} info={SECTION_INFO}>
        <SettingsCard>
          {state.status === "loading" ? (
            <SettingsRow label="Loading idle-agent settings…" />
          ) : (
            <SettingsAction label="Idle-agent settings" error={state.error} actionLabel="Reload" onPress={() => void state.reload()} />
          )}
        </SettingsCard>
      </SettingsSection>
    );
  }

  const values = state.values;
  const save = change(SECTION_TITLE);
  const needsAcknowledgement = values.mode === "clear" && !values.clearAcknowledged;

  return (
    <SettingsSection title={SECTION_TITLE} info={SECTION_INFO}>
      <SettingsCard>
        <SettingsSelect
          label="What to do with idle agents"
          hint="Off shows an “Idle chat” hint. Compact shrinks the chat with a small model turn. Clear uses a new chat in the same tab after you acknowledge it below."
          value={values.mode}
          options={[
            { label: "Off – only show a hint", value: "off" },
            { label: "Compact before the cache expires", value: "compact-warm" },
            { label: "Clear the chat (default)", value: "clear" },
          ]}
          onValueChange={(mode) => void save((current) => ({ ...current, mode }))}
        />
        <SettingsSelect
          label="Cost profile"
          hint="Timing for Compact. Efficiency acts earlier, Balanced acts shortly before the cache expires, and Comfort acts less often."
          value={values.profile}
          options={[
            { label: "Maximum efficiency – compact early, even small chats", value: "efficiency" },
            { label: "Balanced (default) – compact before the cache cools", value: "balanced" },
            { label: "Comfort – compact rarely and late", value: "comfort" },
          ]}
          onValueChange={(profile) => void save((current) => ({ ...current, profile }))}
        />
        <AutosaveInput
          label="Clear after (minutes idle)"
          hint="Also controls when the idle hint appears. Default 60."
          stored={String(values.idleMinutes)}
          save={save}
          edit={(text) => {
            const idleMinutes = wholeNumber(text);
            if (!Number.isSafeInteger(idleMinutes) || idleMinutes < 5) return "Enter a whole number of minutes, at least 5.";
            return (current) => ({ ...current, idleMinutes });
          }}
        />
        <AutosaveInput
          label="Only chats larger than (tokens)"
          hint="Default 60,000."
          stored={String(values.minContextTokens)}
          save={save}
          edit={(text) => {
            const minContextTokens = wholeNumber(text);
            if (!Number.isSafeInteger(minContextTokens) || minContextTokens < 1000) return "Enter a whole number of tokens, at least 1,000.";
            return (current) => ({ ...current, minContextTokens });
          }}
        />
        <AutosaveInput
          label="Providers"
          hint="Comma-separated provider IDs. Default claude. Codex supports Compact."
          stored={values.providers.join(",")}
          save={save}
          edit={(text) => {
            const providers = commaSeparated(text);
            if (!providers.length) return "Enter at least one provider ID.";
            return (current) => ({ ...current, providers });
          }}
        />
        <AutosaveInput
          label="Agent roles"
          hint="Enter steer, worker, or both separated by a comma."
          stored={values.roles.join(",")}
          save={save}
          edit={(text) => {
            const roles = commaSeparated(text);
            if (!roles.length || !roles.every((role) => role === "steer" || role === "worker")) {
              return "Enter steer, worker, or both.";
            }
            return (current) => ({ ...current, roles });
          }}
        />
        <SettingsSwitch
          label="I understand what Clear does"
          hint="After a reload, the agent tab shows the new chat. Open the saved chat in the Factory: context panel."
          error={needsAcknowledgement ? "Clear starts after you turn on this acknowledgement." : null}
          value={values.clearAcknowledged}
          onValueChange={(clearAcknowledged) => void save((current) => ({ ...current, clearAcknowledged }))}
        />
        <SettingsSwitch
          label="Rewind “fresh” Codex chats in place"
          hint="When cleanup recommends a fresh Codex agent, rewind the chat in its existing tab. The agent continues from its checkpoint with /factory resume."
          value={values.rewindFresh}
          onValueChange={(rewindFresh) => void save((current) => ({ ...current, rewindFresh }))}
        />
        <AutosaveInput
          label="Max automatic actions per day"
          hint="Host-wide limit. Default 20."
          stored={String(values.dailyCap)}
          save={save}
          edit={(text) => {
            const dailyCap = wholeNumber(text);
            if (!Number.isSafeInteger(dailyCap) || dailyCap < 1) return "Enter a whole number of actions, at least 1.";
            return (current) => ({ ...current, dailyCap });
          }}
        />
        <SettingsSaveError error={errors[SECTION_TITLE]} />
      </SettingsCard>
    </SettingsSection>
  );
}
