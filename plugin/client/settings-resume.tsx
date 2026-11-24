import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { factoryResumeSettings } from "../shared/settings.js";

/**
 * Window for "needs resume": a steer whose last turn ended less than this many
 * hours ago counts as recently active (factory-resume.recentHours, default 24).
 */
export function ResumeSettingsSection({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const state = useSettings(factoryResumeSettings);
  const [hours, setHours] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (state.status !== "ready") {
    return (
      <SettingsSection title="Resume">
        <SettingsCard>
          <SettingsRow label="Resume window">
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
              {state.status === "loading" ? "Loading…" : "Unavailable."}
            </Text>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    );
  }
  const stored = (state.values as { recentHours: number }).recentHours;
  const parsed = hours === null ? stored : Number.parseInt(hours.trim(), 10);
  const valid = Number.isInteger(parsed) && parsed >= 1;
  return (
    <SettingsSection title="Resume">
      <SettingsCard>
        <SettingsInput
          label="Recently active (hours)"
          hint="A steer whose last turn ended within this many hours is treated as recently active when the plugin checks which steers need a resume. Default 24."
          initialValue={String(stored)}
          onChangeText={setHours}
        />
        {!valid ? (
          <SettingsRow label="Please fix" error="Enter a whole number of hours, at least 1." />
        ) : null}
        {notice ? (
          <SettingsRow label="Status">
            <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{notice}</Text>
          </SettingsRow>
        ) : null}
        <SettingsAction
          label="Save"
          hint={valid ? "Saves the resume window." : "Enter a whole number of hours, at least 1."}
          actionLabel={state.saving ? "Saving…" : "Save"}
          disabled={!valid || parsed === stored || state.saving}
          onPress={() => {
            void state
              .save({ ...(state.values as { providers: string[]; recentHours: number }), recentHours: parsed }, state.revision)
              .then((ok) => setNotice(ok ? "Saved." : `Not saved: ${state.saveError ?? "revision conflict"}.`));
          }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
