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
        ? "Saved. The server picks the new mode up on its next sweep."
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
      setNotice("Reset to defaults (mode off).");
    } else {
      setNotice(`Reset failed: ${state.saveError ?? "unknown error"}.`);
    }
  }

  if (state.status === "loading") {
    return (
      <SettingsSection title="Idle cleanup">
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
      <SettingsSection title="Idle cleanup">
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
      <SettingsSection title="Idle cleanup">
        <SettingsCard>
          {state.status === "invalid" ? (
            <SettingsRow label="Invalid" error={state.error} />
          ) : (
            <SettingsRow label="Automation">
              <Text style={styles.muted}>Loading…</Text>
            </SettingsRow>
          )}
          <SettingsAction
            label="Defaults"
            hint="Replaces the document with mode off."
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
    <SettingsSection title="Idle cleanup">
      <SettingsCard>
        <SettingsSelect
          label="Mode"
          hint="off keeps the manual hint only. compact-warm compacts before the cache TTL expires; clear empties the session."
          value={draft.mode}
          options={[
            { label: "off", value: "off" },
            { label: "clear", value: "clear" },
            { label: "compact-warm", value: "compact-warm" },
          ]}
          onValueChange={(value) => update({ ...draft, mode: value })}
        />
        <SettingsSwitch
          label="Acknowledge clear"
          hint="Required for mode clear: after /clear only the new session survives a reload; the old history stays available through the saved session import."
          value={draft.clearAcknowledged}
          disabled={state.saving}
          onValueChange={(next) => update({ ...draft, clearAcknowledged: next })}
        />
        <SettingsInput
          key={`idle-${formKey}`}
          label="Idle minutes"
          hint="Minimum idle time before mode clear acts (default 60)."
          initialValue={numberInput("idleMinutes")}
          onChangeText={(value) =>
            update({ ...draft, idleMinutes: Number.parseInt(value.trim(), 10) })
          }
        />
        <SettingsInput
          key={`compact-${formKey}`}
          label="Compact at minutes"
          hint="Idle time before mode compact-warm acts (default 50, before a 1 h TTL expires)."
          initialValue={numberInput("compactAtMinutes")}
          onChangeText={(value) =>
            update({ ...draft, compactAtMinutes: Number.parseInt(value.trim(), 10) })
          }
        />
        <SettingsInput
          key={`ctx-${formKey}`}
          label="Min context tokens"
          hint="Agents below this context size are left alone (default 60000)."
          initialValue={numberInput("minContextTokens")}
          onChangeText={(value) =>
            update({ ...draft, minContextTokens: Number.parseInt(value.trim(), 10) })
          }
        />
        <SettingsInput
          key={`providers-${formKey}`}
          label="Providers"
          hint="Comma-separated provider ids (default claude)."
          initialValue={draft.providers.join(",")}
          onChangeText={(value) => update({ ...draft, providers: asList(value) })}
        />
        <SettingsInput
          key={`roles-${formKey}`}
          label="Roles"
          hint="Comma-separated roles, steer and/or worker."
          initialValue={draft.roles.join(",")}
          onChangeText={(value) => update({ ...draft, roles: asList(value) })}
        />
        <SettingsSwitch
          label="Seed after clear"
          hint="Sends a one-line resume reminder after a verified clear (costs one small turn)."
          value={draft.seedAfterClear}
          disabled={state.saving}
          onValueChange={(next) => update({ ...draft, seedAfterClear: next })}
        />
        <SettingsInput
          key={`cap-${formKey}`}
          label="Daily cap"
          hint="Maximum automatic cleanups per host and day (default 20)."
          initialValue={numberInput("dailyCap")}
          onChangeText={(value) =>
            update({ ...draft, dailyCap: Number.parseInt(value.trim(), 10) })
          }
        />
        {errors.map((message) => (
          <SettingsRow key={message} label="Invalid" error={message} />
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
          hint={changed ? "Writes the whole document." : "No unsaved changes."}
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
          hint="Replaces the document with mode off."
          actionLabel="Reset to defaults"
          onPress={() => void reset()}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
