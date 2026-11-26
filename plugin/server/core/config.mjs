// Central factory configuration: structural validation and validation
// against the live provider catalog. The effective config is built from the
// plugin settings only (see plugin/server/config.ts); there is no config file.
// Presets select future models. Each live steer keeps its coordination role.
import { isAbsolute } from 'node:path';
import { KNOWN_UNSUPPORTED, knownUnsupportedReason } from '../../shared/defaults.mjs';
import { profilePool } from './quota.mjs';
import { LABEL } from './paseo.mjs';

export { KNOWN_UNSUPPORTED };

export const KNOWN_LIMIT_FIELDS = ['thinking', 'mode'];

/**
 * User-supplied exceptions from `knownLimits`, normalized to matcher rules.
 * Invalid entries are skipped here; validateConfig() reports them.
 */
function configKnownLimits(config) {
  const rules = [];
  if (!Array.isArray(config?.knownLimits)) return rules;
  for (const entry of config.knownLimits) {
    if (!entry || typeof entry !== 'object') continue;
    let pattern = null;
    if (typeof entry.modelPattern === 'string' && entry.modelPattern) {
      try {
        pattern = new RegExp(entry.modelPattern);
      } catch {
        continue;
      }
    }
    const model = typeof entry.model === 'string' && entry.model ? entry.model : undefined;
    if (model === undefined && !pattern) continue;
    if (!KNOWN_LIMIT_FIELDS.includes(entry.field)) continue;
    if (typeof entry.reason !== 'string' || !entry.reason) continue;
    rules.push({ provider: entry.provider, model, pattern, field: entry.field, reason: entry.reason });
  }
  return rules;
}
export const SLOT_PATTERN = /^[A-Z]$/;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Worker priority, highest first. A missing `workers.priority` reads as
 * `[defaultProfile]` (read migration); writes set `defaultProfile` to
 * `priority[0]` for older readers.
 */
export function workerPriority(config) {
  const priority = config?.workers?.priority;
  if (Array.isArray(priority)) return [...priority];
  const fallback = config?.workers?.defaultProfile;
  return typeof fallback === 'string' && fallback ? [fallback] : [];
}

/** True when the profile carries `"advisor": true` (default false). */
export function isAdvisorProfile(config, name) {
  return config?.profiles?.[name]?.advisor === true;
}

/** True when the slot's profile is advisor-tagged (resolved live, no label). */
export function isAdvisorSlot(config, slot) {
  const name = config?.steers?.slots?.[slot];
  return typeof name === 'string' && isAdvisorProfile(config, name);
}

/** A holder keeps its coordination role when its title, model or host preset changes. */
export function isAdvisorSteer(config, labels, metadata = null) {
  const role = labels?.[LABEL.steerRole] ?? metadata?.[LABEL.steerRole];
  if (role !== undefined) return role !== 'coordinator';
  const slot = labels?.[LABEL.slot];
  return isAdvisorSlot(config, slot) || config?.legacyAdvisorSlots?.includes(slot) === true;
}

/**
 * True when workers of this profile must only get sanitized technical tasks.
 * An explicit boolean wins; otherwise `muse` providers default to sensitive
 * (read migration, backwards compatible).
 */
export function isSensitiveProfile(config, name) {
  const profile = config?.profiles?.[name];
  if (!profile || typeof profile !== 'object') return false;
  if (typeof profile.sensitive === 'boolean') return profile.sensitive;
  return String(profile.provider ?? '').trim().toLowerCase() === 'muse';
}

/** True when the slot's profile is sensitive. */
export function isSensitiveSlot(config, slot) {
  const name = config?.steers?.slots?.[slot];
  return typeof name === 'string' && isSensitiveProfile(config, name);
}

/**
 * Provider-level sensitivity for the adoption privacy rule: sensitive when any
 * same-provider profile is sensitive. Without any such profile, `muse` stays
 * sensitive (migration default) and other providers stay open — the previous
 * hard-coded behavior, now config-driven.
 */
export function providerIsSensitive(config, provider) {
  const key = String(provider ?? '').trim().toLowerCase();
  const matches = Object.entries(config?.profiles ?? {}).filter(([, p]) => String(p?.provider ?? '').trim().toLowerCase() === key);
  if (!matches.length) return key === 'muse';
  return matches.some(([name]) => isSensitiveProfile(config, name));
}

/** Factory packets have unverified provenance, even when addressed to their source tab. */
export function advisorBriefAdmission(config, agent) {
  const advisor = agent?.advisor === true || isAdvisorSteer(config, agent?.labels, agent?.metadata) ||
    isAdvisorSteer(null, null, agent?.metadata);
  return advisor ? { allowed: false, reason: 'advisor brief requires verified sanitized technical context; Factory packet provenance is unverified' } :
    { allowed: true, reason: null };
}

export function steerPrivacyAdmission(config, agent, repoPublic) {
  const provider = String(agent?.provider ?? '').trim().toLowerCase();
  if (!provider) return { allowed: false, reason: 'runtime provider is unknown; inspect the target before delivery' };
  if (providerIsSensitive(config, provider)) {
    if (repoPublic !== true) return { allowed: false, reason: 'sensitive runtime requires a public scope; visibility is private or unknown' };
    return { allowed: false, reason: 'sensitive runtime requires a verified sanitized brief; public repository visibility does not sanitize delivery' };
  }
  return advisorBriefAdmission(config, agent);
}

/** Slot letters in priority order (A first, then B, C, …). */
export function slotOrder(config) {
  return Object.keys(config?.steers?.slots ?? {}).sort();
}

export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return ['config must be an object'];
  if (config.version !== 1) errors.push('version must be 1');
  if (!OWNER_PATTERN.test(config.github?.owner ?? '')) errors.push('github.owner must be a GitHub account name');
  // Retired K13 knobs (cloneProtocol, upstreamRemote, workspaceTitle{,MultiRepo}):
  // validated only when present so old configs keep loading; the planner ignores them.
  if (config.github?.cloneProtocol !== undefined && !['https', 'ssh'].includes(config.github.cloneProtocol)) errors.push('github.cloneProtocol must be https or ssh');
  if (config.github?.upstreamRemote !== undefined && !/^[A-Za-z0-9._-]+$/.test(config.github.upstreamRemote)) errors.push('github.upstreamRemote must be a plain remote name');
  if (typeof config.checkoutRoot !== 'string' || !isAbsolute(config.checkoutRoot)) errors.push('checkoutRoot must be an absolute path');
  if (config.workspaceTitle !== undefined && (typeof config.workspaceTitle !== 'string' || !config.workspaceTitle.trim())) errors.push('workspaceTitle must be a non-empty string when set (retired; ignored)');
  if (config.workspaceTitleMultiRepo !== undefined && config.workspaceTitleMultiRepo !== null
    && (typeof config.workspaceTitleMultiRepo !== 'string' || !config.workspaceTitleMultiRepo.trim())) {
    errors.push('workspaceTitleMultiRepo must be a non-empty string when set (retired; ignored)');
  }

  const profiles = config.profiles ?? {};
  if (typeof profiles !== 'object' || !Object.keys(profiles).length) errors.push('profiles must define at least one profile');
  for (const [name, profile] of Object.entries(profiles)) {
    for (const key of ['provider', 'model']) {
      if (typeof profile?.[key] !== 'string' || !profile[key]) errors.push(`profiles.${name}.${key} is required`);
    }
    for (const key of ['thinking', 'mode']) {
      if (profile?.[key] !== null && profile?.[key] !== undefined && typeof profile[key] !== 'string') {
        errors.push(`profiles.${name}.${key} must be a string or null`);
      }
    }
    for (const key of ['advisor', 'sensitive']) {
      if (profile?.[key] !== undefined && typeof profile[key] !== 'boolean') {
        errors.push(`profiles.${name}.${key} must be a boolean`);
      }
      if (profile?.pool !== undefined && (typeof profile.pool !== 'string' || !profile.pool.trim())) {
        errors.push(`profiles.${name}.pool must be a non-empty string when set`);
      }
    }
  }

  if (config.knownLimits !== undefined) {
    if (!Array.isArray(config.knownLimits)) errors.push('knownLimits must be an array');
    else config.knownLimits.forEach((entry, index) => {
      const where = `knownLimits[${index}]`;
      if (!entry || typeof entry !== 'object') {
        errors.push(`${where} must be an object`);
        return;
      }
      if (typeof entry.provider !== 'string' || !entry.provider) errors.push(`${where}.provider is required`);
      if (entry.model === undefined && entry.modelPattern === undefined) errors.push(`${where} needs model or modelPattern`);
      if (entry.model !== undefined && (typeof entry.model !== 'string' || !entry.model)) errors.push(`${where}.model must be a non-empty string`);
      if (entry.modelPattern !== undefined) {
        if (typeof entry.modelPattern !== 'string' || !entry.modelPattern) errors.push(`${where}.modelPattern must be a non-empty string`);
        else {
          try {
            new RegExp(entry.modelPattern);
          } catch {
            errors.push(`${where}.modelPattern is not a valid regular expression`);
          }
        }
      }
      if (!KNOWN_LIMIT_FIELDS.includes(entry.field)) errors.push(`${where}.field must be thinking or mode`);
      if (typeof entry.reason !== 'string' || !entry.reason.trim()) errors.push(`${where}.reason is required`);
    });
  }

  const slots = config.steers?.slots ?? {};
  if (!Object.keys(slots).length) errors.push('steers.slots must define at least one slot');
  for (const [slot, profile] of Object.entries(slots)) {
    if (!SLOT_PATTERN.test(slot)) errors.push(`steer slot "${slot}" must be a single capital letter`);
    if (!profiles[profile]) errors.push(`steer slot ${slot} references unknown profile "${profile}"`);
  }
  const prepare = config.steers?.prepare ?? [];
  if (!Array.isArray(prepare) || !prepare.length) errors.push('steers.prepare must list at least one slot');
  for (const slot of prepare) if (!slots[slot]) errors.push(`steers.prepare references unknown slot "${slot}"`);
  if (new Set(prepare).size !== prepare.length) errors.push('steers.prepare contains duplicates');
  if (!prepare.includes(config.steers?.initialActive)) errors.push('steers.initialActive must be one of steers.prepare');
  if (config.steers?.activeMarker !== undefined && typeof config.steers.activeMarker !== 'string') errors.push('steers.activeMarker must be a string (empty disables the active-steer tab marker)');
  const slotEntries = Object.entries(slots);
  if (slotEntries.length && slotEntries.every(([, profile]) => profiles[profile]?.advisor === true)) {
    errors.push('steers.slots needs at least one non-advisor slot (advisors never coordinate)');
  }
  const initialProfile = slots[config.steers?.initialActive];
  if (initialProfile && profiles[initialProfile]?.advisor === true) {
    errors.push(`steers.initialActive must not be advisor slot "${config.steers.initialActive}" (profile "${initialProfile}")`);
  }
  if (config.handoffLanguage !== undefined && !['en', 'de'].includes(config.handoffLanguage)) errors.push('handoffLanguage must be "en" or "de"');
  const runtime = config.runtime ?? {};
  if (typeof runtime !== 'object') errors.push('runtime must be an object');
  if (runtime.stateDir !== undefined && (typeof runtime.stateDir !== 'string' || !runtime.stateDir)) errors.push('runtime.stateDir must be a path');
  for (const key of ['url', 'bin', 'passwordFile']) {
    if (runtime.paseo?.[key] !== undefined && runtime.paseo[key] !== null && typeof runtime.paseo[key] !== 'string') errors.push(`runtime.paseo.${key} must be a string`);
  }
  if (config.workers !== undefined && (typeof config.workers !== 'object' || config.workers === null || Array.isArray(config.workers))) {
    errors.push('workers must be an object');
  }
  if (config.workers?.defaultProfile && !profiles[config.workers.defaultProfile]) {
    errors.push(`workers.defaultProfile references unknown profile "${config.workers.defaultProfile}"`);
  }
  if (config.workers?.priority !== undefined) {
    const priority = config.workers.priority;
    if (!Array.isArray(priority) || !priority.length) {
      errors.push('workers.priority must be a non-empty array of profile names');
    } else {
      const seen = new Set();
      for (const name of priority) {
        if (typeof name !== 'string' || !name) errors.push('workers.priority must list profile names');
        else if (!profiles[name]) errors.push(`workers.priority references unknown profile "${name}"`);
        else if (seen.has(name)) errors.push(`workers.priority lists "${name}" twice`);
        else seen.add(name);
      }
    }
  }
  // Removed keys (advisors, runtime.scratchDir, top-level quotaSampleMinutes)
  // are ignored silently for old installs; they are not validated.
  if (config.usage !== undefined) {
    if (typeof config.usage !== 'object' || config.usage === null || Array.isArray(config.usage)) errors.push('usage must be an object');
    else if (config.usage.warnContextTokens !== undefined && (!Number.isInteger(config.usage.warnContextTokens) || config.usage.warnContextTokens <= 0)) {
      errors.push('usage.warnContextTokens must be a positive integer');
    }
    if (config.quota !== undefined) {
      if (typeof config.quota !== 'object' || config.quota === null || Array.isArray(config.quota)) errors.push('quota must be an object');
      else for (const key of ['warnPct', 'exhaustedPct']) {
        if (config.quota[key] !== undefined && (!Number.isFinite(config.quota[key]) || config.quota[key] < 0 || config.quota[key] > 100)) {
          errors.push(`quota.${key} must be a number from 0 to 100`);
        }
      }
    }
  }
  return errors;
}

/**
 * Non-blocking config warnings (advisory only, never thrown):
 * advisor-tagged worker entries (never picked) and advisor profiles that
 * are also sensitive.
 */
export function configWarnings(config) {
  const warnings = [];
  if (!config || typeof config !== 'object') return warnings;
  const profiles = config.profiles ?? {};
  for (const name of workerPriority(config)) {
    if (profiles[name]?.advisor === true) {
      warnings.push(`workers.priority lists advisor profile "${name}" (never picked for workers)`);
    }
  }
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile?.advisor === true && isSensitiveProfile(config, name)) {
      warnings.push(`profile "${name}" is both advisor and sensitive (advisors get sanitized context only)`);
    }
  }
  const pools = new Set(Object.entries(config.steers?.slots ?? {})
    .filter(([, name]) => profiles[name]?.advisor !== true)
    .map(([, name]) => profilePool(profiles[name]))
    .filter(Boolean));
  const nonAdvisor = Object.entries(config.steers?.slots ?? {}).filter(([, name]) => profiles[name]?.advisor !== true);
  if (nonAdvisor.length > 1 && pools.size === 1) {
    warnings.push(`all non-advisor steer slots use quota pool "${[...pools][0]}"`);
  }
  return warnings;
}

/** Profile used by a steer slot, resolved to concrete provider settings. */
export function slotProfile(config, slot) {
  const name = config.steers.slots[slot];
  return { name, ...config.profiles[name] };
}

/**
 * Validates every profile that the plan would use against the daemon's provider
 * snapshot. Returns per-profile problems; an empty object means all are startable.
 */
export function validateProfilesAgainstCatalog(config, providerEntries, profileNames) {
  const byProvider = new Map((providerEntries ?? []).map((entry) => [entry.provider, entry]));
  const problems = {};
  for (const name of profileNames) {
    const profile = config.profiles[name];
    const issues = [];
    const entry = byProvider.get(profile.provider);
    if (!entry) issues.push(`provider "${profile.provider}" is not configured in Paseo`);
    else if (!entry.enabled || entry.status !== 'ready') issues.push(`provider "${profile.provider}" is ${entry.enabled ? entry.status : 'disabled'}`);
    else {
      const model = (entry.models ?? []).find((m) => m.id === profile.model);
      if (!model) issues.push(`model "${profile.model}" is not offered by ${profile.provider}`);
      else if (profile.thinking) {
        const options = (model.thinkingOptions ?? []).map((t) => t.id);
        if (!options.includes(profile.thinking)) {
          issues.push(`thinking "${profile.thinking}" is not available for ${profile.model} (available: ${options.join(', ') || 'none'})`);
        }
      }
      const unsupported = knownUnsupportedReason(profile);
      if (unsupported) issues.push(unsupported);
      for (const rule of configKnownLimits(config)) {
        if (rule.provider !== profile.provider || !profile[rule.field]) continue;
        if (rule.model !== undefined && profile.model !== rule.model) continue;
        if (rule.pattern && !rule.pattern.test(profile.model)) continue;
        issues.push(rule.reason);
      }
      if (profile.mode && !(entry.modes ?? []).some((m) => m.id === profile.mode)) {
        issues.push(`mode "${profile.mode}" is not available for ${profile.provider} (available: ${(entry.modes ?? []).map((m) => m.id).join(', ')})`);
      }
    }
    if (issues.length) problems[name] = issues;
  }
  return problems;
}
