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
} from '../src/steer-add.mjs';
import { normalizeZerosubState } from '../src/zerosub.mjs';

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
const BASE = { scopeId: SCOPE, workspaceId: WORKSPACE, repo: SCOPE, now: NOW };

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

function executor(agentId = 'agent-C-new') {
  const calls = [];
  const execute = async (op) => {
    calls.push(op);
    return { agentId };
  };
  return { calls, execute };
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
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], BASE);
  const { calls, execute } = executor();
  const result = await applySteerAdd(CONFIG, PROVIDERS, [], {
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
  assert.equal(calls[0].params.idempotencyKey, plan.op.params.idempotencyKey);
  assert.deepEqual(calls[0].params.labels, plan.op.params.labels);
});

test('apply after the settings save provisions with the same key', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], BASE);
  const { calls, execute } = executor();
  const result = await applySteerAdd(plan.config, PROVIDERS, [], {
    ...BASE, slot: 'C', fingerprint: fp(plan.fingerprintInput), fingerprintOf: fp,
    lookupReceipt: noReceipt, execute,
  });
  assert.equal(result.agentId, 'agent-C-new');
  assert.equal(calls[0].params.idempotencyKey, plan.op.params.idempotencyKey);
});

test('apply refuses a tampered fingerprint as stale', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], BASE);
  const { execute } = executor();
  await assert.rejects(
    applySteerAdd(CONFIG, PROVIDERS, [], {
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
    applySteerAdd(CONFIG, PROVIDERS, [], {
      ...BASE, fingerprint: null, fingerprintOf: fp,
      lookupReceipt: noReceipt, execute,
    }),
    SteerAddStale,
  );
});

test('apply detects configuration changes as stale', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], BASE);
  const fingerprint = fp(plan.fingerprintInput);
  const { execute } = executor();
  // The picked profile now names another offered model.
  const edited = structuredClone(CONFIG);
  edited.profiles.alpha.model = 'x2';
  await assert.rejects(
    applySteerAdd(edited, PROVIDERS, [], {
      ...BASE, fingerprint, fingerprintOf: fp,
      lookupReceipt: noReceipt, execute,
    }),
    SteerAddStale,
  );
  // Someone else configured slot C with another profile meanwhile.
  const taken = structuredClone(CONFIG);
  taken.steers.slots.C = 'beta';
  taken.steers.prepare.push('C');
  await assert.rejects(
    applySteerAdd(taken, PROVIDERS, [], {
      ...BASE, slot: 'C', fingerprint, fingerprintOf: fp,
      lookupReceipt: noReceipt, execute,
    }),
    SteerAddStale,
  );
});

test('apply refuses a live slot from another request as conflict', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], BASE);
  const fingerprint = fp(plan.fingerprintInput);
  const { calls, execute } = executor();
  const foreign = liveSteer('C', { id: 'agent-foreign', provider: 'fake-y', model: 'y1' });
  await assert.rejects(
    applySteerAdd(CONFIG, PROVIDERS, [foreign], {
      ...BASE, slot: 'C', fingerprint, fingerprintOf: fp,
      lookupReceipt: noReceipt, execute,
    }),
    (error) => {
      assert.ok(error instanceof SteerAddConflict);
      assert.match(error.message, /already occupied by live steer agent-foreign/);
      assert.match(error.message, /without a configured slot/);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'no creation on conflict');
  // A configured slot with a foreign live steer points at steer set/fresh.
  const { calls: calls2, execute: execute2 } = executor();
  await assert.rejects(
    applySteerAdd(plan.config, PROVIDERS, [foreign], {
      ...BASE, slot: 'C', fingerprint, fingerprintOf: fp,
      lookupReceipt: noReceipt, execute: execute2,
    }),
    (error) => {
      assert.ok(error instanceof SteerAddConflict);
      assert.match(error.message, /already occupied by live steer agent-foreign/);
      assert.match(error.message, /steer set C .* or fresh/);
      return true;
    },
  );
  assert.equal(calls2.length, 0, 'no creation on conflict');
});

test('apply reuses a completed receipt instead of creating again', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], BASE);
  const key = plan.op.params.idempotencyKey;
  const receipt = { idempotencyKey: key, phase: 'completed', agentId: 'agent-C-new' };
  const { calls, execute } = executor('agent-C-new');
  const result = await applySteerAdd(CONFIG, PROVIDERS, [], {
    ...BASE, fingerprint: fp(plan.fingerprintInput), fingerprintOf: fp,
    lookupReceipt: async () => receipt, execute,
  });
  assert.equal(result.agentId, 'agent-C-new');
  assert.equal(result.reused, true);
  assert.match(result.text, /reused after receipt/);
  assert.equal(calls.length, 1, 'the identical request is re-sent once');
  assert.equal(calls[0].params.idempotencyKey, key);
});

test('apply after the creation returns the matching live steer', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], BASE);
  const fingerprint = fp(plan.fingerprintInput);
  const key = plan.op.params.idempotencyKey;
  const live = liveSteer('C', { id: 'agent-C-new' });
  const savedConfig = plan.config;
  // With a receipt naming the live agent: reused, no new creation.
  const { calls, execute } = executor('agent-C-new');
  const receipt = { idempotencyKey: key, phase: 'completed', agentId: 'agent-C-new' };
  const viaReceipt = await applySteerAdd(savedConfig, PROVIDERS, [live], {
    ...BASE, slot: 'C', fingerprint, fingerprintOf: fp,
    lookupReceipt: async () => receipt, execute,
  });
  assert.equal(viaReceipt.agentId, 'agent-C-new');
  assert.equal(viaReceipt.reused, true);
  assert.equal(calls.length, 0);
  // Without a receipt the exact label/model match still converges.
  const { calls: calls2, execute: execute2 } = executor();
  const viaLive = await applySteerAdd(savedConfig, PROVIDERS, [live], {
    ...BASE, slot: 'C', fingerprint, fingerprintOf: fp,
    lookupReceipt: noReceipt, execute: execute2,
  });
  assert.equal(viaLive.agentId, 'agent-C-new');
  assert.match(viaLive.text, /already provisioned/);
  assert.equal(calls2.length, 0);
});

test('apply stops recovery on ambiguous or failed receipts', async () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], BASE);
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
      applySteerAdd(CONFIG, PROVIDERS, [], {
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
    applySteerAdd(CONFIG, PROVIDERS, [], {
      ...BASE, fingerprint, fingerprintOf: fp,
      lookupReceipt: async () => receipt, execute: wrong,
    }),
    /identical request returned agent-other/,
  );
  // A receipt naming another agent than the live occupant stops too.
  const live = liveSteer('C', { id: 'agent-C-live' });
  const { execute: execute2 } = executor();
  await assert.rejects(
    applySteerAdd(plan.config, PROVIDERS, [live], {
      ...BASE, slot: 'C', fingerprint, fingerprintOf: fp,
      lookupReceipt: async () => receipt, execute: execute2,
    }),
    /receipt names agent-C-new but agent-C-live is live/,
  );
});

test('apply reports a blocked plan with the earliest reset', async () => {
  const zerosub = normalizeZerosubState(
    { accounts: [acc('acc-x', 'fake-x', 80), acc('acc-y', 'fake-y', 90)], agents: [] },
    { now: NOW },
  );
  const { execute } = executor();
  await assert.rejects(
    applySteerAdd(CONFIG, PROVIDERS, [], {
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
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], BASE);
  const fingerprint = fp(plan.fingerprintInput);
  const { execute } = executor();
  await assert.rejects(
    applySteerAdd(CONFIG, PROVIDERS, [], { ...BASE, fingerprint, fingerprintOf: fp, execute }),
    /needs a receipt lookup and an executor/,
  );
  await assert.rejects(
    applySteerAdd(CONFIG, PROVIDERS, [], { ...BASE, fingerprint, fingerprintOf: fp, lookupReceipt: noReceipt }),
    /needs a receipt lookup and an executor/,
  );
});
