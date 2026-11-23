// Central factory configuration: loading, structural validation and validation
// against the live provider catalog. Roles never carry provider data; slots only
// reference a named profile, so a model change is a one-line config edit.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** --config > PASEO_FACTORY_CONFIG > $XDG_CONFIG_HOME/paseo-workspace-factory/config.json */
export function defaultConfigPath() {
  if (process.env.PASEO_FACTORY_CONFIG) return process.env.PASEO_FACTORY_CONFIG;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'paseo-workspace-factory', 'config.json');
}

/**
 * Settings the catalog advertises but a provider rejects when an agent is created.
 * Observed 2026-11-23: copilot/claude-sonnet-5.5 lists thinking options, yet
 * creation fails with "setReasoningEffort ... not supported".
 */
export const KNOWN_UNSUPPORTED = [
  { provider: 'copilot', model: /^claude-/, field: 'thinking', reason: 'Copilot rejects a reasoning effort for Claude models; use thinking: null' },
];
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

export async function loadConfig(path = defaultConfigPath()) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`No factory config at ${path}; copy config.example.json there or pass --config`);
    throw error;
  }
  const config = JSON.parse(text);
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`Invalid factory config ${path}:\n- ${errors.join('\n- ')}`);
  return config;
}

export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return ['config must be an object'];
  if (config.version !== 1) errors.push('version must be 1');
  if (!OWNER_PATTERN.test(config.github?.owner ?? '')) errors.push('github.owner must be a GitHub account name');
  if (!['https', 'ssh'].includes(config.github?.cloneProtocol)) errors.push('github.cloneProtocol must be https or ssh');
  if (!/^[A-Za-z0-9._-]+$/.test(config.github?.upstreamRemote ?? '')) errors.push('github.upstreamRemote must be a plain remote name');
  if (typeof config.checkoutRoot !== 'string' || !isAbsolute(config.checkoutRoot)) errors.push('checkoutRoot must be an absolute path');
  if (typeof config.workspaceTitle !== 'string' || !config.workspaceTitle.trim()) errors.push('workspaceTitle must be a non-empty string');

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
  if (config.handoffLanguage !== undefined && !['en', 'de'].includes(config.handoffLanguage)) errors.push('handoffLanguage must be "en" or "de"');
  const runtime = config.runtime ?? {};
  if (typeof runtime !== 'object') errors.push('runtime must be an object');
  for (const key of ['stateDir', 'scratchDir']) {
    if (runtime[key] !== undefined && (typeof runtime[key] !== 'string' || !runtime[key])) errors.push(`runtime.${key} must be a path`);
  }
  for (const key of ['url', 'bin', 'passwordFile']) {
    if (runtime.paseo?.[key] !== undefined && runtime.paseo[key] !== null && typeof runtime.paseo[key] !== 'string') errors.push(`runtime.paseo.${key} must be a string`);
  }
  if (config.workers?.defaultProfile && !profiles[config.workers.defaultProfile]) {
    errors.push(`workers.defaultProfile references unknown profile "${config.workers.defaultProfile}"`);
  }
  if (config.advisors !== undefined) {
    if (typeof config.advisors !== 'object' || config.advisors === null || Array.isArray(config.advisors)) errors.push('advisors must be an object');
    else {
      const advisorProfiles = config.advisors.profiles ?? {};
      if (typeof advisorProfiles !== 'object' || advisorProfiles === null || Array.isArray(advisorProfiles)) errors.push('advisors.profiles must be an object');
      else for (const [purpose, profile] of Object.entries(advisorProfiles)) {
        if (!purpose) errors.push('advisors.profiles has an empty purpose name');
        else if (!profiles[profile]) errors.push(`advisors.profiles.${purpose} references unknown profile "${profile}"`);
      }
    }
  }
  if (config.usage !== undefined) {
    if (typeof config.usage !== 'object' || config.usage === null || Array.isArray(config.usage)) errors.push('usage must be an object');
    else if (config.usage.warnContextTokens !== undefined && (!Number.isInteger(config.usage.warnContextTokens) || config.usage.warnContextTokens <= 0)) {
      errors.push('usage.warnContextTokens must be a positive integer');
    }
  }
  return errors;
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
      for (const rule of KNOWN_UNSUPPORTED) {
        if (rule.provider === profile.provider && rule.model.test(profile.model) && profile[rule.field]) issues.push(rule.reason);
      }
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
