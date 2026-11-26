import test from 'node:test';
import assert from 'node:assert/strict';
import { moveZerosubBeforeLimit, MOVE_BEFORE_LIMIT_RPC } from '../plugin/server/core/zerosub.mjs';
import { planRoutes } from '../plugin/server/core/routing.mjs';

function fake(reply, error = null, closeError = false) {
  const calls = [];
  let closed = 0;
  return {
    calls, get closed() { return closed; },
    async createClient() {
      return {
        async invokePluginRpc(...args) { calls.push(args); if (error) throw error; return reply; },
        async close() { closed++; if (closeError) throw new Error('close failed'); },
      };
    },
  };
}

function run(client) {
  return moveZerosubBeforeLimit({ agentId: 'holder', accountId: 'target', url: 'ws://fake', cliPath: '/fake', createClient: client.createClient });
}

const response = (outcome, extra = {}) => ({ outcome, reason: null, retryable: false, accountId: 'target', ...extra });

test('one native move preserves pins and background work; the adapter never sends work', async () => {
  const client = fake(response('moved'));
  assert.deepEqual(await run(client), response('moved'));
  assert.deepEqual(client.calls, [['zerosub', MOVE_BEFORE_LIMIT_RPC, {
    agentId: 'holder', accountId: 'target', stopBackgroundWork: false,
  }]]);
  assert.equal(client.closed, 1);
});

test('old ZeroSub unknown-method disables only the move alternative', async () => {
  const client = fake(null, new Error(`Unknown RPC method: ${MOVE_BEFORE_LIMIT_RPC}`));
  const result = await run(client);
  assert.equal(result.outcome, 'unsupported');
  assert.equal(result.retryable, false);
  const plan = planRoutes({ due: true, candidates: [
    { id: 'move', kind: 'move', eligible: result.outcome !== 'unsupported', reason: result.reason },
    { id: 'handover', kind: 'handover', eligible: true },
  ] });
  assert.equal(plan.selected.kind, 'handover');
  assert.equal(client.calls.length, 1);
  assert.equal(client.closed, 1);
});

test('lost replies and pending moves require reconciliation and are not retried', async () => {
  for (const client of [fake(null, new Error('connection reset')), fake(response('pending', { accountId: 'source' }))]) {
    const result = await run(client);
    assert.ok(['uncertain', 'pending'].includes(result.outcome));
    assert.equal(client.calls.length, 1);
  }
});

test('connection failure proves no move was invoked; missing ids fail before connecting', async () => {
  let connections = 0;
  const createClient = async () => { connections++; throw new Error('offline'); };
  const result = await moveZerosubBeforeLimit({ agentId: 'holder', accountId: 'target', url: 'ws://fake', cliPath: '/fake', createClient });
  assert.equal(result.outcome, 'unavailable');
  await assert.rejects(() => moveZerosubBeforeLimit({ agentId: 'holder', createClient }), /needs agentId and accountId/);
  assert.equal(connections, 1);
});

test('busy/background waiting is retryable without queuing or stopping anything', async () => {
  for (const [reason, waitingFor] of [['busy_turn', 'turn'], ['background_work', 'background']]) {
    const client = fake(response('waiting', { reason, waitingFor, retryable: true, accountId: 'source' }));
    const result = await run(client);
    assert.equal(result.outcome, 'waiting');
    assert.equal(result.reason, reason);
    assert.equal(result.retryable, true);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0][2].stopBackgroundWork, false);
  }
});

test('native guards remain authoritative for a pin arriving after preview or unavailable targets', async () => {
  for (const reason of ['user_pinned', 'auto_switch_off', 'ineligible_target', 'unsupported_provider', 'landed_elsewhere']) {
    const client = fake(response('refused', { reason, accountId: 'source' }));
    const result = await run(client);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.reason, reason);
    assert.equal(result.accountId, 'source');
    assert.equal(client.calls.length, 1);
  }
});

test('legacy waiting, unknown replies and mismatched accounts never confirm a move', async () => {
  for (const raw of [
    null, { outcome: 'waiting' }, response('waiting'), response('unknown'),
    response('moved', { accountId: 'elsewhere' }), response('already', { accountId: null }),
    response('moved', { reason: 'future_reason' }),
  ]) {
    assert.equal((await run(fake(raw))).outcome, 'uncertain');
  }
  const refused = await run(fake(response('refused', { reason: 'future_reason', retryable: true })));
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.retryable, false);
});

test('already-on-account is explicit and cleanup failures do not hide the native result', async () => {
  assert.equal((await run(fake(response('already'), null, true))).outcome, 'already');
});
