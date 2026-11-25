// Scopes view + status show the live continuation tab as slot holder.
// Fake-state only: origin steers with a Codex continuation tab (label edge
// and timeline-switch edge) resolve to the live tab, the origin is marked
// superseded via continuedFrom, and no duplicate rows appear.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeRows, formatScopeRows, formatStatus } from '../plugin/server/core/scopes-view.mjs';
import { discoverRepository } from '../plugin/server/core/discovery.mjs';
import { steerStatus } from '../plugin/server/core/steer.mjs';
import { CONTINUED_FROM_LABEL } from '../plugin/server/core/zerosub.mjs';
import { LABEL, METADATA_KEY } from '../plugin/server/core/paseo.mjs';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

function mainWorkspace({ id, dir, scope, activeSteer, epoch }) {
  return {
    id, projectId: 'proj-1', title: 'Main', name: 'Main', workspaceDirectory: dir,
    metadata: {
      wsf: { main: true, activeSteer, epoch, scope },
      'wsf.checkpoint': { task: 'Ship it', tests: ['npm test'], blockers: [], next: 'Cut a release', epoch, updatedAt: ago(3600_000) },
    },
  };
}

function originSteer({ id, workspaceId, slot, repo, used = 12000, max = 200000 }) {
  return {
    id, workspaceId, archivedAt: null, title: `Steer ${slot}`, provider: 'codex', model: 'gpt-6.2-sol', status: 'idle',
    labels: { 'wsf.role': 'steer', 'wsf.repo': repo, 'wsf.scope': repo, 'wsf.slot': slot },
    lastUsage: { contextWindowUsedTokens: used, contextWindowMaxTokens: max },
  };
}

function continuationTab({ id, workspaceId, originId, used = 3000, max = 200000, withLabel = true }) {
  return {
    id, workspaceId, archivedAt: null, title: 'Steer A', provider: 'codex', model: 'gpt-6.2-sol', status: 'idle',
    labels: withLabel ? { [CONTINUED_FROM_LABEL]: originId } : {},
    lastUsage: { contextWindowUsedTokens: used, contextWindowMaxTokens: max },
  };
}

function continuationState({ withLabel = true } = {}) {
  const workspace = mainWorkspace({
    id: 'wks_main1', dir: '/home/you/projects/web', activeSteer: 'A', epoch: 3,
    scope: { id: 'example/web', kind: 'github', locator: 'example/web' },
  });
  const origin = originSteer({ id: 'steer-origin', workspaceId: 'wks_main1', slot: 'A', repo: 'example/web' });
  const live = continuationTab({ id: 'steer-live', workspaceId: 'wks_main1', originId: 'steer-origin', withLabel });
  return {
    workspaces: [workspace],
    agents: [origin, live],
    projects: [{ projectId: 'proj-1', projectRootPath: '/home/you/projects/web' }],
    providers: [],
  };
}

test('scopes view shows the live continuation tab as holder, origin marked superseded', () => {
  const [row] = scopeRows(continuationState(), { now: () => NOW });
  assert.equal(row.id, 'example/web');
  assert.equal(row.active.id, 'steer-live');
  assert.equal(row.active.slot, 'A');
  assert.equal(row.active.continuedFrom, 'steer-origin');
  // Usage follows the live tab, not the origin.
  assert.deepEqual(row.usage, { usedTokens: 3000, maxTokens: 200000 });
  // One row per scope, no duplicate holder rows.
  assert.equal(scopeRows(continuationState(), { now: () => NOW }).length, 1);
  const text = formatScopeRows([row]);
  assert.match(text, /steer A codex\/gpt-6\.2-sol/);
  assert.match(text, /continued-from steer-origin/);
});

test('scopes view follows timeline switches the same way', () => {
  const state = continuationState({ withLabel: false });
  const switches = [{ agentId: 'steer-origin', continuedIn: 'steer-live' }];
  const [row] = scopeRows(state, { now: () => NOW, zerosubSwitches: switches });
  assert.equal(row.active.id, 'steer-live');
  assert.equal(row.active.continuedFrom, 'steer-origin');
  // Without the switch pair the origin stays the holder (no label edge).
  const [plain] = scopeRows(state, { now: () => NOW });
  assert.equal(plain.active.id, 'steer-origin');
  assert.equal(plain.active.continuedFrom, undefined);
  assert.ok(!formatScopeRows([plain]).includes('continued-from'));
});

test('scopes view without a continuation stays unchanged', () => {
  const workspace = mainWorkspace({
    id: 'wks_main1', dir: '/home/you/projects/web', activeSteer: 'A', epoch: 3,
    scope: { id: 'example/web', kind: 'github', locator: 'example/web' },
  });
  const state = {
    workspaces: [workspace],
    agents: [originSteer({ id: 'steer-a', workspaceId: 'wks_main1', slot: 'A', repo: 'example/web' })],
    projects: [], providers: [],
  };
  const [row] = scopeRows(state, { now: () => NOW });
  assert.deepEqual(row.active, { slot: 'A', id: 'steer-a', model: 'codex/gpt-6.2-sol', status: 'idle' });
  assert.ok(!formatScopeRows([row]).includes('continued-from'));
});

const DIR_CONFIG = {
  version: 1, github: { owner: 'Test', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p', workspaceTitle: 'Main',
  profiles: { codex: { provider: 'codex', model: 'codex' } },
  steers: { slots: { E: 'codex' }, prepare: ['E'], initialActive: 'E' },
  workers: { priority: ['codex'], defaultProfile: 'codex' },
};

function dirDiscovery({ switches = [], withLabel = true } = {}) {
  const workspace = {
    id: 'wks_test0000000001', projectId: 'prj_1', workspaceDirectory: '/p/proj',
    workspaceKind: 'local_checkout', title: 'Main', name: 'Main',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'E', epoch: 1, scope: { id: 'proj', kind: 'dir', locator: '/p/proj' } } },
  };
  const origin = {
    id: 'agent-origin', workspaceId: workspace.id, status: 'idle', archivedAt: null,
    title: 'Steer E', provider: 'codex', model: 'codex',
    labels: { [LABEL.repo]: 'proj', [LABEL.scope]: 'proj', [LABEL.role]: 'steer', [LABEL.slot]: 'E' },
  };
  const cont = {
    id: 'agent-cont', workspaceId: workspace.id, status: 'idle', archivedAt: null,
    title: 'Steer E', provider: 'codex', model: 'codex',
    labels: withLabel ? { [CONTINUED_FROM_LABEL]: 'agent-origin' } : {},
  };
  return discoverRepository({ local: '/p/proj' }, {
    config: DIR_CONFIG,
    gh: () => { throw new Error('no github'); },
    git: () => { throw new Error('no git'); },
    checkouts: [{ path: '/p/proj', linkedWorktree: false, remotes: {}, repos: {} }],
    paseo: {
      projects: [{ projectId: 'prj_1', projectRootPath: '/p/proj' }],
      workspaces: [workspace],
      agents: [origin, cont],
      providers: [],
    },
    existsDir: () => true,
    zerosubSwitches: switches,
  });
}

test('status shows the live continuation tab as holder, origin marked superseded', () => {
  const status = steerStatus(dirDiscovery());
  assert.deepEqual(status.steers.map((s) => [s.slot, s.id]), [['E', 'agent-cont']]);
  assert.equal(status.steers[0].continuedFrom, 'agent-origin');
  const text = formatStatus(status);
  assert.match(text, /Steer E.*agent-cont/);
  assert.match(text, /continued-from agent-origin/);
  assert.ok(!text.includes('agent-origin  codex'));
});

test('status follows timeline switches and keeps plain steers unchanged', () => {
  const switched = steerStatus(dirDiscovery({
    withLabel: false,
    switches: [{ agentId: 'agent-origin', continuedIn: 'agent-cont' }],
  }));
  assert.equal(switched.steers[0].id, 'agent-cont');
  assert.equal(switched.steers[0].continuedFrom, 'agent-origin');
  const plain = steerStatus(dirDiscovery({ withLabel: false }));
  assert.equal(plain.steers[0].id, 'agent-origin');
  assert.equal(plain.steers[0].continuedFrom, undefined);
  assert.ok(!formatStatus(plain).includes('continued-from'));
});
