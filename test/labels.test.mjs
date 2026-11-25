// Labels audit tests: missing/wrong factory agent labels are reported with
// their fix (dry-run), legacy ari.wsf.* keys migrate along, and `labels.set`
// writes them via `agent update`. Fakes only; no daemon, no live apply.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LABEL, METADATA_KEY, PARENT_LABEL, readPaseoState } from '../src/paseo.mjs';
import { planLabelFixes, formatLabelFixes } from '../src/labels.mjs';
import { createExecutors } from '../src/apply.mjs';

// ---------------------------------------------------------------- fixtures

function makeWorld() {
  return { projects: [], workspaces: [], agents: [], providers: [], calls: [], seq: 0 };
}

function addScope(world, { id, path }) {
  const ws = {
    id: `wks_${String(++world.seq).padStart(4, '0')}`, projectId: 'prj_1', workspaceDirectory: path,
    workspaceKind: 'local_checkout', title: 'Main', name: 'Main',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id, kind: 'dir', locator: path } } },
    createdAt: '2026-11-24T00:00:00.000Z',
  };
  world.workspaces.push(ws);
  if (!world.projects.some((p) => p.projectId === ws.projectId)) {
    world.projects.push({ projectId: ws.projectId, projectRootPath: path, projectDisplayName: id });
  }
  return ws;
}

function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}

/** Two scopes with clean, legacy, half-labelled and stray agents. */
function provisioned(world) {
  const wsWeb = addScope(world, { id: 'web', path: '/p/web' });
  const wsApi = addScope(world, { id: 'api', path: '/p/api' });
  const steerA = addAgent(world, { provider: 'codex', model: 'm', title: 'Steer A', workspaceId: wsWeb.id, labels: { [LABEL.repo]: 'web', [LABEL.role]: 'steer', [LABEL.slot]: 'A', [LABEL.scope]: 'web' } });
  const oldSteer = addAgent(world, { provider: 'codex', model: 'm', title: 'Steer B', workspaceId: wsWeb.id, labels: { [LABEL.repo]: 'web' } });
  const legacySteer = addAgent(world, { provider: 'codex', model: 'm', title: 'Steer C', workspaceId: wsWeb.id, labels: { 'ari.wsf.repo': 'web', 'ari.wsf.role': 'steer', 'ari.wsf.slot': 'C' } });
  const halfSteer = addAgent(world, { provider: 'codex', model: 'm', title: 'Helper', workspaceId: wsWeb.id, labels: { [LABEL.role]: 'steer' } });
  const worker1 = addAgent(world, { provider: 'codex', model: 'm', title: 'Worker 1', workspaceId: wsWeb.id, labels: { [PARENT_LABEL]: steerA.id, [LABEL.scope]: 'web', [LABEL.role]: 'worker', [LABEL.owner]: 'A' } });
  const workerNoOwner = addAgent(world, { provider: 'codex', model: 'm', title: 'Worker 2', workspaceId: wsWeb.id, labels: { [PARENT_LABEL]: steerA.id, [LABEL.scope]: 'web', [LABEL.role]: 'worker' } });
  const bareWorker = addAgent(world, { provider: 'codex', model: 'm', title: 'Worker 3', workspaceId: wsWeb.id, labels: { [PARENT_LABEL]: steerA.id } });
  const typoWorker = addAgent(world, { provider: 'codex', model: 'm', title: 'Worker 4', workspaceId: wsWeb.id, labels: { [PARENT_LABEL]: steerA.id, [LABEL.scope]: 'weeb', [LABEL.role]: 'worker' } });
  const foreignSteer = addAgent(world, { provider: 'codex', model: 'm', title: 'Steer A', workspaceId: wsWeb.id, labels: { [LABEL.repo]: 'api', [LABEL.role]: 'steer', [LABEL.slot]: 'A', [LABEL.scope]: 'api' } });
  const archivedBad = addAgent(world, { provider: 'codex', model: 'm', title: 'Steer Z', workspaceId: wsWeb.id, archivedAt: '2026-11-24T00:00:00.000Z', labels: { [LABEL.role]: 'steer' } });
  const randomAgent = addAgent(world, { provider: 'codex', model: 'm', title: 'Scratch', workspaceId: wsWeb.id, labels: {} });
  const ambiguous = addAgent(world, { provider: 'codex', model: 'm', title: 'Notes', workspaceId: wsWeb.id, labels: { [LABEL.repo]: 'web' } });
  const apiSteer = addAgent(world, { provider: 'codex', model: 'm', title: 'Steer A', workspaceId: wsApi.id, labels: { [LABEL.repo]: 'api', [LABEL.role]: 'steer', [LABEL.slot]: 'A', [LABEL.scope]: 'api' } });
  const wrongRepo = addAgent(world, { provider: 'codex', model: 'm', title: 'Steer B', workspaceId: wsApi.id, labels: { [LABEL.repo]: 'WRONG', [LABEL.role]: 'steer', [LABEL.slot]: 'B', [LABEL.scope]: 'api' } });
  return { wsWeb, wsApi, steerA, oldSteer, legacySteer, halfSteer, worker1, workerNoOwner, bareWorker, typoWorker, foreignSteer, archivedBad, randomAgent, ambiguous, apiSteer, wrongRepo };
}

function listClient(world) {
  const page = (entries) => async () => ({ entries, pageInfo: { hasMore: false } });
  return {
    projects: { list: async () => ({ projects: world.projects }) },
    workspaces: { list: page(world.workspaces) },
    agents: { list: page(world.agents.map((agent) => ({ agent }))) },
    providers: { snapshot: async () => ({ entries: world.providers }) },
  };
}

const stateOf = (world) => readPaseoState(listClient(world));

function fakeClient(world) {
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  return { agents: { ref: (id) => ({ refresh: async () => ({ agent: structuredClone(findAgent(id)) }) }) } };
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

const byId = (rows, id) => rows.find((r) => r.agentId === id);

// ---------------------------------------------------------------- planning

test('steers with missing labels get completed (repo-only Alt-Steer, legacy prefix)', async () => {
  const world = makeWorld();
  const { oldSteer, legacySteer } = provisioned(world);
  const rows = planLabelFixes(await stateOf(world));
  const old = byId(rows, oldSteer.id);
  assert.equal(old.scope, 'web');
  assert.equal(old.kind, 'steer');
  assert.equal(old.slot, 'B');
  assert.deepEqual(old.labels, { [LABEL.scope]: 'web', [LABEL.role]: 'steer', [LABEL.slot]: 'B' });
  assert.deepEqual(old.was, { [LABEL.scope]: null, [LABEL.role]: null, [LABEL.slot]: null });
  const legacy = byId(rows, legacySteer.id);
  assert.deepEqual(legacy.labels, { [LABEL.repo]: 'web', [LABEL.scope]: 'web', [LABEL.role]: 'steer', [LABEL.slot]: 'C' });
  assert.deepEqual(legacy.migrate.sort(), ['ari.wsf.repo', 'ari.wsf.role', 'ari.wsf.slot']);
});

test('wrong values are overwritten; underivable slots stay manual with a note', async () => {
  const world = makeWorld();
  const { wrongRepo, halfSteer } = provisioned(world);
  const rows = planLabelFixes(await stateOf(world));
  const wrong = byId(rows, wrongRepo.id);
  assert.deepEqual(wrong.labels, { [LABEL.repo]: 'api' });
  assert.deepEqual(wrong.was, { [LABEL.repo]: 'WRONG' });
  const half = byId(rows, halfSteer.id);
  assert.deepEqual(half.labels, { [LABEL.repo]: 'web', [LABEL.scope]: 'web' });
  assert.match(half.note, /slot unknown/);
});

test('workers are completed from scope label and parent steer; clean agents stay silent', async () => {
  const world = makeWorld();
  const { steerA, worker1, workerNoOwner, bareWorker, typoWorker, apiSteer } = provisioned(world);
  const rows = planLabelFixes(await stateOf(world));
  assert.deepEqual(byId(rows, workerNoOwner.id).labels, { [LABEL.owner]: 'A' });
  assert.deepEqual(byId(rows, bareWorker.id).labels, { [LABEL.scope]: 'web', [LABEL.role]: 'worker', [LABEL.owner]: 'A' });
  assert.equal(byId(rows, bareWorker.id).kind, 'worker');
  assert.deepEqual(byId(rows, typoWorker.id).labels, { [LABEL.scope]: 'web', [LABEL.owner]: 'A' });
  for (const clean of [steerA, worker1, apiSteer]) {
    assert.equal(byId(rows, clean.id), undefined, `${clean.id} should produce no row`);
  }
});

test('foreign, archived, unattributed and ambiguous agents are never rewritten', async () => {
  const world = makeWorld();
  const { foreignSteer, archivedBad, randomAgent, ambiguous } = provisioned(world);
  const rows = planLabelFixes(await stateOf(world));
  const foreign = byId(rows, foreignSteer.id);
  assert.deepEqual(foreign.labels, {}, 'conflicting attribution is reported, not rewritten');
  assert.match(foreign.note, /lives in the web workspace/);
  assert.equal(byId(rows, archivedBad.id), undefined);
  assert.equal(byId(rows, randomAgent.id), undefined);
  const amb = byId(rows, ambiguous.id);
  assert.deepEqual(amb.labels, {});
  assert.match(amb.note, /adopt it explicitly/);
});

test('scope and agent filters narrow the rows; unknown addresses throw', async () => {
  const world = makeWorld();
  const { oldSteer, wrongRepo, steerA, randomAgent, archivedBad } = provisioned(world);
  const state = await stateOf(world);
  const apiRows = planLabelFixes(state, { address: 'api' });
  assert.ok(apiRows.length > 0);
  assert.ok(apiRows.every((r) => r.scope === 'api'));
  assert.equal(byId(apiRows, oldSteer.id), undefined);
  const one = planLabelFixes(state, { address: wrongRepo.id });
  assert.deepEqual(one.map((r) => r.agentId), [wrongRepo.id]);
  assert.deepEqual(planLabelFixes(state, { address: steerA.id }), [], 'clean agents produce no rows');
  assert.throws(() => planLabelFixes(state, { address: 'nope' }), /Unknown scope or agent/);
  assert.throws(() => planLabelFixes(state, { address: randomAgent.id }), /not attributable/);
  assert.throws(() => planLabelFixes(state, { address: archivedBad.id }), /archived/);
});

test('applying every fix leaves only note rows behind', async () => {
  const world = makeWorld();
  provisioned(world);
  const execute = createExecutors({ client: fakeClient(world), paseoCli: fakePaseoCli(world) });
  for (const row of planLabelFixes(await stateOf(world))) {
    if (!Object.keys(row.labels).length) continue;
    await execute({ key: `labels.${row.agentId}`, kind: 'labels.set', params: { agentId: row.agentId, labels: row.labels } }, {});
  }
  const again = planLabelFixes(await stateOf(world));
  assert.ok(again.length > 0, 'note rows persist until fixed manually');
  assert.ok(again.every((r) => !Object.keys(r.labels).length), JSON.stringify(again.map((r) => r.agentId)));
  assert.ok(again.every((r) => r.note), 'every remaining row explains itself');
});

// ---------------------------------------------------------------- executor

test('labels.set writes and verifies; refuses bad params, missing and archived agents', async () => {
  const world = makeWorld();
  const { oldSteer, archivedBad } = provisioned(world);
  const execute = createExecutors({ client: fakeClient(world), paseoCli: fakePaseoCli(world) });
  const run = (params) => execute({ key: 'labels.x', kind: 'labels.set', params }, {});
  const out = await run({ agentId: oldSteer.id, labels: { [LABEL.scope]: 'web', [LABEL.role]: 'steer' } });
  assert.deepEqual(out, { agentId: oldSteer.id, labels: { [LABEL.scope]: 'web', [LABEL.role]: 'steer' } });
  assert.equal(world.agents.find((a) => a.id === oldSteer.id).labels[LABEL.role], 'steer');
  await assert.rejects(run({ agentId: oldSteer.id, labels: {} }), /at least one label/);
  await assert.rejects(run({ agentId: oldSteer.id, labels: { 'paseo.foo': 'x' } }), /unknown label/);
  await assert.rejects(run({ agentId: oldSteer.id, labels: { [LABEL.slot]: '' } }), /non-empty string/);
  await assert.rejects(run({ agentId: 'agent-missing', labels: { [LABEL.role]: 'steer' } }), /missing or archived/);
  await assert.rejects(run({ agentId: archivedBad.id, labels: { [LABEL.role]: 'steer' } }), /missing or archived/);
  const silent = createExecutors({ client: fakeClient(world), paseoCli: () => ({}) });
  await assert.rejects(
    silent({ key: 'labels.x', kind: 'labels.set', params: { agentId: oldSteer.id, labels: { [LABEL.slot]: 'B' } } }, {}),
    /expected B/,
  );
});

// ---------------------------------------------------------------- format/cli

test('format prints one line per agent with its fix', async () => {
  const world = makeWorld();
  provisioned(world);
  const rows = planLabelFixes(await stateOf(world));
  const lines = formatLabelFixes(rows).split('\n');
  assert.equal(lines.length, rows.length);
  assert.match(lines.join('\n'), /wsf\.scope: missing → "web"/);
  assert.match(lines.join('\n'), /migrates ari\.wsf\.repo, ari\.wsf\.role, ari\.wsf\.slot/);
  assert.equal(formatLabelFixes([]), '(no label fixes needed)');
});

// The CLI `labels` command was replaced by `migrate` (K16a); the audit itself
// stays for the plugin RPC (`factory.labels`), covered above.
