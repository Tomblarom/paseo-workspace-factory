import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useSettings } from "@getpaseo/plugin/client";
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
import { factoryConfigSettings, factorySidebarSettings } from "../shared/settings.js";
import {
  validateFactorySettings,
  validateProfilesAgainstCatalogLocal,
  type FactorySettingsValues,
  type ProviderEntry,
} from "../shared/settings-validate.js";
import { setSidebarVisible } from "./sidebar-visibility.js";

function clone(values: FactorySettingsValues): FactorySettingsValues {
  return JSON.parse(JSON.stringify(values)) as FactorySettingsValues;
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
  const sidebarState = useSettings(factorySidebarSettings);
  const [draft, setDraft] = useState<FactorySettingsValues | null>(null);
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newSlot, setNewSlot] = useState("");
  const [newProfile, setNewProfile] = useState("");
  const [formKey, setFormKey] = useState(0);
  const [catalog, setCatalog] = useState<CatalogState>({ state: "loading" });
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
  const usedProfiles = useMemo(
    () => (draft ? [...new Set([...Object.values(draft.slots), draft.workerDefault])] : []),
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
        ? "Saved. Existing steers keep running; the next plan reports the difference."
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

  async function toggleSidebar(next: boolean): Promise<void> {
    if (sidebarState.status !== "ready") return;
    const ok = await sidebarState.save({ visible: next }, sidebarState.revision);
    if (ok) setSidebarVisible(next);
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
              hint="Replaces the stored document with the single-steer defaults."
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
      <SettingsSection title="Steer slots">
        <SettingsCard>
          {slotNames.map((slot) => {
            const current = draft.slots[slot];
            const options = (
              profileNames.includes(current) ? profileNames : [...profileNames, current]
            ).map((name) => ({ label: name, value: name }));
            return (
              <SettingsSelect
                key={slot}
                label={`Slot ${slot}`}
                value={current}
                options={options}
                onValueChange={(value) =>
                  updateDraft({ ...draft, slots: { ...draft.slots, [slot]: value } })
                }
              />
            );
          })}
          <SettingsInput
            label="New slot"
            hint="One capital letter A-Z."
            placeholder="B"
            ref={newSlotRef}
            onChangeText={setNewSlot}
          />
          <SettingsAction
            label="Add slot"
            actionLabel="Add"
            disabled={!/^[A-Za-z]$/.test(newSlot.trim()) || Boolean(draft.slots[newSlot.trim().toUpperCase()])}
            onPress={() => {
              const slot = newSlot.trim().toUpperCase();
              updateDraft({
                ...draft,
                slots: { ...draft.slots, [slot]: draft.workerDefault },
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
                  label={`Remove slot ${slot}`}
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
            label="Prepare"
            hint="Comma-separated slots to create, e.g. A,B."
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
            label="Start steer"
            hint="Active after the first plan."
            value={
              draft.prepare.includes(draft.initialActive)
                ? draft.initialActive
                : (draft.prepare[0] ?? "")
            }
            options={draft.prepare.map((slot) => ({ label: `Steer ${slot}`, value: slot }))}
            onValueChange={(value) => updateDraft({ ...draft, initialActive: value })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Profiles">
        <SettingsCard>
          {catalog.state === "error" ? (
            <SettingsRow label="Provider catalog" hint={catalog.message}>
              <Text style={styles.muted}>Catalog unavailable; saving stays possible.</Text>
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
              { label: "None", value: "" },
              ...(models.find((m) => m.id === profile.model)?.thinkingOptions ?? []).map((t) => ({
                label: t.id,
                value: t.id,
              })),
            ];
            if (profile.thinking && !thinkingOptions.some((o) => o.value === profile.thinking)) {
              thinkingOptions.push({ label: profile.thinking, value: profile.thinking });
            }
            const modeOptions = [
              { label: "None", value: "" },
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
                label={`Profile ${name}`}
                error={problems.length ? problems.join("; ") : null}
              >
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
                  label="Mode"
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
            label="New profile"
            hint="A name for a provider and model combination."
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
                  [name]: { ...draft.profiles[draft.workerDefault] },
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
          <SettingsSelect
            label="Worker default profile"
            value={
              profileNames.includes(draft.workerDefault)
                ? draft.workerDefault
                : (profileNames[0] ?? "")
            }
            options={profileNames.map((name) => ({ label: name, value: name }))}
            onValueChange={(value) => updateDraft({ ...draft, workerDefault: value })}
          />
          <SettingsRow
            label="Existing steers"
            hint="Profile changes never touch running steers. The Factory panel shows drift between a steer and its profile."
          />
        </SettingsCard>
      </SettingsSection>

      <CleanupSettingsSection theme={theme} layout={layout} />

      <SettingsSection title="Changes">
        <SettingsCard>
          {errors.map((message) => (
            <SettingsRow key={message} label="Invalid" error={message} />
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
            hint={changed ? "Writes the whole document." : "No unsaved changes."}
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
            hint="Replaces the document with the single-steer defaults."
            actionLabel="Reset to defaults"
            onPress={() => void reset()}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Sidebar">
        <SettingsCard>
          {sidebarState.status === "ready" ? (
            <SettingsSwitch
              label="Show Factory entry"
              hint="Adds a sidebar row with a steer status popover. Off by default."
              value={sidebarState.values.visible}
              disabled={sidebarState.saving}
              onValueChange={(next) => void toggleSidebar(next)}
            />
          ) : sidebarState.status === "invalid" ? (
            <SettingsAction
              label="Sidebar entry"
              hint={sidebarState.error}
              actionLabel="Reset to hidden"
              onPress={() => void sidebarState.reset()}
            />
          ) : (
            <SettingsRow label="Show Factory entry">
              <Text style={styles.muted}>
                {sidebarState.status === "loading" ? "Loading…" : "Unavailable."}
              </Text>
            </SettingsRow>
          )}
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
