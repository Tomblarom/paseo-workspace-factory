import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptSteerAccountMove, reconcileSteerAccountMove } from '../plugin/server/core/steer-account-move.mjs';
import { actionEntry, newSteerAction, reconcileSteerSend } from '../plugin/server/core/steer-action.mjs';
import { AGENTS_KEY } from '../plugin/server/core/agent-state.mjs';
import { LABEL, METADATA_KEY } from '../plugin/server/core/paseo.mjs';

const AT = '2026-11-26T17:00:00.000Z';
function fixture(reply = { outcome: 'moved', reason: null, accountId: 'target', retryable: false }) {
  const agent = { id: 'a', title: 'Steer A', workspaceId: 'w', provider: 'claude', model: 'm', status: 'idle',
    persistence: { sessionId: 'conversation' }, labels: { [LABEL.scope]: 'example/repo', [LABEL.role]: 'steer', [LABEL.slot]: 'A' } };
  const action = { ...newSteerAction({ id: 'delivery', epoch: 3, text: 'work' }),
    authority: { scopeId: 'example/repo', agentId: 'a' } };
  const metadata = { [METADATA_KEY]: { epoch: 3, activeSteer: 'A', scope: { id: 'example/repo' } },
    [AGENTS_KEY]: { a: { action, needsResume: { reason: 'limit', at: AT } } } };
  const observation = { agent, zerosub: { accounts: [{ id: 'source', label: 'Source' }, { id: 'target', label: 'Target' }],
    agentAccount: { a: 'source' }, pending: {} }, row: null };
  let nativeCalls = 0, sends = 0;
  const workspace = { refresh: async () => ({ metadata: structuredClone(metadata) }),
    setMetadata: async (patch) => Object.assign(metadata, structuredClone(patch)) };
  const client = { workspaces: { ref: () => workspace }, agents: {
    list: async () => ({ entries: [agent], pageInfo: { hasMore: false } }),
    ref: () => ({ send: async () => { sends++; } }),
  } };
  // Serial interprocess-lock equivalent, so concurrent claims see persisted state.
  let tail = Promise.resolve();
  const lock = (_name, fn) => {
    const current = tail.then(() => fn({ verify() {} }));
    tail = current.catch(() => {});
    return current;
  };
  const args = { client, workspaceId: 'w', agentId: 'a', actionId: 'delivery', accountId: 'target', lock,
    now: () => AT, readObservation: async () => structuredClone(observation),
    validate: async () => true,
    move: async () => {
      nativeCalls++;
      assert.equal(metadata[AGENTS_KEY].a.action.accountMove.phase, 'uncertain');
      if (reply instanceof Error) throw reply;
      return reply;
    } };
  return { args, metadata, agent, observation, workspace, get nativeCalls() { return nativeCalls; },
    get sends() { return sends; }, action: () => metadata[AGENTS_KEY].a.action,
    land() { observation.zerosub.agentAccount.a = 'target'; },
    row() { observation.row = { family: 'claude', from: 'Source', to: 'Target', at: AT,
      reason: 'near_limit', outcome: 'switched', continued: false, continuedIn: null, toFamily: null }; } };
}

test('a durable move claim wins once, survives restart and blocks ordinary sends until fresh admission', async () => {
  const f = fixture();
  const results = await Promise.all([attemptSteerAccountMove(f.args), attemptSteerAccountMove(f.args)]);
  assert.equal(f.nativeCalls, 1);
  assert.ok(results.every((r) => r.status === 'reconcile'));
  assert.equal((await reconcileSteerSend(f.args)).status, 'pending');
  assert.equal(f.sends, 0);
  f.land();
  // New argument object models a new process; the metadata is the only claim.
  assert.equal((await attemptSteerAccountMove({ ...f.args })).status, 'reconcile');
  assert.equal(f.nativeCalls, 1);
  assert.equal((await reconcileSteerAccountMove({ ...f.args })).status, 'ready');
  assert.equal((await reconcileSteerSend(f.args)).status, 'sent');
  assert.equal((await reconcileSteerSend(f.args)).status, 'sent');
  assert.equal(f.sends, 1);
  assert.equal(f.metadata[AGENTS_KEY].a.needsResume.reason, 'limit');
});

test('lost reply and pending through restart require both live state and a matching switch row', async () => {
  for (const reply of [new Error('reply lost'), { outcome: 'pending', accountId: 'source', reason: 'in_progress', retryable: false }]) {
    const f = fixture(reply);
    await attemptSteerAccountMove(f.args);
    f.land();
    assert.equal((await reconcileSteerAccountMove({ ...f.args })).status, 'pending');
    f.row();
    f.observation.zerosub.pending.a = 'source';
    assert.equal((await reconcileSteerAccountMove(f.args)).status, 'pending');
    delete f.observation.zerosub.pending.a;
    assert.equal((await reconcileSteerAccountMove(f.args)).status, 'ready');
    assert.equal(f.nativeCalls, 1);
    assert.equal(f.sends, 0);
  }
});

test('old rows, duplicated account labels, native continuation and changed conversation cannot settle a lost reply', async () => {
  for (const change of [
    (f) => { f.observation.row.at = '2026-11-26T16:59:59.000Z'; },
    (f) => { f.observation.zerosub.accounts.push({ id: 'other', label: 'Target' }); },
    (f) => { f.observation.row.continued = true; },
    (f) => { f.observation.row.continuedIn = 'other-agent'; },
    (f) => { f.agent.persistence.sessionId = 'different-conversation'; },
    (f) => { f.observation.row.reason = 'manual'; },
    (f) => { f.observation.row.to = 'Elsewhere'; },
    (f) => { f.agent.status = 'closed'; },
    (f) => { f.agent.status = 'running'; },
    (f) => { f.agent.pendingPermissions = [{ id: 'permission' }]; },
  ]) {
    const f = fixture(new Error('reply lost'));
    await attemptSteerAccountMove(f.args);
    f.land(); f.row(); change(f);
    assert.equal((await reconcileSteerAccountMove(f.args)).status, 'pending');
    assert.equal((await reconcileSteerSend(f.args)).status, 'pending');
    assert.equal(f.sends, 0);
  }
});

test('effect-time pin, policy, quota or exact-holder change prevents effects and preserves attempts', async () => {
  const f = fixture();
  assert.equal((await attemptSteerAccountMove({ ...f.args, validate: async () => false })).status, 'blocked');
  assert.equal(f.nativeCalls, 0);
  assert.equal(f.action().accountMove, undefined);
  await attemptSteerAccountMove(f.args); f.land();
  assert.equal((await reconcileSteerAccountMove({ ...f.args, validate: async () => false })).status, 'pending');
  assert.equal(f.action().accountMove.phase, 'uncertain');
  f.agent.model = 'other';
  assert.equal((await reconcileSteerAccountMove(f.args)).status, 'pending');
  f.agent.model = 'm';
  f.metadata[METADATA_KEY].epoch++;
  assert.equal((await reconcileSteerAccountMove(f.args)).status, 'blocked');
  assert.equal((await reconcileSteerSend(f.args)).status, 'pending');
  assert.equal(f.sends, 0);
});

test('scope changed during asynchronous policy validation is rechecked before invoking the RPC', async () => {
  const f = fixture();
  assert.equal((await attemptSteerAccountMove({ ...f.args, validate: async () => {
    f.metadata[METADATA_KEY].epoch++; return true;
  } })).status, 'blocked');
  assert.equal(f.nativeCalls, 0);
});

test('native waiting, pin refusal, unavailable and unsupported settle only for replanning, never a send or repeated move', async () => {
  for (const outcome of ['waiting', 'refused', 'unavailable', 'unsupported']) {
    const f = fixture({ outcome, accountId: 'source', reason: 'user_pinned', retryable: true });
    await attemptSteerAccountMove(f.args);
    assert.equal((await reconcileSteerSend(f.args)).status, 'pending');
    assert.equal((await reconcileSteerAccountMove(f.args)).status, 'replan');
    assert.equal((await reconcileSteerSend(f.args)).status, 'pending');
    await attemptSteerAccountMove(f.args);
    assert.equal(f.nativeCalls, 1);
    assert.equal(f.sends, 0);
  }
});

test('unresolved move cannot be discarded or rebound when assignment/report state changes', async () => {
  const f = fixture(new Error('lost'));
  await attemptSteerAccountMove(f.args);
  const entry = f.metadata[AGENTS_KEY].a;
  assert.throws(() => actionEntry(entry, null), /move needs reconciliation/);
  assert.throws(() => actionEntry(entry, newSteerAction({ id: 'other' })), /move needs reconciliation/);
  const { accountMove, ...withoutMove } = f.action();
  assert.throws(() => actionEntry(entry, withoutMove), /move needs reconciliation/);
  assert.equal(actionEntry(entry, { ...f.action(), phase: 'blocked' }).action.accountMove.accountId, 'target');
});

test('a settled native receipt is immutable for the same delivery', async () => {
  const f = fixture();
  await attemptSteerAccountMove(f.args); f.land();
  await reconcileSteerAccountMove(f.args);
  const entry = f.metadata[AGENTS_KEY].a;
  assert.throws(() => actionEntry(entry, { ...f.action(), accountMove: undefined }), /receipt cannot change/);
  assert.throws(() => actionEntry(entry, { ...f.action(), accountMove: { ...f.action().accountMove, resolution: 'replan' } }), /receipt cannot change/);
  assert.equal(actionEntry(entry, { ...f.action(), phase: 'done' }).action.accountMove.reply.outcome, 'moved');
});

test('verified destination without quota headroom releases reconciliation only for a new route', async () => {
  const f = fixture();
  await attemptSteerAccountMove(f.args); f.land();
  assert.equal((await reconcileSteerAccountMove({ ...f.args,
    validate: async ({ stage, accountId }) => {
      assert.equal(stage, 'reconcile'); assert.equal(accountId, 'target'); return 'replan';
    } })).status, 'replan');
  assert.equal((await reconcileSteerSend(f.args)).status, 'pending');
  assert.equal(f.sends, 0);
  assert.equal(f.action().accountMove.phase, 'settled');
});

test('lost response that landed elsewhere replans only after a matching observation of that runtime', async () => {
  const f = fixture(new Error('lost'));
  await attemptSteerAccountMove(f.args);
  f.observation.zerosub.accounts.push({ id: 'other', label: 'Other' });
  f.observation.zerosub.agentAccount.a = 'other';
  f.row();
  assert.equal((await reconcileSteerAccountMove(f.args)).status, 'pending');
  f.observation.row.to = 'Other';
  assert.equal((await reconcileSteerAccountMove(f.args)).status, 'replan');
  assert.equal((await reconcileSteerSend(f.args)).status, 'pending');
  assert.equal(f.sends, 0);
});

test('crash after native move but before reply persistence recovers without reinvocation', async () => {
  const f = fixture();
  const write = f.workspace.setMetadata;
  let writes = 0;
  f.workspace.setMetadata = async (patch) => {
    if (++writes === 2) throw new Error('process stopped');
    return write(patch);
  };
  await assert.rejects(attemptSteerAccountMove(f.args), /process stopped/);
  assert.equal(f.action().accountMove.reply, undefined);
  f.workspace.setMetadata = write;
  f.land(); f.row();
  assert.equal((await reconcileSteerAccountMove({ ...f.args })).status, 'ready');
  assert.equal(f.nativeCalls, 1);
});
