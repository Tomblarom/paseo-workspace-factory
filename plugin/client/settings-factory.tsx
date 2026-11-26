import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { CleanupSettingsSection } from "./settings-cleanup.js";
import { ResumeSettingsSection } from "./settings-resume.js";
import { SteerMenuSettingsSection } from "./settings-steer-menu.js";
import { factoryModelsList } from "../shared/factory.js";
import { formatModelList } from "../shared/models-format.js";
import { factoryPromptSettings } from "../shared/prompt-settings.js";
import { factoryConfigSettings, factoryDisplaySettings } from "../shared/settings.js";
import {
  GITHUB_OWNER_PATTERN,
  isAbsolutePath,
  validateFactorySettings,
  validateProfilesAgainstCatalogLocal,
  type FactorySettingsValues,
} from "../shared/settings-validate.js";
import { setCheckpointInChat } from "./checkpoint-display.js";
import { AutosaveInput, SettingsSaveError, useAutosave } from "./settings-autosave.js";
import { percentage, type SettingsEdit } from "./settings-edit.js";
import { ModelSettingsSections, type CatalogState } from "./settings-profiles.js";
import { usedProfileNames } from "./settings-routing.js";

const EFFECTIVE_INFO =
  "Availability is checked against the saved profiles and role priorities.";

const HOST_INFO =
  "Both fields are required. Fill in the GitHub owner and the checkout root to run the factory on this host.";

const QUOTA_INFO =
  "View sampled usage with /factory quota. Warnings favor other pools and exhausted pools are skipped.";

export function FactorySettings(props: PluginSurfaceProps) {
  return (
    <View style={{ gap: props.layout.compact ? 12 : 16 }}>
      <FactoryConfigSections {...props} />
      <CleanupSettingsSection />
      <ResumeSettingsSection />
      <SteerMenuSettingsSection />
      <DisplaySettingsSection />
    </View>
  );
}

function FactoryConfigSections({ theme, layout }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const { state: configState, change, errors: saveErrors } = useAutosave(factoryConfigSettings);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [catalog, setCatalog] = useState<CatalogState>({ state: "loading" });
  const callModels = useRpc(factoryModelsList);
  const [effective, setEffective] = useState<{ text: string } | { error: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    paseo.providers
      .snapshot()
      .then(({ entries }) => {
        if (!cancelled) setCatalog({ state: "ready", entries });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCatalog({
            state: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [paseo]);

  const settingsRevision = configState.status === "ready" ? configState.revision : null;
  useEffect(() => {
    // Effective lists come from the server (saved settings + live
    // catalog); refresh after every successful save.
    if (settingsRevision === null) return;
    let cancelled = false;
    callModels({})
      .then((list) => {
        if (cancelled) return;
        setEffective({ text: `${formatModelList("steer", list)}\n\n${formatModelList("worker", list)}` });
      })
      .catch((error: unknown) => {
        if (!cancelled) setEffective({ error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [callModels, settingsRevision]);

  const styles = useMemo(
    () => ({
      screen: { gap: layout.compact ? 12 : 16 },
      text: { color: theme.colors.foreground, fontSize: 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 14 },
    }),
    [theme, layout.compact],
  );

  if (configState.status !== "ready") {
    return (
      <SettingsSection title="Factory">
        <SettingsCard>
          {configState.status === "loading" ? (
            <SettingsRow label="Loading factory settings…" />
          ) : (
            <SettingsAction label="Factory settings" error={configState.error} actionLabel="Reload" onPress={() => void configState.reload()} />
          )}
        </SettingsCard>
      </SettingsSection>
    );
  }

  const draft = configState.values;

  function catalogIssues(values: FactorySettingsValues) {
    return catalog.state === "ready"
      ? validateProfilesAgainstCatalogLocal(values.profiles, catalog.entries, usedProfileNames(values))
      : {};
  }

  function issues(values: FactorySettingsValues) {
    const catalogErrors = Object.entries(catalogIssues(values)).flatMap(([name, problems]) =>
      problems.map((problem) => `Profile ${name}: ${problem}`),
    );
    return [...validateFactorySettings(values), ...catalogErrors];
  }

  function validated(edit: SettingsEdit<FactorySettingsValues>): SettingsEdit<FactorySettingsValues> {
    return (current) => {
      const next = edit(current);
      if (typeof next === "string") return next;
      const existing = new Set(issues(current));
      return issues(next).find((problem) => !existing.has(problem)) ?? next;
    };
  }

  function update(section: string, field: string, edit: SettingsEdit<FactorySettingsValues>) {
    setFieldErrors((current) => ({ ...current, [field]: null }));
    return change(section)(validated(edit)).then((result) => {
      if (result.status === "invalid") {
        setFieldErrors((current) => ({ ...current, [field]: result.error }));
      }
      return result.status === "saved";
    });
  }

  return (
    <View style={styles.screen}>
      <SettingsSection title="Host" info={HOST_INFO}>
        <SettingsCard>
          <AutosaveInput
            label="GitHub owner"
            hint="Account that owns the forks."
            placeholder="octocat"
            stored={draft.githubOwner ?? ""}
            save={change("Host")}
            edit={(text) => {
              const githubOwner = text.trim() || null;
              if (githubOwner && !GITHUB_OWNER_PATTERN.test(githubOwner)) return "Enter a GitHub account name.";
              return (current) => ({ ...current, githubOwner });
            }}
          />
          <AutosaveInput
            label="Checkout root"
            hint="Absolute directory where the factory clones repositories."
            placeholder="/home/you/projects"
            stored={draft.checkoutRoot ?? ""}
            save={change("Host")}
            edit={(text) => {
              const checkoutRoot = text.trim() || null;
              if (checkoutRoot && !isAbsolutePath(checkoutRoot)) return "Enter an absolute path.";
              return (current) => ({ ...current, checkoutRoot });
            }}
          />
          <SettingsSaveError error={saveErrors.Host} />
        </SettingsCard>
      </SettingsSection>

      <ModelSettingsSections
        draft={draft}
        catalog={catalog}
        catalogProblems={catalogIssues(draft)}
        fieldErrors={fieldErrors}
        saveErrors={saveErrors}
        update={update}
        theme={theme}
        compact={layout.compact}
      />

      <SettingsSection title="Configured routes" info={EFFECTIVE_INFO}>
        <SettingsCard>
          <SettingsRow label="Route availability">
            {effective === null ? (
              <Text style={styles.muted}>Loading…</Text>
            ) : "error" in effective ? (
              <Text style={styles.error}>{effective.error}</Text>
            ) : (
              <Text style={styles.text}>{effective.text}</Text>
            )}
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Quota" info={QUOTA_INFO}>
        <SettingsCard>
          {([
            { key: "warnPct", label: "Warn at (percent)", hint: "Default 75." },
            { key: "exhaustedPct", label: "Exhausted at (percent)", hint: "Default 90." },
          ] as const).map(({ key, label, hint }) => (
            <AutosaveInput
              key={key}
              label={label}
              hint={hint}
              stored={String(draft.quota[key])}
              save={change("Quota")}
              edit={(text) => {
                const value = percentage(text);
                if (!Number.isFinite(value) || value > 100) return "Enter a percentage from 0 to 100.";
                return (current) => ({ ...current, quota: { ...current.quota, [key]: value } });
              }}
            />
          ))}
          <SettingsSaveError error={saveErrors.Quota} />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

const DISPLAY_SECTION = "Chat and prompts";

function DisplaySettingsSection() {
  const { state, change, errors } = useAutosave(factoryDisplaySettings);
  const readPromptSettings = useRpc(factoryPromptSettings);
  const [installation, setInstallation] = useState<{
    read: typeof readPromptSettings;
    factoryRoot: string | null;
    error?: string;
  } | null>(null);
  const save = change(DISPLAY_SECTION);

  useEffect(() => {
    let cancelled = false;
    readPromptSettings({}).then(
      ({ factoryRoot }) => {
        if (!cancelled) setInstallation({ read: readPromptSettings, factoryRoot });
      },
      (error: unknown) => {
        if (!cancelled) {
          setInstallation({
            read: readPromptSettings,
            factoryRoot: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [readPromptSettings]);

  const currentInstallation = installation?.read === readPromptSettings ? installation : null;
  const factoryRoot = currentInstallation?.factoryRoot ?? null;
  const findingsHint = factoryRoot !== null
    ? `Adds a short passage to prompts of new steers and workers: record observations about using the factory in ${factoryRoot}/FINDINGS.md; entries move to TODO.md only with your consent. Off leaves the passage out.`
    : currentInstallation
      ? "Only available when the plugin is installed from the git checkout (build from source)."
      : "Checking the plugin installation…";

  return (
    <SettingsSection title={DISPLAY_SECTION}>
      <SettingsCard>
        {state.status === "ready" ? (
          <>
            <SettingsSwitch
              label="Show CHECKPOINT blocks in chat"
              hint="Turn off to show a checkmark and short title in chat."
              value={state.values.checkpointInChat}
              onValueChange={(checkpointInChat) => void save((current) => ({ ...current, checkpointInChat })).then((result) => {
                if (result.status === "saved") setCheckpointInChat(result.values.checkpointInChat);
              })}
            />
            <SettingsSwitch
              label="Ask agents to record factory findings"
              hint={currentInstallation?.error ? undefined : findingsHint}
              error={currentInstallation?.error}
              disabled={factoryRoot === null}
              value={factoryRoot !== null && state.values.findingsInPrompts}
              onValueChange={(findingsInPrompts) => void save((current) => ({ ...current, findingsInPrompts }))}
            />
          </>
        ) : state.status === "loading" ? (
          <SettingsRow label="Loading chat and prompt settings…" />
        ) : (
          <SettingsAction label="Chat and prompt settings" error={state.error} actionLabel="Reload" onPress={() => void state.reload()} />
        )}
        <SettingsSaveError error={errors[DISPLAY_SECTION]} />
      </SettingsCard>
    </SettingsSection>
  );
}
