// Automatic steer policy for one scope. The caller supplies live admission and
// persists reservations under the scope lock before dispatching any creation.
import { isAdvisorSteer } from './config.mjs';
import { steerTitleSlot } from './discovery.mjs';
import { CREATION_SNAPSHOT_PHASES, LABEL, parentOf } from './paseo.mjs';
import { readStagedSteerBrief, unsettledAccountMove } from './steer-action.mjs';
import { buildSteerCreate, MANAGED_STEER_PROVENANCE_KEY, SteerPlacementError, verifySteerPlacement } from './steer-create.mjs';
import { ACCOUNT_METADATA_KEY } from './zerosub.mjs';

export const MAX_MANAGED_STEER_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 60_000;

const isFactoryCreated = (steer) => steer?.metadata?.[MANAGED_STEER_PROVENANCE_KEY] === 'factory';
const slotOf = (steer) => steerTitleSlot(steer.title) ?? steer.slot ?? steer.labels?.[LABEL.slot];
const occupiesSlot = (steer, slot) => Boolean(slot && (slotOf(steer) === slot || steer.labels?.[LABEL.slot] === slot));
const parentIdOf = (agent) => parentOf(agent) ?? agent?.parent ?? null;
const isIdCollection = (value) => Array.isArray(value) || value instanceof Set;
const scopeKeyOf = (steer) => JSON.stringify([
  steer.workspaceId ?? null, String(steer.labels?.[LABEL.scope] ?? steer.scopeId ?? '').toLowerCase(),
]);

function isLiveSteer(steer) {
  const role = steer?.labels?.[LABEL.role];
  return Boolean(steer?.id && slotOf(steer) && (!role || role === 'steer') && !parentIdOf(steer) &&
    !steer.archivedAt && !steer.superseded && !steer.background && steer.status !== 'closed');
}

function isAdvisor(steer, config) {
  return steer.advisor === true || isAdvisorSteer(config, steer.labels, steer.metadata) ||
    isAdvisorSteer(config, { ...steer.labels, [LABEL.slot]: slotOf(steer) }, steer.metadata);
}

function isEligible(steer, ids, config) {
  return isLiveSteer(steer) && ids.has(steer.id) && !isAdvisor(steer, config);
}

/** Takes resolved scope membership in caller preference order and admitted IDs
 * (role, privacy and quota already checked). Manual steers may be reused. */
export function findReusableSteer({ steers = [], eligibleLiveSteerIds, config }) {
  const ids = new Set(isIdCollection(eligibleLiveSteerIds) ? eligibleLiveSteerIds : []);
  return steers.find((steer) => isEligible(steer, ids, config)) ?? null;
}

/**
 * Decide reuse, reconciliation, waiting or a fresh reservation. `create` is
 * the buildSteerCreate input for this route. `cycleKey` is a stable identity
 * from the scope epoch, effective eligibility and observed quota reset. A
 * changed key reopens the budget after settlement while `generation` keeps
 * increasing. `now` is epoch milliseconds. Persist the returned `state` on
 * `create` and use its exact request and key. `reconcile` refers to that same
 * reservation, including after a daemon restart.
 */
export function reserveManagedSteerCreation({ state = null, cycleKey, now, create, steers = [], eligibleLiveSteerIds, config }) {
  if (state?.phase === 'pending') return { action: 'reconcile', state };
  if (!isIdCollection(eligibleLiveSteerIds)) return { action: 'wait', reason: 'eligibility-unavailable', state };

  const reuse = { eligibleLiveSteerIds, config };
  const recovered = state?.phase === 'completed'
    ? findReusableSteer({ ...reuse, steers: steers.filter((steer) => steer?.id === state.agentId) }) : null;
  const steer = recovered ?? findReusableSteer({ ...reuse, steers });
  if (steer) return { action: 'reuse', agentId: steer.id, state };

  if (typeof cycleKey !== 'string' || !cycleKey || !Number.isFinite(now)) {
    throw new TypeError('Managed steer creation needs a stable cycle key and a current timestamp');
  }
  const sameCycle = state?.cycleKey === cycleKey;
  if (sameCycle && state.phase === 'completed') return { action: 'wait', reason: 'completed-attempt', state };
  if (sameCycle && state.exhausted) return { action: 'wait', reason: 'exhausted', state };
  if (sameCycle && now < state.backoffUntil) return { action: 'wait', reason: 'backoff', state };

  const generation = (state?.generation ?? 0) + 1;
  const accountId = create.accountId ?? create.metadata?.[ACCOUNT_METADATA_KEY];
  const creation = buildSteerCreate({
    ...create, accountId, managed: true, digestInput: null,
    keyParts: ['managed-steer', ...(create.keyParts ?? []), `g${generation}`],
  });
  if (isAdvisor(creation.request, config)) throw new Error('Managed creation requires a coordinating steer');
  return {
    action: 'create',
    state: {
      ...structuredClone(creation), cycleKey, generation, attempts: (sameCycle ? state.attempts : 0) + 1,
      phase: 'pending', startedAt: now, agentId: null, failureReason: null, backoffUntil: null, exhausted: false,
    },
  };
}

function failAttempt(state, reason, now) {
  if (!Number.isFinite(now)) throw new TypeError('Managed steer failure needs a current timestamp');
  return {
    status: 'failed',
    state: {
      ...state,
      phase: 'failed',
      failureReason: reason.slice(0, 300),
      backoffUntil: Math.max(state.startedAt, now) + INITIAL_BACKOFF_MS * 2 ** (state.attempts - 1),
      exhausted: state.attempts >= MAX_MANAGED_STEER_ATTEMPTS,
    },
  };
}

/**
 * Reconcile the exact reserved key with a Paseo receipt and, for completion,
 * a fresh agent snapshot. `undefined` means lookup unavailable. Explicit null
 * only settles a failure when the caller also knows dispatch never occurred
 * (`preDispatchFailure`, a reason string). The stored request remains available
 * for recovery under the same key. An unresolved receipt bars new generations.
 */
export function reconcileManagedSteerCreation({ state, receipt, agent, now, preDispatchFailure, config }) {
  if (state?.phase !== 'pending') return { status: 'unchanged', state };
  if (receipt === undefined) return { status: 'receipt-unavailable', state };
  if (receipt === null) {
    return !agent && typeof preDispatchFailure === 'string' && preDispatchFailure.trim()
      ? failAttempt(state, preDispatchFailure, now) : { status: 'receipt-missing', state };
  }
  if (receipt.kind !== 'agent' || receipt.idempotencyKey !== state.idempotencyKey ||
      (receipt.workspaceId != null && receipt.workspaceId !== state.expected.workspaceId) ||
      !CREATION_SNAPSHOT_PHASES.includes(receipt.phase)) return { status: 'receipt-mismatch', state };
  if (receipt.outcomeUnknown) return { status: 'outcome-unknown', state };
  if (receipt.phase === 'failed') {
    // Paseo reserves an agent ID before the start. A definitive agent-stage
    // failure may carry that ID, but must have produced no agent snapshot.
    if (receipt.outcomeUnknown !== false || receipt.failedStage !== 'agent' || receipt.agent || agent) {
      return { status: 'outcome-unknown', state };
    }
    const reason = typeof receipt.error === 'string' && receipt.error ? receipt.error : 'Agent creation failed';
    return failAttempt(state, reason, now);
  }
  if (receipt.phase !== 'completed') return { status: 'receipt-pending', state };
  if (!receipt.agentId) return { status: 'receipt-mismatch', state };
  if (!agent) return { status: 'agent-missing', state };
  if (receipt.agentId !== agent.id || !isLiveSteer(agent) || slotOf(agent) !== state.expected.slot || isAdvisor(agent, config)) {
    return { status: 'agent-mismatch', state };
  }
  try {
    verifySteerPlacement(agent, state.expected);
  } catch (error) {
    if (!(error instanceof SteerPlacementError)) throw error;
    return { status: 'agent-mismatch', detail: error.message, state };
  }
  return { status: 'completed', state: { ...state, phase: 'completed', agentId: agent.id } };
}

function ownsWorker(steer, worker) {
  if (!worker || worker.archivedAt) return false;
  const parent = parentIdOf(worker);
  if (parent) return parent === steer.id || worker.parentContinuedFrom === steer.id;
  return occupiesSlot(steer, worker.labels?.[LABEL.owner] ?? worker.owner);
}

/**
 * Read-only evaluation for a scope. Pass resolved steer and worker snapshots,
 * the active slot (or `{ activeSteer, activeAgentId }` from scope metadata),
 * and the per-agent entry map with `openAssignment: true` for unfinished
 * assignments. The remaining guard collections are sets or arrays of affected
 * steer IDs, projected from current records by the caller. Supply empty
 * collections for known-empty guards and null for an explicitly vacant slot.
 * Supply coverage IDs after any required replacement acceptance. Every
 * candidate's covering steer is kept in this same result.
 */
export function findArchiveCandidates({ steers = [], activeSlot, agentEntries, workers, permissions, stagedBriefs, pendingReports, uncertainOps, reservedDeliveries, config, eligibleLiveSteerIds }) {
  const active = typeof activeSlot === 'string' ? { activeSteer: activeSlot } : activeSlot;
  const hasAuthoritySnapshot = active === null || active?.activeSteer === null ||
    Boolean(active?.activeSteer || active?.activeAgentId);
  const guards = [
    ['pending-permission', permissions], ['staged-brief', stagedBriefs], ['pending-report', pendingReports],
    ['uncertain-operation', uncertainOps], ['pending-delivery', reservedDeliveries],
  ];
  const ids = new Set(isIdCollection(eligibleLiveSteerIds) ? eligibleLiveSteerIds : []);
  const guardIds = guards.map(([reason, values]) => [reason, new Set(isIdCollection(values) ? values : [])]);
  const scopeWorkers = Array.isArray(workers) ? workers : [];
  const complete = hasAuthoritySnapshot && agentEntries && typeof agentEntries === 'object' && !Array.isArray(agentEntries) &&
    scopeWorkers === workers && isIdCollection(eligibleLiveSteerIds) && guards.every(([, values]) => isIdCollection(values));

  const rows = steers.map((steer) => {
    const agentId = steer.id;
    const entry = agentEntries?.[agentId];
    const action = entry?.action;
    const reasons = new Set();
    if (!isFactoryCreated(steer)) reasons.add('manual-steer');
    if (isAdvisor(steer, config)) reasons.add('advisor');
    if (!isLiveSteer(steer)) reasons.add('not-live');
    if (!complete) reasons.add('incomplete-snapshot');
    if (agentId === active?.activeAgentId || occupiesSlot(steer, active?.activeSteer)) reasons.add('active-authority');
    if (entry?.openAssignment === true) reasons.add('open-assignment');
    if (scopeWorkers.some((worker) => ownsWorker(steer, worker))) reasons.add('dependent-worker');
    if (steer.pendingPermissions?.length) reasons.add('pending-permission');
    if (readStagedSteerBrief(entry)) reasons.add('staged-brief');
    if (unsettledAccountMove(action) || action?.cleanup || ['uncertain', 'rewinding'].includes(action?.phase)) reasons.add('uncertain-operation');
    if (action && !['done', 'staged'].includes(action.phase)) reasons.add('pending-delivery');
    // A late turn.before can republish the already-ended turn from turn.after.
    const openTurn = entry?.openTurnId && entry.openTurnId !== entry.lastTurnId;
    if (steer.status !== 'idle' || steer.activeTurn || openTurn) reasons.add('not-idle');
    for (const [reason, targets] of guardIds) {
      if (targets.has(agentId)) reasons.add(reason);
    }
    return { agentId, reasons: [...reasons], scope: scopeKeyOf(steer), eligible: isEligible(steer, ids, config) };
  });

  // Prefer coverage by a steer already kept for another reason. If every
  // suitable steer is otherwise archivable, keep one for the whole result.
  const coverage = new Map();
  for (const row of rows) {
    if (row.eligible && row.reasons.length && !coverage.has(row.scope)) coverage.set(row.scope, row.agentId);
  }
  for (const row of rows) {
    if (row.eligible && !coverage.has(row.scope)) coverage.set(row.scope, row.agentId);
  }
  const candidates = [];
  const kept = [];
  for (const { agentId, reasons, scope } of rows) {
    const coveredBy = coverage.get(scope);
    if (reasons.length) kept.push({ agentId, reasons });
    else if (!coveredBy) kept.push({ agentId, reasons: ['no-eligible-cover'] });
    else if (coveredBy === agentId) kept.push({ agentId, reasons: ['retained-for-coverage'] });
    else candidates.push({ agentId, reasons: ['covered-by-eligible-steer'], coveredBy });
  }
  return { candidates, kept };
}
