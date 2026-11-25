// Retired-scope rules: retired scopes (kept from old installs) refuse
// coordination (switch/fresh/assign) and steer planning, and stay visible in
// status and scopes. Fakes only; no daemon, no filesystem, no git.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureRuntime } from '../src/runtime.mjs';
import { LABEL, METADATA_KEY, PARENT_LABEL } from '../src/paseo.mjs';
import { steerStatus, switchSteer } from '../src/steer.mjs';
import { freshSteer } from '../src/steer.mjs';
import { planRepository } from '../src/planner.mjs';
import { withLock } from '../src/lock.mjs';

// Locked paths take real workspace locks; keep them in a throwaway state dir
// instead of the production one (per-file processes).
configureRuntime({ runtime: { stateDir: mkdtempSync(join(tmpdir(), 'wsf-retired-')) } });

// ---------------------------------------------------------------- fixtures

const REPO = 'example-owner/example-repo';
const CONFIG = {
  version: 1,
  github: { owner: 'example-owner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    std: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
    cheap: { provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null, mode: 'allowAll' },
  },
  steers: { slots: { A: 'std', B: 'cheap' }, prepare: ['A', 'B'], initialActive: 'A' },
  workers: { defaultProfile: 'cheap' },
};
const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'full-access' }] },
  { provider: 'muse', enabled: true, status: 'ready', models: [{ id: 'muse-spark-1.3-contributor', thinkingOptions: [] }], modes: [{ id: 'allowAll' }] },
];

function makeWorld() {
  return { projects: [], workspaces: [], agents: [], providers: structuredClone(PROVIDERS), calls: [], receipts: new Map(), fingerprints: new Map(), seq: 0, hooks: {} };
}

function addWorkspace(world, { path, title = 'Main', metadata = {}, id } = {}) {
  const ws = { id: id ?? `wks_${String(++world.seq).padStart(4, '0')}`, projectId: 'prj_1', workspaceDirectory: path, workspaceKind: 'local_checkout', title, name: title, metadata: structuredClone(metadata), createdAt: '2026-11-23T00:00:00.000Z' };
  world.workspaces.push(ws);
  if (!world.projects.some((p) => p.projectId === ws.projectId)) {
    world.projects.push({ projectId: ws.projectId, projectKey: `test-key-${ws.projectId}`, projectRootPath: path, projectDisplayName: 'demo', projectKind: ws.projectKind ?? 'git' });
  }
  return ws;
}

function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}

function provisioned(world) {
  const ws = addWorkspace(world, {
    path: '/p/demo',
    metadata: {
      [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 3 },
      [`${METADATA_KEY}.checkpoint`]: { task: 'Ship it', tests: ['npm test'], blockers: [], next: 'tag', epoch: 3, updatedAt: '2026-11-23T00:00:00.000Z' },
    },
  });
  const steers = {
    A: addAgent(world, { provider: 'codex', model: 'gpt-6.2-sol', title: 'Steer A', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'A' } }),
    B: addAgent(world, { provider: 'muse', model: 'muse-spark-1.3-contributor', title: 'Steer B', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'B' } }),
  };
  addAgent(world, { provider: 'muse', model: 'm', title: 'Worker 1', workspaceId: ws.id, labels: { [PARENT_LABEL]: steers.A.id } });
  return { ws, steers };
}

function discoveryOf(world, forkName = REPO) {
  return {
    forkName,
    mainWorkspace: world.workspaces[0] ? structuredClone(world.workspaces[0]) : null,
    steers: { labelled: structuredClone(world.agents.filter((a) => a.labels?.[LABEL.role] === 'steer')), legacy: [] },
    workers: structuredClone(world.agents.filter((a) => a.labels?.[PARENT_LABEL])),
    providers: structuredClone(world.providers),
  };
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  const fingerprint = (opts) => JSON.stringify({ ...opts, idempotencyKey: undefined });
  const agentHandle = (id) => ({
    id,
    refresh: async () => ({ agent: structuredClone(findAgent(id)) }),
    send: async (text) => {
      world.calls.push(['agent.send', id, text]);
    },
    timeline: { refetch: async () => ({ entries: [{ item: { type: 'assistant_message', text: 'Done.' } }] }) },
  });
  const workspaceHandle = (id) => ({
    id,
    refresh: async () => structuredClone(findWs(id)),
    setMetadata: async (patch) => {
      world.calls.push(['workspace.setMetadata', id, patch]);
      for (const [key, value] of Object.entries(structuredClone(patch))) {
        if (value === null) delete findWs(id).metadata[key];
        else findWs(id).metadata[key] = value;
      }
    },
    agents: {
      create: async (opts) => {
        world.calls.push(['agent.create', opts]);
        if (opts.idempotencyKey && world.receipts.has(opts.idempotencyKey)) {
          if (world.fingerprints.get(opts.idempotencyKey) !== fingerprint(opts)) throw new Error('agent_request_key_conflict');
          return agentHandle(world.receipts.get(opts.idempotencyKey));
        }
        const [provider, model] = opts.config.provider.split('/');
        const agent = addAgent(world, { provider, model, title: opts.title, workspaceId: id, labels: { ...opts.labels } });
        if (opts.idempotencyKey) {
          world.receipts.set(opts.idempotencyKey, agent.id);
          world.fingerprints.set(opts.idempotencyKey, fingerprint(opts));
        }
        if (world.hooks.dropAgentCreate?.(opts)) throw new Error('socket closed before agent.create response');
        return agentHandle(agent.id);
      },
    },
  });
  return {
    workspaces: {
      ref: workspaceHandle,
      create: async ({ source, title, metadata, idempotencyKey }) => {
        world.calls.push(['workspace.create', { source, title, metadata, idempotencyKey }]);
        const print = JSON.stringify({ source, title, metadata });
        if (idempotencyKey && world.receipts.has(idempotencyKey)) {
          if (world.fingerprints.get(idempotencyKey) !== print) throw new Error('workspace_request_key_conflict');
          return workspaceHandle(world.receipts.get(idempotencyKey));
        }
        const ws = addWorkspace(world, { path: source.path, title, metadata });
        if (idempotencyKey) {
          world.receipts.set(idempotencyKey, ws.id);
          world.fingerprints.set(idempotencyKey, print);
        }
        return workspaceHandle(ws.id);
      },
    },
    agents: { ref: agentHandle },
  };
}

const LOCK_TMP = mkdtempSync(join(tmpdir(), 'wsf-retired-lock-'));

const testLock = (name, fn) => withLock(name, fn, { dir: LOCK_TMP });

// ---------------------------------------------------------------- retired rules (S1)

function retiredDiscovery(world) {
  world.workspaces[0].metadata[METADATA_KEY] = { main: true, activeSteer: null, epoch: 4, previousSteer: 'A', retired: true, movedTo: '/p/moved' };
  return discoveryOf(world);
}

test('switch and fresh refuse retired scopes, naming the successor', async () => {
  const world = makeWorld();
  provisioned(world);
  const discovery = retiredDiscovery(world);
  await assert.rejects(
    switchSteer({ client: fakeClient(world), discovery, toSlot: 'B', lock: testLock, language: 'en' }),
    /Scope example-owner\/example-repo is retired \(moved to \/p\/moved\); coordinate in the successor scope/,
  );
  await assert.rejects(
    freshSteer({ client: fakeClient(world), discovery, config: CONFIG, lock: testLock, language: 'en' }),
    /already retired|is retired/,
  );
  assert.deepEqual(world.calls, [], 'no writes to a retired scope');
});

test('planner reports retired scopes as conflict and plans no steers', () => {
  const world = makeWorld();
  provisioned(world);
  const discovery = {
    local: true,
    github: { local: true, fork: { status: 'local' }, upstream: null, source: null, notes: [] },
    forkName: 'local/demo',
    expectedPath: '/p/demo',
    cloneTarget: null,
    checkout: { path: '/p/demo', linkedWorktree: false, remotes: {}, repos: {}, local: true },
    checkoutIssues: [],
    relatedCheckouts: [],
    upstreamRemote: null,
    projects: [{ projectId: 'prj_1' }],
    mainCandidates: [],
    otherLocalWorkspaces: [],
    mainWorkspace: {
      id: 'wks_0001', projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout',
      title: 'Main', name: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: null, epoch: 2, retired: true, movedTo: '/p/moved' } },
    },
    steers: { labelled: [], legacy: [] },
    workers: [],
    providers: structuredClone(PROVIDERS),
  };
  discovery.mainCandidates = [discovery.mainWorkspace];
  const plan = planRepository(discovery, CONFIG, {});
  assert.equal(plan.status, 'conflict');
  assert.ok(plan.conflicts.some((c) => c.key === 'workspace.main' && /retired, movedTo \/p\/moved/.test(c.reason)), JSON.stringify(plan.conflicts));
  assert.ok(!plan.ops.some((op) => op.key.startsWith('steer.')), JSON.stringify(plan.ops.map((op) => op.key)));
});

test('status carries retired state and null active steer stays robust', async () => {
  const world = makeWorld();
  provisioned(world);
  const status = steerStatus(retiredDiscovery(world));
  assert.equal(status.state.retired, true);
  assert.equal(status.state.movedTo, '/p/moved');
  assert.equal(status.state.activeSteer, null);

  const nulled = makeWorld();
  provisioned(nulled);
  nulled.workspaces[0].metadata[METADATA_KEY].activeSteer = null;
  const preview = await switchSteer({ client: fakeClient(nulled), discovery: discoveryOf(nulled), toSlot: 'B', lock: testLock, language: 'en' });
  assert.equal(preview.to, 'B');
  assert.equal(preview.applied, false);
});
