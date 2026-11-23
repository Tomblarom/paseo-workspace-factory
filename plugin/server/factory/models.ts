// @ts-nocheck
// GENERATED from src/models.mjs by npm run plugin:sync. Do not edit.
// Model catalog listing and config editing for steer slots and workers.
// Validation reuses validateProfilesAgainstCatalog() from config.mjs, the same
// check the planner runs (live catalog shape plus knownLimits).
import { chmod, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { SLOT_PATTERN, validateConfig, validateProfilesAgainstCatalog } from './config.js';

/** Split "<provider>/<model>" (model may itself contain "/"). */
export function parseProviderModel(spec) {
  if (typeof spec !== 'string' || !spec) throw new Error(`Expected <provider>/<model>, got ${JSON.stringify(spec)}`);
  const slash = spec.indexOf('/');
  if (slash <= 0 || slash === spec.length - 1) throw new Error(`Expected <provider>/<model>, got "${spec}"`);
  const provider = spec.slice(0, slash).trim();
  const model = spec.slice(slash + 1).trim();
  if (!provider || !model) throw new Error(`Expected <provider>/<model>, got "${spec}"`);
  return { provider, model };
}

/** CLI flag value: undefined keeps the stored value, "null"/"" means explicit null. */
export function flagValue(value) {
  if (value === undefined) return undefined;
  if (value === 'null' || value === '') return null;
  return value;
}

/** Human-readable catalog listing, or JSON with { json: true }. */
export function formatCatalog(providerEntries, { json = false } = {}) {
  const entries = providerEntries ?? [];
  if (json) return JSON.stringify(entries, null, 2);
  const lines = [];
  for (const entry of entries) {
    lines.push(`${entry.provider} ${entry.status ?? 'unknown'} (${entry.enabled ? 'enabled' : 'disabled'})`);
    const modes = (entry.modes ?? []).map((m) => m.id).filter(Boolean);
    lines.push(`  modes: ${modes.join(', ') || 'none'}`);
    const models = entry.models ?? [];
    if (!models.length) lines.push('  (no models)');
    for (const model of models) {
      const thinking = (model.thinkingOptions ?? []).map((t) => t.id).filter(Boolean);
      lines.push(`  ${model.id} thinking: ${thinking.join(', ') || 'none'}`);
    }
  }
  return lines.join('\n');
}

function resolveProfileName(config, slot, provider, model, profileOption) {
  if (profileOption !== undefined && profileOption !== null) {
    const name = String(profileOption).trim();
    if (!name) throw new Error('--profile must be a non-empty name');
    return name;
  }
  if (slot && config.steers?.slots?.[slot]) return config.steers.slots[slot];
  return `${provider}-${model}`;
}

function buildCandidate(existing, provider, model, thinking, mode) {
  const candidate = { provider, model };
  if (thinking !== undefined) candidate.thinking = thinking;
  else if (existing && 'thinking' in existing) candidate.thinking = existing.thinking;
  else if (!existing) candidate.thinking = null;
  if (mode !== undefined) candidate.mode = mode;
  else if (existing && 'mode' in existing) candidate.mode = existing.mode;
  return candidate;
}

function checkedConfig(next) {
  const errors = validateConfig(next);
  if (errors.length) throw new Error(`Invalid config after change:\n- ${errors.join('\n- ')}`);
  return next;
}

function requireStartable(config, providerEntries, profileName) {
  const problems = validateProfilesAgainstCatalog(config, providerEntries, [profileName]);
  if (problems[profileName]) throw new Error(`Profile "${profileName}" is not startable: ${problems[profileName].join('; ')}`);
}

/**
 * Plan `slot set`: create or update a profile and point the slot at it.
 * thinking/mode use flagValue() semantics (undefined keeps the stored value).
 */
export function planSlotSet(config, providerEntries, { slot, provider, model, thinking, mode, profile }) {
  if (!SLOT_PATTERN.test(slot ?? '')) throw new Error(`Slot must be a single capital letter A-Z, got ${JSON.stringify(slot)}`);
  if (!provider || !model) throw new Error('slot set needs <provider>/<model>');
  const profileName = resolveProfileName(config, slot, provider, model, profile);
  const candidate = buildCandidate(config.profiles?.[profileName], provider, model, thinking, mode);
  requireStartable({ ...config, profiles: { ...config.profiles, [profileName]: candidate } }, providerEntries, profileName);
  const next = structuredClone(config);
  next.profiles[profileName] = candidate;
  next.steers.slots[slot] = profileName;
  checkedConfig(next);
  const detail = `${provider}/${model}`
    + (candidate.thinking ? ` thinking ${candidate.thinking}` : '')
    + (candidate.mode ? ` mode ${candidate.mode}` : '');
  return {
    config: next,
    profileName,
    summary: `Slot ${slot} → profile "${profileName}" (${detail})`,
    hint: 'Existing steers are unchanged; the next plan will report the difference.',
  };
}

/** Plan `slot rm`: drop the slot, keep its profile, repair prepare/initialActive. */
export function planSlotRemove(config, slot) {
  if (!SLOT_PATTERN.test(slot ?? '')) throw new Error(`Slot must be a single capital letter A-Z, got ${JSON.stringify(slot)}`);
  const slots = config.steers?.slots ?? {};
  if (!slots[slot]) throw new Error(`Slot ${slot} is not defined in steers.slots`);
  if (Object.keys(slots).length === 1) throw new Error(`Cannot remove slot ${slot}: at least one slot must remain`);
  const next = structuredClone(config);
  const removedProfile = next.steers.slots[slot];
  delete next.steers.slots[slot];
  next.steers.prepare = (next.steers.prepare ?? []).filter((s) => s !== slot);
  if (!next.steers.prepare.length) next.steers.prepare = [Object.keys(next.steers.slots).sort()[0]];
  if (next.steers.initialActive === slot) next.steers.initialActive = next.steers.prepare[0];
  checkedConfig(next);
  return { config: next, summary: `Slot ${slot} removed (profile "${removedProfile}" kept)` };
}

/**
 * Plan `worker-default`: either point at an existing profile, or create/update
 * a profile from <provider>/<model> first. The profile form takes no
 * --thinking/--mode/--profile.
 */
export function planWorkerDefault(config, providerEntries, { spec, thinking, mode, profile }) {
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('worker-default needs <profile|provider/model>');
  const trimmed = spec.trim();
  let profileName;
  let candidate = null;
  if (trimmed.includes('/')) {
    const { provider, model } = parseProviderModel(trimmed);
    profileName = resolveProfileName(config, null, provider, model, profile);
    candidate = buildCandidate(config.profiles?.[profileName], provider, model, thinking, mode);
    requireStartable({ ...config, profiles: { ...config.profiles, [profileName]: candidate } }, providerEntries, profileName);
  } else {
    profileName = trimmed;
    if (thinking !== undefined || mode !== undefined || (profile !== undefined && profile !== null)) {
      throw new Error('worker-default <profile> takes no --thinking/--mode/--profile; use worker-default <provider/model> to change a profile');
    }
    if (!config.profiles?.[profileName]) throw new Error(`Unknown profile "${profileName}"`);
    requireStartable(config, providerEntries, profileName);
  }
  const next = structuredClone(config);
  if (candidate) next.profiles[profileName] = candidate;
  next.workers = next.workers ?? {};
  next.workers.defaultProfile = profileName;
  checkedConfig(next);
  return { config: next, profileName, summary: `workers.defaultProfile → "${profileName}"` };
}

/** File text for a config object (also used for --dry-run previews). */
export function previewConfig(newConfig) {
  return `${JSON.stringify(newConfig, null, 2)}\n`;
}

/** Atomically replace the config file (tmp + rename), keeping its mode. */
export async function writeConfigAtomic(configPath, newConfig) {
  const text = previewConfig(newConfig);
  let mode = 0o600;
  try {
    mode = (await stat(configPath)).mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const tmp = `${configPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmp, text, { mode });
    await chmod(tmp, mode);
    await rename(tmp, configPath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return configPath;
}
