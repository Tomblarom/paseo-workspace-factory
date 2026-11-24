// Model catalog listing and config editing for steer slots and workers.
// Validation reuses validateProfilesAgainstCatalog() from config.mjs, the same
// check the planner runs (live catalog shape plus knownLimits).
import { chmod, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { SLOT_PATTERN, isAdvisorProfile, isAdvisorSlot, isSensitiveProfile, slotOrder, validateConfig, validateProfilesAgainstCatalog, workerPriority } from './config.mjs';
import { profileIsUnhealthy, quotaExhausted, profilePool, profileFamily, familyAccounts, familyExhausted, bestFamilyAccount, earliestFamilyReset } from './quota.mjs';

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

/**
 * Fallback order for steer slot S: its own profile first, then the profiles
 * of the following slots, then the previous ones (slot order, deduplicated).
 */
export function steerFallbackList(config, slot) {
  const order = slotOrder(config);
  const index = order.indexOf(slot);
  if (index === -1) return [];
  const names = [];
  for (const s of [...order.slice(index), ...order.slice(0, index)]) {
    const name = config.steers.slots[s];
    if (typeof name === 'string' && name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Profile names whose provider/model match a live steer (fallback duplicate avoidance). */
export function usedProfilesByLiveSteers(config, steers) {
  const byPair = new Map();
  for (const [name, p] of Object.entries(config?.profiles ?? {})) {
    if (p && typeof p.provider === 'string' && typeof p.model === 'string') {
      const key = `${p.provider}\n${p.model}`;
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key).push(name);
    }
  }
  const used = new Set();
  for (const s of steers ?? []) {
    if (!s || s.archivedAt) continue;
    for (const name of byPair.get(`${s.provider}\n${s.model}`) ?? []) used.add(name);
  }
  return [...used];
}

/**
 * First startable profile of `list` for `role`: passes the catalog check and
 * matches the role. Workers always skip advisor profiles, plus sensitive
 * profiles when the repo is not provably public (`repoPublic !== true`).
 * Steers take only advisor profiles in advisor slots and only non-advisor
 * ones elsewhere; sensitive steer profiles are never blocked. Fallback
 * entries (past the first) already used by a live steer are skipped, so no
 * two steers share a model by accident. Returns
 * `{ profile: { name, ...settings } | null, skipped: [{ name, reason }],
 * zerosubAccount: <id|null> }`. With `zerosub` (normalized ZeroSub state), a
 * profile whose family has accounts is judged by those accounts instead of the
 * usage snapshot: all accounts exhausted skips it (reason names the earliest
 * reset when known), otherwise the roomiest account id is reported.
 */
export function resolveProfile(config, providerEntries, list, { role = 'worker', advisorSlot = false, usedProfiles = [], repoPublic = null, quotaSnapshot = null, quotaExhaustedPct = config?.quota?.exhaustedPct ?? 90, profileHealth = null, now = Date.now(), zerosub = null } = {}) {
  const skipped = [];
  const used = new Set(usedProfiles ?? []);
  const names = Array.isArray(list) ? list : [];
  for (const [index, name] of names.entries()) {
    if (typeof name !== 'string' || !config?.profiles?.[name]) {
      skipped.push({ name, reason: `unknown profile ${JSON.stringify(name)}` });
      continue;
    }
    const advisor = isAdvisorProfile(config, name);
    if (profileIsUnhealthy(profileHealth, name, now)) {
      skipped.push({ name, reason: `recently failed: ${profileHealth[name].class ?? 'other'}` });
      continue;
    }
    const family = profileFamily(config.profiles[name]);
    if (zerosub && familyAccounts(zerosub, family).length) {
      if (familyExhausted(zerosub, family, { exhaustedPct: quotaExhaustedPct, now })) {
        const reset = earliestFamilyReset(zerosub, family, { now });
        skipped.push({ name, reason: reset ? `accounts exhausted, earliest reset ${reset}` : 'accounts exhausted' });
        continue;
      }
    } else {
      const pool = profilePool(config.profiles[name]);
      if (quotaExhausted(quotaSnapshot, pool, quotaExhaustedPct, now)) {
        skipped.push({ name, reason: 'pool exhausted' });
        continue;
      }
    }
    if (role === 'worker' && advisor) {
      skipped.push({ name, reason: `profile "${name}" is tagged as advisor` });
      continue;
    }
    if (role === 'worker' && repoPublic !== true && isSensitiveProfile(config, name)) {
      skipped.push({ name, reason: `sensitive profile "${name}": private repo` });
      continue;
    }
    if (role === 'steer') {
      if (advisorSlot && !advisor) {
        skipped.push({ name, reason: `profile "${name}" is not tagged as advisor` });
        continue;
      }
      if (!advisorSlot && advisor) {
        skipped.push({ name, reason: `profile "${name}" is tagged as advisor` });
        continue;
      }
      if (index > 0 && used.has(name)) {
        skipped.push({ name, reason: `profile "${name}" is already used by a live steer` });
        continue;
      }
    }
    const problems = validateProfilesAgainstCatalog(config, providerEntries, [name]);
    if (problems[name]) {
      skipped.push({ name, reason: problems[name].join('; ') });
      continue;
    }
    const account = zerosub ? bestFamilyAccount(zerosub, family, { exhaustedPct: quotaExhaustedPct, now }) : null;
    return { profile: { name, ...config.profiles[name] }, skipped, zerosubAccount: account ? account.id : null };
  }
  return { profile: null, skipped, zerosubAccount: null };
}

/** `paseo run` flags for a resolved profile. */
export function paseoRunFlags(profile) {
  const quote = (v) => (/[\s"']/.test(v) ? JSON.stringify(v) : v);
  const flags = ['--provider', quote(profile.provider), '--model', quote(profile.model)];
  if (profile.thinking) flags.push('--thinking', quote(profile.thinking));
  if (profile.mode) flags.push('--mode', quote(profile.mode));
  return flags.join(' ');
}

/**
 * Brief/handoff line for the worker model, e.g.
 * `Worker model: muse/m-1 (mode allowAll) - start workers with
 * `paseo-factory worker pick`` plus a sensitive suffix when the profile is
 * sensitive. Pass the string into brief/handoff builders (they stay pure).
 */
export function formatWorkerModel(config, profile, { factoryCmd = 'paseo-factory' } = {}) {
  let line = `Worker model: ${profile.provider}/${profile.model} (mode ${profile.mode ?? 'default'}) - start workers with \`${factoryCmd} worker pick\``;
  if (isSensitiveProfile(config, profile.name)) line += ' [sensitive: give only sanitized technical tasks]';
  return line;
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
  if (existing?.pool !== undefined) candidate.pool = existing.pool;
  if (thinking !== undefined) candidate.thinking = thinking;
  else if (existing && 'thinking' in existing) candidate.thinking = existing.thinking;
  else if (!existing) candidate.thinking = null;
  if (mode !== undefined) candidate.mode = mode;
  else if (existing && 'mode' in existing) candidate.mode = existing.mode;
  if (existing && existing.advisor !== undefined) candidate.advisor = existing.advisor;
  if (existing && existing.sensitive !== undefined) candidate.sensitive = existing.sensitive;
  return candidate;
}

function checkedConfig(next) {
  const errors = validateConfig(next);
  if (errors.length) throw new Error(`Invalid config after change:\n- ${errors.join('\n- ')}`);
  return next;
}

/** Catalog problems for one profile as warnings (stored anyway, fallback skips it). */
function startableWarnings(config, providerEntries, profileName) {
  const problems = validateProfilesAgainstCatalog(config, providerEntries, [profileName]);
  return (problems[profileName] ?? []).map((reason) => `Profile "${profileName}" is not startable now (${reason}); stored anyway, fallback will skip it`);
}

/** Identity of a model for dedup: provider/model/thinking/mode, tag-aware when merging profiles. */
function modelKey(profile, { withTags = false } = {}) {
  const base = [profile?.provider ?? '', profile?.model ?? '', profile?.thinking ?? null, profile?.mode ?? null];
  if (withTags) base.push(profile?.advisor === true, isSensitiveExplicit(profile));
  return JSON.stringify(base);
}

function isSensitiveExplicit(profile) {
  return profile?.sensitive === true;
}

function findProfileByKey(profiles, key, { exclude = null, withTags = false } = {}) {
  for (const [name, profile] of Object.entries(profiles ?? {})) {
    if (name === exclude) continue;
    if (modelKey(profile, { withTags }) === key) return name;
  }
  return null;
}

/** Notes other profiles with the same provider/model but different thinking/mode. */
function samePairNotes(config, provider, model, profileName) {
  const others = Object.entries(config.profiles ?? {})
    .filter(([name, p]) => name !== profileName && p?.provider === provider && p?.model === model)
    .map(([name]) => name);
  return others.length ? [`Other profiles use the same provider/model with different thinking/mode: ${others.join(', ')}`] : [];
}

/** Warns when an edited profile is shared beyond the edited entry. */
function sharedProfileWarnings(config, profileName, { steerSlot = null, workerEntry = false } = {}) {
  const warnings = [];
  const slots = Object.entries(config.steers?.slots ?? {}).filter(([slot, name]) => name === profileName && slot !== steerSlot).map(([slot]) => slot);
  if (slots.length) warnings.push(`Profile "${profileName}" is also used by steer slot${slots.length > 1 ? 's' : ''} ${slots.join(', ')}; those steers keep running until plan/fresh`);
  if (!workerEntry && workerPriority(config).includes(profileName)) {
    warnings.push(`Profile "${profileName}" is also in workers.priority; future workers use the new model`);
  }
  return warnings;
}

function checkPosition(n, what) {
  const position = typeof n === 'string' && /^\d+$/.test(n.trim()) ? Number(n.trim()) : n;
  if (!Number.isInteger(position) || position < 1) throw new Error(`${what} needs a position ≥ 1, got ${JSON.stringify(n)}`);
  return position;
}

/**
 * Plan `worker set <n> <profile|provider/model>`: insert the model at position
 * n, entries from n onwards move down by one; an existing copy of the same
 * model is removed first (inserting it again moves it), so every model appears
 * once. n past the end appends. The profile form takes no
 * --thinking/--mode/--profile. Advisor profiles are rejected for workers.
 * Unavailable models are stored with a warning (fallback skips them).
 */
export function planWorkerSet(config, providerEntries, { n, spec, thinking, mode, profile }) {
  const position = checkPosition(n, 'worker set');
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('worker set needs <profile|provider/model>');
  const trimmed = spec.trim();
  const notes = [];
  let profileName;
  let candidate = null;
  if (trimmed.includes('/')) {
    const { provider, model } = parseProviderModel(trimmed);
    profileName = resolveProfileName(config, null, provider, model, profile);
    const existing = config.profiles?.[profileName] ?? null;
    candidate = buildCandidate(existing, provider, model, thinking, mode);
    if (candidate.advisor === true) throw new Error(`Profile "${profileName}" is tagged as advisor and cannot be used for workers`);
    const key = modelKey(candidate, { withTags: true });
    if (!existing) {
      const merged = findProfileByKey(config.profiles, key, { withTags: true });
      if (merged) {
        notes.push(`Reusing existing profile "${merged}" (identical model, no new profile created)`);
        profileName = merged;
        candidate = null;
      }
    } else if (modelKey(existing, { withTags: true }) !== key) {
      const other = findProfileByKey(config.profiles, key, { exclude: profileName, withTags: true });
      if (other) throw new Error(`Profile "${profileName}" would duplicate "${other}" (${provider}/${model}); use "${other}" instead`);
    } else {
      candidate = null;
    }
  } else {
    profileName = trimmed;
    if (thinking !== undefined || mode !== undefined || (profile !== undefined && profile !== null)) {
      throw new Error('worker set <n> <profile> takes no --thinking/--mode/--profile; use worker set <n> <provider/model> to change a profile');
    }
    if (!config.profiles?.[profileName]) throw new Error(`Unknown profile "${profileName}"`);
    if (isAdvisorProfile(config, profileName)) throw new Error(`Profile "${profileName}" is tagged as advisor and cannot be used for workers`);
  }
  const next = structuredClone(config);
  if (candidate) {
    next.profiles[profileName] = candidate;
    if (config.profiles?.[profileName]) notes.push(`Profile "${profileName}" updated in place`);
    else if (trimmed.includes('/')) notes.push(...samePairNotes(config, next.profiles[profileName].provider, next.profiles[profileName].model, profileName));
  }
  const target = modelKey(next.profiles[profileName]);
  const before = workerPriority(config);
  const rest = workerPriority(next).filter((entry) => !next.profiles[entry] || modelKey(next.profiles[entry]) !== target);
  const moved = before.length !== rest.length;
  const at = Math.min(position, rest.length + 1);
  if (position > rest.length + 1) notes.push(`Position ${position} is past the end; appended at ${at}`);
  rest.splice(at - 1, 0, profileName);
  if (moved) notes.push(`Moved "${profileName}" to position ${at} (removed duplicate entries)`);
  next.workers = next.workers ?? {};
  next.workers.priority = rest;
  next.workers.defaultProfile = rest[0];
  checkedConfig(next);
  const warnings = startableWarnings(next, providerEntries, profileName);
  if (candidate && config.profiles?.[profileName]) warnings.push(...sharedProfileWarnings(next, profileName, { workerEntry: true }));
  return {
    config: next, profileName, position: at, before, after: [...rest],
    summary: `workers.priority: [${before.join(', ')}] → [${rest.join(', ')}]`,
    notes, warnings,
  };
}

/** Plan `worker rm <n>`: remove the entry, the rest closes the gap. */
export function planWorkerRemove(config, n) {
  const before = workerPriority(config);
  const position = checkPosition(n, 'worker rm');
  if (position > before.length) throw new Error(`worker rm needs a position 1..${before.length}, got ${JSON.stringify(n)}`);
  if (before.length === 1) throw new Error('Cannot remove the last worker profile: at least one entry must remain');
  const next = structuredClone(config);
  const after = before.filter((_, index) => index !== position - 1);
  next.workers = next.workers ?? {};
  next.workers.priority = after;
  next.workers.defaultProfile = after[0];
  checkedConfig(next);
  const removed = before[position - 1];
  return {
    config: next, removed, position, before, after,
    summary: `workers.priority: [${before.join(', ')}] → [${after.join(', ')}]`,
  };
}

/**
 * Plan `worker-default`: alias of `worker set 1` (insert at the front,
 * duplicates move). Deprecated; the CLI prints a hint.
 */
export function planWorkerDefault(config, providerEntries, { spec, thinking, mode, profile }) {
  return planWorkerSet(config, providerEntries, { n: 1, spec, thinking, mode, profile });
}

/**
 * Resolve a `steer set|rm` target: a slot letter (existing, or a free one for
 * set) or a 1-based position in slot order (2 is B). Steer slots never shift:
 * positions address the current order, replacements keep every letter. A new
 * letter must not open a gap (existing gappy configs still load, but no new
 * gap can be written).
 */
export function resolveSteerTarget(config, target, { allowNewLetter = false } = {}) {
  const order = slotOrder(config);
  const raw = String(target ?? '').trim().toUpperCase();
  if (/^[A-Z]$/.test(raw)) {
    if (!config.steers?.slots?.[raw] && !allowNewLetter) throw new Error(`Slot ${raw} is not defined in steers.slots`);
    if (!config.steers?.slots?.[raw] && allowNewLetter) {
      const max = order.length ? order[order.length - 1] : '@';
      const nextFree = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).find((letter) => !config.steers?.slots?.[letter]);
      if (raw > String.fromCharCode(max.charCodeAt(0) + 1)) {
        throw new Error(`Slot ${raw} would leave a gap (slots are ${order.join(', ') || 'none'}); use the next free letter ${nextFree}`);
      }
    }
    return raw;
  }
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= order.length) return order[n - 1];
    throw new Error(`Steer position ${raw} is out of range (1..${order.length}); slots never shift, use an existing position or slot letter`);
  }
  throw new Error(`Steer target must be a slot letter A-Z or a position 1..${order.length}, got ${JSON.stringify(target)}`);
}

function slotList(config) {
  return slotOrder(config).map((slot) => `${slot}:${config.steers.slots[slot]}`);
}

/**
 * Plan `steer set <n|slot> <profile|provider/model>`: replace the slot's
 * profile (no shifting; a free letter creates the slot). Unavailable models
 * are stored with a warning.
 */
export function planSteerSet(config, providerEntries, { target, spec, thinking, mode, profile }) {
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('steer set needs <profile|provider/model>');
  const slot = resolveSteerTarget(config, target, { allowNewLetter: true });
  const trimmed = spec.trim();
  const notes = [];
  const isNewSlot = !config.steers?.slots?.[slot];
  let profileName;
  let candidate = null;
  if (trimmed.includes('/')) {
    const { provider, model } = parseProviderModel(trimmed);
    profileName = resolveProfileName(config, slot, provider, model, profile);
    const existing = config.profiles?.[profileName] ?? null;
    candidate = buildCandidate(existing, provider, model, thinking, mode);
    if (!existing) {
      const assumed = { provider: candidate.provider, model: candidate.model, thinking: candidate.thinking ?? null, mode: candidate.mode ?? null, advisor: false };
      const merged = findProfileByKey(config.profiles, modelKey(assumed, { withTags: true }), { withTags: true });
      if (merged) {
        notes.push(`Reusing existing profile "${merged}" (identical model, no new profile created)`);
        profileName = merged;
        candidate = null;
      }
    } else if (modelKey(existing, { withTags: true }) !== modelKey(candidate, { withTags: true })) {
      const other = findProfileByKey(config.profiles, modelKey(candidate, { withTags: true }), { exclude: profileName, withTags: true });
      if (other) {
        notes.push(`Profile "${profileName}" not changed: identical model already exists as "${other}", slot ${slot} points there`);
        profileName = other;
        candidate = null;
      }
    } else {
      candidate = null;
    }
  } else {
    profileName = trimmed;
    if (thinking !== undefined || mode !== undefined || (profile !== undefined && profile !== null)) {
      throw new Error('steer set <profile> takes no --thinking/--mode/--profile; use steer set <provider/model> to change a profile');
    }
    if (!config.profiles?.[profileName]) throw new Error(`Unknown profile "${profileName}"`);
  }
  const next = structuredClone(config);
  if (candidate) {
    next.profiles[profileName] = candidate;
    if (config.profiles?.[profileName]) notes.push(`Profile "${profileName}" updated in place`);
    else if (trimmed.includes('/')) notes.push(...samePairNotes(config, next.profiles[profileName].provider, next.profiles[profileName].model, profileName));
  }
  const before = slotList(config);
  next.steers.slots[slot] = profileName;
  checkedConfig(next);
  const after = slotList(next);
  if (isNewSlot && !next.steers.prepare.includes(slot)) {
    notes.push(`Slot ${slot} is not in steers.prepare; add it there to plan a steer`);
  }
  const warnings = startableWarnings(next, providerEntries, profileName);
  if (candidate && config.profiles?.[profileName]) warnings.push(...sharedProfileWarnings(next, profileName, { steerSlot: slot }));
  const detail = `${next.profiles[profileName].provider}/${next.profiles[profileName].model}`
    + (next.profiles[profileName].thinking ? ` thinking ${next.profiles[profileName].thinking}` : '')
    + (next.profiles[profileName].mode ? ` mode ${next.profiles[profileName].mode}` : '');
  return {
    config: next, slot, profileName, before, after,
    summary: `steer slots: [${before.join(', ')}] → [${after.join(', ')}] (${slot} → "${profileName}" ${detail})`,
    notes, warnings,
    hint: 'Existing steers are unchanged; the next plan will report the difference.',
  };
}

/**
 * Plan `slot set`: alias of `steer set` with provider/model (replace, no
 * shifting). Deprecated; the CLI prints a hint.
 */
export function planSlotSet(config, providerEntries, { slot, provider, model, thinking, mode, profile }) {
  if (!provider || !model) throw new Error('slot set needs <provider>/<model>');
  return planSteerSet(config, providerEntries, { target: slot, spec: `${provider}/${model}`, thinking, mode, profile });
}

/** Plan `slot rm`: drop the slot, keep its profile, repair prepare/initialActive. */
export function planSlotRemove(config, slot) {
  if (!SLOT_PATTERN.test(slot ?? '')) throw new Error(`Slot must be a single capital letter A-Z, got ${JSON.stringify(slot)}`);
  const slots = config.steers?.slots ?? {};
  if (!slots[slot]) throw new Error(`Slot ${slot} is not defined in steers.slots`);
  if (Object.keys(slots).length === 1) throw new Error(`Cannot remove slot ${slot}: at least one slot must remain`);
  const next = structuredClone(config);
  const before = slotList(config);
  const removedProfile = next.steers.slots[slot];
  delete next.steers.slots[slot];
  next.steers.prepare = (next.steers.prepare ?? []).filter((s) => s !== slot);
  if (!next.steers.prepare.length) next.steers.prepare = [Object.keys(next.steers.slots).sort()[0]];
  if (next.steers.initialActive === slot) next.steers.initialActive = next.steers.prepare[0];
  checkedConfig(next);
  const after = slotList(next);
  return {
    config: next, slot, removedProfile, before, after,
    summary: `steer slots: [${before.join(', ')}] → [${after.join(', ')}] (slot ${slot} removed, profile "${removedProfile}" kept)`,
  };
}

/** Plan `steer rm <n|slot>`: same as slot rm, addressed by letter or position. */
export function planSteerRemove(config, target) {
  return planSlotRemove(config, resolveSteerTarget(config, target, { allowNewLetter: false }));
}

/**
 * Plan `model advisor|sensitive <profile|provider/model> on|off`: flip the
 * tag. A provider/model matching exactly one profile tags it; matching none
 * creates a minimal profile (thinking null) with the tag; matching several is
 * ambiguous and rejected.
 */
export function planProfileTag(config, providerEntries, { flag, spec, on }) {
  if (flag !== 'advisor' && flag !== 'sensitive') throw new Error(`Unknown profile flag ${JSON.stringify(flag)} (expected advisor or sensitive)`);
  if (typeof spec !== 'string' || !spec.trim()) throw new Error(`model ${flag} needs <profile|provider/model>`);
  const trimmed = spec.trim();
  const next = structuredClone(config);
  let profileName;
  let created = false;
  if (trimmed.includes('/')) {
    const { provider, model } = parseProviderModel(trimmed);
    const matches = Object.entries(next.profiles ?? {}).filter(([, p]) => p?.provider === provider && p?.model === model).map(([name]) => name);
    if (matches.length > 1) throw new Error(`"${trimmed}" matches several profiles (${matches.join(', ')}); name the profile explicitly`);
    if (matches.length === 1) {
      profileName = matches[0];
    } else {
      profileName = `${provider}-${model}`;
      if (next.profiles[profileName]) throw new Error(`Profile "${profileName}" exists with a different model; name the profile explicitly`);
      next.profiles[profileName] = { provider, model, thinking: null };
      created = true;
    }
  } else {
    profileName = trimmed;
    if (!next.profiles?.[profileName]) throw new Error(`Unknown profile "${profileName}"`);
  }
  const beforeTag = next.profiles[profileName][flag] === true;
  next.profiles[profileName][flag] = on === true;
  checkedConfig(next);
  const warnings = created ? startableWarnings(next, providerEntries, profileName) : [];
  return {
    config: next, profileName, flag, before: beforeTag, after: on === true, created,
    summary: `profile "${profileName}" ${flag}: ${beforeTag ? 'on' : 'off'} → ${on === true ? 'on' : 'off'}${created ? ' (profile created)' : ''}`,
    warnings,
  };
}

/** Plan `model advisor <profile|provider/model> on|off`. */
export function planAdvisorTag(config, providerEntries, { spec, on }) {
  return planProfileTag(config, providerEntries, { flag: 'advisor', spec, on });
}

/** Plan `model sensitive <profile|provider/model> on|off`. */
export function planSensitiveTag(config, providerEntries, { spec, on }) {
  return planProfileTag(config, providerEntries, { flag: 'sensitive', spec, on });
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
