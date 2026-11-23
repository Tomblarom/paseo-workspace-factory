// Validation and config layering for the factory settings documents.
// Pure module: no imports, so both the plugin bundles and plain node:test use it.

export interface FactoryProfileValue {
  provider: string;
  model: string;
  thinking: string | null;
  mode: string | null;
}

export interface FactorySettingsValues {
  profiles: Record<string, FactoryProfileValue>;
  slots: Record<string, string>;
  prepare: string[];
  initialActive: string;
  workerDefault: string;
}

export interface ProviderEntry {
  provider: string;
  enabled?: boolean;
  status?: string;
  models?: { id: string; thinkingOptions?: { id: string }[] }[];
  modes?: { id: string }[];
}

export interface KnownLimit {
  provider: string;
  model?: string;
  modelPattern?: string;
  field: "thinking" | "mode";
  reason: string;
}

/** Settings the catalog advertises but a provider rejects at creation. Mirrors src/config.mjs. */
export const KNOWN_UNSUPPORTED: {
  provider: string;
  modelPattern: string;
  field: "thinking" | "mode";
  reason: string;
}[] = [
  {
    provider: "copilot",
    modelPattern: "^claude-",
    field: "thinking",
    reason: "Copilot rejects a reasoning effort for Claude models; use thinking: null",
  },
];

export interface CleanupSettingsValues {
  mode: string;
  idleMinutes: number;
  compactAtMinutes: number;
  minContextTokens: number;
  providers: string[];
  roles: string[];
  seedAfterClear: boolean;
  clearAcknowledged: boolean;
  dailyCap: number;
}

/** Structural check of the C5 cleanup document. Empty means valid. */
export function validateCleanupSettings(values: CleanupSettingsValues): string[] {
  const errors: string[] = [];
  if (!values || typeof values !== "object") return ["settings must be an object"];
  if (!["off", "clear", "compact-warm"].includes(values.mode)) {
    errors.push(`mode must be off, clear, or compact-warm, got ${JSON.stringify(values.mode)}`);
  }
  for (const key of ["idleMinutes", "compactAtMinutes"] as const) {
    const value = values[key];
    if (!Number.isInteger(value) || value < 5) {
      errors.push(`${key} must be an integer of at least 5 minutes`);
    }
  }
  if (!Number.isInteger(values.minContextTokens) || values.minContextTokens < 1000) {
    errors.push("minContextTokens must be an integer of at least 1000");
  }
  if (!Array.isArray(values.providers) || !values.providers.length) {
    errors.push("providers must list at least one provider");
  } else {
    for (const provider of values.providers) {
      if (typeof provider !== "string" || !provider) errors.push("providers must be non-empty strings");
    }
  }
  if (!Array.isArray(values.roles) || !values.roles.length) {
    errors.push("roles must list at least one role");
  } else {
    for (const role of values.roles) {
      if (role !== "steer" && role !== "worker") {
        errors.push(`roles must be steer or worker, got ${JSON.stringify(role)}`);
      }
    }
  }
  for (const key of ["seedAfterClear", "clearAcknowledged"] as const) {
    if (typeof values[key] !== "boolean") errors.push(`${key} must be a boolean`);
  }
  if (!Number.isInteger(values.dailyCap) || values.dailyCap < 1) {
    errors.push("dailyCap must be an integer of at least 1");
  }
  return errors;
}

/** Structural check of the host-scope settings document. Empty means valid. */
export function validateFactorySettings(values: FactorySettingsValues): string[] {
  const errors: string[] = [];
  if (!values || typeof values !== "object") return ["settings must be an object"];
  const profiles = values.profiles ?? {};
  if (typeof profiles !== "object" || !Object.keys(profiles).length) {
    errors.push("profiles must define at least one profile");
  }
  for (const [name, raw] of Object.entries(profiles)) {
    const profile = (raw ?? {}) as Partial<FactoryProfileValue>;
    if (typeof profile.provider !== "string" || !profile.provider) {
      errors.push(`profiles.${name}.provider is required`);
    }
    if (typeof profile.model !== "string" || !profile.model) {
      errors.push(`profiles.${name}.model is required`);
    }
    for (const key of ["thinking", "mode"] as const) {
      const value: unknown = profile[key];
      if (value !== null && value !== undefined && typeof value !== "string") {
        errors.push(`profiles.${name}.${key} must be a string or null`);
      }
    }
  }
  const slots = values.slots ?? {};
  if (!Object.keys(slots).length) errors.push("slots must define at least one slot");
  for (const [slot, profile] of Object.entries(slots)) {
    if (!/^[A-Z]$/.test(slot)) errors.push(`slot ${JSON.stringify(slot)} must be a single capital letter`);
    if (!profiles[profile]) errors.push(`slot ${slot} references unknown profile ${JSON.stringify(profile)}`);
  }
  const prepare = values.prepare ?? [];
  if (!Array.isArray(prepare) || !prepare.length) errors.push("prepare must list at least one slot");
  for (const slot of prepare) {
    if (!slots[slot]) errors.push(`prepare references unknown slot ${JSON.stringify(slot)}`);
  }
  if (new Set(prepare).size !== prepare.length) errors.push("prepare contains duplicates");
  if (!prepare.includes(values.initialActive)) {
    errors.push("initialActive must be one of prepare");
  }
  if (!profiles[values.workerDefault]) {
    errors.push(`workerDefault references unknown profile ${JSON.stringify(values.workerDefault)}`);
  }
  return errors;
}

/**
 * Layers the host-scope settings document over the config file: profiles merge
 * per name, slots/prepare/initialActive/workerDefault replace the file values.
 * Everything else (github, checkoutRoot, runtime, knownLimits) stays file-owned.
 */
export function mergeFactoryConfig(fileConfig: any, settings: FactorySettingsValues): any {
  const next = JSON.parse(JSON.stringify(fileConfig));
  next.profiles = { ...(fileConfig.profiles ?? {}), ...settings.profiles };
  next.steers = {
    ...(fileConfig.steers ?? {}),
    slots: { ...settings.slots },
    prepare: [...settings.prepare],
    initialActive: settings.initialActive,
  };
  next.workers = { ...(fileConfig.workers ?? {}), defaultProfile: settings.workerDefault };
  return next;
}

/**
 * Same catalog check the CLI runs: every used profile must be startable.
 * Matches on provider/model/thinking/mode plus known provider exceptions.
 */
export function validateProfilesAgainstCatalogLocal(
  profiles: Record<string, FactoryProfileValue>,
  providerEntries: ProviderEntry[],
  profileNames: string[],
  knownLimits: KnownLimit[] = [],
): Record<string, string[]> {
  const byProvider = new Map((providerEntries ?? []).map((entry) => [entry.provider, entry]));
  const problems: Record<string, string[]> = {};
  for (const name of profileNames) {
    const profile = profiles[name];
    if (!profile) {
      problems[name] = [`unknown profile ${JSON.stringify(name)}`];
      continue;
    }
    const issues: string[] = [];
    const entry = byProvider.get(profile.provider);
    if (!entry) {
      issues.push(`provider "${profile.provider}" is not configured in Paseo`);
    } else if (!entry.enabled || entry.status !== "ready") {
      issues.push(`provider "${profile.provider}" is ${entry.enabled ? entry.status : "disabled"}`);
    } else {
      const model = (entry.models ?? []).find((m) => m.id === profile.model);
      if (!model) {
        issues.push(`model "${profile.model}" is not offered by ${profile.provider}`);
      } else if (profile.thinking) {
        const options = (model.thinkingOptions ?? []).map((t) => t.id);
        if (!options.includes(profile.thinking)) {
          issues.push(
            `thinking "${profile.thinking}" is not available for ${profile.model} (available: ${options.join(", ") || "none"})`,
          );
        }
      }
      for (const rule of KNOWN_UNSUPPORTED) {
        if (
          rule.provider === profile.provider &&
          new RegExp(rule.modelPattern).test(profile.model) &&
          profile[rule.field]
        ) {
          issues.push(rule.reason);
        }
      }
      for (const rule of knownLimits) {
        if (rule.provider !== profile.provider) continue;
        const value = profile[rule.field];
        if (!value) continue;
        if (rule.model !== undefined && profile.model !== rule.model) continue;
        if (rule.modelPattern) {
          try {
            if (!new RegExp(rule.modelPattern).test(profile.model)) continue;
          } catch {
            continue;
          }
        }
        issues.push(rule.reason);
      }
      if (profile.mode && !(entry.modes ?? []).some((m) => m.id === profile.mode)) {
        issues.push(
          `mode "${profile.mode}" is not available for ${profile.provider} (available: ${(entry.modes ?? []).map((m) => m.id).join(", ")})`,
        );
      }
    }
    if (issues.length) problems[name] = issues;
  }
  return problems;
}
