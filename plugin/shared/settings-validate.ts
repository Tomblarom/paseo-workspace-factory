// Validation and config layering for the factory settings documents.
// Pure module: no imports, so both the plugin bundles and plain node:test use it.

export interface FactoryProfileValue {
  provider: string;
  model: string;
  thinking: string | null;
  mode: string | null;
  advisor: boolean;
  sensitive: boolean;
}

export interface FactorySettingsValues {
  profiles: Record<string, FactoryProfileValue>;
  slots: Record<string, string>;
  prepare: string[];
  initialActive: string;
  workerPriority: string[];
  quota: { exhaustedPct: number; warnPct: number };
  quotaSampleMinutes: number;
  /** Null/empty means "from the config file"; a saved value replaces it. */
  githubOwner: string | null;
  /** Null/empty means "from the config file"; a saved value replaces it. */
  checkoutRoot: string | null;
}

/**
 * Settings document that equals `config` for everything the plugin owns.
 * Profiles keep the stored ones and add every profile `config` references or
 * changed, so file-only profiles are copied only when they become used.
 * The host setup (githubOwner, checkoutRoot) is preserved from `current` and
 * never copied from the file, so a models edit cannot pin file values into
 * the settings and change later resolution.
 */
export function settingsFromConfig(config: any, current: FactorySettingsValues): FactorySettingsValues {
  const slots: Record<string, string> = { ...(config.steers?.slots ?? {}) };
  const priority: string[] = Array.isArray(config.workers?.priority)
    ? [...config.workers.priority]
    : config.workers?.defaultProfile
      ? [config.workers.defaultProfile]
      : [];
  const profiles: Record<string, FactoryProfileValue> = {};
  for (const [name, p] of Object.entries<any>(config.profiles ?? {})) {
    const stored = current.profiles?.[name];
    const used = Object.values(slots).includes(name) || priority.includes(name);
    const flagsChanged = stored && (stored.advisor === true) !== (p.advisor === true);
    const sensChanged = stored && Boolean(stored.sensitive) !== Boolean(p.sensitive ?? p.provider === "muse");
    const different = stored && (stored.provider !== p.provider || stored.model !== p.model || (stored.thinking ?? null) !== (p.thinking ?? null) || (stored.mode ?? null) !== (p.mode ?? null));
    if (!stored && !used) continue;
    if (stored && !used && !flagsChanged && !sensChanged && !different) {
      profiles[name] = stored;
      continue;
    }
    profiles[name] = {
      provider: p.provider,
      model: p.model,
      thinking: p.thinking ?? null,
      mode: p.mode ?? null,
      advisor: p.advisor === true,
      sensitive: typeof p.sensitive === "boolean" ? p.sensitive : p.provider === "muse",
    };
  }
  return {
    profiles,
    slots,
    prepare: [...(config.steers?.prepare ?? current.prepare)],
    initialActive: config.steers?.initialActive ?? current.initialActive,
    workerPriority: priority,
    quota: current.quota ?? { exhaustedPct: 90, warnPct: 75 },
    quotaSampleMinutes: current.quotaSampleMinutes ?? 10,
    githubOwner: current.githubOwner ?? null,
    checkoutRoot: current.checkoutRoot ?? null,
  };
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
  profile: string;
  idleMinutes: number;
  minContextTokens: number;
  providers: string[];
  roles: string[];
  seedAfterClear: boolean;
  clearAcknowledged: boolean;
  dailyCap: number;
  rewindFresh: boolean;
}

export interface QuotaSettingsValues {
  quota: { exhaustedPct: number; warnPct: number };
  quotaSampleMinutes: number;
}

export function validateQuotaSettings(values: QuotaSettingsValues): string[] {
  if (!values || typeof values !== "object") return ["settings must be an object"];
  const errors: string[] = [];
  for (const key of ["exhaustedPct", "warnPct"] as const) {
    const value = values.quota?.[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      errors.push(`quota.${key} must be a number from 0 to 100`);
    }
  }
  if (values.quotaSampleMinutes !== undefined &&
      (!Number.isInteger(values.quotaSampleMinutes) || values.quotaSampleMinutes < 10)) {
    errors.push("quotaSampleMinutes must be an integer of at least 10 minutes");
  }
  return errors;
}

/** Same account rule the CLI config validator uses (src/config.mjs). */
export const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Absolute-path check without node:path (this module stays import-free so the
 * client bundle and plain node:test use it): POSIX roots plus Windows drive
 * and UNC roots. The CLI re-checks with path.isAbsolute on its own platform.
 */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

/** Trimmed value, or null when unset, blank, or not a string. */
export function normalizeGithubOwner(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Trimmed value, or null when unset, blank, or not a string. */
export function normalizeCheckoutRoot(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Structural check of the optional host setup. Null/blank means "from the
 * config file" and is valid; an explicit value must be well-formed. Empty
 * means valid.
 */
export function validateHostSettings(values: Pick<FactorySettingsValues, "githubOwner" | "checkoutRoot">): string[] {
  const errors: string[] = [];
  if (!values || typeof values !== "object") return errors;
  const owner = normalizeGithubOwner(values.githubOwner);
  if (owner !== null && !GITHUB_OWNER_PATTERN.test(owner)) {
    errors.push("githubOwner must be a GitHub account name");
  }
  const root = normalizeCheckoutRoot(values.checkoutRoot);
  if (root !== null && !isAbsolutePath(root)) {
    errors.push("checkoutRoot must be an absolute path");
  }
  return errors;
}

/** Host fields still unset (null/blank): "githubOwner" and/or "checkoutRoot". */
export function missingHostSettings(values: Pick<FactorySettingsValues, "githubOwner" | "checkoutRoot">): string[] {
  const missing: string[] = [];
  if (normalizeGithubOwner(values?.githubOwner) === null) missing.push("githubOwner");
  if (normalizeCheckoutRoot(values?.checkoutRoot) === null) missing.push("checkoutRoot");
  return missing;
}

/**
 * File-owned half of a minimal config for hosts without a config file, using
 * the native defaults (https/upstream, workspace title "Main"). The caller
 * layers the settings on top with mergeFactoryConfig and re-validates with
 * the CLI validator. Assumes validateFactorySettings passed and both host
 * fields are explicit; blank values stay blank so validation fails clearly.
 */
export function minimalFileConfigBase(settings: FactorySettingsValues): any {
  return {
    version: 1,
    github: {
      owner: normalizeGithubOwner(settings.githubOwner) ?? "",
      cloneProtocol: "https",
      upstreamRemote: "upstream",
    },
    checkoutRoot: normalizeCheckoutRoot(settings.checkoutRoot) ?? "",
    workspaceTitle: "Main",
    profiles: {},
    steers: {},
    workers: {},
  };
}

/** Structural check of the C5 cleanup document. Empty means valid. */
export function validateCleanupSettings(values: CleanupSettingsValues): string[] {
  const errors: string[] = [];
  if (!values || typeof values !== "object") return ["settings must be an object"];
  if (!["off", "clear", "compact-warm"].includes(values.mode)) {
    errors.push(`mode must be off, clear, or compact-warm, got ${JSON.stringify(values.mode)}`);
  }
  if (!["efficiency", "balanced", "comfort"].includes(values.profile)) {
    errors.push(`profile must be efficiency, balanced, or comfort, got ${JSON.stringify(values.profile)}`);
  }
  if (!Number.isInteger(values.idleMinutes) || values.idleMinutes < 5) {
    errors.push("idleMinutes must be an integer of at least 5 minutes");
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
  for (const key of ["seedAfterClear", "clearAcknowledged", "rewindFresh"] as const) {
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
  errors.push(...validateQuotaSettings(values));
  errors.push(...validateHostSettings(values));
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
  const priority = values.workerPriority ?? [];
  if (!Array.isArray(priority) || !priority.length) {
    errors.push("workerPriority must list at least one profile");
  } else {
    for (const name of priority) {
      if (!profiles[name]) errors.push(`workerPriority references unknown profile ${JSON.stringify(name)}`);
      else if (profiles[name].advisor === true) errors.push(`workerPriority profile ${JSON.stringify(name)} is tagged as advisor`);
    }
    if (new Set(priority).size !== priority.length) errors.push("workerPriority contains duplicates");
  }
  for (const [name, p] of Object.entries(profiles)) {
    for (const key of ["advisor", "sensitive"] as const) {
      const flag: unknown = (p as Partial<FactoryProfileValue>)?.[key];
      if (flag !== undefined && typeof flag !== "boolean") errors.push(`profiles.${name}.${key} must be a boolean`);
    }
  }
  const isAdvisorSlot = (slot: string) => profiles[slots[slot]]?.advisor === true;
  if (Object.keys(slots).length && Object.keys(slots).every(isAdvisorSlot)) {
    errors.push("at least one steer slot needs a non-advisor profile");
  }
  if (slots[values.initialActive] && isAdvisorSlot(values.initialActive)) {
    errors.push(`initialActive ${values.initialActive} is an advisor slot; pick a coordinating steer`);
  }
  return errors;
}

/**
 * Layers the host-scope settings document over the config file: profiles merge
 * per name, slots/prepare/initialActive/workerPriority replace the file values
 * (workers.defaultProfile follows priority[0] for older readers). An explicit
 * githubOwner/checkoutRoot (non-blank) replaces the matching file value;
 * unset host fields leave the file alone. Everything else (github protocol
 * and remotes, runtime, knownLimits) stays file-owned.
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
  next.workers = {
    ...(fileConfig.workers ?? {}),
    priority: [...settings.workerPriority],
    defaultProfile: settings.workerPriority[0],
  };
  next.quota = { ...(fileConfig.quota ?? {}), ...settings.quota };
  next.quotaSampleMinutes = settings.quotaSampleMinutes;
  const owner = normalizeGithubOwner(settings?.githubOwner);
  if (owner !== null) {
    next.github = { ...(next.github ?? {}), owner };
  }
  const root = normalizeCheckoutRoot(settings?.checkoutRoot);
  if (root !== null) {
    next.checkoutRoot = root;
  }
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
