// Prefix migration tests: `ari.wsf*` records are still read (the new `wsf*`
// prefix wins), a `labels.migrate` op rewrites them, and a fresh plan after
// the apply is clean. Fakes only; no daemon, no GitHub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LABEL, METADATA_KEY, PARENT_LABEL, LEGACY_PREFIX, newKeyForLegacyKey, pendingLegacyKeys, readPaseoState } from '../src/paseo.mjs';
import { planRepository, planHash } from '../src/planner.mjs';
import { applyPlans, createAuthorization, createExecutors, memoryProgress } from '../src/apply.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureRuntime } from '../src/runtime.mjs';

// The migrate executor takes the real workspace lock; keep lock files in a
// throwaway state dir instead of the production one (per-file processes).
configureRuntime({ runtime: { stateDir: mkdtempSync(join(tmpdir(), 'wsf-prefix-')) } });

// ---------------------------------------------------------------- fixtures

const CONFIG = {
  version: 1,
  github: { owner: 'example-owner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    std: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
  },
  steers: { slots: { A: 'std' }, prepare: ['A'], initialActive: 'A' },
  workers: { defaultProfile: 'std' },
};
const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'full-access' }] },
];
const LEGACY_STATE = { main: true, activeSteer: 'A', epoch: 3 };
const LEGACY_CHECKPOINT = { task: 'Ship it', tests: [], blockers: [], epoch: 3, updatedAt: '2026-11-23T00:00:00.000Z' };

function makeWorld() {
  return { projects: [], workspaces: [], agents: [], providers: structuredClone(PROVIDERS), calls: [], seq: 0 };
}

function addWorkspace(world, { metadata, title = 'Main' }) {
  const ws = { id: `wks_${String(++world.seq).padStart(4, '0')}`, projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout', title, name: title, metadata: structuredClone(metadata), createdAt: '2026-11-23T00:00:00.000Z' };
  world.workspaces.push(ws);
  if (!world.projects.some((p) => p.projectId === ws.projectId)) {
    world.projects.push({ projectId: ws.projectId, projectRootPath: '/p/demo', projectDisplayName: 'demo' });
  }
  return ws;
}

function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}

/** A provisioned local repo whose records still carry the pilot prefix. */
function provisionedLegacy(world) {
  const ws = addWorkspace(world, { metadata: { 'ari.wsf': LEGACY_STATE, 'ari.wsf.checkpoint': LEGACY_CHECKPOINT } });
  const steerA = addAgent(world, {
    provider: 'codex', model: 'gpt-6.2-sol', title: 'Steer A', workspaceId: ws.id,
    labels: { 'ari.wsf.repo': 'local/demo', 'ari.wsf.role': 'steer', 'ari.wsf.slot': 'A' },
  });
  const workerOld = addAgent(world, {
    provider: 'codex', model: 'gpt-6.2-sol', title: 'Worker 1', workspaceId: ws.id,
    labels: { [PARENT_LABEL]: steerA.id, 'ari.wsf.lifecycle': 'reusable' },
  });
  const workerNew = addAgent(world, {
    provider: 'codex', model: 'gpt-6.2-sol', title: 'Worker 2', workspaceId: ws.id,
    labels: { [PARENT_LABEL]: steerA.id, 'wsf.lifecycle': 'reusable' },
  });
  return { ws, steerA, workerOld, workerNew };
}

/** Paginated list client over the fake world, shaped like the SDK. */
function listClient(world) {
  const page = (entries) => async () => ({ entries, pageInfo: { hasMore: false } });
  return {
    projects: { list: async () => ({ projects: world.projects }) },
    workspaces: { list: page(world.workspaces) },
    agents: { list: page(world.agents.map((agent) => ({ agent }))) },
    providers: { snapshot: async () => ({ entries: world.providers }) },
  };
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  return {
    workspaces: {
      ref: (id) => ({
        refresh: async () => structuredClone(findWs(id)),
        setMetadata: async (patch) => {
          world.calls.push(['workspace.setMetadata', id, patch]);
          for (const [key, value] of Object.entries(structuredClone(patch))) {
            if (value === null) delete findWs(id).metadata[key]; // the SDK removes null keys
            else findWs(id).metadata[key] = value;
          }
        },
      }),
    },
    agents: {
      ref: (id) => ({ refresh: async () => ({ agent: structuredClone(findAgent(id)) }) }),
    },
  };
}

function fakePaseoCli(world) {
  return (args) => {
    world.calls.push(['paseo', ...args]);
    if (args[0] === 'agent' && args[1] === 'update') {
      const agent = world.agents.find((a) => a.id === args[2]);
      for (const pair of args[4].split(',')) {
        const [k, v] = pair.split('=');
        agent.labels[k] = v; // add/set only: old labels cannot be removed
      }
      return { id: agent.id };
    }
    throw new Error(`unexpected paseo ${args.join(' ')}`);
  };
}

/** Minimal local-mode discovery from a normalized daemon snapshot. */
function discoveryFromState(state) {
  const main = state.workspaces[0] ?? null;
  return {
    local: true,
    github: { local: true, fork: { status: 'local' }, upstream: null, source: null, notes: [] },
    forkName: 'local/demo',
    expectedPath: '/p/demo',
    cloneTarget: null,
    checkout: { path: '/p/demo', linkedWorktree: false, remotes: {}, repos: {}, local: true },
    checkoutIssues: [],
    relatedCheckouts: [],
    upstreamRemote: null,
    projects: state.projects,
    mainCandidates: main ? [main] : [],
    otherLocalWorkspaces: [],
    mainWorkspace: main,
    steers: { labelled: state.agents.filter((a) => a.labels?.[LABEL.role] === 'steer'), legacy: [] },
    workers: state.agents.filter((a) => a.labels?.[PARENT_LABEL]),
    providers: state.providers,
  };
}

// ---------------------------------------------------------------- key mapping

test('legacy key mapping: ari.wsf* counterparts, nothing else', () => {
  assert.equal(LEGACY_PREFIX, 'ari.wsf');
  assert.equal(METADATA_KEY, 'wsf');
  assert.equal(newKeyForLegacyKey('ari.wsf'), 'wsf');
  assert.equal(newKeyForLegacyKey('ari.wsf.slot'), 'wsf.slot');
  assert.equal(newKeyForLegacyKey('ari.wsf.checkpoint'), 'wsf.checkpoint');
  for (const other of ['wsf.slot', 'wsf', 'paseo.parent-agent-id', 'ari.wsf2.x', '', null, undefined, 42]) {
    assert.equal(newKeyForLegacyKey(other), null, String(other));
  }
  assert.deepEqual(pendingLegacyKeys({ 'ari.wsf.role': 'steer' }), ['ari.wsf.role']);
  assert.deepEqual(pendingLegacyKeys({ 'ari.wsf.role': 'steer', 'wsf.role': 'steer' }), []);
  assert.deepEqual(pendingLegacyKeys({ 'wsf.role': 'steer' }), []);
  assert.deepEqual(pendingLegacyKeys(null), []);
});

// ---------------------------------------------------------------- read compatibility

test('readPaseoState normalizes legacy records; mixed records keep both, new wins', async () => {
  const world = makeWorld();
  addWorkspace(world, { metadata: { 'ari.wsf': LEGACY_STATE } });
  addWorkspace(world, { metadata: { 'ari.wsf': { main: true }, [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 9 } } });
  addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } } });
  const state = await readPaseoState(listClient(world));

  const [legacy, mixed, fresh] = state.workspaces;
  assert.deepEqual(legacy.metadata[METADATA_KEY], LEGACY_STATE);
  assert.equal(legacy.legacyPrefix, true);
  assert.deepEqual(legacy.legacyPending, ['ari.wsf']);
  assert.deepEqual(mixed.metadata[METADATA_KEY], { main: true, activeSteer: 'A', epoch: 9 });
  assert.equal(mixed.legacyPrefix, true);
  assert.equal(mixed.legacyPending, undefined);
  assert.equal(fresh.legacyPrefix, undefined);
  assert.equal(fresh.legacyPending, undefined);
});

test('legacy steer labels still identify the steer through the new constants', async () => {
  const world = makeWorld();
  provisionedLegacy(world);
  const state = await readPaseoState(listClient(world));
  const steer = state.agents.find((a) => a.labels?.[LABEL.role] === 'steer');
  assert.ok(steer);
  assert.equal(steer.labels[LABEL.slot], 'A');
  assert.equal(steer.legacyPrefix, true);
  assert.deepEqual([...steer.legacyPending].sort(), ['ari.wsf.repo', 'ari.wsf.role', 'ari.wsf.slot']);
});

// ---------------------------------------------------------------- planning

test('planner proposes one workspace op and one op per legacy agent, none when clean', async () => {
  const world = makeWorld();
  const { ws, steerA, workerOld, workerNew } = provisionedLegacy(world);
  const plan = planRepository(discoveryFromState(await readPaseoState(listClient(world))), CONFIG, {});
  assert.equal(plan.status, 'pending');
  const keys = plan.ops.map((op) => op.key);
  assert.ok(keys.includes('labels.migrate.workspace'), keys.join(','));
  assert.ok(keys.includes(`labels.migrate.agent.${steerA.id}`), keys.join(','));
  assert.ok(keys.includes(`labels.migrate.agent.${workerOld.id}`), keys.join(','));
  assert.ok(!keys.includes(`labels.migrate.agent.${workerNew.id}`), keys.join(','));

  const workspaceOp = plan.ops.find((op) => op.key === 'labels.migrate.workspace');
  assert.deepEqual(workspaceOp.params, { target: 'workspace', workspaceId: ws.id, migrate: ['ari.wsf', 'ari.wsf.checkpoint'] });
  const agentOp = plan.ops.find((op) => op.key === `labels.migrate.agent.${steerA.id}`);
  assert.equal(agentOp.kind, 'labels.migrate');
  assert.deepEqual(agentOp.params, { target: 'agent', agentId: steerA.id, migrate: ['ari.wsf.repo', 'ari.wsf.role', 'ari.wsf.slot'] });

  const again = planRepository(discoveryFromState(await readPaseoState(listClient(world))), CONFIG, {});
  assert.equal(planHash([again], CONFIG), planHash([plan], CONFIG), 'same state, same hash');

  const migrated = makeWorld();
  const migratedWs = addWorkspace(migrated, { metadata: { [METADATA_KEY]: LEGACY_STATE, [`${METADATA_KEY}.checkpoint`]: LEGACY_CHECKPOINT } });
  const migratedSteer = addAgent(migrated, {
    provider: 'codex', model: 'gpt-6.2-sol', title: 'Steer A', workspaceId: migratedWs.id,
    labels: { [LABEL.repo]: 'local/demo', [LABEL.role]: 'steer', [LABEL.slot]: 'A' },
  });
  addAgent(migrated, {
    provider: 'codex', model: 'gpt-6.2-sol', title: 'Worker 1', workspaceId: migratedWs.id,
    labels: { [PARENT_LABEL]: migratedSteer.id, 'wsf.lifecycle': 'reusable' },
  });
  const clean = planRepository(discoveryFromState(await readPaseoState(listClient(migrated))), CONFIG, {});
  assert.equal(clean.status, 'complete');
  assert.ok(!clean.ops.some((op) => op.kind === 'labels.migrate'));
});

// ---------------------------------------------------------------- execution

test('workspace migration copies values to wsf.* and removes the old keys', async () => {
  const world = makeWorld();
  const { ws } = provisionedLegacy(world);
  const execute = createExecutors({ client: fakeClient(world), paseoCli: fakePaseoCli(world) });
  const result = await execute({ key: 'labels.migrate.workspace', kind: 'labels.migrate', params: { target: 'workspace', workspaceId: ws.id, migrate: ['ari.wsf', 'ari.wsf.checkpoint'] } }, CONFIG);
  assert.deepEqual(result, { workspaceId: ws.id, migrated: ['ari.wsf', 'ari.wsf.checkpoint'] });
  assert.deepEqual(world.workspaces[0].metadata, { [METADATA_KEY]: LEGACY_STATE, [`${METADATA_KEY}.checkpoint`]: LEGACY_CHECKPOINT });
});

test('agent migration persists new labels via the native CLI; old labels linger', async () => {
  const world = makeWorld();
  const { steerA, workerOld } = provisionedLegacy(world);
  const execute = createExecutors({ client: fakeClient(world), paseoCli: fakePaseoCli(world) });
  await execute({ key: `labels.migrate.agent.${steerA.id}`, kind: 'labels.migrate', params: { target: 'agent', agentId: steerA.id, migrate: ['ari.wsf.repo', 'ari.wsf.role', 'ari.wsf.slot'] } }, CONFIG);
  const calls = world.calls.filter((c) => c[0] === 'paseo');
  assert.deepEqual(calls, [['paseo', 'agent', 'update', steerA.id, '--label', 'wsf.repo=local/demo,wsf.role=steer,wsf.slot=A']]);
  assert.deepEqual(world.agents.find((a) => a.id === steerA.id).labels, {
    'ari.wsf.repo': 'local/demo', 'ari.wsf.role': 'steer', 'ari.wsf.slot': 'A',
    'wsf.repo': 'local/demo', 'wsf.role': 'steer', 'wsf.slot': 'A',
  });

  const workerResult = await execute({ key: `labels.migrate.agent.${workerOld.id}`, kind: 'labels.migrate', params: { target: 'agent', agentId: workerOld.id, migrate: ['ari.wsf.lifecycle'] } }, CONFIG);
  assert.equal(workerResult.oldLabelsRemain, true);
  assert.equal(world.agents.find((a) => a.id === workerOld.id).labels['wsf.lifecycle'], 'reusable');
});

test('migration refuses unknown targets, non-legacy keys and missing agents', async () => {
  const world = makeWorld();
  const { ws } = provisionedLegacy(world);
  const execute = createExecutors({ client: fakeClient(world), paseoCli: fakePaseoCli(world) });
  const run = (params) => execute({ key: 'labels.migrate.x', kind: 'labels.migrate', params }, CONFIG);
  await assert.rejects(run({ target: 'workspace', workspaceId: ws.id, migrate: [] }), /at least one legacy key/);
  await assert.rejects(run({ target: 'workspace', workspaceId: ws.id, migrate: ['wsf.slot'] }), /Not a legacy key/);
  await assert.rejects(run({ target: 'project', migrate: ['ari.wsf'] }), /target workspace or agent/);
  await assert.rejects(run({ target: 'agent', agentId: 'agent-404', migrate: ['ari.wsf.role'] }), /missing or archived/);
  world.agents[1].archivedAt = 'archived';
  await assert.rejects(run({ target: 'agent', agentId: world.agents[1].id, migrate: ['ari.wsf.role'] }), /missing or archived/);
});

// ---------------------------------------------------------------- full cycle

test('full cycle: plan migrates, apply executes, the next plan is clean', async () => {
  const world = makeWorld();
  provisionedLegacy(world);
  const client = fakeClient(world);
  const execute = createExecutors({ client, paseoCli: fakePaseoCli(world) });
  const planNow = async () => planRepository(discoveryFromState(await readPaseoState(listClient(world))), CONFIG, {});

  const before = await planNow();
  assert.ok(before.ops.some((op) => op.kind === 'labels.migrate'));
  for (const op of before.ops.filter((op) => op.kind === 'labels.migrate')) {
    await execute(op, CONFIG);
  }
  const after = await planNow();
  assert.equal(after.status, 'complete', JSON.stringify(after.ops));
  assert.ok(!after.ops.some((op) => op.kind === 'labels.migrate'));

  const state = await readPaseoState(listClient(world));
  assert.equal(state.workspaces[0].legacyPrefix, undefined);
  const steer = state.agents.find((a) => a.labels?.[LABEL.role] === 'steer');
  assert.equal(steer.legacyPrefix, true, 'lingering old labels stay readable');
  assert.equal(steer.legacyPending, undefined, 'but need no further migration');
});

test('migrate ops flow through the hash-confirmed apply loop', async () => {
  const world = makeWorld();
  const { ws, steerA } = provisionedLegacy(world);
  const ops = [
    { key: 'labels.migrate.workspace', kind: 'labels.migrate', summary: 'ws', params: { target: 'workspace', workspaceId: ws.id, migrate: ['ari.wsf', 'ari.wsf.checkpoint'] } },
    { key: `labels.migrate.agent.${steerA.id}`, kind: 'labels.migrate', summary: 'agent', params: { target: 'agent', agentId: steerA.id, migrate: ['ari.wsf.repo', 'ari.wsf.role', 'ari.wsf.slot'] } },
  ];
  const plan = { repo: 'local/demo', input: 'local/demo', status: 'pending', ops, conflicts: [], notes: [], observed: {} };
  const authorization = createAuthorization([plan], CONFIG, { entries: ['local/demo'] });
  const callCount = { n: 0 };
  const outcome = await applyPlans({
    authorization, config: CONFIG, confirm: authorization.hash, progress: memoryProgress(),
    runPlans: async () => {
      callCount.n += 1;
      if (callCount.n === 1) return [structuredClone(plan)]; // pre-apply hash check
      const executed = world.calls.filter((c) => c[0] === 'workspace.setMetadata' || c[0] === 'paseo').length;
      return [{ ...structuredClone(plan), ops: plan.ops.slice(executed), observed: {} }];
    },
    execute: createExecutors({ client: fakeClient(world), paseoCli: fakePaseoCli(world) }),
  });
  assert.equal(outcome.report[0].status, 'complete');
  assert.deepEqual(Object.keys(world.workspaces[0].metadata).sort(), [METADATA_KEY, `${METADATA_KEY}.checkpoint`]);
  assert.equal(world.agents.find((a) => a.id === steerA.id).labels['wsf.slot'], 'A');
});
