import test from 'node:test';
import assert from 'node:assert/strict';
import { actionEntry, newSteerAction, readSteerAction, reconcileSteerSend } from '../src/steer-action.mjs';
import { AGENTS_KEY } from '../src/agent-state.mjs';
import { METADATA_KEY } from '../src/paseo.mjs';
import { ACTION_FACTS, actionFact, mergeActionFacts } from '../src/action-facts.mjs';

const lock = (_name, fn) => fn({ verify() {} });
function fixture() {
  const action = newSteerAction({ id: 'message-1', epoch: 3, text: 'exact payload', options: { activeTurnBehavior: 'steer' }, batch: { workspaceId: 'w', epoch: 3, events: [{ workerId: 'worker', state: 'done', queuedAt: 'event-time' }] } });
  const metadata = { [METADATA_KEY]: { epoch: 3 }, [AGENTS_KEY]: { a: { action } } };
  const requests = [];
  const workspace = { refresh: async () => ({ metadata: structuredClone(metadata) }), setMetadata: async (patch) => Object.assign(metadata, structuredClone(patch)) };
  let send = async (packet, options) => { requests.push({ packet, options }); };
  const client = { workspaces: { ref: () => workspace }, agents: { ref: () => ({ send: (...args) => send(...args) }) } };
  return { client, metadata, requests, action, setSend: (fn) => { send = fn; } };
}
const reconcile = (f) => reconcileSteerSend({ client: f.client, workspaceId: 'w', agentId: 'a', actionId: 'message-1', lock });

test('intent and immutable attempt precede the first effect', async () => {
  const f = fixture();
  f.setSend(async (packet, options) => {
    const current = f.metadata[AGENTS_KEY].a.action;
    assert.equal(current.phase, 'uncertain');
    assert.ok(current.attemptedAt);
    assert.equal(current.batch.events[0].queuedAt, 'event-time');
    assert.equal(packet, current.packet);
    assert.deepEqual(options, { messageId: 'message-1', activeTurnBehavior: 'steer' });
  });
  assert.equal((await reconcile(f)).status, 'sent');
  assert.equal(f.metadata[AGENTS_KEY].a.action.phase, 'sent');
});

test('lost response and pending receipt never start a second turn', async () => {
  const f = fixture();
  let turns = 0;
  let admitted = false;
  const calls = [];
  f.setSend(async (packet, options) => {
    calls.push({ packet, options });
    if (!admitted) { admitted = true; turns++; throw Error('connection lost'); }
    if (calls.length === 2) throw Error('agent_request_outcome_unknown');
  });
  assert.equal((await reconcile(f)).status, 'uncertain');
  assert.equal((await reconcile(f)).status, 'uncertain');
  assert.equal((await reconcile(f)).status, 'sent');
  assert.equal((await reconcile(f)).status, 'sent');
  assert.equal(turns, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[1], calls[2]);
});

test('missing intent and changed scope cannot dispatch', async () => {
  const f = fixture();
  delete f.metadata[AGENTS_KEY].a.action;
  assert.equal((await reconcile(f)).status, 'missing');
  f.metadata[AGENTS_KEY].a.action = f.action;
  f.metadata[METADATA_KEY].epoch = 4;
  assert.equal((await reconcile(f)).status, 'blocked');
  assert.equal(f.requests.length, 0);
});

test('legacy pending delivery, stage and last receipt are decoded and old keys removed on write', () => {
  const old = { pendingWakeBrief: { wakeId: 'old', note: 'wake', events: [{ workerId: 'w', state: 'done' }], epoch: 3 }, pendingAction: { kind: 'clear' }, stagedBrief: { packet: 'other', at: 't', kind: 'switch' }, lastSteerDeliveryId: 'last' };
  const action = readSteerAction(old, 'ws');
  assert.equal(action.phase, 'renewing');
  assert.equal(action.legacyStage.packet, 'other');
  assert.equal(action.batch.workspaceId, 'ws');
  const migrated = actionEntry(old, action);
  assert.equal(migrated.pendingWakeBrief, undefined);
  assert.equal(migrated.stagedBrief, undefined);
  assert.equal(migrated.lastSteerDeliveryId, undefined);
  assert.equal(migrated.pendingAction, undefined);
  assert.equal(migrated.action.cleanup.kind, 'clear');
  assert.equal(readSteerAction({ lastSteerDeliveryId: 'last' }, 'ws').phase, 'done');
  assert.equal(readSteerAction({ stagedBrief: { packet: 'p' } }, 'ws').phase, 'staged');
});

test('disconnect after native admission but before the sent write replays the same request', async () => {
  const f = fixture();
  const originalWorkspace = f.client.workspaces.ref;
  const workspace = originalWorkspace();
  const write = workspace.setMetadata;
  let calls = 0;
  workspace.setMetadata = async (patch) => {
    calls++;
    if (calls === 2) throw new Error('metadata disconnected');
    return write(patch);
  };
  f.client.workspaces.ref = () => workspace;
  const receipts = new Map();
  let turns = 0;
  f.setSend(async (text, options) => {
    f.requests.push({ text, options });
    if (!receipts.has(options.messageId)) { receipts.set(options.messageId, text); turns++; }
  });
  await assert.rejects(reconcile(f), /metadata disconnected/);
  assert.equal(f.metadata[AGENTS_KEY].a.action.phase, 'uncertain');
  assert.equal((await reconcile(f)).status, 'sent');
  assert.equal(turns, 1);
  assert.deepEqual(f.requests[0], f.requests[1]);
});

test('legacy cleanup and facts migrate once and survive action replacement', () => {
  const legacy = { pendingAction: { kind: 'clear', at: 't', messageId: 'm' }, cleared: { mode: 'rewind', at: 'old' }, actionVerified: true, lastActionFailed: null, refreshed: { briefMessageId: 'b' }, freshHint: { at: 't', reason: 'large' } };
  const action = readSteerAction(legacy, 'w');
  const migrated = actionEntry(legacy, action);
  for (const key of ['pendingAction', ...ACTION_FACTS]) assert.equal(Object.hasOwn(migrated, key), false);
  assert.equal(migrated.action.cleanup.messageId, 'm');
  assert.equal(actionFact(migrated, 'refreshed').briefMessageId, 'b');
  const again = mergeActionFacts(migrated, { action: { kind: 'delivery', wakeId: 'new', phase: 'ready' } });
  assert.equal(actionFact(again, 'cleared').mode, 'rewind');
  assert.deepEqual(mergeActionFacts(again, {}), again);
});
