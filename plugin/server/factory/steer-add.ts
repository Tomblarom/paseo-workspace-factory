// @ts-nocheck
// GENERATED from src/steer-add.mjs by npm run plugin:sync. Do not edit.
// Steer-add planning for the current scope: pure preview plus a retryable
// create operation. A preview writes no live config (it returns the new
// config object); apply creates the agent under a stable idempotency key and
// the caller persists the slot/profile config, so a retry converges instead
// of duplicating. Configured-but-unprovisioned slots (in steers.slots, no
// live agent) are provisionable; live-occupied slots refuse with a pointer
// to `steer set`/`fresh`. Live checks use exact label IDs and roles, never
// titles.
import { LABEL } from './paseo.js';
import { isAdvisorProfile, slotOrder, validateConfig } from './config.js';
import { buildCandidate, nextFreeSlot, parseProviderModel, resolveProfile, resolveSteerAdd } from './models.js';
import { QUOTA_DEFAULTS, bestFamilyAccount, earliestFamilyReset, familyAccounts, profileFamily } from './quota.js';
import { buildSteerCreate, checkedCreationReceipt, confirmCreationReceipt, lookupCreation, SteerPlacementError, verifySteerPlacement } from './steer-create.js';
import { suggestAccountPin } from './zerosub.js';

/**
 * Live steer agent for a slot in this scope, or null. Exact label match:
 * role exactly 'steer', slot exactly the uppercase letter, scope exactly the
 * scope id (wsf.scope wins, wsf.repo is the legacy fallback,
 * case-insensitive like discovery), never archived. Titles are ignored.
 */
export function liveSteerForSlot(liveSteers, slot, scopeId) {
  const want = typeof scopeId === 'string' ? scopeId.toLowerCase() : null;
  let fallback = null;
  for (const agent of liveSteers ?? []) {
    if (!agent || agent.archivedAt) continue;
    if (agent.labels?.[LABEL.role] !== 'steer') continue;
    if (agent.labels?.[LABEL.slot] !== slot) continue;
    if (want) {
      const scope = agent.labels?.[LABEL.scope];
      const repo = agent.labels?.[LABEL.repo];
      const scopeMatch = typeof scope === 'string' && scope.toLowerCase() === want;
      const repoMatch = typeof repo === 'string' && repo.toLowerCase() === want;
      if (!scopeMatch && !repoMatch) continue;
    }
    if (typeof agent.id !== 'string' || !agent.id) continue;
    // Same-slot newer-wins: a superseded older holder never shadows the
    // live one; it only counts when nothing else matches.
    if (agent.superseded === true) {
      fallback ??= agent;
      continue;
    }
    return agent;
  }
  return fallback;
}

/**
 * Slot state for steer-add: configured (in steers.slots) crossed with live
 * (a live steer agent with exact labels). `free` takes a new slot,
 * `configured-unprovisioned` is the retryable intermediate (config saved,
 * agent missing) and provisions on apply, `live-occupied` and
 * `live-unconfigured` refuse (the latter is drift: live without config).
 */
export function classifySteerSlot(config, liveSteers, slot, scopeId) {
  const configuredProfile = config?.steers?.slots?.[slot] ?? null;
  const configured = typeof configuredProfile === 'string' && Boolean(configuredProfile);
  const live = liveSteerForSlot(liveSteers, slot, scopeId);
  let state = 'free';
  if (configured && live) state = 'live-occupied';
  else if (configured && !live) state = 'configured-unprovisioned';
  else if (!configured && live) state = 'live-unconfigured';
  return { slot, configured, configuredProfile: configured ? configuredProfile : null, live, state };
}

/**
 * First free slot letter for steer-add: neither configured in
 * steers.slots nor live-occupied in this scope. Null when all A-Z are taken.
 */
export function nextFreeSlotForAdd(config, liveSteers, scopeId) {
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    if (classifySteerSlot(config, liveSteers, letter, scopeId).state === 'free') return letter;
  }
  return null;
}

function checkedTargetSlot(config, liveSteers, scopeId, slotInput) {
  if (slotInput === null || slotInput === undefined || String(slotInput).trim() === '') {
    const target = nextFreeSlotForAdd(config, liveSteers, scopeId);
    if (!target) throw new Error('No free steer slot: all letters A-Z are defined or occupied by a live steer');
    return { target, classification: classifySteerSlot(config, liveSteers, target, scopeId) };
  }
  const raw = String(slotInput).trim().toUpperCase();
  if (!/^[A-Z]$/.test(raw)) throw new Error(`Steer slot must be a single capital letter A-Z, got ${JSON.stringify(slotInput)}`);
  const classification = classifySteerSlot(config, liveSteers, raw, scopeId);
  if (classification.state === 'live-occupied') {
    throw new Error(`Slot ${raw} is already occupied by live steer ${classification.live.id} (profile "${classification.configuredProfile}"); use steer set ${raw} <profile|provider/model> to replace it or fresh to refresh its steer`);
  }
  if (classification.state === 'live-unconfigured') {
    const agent = classification.live;
    throw new Error(`Slot ${raw} is already occupied by live steer ${agent.id} (${agent.provider}/${agent.model}) without a configured slot; archive it in Paseo or define slot ${raw} via steer set ${raw} <profile|provider/model> first`);
  }
  if (classification.state === 'free') {
    // A gap means a still-free letter before the target. Live steers that are
    // not configured yet (adopted B, D, E) occupy their letters, so the next
    // free letter suggested by nextFreeSlotForAdd is always accepted.
    const gap = [];
    for (let code = 65; code < raw.charCodeAt(0); code++) {
      const letter = String.fromCharCode(code);
      if (classifySteerSlot(config, liveSteers, letter, scopeId).state === 'free') gap.push(letter);
    }
    if (gap.length) {
      const order = slotOrder(config);
      throw new Error(`Slot ${raw} would leave a gap (slots are ${order.join(', ') || 'none'}; free: ${gap.join(', ')}); use the next free letter ${nextFreeSlotForAdd(config, liveSteers, scopeId)}`);
    }
  }
  return { target: raw, classification };
}

function mapWarnReason(skipped, quotaWarnPct) {
  return (skipped ?? []).map((entry) => {
    const reason = entry?.reason;
    if (typeof reason === 'string' && reason.startsWith('accounts exhausted')) {
      const prefix = 'accounts exhausted, earliest reset ';
      const reset = reason.startsWith(prefix) ? reason.slice(prefix.length) : null;
      return { ...entry, reason: reset ? `accounts over warn threshold (≥${quotaWarnPct}%), earliest reset ${reset}` : `accounts over warn threshold (≥${quotaWarnPct}%)` };
    }
    return entry;
  });
}

function earliestResetAcross(config, mapped, zerosub, now) {
  let earliestReset = null;
  let bestMs = Infinity;
  for (const entry of mapped) {
    if (typeof entry?.reason !== 'string' || !entry.reason.startsWith('accounts over warn')) continue;
    const family = profileFamily(config?.profiles?.[entry.name]);
    if (!family) continue;
    const reset = earliestFamilyReset(zerosub, family, { now });
    const ms = reset ? Date.parse(reset) : NaN;
    if (Number.isFinite(ms) && ms > now && ms < bestMs) {
      bestMs = ms;
      earliestReset = reset;
    }
  }
  return earliestReset;
}

function resolveOneProfile(config, providerEntries, name, opts, quotaWarnPct, now, zerosub) {
  const { profile, skipped, zerosubAccount, zerosubPin } = resolveProfile(config, providerEntries, [name], {
    ...opts,
    zerosubExhaustedPct: quotaWarnPct,
  });
  const mapped = mapWarnReason(skipped, quotaWarnPct);
  const earliestReset = !profile && zerosub ? earliestResetAcross(config, mapped, zerosub, now) : null;
  return { profile, skipped: mapped, zerosubAccount, zerosubPin, earliestReset };
}

function candidateForProviderModel(config, profileName, provider, model, thinking, mode, providerEntries, notes) {
  const existing = config.profiles?.[profileName] ?? null;
  const candidate = buildCandidate(existing, provider, model, thinking, mode, { providerEntries, notes, profileName });
  return { candidate, existing };
}

function modelKeyWithTags(profile) {
  return JSON.stringify([profile?.provider ?? '', profile?.model ?? '', profile?.thinking ?? null, profile?.mode ?? null, profile?.advisor === true, profile?.sensitive === true]);
}

function findProfileByModelKey(profiles, key, exclude = null) {
  for (const [name, profile] of Object.entries(profiles ?? {})) {
    if (name === exclude) continue;
    if (modelKeyWithTags(profile) === key) return name;
  }
  return null;
}

/**
 * Pure steer-add plan for the current scope. `liveSteers` are the labelled
 * live agents (discovery.steers.labelled works); `scopeId`/`repo`/
 * `workspaceId` name the creation target. `spec` null auto-picks via
 * resolveSteerAdd slot-priority order; a profile name tries it alone; a
 * provider/model plans a profile (created or reused) and then selects it.
 * Returns the slot, profile selection (null when blocked, with skipped
 * reasons and earliestReset), the new config (unchanged when blocked), the
 * agent.create op (null when blocked), notes/warnings and the fingerprint
 * input. Throws on a bad slot, a live-occupied slot, a gap, a full A-Z, or
 * an unknown profile. A preview writes nothing; apply persists
 * `config` and runs `op` under its idempotency key.
 */
export function planSteerAdd(config, providerEntries, liveSteers, {
  slot = null, spec = null, thinking = undefined, mode = undefined, profile: profileOption = undefined,
  scopeId = null, workspaceId = null, repo = null,
  usedProfiles = [], quotaSnapshot = null, quotaExhaustedPct = config?.quota?.exhaustedPct ?? QUOTA_DEFAULTS.exhaustedPct,
  quotaWarnPct = config?.quota?.warnPct ?? QUOTA_DEFAULTS.warnPct, profileHealth = null, now = Date.now(), zerosub = null,
} = {}) {
  const { target, classification } = checkedTargetSlot(config, liveSteers, scopeId, slot);
  const notes = [];
  const warnings = [];
  const effectiveScope = scopeId ?? repo ?? null;
  const effectiveRepo = repo ?? scopeId ?? null;

  const specText = spec === null || spec === undefined ? '' : String(spec).trim();
  const isProviderModel = specText.includes('/');

  let profileName = null;
  let picked = null;
  let skipped = [];
  let zerosubAccount = null;
  let zerosubPin = null;
  let earliestReset = null;
  let advisorSlot = false;
  let candidate = null;
  let candidateProfileName = null;

  if (!specText) {
    if (classification.state === 'configured-unprovisioned') {
      const name = classification.configuredProfile;
      advisorSlot = isAdvisorProfile(config, name);
      const resolved = resolveOneProfile(config, providerEntries, name, {
        role: 'steer', advisorSlot, usedProfiles, quotaSnapshot, quotaExhaustedPct, profileHealth, now, zerosub,
      }, quotaWarnPct, now, zerosub);
      picked = resolved.profile;
      skipped = resolved.skipped;
      zerosubAccount = resolved.zerosubAccount;
      zerosubPin = resolved.zerosubPin;
      earliestReset = resolved.earliestReset;
      profileName = name;
      notes.push(`Slot ${target} is configured but has no live steer; provisioning profile "${name}"`);
    } else {
      const resolved = resolveSteerAdd(config, providerEntries, {
        slot: target, usedProfiles, quotaSnapshot, quotaExhaustedPct, quotaWarnPct, profileHealth, now, zerosub, allowGap: true,
      });
      picked = resolved.profile;
      skipped = resolved.skipped;
      zerosubAccount = resolved.zerosubAccount;
      zerosubPin = resolved.zerosubPin;
      earliestReset = resolved.earliestReset;
      advisorSlot = resolved.advisorSlot;
      profileName = picked?.name ?? null;
    }
  } else if (!isProviderModel) {
    const name = specText;
    if (!config?.profiles?.[name]) throw new Error(`Unknown profile "${name}"`);
    advisorSlot = isAdvisorProfile(config, name);
    profileName = name;
    if (classification.state === 'configured-unprovisioned' && classification.configuredProfile !== name) {
      notes.push(`Slot ${target} is configured with "${classification.configuredProfile}" but has no live steer; switching it to "${name}"`);
    } else if (classification.state === 'configured-unprovisioned') {
      notes.push(`Slot ${target} is configured but has no live steer; provisioning profile "${name}"`);
    }
    const resolved = resolveOneProfile(config, providerEntries, name, {
      role: 'steer', advisorSlot, usedProfiles, quotaSnapshot, quotaExhaustedPct, profileHealth, now, zerosub,
    }, quotaWarnPct, now, zerosub);
    picked = resolved.profile;
    skipped = resolved.skipped;
    zerosubAccount = resolved.zerosubAccount;
    zerosubPin = resolved.zerosubPin;
    earliestReset = resolved.earliestReset;
  } else {
    const { provider, model } = parseProviderModel(specText);
    let name;
    if (profileOption !== undefined && profileOption !== null) {
      name = String(profileOption).trim();
      if (!name) throw new Error('--profile must be a non-empty name');
    } else if (classification.state === 'configured-unprovisioned') {
      name = classification.configuredProfile;
    } else {
      name = `${provider}-${model}`;
    }
    const { candidate: built, existing } = candidateForProviderModel(config, name, provider, model, thinking, mode, providerEntries, notes);
    if (!existing) {
      const assumed = { provider: built.provider, model: built.model, thinking: built.thinking ?? null, mode: built.mode ?? null, advisor: false };
      const merged = findProfileByModelKey(config.profiles, modelKeyWithTags(assumed));
      if (merged) {
        notes.push(`Reusing existing profile "${merged}" (identical model, no new profile created)`);
        name = merged;
      } else {
        candidate = built;
        candidateProfileName = name;
      }
    } else if (modelKeyWithTags(existing) !== modelKeyWithTags(built)) {
      const other = findProfileByModelKey(config.profiles, modelKeyWithTags(built), name);
      if (other) {
        notes.push(`Profile "${name}" not changed: identical model already exists as "${other}", slot ${target} points there`);
        name = other;
      } else {
        candidate = built;
        candidateProfileName = name;
        notes.push(`Profile "${name}" updated in place`);
      }
    }
    profileName = name;
    const withCandidate = candidate ? { ...config, profiles: { ...config.profiles, [candidateProfileName]: candidate } } : config;
    advisorSlot = isAdvisorProfile(withCandidate, name);
    const resolved = resolveOneProfile(withCandidate, providerEntries, name, {
      role: 'steer', advisorSlot, usedProfiles, quotaSnapshot, quotaExhaustedPct, profileHealth, now, zerosub,
    }, quotaWarnPct, now, zerosub);
    picked = resolved.profile;
    skipped = resolved.skipped;
    zerosubAccount = resolved.zerosubAccount;
    zerosubPin = resolved.zerosubPin;
    earliestReset = resolved.earliestReset;
    if (classification.state === 'configured-unprovisioned' && classification.configuredProfile !== name) {
      notes.push(`Slot ${target} is configured with "${classification.configuredProfile}" but has no live steer; switching it to "${name}"`);
    } else if (classification.state === 'configured-unprovisioned') {
      notes.push(`Slot ${target} is configured but has no live steer; provisioning profile "${name}"`);
    }
  }

  if (!picked) {
    return {
      slot: target, advisorSlot, profile: null, profileName: null, skipped, zerosubAccount: null, zerosubPin: null, earliestReset,
      config, isNewSlot: classification.state === 'free', isNewProfile: false, before: slotList(config), after: slotList(config),
      summary: `steer add ${target}: blocked (no startable profile)`, notes, warnings, op: null, fingerprintInput: null,
    };
  }

  const next = structuredClone(config);
  let isNewProfile = false;
  if (candidate && candidateProfileName) {
    const existed = Boolean(config.profiles?.[candidateProfileName]);
    next.profiles[candidateProfileName] = candidate;
    isNewProfile = !existed;
  }
  const before = slotList(config);
  next.steers.slots[target] = profileName;
  const errors = validateConfig(next);
  if (errors.length) throw new Error(`Invalid config after change:\n- ${errors.join('\n- ')}`);
  const after = slotList(next);
  if (advisorSlot) notes.push(`Steer ${target} uses advisor profile "${profileName}" (advisor, never active)`);

  const effective = { name: picked.name, provider: picked.provider, model: picked.model, thinking: picked.thinking ?? null, mode: picked.mode ?? null };
  const { request, idempotencyKey: key } = buildSteerCreate({
    keyScope: effectiveRepo ?? effectiveScope ?? 'scope', repo: effectiveRepo ?? effectiveScope ?? '?',
    scopeId: effectiveScope ?? effectiveRepo ?? '?', slot: target, workspaceId: workspaceId ?? '?',
    profile: effective, keyParts: ['steer', target, 'g1'],
    metadata: zerosubPin ? zerosubPin.metadata : null, accountId: zerosubAccount,
  });
  const op = {
    key: `steer.${target}`, kind: 'paseo.agent.create',
    summary: `Create top-level Steer ${target} (${effective.provider}/${effective.model}) without prompt`,
    params: { ...request, idempotencyKey: key },
  };
  const detail = `${effective.provider}/${effective.model}`
    + (effective.thinking ? ` thinking ${effective.thinking}` : '')
    + (effective.mode ? ` mode ${effective.mode}` : '');
  const summary = `steer slots: [${before.join(', ')}] → [${after.join(', ')}] (${target} → "${profileName}" ${detail})`;
  const fingerprintInput = {
    kind: 'factory.steer.add', scope: effectiveScope, repo: effectiveRepo, workspaceId: workspaceId ?? null,
    slot: target, profile: profileName, provider: effective.provider, model: effective.model,
    thinking: effective.thinking, mode: effective.mode, account: zerosubAccount, advisor: advisorSlot,
  };
  return {
    slot: target, advisorSlot, profile: picked, profileName, skipped, zerosubAccount, zerosubPin, earliestReset,
    config: next, isNewSlot: classification.state === 'free', isNewProfile, before, after,
    summary, notes, warnings, op, fingerprintInput,
  };
}

function slotList(config) {
  return slotOrder(config).map((slot) => `${slot}:${config.steers.slots[slot]}`);
}

/**
 * Human-readable preview text for a steer-add plan (no writes). Blocked
 * plans name every skipped profile and the earliest reset when known.
 */
export function formatSteerAddPreview(plan, { scopeId = null } = {}) {
  const lines = [];
  const scope = scopeId ?? plan?.fingerprintInput?.scope ?? plan?.fingerprintInput?.repo ?? '?';
  if (!plan?.profile) {
    lines.push(`Steer add ${plan.slot} for ${scope}: blocked, no startable profile.`);
    for (const entry of plan.skipped ?? []) lines.push(`- "${entry.name}": ${entry.reason}`);
    if (plan.earliestReset) lines.push(`Earliest reset: ${plan.earliestReset}`);
    lines.push('Nothing written. Resolve the blockers and preview again.');
    return lines.join('\n');
  }
  lines.push(`Steer add ${plan.slot} for ${scope}: ${plan.profile.provider}/${plan.profile.model} (profile "${plan.profileName}")`);
  lines.push(plan.summary);
  if (plan.zerosubAccount) lines.push(`ZeroSub account: ${plan.zerosubAccount}`);
  for (const entry of plan.skipped ?? []) lines.push(`Skipped "${entry.name}": ${entry.reason}`);
  if (plan.earliestReset) lines.push(`Earliest reset: ${plan.earliestReset}`);
  for (const note of plan.notes ?? []) lines.push(`Note: ${note}`);
  for (const warning of plan.warnings ?? []) lines.push(`Warning: ${warning}`);
  lines.push(`Op: ${plan.op.summary} [${plan.op.params.idempotencyKey}]`);
  lines.push('Nothing written. Confirm to save the slot/profile config and create the steer.');
  return lines.join('\n');
}

/**
 * Next free slot suggestion for help text: the config-only suggestion
 * (resolveSteerAdd throws with it on gaps) widened to live occupancy.
 */
export function suggestSteerAddSlot(config, liveSteers, scopeId) {
  return nextFreeSlotForAdd(config, liveSteers, scopeId) ?? nextFreeSlot(config);
}

/** The confirmed preview no longer matches fresh state; re-preview. */
export class SteerAddStale extends Error {}
/** The slot is taken by another request; use steer set/fresh. */
export class SteerAddConflict extends Error {}
/** Creation cannot be verified; check manually, then retry. */
export class SteerAddRecovery extends Error {}

const addRecoveryFail = (message) => new SteerAddRecovery(`Steer add recovery stopped: ${message}`);
// A missing lookup is unreachable here: applySteerAdd refuses first unless
// both a receipt lookup and an executor are passed.
const addLookupFail = (message) => new SteerAddRecovery(`Steer add recovery stopped: the ${message}`);

function occupiedError(slot, classification) {
  if (classification.state === 'live-unconfigured') {
    const agent = classification.live;
    return new SteerAddConflict(`Slot ${slot} is already occupied by live steer ${agent.id} (${agent.provider}/${agent.model}) without a configured slot; archive it in Paseo or define slot ${slot} via steer set ${slot} <profile|provider/model> first`);
  }
  return new SteerAddConflict(`Slot ${slot} is already occupied by live steer ${classification.live.id} (profile "${classification.configuredProfile}"); use steer set ${slot} <profile|provider/model> to replace it or fresh to refresh its steer`);
}

function staleError() {
  return new SteerAddStale('Something changed since the steer-add preview (for example a slot, profile or quota state). Run /factory steer add again and confirm the new preview.');
}

function blockedError(plan) {
  const tried = (plan.skipped ?? []).map((s) => `"${s.name}" (${s.reason})`).join('; ') || 'no profiles available';
  return new SteerAddRecovery(`Steer add ${plan.slot} is blocked, no startable profile (tried ${tried})${plan.earliestReset ? `, earliest reset ${plan.earliestReset}` : ''}. Resolve the blockers and preview again.`);
}

/**
 * Applies a confirmed steer-add preview: re-plans from fresh state, refuses
 * the write when the fingerprint no longer matches (stale preview or
 * configuration change), then creates the steer under the plan's stable
 * idempotency key. Same-request retries are safe at every step: after the
 * settings save the slot is configured-unprovisioned and provisions with the
 * same key; after the creation the daemon receipt (or the matching live
 * steer) is reused instead of creating a duplicate. A live slot from another
 * request stays a conflict pointing at `steer set`/`fresh`.
 *
 * `fingerprintOf` is the fingerprint function (the plugin passes
 * steerAddFingerprint); `lookupReceipt`/`execute` are the creation receipt
 * lookup and the op executor. Returns
 * `{ scope, slot, agentId, profile, provider, model, account, applied,
 * reused, text }`.
 */
export async function applySteerAdd(config, providerEntries, liveSteers, {
  slot = null, spec = null, thinking = undefined, mode = undefined, profile: profileOption = undefined,
  scopeId = null, workspaceId = null, repo = null, fingerprint = null,
  fingerprintOf = null, usedProfiles = [], quotaSnapshot = null,
  quotaExhaustedPct = config?.quota?.exhaustedPct ?? QUOTA_DEFAULTS.exhaustedPct, quotaWarnPct = config?.quota?.warnPct ?? QUOTA_DEFAULTS.warnPct,
  profileHealth = null, now = Date.now(), zerosub = null, lookupReceipt = null, execute = null,
} = {}) {
  if (typeof fingerprint !== 'string' || !fingerprint) throw new SteerAddStale('Steer add needs the fingerprint of a confirmed preview.');
  if (typeof fingerprintOf !== 'function') throw new Error('Steer add needs a fingerprint function.');
  if (typeof lookupReceipt !== 'function' || typeof execute !== 'function') {
    throw new SteerAddRecovery('Steer add needs a receipt lookup and an executor; refusing to create without a receipt.');
  }
  const planArgs = {
    slot, spec, thinking, mode, profile: profileOption, scopeId, workspaceId, repo,
    usedProfiles, quotaSnapshot, quotaExhaustedPct, quotaWarnPct, profileHealth, now, zerosub,
  };
  const raw = slot === null || slot === undefined || String(slot).trim() === ''
    ? nextFreeSlotForAdd(config, liveSteers, scopeId)
    : String(slot).trim().toUpperCase();
  const classification = raw ? classifySteerSlot(config, liveSteers, raw, scopeId) : null;
  if (classification && (classification.state === 'live-occupied' || classification.state === 'live-unconfigured')) {
    return recoverOccupiedSlot(config, providerEntries, liveSteers, planArgs, classification, fingerprint, fingerprintOf, lookupReceipt, execute);
  }
  let plan;
  try {
    plan = planSteerAdd(config, providerEntries, liveSteers, planArgs);
  } catch (error) {
    throw new SteerAddStale(`Something changed since the steer-add preview (${error.message}). Run /factory steer add again and confirm the new preview.`);
  }
  if (!plan.profile) throw blockedError(plan);
  if (fingerprintOf(plan.fingerprintInput) !== fingerprint) throw staleError();
  return createWithReceipt(plan, lookupReceipt, execute, scopeId ?? repo);
}

async function recoverOccupiedSlot(config, providerEntries, liveSteers, planArgs, classification, fingerprint, fingerprintOf, lookupReceipt, execute) {
  const occupant = classification.live;
  const rest = (liveSteers ?? []).filter((a) => a?.id !== occupant.id);
  let plan;
  try {
    plan = planSteerAdd(config, providerEntries, rest, { ...planArgs, slot: classification.slot });
  } catch {
    throw occupiedError(classification.slot, classification);
  }
  if (!plan.profile || fingerprintOf(plan.fingerprintInput) !== fingerprint) {
    throw occupiedError(classification.slot, classification);
  }
  const key = plan.op.params.idempotencyKey;
  const receipt = await lookupCreation(lookupReceipt, 'agent', key, addLookupFail);
  if (receipt) {
    const receiptAgentId = checkedCreationReceipt(receipt, key, addRecoveryFail);
    if (receiptAgentId !== occupant.id) {
      throw new SteerAddRecovery(`Steer add recovery stopped: the receipt names ${receiptAgentId} but ${occupant.id} is live; check manually and archive the spare steer in Paseo`);
    }
    return finishApplied(plan, occupant.id, { reused: true, scopeId: planArgs.scopeId ?? planArgs.repo, note: 'reused after receipt' });
  }
  // A live occupant from our own request converges without a receipt; a
  // foreign one (other scope labels or model) stays a conflict. Workspace and
  // parent are not adjudicated here, as before.
  try {
    verifySteerPlacement(occupant, { labels: plan.op.params.labels, provider: plan.profile.provider, model: plan.profile.model });
  } catch (error) {
    if (error instanceof SteerPlacementError) throw occupiedError(classification.slot, classification);
    throw error;
  }
  return finishApplied(plan, occupant.id, { reused: false, scopeId: planArgs.scopeId ?? planArgs.repo, note: 'already provisioned' });
}

async function createWithReceipt(plan, lookupReceipt, execute, scope) {
  const key = plan.op.params.idempotencyKey;
  const receipt = await lookupCreation(lookupReceipt, 'agent', key, addLookupFail);
  if (!receipt) {
    const created = await execute(plan.op, undefined);
    const agentId = created?.agentId;
    if (!agentId) throw new SteerAddRecovery('Steer add creation returned no agent id');
    return finishApplied(plan, agentId, { reused: false, scopeId: scope });
  }
  const receiptAgentId = checkedCreationReceipt(receipt, key, addRecoveryFail);
  const { id } = await confirmCreationReceipt(execute, plan.op, undefined, receiptAgentId, addRecoveryFail);
  return finishApplied(plan, id, { reused: true, scopeId: scope, note: 'reused after receipt' });
}

function finishApplied(plan, agentId, { reused, scopeId, note = null }) {
  const text = [
    `Steer ${plan.slot} created: agent ${agentId} (profile "${plan.profileName}" ${plan.profile.provider}/${plan.profile.model})`,
    plan.zerosubAccount ? `ZeroSub account ${plan.zerosubAccount}` : null,
    note,
  ].filter(Boolean).join(' · ') + '.';
  return {
    scope: scopeId ?? plan.fingerprintInput.scope ?? plan.fingerprintInput.repo,
    slot: plan.slot, agentId, profile: plan.profileName,
    provider: plan.profile.provider, model: plan.profile.model,
    account: plan.zerosubAccount, applied: true, reused, text,
  };
}
