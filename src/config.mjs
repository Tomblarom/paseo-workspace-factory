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
      if (profile.mode && !(entry.modes ?? []).some((m) => m.id === profile.mode)) {
        issues.push(`mode "${profile.mode}" is not available for ${profile.provider} (available: ${(entry.modes ?? []).map((m) => m.id).join(', ')})`);
      }
    }
    if (issues.length) problems[name] = issues;
  }
  return problems;
}
