// Worker supervision core (S-A): transitions, register with lock, wake rules,
// failover chain and escalation counter. Fakes only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  WORKERS_KEY, TASK_MAX, SUPERVISION_DEFAULTS,
  nextWorkerState, statusForEvent, turnEndEvent, eventForRestartReason,
  clipTask, createWorkerEntry, readWorkers, workersReport, openWorkers, pruneWorkers,
  applyWorkerEvent, recordResume, queuePendingWake, collectPendingWakes, markWakeSent,
  shouldMarkStale, isCleanupProtected, isOpenWorkerState,
  isIgnoredAgent, canWakeAgent, isImmediateWakeState, isBatchDue, isQuietPeriod,
  planWake, resolveWakeTarget, formatWakeMessage, isStaleWake,
  failoverChain, escalationStep, describeEscalation,
  updateWorkerEntry, registerWorker, removeWorker, formatWorkersText,
} from '../plugin/server/core/supervision.mjs';
import { CHECKPOINT_KEY, SwitchRefused, buildHandoff, buildResumeBrief, steerStatus, switchSteer, writeCheckpoint } from '../plugin/server/core/steer.mjs';
import { LABEL, METADATA_KEY } from '../plugin/server/core/paseo.mjs';
import { LockBusy, withLock } from '../plugin/server/core/lock.mjs';

const REPO = 'example-owner/example-repo';
const NOW = new Date('2026-11-24T12:00:00.000Z').getTime();

function makeWorld() {
  return { workspaces: [], agents: [], calls: [], seq: 0 };
}
function addWorkspace(world, { metadata }) {
  const ws = { id: `wks_${String(++world.seq).padStart(4, '0')}`, projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout', title: 'Main', name: 'Main', metadata: structuredClone(metadata), createdAt: new Date().toISOString() };
  world.workspaces.push(ws);
  return ws;
}
function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, provider: 'codex', model: 'm', status: 'idle', archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}
function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  return {
    workspaces: {
      ref: (id) => ({
        refresh: async () => structuredClone(findWs(id)),
        setMetadata: async (patch) => {
          world.calls.push(['workspace.setMetadata', id, patch]);
          Object.assign(findWs(id).metadata, structuredClone(patch));
        },
      }),
    },
    agents: {
      list: async () => ({ entries: structuredClone(world.agents), pageInfo: { hasMore: false } }),
      ref: (id) => ({
        refresh: async () => ({ agent: structuredClone(world.agents.find((agent) => agent.id === id)) }),
        send: async (text) => { world.calls.push(['agent.send', id, text]); },
        timeline: { refetch: async () => ({ entries: [{ item: { type: 'assistant_message', text: 'Done.' } }] }) },
      }),
    },
  };
}
const noLock = (_name, fn) => fn({ verify() {} });
const throwingLock = (_name, fn) => fn({ verify() { throw new Error('lock file replaced'); } });

function provisioned(world, { checkpoint = null, workers = null } = {}) {
  const metadata = { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 3 } };
  if (checkpoint) metadata[CHECKPOINT_KEY] = checkpoint;
  if (workers) metadata[WORKERS_KEY] = workers;
  const ws = addWorkspace(world, { metadata });
  const steers = {
    A: addAgent(world, { title: 'Steer A', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'A', [LABEL.scope]: REPO } }),
    B: addAgent(world, { title: 'Steer B', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'B', [LABEL.scope]: REPO } }),
    C: addAgent(world, { title: 'Steer C', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'C', [LABEL.scope]: REPO } }),
  };
  return { ws, steers };
}
function discoveryOf(world) {
  return {
    forkName: REPO,
    scope: { id: REPO, kind: 'github', locator: REPO },
    mainWorkspace: world.workspaces[0] ? structuredClone(world.workspaces[0]) : null,
    steers: { labelled: structuredClone(world.agents.filter((a) => a.labels?.[LABEL.role] === 'steer')), legacy: [] },
    workers: [],
    providers: [],
  };
}
function entry(state, task = 'do it', extra = {}) {
  return { task, startedBy: 'A', startedAt: '2026-11-24T10:00:00.000Z', epoch: 3, state, status: null, resumes: 0, lastWakeAt: null, pendingWake: null, ...extra };
}

// ---------------------------------------------------------- state transitions

test('state transition table maps every design event', () => {
  const cases = {
    created: 'running', adopted: 'running',
    'checkpoint-done': 'done', 'checkpoint-none': 'done', 'checkpoint-partial': 'partial',
    'checkpoint-blocked': 'blocked', 'advisor-request': 'blocked',
    'turn-no-checkpoint': 'partial', 'turn-failed': 'interrupted', 'turn-canceled': 'interrupted',
    'restart-daemon': 'interrupted', 'restart-planned': 'interrupted',
    reassigned: 'running', archived: null,
  };
  for (const [event, expected] of Object.entries(cases)) assert.equal(nextWorkerState('running', event), expected, event);
  assert.equal(nextWorkerState('blocked', 'checkpoint-done'), 'done');
  assert.equal(nextWorkerState('stale', 'reassigned'), 'running');
  assert.equal(nextWorkerState('done', 'adopted'), 'running');
});

test('stale applies only while running; unknown events throw', () => {
  assert.equal(nextWorkerState('running', 'stale'), 'stale');
  assert.equal(nextWorkerState('blocked', 'stale'), 'blocked');
  assert.equal(nextWorkerState('done', 'stale'), 'done');
  assert.throws(() => nextWorkerState('running', 'nope'), /Unknown worker event/);
});

test('status follows CHECKPOINT and ADVISOR-REQUEST events only', () => {
  assert.equal(statusForEvent('checkpoint-done'), 'done');
  assert.equal(statusForEvent('checkpoint-none'), 'done');
  assert.equal(statusForEvent('checkpoint-partial'), 'partial');
  assert.equal(statusForEvent('checkpoint-blocked'), 'blocked');
  assert.equal(statusForEvent('advisor-request'), 'blocked');
  assert.equal(statusForEvent('turn-failed'), null);
  assert.equal(statusForEvent('reassigned'), null);
  assert.equal(statusForEvent('stale'), null);
});

test('turnEndEvent maps outcomes, checkpoints and advisor requests', () => {
  assert.equal(turnEndEvent({ outcome: 'failed', hasCheckpoint: true, status: 'done' }), 'turn-failed');
  assert.equal(turnEndEvent({ outcome: 'canceled' }), 'turn-canceled');
  assert.equal(turnEndEvent({ hasCheckpoint: true, status: 'done', advisorRequest: true }), 'advisor-request');
  assert.equal(turnEndEvent({ hasCheckpoint: false }), 'turn-no-checkpoint');
  assert.equal(turnEndEvent({ hasCheckpoint: true, status: 'done' }), 'checkpoint-done');
  assert.equal(turnEndEvent({ hasCheckpoint: true, status: null }), 'checkpoint-none');
  assert.equal(turnEndEvent({ hasCheckpoint: true }), 'checkpoint-none');
  assert.equal(turnEndEvent({ hasCheckpoint: true, status: 'partial' }), 'checkpoint-partial');
  assert.equal(turnEndEvent({ hasCheckpoint: true, status: 'blocked' }), 'checkpoint-blocked');
  assert.equal(eventForRestartReason('daemon-restart'), 'restart-daemon');
  assert.equal(eventForRestartReason('planned-restart'), 'restart-planned');
  assert.equal(eventForRestartReason('failed'), null);
});

// ------------------------------------------------------------ register entries

test('applyWorkerEvent creates, updates and removes entries', () => {
  let register = applyWorkerEvent({}, 'w-1', 'created', { task: 'build it', startedBy: 'A', epoch: 3, startedAt: '2026-11-24T10:00:00.000Z' });
  assert.equal(register['w-1'].state, 'running');
  assert.equal(register['w-1'].epoch, 3);
  register = applyWorkerEvent(register, 'w-1', 'checkpoint-partial');
  assert.equal(register['w-1'].state, 'partial');
  assert.equal(register['w-1'].status, 'partial');
  register = applyWorkerEvent({ ...register, 'w-1': { ...register['w-1'], resumes: 2 } }, 'w-1', 'reassigned', { task: 'build it better', epoch: 4 });
  assert.equal(register['w-1'].state, 'running');
  assert.equal(register['w-1'].resumes, 0);
  assert.equal(register['w-1'].task, 'build it better');
  assert.equal(register['w-1'].epoch, 4);
  register = applyWorkerEvent(register, 'w-1', 'archived');
  assert.deepEqual(register, {});
  assert.deepEqual(applyWorkerEvent({ 'w-1': entry('running') }, 'w-9', 'archived'), { 'w-1': entry('running') });
});

test('recordResume counts continuations; stale resumes survive other events', () => {
  assert.equal(recordResume({ resumes: 0 }).resumes, 1);
  assert.equal(recordResume({}).resumes, 1);
  const register = applyWorkerEvent({ 'w-1': { ...entry('running'), resumes: 2 } }, 'w-1', 'turn-failed');
  assert.equal(register['w-1'].state, 'interrupted');
  assert.equal(register['w-1'].resumes, 2);
});

test('task excerpts clip to 300 single-line chars', () => {
  assert.equal(TASK_MAX, 300);
  assert.equal(clipTask('  a\nb\tc  '), 'a b c');
  assert.equal(clipTask('x'.repeat(400)).length, 300);
  assert.equal(createWorkerEntry({ task: 'y'.repeat(500) }).task.length, 300);
});

test('register reads tolerate missing or malformed maps; reports sort by id', () => {
  assert.deepEqual(readWorkers({}), {});
  assert.deepEqual(readWorkers({ [WORKERS_KEY]: [] }), {});
  const register = { 'w-b': entry('blocked'), 'w-a': entry('running') };
  assert.deepEqual(workersReport(register).map((e) => e.id), ['w-a', 'w-b']);
  assert.deepEqual(openWorkers({ ...register, 'w-c': entry('done') }).map((e) => e.id), ['w-a', 'w-b']);
  assert.equal(isOpenWorkerState('done'), false);
  assert.equal(isOpenWorkerState('partial'), true);
});

test('prune keeps the bound, oldest done first, deterministically', () => {
  const at = (h) => `2026-11-24T${h}:00:00.000Z`;
  const register = {
    'w-1': entry('done', 't', { startedAt: at('08') }),
    'w-2': entry('done', 't', { startedAt: at('09') }),
    'w-3': entry('running', 't', { startedAt: at('10') }),
    'w-4': entry('blocked', 't', { startedAt: at('11') }),
  };
  assert.deepEqual(Object.keys(pruneWorkers(register, 3)).sort(), ['w-2', 'w-3', 'w-4']);
  const open = { 'w-1': entry('running', 't', { startedAt: at('08') }), 'w-2': entry('running', 't', { startedAt: at('09') }) };
  assert.deepEqual(Object.keys(pruneWorkers(open, 1)), ['w-2']);
  assert.equal(Object.keys(pruneWorkers(register, 4)).length, 4);
});

// --------------------------------------------------------------- register lock

test('updateWorkerEntry writes under the lock, epoch in every entry', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 3 } } });
  const client = fakeClient(world);
  const created = await updateWorkerEntry({ client, workspaceId: ws.id, workerId: 'w-1', event: 'created', eventDetails: { task: 'build', startedBy: 'A', epoch: 3, startedAt: '2026-11-24T10:00:00.000Z' }, lock: noLock });
  assert.equal(created.state, 'running');
  assert.equal(created.epoch, 3);
  const blocked = await updateWorkerEntry({ client, workspaceId: ws.id, workerId: 'w-1', event: 'advisor-request', lock: noLock });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.status, 'blocked');
  const patched = await updateWorkerEntry({ client, workspaceId: ws.id, workerId: 'w-1', patch: { resumes: 2 }, lock: noLock });
  assert.equal(patched.resumes, 2);
  assert.equal(patched.state, 'blocked');
  assert.equal(await updateWorkerEntry({ client, workspaceId: ws.id, workerId: 'w-1', event: 'archived', lock: noLock }), null);
  assert.deepEqual(world.workspaces[0].metadata[WORKERS_KEY], {});
});

test('registerWorker and removeWorker round-trip; patch remove deletes', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true } } });
  const client = fakeClient(world);
  const registered = await registerWorker({ client, workspaceId: ws.id, workerId: 'w-1', task: 't', startedBy: 'B', epoch: 5, lock: noLock, now: () => '2026-11-24T10:00:00.000Z' });
  assert.equal(registered.startedBy, 'B');
  assert.equal(registered.epoch, 5);
  assert.equal(await removeWorker({ client, workspaceId: ws.id, workerId: 'w-1', lock: noLock }), null);
  await registerWorker({ client, workspaceId: ws.id, workerId: 'w-2', lock: noLock });
  assert.equal(await updateWorkerEntry({ client, workspaceId: ws.id, workerId: 'w-2', patch: { remove: true }, lock: noLock }), null);
  await assert.rejects(updateWorkerEntry({ client, workspaceId: ws.id, workerId: '', event: 'created', lock: noLock }), /workerId/);
  await assert.rejects(updateWorkerEntry({ client, workspaceId: ws.id, workerId: 'w-3', lock: noLock }), /event or a patch/);
});

test('register writes fail closed on lock races and unverifiable writes', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true } } });
  await assert.rejects(updateWorkerEntry({ client: fakeClient(world), workspaceId: ws.id, workerId: 'w-1', event: 'created', lock: throwingLock }), /lock file replaced/);
  assert.ok(!world.workspaces[0].metadata[WORKERS_KEY], 'no write after a failed lock check');
  const frozen = fakeClient(world);
  frozen.workspaces.ref = () => ({ refresh: async () => ({ metadata: {} }), setMetadata: async () => {} });
  await assert.rejects(updateWorkerEntry({ client: frozen, workspaceId: ws.id, workerId: 'w-1', event: 'created', lock: noLock }), /not verifiable/);
});

test('concurrent writers are serialized: busy fails, retry keeps both entries', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 3 } } });
  const dir = mkdtempSync(join(tmpdir(), 'wsf-sup-'));
  try {
    const lock = (name, fn) => withLock(name, fn, { dir });
    const client = fakeClient(world);
    const first = updateWorkerEntry({ client, workspaceId: ws.id, workerId: 'w-1', event: 'created', eventDetails: { task: 'one', epoch: 3 }, lock });
    await assert.rejects(updateWorkerEntry({ client, workspaceId: ws.id, workerId: 'w-2', event: 'created', eventDetails: { task: 'two', epoch: 3 }, lock }), LockBusy);
    await first;
    await updateWorkerEntry({ client, workspaceId: ws.id, workerId: 'w-2', event: 'created', eventDetails: { task: 'two', epoch: 3 }, lock });
    const map = world.workspaces[0].metadata[WORKERS_KEY];
    assert.equal(map['w-1'].task, 'one');
    assert.equal(map['w-2'].task, 'two');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ wake rules

function scopedAgent(extra = {}) {
  return { id: 'agent-1', status: 'idle', archivedAt: null, labels: { [LABEL.scope]: REPO, [LABEL.role]: 'worker' }, ...extra };
}

test('ignore rule: archived and unassigned ignored, closed still supervised', () => {
  assert.equal(isIgnoredAgent(scopedAgent({ archivedAt: '2026-11-24T10:00:00.000Z' })), true);
  assert.equal(isIgnoredAgent({ id: 'x', status: 'idle', labels: {} }), true);
  assert.equal(isIgnoredAgent({ id: 'x', status: 'idle', labels: { [LABEL.scope]: '  ' } }), true);
  assert.equal(isIgnoredAgent(scopedAgent({ status: 'closed' })), false);
  assert.equal(isIgnoredAgent(scopedAgent()), false);
  assert.equal(isIgnoredAgent(null), true);
});

test('background agents are never woken', () => {
  assert.equal(canWakeAgent(scopedAgent()), true);
  assert.equal(canWakeAgent(scopedAgent({ status: 'closed' })), true);
  assert.equal(canWakeAgent(scopedAgent({ background: true })), false);
  assert.equal(canWakeAgent(scopedAgent({ archivedAt: '2026-11-24T10:00:00.000Z' })), false);
  assert.equal(canWakeAgent({ id: 'x', labels: {} }), false);
});

test('all actionable outcomes wake immediately', () => {
  const agent = scopedAgent();
  assert.deepEqual(planWake({ agent, newState: 'blocked', nowMs: NOW }), { action: 'immediate', reason: 'blocked' });
  assert.deepEqual(planWake({ agent, newState: 'interrupted', nowMs: NOW }), { action: 'immediate', reason: 'interrupted' });
  assert.equal(isImmediateWakeState('done'), true);
  assert.equal(isImmediateWakeState('partial'), true);
  assert.equal(isImmediateWakeState('stale'), true);
  assert.deepEqual(planWake({ agent, newState: 'done', nowMs: NOW }), { action: 'immediate', reason: 'done' });
  assert.deepEqual(planWake({ agent, newState: 'partial', nowMs: NOW }), { action: 'immediate', reason: 'partial' });
  assert.deepEqual(planWake({ agent, newState: 'stale', nowMs: NOW }), { action: 'immediate', reason: 'stale' });
});

test('debounce window defers simultaneous outcomes briefly', () => {
  assert.equal(SUPERVISION_DEFAULTS.batchMinutes, 0);
  assert.equal(SUPERVISION_DEFAULTS.wakeDebounceSeconds, 20);
  const agent = scopedAgent();
  const recent = new Date(NOW - 1_000).toISOString();
  const old = new Date(NOW - 21_000).toISOString();
  assert.deepEqual(planWake({ agent, newState: 'done', nowMs: NOW, lastWakeAt: recent }), { action: 'defer', reason: 'debounce-window' });
  assert.deepEqual(planWake({ agent, newState: 'done', nowMs: NOW, lastWakeAt: old }), { action: 'immediate', reason: 'done' });
  assert.equal(isBatchDue({ nowMs: NOW, lastWakeAt: null }), true);
  assert.equal(isBatchDue({ nowMs: NOW, lastWakeAt: 'not-a-date' }), true);
  assert.deepEqual(planWake({ agent, newState: 'blocked', nowMs: NOW, lastWakeAt: recent }), { action: 'defer', reason: 'debounce-window' });
});

test('quiet periods skip wakes during drain and before the boot check', () => {
  const agent = scopedAgent();
  assert.equal(isQuietPeriod({ draining: false, bootCheckDone: true }), false);
  assert.equal(isQuietPeriod({ draining: true, bootCheckDone: true }), true);
  assert.equal(isQuietPeriod({ draining: false, bootCheckDone: false }), true);
  assert.deepEqual(planWake({ agent, newState: 'blocked', nowMs: NOW, draining: true }), { action: 'skip', reason: 'drain' });
  assert.deepEqual(planWake({ agent, newState: 'blocked', nowMs: NOW, bootCheckDone: false }), { action: 'skip', reason: 'boot' });
  assert.deepEqual(planWake({ agent: { id: 'x', labels: {} }, newState: 'blocked', nowMs: NOW }), { action: 'skip', reason: 'ineligible' });
});

test('wake target resolves at send time from the scope state', () => {
  const steers = [{ slot: 'A', id: 'steer-a' }, { slot: 'B', id: 'steer-b' }];
  assert.equal(resolveWakeTarget({ activeSteer: 'A', epoch: 3 }, steers), 'steer-a');
  assert.equal(resolveWakeTarget({ activeSteer: 'B', epoch: 4 }, steers), 'steer-b');
  assert.equal(resolveWakeTarget({ activeSteer: 'A', epoch: 3 }, [...steers, { slot: 'A', id: 'steer-a2' }]), null);
  assert.equal(resolveWakeTarget({ activeSteer: 'Z', epoch: 3 }, steers), null);
  assert.equal(resolveWakeTarget({ activeSteer: 'A', epoch: 3 }, [{ slot: 'A', id: 'steer-a', archivedAt: 't' }]), null);
  assert.equal(resolveWakeTarget({ activeSteer: 'A', epoch: 3 }, [{ slot: 'A', id: 'steer-a', retired: true }]), null);
  assert.equal(resolveWakeTarget({ activeSteer: 'A', epoch: 3 }, [{ slot: 'A', id: 'steer-a', status: 'closed' }]), 'steer-a');
  assert.equal(resolveWakeTarget(null, steers), null);
});

test('wake text identifies workers and separates reporting from acceptance', () => {
  assert.equal(
    formatWakeMessage({
      events: [{ workerId: 'w-1', state: 'blocked' }, { workerId: 'w-2', state: 'done' }],
      workerNames: { 'w-1': 'Integration checks', 'w-2': 'Documentation' },
    }),
    '[factory] Integration checks: blocked. Review the checkpoint.\n[factory] Documentation: result reported. Review the result.',
  );
  assert.equal(formatWakeMessage({ events: [] }), null);
});

test('stale-epoch wakes are ignored', () => {
  assert.equal(isStaleWake(3, 4), true);
  assert.equal(isStaleWake(4, 4), false);
  assert.equal(isStaleWake(5, 4), false);
  assert.equal(isStaleWake(null, 4), false);
  assert.equal(isStaleWake(3, null), false);
});

test('pending wakes queue, collect and clear on send', () => {
  let register = { 'w-b': entry('done'), 'w-a': entry('partial') };
  register = { ...register, 'w-b': queuePendingWake(register['w-b'], { state: 'done', queuedAt: '2026-11-24T11:00:00.000Z' }) };
  register = { ...register, 'w-a': queuePendingWake(register['w-a'], { state: 'partial', queuedAt: '2026-11-24T11:01:00.000Z' }) };
  assert.deepEqual(collectPendingWakes(register), [
    { workerId: 'w-a', state: 'partial', queuedAt: '2026-11-24T11:01:00.000Z' },
    { workerId: 'w-b', state: 'done', queuedAt: '2026-11-24T11:00:00.000Z' },
  ]);
  const sent = markWakeSent(register['w-a'], { at: '2026-11-24T11:05:00.000Z' });
  assert.equal(sent.lastWakeAt, '2026-11-24T11:05:00.000Z');
  assert.equal(sent.pendingWake, null);
  assert.deepEqual(collectPendingWakes({ ...register, 'w-a': sent }).map((p) => p.workerId), ['w-b']);
});

test('watchdog marks only idle running entries stale', () => {
  assert.equal(SUPERVISION_DEFAULTS.staleMinutes, 60);
  assert.equal(shouldMarkStale({ entry: entry('running'), nowMs: NOW, lastActiveMs: NOW - 61 * 60_000 }), true);
  assert.equal(shouldMarkStale({ entry: entry('running'), nowMs: NOW, lastActiveMs: NOW - 30 * 60_000 }), false);
  assert.equal(shouldMarkStale({ entry: entry('blocked'), nowMs: NOW, lastActiveMs: NOW - 61 * 60_000 }), false);
  assert.equal(shouldMarkStale({ entry: entry('running'), nowMs: NOW, lastActiveMs: null }), false);
  assert.equal(shouldMarkStale({ entry: entry('running'), nowMs: NOW, lastActiveMs: NOW - 61 * 60_000, staleMinutes: 120 }), false);
});

test('cleanup protection covers running, blocked, interrupted and missing checkpoints', () => {
  assert.equal(isCleanupProtected('running'), true);
  assert.equal(isCleanupProtected('blocked'), true);
  assert.equal(isCleanupProtected('interrupted'), true);
  assert.equal(isCleanupProtected('done'), false);
  assert.equal(isCleanupProtected('partial'), false);
  assert.equal(isCleanupProtected('stale'), false);
  assert.equal(isCleanupProtected(entry('running')), true);
  assert.equal(isCleanupProtected({ state: 'partial', status: null }), true);
  assert.equal(isCleanupProtected({ state: 'partial', status: 'partial' }), false);
  assert.equal(isCleanupProtected(entry('done')), false);
});

// -------------------------------------------------------------------- failover

test('failover chain: next slots, then domain, then hub', () => {
  const steers = [
    { slot: 'A', id: 'steer-a' },
    { slot: 'B', id: 'steer-b' },
    { slot: 'C', id: 'steer-c' },
    { slot: 'D', id: 'steer-d', retired: true },
    { slot: 'E', id: 'steer-e', archivedAt: 't' },
    { slot: 'F', id: 'steer-f', interrupted: { reason: 'daemon-restart' } },
  ];
  const domainSteer = { steerId: 'steer-dom', scopeId: 'shop' };
  const hubSteer = { steerId: 'steer-hub', scopeId: 'hub' };
  assert.deepEqual(
    failoverChain({ steers, activeSlot: 'A', domainSteer, hubSteer }),
    [
      { kind: 'steer', slot: 'B', steerId: 'steer-b' },
      { kind: 'steer', slot: 'C', steerId: 'steer-c' },
      { kind: 'domain', steerId: 'steer-dom', scopeId: 'shop' },
      { kind: 'hub', steerId: 'steer-hub', scopeId: 'hub' },
    ],
  );
  assert.deepEqual(
    failoverChain({ steers, activeSlot: 'C', domainSteer, hubSteer }).map((c) => c.steerId),
    ['steer-a', 'steer-b', 'steer-dom', 'steer-hub'],
  );
  assert.deepEqual(failoverChain({ steers, activeSlot: 'A', retiredIds: ['steer-b'] }).map((c) => c.slot), ['C']);
  assert.deepEqual(failoverChain({ steers, activeSlot: 'A', interruptedIds: ['steer-c'] }).map((c) => c.slot), ['B']);
  assert.deepEqual(failoverChain({ steers: [], activeSlot: 'A' }), []);
  assert.deepEqual(failoverChain({ steers, activeSlot: 'A' }).map((c) => c.kind), ['steer', 'steer']);
});

// ------------------------------------------------------------------ escalation

test('escalation counter: resumes, advisor, domain, hub, user', () => {
  assert.equal(SUPERVISION_DEFAULTS.maxAutoResumes, 2);
  assert.equal(escalationStep({ resumes: 0 }), 'resume');
  assert.equal(escalationStep({ resumes: 1 }), 'resume');
  assert.equal(escalationStep({ resumes: 2 }), 'advisor');
  assert.equal(escalationStep({ resumes: 5 }), 'advisor');
  assert.equal(escalationStep({ resumes: 2, advisorDone: true }), 'domain');
  assert.equal(escalationStep({ resumes: 2, advisorDone: true, domainDone: true }), 'hub');
  assert.equal(escalationStep({ resumes: 2, advisorDone: true, domainDone: true, hubDone: true }), 'user');
  assert.equal(escalationStep({ resumes: 1, maxAutoResumes: 1 }), 'advisor');
  assert.match(describeEscalation('advisor'), /advisor/);
  assert.match(describeEscalation('domain'), /domain:/);
  assert.match(describeEscalation('hub'), /hub:/);
  assert.match(describeEscalation('user'), /user:/);
  assert.match(describeEscalation('resume'), /resume brief/);
});

// ----------------------------------------------- status, resume, handoff, CLI

function supervisedDiscovery(world) {
  provisioned(world, { workers: { 'w-live': entry('blocked', 'fix pwm'), 'w-gone': entry('done', 'old task'), 'w-ghost': entry('interrupted', 'lost task') } });
  const d = discoveryOf(world);
  d.workers = [{ id: 'w-live', title: 'PWM', provider: 'codex', model: 'm', status: 'idle', workspaceId: world.workspaces[0].id, labels: { [LABEL.role]: 'worker', [LABEL.scope]: REPO, [LABEL.owner]: 'A' } }];
  return d;
}

test('steerStatus exposes open register entries with task and state', () => {
  const status = steerStatus(supervisedDiscovery(makeWorld()));
  assert.deepEqual(status.openWorkers.map((e) => e.id), ['w-ghost', 'w-live']);
  assert.equal(status.openWorkers.find((e) => e.id === 'w-live').task, 'fix pwm');
  assert.equal(steerStatus(discoveryOf((() => { const w = makeWorld(); provisioned(w); return w; })())).openWorkers.length, 0);
});

test('resume brief lists open supervised workers; silent without a register', () => {
  const world = makeWorld();
  const d = supervisedDiscovery(world);
  const brief = buildResumeBrief(steerStatus(d), { scope: d.scope, now: () => NOW });
  assert.match(brief, /w-live "PWM" idle · no note · supervised: blocked fix pwm/);
  assert.match(brief, /w-ghost \(agent not live\) · supervised: interrupted lost task/);
  assert.ok(!brief.includes('old task'), 'done entries stay out of the brief');
  const plain = makeWorld();
  provisioned(plain);
  const pd = discoveryOf(plain);
  assert.match(buildResumeBrief(steerStatus(pd), { scope: pd.scope, now: () => NOW }), /Workers: none\./);
});

test('switch handoff lists open supervised workers with task and state', () => {
  const world = makeWorld();
  const d = supervisedDiscovery(world);
  const status = steerStatus(d);
  const packet = buildHandoff(status, { from: { slot: 'A', id: status.steers[0].id }, to: { slot: 'B', id: status.steers[1].id }, epoch: 3, git: null, lastMessage: null });
  assert.match(packet, /supervised blocked: fix pwm/);
  assert.match(packet, /w-ghost \(agent not live\) · supervised interrupted: lost task/);
  const plain = makeWorld();
  provisioned(plain);
  const ps = steerStatus(discoveryOf(plain));
  assert.match(buildHandoff(ps, { from: { slot: 'A', id: ps.steers[0].id }, to: { slot: 'B', id: ps.steers[1].id }, epoch: 3, git: null, lastMessage: null }), /Workers: none\./);
});

test('writeCheckpoint accepts failover source; brief and handoff show it', async () => {
  const world = makeWorld();
  provisioned(world);
  const discovery = discoveryOf(world);
  const cp = await writeCheckpoint({
    client: fakeClient(world), discovery, task: 'keep shipping', source: 'failover',
    previousSteer: 'A', failoverReason: 'no answer within 10m', lock: noLock, now: () => new Date('2026-11-24T12:00:00.000Z'),
  });
  assert.equal(cp.source, 'failover');
  assert.deepEqual(cp.failover, { previousSteer: 'A', reason: 'no answer within 10m' });
  const d = discoveryOf(world);
  const status = steerStatus(d);
  assert.match(buildResumeBrief(status, { scope: d.scope, now: () => NOW }), /Failover from A: no answer within 10m/);
  assert.match(
    buildHandoff(status, { from: { slot: 'A', id: status.steers[0].id }, to: { slot: 'B', id: status.steers[1].id }, epoch: 3, git: null, lastMessage: null }),
    /- Failover: takeover from A \(no answer within 10m\)/,
  );
});

test('switch race: exactly one of two candidates wins; own active slot refused', async () => {
  const world = makeWorld();
  provisioned(world);
  const stale = discoveryOf(world);
  const first = await switchSteer({ client: fakeClient(world), discovery: stale, toSlot: 'B', apply: true, lock: noLock });
  assert.equal(first.applied, true);
  assert.equal(first.epoch, 4);
  assert.ok(world.calls.some((c) => c[0] === 'agent.send'), 'winner delivers the handoff');
  await assert.rejects(switchSteer({ client: fakeClient(world), discovery: stale, toSlot: 'C', apply: true, lock: noLock }), SwitchRefused);
  await assert.rejects(switchSteer({ client: fakeClient(world), discovery: discoveryOf(world), toSlot: 'B', apply: true, lock: noLock }), /already active/);
});

test('workers report sorts entries; text prints header and lines', () => {
  const report = workersReport({
    'w-b': entry('done', 'second'),
    'w-a': entry('blocked', 'first', { resumes: 2, status: 'blocked', lastWakeAt: '2026-11-24T11:00:00.000Z', pendingWake: { state: 'blocked', queuedAt: 't' } }),
  });
  assert.deepEqual(report.map((e) => e.id), ['w-a', 'w-b']);
  const text = formatWorkersText(REPO, 3, report);
  assert.match(text, new RegExp(`Workers of ${REPO.replace('/', '\\/')} · epoch 3 · 1 open / 2 total`));
  assert.ok(text.indexOf('w-a') < text.indexOf('w-b'));
  assert.match(text, /w-a blocked "first" · started by A epoch 3 · resumes 2 · status blocked · last wake .* · pending wake/);
  assert.match(formatWorkersText(REPO, 3, []), /\(no supervised workers\)/);
});

test('CLI usage documents workers', () => {
  const out = execFileSync('node', ['plugin/cli.mjs', '--help'], { encoding: 'utf8' });
  assert.match(out, /workers \[scope\] \[--prune\] \[--apply\] \[--json\]/);
  assert.match(out, /--prune removes entries whose agent is gone/);
});
