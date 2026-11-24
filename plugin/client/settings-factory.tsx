import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
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
import { factoryModelsList } from "../shared/factory.js";
import { formatModelList, profileBadges } from "../shared/models-format.js";
import { factoryConfigSettings, factoryDisplaySettings } from "../shared/settings.js";
import {
  validateFactorySettings,
  validateHostSettings,
  validateProfilesAgainstCatalogLocal,
  validateQuotaSettings,
  type FactorySettingsValues,
  type ProviderEntry,
} from "../shared/settings-validate.js";
import { setCheckpointInChat } from "./checkpoint-display.js";

const STEERS_INFO =
  "A steer is an agent that coordinates one project. You can keep several (A, B, C \u2026), each on its own provider or model; one is in charge at a time and hands over with /factory switch when it hits a limit or its chat gets too long.";

const WORKERS_INFO =
  "Workers are helper agents a steer starts. The list is a priority: the first entry that is available is used, so a limit or outage on one provider falls through to the next. Advisor profiles cannot be workers.";

const EFFECTIVE_INFO =
  "These lists are what the factory uses right now. Saving steers, profiles or workers below replaces the steer slots and the worker list from the config file with these settings; a profile that only exists in the file stays available. A GitHub owner or checkout root saved below replaces the matching file value.";

const HOST_INFO =
  "The host setup this plugin runs on. Both fields are optional while a config file exists: a saved value replaces the matching file value, an empty field keeps it. Without a config file both are required, and together with the steers, profiles and workers below they form the complete configuration.";

const PROFILES_INFO =
  "A profile is a named choice of provider, model, thinking level and permission mode. Steers and workers refer to profiles by name, so you change a model in one place.";

const QUOTA_INFO =
  "The plugin samples provider quota in the background and shows it with /factory quota. At the warn level a pool counts as tight (the sidebar warns and briefs prefer another pool); at the exhausted level the pool is skipped when a profile is picked. Sampling runs at most every few minutes.";

function clone(values: FactorySettingsValues): FactorySettingsValues {
  return JSON.parse(JSON.stringify(values)) as FactorySettingsValues;
}

/** Profile a new steer slot starts on: the first non-advisor profile (worker priority first). */
function coordinatorProfile(draft: FactorySettingsValues): string {
  const names = [...draft.workerPriority, ...Object.keys(draft.profiles).sort()];
  return names.find((name) => draft.profiles[name] && !draft.profiles[name].advisor) ?? names[0];
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

export function FactorySettings({ theme, layout }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const configState = useSettings(factoryConfigSettings);
  const displayState = useSettings(factoryDisplaySettings);
  const [draft, setDraft] = useState<FactorySettingsValues | null>(null);
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newSlot, setNewSlot] = useState("");
  const [newProfile, setNewProfile] = useState("");
  const [formKey, setFormKey] = useState(0);
  const [catalog, setCatalog] = useState<CatalogState>({ state: "loading" });
  const callModels = useRpc(factoryModelsList);
  const [effective, setEffective] = useState<{ text: string } | { error: string } | null>(null);
  const newSlotRef = useRef<SettingsInputHandle | null>(null);
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
    // Effective lists come from the server (file + saved settings + live
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

  useEffect(() => {
    if (configState.status === "ready" && draft === null) {
      setDraft(clone(configState.values as FactorySettingsValues));
      setBaseRevision(configState.revision);
    }
  }, [configState, draft]);

  // After a successful save, adopt the new revision once the hook delivers it.
  useEffect(() => {
    if (
      configState.status === "ready" &&
      draft !== null &&
      baseRevision !== null &&
      configState.revision !== baseRevision &&
      JSON.stringify(configState.values) === JSON.stringify(draft)
    ) {
      setBaseRevision(configState.revision);
    }
  }, [configState, draft, baseRevision]);

  const styles = useMemo(
    () => ({
      screen: { gap: layout.compact ? 12 : 16 },
      text: { color: theme.colors.foreground, fontSize: 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 14 },
    }),
    [theme, layout.compact],
  );

  const savedJson =
    configState.status === "ready" ? JSON.stringify(configState.values) : null;
  const changed = draft !== null && savedJson !== null && JSON.stringify(draft) !== savedJson;
  const errors = useMemo(() => (draft ? validateFactorySettings(draft) : []), [draft]);
  const quotaErrors = useMemo(() => (draft ? validateQuotaSettings(draft) : []), [draft]);
  const hostErrors = useMemo(() => (draft ? validateHostSettings(draft) : []), [draft]);
  const usedProfiles = useMemo(
    () => (draft ? [...new Set([...Object.values(draft.slots), ...draft.workerPriority])] : []),
    [draft],
  );
  const catalogProblems = useMemo(
    () =>
      draft && catalog.state === "ready" && errors.length === 0
        ? validateProfilesAgainstCatalogLocal(draft.profiles, catalog.entries, usedProfiles)
        : {},
    [draft, catalog, errors.length, usedProfiles],
  );
  const catalogBlockers = Object.keys(catalogProblems).length;

  async function save(): Promise<void> {
    if (!draft || !baseRevision || configState.status !== "ready") return;
    setNotice(null);
    const ok = await configState.save(draft, baseRevision);
    setNotice(
      ok
        ? "Saved. Running steers are not changed; /factory plan shows what would change."
        : `Not saved: ${configState.saveError ?? "revision conflict"}. Reload and retry.`,
    );
  }

  function discard(): void {
    if (configState.status !== "ready") return;
    setDraft(clone(configState.values as FactorySettingsValues));
    setBaseRevision(configState.revision);
    setNotice(null);
    setFormKey((key) => key + 1);
  }

  async function reset(): Promise<void> {
    if (configState.status !== "ready" && configState.status !== "invalid") return;
    const ok = await configState.reset();
    if (ok) {
      setDraft(null);
      setBaseRevision(null);
      setNotice("Reset to defaults.");
    } else {
      setNotice(`Reset failed: ${configState.saveError ?? "unknown error"}.`);
    }
  }

  async function toggleDisplay(next: boolean): Promise<void> {
    if (displayState.status !== "ready") return;
    const ok = await displayState.save({ checkpointInChat: next }, displayState.revision);
    if (ok) setCheckpointInChat(next);
  }

  if (configState.status === "loading") {
    return (
      <View style={styles.screen}>
        <Text style={styles.muted}>Loading factory settings…</Text>
      </View>
    );
  }
  if (configState.status === "error") {
    return (
      <View style={styles.screen}>
        <Text style={styles.error}>{configState.error}</Text>
        <SettingsSection title="Factory">
          <SettingsCard>
            <SettingsAction label="Retry" actionLabel="Reload" onPress={() => void configState.reload()} />
          </SettingsCard>
        </SettingsSection>
      </View>
    );
  }
  if (configState.status === "invalid" || !draft) {
    return (
      <View style={styles.screen}>
        {configState.status === "invalid" ? (
          <Text style={styles.error}>Stored settings are invalid: {configState.error}</Text>
        ) : (
          <Text style={styles.muted}>Loading factory settings…</Text>
        )}
        <SettingsSection title="Factory">
          <SettingsCard>
            <SettingsAction
              label="Defaults"
              hint="Back to one steer (A) with the default profile; clears the host setup."
              actionLabel="Reset to defaults"
              onPress={() => void reset()}
            />
          </SettingsCard>
        </SettingsSection>
      </View>
    );
  }

  const profileNames = Object.keys(draft.profiles).sort();
  const slotNames = Object.keys(draft.slots).sort();
  const providerNames =
    catalog.state === "ready" ? catalog.entries.map((e) => e.provider).sort() : [];
  const entryFor = (provider: string) =>
    catalog.state === "ready" ? catalog.entries.find((e) => e.provider === provider) : undefined;

  const updateDraft = (next: FactorySettingsValues) => {
    setDraft(next);
    setNotice(null);
  };

  return (
    <View style={styles.screen}>
      <SettingsSection title="In use now" info={EFFECTIVE_INFO}>
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
          <SettingsInput
            key={`github-owner-${formKey}`}
            label="GitHub owner"
            hint="Account that owns the forks, e.g. octocat. Empty keeps the config file value."
            placeholder="octocat"
            initialValue={draft.githubOwner ?? ""}
            onChangeText={(value) =>
              updateDraft({ ...draft, githubOwner: value.trim() ? value.trim() : null })
            }
          />
          <SettingsInput
            key={`checkout-root-${formKey}`}
            label="Checkout root"
            hint="Absolute directory below which repositories are cloned, e.g. /home/you/projects. Empty keeps the config file value."
            placeholder="/home/you/projects"
            initialValue={draft.checkoutRoot ?? ""}
            onChangeText={(value) =>
              updateDraft({ ...draft, checkoutRoot: value.trim() ? value.trim() : null })
            }
          />
          {hostErrors.map((message) => (
            <SettingsRow key={message} label="Please fix" error={message} />
          ))}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Steers" info={STEERS_INFO}>
        <SettingsCard>
          {slotNames.map((slot) => {
            const current = draft.slots[slot];
            const options = (
              profileNames.includes(current) ? profileNames : [...profileNames, current]
            ).map((name) => ({ label: name, value: name }));
            return (
              <SettingsSelect
                key={slot}
                label={`${slotNames.indexOf(slot) + 1}. Steer ${slot}${profileBadges(draft.profiles[current] ?? { advisor: false, sensitive: false })}`}
                hint="Profile (provider and model) this steer uses. Slot order is the priority: if a steer's model is unavailable when steers are created, the next slot's profile is used."
                value={current}
                options={options}
                onValueChange={(value) =>
                  updateDraft({ ...draft, slots: { ...draft.slots, [slot]: value } })
                }
              />
            );
          })}
          <SettingsInput
            label="Add a steer"
            hint="Next free letter, A-Z. A second steer on another provider lets you hand over when one hits its limit."
            placeholder="B"
            ref={newSlotRef}
            onChangeText={setNewSlot}
          />
          <SettingsAction
            label="Add steer"
            actionLabel="Add"
            disabled={!/^[A-Za-z]$/.test(newSlot.trim()) || Boolean(draft.slots[newSlot.trim().toUpperCase()])}
            onPress={() => {
              const slot = newSlot.trim().toUpperCase();
              updateDraft({
                ...draft,
                slots: { ...draft.slots, [slot]: coordinatorProfile(draft) },
                prepare: [...draft.prepare, slot],
              });
              setNewSlot("");
              newSlotRef.current?.replaceText("");
            }}
          />
          {slotNames.length > 1
            ? slotNames.map((slot) => (
                <SettingsAction
                  key={`rm-${slot}`}
                  label={`Remove Steer ${slot}`}
                  hint="Only removes it from the settings; a running agent is not touched."
                  actionLabel="Remove"
                  onPress={() => {
                    const slots = { ...draft.slots };
                    delete slots[slot];
                    let prepare = draft.prepare.filter((s) => s !== slot);
                    if (!prepare.length) prepare = [Object.keys(slots).sort()[0]];
                    updateDraft({
                      ...draft,
                      slots,
                      prepare,
                      initialActive: prepare.includes(draft.initialActive)
                        ? draft.initialActive
                        : prepare[0],
                    });
                  }}
                />
              ))
            : null}
          <SettingsInput
            key={`prepare-${formKey}`}
            label="Steers to create"
            hint="Letters that /factory plan sets up, comma-separated, e.g. A,B. Default A: one steer, add more when you need them."
            initialValue={draft.prepare.join(",")}
            onChangeText={(value) =>
              updateDraft({
                ...draft,
                prepare: value
                  .split(",")
                  .map((s) => s.trim().toUpperCase())
                  .filter(Boolean),
              })
            }
          />
          <SettingsSelect
            label="Steer in charge at first"
            hint="Which steer coordinates right after a new project is set up."
            value={
              draft.prepare.includes(draft.initialActive)
                ? draft.initialActive
                : (draft.prepare[0] ?? "")
            }
            options={draft.prepare
              .filter((slot) => draft.profiles[draft.slots[slot]]?.advisor !== true)
              .map((slot) => ({ label: `Steer ${slot}`, value: slot }))}
            onValueChange={(value) => updateDraft({ ...draft, initialActive: value })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Profiles" info={PROFILES_INFO}>
        <SettingsCard>
          {catalog.state === "error" ? (
            <SettingsRow label="Provider catalog" hint={catalog.message}>
              <Text style={styles.muted}>Could not load the list of providers and models; you can still save, but choices are not checked.</Text>
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
                      hint="Second opinion only: never a coordinating steer or a worker."
                      value={profile.advisor}
                      onValueChange={(value) =>
                        updateDraft({
                          ...draft,
                          profiles: { ...draft.profiles, [name]: { ...profile, advisor: value } },
                        })
                      }
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <SettingsSwitch
                      label="Sensibel (nur bereinigte Aufträge)"
                      hint="Workers on this profile only get sanitized technical tasks: no personal data, accounts or credentials."
                      value={profile.sensitive}
                      onValueChange={(value) =>
                        updateDraft({
                          ...draft,
                          profiles: { ...draft.profiles, [name]: { ...profile, sensitive: value } },
                        })
                      }
                    />
                  </View>
                </View>
                <SettingsSelect
                  label="Provider"
                  value={profile.provider}
                  options={providerOptions}
                  onValueChange={(value) =>
                    updateDraft({
                      ...draft,
                      profiles: { ...draft.profiles, [name]: { ...profile, provider: value } },
                    })
                  }
                />
                <SettingsSelect
                  label="Model"
                  value={profile.model}
                  options={modelOptions}
                  onValueChange={(value) =>
                    updateDraft({
                      ...draft,
                      profiles: { ...draft.profiles, [name]: { ...profile, model: value } },
                    })
                  }
                />
                <SettingsSelect
                  label="Thinking"
                  hint="How long the model reasons before answering. None uses the provider default."
                  value={profile.thinking ?? ""}
                  options={thinkingOptions}
                  onValueChange={(value) =>
                    updateDraft({
                      ...draft,
                      profiles: {
                        ...draft.profiles,
                        [name]: { ...profile, thinking: value === "" ? null : value },
                      },
                    })
                  }
                />
                <SettingsSelect
                  label="Permission mode"
                  hint="What the agent may do without asking, as offered by the provider. None uses the provider default."
                  value={profile.mode ?? ""}
                  options={modeOptions}
                  onValueChange={(value) =>
                    updateDraft({
                      ...draft,
                      profiles: {
                        ...draft.profiles,
                        [name]: { ...profile, mode: value === "" ? null : value },
                      },
                    })
                  }
                />
              </SettingsRow>
            );
          })}
          <SettingsInput
            label="Add a profile"
            hint="A short name, e.g. claude-strong or codex-cheap. Then pick provider and model above."
            placeholder="my-profile"
            ref={newProfileRef}
            onChangeText={setNewProfile}
          />
          <SettingsAction
            label="Add profile"
            actionLabel="Add"
            disabled={!newProfile.trim() || Boolean(draft.profiles[newProfile.trim()])}
            onPress={() => {
              const name = newProfile.trim();
              updateDraft({
                ...draft,
                profiles: {
                  ...draft.profiles,
                  [name]: { ...draft.profiles[draft.workerPriority[0]], advisor: false, sensitive: false },
                },
              });
              setNewProfile("");
              newProfileRef.current?.replaceText("");
            }}
          />
          {profileNames
            .filter((name) => !usedProfiles.includes(name))
            .map((name) => (
              <SettingsAction
                key={`rm-${name}`}
                label={`Remove profile ${name}`}
                actionLabel="Remove"
                onPress={() => {
                  const profiles = { ...draft.profiles };
                  delete profiles[name];
                  updateDraft({ ...draft, profiles });
                }}
              />
            ))}
          <SettingsRow
            label="Running steers stay as they are"
            hint="Changes here apply to steers created later. The Factory panel marks a running steer whose model differs from its profile; the next plan lists the difference."
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Workers" info={WORKERS_INFO}>
        <SettingsCard>
          {draft.workerPriority.map((name, index) => {
            const move = (to: number) => {
              const next = [...draft.workerPriority];
              const [item] = next.splice(index, 1);
              next.splice(to, 0, item);
              updateDraft({ ...draft, workerPriority: next });
            };
            return (
              <SettingsRow
                key={`worker-${name}`}
                label={`${index + 1}. ${name}${profileBadges(draft.profiles[name] ?? { advisor: false, sensitive: false })}`}
                hint={draft.profiles[name] ? `${draft.profiles[name].provider}/${draft.profiles[name].model}` : "unknown profile"}
              >
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <SettingsAction label="Priority" actionLabel="Up" disabled={index === 0} onPress={() => move(index - 1)} />
                  <SettingsAction
                    label="Priority"
                    actionLabel="Down"
                    disabled={index === draft.workerPriority.length - 1}
                    onPress={() => move(index + 1)}
                  />
                  <SettingsAction
                    label="Remove"
                    actionLabel="Remove"
                    disabled={draft.workerPriority.length === 1}
                    onPress={() =>
                      updateDraft({ ...draft, workerPriority: draft.workerPriority.filter((n) => n !== name) })
                    }
                  />
                </View>
              </SettingsRow>
            );
          })}
          <SettingsSelect
            label="Add a worker profile"
            hint="Appended at the end of the priority list. Advisor profiles are not offered."
            value=""
            options={[
              { label: "Choose…", value: "" },
              ...profileNames
                .filter((name) => !draft.profiles[name].advisor && !draft.workerPriority.includes(name))
                .map((name) => ({ label: name, value: name })),
            ]}
            onValueChange={(value) => {
              if (value) updateDraft({ ...draft, workerPriority: [...draft.workerPriority, value] });
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Quota" info={QUOTA_INFO}>
        <SettingsCard>
          <SettingsInput
            key={`warn-${formKey}`}
            label="Warn at (percent)"
            hint="A pool at or above this session usage counts as tight. Default 75."
            initialValue={String(draft.quota?.warnPct ?? 75)}
            onChangeText={(value) =>
              updateDraft({
                ...draft,
                quota: { ...(draft.quota ?? { exhaustedPct: 90, warnPct: 75 }), warnPct: Number(value.trim()) },
              })
            }
          />
          <SettingsInput
            key={`exhausted-${formKey}`}
            label="Exhausted at (percent)"
            hint="A pool at or above this session usage is skipped when a profile is picked. Default 90."
            initialValue={String(draft.quota?.exhaustedPct ?? 90)}
            onChangeText={(value) =>
              updateDraft({
                ...draft,
                quota: { ...(draft.quota ?? { exhaustedPct: 90, warnPct: 75 }), exhaustedPct: Number(value.trim()) },
              })
            }
          />
          <SettingsInput
            key={`sample-${formKey}`}
            label="Sample at most every (minutes)"
            hint="How often the plugin may ask Paseo for fresh quota numbers. Whole minutes, at least 10. Default 10."
            initialValue={String(draft.quotaSampleMinutes ?? 10)}
            onChangeText={(value) =>
              updateDraft({ ...draft, quotaSampleMinutes: Number.parseInt(value.trim(), 10) })
            }
          />
          {quotaErrors.map((message) => (
            <SettingsRow key={message} label="Please fix" error={message} />
          ))}
        </SettingsCard>
      </SettingsSection>

      <CleanupSettingsSection theme={theme} layout={layout} />
      <ResumeSettingsSection theme={theme} />

      <SettingsSection title="Save settings">
        <SettingsCard>
          {errors.map((message) => (
            <SettingsRow key={message} label="Please fix" error={message} />
          ))}
          {Object.entries(catalogProblems).map(([name, problems]) =>
            problems.map((message) => (
              <SettingsRow key={`${name}-${message}`} label={`Profile ${name}`} error={message} />
            )),
          )}
          {notice ? (
            <SettingsRow label="Status">
              <Text style={styles.text}>{notice}</Text>
            </SettingsRow>
          ) : null}
          {configState.saveError && !notice ? (
            <SettingsRow label="Save error" error={configState.saveError} />
          ) : null}
          <SettingsAction
            label="Save"
            hint={changed ? "Saves these settings." : "No unsaved changes."}
            actionLabel={configState.saving ? "Saving…" : "Save"}
            disabled={!changed || configState.saving || errors.length > 0 || catalogBlockers > 0}
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
            hint="Back to one steer (A) with the default profile; clears the host setup."
            actionLabel="Reset to defaults"
            onPress={() => void reset()}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Chat display">
        <SettingsCard>
          {displayState.status === "ready" ? (
            <SettingsSwitch
              label="Show CHECKPOINT blocks in chat"
              hint="The model still writes the full CHECKPOINT block; only the chat display is shortened to one line. This saves no model tokens. Shortened answers render as plain text."
              value={displayState.values.checkpointInChat}
              disabled={displayState.saving}
              onValueChange={(next) => void toggleDisplay(next)}
            />
          ) : displayState.status === "invalid" ? (
            <SettingsAction
              label="Chat display"
              hint={displayState.error}
              actionLabel="Reset to full blocks"
              onPress={() => void displayState.reset().then((ok) => {
                if (ok) setCheckpointInChat(true);
              })}
            />
          ) : (
            <SettingsRow label="Show CHECKPOINT blocks">
              <Text style={styles.muted}>
                {displayState.status === "loading" ? "Loading…" : "Unavailable."}
              </Text>
            </SettingsRow>
          )}
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
