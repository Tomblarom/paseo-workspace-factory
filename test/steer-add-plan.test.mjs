// Steer-add core planning (plugin/server/core/steer-add.mjs): slot classification with exact
// label IDs/roles, free-slot suggestion across config+live, pure preview (no
// live config writes), retryable create op with stable idempotency key and
// ZeroSub pin metadata. Offline only: fake config, catalog, live steers and
// ZeroSub state, no live RPC.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifySteerSlot,
  formatSteerAddPreview,
  liveSteerForSlot,
  nextFreeSlotForAdd,
  planSteerAdd,
} from '../plugin/server/core/steer-add.mjs';
import { normalizeZerosubState } from '../plugin/server/core/zerosub.mjs';
import { buildCandidate } from '../plugin/server/core/models.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const RESET_5H = '2026-11-24T15:00:00Z';
const RESET_LATE = '2026-11-24T18:00:00Z';
const PAST = '2026-11-20T12:00:00Z';

const CONFIG = {
  version: 1,
  github: { owner: 'Test', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/tmp/test',
  workspaceTitle: 'Main',
  profiles: {
    alpha: { provider: 'fake-x', model: 'x1' },
    beta: { provider: 'fake-y', model: 'y1' },
    gamma: { provider: 'fake-x', model: 'x2' },
  },
  steers: { slots: { A: 'alpha', B: 'beta' }, prepare: ['A', 'B'], initialActive: 'A' },
};

const PROVIDERS = [
  { provider: 'fake-x', enabled: true, status: 'ready', models: [{ id: 'x1' }, { id: 'x2' }] },
  { provider: 'fake-y', enabled: true, status: 'ready', models: [{ id: 'y1' }] },
];

const SCOPE = 'Test/scope';
const WORKSPACE = 'wks_test123';

function liveSteer(slot, { id = `agent-${slot}`, scope = SCOPE, role = 'steer', archivedAt = null, provider = 'fake-x', model = 'x1', title = `Steer ${slot}` } = {}) {
  return {
    id, archivedAt, workspaceId: WORKSPACE, title, provider, model, status: 'idle',
    labels: { 'wsf.repo': scope, 'wsf.role': role, 'wsf.slot': slot, 'wsf.scope': scope },
  };
}

function acc(id, family, pct, { resetsAt = RESET_5H, status = 'active', limitedUntil = null } = {}) {
  return {
    id, family, label: id, kind: 'oauth', plan: 'pro',
    status, isDefault: false, limitedUntil,
    usage: {
      fetchedAt: '2026-11-24T11:59:00Z',
      windows: pct === null ? [] : [{ id: 'five_hour', label: '5h', usedPercent: pct, resetsAt }],
      cached: false,
    },
    agentCount: 0,
  };
}

function state(accounts) {
  return normalizeZerosubState({ accounts, agents: [] }, { now: NOW });
}

test('liveSteerForSlot uses exact labels and ignores titles, archived and foreign scopes', () => {
  const agents = [
    liveSteer('C', { id: 'agent-live' }),
    liveSteer('C', { id: 'agent-archived', archivedAt: '2026-11-24T10:00:00Z' }),
    liveSteer('C', { id: 'agent-worker', role: 'worker' }),
    liveSteer('C', { id: 'agent-foreign', scope: 'Other/scope' }),
    { id: 'agent-title-only', archivedAt: null, title: 'Steer C', labels: {}, provider: 'fake-x', model: 'x1' },
  ];
  const found = liveSteerForSlot(agents, 'C', SCOPE);
  assert.equal(found?.id, 'agent-live');
  assert.equal(liveSteerForSlot(agents, 'D', SCOPE), null);
  assert.equal(liveSteerForSlot(agents, 'c', SCOPE), null, 'slot match is exact uppercase');
});

test('classifySteerSlot distinguishes free, configured-unprovisioned, live-occupied and drift', () => {
  assert.equal(classifySteerSlot(CONFIG, [], 'C', SCOPE).state, 'free');
  assert.equal(classifySteerSlot(CONFIG, [], 'A', SCOPE).state, 'configured-unprovisioned');
  assert.equal(classifySteerSlot(CONFIG, [liveSteer('A')], 'A', SCOPE).state, 'live-occupied');
  assert.equal(classifySteerSlot(CONFIG, [liveSteer('C')], 'C', SCOPE).state, 'live-unconfigured');
  const classified = classifySteerSlot(CONFIG, [liveSteer('A')], 'A', SCOPE);
  assert.equal(classified.configuredProfile, 'alpha');
  assert.equal(classified.live?.id, 'agent-A');
});

test('nextFreeSlotForAdd skips configured and live-occupied letters', () => {
  assert.equal(nextFreeSlotForAdd(CONFIG, [], SCOPE), 'C');
  assert.equal(nextFreeSlotForAdd(CONFIG, [liveSteer('C')], SCOPE), 'D');
  assert.equal(nextFreeSlotForAdd({ steers: { slots: {} } }, [liveSteer('A'), liveSteer('B')], SCOPE), 'C');
  const full = {};
  for (let i = 0; i < 26; i++) full[String.fromCharCode(65 + i)] = 'alpha';
  assert.equal(nextFreeSlotForAdd({ ...CONFIG, steers: { slots: full, prepare: ['A'], initialActive: 'A' } }, [], SCOPE), null);
});

test('planSteerAdd auto slot and profile leaves the input config untouched', () => {
  const before = structuredClone(CONFIG);
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], { scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.deepEqual(CONFIG, before, 'preview writes no live config');
  assert.equal(plan.slot, 'C');
  assert.equal(plan.profileName, 'alpha');
  assert.equal(plan.isNewSlot, true);
  assert.equal(plan.isNewProfile, false);
  assert.deepEqual(plan.config.steers.slots.C, 'alpha');
  assert.deepEqual(plan.config.steers.prepare, CONFIG.steers.prepare, 'adding a steer to this scope does not change the default slots for other scopes');
  assert.equal(plan.config.steers.initialActive, 'A', 'activation stays with switch/resume');
  assert.equal(plan.op.kind, 'paseo.agent.create');
  assert.equal(plan.op.params.workspaceId, WORKSPACE);
  assert.equal(plan.op.params.title, 'Steer C');
  assert.deepEqual(plan.op.params.labels, { 'wsf.repo': SCOPE, 'wsf.role': 'steer', 'wsf.slot': 'C', 'wsf.scope': SCOPE });
  assert.match(plan.op.params.idempotencyKey, /^wsf:/);
  assert.equal(plan.op.params.metadata, undefined, 'no ZeroSub pin without state');
  assert.ok(plan.fingerprintInput);
  assert.equal(plan.fingerprintInput.slot, 'C');
});

test('planSteerAdd refuses live-occupied slots and allows configured-unprovisioned retries', () => {
  assert.throws(
    () => planSteerAdd(CONFIG, PROVIDERS, [liveSteer('A', { id: 'agent-live-a' })], { slot: 'A', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW }),
    /Slot A is already occupied by live steer agent-live-a.*steer set A .* or fresh/,
  );
  assert.throws(
    () => planSteerAdd(CONFIG, PROVIDERS, [liveSteer('C')], { slot: 'C', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW }),
    /already occupied by live steer/,
  );
  const retry = planSteerAdd(CONFIG, PROVIDERS, [], { slot: 'A', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(retry.slot, 'A');
  assert.equal(retry.profileName, 'alpha');
  assert.match(retry.notes.join('; '), /configured but has no live steer/);
  assert.equal(retry.isNewSlot, false);
});

test('planSteerAdd validates slots: normalization, gaps, invalid and full', () => {
  assert.equal(planSteerAdd(CONFIG, PROVIDERS, [], { slot: 'c', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW }).slot, 'C');
  assert.throws(
    () => planSteerAdd(CONFIG, PROVIDERS, [], { slot: 'D', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW }),
    /would leave a gap.*next free letter C/,
  );
  // Live unconfigured steers occupy their letters: the suggested next free letter is accepted.
  const live = [liveSteer('C')];
  assert.equal(planSteerAdd(CONFIG, PROVIDERS, live, { slot: 'D', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW }).slot, 'D');
  assert.throws(
    () => planSteerAdd(CONFIG, PROVIDERS, live, { slot: 'E', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW }),
    /would leave a gap.*next free letter D/,
  );
  for (const bad of ['AA', '1']) {
    assert.throws(() => planSteerAdd(CONFIG, PROVIDERS, [], { slot: bad, scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW }), /single capital letter A-Z/, String(bad));
  }
  const full = {};
  for (let i = 0; i < 26; i++) full[String.fromCharCode(65 + i)] = 'alpha';
  const fullConfig = { ...CONFIG, steers: { slots: full, prepare: ['A'], initialActive: 'A' } };
  assert.throws(() => planSteerAdd(fullConfig, PROVIDERS, [], { scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW }), /all letters A-Z are defined or occupied/);
});

test('planSteerAdd with an explicit profile tries it alone and infers advisor', () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], { spec: 'beta', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(plan.slot, 'C');
  assert.equal(plan.profileName, 'beta');
  assert.equal(plan.advisorSlot, false);
  const tagged = structuredClone(CONFIG);
  tagged.profiles.gamma.advisor = true;
  const advisor = planSteerAdd(tagged, PROVIDERS, [], { spec: 'gamma', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(advisor.profileName, 'gamma');
  assert.equal(advisor.advisorSlot, true);
  assert.match(advisor.notes.join('; '), /advisor, never active/);
  assert.throws(() => planSteerAdd(CONFIG, PROVIDERS, [], { spec: 'missing', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW }), /Unknown profile "missing"/);
});

test('planSteerAdd with provider/model creates, reuses and blocks on catalog', () => {
  const extended = [
    { provider: 'fake-x', enabled: true, status: 'ready', models: [{ id: 'x1' }, { id: 'x2' }, { id: 'x9' }] },
    PROVIDERS[1],
  ];
  const created = planSteerAdd(CONFIG, extended, [], { spec: 'fake-x/x9', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(created.profileName, 'fake-x-x9');
  assert.equal(created.isNewProfile, true);
  assert.equal(created.config.profiles['fake-x-x9'].model, 'x9');
  const reused = planSteerAdd(CONFIG, PROVIDERS, [], { spec: 'fake-x/x1', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(reused.profileName, 'alpha');
  assert.equal(reused.isNewProfile, false);
  assert.match(reused.notes.join('; '), /Reusing existing profile "alpha"/);
  const blocked = planSteerAdd(CONFIG, PROVIDERS, [], { spec: 'fake-x/missing', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(blocked.profile, null);
  assert.equal(blocked.op, null);
  assert.match(blocked.skipped[0].reason, /not offered/);
});

test('planSteerAdd model override drops mode/thinking the new provider does not offer', () => {
  const config = structuredClone(CONFIG);
  config.profiles.alpha = { provider: 'fake-x', model: 'x1', thinking: 'high', mode: 'full-access' };
  const providers = [
    { provider: 'fake-x', enabled: true, status: 'ready', models: [{ id: 'x1', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'full-access' }] },
    { provider: 'fake-y', enabled: true, status: 'ready', models: [{ id: 'y1' }, { id: 'y2', thinkingOptions: [{ id: 'max' }] }], modes: [{ id: 'bypassPermissions' }] },
  ];
  // Slot A is configured with alpha but has no live steer: the override
  // rewrites alpha in place for fake-y.
  const plan = planSteerAdd(config, providers, [], { slot: 'A', spec: 'fake-y/y2', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(plan.profileName, 'alpha');
  assert.deepEqual(plan.config.profiles.alpha, { provider: 'fake-y', model: 'y2', thinking: null });
  assert.equal(plan.profile.mode ?? null, null);
  assert.match(plan.notes.join('; '), /Mode "full-access" of profile "alpha" not carried over to fake-y/);
  assert.match(plan.notes.join('; '), /Thinking "high" of profile "alpha" not carried over/);
  assert.equal(plan.op.params.config.modeId, undefined);
  // An explicit --mode wins; the same provider keeps a still valid mode.
  const explicit = planSteerAdd(config, providers, [], { slot: 'A', spec: 'fake-y/y2', mode: 'bypassPermissions', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(explicit.op.params.config.modeId, 'bypassPermissions');
  const sameProvider = buildCandidate(config.profiles.alpha, 'fake-x', 'x1', undefined, undefined, { providerEntries: providers, notes: [] });
  assert.equal(sameProvider.mode, 'full-access');
  assert.equal(sameProvider.thinking, 'high');
});

test('planSteerAdd pins the roomiest ZeroSub account below warn as creation metadata', () => {
  const zerosub = state([
    acc('acc-roomy', 'fake-x', 20),
    acc('acc-full', 'fake-x', 10, { status: 'limited', limitedUntil: RESET_5H }),
    acc('acc-high', 'fake-x', 60),
  ]);
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], { spec: 'alpha', zerosub, scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(plan.zerosubAccount, 'acc-roomy');
  assert.deepEqual(plan.op.params.metadata, { 'zerosub.account': 'acc-roomy' });
  assert.equal(plan.fingerprintInput.account, 'acc-roomy');
});

test('planSteerAdd reports all accounts exhausted with the earliest reset', () => {
  const zerosub = state([
    acc('acc-x', 'fake-x', 80, { resetsAt: RESET_LATE }),
    acc('acc-y', 'fake-y', 90, { resetsAt: RESET_5H }),
  ]);
  const blocked = planSteerAdd(CONFIG, PROVIDERS, [], { zerosub, scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(blocked.profile, null);
  assert.equal(blocked.op, null);
  assert.equal(blocked.skipped.length, 3);
  assert.ok(blocked.skipped.every((s) => s.reason.startsWith('accounts over warn threshold')));
  assert.equal(blocked.earliestReset, RESET_5H);
  const unknown = state([acc('acc-x', 'fake-x', 80, { resetsAt: null })]);
  const bare = planSteerAdd(CONFIG, PROVIDERS, [], { spec: 'alpha', zerosub: unknown, scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(bare.skipped[0].reason, 'accounts over warn threshold (≥75%)');
  assert.equal(bare.earliestReset, null);
});

test('planSteerAdd is retryable: same inputs reuse the idempotency key across the config save', () => {
  const first = planSteerAdd(CONFIG, PROVIDERS, [], { scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  const second = planSteerAdd(CONFIG, PROVIDERS, [], { scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(first.op.params.idempotencyKey, second.op.params.idempotencyKey);
  const afterSave = planSteerAdd(first.config, PROVIDERS, [], { slot: 'C', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(afterSave.slot, 'C');
  assert.equal(afterSave.op.params.idempotencyKey, first.op.params.idempotencyKey, 'configured-unprovisioned retry reuses the key');
});

test('formatSteerAddPreview names slot, profile, account, skips and the op', () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], { scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  const text = formatSteerAddPreview(plan, { scopeId: SCOPE });
  assert.match(text, /Steer add C for Test\/scope/);
  assert.match(text, /profile "alpha"/);
  assert.match(text, /steer slots:/);
  assert.match(text, new RegExp(plan.op.params.idempotencyKey));
  assert.match(text, /Nothing written/);
  const zerosub = state([acc('acc-x', 'fake-x', 80, { resetsAt: RESET_5H })]);
  const blocked = planSteerAdd(CONFIG, PROVIDERS, [], { spec: 'alpha', zerosub, scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  const blockedText = formatSteerAddPreview(blocked, { scopeId: SCOPE });
  assert.match(blockedText, /blocked, no startable profile/);
  assert.match(blockedText, new RegExp(RESET_5H.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
