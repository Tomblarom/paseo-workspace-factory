// P1 open-turn tracking and restart marking: pure decision plus fake-client
// integration (open turn before/after the daemon start, no duplicate on a
// second boot check). Fakes only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGENTS_KEY, buildRestartInterrupted, flagCheckpointInterrupted,
  isOpenTurnBeforeRestart, updateAgentEntry,
} from '../src/agent-state.mjs';
import { LABEL, METADATA_KEY } from '../src/paseo.mjs';
import { CHECKPOINT_KEY } from '../src/steer.mjs';

const DAEMON = '2026-11-23T11:00:00.000Z';
const BEFORE = '2026-11-23T10:00:00.000Z';
const AFTER = '2026-11-23T12:00:00.000Z';
const NOW = '2026-11-23T12:30:00.000Z';

function makeWorld() {
  return { workspaces: [], seq: 0, calls: [] };
}
function addWorkspace(world, { metadata }) {
  const ws = {
    id: `wks_${String(++world.seq).padStart(4, '0')}`,
    projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout',
    title: 'Main', name: 'Main', metadata: structuredClone(metadata), createdAt: NOW,
  };
  world.workspaces.push(ws);
  return ws;
}
function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  return {
    workspaces: {
      ref: (id) => ({
        refresh: async () => structuredClone(findWs(id)),
        setMetadata: async (patch) => {
          world.calls.push(['workspace.setMetadata', id, Object.keys(patch)]);
          Object.assign(findWs(id).metadata, structuredClone(patch));
        },
      }),
    },
  };
}
const noLock = (_name, fn) => fn({ verify() {} });

function provisioned(world, entry) {
  const metadata = {
    [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 3 },
    [CHECKPOINT_KEY]: { task: 'Ship it', tests: [], blockers: [], next: null, epoch: 3, updatedAt: BEFORE, source: 'manual', capturedAt: BEFORE, interrupted: null },
    [AGENTS_KEY]: { 'agent-1': entry },
  };
  return addWorkspace(world, { metadata });
}

// Mimics one boot-check pass for a single entry: mark when the open turn
// predates the daemon start, then clear the open fields. Returns true when marked.
async function bootPass({ client, workspaceId, agentId, daemonStartedAt, at }) {
  const entry = (await client.workspaces.ref(workspaceId).refresh())?.metadata?.[AGENTS_KEY]?.[agentId] ?? null;
  if (!isOpenTurnBeforeRestart(entry, daemonStartedAt)) return false;
  const interrupted = buildRestartInterrupted({ at, reason: 'daemon-restart', error: 'daemon restarted during turn', excerpt: null, git: null });
  await updateAgentEntry({
    client, workspaceId, agentId, lock: noLock,
    patch: {
      lastTurnId: entry.openTurnId ?? entry.lastTurnId ?? null,
      lastTurnEndedAt: at, outcome: 'canceled',
      openTurnId: null, turnStartedAt: null, interrupted,
    },
  });
  await flagCheckpointInterrupted({ client, workspaceId, agentId, at, reason: 'daemon-restart', lock: noLock });
  return true;
}

test('isOpenTurnBeforeRestart compares turn start with daemon start', () => {
  assert.equal(isOpenTurnBeforeRestart({ openTurnId: 't1', turnStartedAt: BEFORE }, DAEMON), true);
  assert.equal(isOpenTurnBeforeRestart({ openTurnId: 't1', turnStartedAt: AFTER }, DAEMON), false);
  assert.equal(isOpenTurnBeforeRestart({ openTurnId: 't1', turnStartedAt: DAEMON }, DAEMON), false);
  assert.equal(isOpenTurnBeforeRestart({ openTurnId: null, turnStartedAt: null }, DAEMON), false);
  assert.equal(isOpenTurnBeforeRestart({}, DAEMON), false);
  assert.equal(isOpenTurnBeforeRestart(null, DAEMON), false);
  assert.equal(isOpenTurnBeforeRestart({ turnStartedAt: 'not-a-date' }, DAEMON), false);
  assert.equal(isOpenTurnBeforeRestart({ turnStartedAt: BEFORE }, null), false);
  assert.equal(isOpenTurnBeforeRestart({ turnStartedAt: BEFORE }, 'not-a-date'), false);
  // openTurnId may be null (turnId unknown); the timestamp decides.
  assert.equal(isOpenTurnBeforeRestart({ openTurnId: null, turnStartedAt: BEFORE }, DAEMON), true);
});

test('buildRestartInterrupted keeps the C2 shape plus reason and clips bounds', () => {
  const git = { branch: 'main', sha: 'abc', changes: 2 };
  const record = buildRestartInterrupted({ at: NOW, reason: 'daemon-restart', error: 'e'.repeat(500), excerpt: 'a'.repeat(2000), git });
  assert.equal(record.at, NOW);
  assert.equal(record.reason, 'daemon-restart');
  assert.equal(record.outcome, 'canceled');
  assert.equal(record.error.length, 300);
  assert.equal(record.excerpt.length, 1500);
  assert.deepEqual(record.git, git);
  const minimal = buildRestartInterrupted({ at: NOW, reason: 'planned-restart' });
  assert.deepEqual(minimal, { at: NOW, outcome: 'canceled', error: null, excerpt: null, git: null, reason: 'planned-restart' });
});

test('flagCheckpointInterrupted carries an optional reason', async () => {
  const world = makeWorld();
  const ws = provisioned(world, { lastTurnId: 't0' });
  const client = fakeClient(world);
  const flagged = await flagCheckpointInterrupted({ client, workspaceId: ws.id, agentId: 'agent-1', at: NOW, reason: 'daemon-restart', lock: noLock });
  assert.deepEqual(flagged.interrupted, { agentId: 'agent-1', at: NOW, reason: 'daemon-restart' });
  assert.equal(flagged.task, 'Ship it');
  const world2 = makeWorld();
  const ws2 = provisioned(world2, { lastTurnId: 't0' });
  const plain = await flagCheckpointInterrupted({ client: fakeClient(world2), workspaceId: ws2.id, agentId: 'agent-1', at: NOW, lock: noLock });
  assert.deepEqual(plain.interrupted, { agentId: 'agent-1', at: NOW });
});

test('open turn before the daemon start is marked daemon-restart', async () => {
  const world = makeWorld();
  const ws = provisioned(world, { lastTurnId: 't0', openTurnId: 't1', turnStartedAt: BEFORE });
  const client = fakeClient(world);
  assert.equal(await bootPass({ client, workspaceId: ws.id, agentId: 'agent-1', daemonStartedAt: DAEMON, at: NOW }), true);
  const entry = (await client.workspaces.ref(ws.id).refresh())?.metadata?.[AGENTS_KEY]?.['agent-1'];
  assert.equal(entry.openTurnId, null);
  assert.equal(entry.turnStartedAt, null);
  assert.equal(entry.lastTurnId, 't1');
  assert.equal(entry.interrupted.reason, 'daemon-restart');
  assert.equal(entry.interrupted.outcome, 'canceled');
  const checkpoint = (await client.workspaces.ref(ws.id).refresh())?.metadata?.[CHECKPOINT_KEY];
  assert.deepEqual(checkpoint.interrupted, { agentId: 'agent-1', at: NOW, reason: 'daemon-restart' });
});

test('open turn after the daemon start is left alone', async () => {
  const world = makeWorld();
  const ws = provisioned(world, { lastTurnId: 't0', openTurnId: 't1', turnStartedAt: AFTER });
  const client = fakeClient(world);
  assert.equal(await bootPass({ client, workspaceId: ws.id, agentId: 'agent-1', daemonStartedAt: DAEMON, at: NOW }), false);
  const entry = (await client.workspaces.ref(ws.id).refresh())?.metadata?.[AGENTS_KEY]?.['agent-1'];
  assert.equal(entry.openTurnId, 't1');
  assert.equal(entry.turnStartedAt, AFTER);
  assert.equal(entry.interrupted, undefined);
  const checkpoint = (await client.workspaces.ref(ws.id).refresh())?.metadata?.[CHECKPOINT_KEY];
  assert.equal(checkpoint.interrupted, null);
});

test('a second boot check finds nothing to mark (no duplicate)', async () => {
  const world = makeWorld();
  const ws = provisioned(world, { lastTurnId: 't0', openTurnId: 't1', turnStartedAt: BEFORE });
  const client = fakeClient(world);
  assert.equal(await bootPass({ client, workspaceId: ws.id, agentId: 'agent-1', daemonStartedAt: DAEMON, at: NOW }), true);
  const writesAfterFirst = world.calls.length;
  assert.equal(await bootPass({ client, workspaceId: ws.id, agentId: 'agent-1', daemonStartedAt: DAEMON, at: NOW }), false);
  assert.equal(world.calls.length, writesAfterFirst, 'second pass writes nothing');
  const entry = (await client.workspaces.ref(ws.id).refresh())?.metadata?.[AGENTS_KEY]?.['agent-1'];
  assert.equal(entry.interrupted.at, NOW);
});

test('updateAgentEntry preserves open-turn fields and the reason', async () => {
  const world = makeWorld();
  const ws = provisioned(world, {});
  const client = fakeClient(world);
  const entry = await updateAgentEntry({
    client, workspaceId: ws.id, agentId: 'agent-1', lock: noLock,
    patch: { openTurnId: 't9', turnStartedAt: BEFORE, interrupted: { at: NOW, reason: 'daemon-restart' } },
  });
  assert.equal(entry.openTurnId, 't9');
  assert.equal(entry.turnStartedAt, BEFORE);
  assert.equal(entry.interrupted.reason, 'daemon-restart');
  assert.ok(LABEL.scope, 'labels import keeps the factory prefix visible');
});
