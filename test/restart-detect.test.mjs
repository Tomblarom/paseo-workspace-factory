// P2 restart detection: plugin marks via interrupted reason plus the heuristic
// without the plugin (daemon newer than CHECKPOINT, agent idle, last turn
// without CHECKPOINT). Fakes only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daemonStartedAt, isRestartReason, restartMessage } from '../src/paseo.mjs';
import { isHeuristicRestart, restartInterruptions, steerStatus, buildResumeBrief, CHECKPOINT_KEY } from '../src/steer.mjs';
import { scopeRows, formatScopeRows } from '../src/scopes-view.mjs';
import { AGENTS_KEY } from '../src/agent-state.mjs';
import { LABEL, METADATA_KEY } from '../src/paseo.mjs';

const DAEMON = '2026-11-23T11:00:00.000Z';
const OLD_CP = '2026-11-23T10:00:00.000Z';
const NEW_CP = '2026-11-23T12:00:00.000Z';
const NOW = Date.parse('2026-11-23T12:30:00.000Z');

test('restart helpers name the reasons and the line', () => {
  assert.equal(isRestartReason('daemon-restart'), true);
  assert.equal(isRestartReason('planned-restart'), true);
  assert.equal(isRestartReason(undefined), false);
  assert.equal(isRestartReason('failed'), false);
  assert.equal(restartMessage('agent-1'), 'Agent agent-1 durch Neustart unterbrochen');
});

test('daemonStartedAt reads startedAt and fails closed', () => {
  assert.equal(daemonStartedAt(() => ({ startedAt: DAEMON })), DAEMON);
  assert.equal(daemonStartedAt(() => ({})), null);
  assert.equal(daemonStartedAt(() => null), null);
  assert.equal(daemonStartedAt(() => { throw new Error('no daemon'); }), null);
});

test('restartInterruptions collects restart reasons from agents and flag', () => {
  const checkpoint = { task: 't', interrupted: { agentId: 'agent-9', at: OLD_CP, reason: 'daemon-restart' } };
  const agentState = {
    'agent-2': { interrupted: { at: OLD_CP, reason: 'planned-restart' } },
    'agent-1': { interrupted: { at: OLD_CP, reason: 'daemon-restart' } },
    'agent-3': { interrupted: { at: OLD_CP, outcome: 'failed' } },
    'agent-4': { note: 'x' },
  };
  assert.deepEqual(restartInterruptions({ checkpoint, agentState }), [
    { agentId: 'agent-1', reason: 'daemon-restart', at: OLD_CP, heuristic: false },
    { agentId: 'agent-2', reason: 'planned-restart', at: OLD_CP, heuristic: false },
    { agentId: 'agent-9', reason: 'daemon-restart', at: OLD_CP, heuristic: false },
  ]);
  assert.deepEqual(restartInterruptions({ checkpoint: { task: 't' }, agentState: {} }), []);
  assert.deepEqual(restartInterruptions({}), []);
  // Same agent in both places is listed once (agent record wins).
  assert.deepEqual(
    restartInterruptions({ checkpoint: { task: 't', interrupted: { agentId: 'a', at: OLD_CP, reason: 'daemon-restart' } }, agentState: { a: { interrupted: { at: NEW_CP, reason: 'daemon-restart' } } } }),
    [{ agentId: 'a', reason: 'daemon-restart', at: NEW_CP, heuristic: false }],
  );
});

test('isHeuristicRestart needs daemon newer, idle, and no CHECKPOINT', () => {
  const base = { daemonStartedAt: DAEMON, checkpointAt: OLD_CP, agentStatus: 'idle', lastTurnHadCheckpoint: false };
  assert.equal(isHeuristicRestart(base), true);
  assert.equal(isHeuristicRestart({ ...base, agentStatus: 'running' }), false);
  assert.equal(isHeuristicRestart({ ...base, lastTurnHadCheckpoint: true }), false);
  assert.equal(isHeuristicRestart({ ...base, lastTurnHadCheckpoint: null }), false);
  assert.equal(isHeuristicRestart({ ...base, lastTurnHadCheckpoint: undefined }), false);
  assert.equal(isHeuristicRestart({ ...base, checkpointAt: NEW_CP }), false);
  assert.equal(isHeuristicRestart({ ...base, checkpointAt: DAEMON }), false);
  assert.equal(isHeuristicRestart({ ...base, daemonStartedAt: null }), false);
  assert.equal(isHeuristicRestart({ ...base, checkpointAt: null }), false);
  assert.equal(isHeuristicRestart({ ...base, daemonStartedAt: 'nope' }), false);
});

function discoveryWith({ checkpoint, agents, steers, workers }) {
  const ws = {
    id: 'wks_0001', projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout',
    title: 'Main', name: 'Main',
    metadata: {
      [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 3 },
      ...(checkpoint ? { [CHECKPOINT_KEY]: checkpoint } : {}),
      ...(agents ? { [AGENTS_KEY]: agents } : {}),
    },
    createdAt: OLD_CP,
  };
  return {
    forkName: 'example/repo', scope: { id: 'example/repo', kind: 'github' },
    mainWorkspace: structuredClone(ws),
    steers: { labelled: structuredClone(steers), legacy: [] },
    workers: structuredClone(workers),
    providers: [],
  };
}

function steerAgent(id, status = 'idle') {
  return {
    id, status, archivedAt: null, title: 'Steer A', workspaceId: 'wks_0001',
    provider: 'codex', model: 'm', labels: { [LABEL.repo]: 'example/repo', [LABEL.role]: 'steer', [LABEL.slot]: 'A', [LABEL.scope]: 'example/repo' },
  };
}

function workerAgent(id, status = 'idle') {
  return {
    id, status, archivedAt: null, title: 'w', workspaceId: 'wks_0001', cwd: '/p/demo',
    provider: 'codex', model: 'm', labels: { [LABEL.role]: 'worker', [LABEL.scope]: 'example/repo', 'paseo.parent-agent-id': 'agent-steer' },
  };
}

test('steerStatus exposes plugin restart marks with interrupted and reason JSON', () => {
  const d = discoveryWith({
    checkpoint: { task: 't', tests: [], blockers: [], next: null, epoch: 3, updatedAt: OLD_CP, capturedAt: OLD_CP, interrupted: { agentId: 'agent-s', at: OLD_CP, reason: 'daemon-restart' } },
    agents: { 'agent-s': { interrupted: { at: OLD_CP, reason: 'daemon-restart' } } },
    steers: [{ ...steerAgent('agent-s'), labels: { [LABEL.repo]: 'example/repo', [LABEL.role]: 'steer', [LABEL.slot]: 'A' } }],
    workers: [],
  });
  const status = steerStatus(d);
  assert.deepEqual(status.restartInterrupted, [{ agentId: 'agent-s', reason: 'daemon-restart', at: OLD_CP, heuristic: false }]);
  assert.deepEqual(status.steers[0].interrupted, { at: OLD_CP, reason: 'daemon-restart' });
  assert.equal(status.steers[0].reason, 'daemon-restart');
  const clean = steerStatus(discoveryWith({
    checkpoint: { task: 't', tests: [], blockers: [], next: null, epoch: 3, updatedAt: OLD_CP },
    agents: {}, steers: [steerAgent('agent-s')], workers: [],
  }));
  assert.equal(clean.restartInterrupted, undefined);
  assert.equal(clean.steers[0].interrupted, undefined);
  assert.equal(clean.steers[0].reason, undefined);
});

test('steerStatus heuristic marks idle agents without CHECKPOINT after a restart', () => {
  const d = discoveryWith({
    checkpoint: { task: 't', tests: [], blockers: [], next: null, epoch: 3, updatedAt: OLD_CP, capturedAt: OLD_CP },
    agents: {},
    steers: [steerAgent('agent-idle'), { ...steerAgent('agent-busy', 'running'), labels: { [LABEL.repo]: 'example/repo', [LABEL.role]: 'steer', [LABEL.slot]: 'B' } }],
    workers: [workerAgent('agent-w')],
  });
  const status = steerStatus(d, { daemonStartedAt: DAEMON, lastTurnCheckpoints: { 'agent-idle': false, 'agent-busy': false, 'agent-w': true } });
  assert.deepEqual(status.restartInterrupted, [{ agentId: 'agent-idle', reason: 'daemon-restart', at: null, heuristic: true }]);
  assert.equal(status.steers.find((s) => s.id === 'agent-idle').reason, 'daemon-restart');
  assert.equal(status.steers.find((s) => s.id === 'agent-idle').interrupted.heuristic, true);
  assert.equal(status.workers[0].interrupted, undefined);
  const fresh = steerStatus(d, { daemonStartedAt: OLD_CP, lastTurnCheckpoints: { 'agent-idle': false } });
  assert.equal(fresh.restartInterrupted, undefined);
});

test('resume brief shows the German restart line for marks and guesses', () => {
  const d = discoveryWith({
    checkpoint: { task: 't', tests: [], blockers: [], next: null, epoch: 3, updatedAt: OLD_CP, capturedAt: OLD_CP, source: 'manual' },
    agents: { 'agent-m': { interrupted: { at: OLD_CP, reason: 'daemon-restart', excerpt: 'tail' } } },
    steers: [steerAgent('agent-m')],
    workers: [],
  });
  const status = steerStatus(d);
  const brief = buildResumeBrief(status, { agentState: d.mainWorkspace.metadata[AGENTS_KEY], scope: d.scope, now: () => NOW });
  assert.match(brief, /Agent agent-m durch Neustart unterbrochen \(daemon-restart\)/);
  const guess = buildResumeBrief(status, {
    agentState: {}, scope: d.scope, now: () => NOW,
    daemonStartedAt: DAEMON, lastTurnCheckpoints: { 'agent-m': false },
  });
  assert.match(guess, /Agent agent-m durch Neustart unterbrochen \(daemon-restart, vermutet\)/);
  const quiet = buildResumeBrief(status, { agentState: {}, scope: d.scope, now: () => NOW });
  assert.ok(!quiet.includes('durch Neustart unterbrochen'));
});

function scopeStateWith({ checkpoint, agents, agentStatus = 'idle' }) {
  const workspace = {
    id: 'wks_main1', projectId: 'proj-1', title: 'Main', name: 'Main', workspaceDirectory: '/p/web',
    metadata: {
      wsf: { main: true, activeSteer: 'A', epoch: 3, scope: { id: 'example/web', kind: 'github', locator: 'example/web' } },
      ...(checkpoint ? { 'wsf.checkpoint': checkpoint } : {}),
      ...(agents ? { 'wsf.agents': agents } : {}),
    },
  };
  return {
    workspaces: [workspace],
    agents: [{
      id: 'steer-a', workspaceId: 'wks_main1', archivedAt: null, title: 'Steer A',
      provider: 'codex', model: 'm', status: agentStatus,
      labels: { 'wsf.role': 'steer', 'wsf.slot': 'A', 'wsf.scope': 'example/web' },
    }],
    projects: [], providers: [],
  };
}

test('scopes rows carry interrupted JSON and format the restart line', () => {
  const state = scopeStateWith({
    checkpoint: { task: 't', tests: [], blockers: [], next: 'n', epoch: 3, updatedAt: OLD_CP, interrupted: { agentId: 'steer-a', at: OLD_CP, reason: 'daemon-restart' } },
    agents: { 'steer-a': { interrupted: { at: OLD_CP, reason: 'daemon-restart' } } },
  });
  const [row] = scopeRows(state, { now: () => NOW });
  assert.deepEqual(row.checkpoint.interrupted, { agentId: 'steer-a', at: OLD_CP, reason: 'daemon-restart' });
  assert.deepEqual(row.restartInterrupted, [{ agentId: 'steer-a', reason: 'daemon-restart', at: OLD_CP, heuristic: false }]);
  assert.match(formatScopeRows([row]), /Agent steer-a durch Neustart unterbrochen \(daemon-restart\)/);
  const plain = scopeRows(scopeStateWith({ checkpoint: { task: 't', tests: [], blockers: [], next: null, epoch: 3, updatedAt: OLD_CP } }), { now: () => NOW })[0];
  assert.equal(plain.restartInterrupted, undefined);
  assert.equal(plain.checkpoint.interrupted, undefined);
  assert.ok(!formatScopeRows([plain]).includes('Neustart'));
  const guessed = scopeRows(
    scopeStateWith({ checkpoint: { task: 't', tests: [], blockers: [], next: null, epoch: 3, updatedAt: OLD_CP, capturedAt: OLD_CP } }),
    { now: () => NOW, daemonStartedAt: DAEMON, lastTurnCheckpoints: { 'steer-a': false } },
  )[0];
  assert.equal(guessed.restartInterrupted[0].heuristic, true);
  assert.match(formatScopeRows([guessed]), /vermutet/);
});
