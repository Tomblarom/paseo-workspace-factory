// Steer-add previews from offline workspace, catalog and quota fixtures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatSteerAddPreview,
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
const BASE = { scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW };

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

test('allocation uses first free live workspace title, including unlabelled and closed holders', () => {
  const renamed = liveSteer('B', { title: 'Research notes' });
  const closed = { ...liveSteer('C', { title: '▷ Steer C · runtime' }), labels: {}, status: 'closed' };
  const elsewhere = { ...liveSteer('A'), id: 'other-workspace-a', workspaceId: 'another-workspace' };
  const child = { ...liveSteer('A'), id: 'worker-a', labels: { 'paseo.parent-agent-id': 'parent-id' } };
  assert.equal(planSteerAdd(CONFIG, PROVIDERS, [renamed, closed, elsewhere, child], BASE).slot, 'A');
  assert.equal(planSteerAdd(CONFIG, PROVIDERS, [liveSteer('A'), renamed, closed], BASE).slot, 'B');
  assert.equal(planSteerAdd(CONFIG, PROVIDERS, [liveSteer('A'), liveSteer('B'), closed], BASE).slot, 'D');
});

test('allocation refuses duplicate titles and honors a resolved continuation', () => {
  const origin = liveSteer('A');
  const duplicate = { ...liveSteer('A', { id: 'duplicate' }), labels: {} };
  assert.throws(() => planSteerAdd(CONFIG, PROVIDERS, [origin, duplicate], BASE), /Several live agents are titled Steer A/);
  const continuation = { ...liveSteer('A', { id: 'continuation', title: 'Continuation' }), continuedFrom: origin.id };
  assert.equal(planSteerAdd(CONFIG, PROVIDERS, [origin, continuation], { ...BASE, resolvedSteers: [continuation] }).slot, 'B');
});

test('plan uses role priority and leaves host preferences untouched', () => {
  const config = structuredClone(CONFIG);
  config.steers.priority = ['gamma', 'alpha'];
  const before = structuredClone(config);
  const plan = planSteerAdd(config, PROVIDERS, [], BASE);
  assert.deepEqual(config, before);
  assert.equal(plan.slot, 'A');
  assert.equal(plan.profileName, 'gamma');
  assert.equal(plan.config, undefined);
  assert.equal(plan.op.kind, 'paseo.agent.create');
  assert.equal(plan.op.params.workspaceId, WORKSPACE);
  assert.equal(plan.op.params.title, 'Steer A');
  assert.deepEqual(plan.op.params.labels, { 'wsf.repo': SCOPE, 'wsf.role': 'steer', 'wsf.slot': 'A', 'wsf.scope': SCOPE });
  assert.match(plan.op.params.idempotencyKey, /^wsf:/);
  assert.deepEqual(plan.op.params.metadata, { 'wsf.steer-role': 'coordinator' });
  assert.equal(plan.fingerprintInput.slot, 'A');
});

test('plan validates slot normalization, gaps, vacancy, occupied and full', () => {
  assert.equal(planSteerAdd(CONFIG, PROVIDERS, [], { ...BASE, slot: 'a' }).slot, 'A');
  assert.throws(() => planSteerAdd(CONFIG, PROVIDERS, [], { ...BASE, slot: 'B' }), /next free letter A/);
  assert.throws(() => planSteerAdd(CONFIG, PROVIDERS, [], { ...BASE, activeSlot: 'A' }), /Active Steer A has no live holder/);
  assert.throws(() => planSteerAdd(CONFIG, PROVIDERS, [liveSteer('A')], { ...BASE, slot: 'A' }), /already occupied by live steer/);
  for (const bad of ['AA', '1']) {
    assert.throws(() => planSteerAdd(CONFIG, PROVIDERS, [], { ...BASE, slot: bad }), /single capital letter A-Z/);
  }
  const full = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((slot) => liveSteer(slot));
  assert.throws(() => planSteerAdd(CONFIG, PROVIDERS, full, BASE), /all letters A-Z are occupied/);
});

test('planSteerAdd with an explicit profile tries it alone and infers advisor', () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], { spec: 'beta', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(plan.slot, 'A');
  assert.equal(plan.profileName, 'beta');
  assert.equal(plan.advisorSlot, false);
  const tagged = structuredClone(CONFIG);
  tagged.profiles.gamma.advisor = true;
  const advisor = planSteerAdd(tagged, PROVIDERS, [], { spec: 'gamma', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(advisor.profileName, 'gamma');
  assert.equal(advisor.advisorSlot, true);
  assert.equal(advisor.op.params.steerRole, 'advisor', 'creation persists the role without a host slot binding');
  assert.match(advisor.notes.join('; '), /advisor, never active/);
  assert.throws(() => planSteerAdd(CONFIG, PROVIDERS, [], { spec: 'missing', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW }), /Unknown profile "missing"/);
});

test('steer-add preview checks privacy for automatic, explicit and provider/model requests', () => {
  const config = structuredClone(CONFIG);
  config.profiles.alpha.sensitive = true;
  config.steers.priority = ['alpha'];
  const base = { scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW };
  for (const repoPublic of [false, null, undefined]) {
    for (const selection of [{ slot: 'A' }, { spec: 'alpha' }, { slot: 'A', spec: 'fake-x/x1' }]) {
      const plan = planSteerAdd(config, PROVIDERS, [], { ...base, ...selection, repoPublic });
      assert.equal(plan.profile, null);
      assert.equal(plan.op, null);
      assert.match(plan.skipped[0].reason, /public scope required/);
    }
  }
  assert.equal(planSteerAdd(config, PROVIDERS, [], { ...base, spec: 'alpha', repoPublic: true }).profile.name, 'alpha');
});

test('new muse provider/model does not reuse an explicitly non-sensitive profile', () => {
  const config = structuredClone(CONFIG);
  config.profiles.optedOut = { provider: 'muse', model: 'm', sensitive: false };
  const providers = [...PROVIDERS, { provider: 'muse', enabled: true, status: 'ready', models: [{ id: 'm' }] }];
  const blocked = planSteerAdd(config, providers, [], { spec: 'muse/m' });
  assert.equal(blocked.profile, null);
  assert.match(blocked.skipped[0].reason, /public scope required/);
  const publicPlan = planSteerAdd(config, providers, [], { spec: 'muse/m', repoPublic: true });
  assert.equal(publicPlan.profileName, 'muse-m');
});

test('planSteerAdd with provider/model creates, reuses and blocks on catalog', () => {
  const extended = [
    { provider: 'fake-x', enabled: true, status: 'ready', models: [{ id: 'x1' }, { id: 'x2' }, { id: 'x9' }] },
    PROVIDERS[1],
  ];
  const created = planSteerAdd(CONFIG, extended, [], { spec: 'fake-x/x9', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(created.profileName, 'fake-x-x9');
  assert.equal(created.op.params.config.provider, 'fake-x/x9');
  assert.equal(CONFIG.profiles['fake-x-x9'], undefined);
  const reused = planSteerAdd(CONFIG, PROVIDERS, [], { spec: 'fake-x/x1', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(reused.profileName, 'alpha');
  assert.match(reused.notes.join('; '), /Using matching profile "alpha"/);
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
  const plan = planSteerAdd(config, providers, [], { slot: 'A', spec: 'fake-y/y2', profile: 'alpha', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(plan.profileName, 'alpha');
  assert.equal(plan.op.params.config.provider, 'fake-y/y2');
  assert.equal(config.profiles.alpha.provider, 'fake-x');
  assert.equal(plan.profile.mode ?? null, null);
  assert.match(plan.notes.join('; '), /Mode "full-access" of profile "alpha" not carried over to fake-y/);
  assert.match(plan.notes.join('; '), /Thinking "high" of profile "alpha" not carried over/);
  assert.equal(plan.op.params.config.modeId, undefined);
  // An explicit --mode wins; the same provider keeps a still valid mode.
  const explicit = planSteerAdd(config, providers, [], { slot: 'A', spec: 'fake-y/y2', profile: 'alpha', mode: 'bypassPermissions', scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(explicit.op.params.config.modeId, 'bypassPermissions');
  const sameProvider = buildCandidate(config.profiles.alpha, 'fake-x', 'x1', undefined, undefined, { providerEntries: providers, notes: [] });
  assert.equal(sameProvider.mode, 'full-access');
  assert.equal(sameProvider.thinking, 'high');
});

test('planSteerAdd uses the roomiest account as quota evidence without pinning', () => {
  const zerosub = state([
    acc('acc-roomy', 'fake-x', 20),
    acc('acc-full', 'fake-x', 10, { status: 'limited', limitedUntil: RESET_5H }),
    acc('acc-high', 'fake-x', 60),
  ]);
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], { spec: 'alpha', zerosub, scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(plan.zerosubAccount, 'acc-roomy');
  assert.equal(plan.op.params.metadata['zerosub.account'], undefined);
  const changed = planSteerAdd(CONFIG, PROVIDERS, [], {
    spec: 'alpha', zerosub: state([acc('another-account', 'fake-x', 10)]),
    scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW,
  });
  assert.notEqual(changed.zerosubAccount, plan.zerosubAccount);
  assert.deepEqual(changed.fingerprintInput, plan.fingerprintInput);
  assert.equal(changed.op.params.idempotencyKey, plan.op.params.idempotencyKey);
});

test('planSteerAdd uses exhaustion, not warning, for all profile selection paths', () => {
  for (const spec of [null, 'alpha', 'fake-x/x1']) {
    for (const [pct, eligible] of [[93, true], [94, true], [95, false]]) {
      const zerosub = state([acc('acc-x', 'fake-x', pct)]);
      const plan = planSteerAdd(CONFIG, PROVIDERS, [], {
        spec, slot: 'A', zerosub, scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW,
      });
      assert.equal(plan.profile?.name === 'alpha', eligible, `${spec}: ${pct}%`);
      if (eligible) assert.equal(plan.zerosubAccount, 'acc-x');
    }
  }
});

test('planSteerAdd reports all accounts exhausted with the earliest reset', () => {
  const zerosub = state([
    acc('acc-x', 'fake-x', 95, { resetsAt: RESET_LATE }),
    acc('acc-y', 'fake-y', 99, { resetsAt: RESET_5H }),
  ]);
  const blocked = planSteerAdd(CONFIG, PROVIDERS, [], { zerosub, scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(blocked.profile, null);
  assert.equal(blocked.op, null);
  assert.equal(blocked.skipped.length, 3);
  assert.ok(blocked.skipped.every((s) => s.reason.startsWith('accounts exhausted')));
  assert.equal(blocked.earliestReset, RESET_5H);
  const unknown = state([acc('acc-x', 'fake-x', 95, { resetsAt: null })]);
  const bare = planSteerAdd(CONFIG, PROVIDERS, [], { spec: 'alpha', zerosub: unknown, scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  assert.equal(bare.skipped[0].reason, 'accounts exhausted');
  assert.equal(bare.earliestReset, null);
});

test('an archived holder does not contribute to a new creation key', () => {
  const first = planSteerAdd(CONFIG, PROVIDERS, [], { ...BASE, creationId: "first" });
  const old = { ...liveSteer('A'), archivedAt: '2026-11-24T10:00:00Z' };
  const second = planSteerAdd(CONFIG, PROVIDERS, [old], { ...BASE, creationId: "second" });
  assert.equal(second.slot, first.slot);
  assert.notEqual(second.fingerprintInput.generation, first.fingerprintInput.generation);
  assert.notEqual(second.op.params.idempotencyKey, first.op.params.idempotencyKey);
  assert.equal(planSteerAdd(CONFIG, PROVIDERS, [], { ...BASE, creationId: "second" }).op.params.idempotencyKey, second.op.params.idempotencyKey);
});

test('formatSteerAddPreview names slot, profile, account, skips and the op', () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], { scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  const text = formatSteerAddPreview(plan, { scopeId: SCOPE });
  assert.match(text, /Steer add A for Test\/scope/);
  assert.match(text, /profile "alpha"/);
  assert.match(text, /Create Steer A/);
  assert.match(text, new RegExp(plan.op.params.idempotencyKey));
  assert.match(text, /Confirm to create the standby/);
  const zerosub = state([acc('acc-x', 'fake-x', 95, { resetsAt: RESET_5H })]);
  const blocked = planSteerAdd(CONFIG, PROVIDERS, [], { spec: 'alpha', zerosub, scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW });
  const blockedText = formatSteerAddPreview(blocked, { scopeId: SCOPE });
  assert.match(blockedText, /blocked, no startable profile/);
  assert.match(blockedText, new RegExp(RESET_5H.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
