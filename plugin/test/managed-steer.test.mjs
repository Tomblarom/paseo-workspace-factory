import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LABEL, PARENT_LABEL } from '../server/core/paseo.mjs';
import {
  findArchiveCandidates, findReusableSteer, MAX_MANAGED_STEER_ATTEMPTS,
  reconcileManagedSteerCreation, reserveManagedSteerCreation,
} from '../server/core/managed-steer.mjs';
import { buildSteerCreate, MANAGED_STEER_PROVENANCE_KEY, requestDigest, steerCreateKey } from '../server/core/steer-create.mjs';
import { ACCOUNT_METADATA_KEY } from '../server/core/zerosub.mjs';

const CREATE = {
  keyScope: 'Example/Repo', repo: 'Example/Repo', scopeId: 'scope', slot: 'B', workspaceId: 'workspace',
  profile: { provider: 'codex', model: 'sol' }, keyParts: ['steer', 'B'],
  metadata: { [LABEL.steerRole]: 'coordinator', [ACCOUNT_METADATA_KEY]: 'account' },
};
const CYCLE = 'epoch-5:eligible-route-1:quota-window-1';
const NOW = 1_000_000;

function reserve(options = {}) {
  return reserveManagedSteerCreation({ cycleKey: CYCLE, now: NOW, create: CREATE, eligibleLiveSteerIds: [], ...options });
}

function steer(id, slot, overrides = {}) {
  return {
    id, title: `Steer ${slot}`, status: 'idle', workspaceId: CREATE.workspaceId,
    labels: { [LABEL.scope]: CREATE.scopeId, [LABEL.role]: 'steer', [LABEL.slot]: slot },
    metadata: { [MANAGED_STEER_PROVENANCE_KEY]: 'factory' }, ...overrides,
  };
}

function receipt(state, overrides = {}) {
  return { kind: 'agent', idempotencyKey: state.idempotencyKey, revision: 2, phase: 'completed', agentId: 'created', ...overrides };
}

function failedReceipt(state, overrides = {}) {
  return receipt(state, { phase: 'failed', failedStage: 'agent', outcomeUnknown: false, error: 'Provider quota exhausted', ...overrides });
}

function createdAgent(state, overrides = {}) {
  const { workspaceId, title, labels, metadata } = state.request;
  return { id: 'created', workspaceId, title, labels, metadata, status: 'idle', provider: 'codex', model: 'sol', ...overrides };
}

test('managed create opts into provenance, while legacy request and digest forms are preserved', () => {
  const plain = buildSteerCreate(CREATE);
  const managed = buildSteerCreate({ ...CREATE, managed: true });
  assert.equal(plain.request.metadata[MANAGED_STEER_PROVENANCE_KEY], undefined);
  assert.equal(plain.expected.metadata, undefined);
  assert.deepEqual(managed.request.metadata, { ...CREATE.metadata, 'wsf.createdBy': 'factory' });
  assert.deepEqual(managed.expected.metadata, { 'wsf.createdBy': 'factory' });
  const unpinned = { ...plain.request, metadata: { [LABEL.steerRole]: 'coordinator' } };
  assert.equal(plain.idempotencyKey, `wsf:example/repo:steer:B:${requestDigest(unpinned)}`);
  assert.notEqual(managed.idempotencyKey, plain.idempotencyKey);
  const digestInput = { path: '/workspace', slot: 'B' };
  const preview = buildSteerCreate({ ...CREATE, digestInput });
  assert.equal(preview.idempotencyKey, steerCreateKey(CREATE.keyScope, CREATE.keyParts, digestInput));
  assert.notEqual(buildSteerCreate({ ...CREATE, digestInput, managed: true }).idempotencyKey, preview.idempotencyKey);
  assert.deepEqual(CREATE.metadata, { [LABEL.steerRole]: 'coordinator', [ACCOUNT_METADATA_KEY]: 'account' });
});

test('reuse comes before a new reservation, including for a manually created steer', () => {
  const steers = [steer('limited', 'A'), steer('manual', 'B', { metadata: {} }), steer('managed', 'C')];
  const eligibleLiveSteerIds = new Set(['manual', 'managed']);
  assert.equal(findReusableSteer({ steers, eligibleLiveSteerIds }), steers[1]);
  assert.deepEqual(reserve({ steers, eligibleLiveSteerIds, create: null }), { action: 'reuse', agentId: 'manual', state: null });
  assert.equal(findReusableSteer({ steers, eligibleLiveSteerIds: [] }), null);
  assert.equal(reserve({ steers, eligibleLiveSteerIds: undefined }).reason, 'eligibility-unavailable');
});

test('reuse excludes advisers, archived and superseded agents, and non-steer tabs', () => {
  const steers = [
    steer('advisor', 'A', { metadata: { [LABEL.steerRole]: 'advisor' } }),
    steer('legacy-advisor', 'B'), steer('archived', 'C', { archivedAt: 'today' }),
    steer('superseded', 'D', { superseded: true }), steer('closed', 'E', { status: 'closed' }),
    steer('background', 'F', { background: true }), steer('parented', 'G', { parent: 'other' }),
    steer('worker', 'H', { labels: { [LABEL.role]: 'worker' } }),
  ];
  assert.equal(findReusableSteer({ steers, eligibleLiveSteerIds: steers.map(({ id }) => id), config: { legacyAdvisorSlots: ['B'] } }), null);
});

test('a reservation is JSON-persistent and gates all new attempts until reconciliation', () => {
  const operation = reserve();
  assert.equal(operation.action, 'create');
  const state = JSON.parse(JSON.stringify(operation.state));
  assert.deepEqual(state, operation.state);
  assert.match(state.idempotencyKey, /:managed-steer:steer:B:g1:/);
  assert.equal(state.generation, 1);
  assert.equal(state.attempts, 1);
  assert.equal(state.startedAt, NOW);
  assert.equal(state.request.metadata['wsf.createdBy'], 'factory');
  assert.equal(state.expected.accountId, 'account');
  assert.equal(state.failureReason, null);
  assert.equal(state.backoffUntil, null);
  assert.equal(state.exhausted, false);
  assert.deepEqual(reserve({ state, cycleKey: 'changed', now: NOW + 200_000 }), { action: 'reconcile', state });
  assert.equal(reserve({ state, steers: [steer('other', 'C')], eligibleLiveSteerIds: ['other'] }).action, 'reconcile');
  assert.equal(reconcileManagedSteerCreation({ state }).status, 'receipt-unavailable');
  assert.deepEqual(reconcileManagedSteerCreation({ state, receipt: null }), { status: 'receipt-missing', state });
});

test('live receipt recovery reuses the exact agent after a lost response', () => {
  const state = JSON.parse(JSON.stringify(reserve().state));
  const agent = createdAgent(state);
  const recovered = reconcileManagedSteerCreation({ state, receipt: receipt(state), agent });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.state.agentId, agent.id);
  assert.equal(state.phase, 'pending');
  const steers = [steer('standby', 'C'), agent];
  assert.deepEqual(reserve({ state: recovered.state, steers, eligibleLiveSteerIds: ['standby', 'created'] }), {
    action: 'reuse', agentId: agent.id, state: recovered.state,
  });
  assert.equal(reserve({ state: recovered.state }).reason, 'completed-attempt');
  assert.deepEqual(reconcileManagedSteerCreation({ state: recovered.state, receipt: receipt(state), agent }), { status: 'unchanged', state: recovered.state });
});

test('unsettled receipts keep the reservation even across cycles', () => {
  const { state } = reserve();
  const cases = [
    [receipt(state, { kind: 'workspace' }), 'receipt-mismatch'],
    [receipt(state, { idempotencyKey: 'different' }), 'receipt-mismatch'],
    [receipt(state, { workspaceId: 'elsewhere' }), 'receipt-mismatch'],
    [receipt(state, { phase: 'new-phase' }), 'receipt-mismatch'],
    [receipt(state, { phase: 'accepted' }), 'receipt-pending'],
    [receipt(state, { phase: 'agent_ready' }), 'receipt-pending'],
    [receipt(state, { agentId: null }), 'receipt-mismatch'],
    [receipt(state, { agent: createdAgent(state) }), 'agent-missing'],
    [failedReceipt(state, { outcomeUnknown: true }), 'outcome-unknown'],
    [failedReceipt(state, { outcomeUnknown: undefined }), 'outcome-unknown'],
    [failedReceipt(state, { failedStage: 'prompt' }), 'outcome-unknown'],
    [failedReceipt(state, { agent: createdAgent(state) }), 'outcome-unknown'],
  ];
  for (const [snapshot, status] of cases) {
    assert.deepEqual(reconcileManagedSteerCreation({ state, receipt: snapshot, now: NOW }), { status, state });
    assert.equal(reserve({ state, cycleKey: 'changed' }).action, 'reconcile');
  }
  assert.equal(reconcileManagedSteerCreation({ state, receipt: failedReceipt(state), agent: createdAgent(state) }).status, 'outcome-unknown');
});

test('completed receipts fail closed on stale and contradictory live placement', () => {
  const { state } = reserve();
  const mismatches = [
    { id: 'wrong' }, { workspaceId: 'elsewhere' }, { title: 'Steer C' }, { provider: 'other-provider' }, { model: 'other-model' },
    { archivedAt: 'today' }, { status: 'closed' }, { superseded: true }, { background: true }, { metadata: {} },
    { metadata: { ...state.request.metadata, [ACCOUNT_METADATA_KEY]: 'wrong-account' } },
    { metadata: { ...state.request.metadata, [LABEL.steerRole]: 'advisor' } },
    { labels: { ...state.request.labels, [LABEL.slot]: 'C' } },
    { labels: { ...state.request.labels, [PARENT_LABEL]: 'parent' } },
  ];
  for (const override of mismatches) {
    const result = reconcileManagedSteerCreation({ state, receipt: receipt(state), agent: createdAgent(state, override) });
    assert.equal(result.status, 'agent-mismatch', JSON.stringify(override));
    assert.equal(result.state, state);
  }
});

test('retry is bounded with increasing durable backoff and unique generation keys', () => {
  let state = null;
  let now = NOW;
  const keys = new Set();
  for (let attempt = 1; attempt <= MAX_MANAGED_STEER_ATTEMPTS; attempt += 1) {
    const reserved = reserve({ state, now });
    assert.equal(reserved.action, 'create');
    assert.equal(reserved.state.generation, attempt);
    assert.equal(reserved.state.attempts, attempt);
    assert.ok(!keys.has(reserved.state.idempotencyKey));
    keys.add(reserved.state.idempotencyKey);
    const failed = reconcileManagedSteerCreation({ state: reserved.state, receipt: failedReceipt(reserved.state), now: now + 100 });
    assert.equal(failed.status, 'failed');
    state = JSON.parse(JSON.stringify(failed.state));
    assert.equal(state.failureReason, 'Provider quota exhausted');
    assert.equal(state.backoffUntil, now + 100 + 60_000 * 2 ** (attempt - 1));
    assert.equal(state.exhausted, attempt === MAX_MANAGED_STEER_ATTEMPTS);
    assert.equal(reserve({ state, now: state.backoffUntil - 1 }).reason, state.exhausted ? 'exhausted' : 'backoff');
    now = state.backoffUntil;
  }
  assert.equal(reserve({ state, now: now + 1_000_000 }).reason, 'exhausted');
  assert.equal(reserve({ state, steers: [steer('available-again', 'C')], eligibleLiveSteerIds: ['available-again'] }).action, 'reuse');
  for (const cycleKey of ['epoch-5:eligible-route-1:quota-window-2', 'epoch-5:eligible-route-2:quota-window-1', 'epoch-6:eligible-route-1:quota-window-1']) {
    const reopened = reserve({ state, cycleKey, now });
    assert.equal(reopened.action, 'create');
    assert.equal(reopened.state.attempts, 1);
    assert.equal(reopened.state.generation, state.generation + 1);
    assert.equal(reopened.state.exhausted, false);
    assert.ok(!keys.has(reopened.state.idempotencyKey));
  }
});

test('a known pre-dispatch error requires an explicit absent receipt to settle', () => {
  const { state } = reserve();
  const preDispatchFailure = 'Route rejected before dispatch';
  assert.equal(reconcileManagedSteerCreation({ state, preDispatchFailure }).status, 'receipt-unavailable');
  assert.equal(reconcileManagedSteerCreation({ state, receipt: receipt(state, { phase: 'accepted' }), preDispatchFailure }).status, 'receipt-pending');
  assert.equal(reconcileManagedSteerCreation({ state, receipt: null, agent: createdAgent(state), preDispatchFailure }).status, 'receipt-missing');
  const failed = reconcileManagedSteerCreation({ state, receipt: null, preDispatchFailure, now: NOW });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.state.failureReason, preDispatchFailure);
  assert.equal(reserve({ state: failed.state, now: NOW }).reason, 'backoff');
  assert.equal(reserve({ state: failed.state, cycleKey: 'changed', now: NOW }).action, 'create');
});

const ACTIVE = steer('active', 'A', { metadata: {} });
const STANDBY = steer('standby', 'B');

function archive(overrides = {}) {
  return findArchiveCandidates({
    steers: [ACTIVE, STANDBY], activeSlot: 'A', agentEntries: {}, workers: [], permissions: [], stagedBriefs: [],
    pendingReports: [], uncertainOps: [], reservedDeliveries: [], eligibleLiveSteerIds: ['active'], ...overrides,
  });
}

test('archive evaluation returns a managed idle standby and its retained coverage', () => {
  assert.deepEqual(archive(), {
    candidates: [{ agentId: 'standby', coveredBy: 'active', reasons: ['covered-by-eligible-steer'] }],
    kept: [{ agentId: 'active', reasons: ['manual-steer', 'active-authority'] }],
  });
  const result = archive({ eligibleLiveSteerIds: [] });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.kept.find(({ agentId }) => agentId === 'standby').reasons, ['no-eligible-cover']);
});

test('archive evaluation never nominates manual or advisor steers', () => {
  const steers = [ACTIVE, steer('manual', 'B', { metadata: {} }), steer('legacy-advisor', 'C'),
    steer('advisor', 'D', { metadata: { ...STANDBY.metadata, [LABEL.steerRole]: 'advisor' } }),
    steer('manual-marker', 'E', { metadata: { 'wsf.createdBy': 'manual' } })];
  const result = archive({ steers, config: { profiles: { review: { advisor: true } }, steers: { slots: { C: 'review' } } } });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.kept.slice(1).map(({ reasons }) => reasons), [['manual-steer'], ['advisor'], ['advisor'], ['manual-steer']]);
});

const guards = [
  ['active slot', { activeSlot: 'B' }, 'active-authority'],
  ['active holder despite slot mismatch', { activeSlot: { activeSteer: 'A', activeAgentId: 'standby' } }, 'active-authority'],
  ['open assignment', { agentEntries: { standby: { openAssignment: true } } }, 'open-assignment'],
  ['direct worker dependency', { workers: [{ labels: { [PARENT_LABEL]: 'standby' }, status: 'closed' }] }, 'dependent-worker'],
  ['detached worker owner slot', { workers: [{ labels: { [LABEL.owner]: 'B' } }] }, 'dependent-worker'],
  ['continuation parent alias', { workers: [{ parent: 'other', parentContinuedFrom: 'standby' }] }, 'dependent-worker'],
  ['permission', { permissions: ['standby'] }, 'pending-permission'],
  ['staged brief', { stagedBriefs: ['standby'] }, 'staged-brief'],
  ['pending report', { pendingReports: new Set(['standby']) }, 'pending-report'],
  ['uncertain operation', { uncertainOps: ['standby'] }, 'uncertain-operation'],
  ['reserved delivery', { reservedDeliveries: ['standby'] }, 'pending-delivery'],
  ['open turn', { agentEntries: { standby: { openTurnId: 'current', lastTurnId: 'older' } } }, 'not-idle'],
  ['recovery action', { agentEntries: { standby: { action: { phase: 'rewinding' } } } }, 'uncertain-operation'],
  ['staged action', { agentEntries: { standby: { action: { phase: 'staged' } } } }, 'staged-brief'],
  ['staged brief beside another action', { agentEntries: { standby: { action: { phase: 'done' }, stagedBrief: {} } } }, 'staged-brief'],
  ['sent action awaiting reconciliation', { agentEntries: { standby: { action: { phase: 'sent' } } } }, 'pending-delivery'],
  ['unknown authority', { activeSlot: undefined }, 'incomplete-snapshot'],
  ['undefined recorded authority', { activeSlot: { activeSteer: undefined } }, 'incomplete-snapshot'],
  ['unavailable report projection', { pendingReports: null }, 'incomplete-snapshot'],
];

for (const [name, input, reason] of guards) {
  test(`archive guard keeps a standby with ${name}`, () => {
    const result = archive(input);
    assert.deepEqual(result.candidates, []);
    assert.ok(result.kept.find(({ agentId }) => agentId === 'standby').reasons.includes(reason));
  });
}

test('live runtime changes veto a previous archive candidate', () => {
  assert.equal(archive().candidates.length, 1);
  const cases = [
    [{ status: 'running' }, 'not-idle'], [{ status: 'initializing' }, 'not-idle'], [{ status: undefined }, 'not-idle'],
    [{ activeTurn: {} }, 'not-idle'], [{ pendingPermissions: [{}] }, 'pending-permission'], [{ superseded: true }, 'not-live'],
  ];
  for (const [changes, reason] of cases) {
    const result = archive({ steers: [ACTIVE, { ...STANDBY, ...changes }] });
    assert.deepEqual(result.candidates, []);
    assert.ok(result.kept.find(({ agentId }) => agentId === 'standby').reasons.includes(reason));
  }
  assert.equal(archive({
    workers: [{ parent: 'standby', archivedAt: 'today' }, { parent: 'active', owner: 'B' }],
    agentEntries: { standby: { openTurnId: 'ended', lastTurnId: 'ended', action: { phase: 'done' } } },
    pendingReports: ['other'],
  }).candidates.length, 1);
});

test('coverage must be eligible, live, coordinating and in the same scope', () => {
  const alternatives = [
    steer('other-workspace', 'C', { workspaceId: 'elsewhere' }),
    steer('other-scope', 'D', { labels: { ...STANDBY.labels, [LABEL.scope]: 'other' } }),
    steer('closed', 'E', { status: 'closed' }), steer('archived', 'F', { archivedAt: 'today' }),
    steer('advisor', 'G', { advisor: true }), steer('superseded', 'H', { superseded: true }),
  ];
  const result = archive({ steers: [STANDBY, ...alternatives], activeSlot: null, eligibleLiveSteerIds: ['standby', ...alternatives.map(({ id }) => id)] });
  assert.ok(!result.candidates.some(({ agentId }) => agentId === 'standby'));
  assert.equal(result.kept[0].reasons[0], 'retained-for-coverage');
});

test('the result retains coverage when several idle managed steers cover each other', () => {
  const steers = [steer('first', 'A'), steer('second', 'B'), steer('third', 'C')];
  const eligibleLiveSteerIds = steers.map(({ id }) => id);
  const inputs = { steers, activeSlot: null, eligibleLiveSteerIds };
  const before = structuredClone(inputs);
  const result = archive(inputs);
  assert.deepEqual(result.kept, [{ agentId: 'first', reasons: ['retained-for-coverage'] }]);
  assert.deepEqual(result.candidates.map(({ agentId, coveredBy }) => [agentId, coveredBy]), [['second', 'first'], ['third', 'first']]);
  const withBusyCover = archive({ ...inputs, steers: [...steers.slice(0, 2), { ...steers[2], status: 'running' }] });
  assert.deepEqual(withBusyCover.kept, [{ agentId: 'third', reasons: ['not-idle'] }]);
  assert.ok(withBusyCover.candidates.every(({ coveredBy }) => coveredBy === 'third'));
  assert.deepEqual(inputs, before);
});
