// Preview and receipt-backed creation for a standby steer in an enrolled workspace.
import { LABEL, parentOf } from './paseo.mjs';
import { steerTitleSlot } from './discovery.mjs';
import { buildCandidate, parseProviderModel, resolveSteerAdd, usedProfilesByLiveSteers } from './models.mjs';
import { buildSteerCreate, checkedCreationReceipt, confirmCreationReceipt, lookupCreation, requestDigest, SteerPlacementError, verifySteerPlacement } from './steer-create.mjs';

const inWorkspace = (agent, workspaceId) => agent?.id && agent.workspaceId === workspaceId && !parentOf(agent);

function membersBySlot(agents, { workspaceId, resolvedSteers = [] }) {
  const continuations = resolvedSteers.filter((agent) => agent.continuedFrom && inWorkspace(agent, workspaceId) && !agent.archivedAt);
  const superseded = new Set(continuations.map((agent) => agent.continuedFrom));
  const members = new Map();
  for (const agent of [...continuations, ...agents]) {
    if (!inWorkspace(agent, workspaceId) || agent.archivedAt || agent.superseded || superseded.has(agent.id)) continue;
    if (agent.labels?.[LABEL.role] && agent.labels[LABEL.role] !== 'steer') continue;
    const slot = steerTitleSlot(agent.title) ?? (agent.continuedFrom ? agent.labels?.[LABEL.slot] : null);
    if (!slot) continue;
    if (!members.has(slot)) members.set(slot, new Map());
    members.get(slot).set(agent.id, agent);
  }
  for (const [slot, holders] of members) {
    if (holders.size > 1) {
      throw new SteerAddConflict(`Several live agents are titled Steer ${slot}: ${[...holders.keys()].join(', ')}; resolve the ambiguity in Paseo`);
    }
  }
  return new Map([...members].map(([slot, holders]) => [slot, holders.values().next().value]));
}

function requestedSlot(input) {
  if (input == null || String(input).trim() === '') return null;
  const slot = String(input).trim().toUpperCase();
  if (!/^[A-Z]$/.test(slot)) throw new Error(`Steer slot must be a single capital letter A-Z, got ${JSON.stringify(input)}`);
  return slot;
}

function checkedTargetSlot(members, requested) {
  if (members.has(requested)) throw occupiedError(requested, members.get(requested));
  const next = nextFreeSlot(members);
  if (!next) throw new Error('No free steer slot: all letters A-Z are occupied by live steers');
  if (requested && requested !== next) throw new Error(`Slot ${requested} would leave a gap; use the next free letter ${next}`);
  return next;
}

function nextFreeSlot(members) {
  return [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find((slot) => !members.has(slot));
}

function generationFor(agents, workspaceId, slot) {
  const ids = agents.filter((agent) => inWorkspace(agent, workspaceId) && !agent.archivedAt &&
    (steerTitleSlot(agent.title) === slot || (agent.labels?.[LABEL.role] === 'steer' && agent.labels[LABEL.slot] === slot)))
    .map((agent) => agent.id);
  return requestDigest([...new Set(ids)].sort());
}

function modelKeyWithTags(profile) {
  const sensitive = typeof profile?.sensitive === 'boolean' ? profile.sensitive : profile?.provider === 'muse';
  return JSON.stringify([profile?.provider, profile?.model, profile?.thinking ?? null, profile?.mode ?? null, profile?.advisor === true, sensitive]);
}

/** Pure preview from the target workspace, with no settings changes. */
export function planSteerAdd(config, providerEntries, agents, args = {}) {
  const members = membersBySlot(agents, args);
  const target = checkedTargetSlot(members, requestedSlot(args.slot));
  checkActiveVacancy(target, args.activeSlot);
  return buildPlan(config, providerEntries, agents, members, target, args);
}

function checkActiveVacancy(slot, activeSlot) {
  if (slot === activeSlot) {
    throw new SteerAddConflict(`Active Steer ${slot} has no live holder. Resolve the scope's active authority before reusing the letter.`);
  }
}

function buildPlan(config, providerEntries, agents, members, target, {
  spec = null, thinking, mode, profile: profileOption,
  scopeId = null, workspaceId = null, repo = null, repoPublic = null, epoch = null, settingsRevision = null,
  quotaSnapshot, quotaExhaustedPct, profileHealth, now, zerosub, creationId,
}, legacy = false) {
  const notes = [];
  const warnings = [];
  const effectiveScope = scopeId ?? repo;
  const effectiveRepo = repo ?? scopeId;
  const legacyProfile = legacy ? config?.steers?.slots?.[target] : null;
  const specText = String(spec ?? '').trim();
  let selectionConfig = config;
  let name = specText || legacyProfile || null;
  let liveProviderPrivacy = false;

  if (specText.includes('/')) {
    const { provider, model } = parseProviderModel(specText);
    name = String(profileOption ?? legacyProfile ?? `${provider}-${model}`).trim();
    if (!name) throw new Error('--profile must be a non-empty name');
    const existing = config.profiles?.[name];
    const built = buildCandidate(existing, provider, model, thinking, mode, { providerEntries, notes, profileName: name });
    if (existing?.provider !== provider) delete built.sensitive;
    liveProviderPrivacy = !profileOption || existing?.provider !== provider;
    if (!existing || modelKeyWithTags(existing) !== modelKeyWithTags(built)) {
      const match = Object.entries(config.profiles ?? {}).find(([, profile]) => modelKeyWithTags(profile) === modelKeyWithTags(built));
      if (match) {
        name = match[0];
        notes.push(`Using matching profile "${name}" for this creation`);
      } else {
        selectionConfig = { ...config, profiles: { ...config.profiles, [name]: built } };
      }
    }
  }

  const { advisorSlot, profile, skipped, zerosubAccount, earliestReset } = resolveSteerAdd(selectionConfig, providerEntries, {
    profile: name, legacyPriority: legacy, usedProfiles: usedProfilesByLiveSteers(config, [...members.values()]),
    repoPublic, liveProviderPrivacy, quotaSnapshot, quotaExhaustedPct, profileHealth, now, zerosub,
  });
  if (!profile) {
    return {
      slot: target, advisorSlot, profile: null, profileName: null, skipped, zerosubAccount: null,
      earliestReset,
      summary: `steer add ${target}: blocked (no startable profile)`, notes, warnings, op: null, fingerprintInput: null,
    };
  }
  const profileName = profile.name;
  if (advisorSlot) notes.push(`Steer ${target} uses advisor profile "${profileName}" (advisor, never active)`);
  const effective = { provider: profile.provider, model: profile.model, thinking: profile.thinking ?? null, mode: profile.mode ?? null };
  const generation = legacy ? null : creationId ?? generationFor(agents, workspaceId, target);
  const steerRole = advisorSlot ? 'advisor' : 'coordinator';
  const { request, idempotencyKey } = buildSteerCreate({
    keyScope: effectiveRepo ?? 'scope', repo: effectiveRepo ?? '?',
    scopeId: effectiveScope ?? '?', slot: target, workspaceId: workspaceId ?? '?',
    profile: effective, keyParts: legacy ? ['steer', target, 'g1'] : ['steer-add', target, generation],
    metadata: legacy ? null : { [LABEL.steerRole]: steerRole },
  });
  const op = {
    key: `steer.${target}`, kind: 'paseo.agent.create',
    summary: `Create top-level Steer ${target} (${effective.provider}/${effective.model}) without prompt`,
    params: { ...request, steerRole, idempotencyKey, ...(legacy ? {} : { recordedCreationMetadata: true }) },
  };
  const detail = `${effective.provider}/${effective.model}`
    + (effective.thinking ? ` thinking ${effective.thinking}` : '')
    + (effective.mode ? ` mode ${effective.mode}` : '');
  const fingerprintInput = {
    kind: 'factory.steer.add', scope: effectiveScope, repo: effectiveRepo, workspaceId,
    slot: target, profile: profileName, ...effective, advisor: advisorSlot,
    ...(legacy ? {} : { generation, epoch, settingsRevision }),
  };
  return {
    slot: target, advisorSlot, profile, profileName, skipped, zerosubAccount, earliestReset,
    summary: `Create Steer ${target} with "${profileName}" (${detail}).`, notes, warnings, op, fingerprintInput,
  };
}

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
  if (plan.zerosubAccount) lines.push(`ZeroSub quota candidate: ${plan.zerosubAccount} (automatic account routing)`);
  for (const entry of plan.skipped ?? []) lines.push(`Skipped "${entry.name}": ${entry.reason}`);
  if (plan.earliestReset) lines.push(`Earliest reset: ${plan.earliestReset}`);
  for (const note of plan.notes ?? []) lines.push(`Note: ${note}`);
  for (const warning of plan.warnings ?? []) lines.push(`Warning: ${warning}`);
  lines.push(`Op: ${plan.op.summary} [${plan.op.params.idempotencyKey}]`);
  lines.push('Confirm to create the standby in this workspace.');
  return lines.join('\n');
}

/** The confirmed preview no longer matches fresh state. */
export class SteerAddStale extends Error {}
/** The requested letter is occupied or live title membership is ambiguous. */
export class SteerAddConflict extends Error {}
/** Creation cannot be verified. */
export class SteerAddRecovery extends Error {}

const recoveryError = (message) => new SteerAddRecovery(`Steer add recovery stopped: ${message}`);

function occupiedError(slot, occupant) {
  return new SteerAddConflict(`Slot ${slot} is already occupied by live steer ${occupant.id}; use Fresh to refresh it`);
}

function staleError() {
  return new SteerAddStale('Something changed since the steer-add preview. Run /factory steer add again and confirm the new preview.');
}

function blockedError(plan) {
  const tried = plan.skipped.map((entry) => `"${entry.name}" (${entry.reason})`).join('; ') || 'no profiles available';
  return new SteerAddRecovery(`Steer add ${plan.slot} is blocked, no startable profile (tried ${tried})${plan.earliestReset ? `, earliest reset ${plan.earliestReset}` : ''}. Resolve the blockers and preview again.`);
}

/** Called with fresh workspace membership while the caller holds its workspace lock. */
export async function applySteerAdd(config, providerEntries, agents, args = {}) {
  const { fingerprint, fingerprintOf, lookupReceipt, execute, pendingKey } = args;
  if (typeof fingerprint !== 'string' || !fingerprint) throw new SteerAddStale('Steer add needs the fingerprint of a confirmed preview.');
  if (typeof fingerprintOf !== 'function') throw new Error('Steer add needs a fingerprint function.');
  if (typeof lookupReceipt !== 'function' || typeof execute !== 'function') {
    throw recoveryError('a receipt lookup and an executor are required');
  }
  const members = membersBySlot(agents, args);
  const requested = requestedSlot(args.slot);
  const occupant = members.get(requested);
  if (occupant) members.delete(requested);
  const rest = occupant ? agents.filter((agent) => agent.id !== occupant.id) : agents;

  // A retry removes its prospective occupant from the observed generation.
  // An older preview can only recover an existing g1 receipt.
  const target = requested ?? checkedTargetSlot(members, requested);
  let plan = buildPlan(config, providerEntries, rest, members, target, args);
  let legacy = false;
  if (!plan.profile || fingerprintOf(plan.fingerprintInput) !== fingerprint) {
    const old = requested ? buildPlan(config, providerEntries, rest, members, requested, args, true) : null;
    if (!old?.profile || fingerprintOf(old.fingerprintInput) !== fingerprint) {
      if (!plan.profile) throw blockedError(plan);
      if (occupant) throw occupiedError(requested, occupant);
      throw staleError();
    }
    plan = old;
    legacy = true;
  }

  const key = plan.op.params.idempotencyKey;
  if (pendingKey && pendingKey !== key) throw recoveryError('a different create is already pending');
  const receipt = await lookupCreation(lookupReceipt, 'agent', key, recoveryError);
  let agentId;
  let account;
  if (receipt) {
    const receiptAgentId = checkedCreationReceipt(receipt, key, recoveryError);
    if (occupant && occupant.id !== receiptAgentId) throw occupiedError(plan.slot, occupant);
    const existing = occupant ?? agents.find((agent) => agent.id === receiptAgentId) ?? receipt.agent;
    if (existing?.archivedAt || (!existing && args.creationId && pendingKey !== key)) throw staleError();
    if (existing) verifyReceiptPlacement(existing, plan, args.workspaceId);
    if (occupant) {
      agentId = receiptAgentId;
      account = occupant.metadata?.['zerosub.account'];
    } else {
      const { id, confirmed } = await confirmCreationReceipt(execute, plan.op, config, receiptAgentId, recoveryError);
      agentId = id;
      account = confirmed.accountId;
    }
  } else {
    if (occupant) throw occupiedError(plan.slot, occupant);
    if (legacy) throw staleError();
    if (target !== nextFreeSlot(members)) throw staleError();
    checkActiveVacancy(plan.slot, args.activeSlot);
    const created = await execute(plan.op, config, { newCreation: true });
    agentId = created?.agentId;
    account = created?.accountId;
    if (!agentId) throw recoveryError('creation returned no agent id');
  }
  return finishApplied(plan, agentId, receipt != null, account ?? null);
}

function verifyReceiptPlacement(agent, plan, workspaceId) {
  try {
    verifySteerPlacement(agent, {
      workspaceId, parent: null, labels: plan.op.params.labels,
      provider: plan.profile.provider, model: plan.profile.model,
    });
    if (steerTitleSlot(agent.title) !== plan.slot) throw new SteerPlacementError(`Agent ${agent.id} no longer holds Steer ${plan.slot}`);
    const role = agent.labels?.[LABEL.steerRole] ?? agent.metadata?.[LABEL.steerRole];
    if (role && role !== plan.op.params.steerRole) throw new SteerPlacementError(`Agent ${agent.id} has a different steer role`);
  } catch (error) {
    if (error instanceof SteerPlacementError) throw recoveryError(error.message);
    throw error;
  }
}

function finishApplied(plan, agentId, reused, account) {
  const text = [
    `Steer ${plan.slot} created: agent ${agentId} (profile "${plan.profileName}" ${plan.profile.provider}/${plan.profile.model})`,
    account ? `ZeroSub account ${account}` : null,
    reused ? 'reused after receipt' : null,
  ].filter(Boolean).join(' · ') + '.';
  return {
    scope: plan.fingerprintInput.scope ?? plan.fingerprintInput.repo,
    slot: plan.slot, agentId, profile: plan.profileName,
    provider: plan.profile.provider, model: plan.profile.model,
    account, applied: true, reused, text,
  };
}
