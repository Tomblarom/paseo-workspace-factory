// Validation and config layering for the factory settings documents.
// Pure module: its only import is the shared defaults, so both the plugin
// bundles and plain node:test use it.
import { KNOWN_UNSUPPORTED as CORE_KNOWN_UNSUPPORTED, QUOTA_DEFAULTS } from "./defaults.mjs";

export interface FactoryProfileValue {
  provider: string;
  model: string;
  thinking: string | null;
  mode: string | null;
  advisor: boolean;
  sensitive: boolean;
}

export interface LegacyFactoryConfig {
  version: number;
  values: {
    profiles?: Record<string, {
      provider: string;
      model: string;
      thinking?: string | null;
      mode?: string | null;
      advisor?: boolean;
      sensitive?: boolean;
      [key: string]: unknown;
    }>;
    slots?: Record<string, string>;
    prepare?: string[];
    initialActive?: string;
    workerDefault?: string;
    workerPriority?: string[];
    quota?: { exhaustedPct?: number; warnPct?: number; [key: string]: unknown };
    githubOwner?: string | null;
    checkoutRoot?: string | null;
    [key: string]: unknown;
  };
}

export interface FactorySettingsValues {
  profiles: Record<string, FactoryProfileValue>;
  slots: Record<string, string>;
  prepare: string[];
  initialActive: string;
  workerPriority: string[];
  steerPriority: string[];
  advisorPriority: string[];
  routingStrategy: "efficiency" | "balanced" | "preference";
  legacySnapshot: LegacyFactoryConfig | null;
  quota: { exhaustedPct: number; warnPct: number };
  /** Null/empty means unset; both host fields are required to run. */
  githubOwner: string | null;
  /** Null/empty means unset; both host fields are required to run. */
  checkoutRoot: string | null;
}

/** Legacy slot order is the existing priority order; classifications are part of route identity. */
export function prioritiesFromSlots(
  slots: Record<string, string>,
  profiles: Record<string, FactoryProfileValue>,
): { steerPriority: string[]; advisorPriority: string[] } {
  const result: { steerPriority: string[]; advisorPriority: string[] } = { steerPriority: [], advisorPriority: [] };
  const seen = new Set<string>();
  for (const slot of Object.keys(slots ?? {}).sort()) {
    const name = slots[slot];
    const p = profiles?.[name];
    if (!p || typeof p.provider !== "string" || !p.provider || typeof p.model !== "string" || !p.model
      || (p.advisor !== undefined && typeof p.advisor !== "boolean")
      || (p.sensitive !== undefined && typeof p.sensitive !== "boolean")
      || (p.thinking != null && typeof p.thinking !== "string")
      || (p.mode != null && typeof p.mode !== "string")) continue;
    const key = JSON.stringify([p.provider, p.model, p.thinking ?? null, p.mode ?? null,
      p.advisor === true, p.sensitive ?? p.provider === "muse"]);
    if (seen.has(key)) continue;
    seen.add(key);
    result[p.advisor === true ? "advisorPriority" : "steerPriority"].push(name);
  }
  return result;
}

/**
 * Settings document that equals `config` for everything the plugin owns.
 * Profiles keep the stored ones and add every profile `config` references or
 * changed, so planner-added profiles are copied only when they become used.
 * The host setup (githubOwner, checkoutRoot) is preserved from `current` and
 * never copied from the planned config, so a models edit cannot pin derived
 * values into the settings and change later resolution.
 */
export function settingsFromConfig(config: any, current: FactorySettingsValues): FactorySettingsValues {
  const slots: Record<string, string> = { ...(config.steers?.slots ?? {}) };
  const priority: string[] = Array.isArray(config.workers?.priority)
    ? [...config.workers.priority]
    : config.workers?.defaultProfile
      ? [config.workers.defaultProfile]
      : [];
  const derived = prioritiesFromSlots(current.slots, current.profiles);
  const steerPriority = config.steers?.priority !== undefined
    ? config.steers.priority : current.steerPriority === undefined ? derived.steerPriority : current.steerPriority;
  const advisorPriority = config.advisors?.priority !== undefined
    ? config.advisors.priority : current.advisorPriority === undefined ? derived.advisorPriority : current.advisorPriority;
  const profiles: Record<string, FactoryProfileValue> = { ...current.profiles };
  for (const [name, p] of Object.entries<any>(config.profiles ?? {})) {
    const stored = current.profiles?.[name];
    const used = Object.values(slots).includes(name) || priority.includes(name)
      || steerPriority.includes(name) || advisorPriority.includes(name);
    for (const key of ["advisor", "sensitive"] as const) {
      if (p[key] !== undefined && typeof p[key] !== "boolean") {
        throw new Error(`profiles.${name}.${key} must be a boolean`);
      }
    }
    const advisor = p.advisor ?? stored?.advisor ?? false;
    const sensitive = p.sensitive ?? stored?.sensitive ?? (p.provider === "muse");
    const flagsChanged = stored && stored.advisor !== advisor;
    const sensChanged = stored && stored.sensitive !== sensitive;
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
      advisor,
      sensitive,
    };
  }
  return {
    profiles,
    slots,
    prepare: [...(config.steers?.prepare ?? current.prepare)],
    initialActive: config.steers?.initialActive ?? current.initialActive,
    workerPriority: priority,
    steerPriority: [...steerPriority],
    advisorPriority: [...advisorPriority],
    routingStrategy: config.routing?.strategy !== undefined
      ? config.routing.strategy : current.routingStrategy === undefined ? "efficiency" : current.routingStrategy,
    legacySnapshot: current.legacySnapshot == null ? null : JSON.parse(JSON.stringify(current.legacySnapshot)),
    quota: current.quota ?? { exhaustedPct: QUOTA_DEFAULTS.exhaustedPct, warnPct: QUOTA_DEFAULTS.warnPct },
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

/** Settings the catalog advertises but a provider rejects at creation. Single source is ./defaults.mjs. */
export const KNOWN_UNSUPPORTED = CORE_KNOWN_UNSUPPORTED as {
  provider: string;
  modelPattern: string;
  field: "thinking" | "mode";
  reason: string;
}[];

export interface CleanupSettingsValues {
  mode: string;
  profile: string;
  idleMinutes: number;
  minContextTokens: number;
  providers: string[];
  roles: string[];
  clearAcknowledged: boolean;
  dailyCap: number;
  rewindFresh: boolean;
}

export interface QuotaSettingsValues {
  quota: { exhaustedPct: number; warnPct: number };
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
  return errors;
}

/** Same account rule the CLI config validator uses (plugin/server/core/config.mjs). */
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
 * Structural check of the host setup. Null/blank is allowed here and reported
 * separately as missing by the loader; an explicit value must be well-formed.
 * Empty means valid.
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
 * Effective config built from the plugin settings only (no config file).
 * Uses the native defaults (https/upstream, workspace title "Main").
 * Assumes validateFactorySettings passed and both host fields are explicit;
 * blank values stay blank so validation fails clearly.
 */
export function configFromSettings(settings: FactorySettingsValues): any {
  const derived = prioritiesFromSlots(settings.slots, settings.profiles);
  const legacy = settings.legacySnapshot?.values;
  return {
    version: 1,
    github: {
      owner: normalizeGithubOwner(settings.githubOwner) ?? "",
      cloneProtocol: "https",
      upstreamRemote: "upstream",
    },
    checkoutRoot: normalizeCheckoutRoot(settings.checkoutRoot) ?? "",
    workspaceTitle: "Main",
    profiles: JSON.parse(JSON.stringify(settings.profiles ?? {})),
    steers: {
      slots: { ...(settings.slots ?? {}) },
      prepare: [...(settings.prepare ?? [])],
      initialActive: settings.initialActive,
      priority: [...(settings.steerPriority === undefined ? derived.steerPriority : settings.steerPriority)],
    },
    ...(legacy?.slots && legacy.profiles ? {
      legacyAdvisorSlots: Object.entries(legacy.slots)
        .filter(([, name]) => legacy.profiles?.[name]?.advisor === true)
        .map(([slot]) => slot),
    } : {}),
    advisors: { priority: [...(settings.advisorPriority === undefined ? derived.advisorPriority : settings.advisorPriority)] },
    workers: {
      priority: [...(settings.workerPriority ?? [])],
      defaultProfile: settings.workerPriority?.[0],
    },
    quota: { ...(settings.quota ?? {}) },
    routing: { strategy: settings.routingStrategy === undefined ? "efficiency" : settings.routingStrategy },
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
  for (const key of ["clearAcknowledged", "rewindFresh"] as const) {
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
  for (const key of ["steerPriority", "advisorPriority"] as const) {
    const list = values[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`${key} must be a list of profiles`);
      continue;
    }
    for (const name of list) {
      if (typeof name !== "string" || !name || !profiles[name]) {
        errors.push(`${key} references unknown profile ${JSON.stringify(name)}`);
      } else if (typeof profiles[name].advisor === "boolean"
        && profiles[name].advisor !== (key === "advisorPriority")) {
        errors.push(`${key} profile ${JSON.stringify(name)} has an incompatible advisor classification`);
      }
    }
    if (new Set(list).size !== list.length) errors.push(`${key} contains duplicates`);
  }
  if (values.routingStrategy !== undefined && !["efficiency", "balanced", "preference"].includes(values.routingStrategy)) {
    errors.push("routingStrategy must be efficiency, balanced, or preference");
  }
  if (values.steerPriority === undefined) {
    const isAdvisorSlot = (slot: string) => profiles[slots[slot]]?.advisor === true;
    if (Object.keys(slots).length && Object.keys(slots).every(isAdvisorSlot)) {
      errors.push("at least one steer slot needs a non-advisor profile");
    }
    if (slots[values.initialActive] && isAdvisorSlot(values.initialActive)) {
      errors.push(`initialActive ${values.initialActive} is an advisor slot; pick a coordinating steer`);
    }
  }
  return errors;
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
