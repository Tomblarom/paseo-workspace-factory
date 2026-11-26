import type { PluginPaseoApi, PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  Icon,
  Modal,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { FactoryProfileValue, FactorySettingsValues } from "../shared/settings-validate.js";
import { SettingsSaveError } from "./settings-autosave.js";
import type { SettingsEdit } from "./settings-edit.js";
import { editPriority, editProfile, fitsPriorityRole, usedProfileNames, type PriorityKey } from "./settings-routing.js";

type ProviderEntries = Awaited<ReturnType<PluginPaseoApi["providers"]["snapshot"]>>["entries"];

export type CatalogState =
  | { state: "loading" }
  | { state: "ready"; entries: ProviderEntries }
  | { state: "error"; message: string };

type FieldErrors = Record<string, string | null>;
type UpdateSettings = (section: string, field: string, edit: SettingsEdit<FactorySettingsValues>) => Promise<boolean>;
type Appearance = Pick<PluginSurfaceProps, "theme"> & { compact: boolean };

interface ModelSettingsProps extends Appearance {
  draft: FactorySettingsValues;
  catalog: CatalogState;
  catalogProblems: Record<string, string[]>;
  fieldErrors: FieldErrors;
  saveErrors: FieldErrors;
  update: UpdateSettings;
}

const ROLE_PRIORITIES: readonly { key: PriorityKey; role: string; info: string }[] = [
  { key: "steerPriority", role: "Steer", info: "Preference order for future coordinating steers." },
  { key: "advisorPriority", role: "Advisor", info: "Preference order for future second opinions." },
  { key: "workerPriority", role: "Worker", info: "The factory starts workers using the first available profile in this order." },
];

export function ModelSettingsSections(props: ModelSettingsProps) {
  const { draft, catalog, fieldErrors, saveErrors, update, theme, compact } = props;
  const entries = catalog.state === "ready" ? catalog.entries : [];
  const names = Object.keys(draft.profiles).sort();
  const appearance = { theme, compact };
  return (
    <>
      <ProfilesSection {...props} />
      <SettingsSection title="Routing" info="Priorities apply to future model routes. Use an agent’s native model controls to change its current route.">
        <SettingsCard>
          <SettingsSelect
            label="Routing strategy"
            value={draft.routingStrategy}
            options={[
              { label: "Efficiency", value: "efficiency" },
              { label: "Balanced", value: "balanced" },
              { label: "Preference", value: "preference" },
            ]}
            error={fieldErrors.strategy}
            onValueChange={(routingStrategy) => void update("Routing", "strategy", (current) => ({ ...current, routingStrategy }))}
          />
          <SettingsSaveError error={saveErrors.Routing} />
        </SettingsCard>
      </SettingsSection>
      {ROLE_PRIORITIES.map(({ key, role, info }) => {
        const roleName = role.toLowerCase();
        const priority = draft[key];
        const eligible = names.filter((name) => fitsPriorityRole(draft.profiles[name], key));
        const choices = eligible.filter((name) => !priority.includes(name));
        return (
          <SettingsSection key={key} title={`${role} priority`} info={info}>
            <SettingsCard>
              {priority.length === 0 ? <SettingsRow label={`No ${roleName} profiles in this list`} /> : null}
              {priority.map((name, index) => {
                const field = `${key}:${name}`;
                const profile = Object.hasOwn(draft.profiles, name) ? draft.profiles[name] : undefined;
                return (
                  <SettingsRow
                    key={name}
                    label={`${index + 1}. ${name}`}
                    hint={profile ? profileSummary(profile, entries) : "Unknown profile"}
                    error={fieldErrors[field]}
                  >
                    <View style={{ flexDirection: "row", gap: 4 }}>
                      <IconButton
                        {...appearance}
                        icon="ArrowUp"
                        label={`Move ${name} up in ${roleName} priority`}
                        disabled={index === 0}
                        onPress={() => void update(key, field, editPriority(key, name, "up"))}
                      />
                      <IconButton
                        {...appearance}
                        icon="ArrowDown"
                        label={`Move ${name} down in ${roleName} priority`}
                        disabled={index === priority.length - 1}
                        onPress={() => void update(key, field, editPriority(key, name, "down"))}
                      />
                      <IconButton
                        {...appearance}
                        icon="X"
                        label={`Remove ${name} from ${roleName} priority`}
                        disabled={key === "workerPriority" && priority.length === 1}
                        onPress={() => void update(key, field, editPriority(key, name, "remove"))}
                      />
                    </View>
                  </SettingsRow>
                );
              })}
              <SettingsSelect
                label={`Add ${roleName} profile`}
                hint={choices.length ? undefined : eligible.length ? "All eligible profiles are listed." : "No profiles are eligible for this role."}
                error={fieldErrors[`${key}.add`]}
                value=""
                disabled={!choices.length}
                options={[{ label: "Choose profile…", value: "" }, ...choices.map((name) => ({ label: name, value: name }))]}
                onValueChange={(name) => {
                  if (name) void update(key, `${key}.add`, editPriority(key, name, "add"));
                }}
              />
              <SettingsSaveError error={saveErrors[key]} />
            </SettingsCard>
          </SettingsSection>
        );
      })}
    </>
  );
}

type ProfileDialog = { kind: "add" } | { kind: "edit"; name: string };

function ProfilesSection({ draft, catalog, catalogProblems, fieldErrors, saveErrors, update, theme, compact }: ModelSettingsProps) {
  const [dialog, setDialog] = useState<ProfileDialog | null>(null);
  const entries = catalog.state === "ready" ? catalog.entries : [];
  const usedProfiles = usedProfileNames(draft);
  const name = dialog?.kind === "edit" ? dialog.name : null;
  const profile = name !== null && Object.hasOwn(draft.profiles, name) ? draft.profiles[name] : undefined;
  const closeDialog = () => setDialog((current) => current === dialog ? null : current);
  const appearance = { theme, compact };

  function catalogError(name: string) {
    return Object.hasOwn(catalogProblems, name) ? catalogProblems[name].join(" · ") : undefined;
  }

  function addProfile(name: string) {
    return update("Profiles", "addProfile", (current) => {
      if (Object.hasOwn(current.profiles, name)) return "This profile already exists.";
      const source = current.profiles[current.workerPriority[0]];
      if (!source) return "Choose a valid worker profile first.";
      return {
        ...current,
        profiles: { ...current.profiles, [name]: { ...source, advisor: false, sensitive: false } },
      };
    }).then((saved) => {
      if (saved) setDialog((current) => current === dialog ? { kind: "edit", name } : current);
    });
  }

  return (
    <SettingsSection
      title="Profiles"
      info="Profiles store provider, model, thinking level and permission mode. Edits apply to future runs. The Factory panel and /factory plan show differences for running steers."
      trailing={<IconButton {...appearance} icon="Plus" label="Add profile" showLabel onPress={() => setDialog({ kind: "add" })} />}
    >
      <SettingsCard>
        {catalog.state === "error" ? <SettingsRow label="Provider catalog unavailable" error={catalog.message} /> : null}
        {Object.keys(draft.profiles).sort().map((name) => (
          <SettingsRow key={name} label={name} hint={profileSummary(draft.profiles[name], entries)} error={catalogError(name)}>
            <IconButton {...appearance} icon="ChevronRight" label={`Edit profile ${name}`} onPress={() => setDialog({ kind: "edit", name })} />
          </SettingsRow>
        ))}
        {!dialog ? <SettingsSaveError error={saveErrors.Profiles} /> : null}
      </SettingsCard>
      {dialog ? (
        <Modal open title={dialog.kind === "add" ? "Add profile" : `Edit profile ${dialog.name}`} onOpenChange={(open) => { if (!open) closeDialog(); }}>
          <Modal.Content>
            {dialog.kind === "add" ? (
              <AddProfileForm profiles={draft.profiles} error={fieldErrors.addProfile} saveError={saveErrors.Profiles} onAdd={addProfile} />
            ) : name !== null && profile ? (
              <SettingsCard key={name}>
                {catalogError(name) ? <SettingsRow label="Profile availability" error={catalogError(name)} /> : null}
                <ProfileFields
                  profile={profile}
                  entries={entries}
                  errorFor={(field) => fieldErrors[`${name}.${field}`]}
                  update={(field, edit) => void update("Profiles", `${name}.${field}`, editProfile(name, edit))}
                />
                <SettingsAction
                  label="Delete profile"
                  hint={usedProfiles.includes(name) ? "This profile is used in a priority list or a legacy slot." : undefined}
                  error={fieldErrors[`remove-profile-${name}`]}
                  actionLabel="Delete"
                  disabled={usedProfiles.includes(name)}
                  onPress={() => void update("Profiles", `remove-profile-${name}`, (current) => {
                    if (usedProfileNames(current).includes(name)) return "This profile is in use.";
                    const profiles = { ...current.profiles };
                    delete profiles[name];
                    return { ...current, profiles };
                  }).then((saved) => { if (saved) closeDialog(); })}
                />
                <SettingsSaveError error={saveErrors.Profiles} />
              </SettingsCard>
            ) : <SettingsCard><SettingsRow label="This profile was removed" /></SettingsCard>}
          </Modal.Content>
        </Modal>
      ) : null}
    </SettingsSection>
  );
}

function AddProfileForm({ profiles, error, saveError, onAdd }: {
  profiles: FactorySettingsValues["profiles"];
  error: string | null;
  saveError: string | null;
  onAdd(name: string): Promise<void>;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const name = text.trim();
  const nameError = !name ? null : Object.hasOwn(profiles, name) ? "This profile already exists."
    : Object.hasOwn(Object.prototype, name) ? "Choose another profile name." : null;
  return (
    <SettingsCard>
      <SettingsInput
        label="Profile name"
        placeholder="my-profile"
        disabled={pending}
        error={nameError ?? (submitted ? error : null)}
        onChangeText={(text) => { setText(text); setSubmitted(false); }}
      />
      <SettingsAction
        label="Create a profile to edit its provider and model"
        actionLabel={pending ? "Adding…" : "Add profile"}
        disabled={!name || Boolean(nameError) || pending}
        onPress={() => {
          setSubmitted(true);
          setPending(true);
          void onAdd(name).finally(() => setPending(false));
        }}
      />
      <SettingsSaveError error={submitted ? saveError : null} />
    </SettingsCard>
  );
}

function ProfileFields({ profile, entries, errorFor, update }: {
  profile: FactoryProfileValue;
  entries: ProviderEntries;
  errorFor(field: keyof FactoryProfileValue): string | null;
  update(field: keyof FactoryProfileValue, edit: (profile: FactoryProfileValue) => FactoryProfileValue): void;
}) {
  const entry = entries.find((entry) => entry.provider === profile.provider);
  const models = entry?.models ?? [];
  const model = models.find((model) => model.id === profile.model);
  const providers = entries.map((entry) => ({ id: entry.provider, label: entry.label }))
    .sort((a, b) => labelOrId(a).localeCompare(labelOrId(b)));
  return (
    <>
      <SettingsSelect
        label="Provider"
        value={profile.provider}
        options={profileOptions(providers, profile.provider)}
        error={errorFor("provider")}
        onValueChange={(provider) => update("provider", (current) => {
          if (provider === current.provider) return current;
          const offered = entries.find((entry) => entry.provider === provider)?.models ?? [];
          const model = offered.find((item) => item.id === current.model)?.id ?? offered[0]?.id ?? current.model;
          return { ...current, provider, model, thinking: null, mode: null };
        })}
      />
      <SettingsSelect
        label="Model"
        value={profile.model}
        options={profileOptions(models, profile.model)}
        error={errorFor("model")}
        onValueChange={(model) => update("model", (current) => {
          if (model === current.model) return current;
          const selected = entries.find((entry) => entry.provider === current.provider)?.models?.find((item) => item.id === model);
          const thinking = selected?.thinkingOptions?.some((item) => item.id === current.thinking) ? current.thinking : null;
          return { ...current, model, thinking };
        })}
      />
      <SettingsSelect
        label="Thinking"
        value={profile.thinking ?? ""}
        options={profileOptions([DEFAULT_OPTION, ...(model?.thinkingOptions ?? [])], profile.thinking ?? "")}
        error={errorFor("thinking")}
        onValueChange={(value) => update("thinking", (current) => ({ ...current, thinking: value || null }))}
      />
      <SettingsSelect
        label="Permission mode"
        value={profile.mode ?? ""}
        options={profileOptions([DEFAULT_OPTION, ...(entry?.modes ?? [])], profile.mode ?? "")}
        error={errorFor("mode")}
        onValueChange={(value) => update("mode", (current) => ({ ...current, mode: value || null }))}
      />
      <SettingsSwitch
        label="Advisor"
        hint="Use this profile for second opinions."
        value={profile.advisor}
        error={errorFor("advisor")}
        onValueChange={(advisor) => update("advisor", (current) => ({ ...current, advisor }))}
      />
      <SettingsSwitch
        label="Sensitive"
        hint="Workers on this profile only get sanitized technical tasks. They receive no personal data, accounts or credentials."
        value={profile.sensitive}
        error={errorFor("sensitive")}
        onValueChange={(sensitive) => update("sensitive", (current) => ({ ...current, sensitive }))}
      />
    </>
  );
}

type CatalogOption = { id: string; label?: string };
const DEFAULT_OPTION = { id: "", label: "Provider default" };

function labelOrId(option: CatalogOption): string {
  return option.label?.trim() || option.id;
}

function profileOptions(items: readonly CatalogOption[], selected: string) {
  const labels = items.map(labelOrId);
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const options = items.map(({ id }, index) => {
    const label = labels[index];
    return { label: (counts.get(label) ?? 0) > 1 && label !== id ? `${label} (${id})` : label, value: id };
  });
  if (!options.some(({ value }) => value === selected)) options.unshift({ label: selected, value: selected });
  return options;
}

function profileSummary(profile: FactoryProfileValue, entries: ProviderEntries): string {
  const entry = entries.find((entry) => entry.provider === profile.provider);
  const model = entry?.models?.find((model) => model.id === profile.model);
  const thinking = model?.thinkingOptions?.find((option) => option.id === profile.thinking);
  const mode = entry?.modes?.find((mode) => mode.id === profile.mode);
  return [
    labelOrId({ id: profile.provider, label: entry?.label }),
    model ? labelOrId(model) : profile.model,
    thinking ? labelOrId(thinking) : profile.thinking,
    mode ? labelOrId(mode) : profile.mode,
    profile.advisor ? "Advisor" : null,
    profile.sensitive ? "Sensitive" : null,
  ].filter(Boolean).join(" · ");
}

function IconButton({ theme, compact, icon, label, showLabel, disabled, onPress }: Appearance & {
  icon: string;
  label: string;
  showLabel?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  const [focused, setFocused] = useState(false);
  const colors = theme.colors;
  const size = compact ? 44 : 32;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
      style={({ pressed }) => ({
        minWidth: size,
        minHeight: size,
        paddingHorizontal: 6,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        borderWidth: 1,
        borderColor: focused && !disabled ? colors.accent : "transparent",
        borderRadius: 6,
        backgroundColor: pressed ? colors.surface2 : "transparent",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Icon name={icon} size={16} color={showLabel ? colors.foreground : colors.foregroundMuted} />
      {showLabel ? <Text style={{ color: colors.foreground, fontSize: 13 }}>{label}</Text> : null}
    </Pressable>
  );
}
