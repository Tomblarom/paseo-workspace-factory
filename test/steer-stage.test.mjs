// Staged and efficient delivery (step 3): fresh/switch send exactly one brief
// to the destination and zero prompts to the outgoing agent on the efficient
// path (send/notifyPrevious flags), stage-only applies return the packet
// without sending, and failed sends keep the packet for a retry. Fake state
// only; no daemon.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS_KEY } from '../plugin/server/core/agent-state.mjs';
import { CHECKPOINT_KEY, freshSteer, switchSteer } from '../plugin/server/core/steer.mjs';
import { withLock } from '../plugin/server/core/lock.mjs';
import { LABEL, METADATA_KEY } from '../plugin/server/core/paseo.mjs';

// ---------------------------------------------------------------- fixtures

const REPO = 'example-owner/example-repo';
const CONFIG = {
  version: 1,
  github: { owner: 'example-owner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    standard: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
  },
  steers: { slots: { A: 'standard', B: 'standard' }, prepare: ['A', 'B'], initialActive: 'A' },
  workers: { defaultProfile: 'standard' },
};
const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'full-access' }] },
];

function makeWorld() {
  return { workspaces: [], agents: [], providers: structuredClone(PROVIDERS), calls: [], receipts: new Map(), fingerprints: new Map(), seq: 0, sendFails: false, rewindSends: [] };
}

function addWorkspace(world, { metadata, title = 'Main' }) {
  const ws = { id: `wks_${String(++world.seq).padStart(4, '0')}`, projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout', title, name: title, metadata: structuredClone(metadata), createdAt: new Date().toISOString() };
  world.workspaces.push(ws);
  return ws;
}

function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, lastUsage: null, ...fields };
  world.agents.push(agent);
  return agent;
}

function provisioned(world, { checkpoint = null } = {}) {
  const metadata = { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } };
  if (checkpoint) metadata[CHECKPOINT_KEY] = structuredClone(checkpoint);
  const ws = addWorkspace(world, { metadata });
  const steers = {
    A: addAgent(world, { provider: 'codex', model: 'gpt-6.2-sol', title: 'Steer A', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'A' } }),
    B: addAgent(world, { provider: 'codex', model: 'gpt-6.2-sol', title: 'Steer B', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'B' } }),
  };
  return { ws, steers };
}

function discoveryOf(world, extra = {}) {
  return {
    forkName: REPO,
    mainWorkspace: world.workspaces[0] ? structuredClone(world.workspaces[0]) : null,
    steers: { labelled: structuredClone(world.agents.filter((a) => a.labels?.[LABEL.role] === 'steer')), legacy: [], digitCandidates: [] },
    workers: [],
    agents: structuredClone(world.agents),
    providers: structuredClone(world.providers),
    ...extra,
  };
}

function fakePaseoCli(world) {
  return (args) => {
    assert.deepEqual(args.slice(0, 2), ['agent', 'update']);
    assert.equal(args[3], '--name');
    world.agents.find((agent) => agent.id === args[2]).title = args[4];
  };
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  const agentHandle = (id) => ({
    id,
    refresh: async () => ({ agent: structuredClone(findAgent(id)) }),
    archive: async () => {
      world.calls.push(['agent.archive', id]);
      if (world.hooks?.archiveFails) throw new Error('archive failed');
      const archivedAt = '2026-11-25T00:00:00Z';
      findAgent(id).archivedAt = archivedAt;
      return { archivedAt };
    },
    send: async (text) => {
      world.calls.push(['agent.send', id, text]);
      if (world.sendFails) throw new Error('agent unreachable');
    },
    waitForFinish: async () => { world.calls.push(['agent.waitForFinish', id]); },
    timeline: { refetch: async () => ({ entries: [{ item: { type: 'assistant_message', text: 'Done.' } }] }) },
  });
  const workspaceHandle = (id) => ({
    id,
    refresh: async () => structuredClone(findWs(id)),
    setMetadata: async (patch) => {
      world.calls.push(['workspace.setMetadata', id, patch]);
      Object.assign(findWs(id).metadata, structuredClone(patch));
    },
    agents: {
      create: async (opts) => {
        world.calls.push(['agent.create', opts]);
        const fingerprint = JSON.stringify({ ...opts, idempotencyKey: undefined });
        if (opts.idempotencyKey && world.receipts.has(opts.idempotencyKey)) {
          if (world.fingerprints.get(opts.idempotencyKey) !== fingerprint) throw new Error('agent_request_key_conflict');
          return agentHandle(world.receipts.get(opts.idempotencyKey));
        }
        const slash = opts.config.provider.indexOf('/');
        const agent = addAgent(world, {
          provider: opts.config.provider.slice(0, slash), model: opts.config.provider.slice(slash + 1),
          title: opts.title, workspaceId: id, labels: { ...opts.labels },
        });
        if (opts.idempotencyKey) {
          world.receipts.set(opts.idempotencyKey, agent.id);
          world.fingerprints.set(opts.idempotencyKey, fingerprint);
        }
        return agentHandle(agent.id);
      },
    },
  });
  return { workspaces: { ref: workspaceHandle }, agents: { ref: agentHandle, list: async () => ({ entries: structuredClone(world.agents), pageInfo: { hasMore: false } }) } };
}

function fakeLookup(world) {
  return async (kind, key) => {
    if (!world.receipts.has(key)) return null;
    const id = world.receipts.get(key);
    return { kind, idempotencyKey: key, phase: 'completed', error: null, agentId: id, workspaceId: world.agents.find((a) => a.id === id)?.workspaceId ?? null };
  };
}

function fakeRewindClient(world, { point = 'msg-1' } = {}) {
  return async () => ({
    fetchAgentTimeline: async () => ({ entries: [{ item: { type: 'user_message', messageId: point } }] }),
    rewindAgent: async () => {},
    sendMessage: async (agentId, text, opts) => {
      world.rewindSends.push([agentId, text, opts]);
    },
    close: async () => {},
  });
}

const fakeGit = () => (cwd, args) => {
  if (args[0] === 'rev-parse') return args.includes('--abbrev-ref') ? 'main' : 'a1b2c3d4e5f6a7b8c9d0';
  if (args[0] === 'status') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
};

const LOCK_TMP = mkdtempSync(join(tmpdir(), 'wsf-steer-stage-'));
const testLock = (name, fn) => withLock(name, fn, { dir: LOCK_TMP });
const sendsTo = (world, id) => world.calls.filter((c) => c[0] === 'agent.send' && c[1] === id).map((c) => c[2]);

// ---------------------------------------------------------------- switch

test('switch delegates delivery after the epoch changes and waits for the delivered brief', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const applied = await switchSteer({
    client: fakeClient(world), discovery: discoveryOf(world), toSlot: 'B', apply: true,
    wait: true, waitTimeoutMs: 1000, lock: testLock, callerId: null, language: 'en', config: CONFIG,
    deliverSteer: async (input) => {
      assert.equal(input.epoch, 2);
      assert.equal(input.agentId, steers.B.id);
      assert.equal(ws.metadata[METADATA_KEY].activeSteer, 'B');
      assert.match(input.renewalNote, /Handoff from Steer A to Steer B/);
      // The clear hook can confirm delivery before the RPC result comes back.
      ws.metadata['wsf.agents'] = { [steers.B.id]: { action: { kind: 'delivery', wakeId: 'handoff-id', phase: 'done' } } };
      return { status: 'pending', deliveryId: 'handoff-id' };
    },
  });
  assert.equal(applied.delivered, true);
  assert.equal(applied.deliveryPending, false);
  assert.equal(applied.reply, 'Done.');
  assert.deepEqual(sendsTo(world, steers.B.id), []);
  assert.ok(world.calls.some(([kind, id]) => kind === 'agent.waitForFinish' && id === steers.B.id));
});

test('switch sends one brief to the destination and none to the outgoing steer', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const applied = await switchSteer({
    client: fakeClient(world), discovery: discoveryOf(world), toSlot: 'B', apply: true,
    git: fakeGit(), lock: testLock, callerId: null, language: 'en', config: CONFIG,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.delivered, true);
  assert.equal(applied.previousNotified, false);
  assert.deepEqual(sendsTo(world, steers.B.id).length, 1);
  assert.match(sendsTo(world, steers.B.id)[0], /Steer handoff for example-owner\/example-repo/);
  assert.deepEqual(sendsTo(world, steers.A.id), [], 'zero prompts to the outgoing steer');
});

test('switch keeps the opt-in notice to the outgoing steer', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const applied = await switchSteer({
    client: fakeClient(world), discovery: discoveryOf(world), toSlot: 'B', apply: true,
    notifyPrevious: true, git: fakeGit(), lock: testLock, callerId: null, language: 'en', config: CONFIG,
  });
  assert.equal(applied.previousNotified, true);
  assert.deepEqual(sendsTo(world, steers.B.id).length, 1);
  assert.deepEqual(sendsTo(world, steers.A.id).length, 1);
});

test('switch with send:false applies without sending and returns the packet', async () => {
  const world = makeWorld();
  provisioned(world);
  const applied = await switchSteer({
    client: fakeClient(world), discovery: discoveryOf(world), toSlot: 'B', apply: true,
    send: false, git: fakeGit(), lock: testLock, callerId: null, language: 'en', config: CONFIG,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.delivered, false);
  assert.equal(applied.deliveryError, null);
  assert.match(applied.packet, /Steer handoff for example-owner\/example-repo/);
  assert.deepEqual(world.calls.filter((c) => c[0] === 'agent.send'), []);
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].activeSteer, 'B');
});

test('switch returns the identity committed with the staged handoff', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const applied = await switchSteer({
    client: fakeClient(world), discovery: discoveryOf(world), toSlot: 'B', apply: true,
    stage: true, send: false, git: fakeGit(), lock: testLock, callerId: null, language: 'en', config: CONFIG,
  });
  const stage = world.workspaces[0].metadata[AGENTS_KEY][steers.B.id].action;
  assert.equal(stage.phase, 'staged');
  assert.equal(applied.stageId, stage.wakeId);
  assert.equal(applied.epoch, stage.epoch);
  assert.deepEqual(sendsTo(world, steers.B.id), []);
});

test('switch supersedes an unused standby reset stage and keeps its prior delivery receipt', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  ws.metadata[AGENTS_KEY] = { [steers.B.id]: { action: {
    kind: 'stage', stageKind: 'fresh', phase: 'staged', wakeId: 'old-stage', epoch: 1,
    lastDeliveryId: 'prior-send', packet: 'Old reset brief',
  } } };
  const applied = await switchSteer({
    client: fakeClient(world), discovery: discoveryOf(world), toSlot: 'B', apply: true,
    stage: true, send: false, lock: testLock, language: 'en', config: CONFIG,
  });
  const action = ws.metadata[AGENTS_KEY][steers.B.id].action;
  assert.equal(applied.applied, true);
  assert.equal(applied.stageId, action.wakeId);
  assert.notEqual(action.wakeId, 'old-stage');
  assert.equal(action.lastDeliveryId, 'prior-send');
  assert.equal(action.epoch, 2);
  assert.match(action.packet, /Steer handoff/);
  assert.deepEqual(sendsTo(world, steers.B.id), []);
});

test('switch preserves pending deliveries and stages with unresolved composer transfer', async (t) => {
  const staged = { kind: 'stage', phase: 'staged', wakeId: 'standby-stage', epoch: 1, packet: 'Reset brief' };
  const claimed = { ...staged, composerClaim: { id: 'claim', recoveryId: 'recovery' } };
  const cases = {
    queued: { action: { ...staged, phase: 'reserved' } },
    attempted: { action: { ...staged, attemptedAt: '2026-11-26T11:58:00Z' } },
    uncertain: { action: { ...staged, phase: 'uncertain' } },
    claimed: { action: claimed },
    retainedClaim: { action: { phase: 'done', wakeId: 'worker-wake' }, stagedBrief: { ...claimed, epoch: 0 } },
    reopenedClaim: { action: { ...staged, manualComposerOnly: true } },
  };
  for (const [name, entry] of Object.entries(cases)) {
    await t.test(name, async () => {
      const world = makeWorld();
      const { ws, steers } = provisioned(world);
      ws.metadata[AGENTS_KEY] = { [steers.B.id]: structuredClone(entry) };
      await assert.rejects(switchSteer({
        client: fakeClient(world), discovery: discoveryOf(world), toSlot: 'B', apply: true,
        stage: true, send: false, lock: testLock, language: 'en', config: CONFIG,
      }), /Target has a pending steer delivery/);
      assert.deepEqual(ws.metadata[AGENTS_KEY][steers.B.id], entry);
      assert.equal(ws.metadata[METADATA_KEY].epoch, 1);
      assert.deepEqual(world.calls, []);
    });
  }
});

test('switch keeps the receipt for a stage already transferred to the composer', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const composerTransfer = { stageId: 'transferred-stage', claimId: 'claim', epoch: 1 };
  ws.metadata[AGENTS_KEY] = { [steers.B.id]: { composerTransfer } };
  const applied = await switchSteer({
    client: fakeClient(world), discovery: discoveryOf(world), toSlot: 'B', apply: true,
    stage: true, send: false, lock: testLock, language: 'en', config: CONFIG,
  });
  assert.equal(applied.applied, true);
  assert.deepEqual(ws.metadata[AGENTS_KEY][steers.B.id].composerTransfer, composerTransfer);
});

test('switch keeps the packet when the send fails (partial apply)', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  world.sendFails = true;
  const applied = await switchSteer({
    client: fakeClient(world), discovery: discoveryOf(world), toSlot: 'B', apply: true,
    git: fakeGit(), lock: testLock, callerId: null, language: 'en', config: CONFIG,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.delivered, false);
  assert.match(applied.deliveryError, /agent unreachable/);
  assert.match(applied.packet, /Steer handoff for example-owner\/example-repo/);
  assert.deepEqual(sendsTo(world, steers.B.id).length, 1, 'exactly one attempt');
  assert.deepEqual(sendsTo(world, steers.A.id), []);
});

// ---------------------------------------------------------------- fresh (new agent)

test('fresh sends one brief to the new agent and archives the source without sending to it', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const applied = await freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(world),
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true,
    notifyPrevious: false, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en',
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.refreshMode, 'new-agent');
  assert.equal(applied.delivered, true);
  assert.equal(applied.previousNotified, false);
  assert.ok(applied.to && applied.to !== steers.A.id);
  assert.deepEqual(sendsTo(world, applied.to).length, 1);
  assert.deepEqual(sendsTo(world, steers.A.id), [], 'zero prompts to the outgoing agent');
});

test('fresh with send:false creates without sending and returns the packet', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const applied = await freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(world),
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true,
    send: false, notifyPrevious: false, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en',
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.delivered, false);
  assert.equal(applied.deliveryError, null);
  assert.ok(applied.packet.length > 0);
  assert.deepEqual(world.calls.filter((c) => c[0] === 'agent.send'), []);
  assert.notEqual(applied.to, steers.A.id);
});

test('fresh --slot honors send:false and notifyPrevious:false', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const applied = await freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(world),
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', apply: true,
    send: false, notifyPrevious: false, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en',
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.delivered, false);
  assert.equal(applied.previousNotified, false);
  assert.deepEqual(world.calls.filter((c) => c[0] === 'agent.send'), []);
  assert.notEqual(applied.to, steers.B.id);
});

test('fresh keeps the packet when the send fails (partial apply)', async () => {
  const world = makeWorld();
  provisioned(world);
  world.sendFails = true;
  const applied = await freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(world),
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true,
    git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en',
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.delivered, false);
  assert.match(applied.deliveryError, /agent unreachable/);
  assert.ok(applied.packet.length > 0);
});

// ---------------------------------------------------------------- fresh (rewind)

test('fresh rewind with send:false rewinds without a brief send', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const applied = await freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(world),
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true,
    send: false, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world),
    rewindClient: fakeRewindClient(world), language: 'en',
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.refreshMode, 'rewind');
  assert.equal(applied.from, steers.A.id);
  assert.equal(applied.to, steers.A.id);
  assert.equal(applied.delivered, false);
  assert.equal(applied.deliveryError, null);
  assert.match(applied.packet, /keeps agent .* in the same tab/);
  assert.deepEqual(world.rewindSends, [], 'no brief through the daemon client');
  assert.deepEqual(world.calls.filter((c) => c[0] === 'agent.send'), []);
});

test('fresh rewind still briefs by default', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const applied = await freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(world),
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true,
    git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world),
    rewindClient: fakeRewindClient(world), language: 'en',
  });
  assert.equal(applied.refreshMode, 'rewind');
  assert.equal(applied.delivered, true);
  assert.deepEqual(world.rewindSends.map((s) => s[0]), [steers.A.id]);
});

// ---------------------------------------------------------------- dry-run binding fields

test('dry runs carry the confirmation binding fields', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world, {
    checkpoint: { task: 'ship it', tests: [], blockers: [], next: null, epoch: 1, updatedAt: '2026-11-25T10:00:00.000Z', capturedAt: '2026-11-25T10:00:00.000Z' },
  });
  const client = fakeClient(world);
  const dry = await switchSteer({
    client, discovery: discoveryOf(world), toSlot: 'B', git: fakeGit(), lock: testLock, callerId: null, language: 'en', config: CONFIG,
  });
  assert.equal(dry.workspaceId, ws.id);
  assert.equal(dry.fromId, steers.A.id);
  assert.equal(dry.toId, steers.B.id);
  assert.equal(dry.checkpointAt, '2026-11-25T10:00:00.000Z');
  const fresh = await freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(world),
    client, discovery: discoveryOf(world), config: CONFIG, git: fakeGit(), lock: testLock, language: 'en',
  });
  assert.equal(fresh.workspaceId, ws.id);
  assert.equal(fresh.from, steers.A.id);
  assert.equal(fresh.refreshMode, 'new-agent');
  assert.equal(fresh.provider, 'codex');
  assert.equal(fresh.model, 'gpt-6.2-sol');
  assert.equal(fresh.checkpointAt, '2026-11-25T10:00:00.000Z');
});

test('switch commits the target handoff intent in the epoch write before delivery', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const result = await switchSteer({
    client: fakeClient(world), discovery: discoveryOf(world), toSlot: 'B', apply: true,
    lock: testLock, config: CONFIG, language: 'en',
    deliverSteer: async () => { throw new Error('connection lost after epoch commit'); },
  });
  const write = world.calls.find(([op, , patch]) => op === 'workspace.setMetadata' && patch[METADATA_KEY]?.epoch === 2);
  assert.equal(write[2]['wsf.agents'][steers.B.id].action.phase, 'reserved');
  assert.equal(write[2]['wsf.agents'][steers.B.id].action.packet, result.packet);
  assert.equal(ws.metadata['wsf.agents'][steers.B.id].action.phase, 'reserved');
  assert.match(result.deliveryError, /connection lost/);
  assert.equal(sendsTo(world, steers.B.id).length, 0);
});
