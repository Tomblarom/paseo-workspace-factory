// One request builder + one placement verifier for every steer creation.
// Plan, steer add, fresh (active/inactive) and relocate build the same
// top-level agent.create request through buildSteerCreate; the executor and
// the recovery paths verify the created or observed agent against the same
// expected placement through verifySteerPlacement. Worker creates keep their
// own request shape (parent + prompt) but verify through the same verifier.
// Receipt lookup stays read-only through lookupCreationReceipt (paseo.mjs);
// the helpers here only validate what it returns, fail closed, and re-send
// the identical request for a completed receipt. `fail` maps a message
// fragment to the caller's domain error, so every path keeps its own type.
import { createHash } from 'node:crypto';
import { LABEL, parentOf } from './paseo.mjs';
import { ACCOUNT_METADATA_KEY } from './zerosub.mjs';

/** Stable daemon idempotency key: `wsf:<scope>:<parts...>` (scope lowercased). */
export function idempotencyKey(scope, ...parts) {
  return ['wsf', String(scope).toLowerCase(), ...parts].join(':');
}

/** Short digest of a create request: the daemon rejects a reused key with a different request. */
export function requestDigest(request) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 10);
}

/** Short holder identity for idempotency keys: first 8 alphanumerics of the agent id. */
export function shortHolderId(agentId) {
  return String(agentId ?? 'x').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'x';
}

/** Exact steer labels: role always 'steer', slot the uppercase letter, scope the scope id. */
export function steerCreateLabels(repo, scopeId, slot) {
  return { [LABEL.repo]: repo, [LABEL.role]: 'steer', [LABEL.slot]: slot, [LABEL.scope]: scopeId };
}

/** Native agent config for a profile: `provider/model` plus mode/thinking when set. */
export function profileAgentConfig(profile) {
  return {
    provider: `${profile.provider}/${profile.model}`,
    ...(profile.mode ? { modeId: profile.mode } : {}),
    ...(profile.thinking ? { thinkingOptionId: profile.thinking } : {}),
  };
}

/** Idempotency key for a steer creation: scope + caller parts + request digest. */
export function steerCreateKey(keyScope, keyParts, digestInput) {
  return idempotencyKey(keyScope, ...keyParts, requestDigest(digestInput));
}

/**
 * One steer create request. `keyParts` is the operation's stable identity
 * (e.g. `['steer', slot, 'g1']`); the digest binds the exact request, so a
 * changed request never reuses the key silently. `digestInput` overrides what
 * the digest covers (relocate previews digest the target directory: the
 * workspace id is unknown until apply). `metadata` pins the agent (e.g. the
 * ZeroSub account); `accountId` adds the pin to the expected placement.
 * Returns `{ request, idempotencyKey, expected }`.
 */
export function buildSteerCreate({ keyScope, repo, scopeId, slot, workspaceId, profile, title = `Steer ${slot}`, keyParts, digestInput = null, metadata = null, accountId = null }) {
  const labels = steerCreateLabels(repo, scopeId, slot);
  const config = profileAgentConfig(profile);
  const request = { workspaceId, title, labels, config, ...(metadata ? { metadata: { ...metadata } } : {}) };
  const key = steerCreateKey(keyScope, keyParts, digestInput ?? request);
  const expected = {
    workspaceId, labels, slot, scopeId, provider: profile.provider, model: profile.model, parent: null,
    ...(accountId ? { accountId } : {}),
  };
  return { request, idempotencyKey: key, expected };
}

/** A created or observed agent that does not match its expected placement. */
export class SteerPlacementError extends Error {}

/**
 * Verifies a created or observed agent against the expected placement. Every
 * field present on `expected` is checked: workspace, parent (null means
 * parent-free; omit the key to skip the check), exact labels, provider/model
 * (only when both are expected) and the ZeroSub account pin (only when
 * expected). Archived agents and missing snapshots always refuse: they read
 * as an old idempotency receipt, never as a live placement.
 */
export function verifySteerPlacement(agent, expected = {}) {
  const id = agent?.id ?? '(unknown agent)';
  if (!agent || typeof agent !== 'object') throw new SteerPlacementError('Agent snapshot missing after write');
  if (agent.archivedAt) throw new SteerPlacementError(`Agent ${id} is archived (an old idempotency receipt?)`);
  if (expected.workspaceId != null && agent.workspaceId !== expected.workspaceId) {
    throw new SteerPlacementError(`Agent ${id} landed in ${agent.workspaceId}, expected ${expected.workspaceId}`);
  }
  if (expected.parent !== undefined) {
    const actual = parentOf(agent) ?? null;
    if (actual !== expected.parent) {
      if (expected.parent === null) throw new SteerPlacementError(`PARENT VIOLATION: agent ${id} has parent ${actual}; not continuing`);
      throw new SteerPlacementError(`Agent ${id} parent is ${actual}, expected ${expected.parent}`);
    }
  }
  for (const [key, value] of Object.entries(expected.labels ?? {})) {
    if (agent.labels?.[key] !== value) throw new SteerPlacementError(`Agent ${id} label ${key} is ${agent.labels?.[key]}, expected ${value}`);
  }
  if (expected.provider != null && expected.model != null && (agent.provider !== expected.provider || agent.model !== expected.model)) {
    throw new SteerPlacementError(`Agent ${id} runs ${agent.provider}/${agent.model}, expected ${expected.provider}/${expected.model}`);
  }
  if (expected.accountId != null && agent.metadata?.[ACCOUNT_METADATA_KEY] !== expected.accountId) {
    throw new SteerPlacementError(`Agent ${id} account is ${agent.metadata?.[ACCOUNT_METADATA_KEY] ?? 'none'}, expected ${expected.accountId}`);
  }
}

/**
 * Refreshes the agent and verifies it against the expected placement. Fails
 * open when the snapshot is unreadable (the executor owns verification
 * then); a readable mismatch throws through `fail`.
 */
export async function verifyCreatedAgent(client, agentId, expected, fail) {
  let snapshot = null;
  try {
    snapshot = (await client.agents.ref(agentId).refresh())?.agent ?? null;
  } catch {
    snapshot = null;
  }
  if (!snapshot) return;
  try {
    verifySteerPlacement(snapshot, expected);
  } catch (error) {
    throw fail(error.message);
  }
}

/**
 * Read-only creation-receipt lookup by idempotency key. A missing lookup or
 * a failed exchange throws through `fail` — it never reads as "no receipt",
 * so callers never create without one.
 */
export async function lookupCreation(lookupReceipt, kind, key, fail) {
  if (typeof lookupReceipt !== 'function') throw fail('needs a receipt lookup; refusing to create without a receipt');
  try {
    return await lookupReceipt(kind, key);
  } catch (error) {
    throw fail(`receipt lookup failed (${error.message}); refusing to create without a receipt`);
  }
}

/**
 * Validates a looked-up creation receipt and returns the created object id.
 * Only a completed receipt with an id passes; a key mismatch, an unknown or
 * failed outcome, or a missing id throws through `fail`. `idOf`/`missing`
 * adapt the identity (agents by default, workspaces pass their own).
 */
export function checkedCreationReceipt(receipt, key, fail, { idOf = (entry) => entry?.agentId, missing = 'the receipt names no agent' } = {}) {
  if (receipt.idempotencyKey && receipt.idempotencyKey !== key) throw fail('the receipt belongs to a different key');
  if (receipt.outcomeUnknown) throw fail(`the receipt has an unknown outcome (${receipt.error ?? 'outcome unknown'})`);
  if (receipt.phase !== 'completed') throw fail(`the receipt is in phase ${receipt.phase}${receipt.error ? ` (${receipt.error})` : ''}`);
  const id = idOf(receipt);
  if (!id) throw fail(missing);
  return id;
}

/**
 * Re-sends the identical request for a completed receipt and returns
 * `{ id, confirmed }`. The daemon answers from its receipt without creating;
 * a rejected request (e.g. same key, changed request) or a contradicting id
 * throws through `fail`.
 */
export async function confirmCreationReceipt(run, op, config, expectedId, fail, { idOf = (result) => result?.agentId } = {}) {
  let confirmed;
  try {
    confirmed = await run(op, config);
  } catch (error) {
    throw fail(`the identical request was rejected (${error.message})`);
  }
  const id = idOf(confirmed);
  if (id !== expectedId) throw fail(`the identical request returned ${id}, receipt says ${expectedId}`);
  return { id, confirmed };
}
