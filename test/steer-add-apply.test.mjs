// Steer-add apply (src/steer-add.mjs applySteerAdd): stale-preview refusal,
// configuration-change detection, live-slot conflicts and creation recovery.
// Offline only: fake config, catalog, live steers, receipts and executors.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applySteerAdd,
  planSteerAdd,
  SteerAddConflict,
  SteerAddRecovery,
  SteerAddStale,
} from '../plugin/server/core/steer-add.mjs';
import { buildSteerCreate } from '../plugin/server/core/steer-create.mjs';
import { normalizeZerosubState } from '../plugin/server/core/zerosub.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const RESET_5H = '2026-11-24T15:00:00Z';

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
const BASE = { scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW, slot: 'C', epoch: 3 };

// Stable test fingerprint: any input change alters the string.
const fp = (value) => `fp:${JSON.stringify(value)}`;
const noReceipt = async () => null;

function liveSteer(slot, { id = `agent-${slot}`, provider = 'fake-x', model = 'x1' } = {}) {
  return {
    id, archivedAt: null, workspaceId: WORKSPACE, title: `Steer ${slot}`,
    provider, model, status: 'idle',
    labels: { 'wsf.repo': SCOPE, 'wsf.role': 'steer', 'wsf.slot': slot, 'wsf.scope': SCOPE },
  };
}

const LIVE = [liveSteer('A'), liveSteer('B')];

function executor(agentId = 'agent-C-new') {
  const calls = [];
  const configs = [];
  const execute = async (op, config) => {
    calls.push(op);
    configs.push(config);
    return { agentId };
  };
  return { calls, configs, execute };
}

function acc(id, family, pct, { resetsAt = RESET_5H } = {}) {
  return {
    id, family, label: id, kind: 'oauth', plan: 'pro', status: 'active',
    isDefault: false, limitedUntil: null,
    usage: {
      fetchedAt: '2026-11-24T11:59:00Z',
      windows: [{ id: 'five_hour', label: '5h', usedPercent: pct, resetsAt }],
      cached: false,
    },
    agentCount: 0,
  };
}

test('apply creates the planned steer and reports it', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, LIVE, BASE);
  const { calls, configs, execute } = executor();
  const result = await applySteerAdd(CONFIG, PROVIDERS, LIVE, {
    ...BASE, fingerprint: fp(plan.fingerprintInput), fingerprintOf: fp,
    lookupReceipt: noReceipt, execute,
  });
  assert.equal(result.slot, 'C');
  assert.equal(result.agentId, 'agent-C-new');
  assert.equal(result.profile, 'alpha');
  assert.equal(result.applied, true);
  assert.equal(result.reused, false);
  assert.match(result.text, /Steer C created: agent agent-C-new/);
  assert.equal(calls.length, 1);
  assert.equal(configs[0], CONFIG);
  assert.equal(calls[0].params.idempotencyKey, plan.op.params.idempotencyKey);
  assert.deepEqual(calls[0].params.labels, plan.op.params.labels);
});

test('apply rechecks public evidence after preview and keeps the receipt key', async () => {
  const config = structuredClone(CONFIG);
  config.profiles.alpha.sensitive = true;
  const plan = planSteerAdd(config, PROVIDERS, LIVE, { ...BASE, spec: 'alpha', repoPublic: true });
  const fingerprint = fp(plan.fingerprintInput);
  for (const repoPublic of [false, null, undefined]) {
    const { calls, execute } = executor();
    await assert.rejects(applySteerAdd(config, PROVIDERS, LIVE, {
      ...BASE, spec: 'alpha', repoPublic, fingerprint, fingerprintOf: fp, lookupReceipt: noReceipt, execute,
    }), /public scope required/);
    assert.equal(calls.length, 0);
  }
  const { calls, execute } = executor();
  const receipt = { idempotencyKey: plan.op.params.idempotencyKey, phase: 'completed', agentId: 'agent-C-new' };
  const recovered = await applySteerAdd(config, PROVIDERS, LIVE, {
    ...BASE, spec: 'alpha', repoPublic: true, fingerprint, fingerprintOf: fp,
    lookupReceipt: async () => receipt, execute,
  });
  assert.equal(recovered.reused, true);
  assert.equal(calls[0].params.idempotencyKey, receipt.idempotencyKey);
});

test('a completed confirmation cannot recreate a missing agent', async () => {
  const prior = { ...BASE, creationId: 'first' };
  const next = { ...BASE, creationId: 'second' };
  const first = planSteerAdd(CONFIG, PROVIDERS, LIVE, prior);
  const fresh = planSteerAdd(CONFIG, PROVIDERS, LIVE, next);
  const { calls, execute } = executor();
  const completed = first.op.params.idempotencyKey;
  const lookupReceipt = async (_, key) => key === completed ? { idempotencyKey: key, phase: 'completed', agentId: 'gone' } : null;
  const common = { fingerprintOf: fp, lookupReceipt, execute };
  await assert.rejects(applySteerAdd(CONFIG, PROVIDERS, LIVE, {
    ...prior, ...common, fingerprint: fp(first.fingerprintInput),
  }), SteerAddStale);
  assert.equal(calls.length, 0);
  const result = await applySteerAdd(CONFIG, PROVIDERS, LIVE, {
    ...next, ...common, fingerprint: fp(fresh.fingerprintInput),
  });
  assert.equal(result.agentId, 'agent-C-new');
  assert.notEqual(completed, calls[0].params.idempotencyKey);
});

test('apply refuses a tampered fingerprint as stale', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, LIVE, BASE);
  const { execute } = executor();
  await assert.rejects(
    applySteerAdd(CONFIG, PROVIDERS, LIVE, {
      ...BASE, fingerprint: 'fp:tampered', fingerprintOf: fp,
      lookupReceipt: noReceipt, execute,
    }),
    (error) => {
      assert.ok(error instanceof SteerAddStale);
      assert.match(error.message, /Something changed since the steer-add preview/);
      return true;
    },
  );
  await assert.rejects(
    applySteerAdd(CONFIG, PROVIDERS, LIVE, {
      ...BASE, fingerprint: null, fingerprintOf: fp,
      lookupReceipt: noReceipt, execute,
    }),
    SteerAddStale,
  );
});

test('apply detects configuration changes as stale', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, LIVE, BASE);
  const fingerprint = fp(plan.fingerprintInput);
  const { execute } = executor();
  // The picked profile now names another offered model.
  const edited = structuredClone(CONFIG);
  edited.profiles.alpha.model = 'x2';
  await assert.rejects(
    applySteerAdd(edited, PROVIDERS, LIVE, {
      ...BASE, fingerprint, fingerprintOf: fp,
      lookupReceipt: noReceipt, execute,
    }),
    SteerAddStale,
  );
  await assert.rejects(
    applySteerAdd(CONFIG, PROVIDERS, LIVE, {
      ...BASE, epoch: BASE.epoch + 1, fingerprint, fingerprintOf: fp,
      lookupReceipt: noReceipt, execute,
    }),
    SteerAddStale,
  );
});

test('apply refuses a live slot from another request even when the model matches', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, LIVE, BASE);
  const foreign = liveSteer('C', { id: 'agent-foreign' });
  const { calls, execute } = executor();
  const args = {
    ...BASE, fingerprint: fp(plan.fingerprintInput), fingerprintOf: fp, lookupReceipt: noReceipt, execute,
  };
  await assert.rejects(applySteerAdd(CONFIG, PROVIDERS, [...LIVE, foreign], args), SteerAddConflict);
  await assert.rejects(applySteerAdd(CONFIG, PROVIDERS, [...LIVE, foreign, liveSteer('C')], args), /Several live agents/);
  assert.equal(calls.length, 0);
});

test('apply reuses a completed receipt instead of creating again', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, LIVE, BASE);
  const key = plan.op.params.idempotencyKey;
  const receipt = { idempotencyKey: key, phase: 'completed', agentId: 'agent-C-new' };
  const { calls, configs, execute } = executor('agent-C-new');
  const result = await applySteerAdd(CONFIG, PROVIDERS, LIVE, {
    ...BASE, fingerprint: fp(plan.fingerprintInput), fingerprintOf: fp,
    lookupReceipt: async () => receipt, execute,
  });
  assert.equal(result.agentId, 'agent-C-new');
  assert.equal(result.reused, true);
  assert.match(result.text, /reused after receipt/);
  assert.equal(calls.length, 1, 'the identical request is re-sent once');
  assert.equal(configs[0], CONFIG);
  assert.equal(calls[0].params.idempotencyKey, key);
});

test('apply after the creation returns the matching live steer', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, LIVE, BASE);
  const fingerprint = fp(plan.fingerprintInput);
  const key = plan.op.params.idempotencyKey;
  const live = liveSteer('C', { id: 'agent-C-new' });
  // With a receipt naming the live agent: reused, no new creation.
  const { calls, execute } = executor('agent-C-new');
  const receipt = { idempotencyKey: key, phase: 'completed', agentId: 'agent-C-new' };
  const viaReceipt = await applySteerAdd(CONFIG, PROVIDERS, [...LIVE, live], {
    ...BASE, slot: 'C', fingerprint, fingerprintOf: fp,
    lookupReceipt: async () => receipt, execute,
  });
  assert.equal(viaReceipt.agentId, 'agent-C-new');
  assert.equal(viaReceipt.reused, true);
  assert.equal(calls.length, 0);
});

test('legacy preview can replay a completed g1 receipt and cannot start creation', async () => {
  const spec = 'beta';
  const plan = planSteerAdd(CONFIG, PROVIDERS, LIVE, { ...BASE, spec });
  const { generation, epoch, settingsRevision, ...legacyIdentity } = plan.fingerprintInput;
  const { idempotencyKey } = buildSteerCreate({
    keyScope: SCOPE, repo: SCOPE, scopeId: SCOPE, slot: 'C', workspaceId: WORKSPACE,
    profile: plan.profile, keyParts: ['steer', 'C', 'g1'],
  });
  const receipt = { idempotencyKey, phase: 'completed', agentId: 'agent-C-new' };
  const { calls, execute } = executor();
  const args = { ...BASE, spec, fingerprint: fp(legacyIdentity), fingerprintOf: fp, execute };
  await assert.rejects(applySteerAdd(CONFIG, PROVIDERS, LIVE, { ...args, lookupReceipt: noReceipt }), SteerAddStale);
  assert.equal(calls.length, 0);
  const lookupReceipt = async (_, key) => key === idempotencyKey ? receipt : null;
  const result = await applySteerAdd(CONFIG, PROVIDERS, LIVE, { ...args, lookupReceipt });
  assert.equal(result.reused, true);
  assert.equal(calls[0].params.idempotencyKey, idempotencyKey);
  const archived = { ...liveSteer('C', { id: receipt.agentId, provider: 'fake-y', model: 'y1' }), archivedAt: '2026-11-24T10:00:00Z' };
  await assert.rejects(applySteerAdd(CONFIG, PROVIDERS, [...LIVE, archived], { ...args, lookupReceipt }), /Something changed since the steer-add preview/);
});

test('apply stops recovery on ambiguous or failed receipts', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, LIVE, BASE);
  const fingerprint = fp(plan.fingerprintInput);
  const key = plan.op.params.idempotencyKey;
  const { execute } = executor();
  const cases = [
    [{ idempotencyKey: key, phase: 'completed', outcomeUnknown: true }, /unknown outcome/],
    [{ idempotencyKey: key, phase: 'failed', error: 'boom' }, /phase failed/],
    [{ idempotencyKey: 'wsf:other', phase: 'completed', agentId: 'agent-x' }, /different key/],
    [{ idempotencyKey: key, phase: 'completed' }, /names no agent/],
  ];
  for (const [receipt, match] of cases) {
    await assert.rejects(
      applySteerAdd(CONFIG, PROVIDERS, LIVE, {
        ...BASE, fingerprint, fingerprintOf: fp,
        lookupReceipt: async () => receipt, execute,
      }),
      (error) => {
        assert.ok(error instanceof SteerAddRecovery);
        assert.match(error.message, match);
        return true;
      },
    );
  }
  // The identical request answering with another id stops as well.
  const receipt = { idempotencyKey: key, phase: 'completed', agentId: 'agent-C-new' };
  const { execute: wrong } = executor('agent-other');
  await assert.rejects(
    applySteerAdd(CONFIG, PROVIDERS, LIVE, {
      ...BASE, fingerprint, fingerprintOf: fp,
      lookupReceipt: async () => receipt, execute: wrong,
    }),
    /identical request returned agent-other/,
  );
  // A receipt naming another agent than the live occupant stops too.
  const live = liveSteer('C', { id: 'agent-C-live' });
  const { execute: execute2 } = executor();
  await assert.rejects(
    applySteerAdd(CONFIG, PROVIDERS, [...LIVE, live], {
      ...BASE, slot: 'C', fingerprint, fingerprintOf: fp,
      lookupReceipt: async () => receipt, execute: execute2,
    }),
    /already occupied by live steer agent-C-live/,
  );
});

test('apply reports a blocked plan with the earliest reset', async () => {
  const zerosub = normalizeZerosubState(
    { accounts: [acc('acc-x', 'fake-x', 95), acc('acc-y', 'fake-y', 99)], agents: [] },
    { now: NOW },
  );
  const { execute } = executor();
  await assert.rejects(
    applySteerAdd(CONFIG, PROVIDERS, LIVE, {
      ...BASE, zerosub, fingerprint: 'fp:any', fingerprintOf: fp,
      lookupReceipt: noReceipt, execute,
    }),
    (error) => {
      assert.ok(error instanceof SteerAddRecovery);
      assert.match(error.message, /blocked, no startable profile/);
      assert.match(error.message, new RegExp(RESET_5H.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
});

test('apply refuses to create without receipt lookup or executor', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, LIVE, BASE);
  const fingerprint = fp(plan.fingerprintInput);
  const { execute } = executor();
  await assert.rejects(
    applySteerAdd(CONFIG, PROVIDERS, LIVE, { ...BASE, fingerprint, fingerprintOf: fp, execute }),
    /a receipt lookup and an executor are required/,
  );
  await assert.rejects(
    applySteerAdd(CONFIG, PROVIDERS, LIVE, { ...BASE, fingerprint, fingerprintOf: fp, lookupReceipt: noReceipt }),
    /a receipt lookup and an executor are required/,
  );
});
