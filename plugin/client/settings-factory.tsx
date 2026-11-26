import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { CleanupSettingsSection } from "./settings-cleanup.js";
import { ResumeSettingsSection } from "./settings-resume.js";
import { SteerMenuSettingsSection } from "./settings-steer-menu.js";
import { factoryModelsList } from "../shared/factory.js";
import { formatModelList, profileBadges } from "../shared/models-format.js";
import { factoryPromptSettings } from "../shared/prompt-settings.js";
import { factoryConfigSettings, factoryDisplaySettings } from "../shared/settings.js";
import {
  GITHUB_OWNER_PATTERN,
  isAbsolutePath,
  validateFactorySettings,
  validateProfilesAgainstCatalogLocal,
  prioritiesFromSlots,
  type FactoryProfileValue,
  type FactorySettingsValues,
  type ProviderEntry,
} from "../shared/settings-validate.js";
import { setCheckpointInChat } from "./checkpoint-display.js";
import { AutosaveInput, SettingsSaveError, useAutosave } from "./settings-autosave.js";
import { commaSeparated, percentage, type SettingsEdit } from "./settings-edit.js";

const WORKERS_INFO =
  "The factory starts workers using the first available profile in this order.";

const EFFECTIVE_INFO =
  "The factory uses the saved profiles and role priorities below. Running agents keep their native model settings.";

const HOST_INFO =
  "Both fields are required. Fill in the GitHub owner and the checkout root to run the factory on this host.";

const PROFILES_INFO =
  "A profile is a named choice of provider, model, thinking level and permission mode. Creation and routing priorities refer to these profiles by name.";

const QUOTA_INFO =
  "View sampled usage with /factory quota. Warnings favor other pools and exhausted pools are skipped.";

function usedProfileNames(values: FactorySettingsValues): string[] {
  return [...new Set([...Object.values(values.slots), ...values.workerPriority,
    ...(values.steerPriority ?? []), ...(values.advisorPriority ?? [])])];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function normalizeCatalog(result: unknown): ProviderEntry[] {
  const entries = asRecord(result).entries;
  if (!Array.isArray(entries)) return [];
  return entries.map((raw) => {
    const entry = asRecord(raw);
    const modelsRaw = Array.isArray(entry.models) ? entry.models : [];
    const modesRaw = Array.isArray(entry.modes) ? entry.modes : [];
    return {
      provider: typeof entry.provider === "string" ? entry.provider : "?",
      enabled: entry.enabled === true,
      status: typeof entry.status === "string" ? entry.status : "?",
      models: modelsRaw.map((m) => {
        const model = asRecord(m);
        const thinking = asRecord(model).thinkingOptions;
        return {
          id: typeof model.id === "string" ? model.id : "?",
          thinkingOptions: Array.isArray(thinking)
            ? thinking.map((t) => ({ id: String(asRecord(t).id ?? "?") }))
            : [],
        };
      }),
      modes: modesRaw.map((m) => ({ id: String(asRecord(m).id ?? "?") })),
    };
  });
}

type CatalogState =
  | { state: "loading" }
  | { state: "ready"; entries: ProviderEntry[] }
  | { state: "error"; message: string };

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
  const [newProfile, setNewProfile] = useState("");
  const [catalog, setCatalog] = useState<CatalogState>({ state: "loading" });
  const callModels = useRpc(factoryModelsList);
  const [effective, setEffective] = useState<{ text: string } | { error: string } | null>(null);
  const newProfileRef = useRef<SettingsInputHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    paseo.providers
      .snapshot()
      .then((result) => {
        if (!cancelled) setCatalog({ state: "ready", entries: normalizeCatalog(result) });
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
        const l = list as any;
        setEffective({ text: `${formatModelList("steer", l)}\n\n${formatModelList("worker", l)}` });
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
  const usedProfiles = usedProfileNames(draft);

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

  const catalogProblems = catalogIssues(draft);
  const profileNames = Object.keys(draft.profiles).sort();
  const providerNames =
    catalog.state === "ready" ? catalog.entries.map((e) => e.provider).sort() : [];
  const entryFor = (provider: string) =>
    catalog.state === "ready" ? catalog.entries.find((e) => e.provider === provider) : undefined;

  const profileName = newProfile.trim();
  const profileNameError = profileName && (
    Object.hasOwn(draft.profiles, profileName) ? "This profile already exists."
      : Object.hasOwn(Object.prototype, profileName) ? "Choose another profile name." : null
  );

  function updateProfile(
    name: string,
    field: keyof FactoryProfileValue,
    edit: (profile: FactoryProfileValue) => FactoryProfileValue,
  ) {
    return update("Profiles", `${name}.${field}`, (current) => {
      if (!Object.hasOwn(current.profiles, name)) return "This profile was removed.";
      const profile = edit(current.profiles[name]);
      const next = { ...current, profiles: { ...current.profiles, [name]: profile } };
      if (field === "advisor" && profile.advisor !== current.profiles[name].advisor) {
        const source = profile.advisor ? current.steerPriority : current.advisorPriority;
        if (source?.includes(name)) {
          next.steerPriority = (current.steerPriority ?? []).filter((p) => p !== name);
          next.advisorPriority = (current.advisorPriority ?? []).filter((p) => p !== name);
          (profile.advisor ? next.advisorPriority : next.steerPriority).push(name);
        }
      }
      return next;
    });
  }

  return (
    <View style={styles.screen}>
      <SettingsSection title="Configured routes" info={EFFECTIVE_INFO}>
        <SettingsCard>
          <SettingsRow label="Steers and workers">
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

      <SettingsSection title="Models & routing" info="Priorities choose future model routes. Changing a running agent uses its native model controls.">
        <SettingsCard>
          <SettingsSelect
            label="Routing strategy"
            value={draft.routingStrategy ?? "efficiency"}
            options={[
              { label: "Efficiency", value: "efficiency" },
              { label: "Balanced", value: "balanced" },
              { label: "Preference", value: "preference" },
            ]}
            onValueChange={(value) => void update("Routing", "strategy", (current) => ({
              ...current, routingStrategy: value as FactorySettingsValues["routingStrategy"],
            }))}
          />
          {(["steerPriority", "advisorPriority"] as const).map((key) => (
            <AutosaveInput
              key={key}
              label={key === "steerPriority" ? "Steer priority" : "Advisor priority"}
              hint="Profile names in priority order, separated by commas."
              stored={(draft[key] ?? prioritiesFromSlots(draft.slots, draft.profiles)[key]).join(", ")}
              save={change("Routing")}
              edit={(text) => {
                const names = commaSeparated(text);
                return validated((current) => ({ ...current, [key]: names }));
              }}
            />
          ))}
          <SettingsSaveError error={saveErrors.Routing} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Profiles" info={PROFILES_INFO}>
        <SettingsCard>
          {catalog.state === "error" ? (
            <SettingsRow label="Provider catalog" hint={catalog.message}>
              <Text style={styles.muted}>Provider and model validation is unavailable.</Text>
            </SettingsRow>
          ) : null}
          {profileNames.map((name) => {
            const profile = draft.profiles[name];
            const entry = entryFor(profile.provider);
            const models = entry?.models ?? [];
            const modelOptions = (
              models.some((m) => m.id === profile.model)
                ? models.map((m) => m.id)
                : [profile.model, ...models.map((m) => m.id)]
            ).map((id) => ({ label: id, value: id }));
            const thinkingOptions = [
              { label: "None (provider default)", value: "" },
              ...(models.find((m) => m.id === profile.model)?.thinkingOptions ?? []).map((t) => ({
                label: t.id,
                value: t.id,
              })),
            ];
            if (profile.thinking && !thinkingOptions.some((o) => o.value === profile.thinking)) {
              thinkingOptions.push({ label: profile.thinking, value: profile.thinking });
            }
            const modeOptions = [
              { label: "None (provider default)", value: "" },
              ...(entry?.modes ?? []).map((m) => ({ label: m.id, value: m.id })),
            ];
            if (profile.mode && !modeOptions.some((o) => o.value === profile.mode)) {
              modeOptions.push({ label: profile.mode, value: profile.mode });
            }
            const providerOptions = (
              providerNames.includes(profile.provider)
                ? providerNames
                : [profile.provider, ...providerNames]
            ).map((id) => ({ label: id, value: id }));
            const problems = catalogProblems[name] ?? [];
            return (
              <SettingsRow
                key={name}
                label={`Profile ${name}${profileBadges(profile)}`}
                error={problems.length ? problems.join("; ") : null}
              >
                <View style={{ flexDirection: layout.compact ? "column" : "row", gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <SettingsSwitch
                      label="Advisor"
                      hint="Use this profile for second opinions."
                      value={profile.advisor}
                      error={fieldErrors[`${name}.advisor`]}
                      onValueChange={(advisor) => void updateProfile(name, "advisor", (current) => ({ ...current, advisor }))}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <SettingsSwitch
                      label="Sensitive"
                      hint="Workers on this profile only get sanitized technical tasks: no personal data, accounts or credentials."
                      value={profile.sensitive}
                      error={fieldErrors[`${name}.sensitive`]}
                      onValueChange={(sensitive) => void updateProfile(name, "sensitive", (current) => ({ ...current, sensitive }))}
                    />
                  </View>
                </View>
                <SettingsSelect
                  label="Provider"
                  value={profile.provider}
                  options={providerOptions}
                  error={fieldErrors[`${name}.provider`]}
                  onValueChange={(provider) => void updateProfile(name, "provider", (current) => {
                    if (provider === current.provider) return current;
                    const offered = entryFor(provider)?.models ?? [];
                    const model = offered.find((item) => item.id === current.model)?.id ?? offered[0]?.id ?? current.model;
                    return { ...current, provider, model, thinking: null, mode: null };
                  })}
                />
                <SettingsSelect
                  label="Model"
                  value={profile.model}
                  options={modelOptions}
                  error={fieldErrors[`${name}.model`]}
                  onValueChange={(model) => void updateProfile(name, "model", (current) => {
                    if (model === current.model) return current;
                    const selected = entryFor(current.provider)?.models?.find((item) => item.id === model);
                    const thinking = selected?.thinkingOptions?.some((item) => item.id === current.thinking)
                      ? current.thinking : null;
                    return { ...current, model, thinking };
                  })}
                />
                <SettingsSelect
                  label="Thinking"
                  value={profile.thinking ?? ""}
                  options={thinkingOptions}
                  error={fieldErrors[`${name}.thinking`]}
                  onValueChange={(value) => void updateProfile(name, "thinking", (current) => ({ ...current, thinking: value || null }))}
                />
                <SettingsSelect
                  label="Permission mode"
                  value={profile.mode ?? ""}
                  options={modeOptions}
                  error={fieldErrors[`${name}.mode`]}
                  onValueChange={(value) => void updateProfile(name, "mode", (current) => ({ ...current, mode: value || null }))}
                />
              </SettingsRow>
            );
          })}
          <SettingsInput
            label="Add a profile"
            hint="Choose a name, then edit its provider and model."
            placeholder="my-profile"
            ref={newProfileRef}
            error={profileNameError || fieldErrors.addProfile}
            onChangeText={(text) => {
              setNewProfile(text);
              setFieldErrors((current) => ({ ...current, addProfile: null }));
            }}
          />
          <SettingsAction
            label="Add profile"
            actionLabel="Add"
            disabled={!profileName || Boolean(profileNameError)}
            onPress={() => void update("Profiles", "addProfile", (current) => {
              if (Object.hasOwn(current.profiles, profileName)) return "This profile already exists.";
              const source = current.profiles[current.workerPriority[0]];
              if (!source) return "Choose a valid worker profile first.";
              return {
                ...current,
                profiles: {
                  ...current.profiles,
                  [profileName]: { ...source, advisor: false, sensitive: false },
                },
              };
            }).then((saved) => {
              if (saved && newProfileRef.current?.getText() === newProfile) {
                setNewProfile("");
                newProfileRef.current?.replaceText("");
              }
            })}
          />
          {profileNames
            .filter((name) => !usedProfiles.includes(name))
            .map((name) => (
              <SettingsAction
                key={`rm-${name}`}
                label={`Remove profile ${name}`}
                error={fieldErrors[`remove-profile-${name}`]}
                actionLabel="Remove"
                onPress={() => void update("Profiles", `remove-profile-${name}`, (current) => {
                  if (usedProfileNames(current).includes(name)) return "This profile is in use.";
                  const profiles = { ...current.profiles };
                  delete profiles[name];
                  return { ...current, profiles };
                })}
              />
            ))}
          <SettingsRow
            label="Changes to steer profiles"
            hint="Future steers use the updated profile. The Factory panel and /factory plan show differences for running steers."
          />
          <SettingsSaveError error={saveErrors.Profiles} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Workers" info={WORKERS_INFO}>
        <SettingsCard>
          {draft.workerPriority.map((name, index) => {
            const move = (offset: number) => {
              void update("Workers", name, (current) => {
                const workerPriority = [...current.workerPriority];
                const from = workerPriority.indexOf(name);
                if (from === -1) return "This worker profile was removed.";
                const to = from + offset;
                if (to < 0 || to >= workerPriority.length) return current;
                workerPriority.splice(from, 1);
                workerPriority.splice(to, 0, name);
                return { ...current, workerPriority };
              });
            };
            return (
              <SettingsRow
                key={`worker-${name}`}
                label={`${index + 1}. ${name}${profileBadges(draft.profiles[name] ?? { advisor: false, sensitive: false })}`}
                hint={draft.profiles[name] ? `${draft.profiles[name].provider}/${draft.profiles[name].model}` : "unknown profile"}
                error={fieldErrors[name]}
              >
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <SettingsAction label="Priority" actionLabel="Up" disabled={index === 0} onPress={() => move(-1)} />
                  <SettingsAction
                    label="Priority"
                    actionLabel="Down"
                    disabled={index === draft.workerPriority.length - 1}
                    onPress={() => move(1)}
                  />
                  <SettingsAction
                    label="Remove"
                    actionLabel="Remove"
                    disabled={draft.workerPriority.length === 1}
                    onPress={() =>
                      void update("Workers", name, (current) => ({
                        ...current, workerPriority: current.workerPriority.filter((profile) => profile !== name),
                      }))
                    }
                  />
                </View>
              </SettingsRow>
            );
          })}
          <SettingsSelect
            label="Add a worker profile"
            hint="Append a profile to the priority list."
            error={fieldErrors.addWorker}
            value=""
            options={[
              { label: "Choose…", value: "" },
              ...profileNames
                .filter((name) => !draft.profiles[name].advisor && !draft.workerPriority.includes(name))
                .map((name) => ({ label: name, value: name })),
            ]}
            onValueChange={(value) => {
              if (value) {
                void update("Workers", "addWorker", (current) => current.workerPriority.includes(value)
                  ? current
                  : { ...current, workerPriority: [...current.workerPriority, value] });
              }
            }}
          />
          <SettingsSaveError error={saveErrors.Workers} />
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
