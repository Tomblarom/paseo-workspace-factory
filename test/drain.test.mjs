// P3 drain: wait for idle, mark leftovers planned-restart. Fakes only, no
// real waiting: the clock and sleep are injected.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DRAIN_DEFAULT_TIMEOUT_MS, DRAIN_GRACE_MS, DRAIN_KEY, buildDrainMarker, clearDrainMarker, drain, factoryRunningAgents, isDrainMarkerActive, isRunningAgent, markPlannedRestart, parseTimeout, setDrainMarker } from '../src/drain.mjs';
import { AGENTS_KEY } from '../src/agent-state.mjs';
import { CHECKPOINT_KEY } from '../src/steer.mjs';
import { LABEL, METADATA_KEY } from '../src/paseo.mjs';

const SCOPE = 'example/web';

function agent(id, { role = 'steer', slot = 'A', status = 'running', archivedAt = null, scope = SCOPE, activeTurn = null } = {}) {
  return {
    id, status, archivedAt, title: id, workspaceId: 'wks_main', provider: 'codex', model: 'm',
    ...(activeTurn ? { activeTurn } : {}),
    labels: { [LABEL.role]: role, [LABEL.scope]: scope, ...(role === 'steer' ? { [LABEL.slot]: slot } : {}) },
  };
}

function workspaceWith({ checkpoint = null, agents = null }) {
  return {
    id: 'wks_main', projectId: 'prj_1', title: 'Main', name: 'Main', workspaceDirectory: '/p/web',
    metadata: {
      [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 3, scope: { id: SCOPE, kind: 'github', locator: SCOPE } },
      ...(checkpoint ? { [CHECKPOINT_KEY]: checkpoint } : {}),
      ...(agents ? { [AGENTS_KEY]: agents } : {}),
    },
  };
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  return {
    workspaces: {
      ref: (id) => ({
        refresh: async () => structuredClone(findWs(id)),
        setMetadata: async (patch) => {
          world.calls.push(id);
          Object.assign(findWs(id).metadata, structuredClone(patch));
        },
      }),
    },
  };
}
const noLock = (_name, fn) => fn({ verify() {} });

test('parseTimeout reads ms/s/m/h and bare seconds', () => {
  assert.equal(parseTimeout('10m'), 600_000);
  assert.equal(parseTimeout('30s'), 30_000);
  assert.equal(parseTimeout('1h'), 3_600_000);
  assert.equal(parseTimeout('500ms'), 500);
  assert.equal(parseTimeout('45'), 45_000);
  assert.equal(parseTimeout(' 2M '), 120_000);
  assert.equal(DRAIN_DEFAULT_TIMEOUT_MS, 600_000);
  assert.throws(() => parseTimeout('soon'), /invalid --timeout/);
  assert.throws(() => parseTimeout(''), /drain needs --timeout/);
  assert.throws(() => parseTimeout('-5s'), /invalid --timeout/);
});

test('factoryRunningAgents lists live factory turns only', () => {
  const state = {
    agents: [
      agent('run-steer', { status: 'running' }),
      agent('init-worker', { role: 'worker', status: 'initializing' }),
      agent('turn-idle', { status: 'idle', activeTurn: { startedAt: '2026-11-23T12:00:00.000Z' } }),
      agent('idle-steer', { status: 'idle' }),
      agent('archived', { status: 'running', archivedAt: '2026-11-23T12:00:00.000Z' }),
      { ...agent('foreign', { status: 'running' }), labels: { [LABEL.role]: 'steer', [LABEL.scope]: 'other/repo' } },
      { id: 'plain', status: 'running', archivedAt: null, labels: {} },
    ],
  };
  assert.deepEqual(factoryRunningAgents(state).map((a) => a.id), ['foreign', 'init-worker', 'run-steer', 'turn-idle']);
  assert.equal(isRunningAgent(agent('x', { status: 'running' })), true);
  assert.equal(isRunningAgent(agent('x', { status: 'idle' })), false);
  assert.equal(isRunningAgent(null), false);
});

test('drain is clean immediately without running agents', async () => {
  let sleeps = 0;
  const result = await drain({
    client: fakeClient({ workspaces: [], calls: [] }),
    timeoutMs: 1000, pollMs: 10, now: () => 0, sleep: async () => { sleeps += 1; },
    readState: async () => ({ agents: [agent('idle', { status: 'idle' })], workspaces: [] }),
  });
  assert.equal(result.clean, true);
  assert.equal(result.waitedMs, 0);
  assert.deepEqual(result.marked, []);
  assert.equal(sleeps, 0);
});

test('drain waits until idle and stays clean', async () => {
  let time = 0;
  let reads = 0;
  const running = { agents: [agent('a', { status: 'running' })], workspaces: [] };
  const idle = { agents: [agent('a', { status: 'idle' })], workspaces: [] };
  const result = await drain({
    client: fakeClient({ workspaces: [], calls: [] }),
    timeoutMs: 1000, pollMs: 100, now: () => time, sleep: async (ms) => { time += ms; },
    readState: async () => (++reads === 1 ? running : idle),
  });
  assert.equal(result.clean, true);
  assert.equal(result.waitedMs, 100);
  assert.equal(reads, 2);
  assert.deepEqual(result.initial.map((a) => a.id), ['a']);
});

test('markPlannedRestart writes excerpt, git, and the flag', async () => {
  const world = {
    workspaces: [workspaceWith({
      checkpoint: { task: 't', tests: [], blockers: [], next: null, epoch: 3, updatedAt: '2026-11-23T10:00:00.000Z' },
      agents: { a1: { openTurnId: 't1', turnStartedAt: '2026-11-23T10:30:00.000Z', lastTurnId: 't0' } },
    })],
    calls: [],
  };
  const state = { agents: [agent('a1', { status: 'running' })], workspaces: world.workspaces };
  const mark = await markPlannedRestart({
    client: fakeClient(world), paseoState: state, agentId: 'a1', at: '2026-11-23T12:00:00.000Z',
    readExcerpt: async () => 'last answer tail', readGit: () => ({ branch: 'main', sha: 'abc', changes: 2 }),
    lock: noLock,
  });
  assert.deepEqual(mark, { agentId: 'a1', scopeId: SCOPE });
  const entry = world.workspaces[0].metadata[AGENTS_KEY].a1;
  assert.equal(entry.interrupted.reason, 'planned-restart');
  assert.equal(entry.interrupted.excerpt, 'last answer tail');
  assert.deepEqual(entry.interrupted.git, { branch: 'main', sha: 'abc', changes: 2 });
  assert.equal(entry.openTurnId, null);
  assert.equal(entry.turnStartedAt, null);
  assert.equal(world.workspaces[0].metadata[CHECKPOINT_KEY].interrupted.reason, 'planned-restart');
  assert.equal(await markPlannedRestart({
    client: fakeClient(world), paseoState: { agents: [], workspaces: [] }, agentId: 'ghost',
    at: '2026-11-23T12:00:00.000Z', lock: noLock,
  }), null);
});

test('drain timeout marks leftovers and reports unclean', async () => {
  let time = 0;
  const world = {
    workspaces: [workspaceWith({
      checkpoint: { task: 't', tests: [], blockers: [], next: null, epoch: 3, updatedAt: '2026-11-23T10:00:00.000Z' },
      agents: {},
    })],
    calls: [],
  };
  const state = { agents: [agent('stuck', { status: 'running' })], workspaces: world.workspaces };
  const result = await drain({
    client: fakeClient(world), timeoutMs: 50, pollMs: 10, now: () => time,
    sleep: async (ms) => { time += ms; },
    readState: async () => state,
    readExcerpt: async () => 'tail', readGit: () => null, lock: noLock,
  });
  assert.equal(result.clean, false);
  assert.equal(result.running.length, 1);
  assert.deepEqual(result.marked, [{ agentId: 'stuck', scopeId: SCOPE }]);
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY].stuck.interrupted.reason, 'planned-restart');
});

test('isDrainMarkerActive honors timeoutAt plus a minute of grace', () => {
  const at = (ms) => new Date(ms).toISOString();
  const marker = buildDrainMarker({ startedAt: at(0), timeoutAt: at(60_000), pid: 1 });
  assert.deepEqual(marker, { startedAt: at(0), timeoutAt: at(60_000), pid: 1 });
  assert.equal(DRAIN_KEY, 'wsf.drain');
  assert.equal(DRAIN_GRACE_MS, 60_000);
  assert.equal(isDrainMarkerActive(marker, 59_999), true);
  assert.equal(isDrainMarkerActive(marker, 60_000), true);
  assert.equal(isDrainMarkerActive(marker, 120_000), true, 'timeoutAt + 1 min still quiet');
  assert.equal(isDrainMarkerActive(marker, 120_001), false, 'past the grace the marker is ignored');
  for (const bad of [null, undefined, 'x', 42, [], {}, { timeoutAt: 'not-a-date' }, { startedAt: at(0) }]) {
    assert.equal(isDrainMarkerActive(bad, 0), false, `ignored: ${JSON.stringify(bad)}`);
  }
  assert.equal(isDrainMarkerActive(marker, Number.NaN), false);
});

test('drain markers round-trip under the lock and keep foreign markers', async () => {
  const world = { workspaces: [workspaceWith({})], calls: [] };
  const client = fakeClient(world);
  const own = buildDrainMarker({ startedAt: '2026-11-24T12:00:00.000Z', timeoutAt: '2026-11-24T12:10:00.000Z', pid: 11 });
  const foreign = buildDrainMarker({ startedAt: '2026-11-24T11:00:00.000Z', timeoutAt: '2026-11-24T11:10:00.000Z', pid: 12 });
  assert.deepEqual(await setDrainMarker({ client, workspaceId: 'wks_main', marker: own, lock: noLock }), own);
  assert.equal(await clearDrainMarker({ client, workspaceId: 'wks_main', marker: foreign, lock: noLock }), false);
  assert.deepEqual(world.workspaces[0].metadata[DRAIN_KEY], own, 'a foreign clear leaves our marker alone');
  assert.equal(await clearDrainMarker({ client, workspaceId: 'wks_main', marker: own, lock: noLock }), true);
  assert.equal(world.workspaces[0].metadata[DRAIN_KEY], null);
  assert.equal(await clearDrainMarker({ client, workspaceId: 'wks_main', marker: own, lock: noLock }), false, 'nothing left to clear');
  await assert.rejects(setDrainMarker({ client, workspaceId: '', marker: own, lock: noLock }), /needs a workspaceId/);
  await assert.rejects(clearDrainMarker({ client, workspaceId: '', lock: noLock }), /needs a workspaceId/);
});

test('drain writes the marker while waiting and clears it after', async () => {
  let time = 0;
  const world = { workspaces: [workspaceWith({})], calls: [] };
  const running = { agents: [agent('a', { status: 'running' })], workspaces: world.workspaces };
  const idle = { agents: [agent('a', { status: 'idle' })], workspaces: world.workspaces };
  let reads = 0;
  let seenDuringWait = 'unset';
  const result = await drain({
    client: fakeClient(world), timeoutMs: 1000, pollMs: 100, now: () => time,
    sleep: async (ms) => { time += ms; },
    readState: async () => {
      reads += 1;
      if (reads === 2) seenDuringWait = structuredClone(world.workspaces[0].metadata[DRAIN_KEY] ?? null);
      return reads === 1 ? running : idle;
    },
    lock: noLock, pid: 4242,
  });
  assert.equal(result.clean, true);
  assert.equal(seenDuringWait?.pid, 4242);
  assert.equal(seenDuringWait?.startedAt, new Date(0).toISOString());
  assert.equal(seenDuringWait?.timeoutAt, new Date(1000).toISOString());
  assert.equal(world.workspaces[0].metadata[DRAIN_KEY] ?? null, null);
});

test('drain clears the marker when it times out', async () => {
  let time = 0;
  const world = { workspaces: [workspaceWith({})], calls: [] };
  const state = { agents: [agent('stuck', { status: 'running' })], workspaces: world.workspaces };
  const result = await drain({
    client: fakeClient(world), timeoutMs: 50, pollMs: 10, now: () => time,
    sleep: async (ms) => { time += ms; },
    readState: async () => state,
    readExcerpt: async () => 'tail', readGit: () => null, lock: noLock, pid: 7,
  });
  assert.equal(result.clean, false);
  assert.equal(world.workspaces[0].metadata[DRAIN_KEY] ?? null, null);
});

test('drain without scopes writes no markers', async () => {
  let time = 0;
  let reads = 0;
  const running = { agents: [agent('a', { status: 'running' })], workspaces: [] };
  const idle = { agents: [agent('a', { status: 'idle' })], workspaces: [] };
  const explodingLock = () => { throw new Error('no lock expected without scopes'); };
  const result = await drain({
    client: fakeClient({ workspaces: [], calls: [] }),
    timeoutMs: 1000, pollMs: 100, now: () => time, sleep: async (ms) => { time += ms; },
    readState: async () => (++reads === 1 ? running : idle),
    lock: explodingLock,
  });
  assert.equal(result.clean, true);
});
