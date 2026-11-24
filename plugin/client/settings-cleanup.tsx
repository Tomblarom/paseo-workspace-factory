import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { factoryCleanupSettings } from "../shared/settings.js";
import {
  validateCleanupSettings,
  type CleanupSettingsValues,
} from "../shared/settings-validate.js";

function clone(values: CleanupSettingsValues): CleanupSettingsValues {
  return JSON.parse(JSON.stringify(values)) as CleanupSettingsValues;
}

// Validated document shape for save(); mirrors the zod schema in
// shared/settings.ts (the draft stays loose so invalid input can be shown).
type CleanupDoc = {
  mode: "off" | "clear" | "compact-warm";
  idleMinutes: number;
  compactAtMinutes: number;
  minContextTokens: number;
  providers: string[];
  roles: ("steer" | "worker")[];
  seedAfterClear: boolean;
  clearAcknowledged: boolean;
  dailyCap: number;
};

const SECTION_TITLE = "Idle agents (save quota)";

const SECTION_INFO =
  "An agent that sat idle for a long time loses its provider cache: its next message re-reads the whole chat and can cost a large share of a usage limit. These settings decide what the plugin does with such agents. Nothing is deleted and the agent keeps its tab; afterwards it continues from its checkpoint with /factory resume.";

function asList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Host-scope idle cleanup (C5) settings: automation mode, thresholds, and the
 * explicit acknowledgement that unlocks mode clear.
 */
export function CleanupSettingsSection({
  theme,
  layout,
}: Pick<PluginSurfaceProps, "theme" | "layout">) {
  const state = useSettings(factoryCleanupSettings);
  const [draft, setDraft] = useState<CleanupSettingsValues | null>(null);
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    if (state.status === "ready" && draft === null) {
      setDraft(clone(state.values as CleanupSettingsValues));
      setBaseRevision(state.revision);
    }
  }, [state, draft]);

  useEffect(() => {
    if (
      state.status === "ready" &&
      draft !== null &&
      baseRevision !== null &&
      state.revision !== baseRevision &&
      JSON.stringify(state.values) === JSON.stringify(draft)
    ) {
      setBaseRevision(state.revision);
    }
  }, [state, draft, baseRevision]);

  const styles = useMemo(
    () => ({
      text: { color: theme.colors.foreground, fontSize: 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 14 },
    }),
    [theme, layout.compact],
  );

  const savedJson = state.status === "ready" ? JSON.stringify(state.values) : null;
  const changed = draft !== null && savedJson !== null && JSON.stringify(draft) !== savedJson;
  const errors = useMemo(() => (draft ? validateCleanupSettings(draft) : []), [draft]);

  async function save(): Promise<void> {
    if (!draft || !baseRevision || state.status !== "ready" || errors.length > 0) return;
    setNotice(null);
    const ok = await state.save(draft as unknown as CleanupDoc, baseRevision);
    setNotice(
      ok
        ? "Saved. Takes effect within five minutes (next check of idle agents)."
        : `Not saved: ${state.saveError ?? "revision conflict"}. Reload and retry.`,
    );
  }

  function discard(): void {
    if (state.status !== "ready") return;
    setDraft(clone(state.values as CleanupSettingsValues));
    setBaseRevision(state.revision);
    setNotice(null);
    setFormKey((key) => key + 1);
  }

  async function reset(): Promise<void> {
    if (state.status !== "ready" && state.status !== "invalid") return;
    const ok = await state.reset();
    if (ok) {
      setDraft(null);
      setBaseRevision(null);
      setNotice("Reset to defaults: idle agents are only marked, nothing is sent.");
    } else {
      setNotice(`Reset failed: ${state.saveError ?? "unknown error"}.`);
    }
  }

  if (state.status === "loading") {
    return (
      <SettingsSection title={SECTION_TITLE} info={SECTION_INFO}>
        <SettingsCard>
          <SettingsRow label="Automation">
            <Text style={styles.muted}>Loading…</Text>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (state.status === "error") {
    return (
      <SettingsSection title={SECTION_TITLE} info={SECTION_INFO}>
        <SettingsCard>
          <SettingsRow label="Automation" error={state.error}>
            <SettingsAction label="Retry" actionLabel="Reload" onPress={() => void state.reload()} />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (state.status === "invalid" || !draft) {
    return (
      <SettingsSection title={SECTION_TITLE} info={SECTION_INFO}>
        <SettingsCard>
          {state.status === "invalid" ? (
            <SettingsRow label="Stored settings are invalid" error={state.error} />
          ) : (
            <SettingsRow label="Automation">
              <Text style={styles.muted}>Loading…</Text>
            </SettingsRow>
          )}
          <SettingsAction
            label="Defaults"
            hint="Back to the defaults: off, 60 minutes, claude only."
            actionLabel="Reset to defaults"
            onPress={() => void reset()}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }

  const update = (next: CleanupSettingsValues) => {
    setDraft(next);
    setNotice(null);
  };
  const numberInput = (key: "idleMinutes" | "compactAtMinutes" | "minContextTokens" | "dailyCap") =>
    String(draft[key] ?? "");

  return (
    <SettingsSection title={SECTION_TITLE} info={SECTION_INFO}>
      <SettingsCard>
        <SettingsSelect
          label="What to do with idle agents"
          hint="Off only shows a \u201cKontext kalt\u201d hint on the agent; nothing is sent. Compact shrinks the chat shortly before the provider cache expires (one small model turn). Clear empties the chat (no model turn) and needs the confirmation below."
          value={draft.mode}
          options={[
            { label: "Off \u2013 only show a hint (default)", value: "off" },
            { label: "Compact before the cache expires", value: "compact-warm" },
            { label: "Clear the chat", value: "clear" },
          ]}
          onValueChange={(value) => update({ ...draft, mode: value })}
        />
        <SettingsInput
          key={`compact-${formKey}`}
          label="Compact after (minutes idle)"
          hint="Used by Compact. Default 50: just before the 1-hour cache of subscription plans expires. With a 5-minute cache (API keys) compacting rarely pays off."
          initialValue={numberInput("compactAtMinutes")}
          onChangeText={(value) =>
            update({ ...draft, compactAtMinutes: Number.parseInt(value.trim(), 10) })
          }
        />
        <SettingsInput
          key={`idle-${formKey}`}
          label="Clear after (minutes idle)"
          hint="Used by Clear and by the hint. Default 60, the cache lifetime of subscription plans."
          initialValue={numberInput("idleMinutes")}
          onChangeText={(value) =>
            update({ ...draft, idleMinutes: Number.parseInt(value.trim(), 10) })
          }
        />
        <SettingsInput
          key={`ctx-${formKey}`}
          label="Only chats larger than (tokens)"
          hint="Smaller chats are cheap to continue and are left alone. Default 60000."
          initialValue={numberInput("minContextTokens")}
          onChangeText={(value) =>
            update({ ...draft, minContextTokens: Number.parseInt(value.trim(), 10) })
          }
        />
        <SettingsInput
          key={`providers-${formKey}`}
          label="Providers"
          hint="Comma-separated provider ids. Default claude, the provider whose cache expires; others are not touched."
          initialValue={draft.providers.join(",")}
          onChangeText={(value) => update({ ...draft, providers: asList(value) })}
        />
        <SettingsInput
          key={`roles-${formKey}`}
          label="Agent roles"
          hint="steer (coordinating agents), worker (helpers), or both, comma-separated. Default both."
          initialValue={draft.roles.join(",")}
          onChangeText={(value) => update({ ...draft, roles: asList(value) })}
        />
        <SettingsSwitch
          label="I understand what Clear does"
          hint="Required for Clear. The agent keeps its tab, but after an app reload or daemon restart the tab shows only the new, short chat. The old chat can still be opened as an extra tab from the \u201cKontext kalt\u201d panel."
          value={draft.clearAcknowledged}
          disabled={state.saving}
          onValueChange={(next) => update({ ...draft, clearAcknowledged: next })}
        />
        {draft.mode === "clear" && !draft.clearAcknowledged ? (
          <SettingsRow
            label="Clear is not active yet"
            error="Turn on \u201cI understand what Clear does\u201d, or pick another option."
          />
        ) : null}
        <SettingsSwitch
          label="Remind the agent after clearing"
          hint="Sends one line asking the agent to run resume before its next task. Costs one small turn. Off by default; the steer instructions already contain this rule."
          value={draft.seedAfterClear}
          disabled={state.saving}
          onValueChange={(next) => update({ ...draft, seedAfterClear: next })}
        />
        <SettingsInput
          key={`cap-${formKey}`}
          label="Max automatic actions per day"
          hint="Safety limit for this host. Default 20."
          initialValue={numberInput("dailyCap")}
          onChangeText={(value) =>
            update({ ...draft, dailyCap: Number.parseInt(value.trim(), 10) })
          }
        />
        {errors.map((message) => (
          <SettingsRow key={message} label="Please fix" error={message} />
        ))}
        {notice ? (
          <SettingsRow label="Status">
            <Text style={styles.text}>{notice}</Text>
          </SettingsRow>
        ) : null}
        {state.saveError && !notice ? (
          <SettingsRow label="Save error" error={state.saveError} />
        ) : null}
        <SettingsAction
          label="Save"
          hint={changed ? "Saves all idle-agent settings." : "No unsaved changes."}
          actionLabel={state.saving ? "Saving…" : "Save"}
          disabled={!changed || state.saving || errors.length > 0}
          onPress={() => void save()}
        />
        <SettingsAction
          label="Discard"
          actionLabel="Discard changes"
          disabled={!changed}
          onPress={discard}
        />
        <SettingsAction
          label="Defaults"
          hint="Back to the defaults: off, 60 minutes, claude only."
          actionLabel="Reset to defaults"
          onPress={() => void reset()}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
