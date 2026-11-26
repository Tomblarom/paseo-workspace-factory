import type { FactoryProfileValue, FactorySettingsValues } from "../shared/settings-validate.js";
import type { SettingsEdit } from "./settings-edit.js";

export type PriorityKey = "steerPriority" | "advisorPriority" | "workerPriority";

type PriorityAction = "add" | "up" | "down" | "remove";

export function usedProfileNames(values: FactorySettingsValues): string[] {
  return [...new Set([
    ...Object.values(values.slots),
    ...values.steerPriority,
    ...values.advisorPriority,
    ...values.workerPriority,
  ])];
}

export function fitsPriorityRole(profile: FactoryProfileValue, key: PriorityKey): boolean {
  return profile.advisor === (key === "advisorPriority");
}

export function editProfile(name: string, edit: (profile: FactoryProfileValue) => FactoryProfileValue): SettingsEdit<FactorySettingsValues> {
  return (current) => {
    if (!Object.hasOwn(current.profiles, name)) return "This profile was removed.";
    const before = current.profiles[name];
    const profile = edit(before);
    const next = { ...current, profiles: { ...current.profiles, [name]: profile } };
    if (profile.advisor === before.advisor) return next;

    const source = profile.advisor ? "steerPriority" : "advisorPriority";
    const target = profile.advisor ? "advisorPriority" : "steerPriority";
    if (!current[source].includes(name)) return next;
    return {
      ...next,
      [source]: current[source].filter((profile) => profile !== name),
      [target]: [...current[target].filter((profile) => profile !== name), name],
    };
  };
}

export function editPriority(key: PriorityKey, name: string, action: PriorityAction): SettingsEdit<FactorySettingsValues> {
  return (current) => {
    const names = current[key];
    const from = names.indexOf(name);

    if (action === "add") {
      if (from !== -1) return current;
      if (!Object.hasOwn(current.profiles, name)) return "This profile was removed.";
      if (!fitsPriorityRole(current.profiles[name], key)) return "This profile is no longer eligible for this role.";
      return { ...current, [key]: [...names, name] };
    }

    if (action === "remove") {
      if (from === -1) return current;
      if (key === "workerPriority" && names.length === 1) return "Keep at least one worker profile.";
      return { ...current, [key]: names.filter((profile) => profile !== name) };
    }

    if (from === -1) return "This profile was removed from the priority list.";
    const to = from + (action === "up" ? -1 : 1);
    if (to < 0 || to >= names.length) return current;
    const ordered = [...names];
    ordered[from] = names[to];
    ordered[to] = name;
    return { ...current, [key]: ordered };
  };
}
