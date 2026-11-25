// Worker adoption and steer detach (S7): --adopt-worker labels, --detach op,
// labelled workers in status. Fakes only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRunner } from '../plugin/server/core/factory.mjs';
import { applyPlans, createExecutors, createAuthorization } from '../plugin/server/core/apply.mjs';
import { steerStatus, buildHandoff } from '../plugin/server/core/steer.mjs';
import { LABEL, METADATA_KEY, PARENT_LABEL } from '../plugin/server/core/paseo.mjs';

const CONFIG = {
  version: 1,
  github: { owner: 'example', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    sol: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
  },
  steers: { slots: { A: 'sol', B: 'sol' }, prepare: ['A'], initialActive: 'A' },
  workers: { defaultProfile: 'sol' },
};
const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'full-access' }] },
];

function makeWorld() {
  return {
    checkouts: {}, localDirs: new Set(), projects: [], workspaces: [], agents: [],
    providers: structuredClone(PROVIDERS), calls: [], receipts: new Map(), seq: 0,
  };
}
function strictGh(world) {
  return (args) => { world.calls.push(['gh', ...args]); throw new Error('no gh here'); };
}
function fakeGit(world) {
  return (cwd, args) => {
    world.calls.push(['git', cwd, ...args]);
    if (!world.checkouts[cwd]) throw new Error(`not a repo: ${cwd}`);
    if (args[0] === 'config') throw new Error('exit 1');
    if (args[0] === 'rev-parse') return 'main';
    if (args[0] === 'status') return '';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}
const worldScan = (world) => () => Object.entries(world.checkouts).map(([path, c]) => ({
  path, linkedWorktree: false, remotes: { ...(c.remotes ?? {}) }, repos: {},
}));
const fakeExistsDir = (world) => (p) => world.checkouts[p] !== undefined || world.localDirs.has(p);

function addProject(world, path) {
  let project = world.projects.find((p) => p.projectRootPath === path);
  if (!project) {
    project = { projectId: `prj_${++world.seq}`, projectRootPath: path, projectDisplayName: path.split('/').at(-1) };
    world.projects.push(project);
  }
  return project;
}
function addMain(world, { path = '/p/demo', scope = { id: 'demo', kind: 'dir', locator: '/p/demo' } } = {}) {
  const project = addProject(world, path);
  const ws = {
    id: `wks_${String(++world.seq).padStart(16, '0')}`, projectId: project.projectId,
    workspaceDirectory: path, workspaceKind: 'local_checkout', title: 'Main', name: 'Main',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope } },
    createdAt: new Date().toISOString(),
  };
  world.workspaces.push(ws);
  return ws;
}
function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}
function addSteer(world, ws, slot = 'A') {
  return addAgent(world, { provider: 'codex', model: 'gpt-6.2-sol', title: `Steer ${slot}`, workspaceId: ws.id, labels: { [LABEL.repo]: 'demo', [LABEL.role]: 'steer', [LABEL.slot]: slot, [LABEL.scope]: 'demo' } });
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  const agentHandle = (id) => ({
    id,
    refresh: async () => ({ agent: structuredClone(findAgent(id)) }),
    detach: async () => {
      world.calls.push(['sdk', 'agent.detach', id]);
      const agent = findAgent(id);
      if (!agent) throw new Error('agent missing');
      delete agent.labels[PARENT_LABEL];
    },
  });
  const workspaceHandle = (id) => ({
    id,
    refresh: async () => structuredClone(findWs(id)),
    setMetadata: async (patch) => { Object.assign(findWs(id).metadata, structuredClone(patch)); },
    agents: {
      create: async (opts) => {
        const [provider, ...rest] = opts.config.provider.split('/');
        const agent = addAgent(world, { provider, model: rest.join('/'), title: opts.title, workspaceId: id, labels: { ...opts.labels } });
        if (opts.idempotencyKey) world.receipts.set(opts.idempotencyKey, agent.id);
        return agentHandle(agent.id);
      },
    },
  });
  return {
    projects: { list: async () => ({ projects: structuredClone(world.projects) }) },
    workspaces: { ref: workspaceHandle },
    agents: { ref: agentHandle },
  };
}
function fakePaseoCli(world) {
  return (args) => {
    world.calls.push(['paseo', ...args]);
    if (args[0] === 'agent' && args[1] === 'update') {
      const agent = world.agents.find((a) => a.id === args[2]);
      for (const pair of args[4].split(',')) {
        const [k, v] = pair.split('=');
        agent.labels[k] = v;
      }
      return { id: agent.id };
    }
    throw new Error(`unexpected paseo ${args.join(' ')}`);
  };
}
function fakeLookup(world) {
  return async (kind, key) => {
    if (!world.receipts.has(key)) return null;
    const id = world.receipts.get(key);
    return { kind, idempotencyKey: key, phase: 'completed', error: null, agentId: id };
  };
}
function runnerFor(world, config = CONFIG) {
  return createRunner({
    config, client: null, gh: strictGh(world), git: fakeGit(world),
    readState: async () => structuredClone({ projects: world.projects, workspaces: world.workspaces, agents: world.agents, providers: world.providers }),
    scan: worldScan(world), inspectTarget: () => { throw new Error('no clones'); },
    realpath: (p) => p, existsDir: fakeExistsDir(world),
  });
}
const keys = (p) => p.ops.map((op) => op.key);

// ------------------------------------------------------- worker adoption

test('adopt-worker plans labels; apply lands them; rerun reports kept', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const ws = addMain(world, {});
  addSteer(world, ws);
  const candidate = addAgent(world, { title: 'Feature work', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id });
  const entries = [{ local: '/p/demo' }];
  const runner = runnerFor(world);
  const [p] = await runner.runPlans(entries, { adoptWorker: { [candidate.id]: 'A' } });
  const op = p.ops.find((o) => o.key === `worker.${candidate.id}`);
  assert.equal(op.kind, 'paseo.agent.worker');
  assert.deepEqual(op.params.labels, { [LABEL.scope]: 'demo', [LABEL.role]: 'worker', [LABEL.owner]: 'A' });
  const authorization = createAuthorization([p], CONFIG, { entries, allowFork: false, adopt: {}, adoptWorker: { [candidate.id]: 'A' } });
  const result = await applyPlans({
    authorization, config: CONFIG, confirm: authorization.hash, lookupReceipt: fakeLookup(world),
    runPlans: (list, options) => runner.runPlans(list, options),
    execute: createExecutors({ client: fakeClient(world), gh: strictGh(world), git: fakeGit(world), paseoCli: fakePaseoCli(world), sleep: async () => {} }),
  });
  assert.equal(result.report[0].status, 'complete', result.report[0].error);
  assert.deepEqual(world.agents.find((a) => a.id === candidate.id).labels, { [LABEL.scope]: 'demo', [LABEL.role]: 'worker', [LABEL.owner]: 'A' });
  const [after] = await runner.runPlans(entries, { adoptWorker: { [candidate.id]: 'A' } });
  assert.ok(!keys(after).some((k) => k.startsWith('worker.')));
  assert.match(after.notes.join('\n'), /already adopted/);
});

test('adopted workers may live in a foreign workspace and stay there', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const ws = addMain(world, {});
  addSteer(world, ws);
  const foreign = {
    id: 'wks_foreign000000001', projectId: ws.projectId, workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout',
    title: 'side quest', name: 'side quest', metadata: {}, createdAt: new Date().toISOString(),
  };
  world.workspaces.push(foreign);
  const candidate = addAgent(world, { title: 'Side work', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: foreign.id, labels: { [PARENT_LABEL]: 'some-parent' } });
  const entries = [{ local: '/p/demo' }];
  const runner = runnerFor(world);
  const [p] = await runner.runPlans(entries, { adoptWorker: { [candidate.id]: 'A' } });
  assert.equal(p.ops.find((o) => o.key === `worker.${candidate.id}`).params.workspaceId, foreign.id);
  const authorization = createAuthorization([p], CONFIG, { entries, allowFork: false, adopt: {}, adoptWorker: { [candidate.id]: 'A' } });
  const result = await applyPlans({
    authorization, config: CONFIG, confirm: authorization.hash, lookupReceipt: fakeLookup(world),
    runPlans: (list, options) => runner.runPlans(list, options),
    execute: createExecutors({ client: fakeClient(world), gh: strictGh(world), git: fakeGit(world), paseoCli: fakePaseoCli(world), sleep: async () => {} }),
  });
  assert.equal(result.report[0].status, 'complete', result.report[0].error);
  const adopted = world.agents.find((a) => a.id === candidate.id);
  assert.equal(adopted.workspaceId, foreign.id, 'not moved');
  assert.equal(adopted.labels[PARENT_LABEL], 'some-parent', 'parent kept');
  const [d] = await runner.discoverAll(entries);
  const status = steerStatus(d);
  const row = status.workers.find((w) => w.id === candidate.id);
  assert.equal(row.workspaceId, foreign.id);
  assert.equal(row.owner, 'A');
});

test('adopt-worker conflicts: unknown, archived, labelled, undefined slot', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const ws = addMain(world, {});
  const steer = addSteer(world, ws);
  const gone = addAgent(world, { title: 'gone', provider: 'codex', model: 'm', workspaceId: ws.id, archivedAt: 'then' });
  const cand = addAgent(world, { title: 'x', provider: 'codex', model: 'm', workspaceId: ws.id });
  const runner = runnerFor(world);
  const planFor = (adoptWorker) => runner.runPlans([{ local: '/p/demo' }], { adoptWorker }).then(([p]) => p);
  assert.match((await planFor({ 'agent-missing': 'A' })).conflicts[0].reason, /not found/);
  assert.match((await planFor({ [gone.id]: 'A' })).conflicts.find((c) => c.key === `worker.${gone.id}`).reason, /archived/);
  assert.match((await planFor({ [steer.id]: 'A' })).conflicts.find((c) => c.key === `worker.${steer.id}`).reason, /already labelled steer/);
  assert.match((await planFor({ [cand.id]: 'Z' })).conflicts.find((c) => c.key === `worker.${cand.id}`).reason, /not defined in steers.slots/);
});

test('missing @slot defaults to the active steer', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const ws = addMain(world, {});
  addSteer(world, ws);
  const cand = addAgent(world, { title: 'x', provider: 'codex', model: 'm', workspaceId: ws.id });
  const [p] = await runnerFor(world).runPlans([{ local: '/p/demo' }], { adoptWorker: { [cand.id]: null } });
  assert.equal(p.ops.find((o) => o.key === `worker.${cand.id}`).params.labels[LABEL.owner], 'A');
});

// ------------------------------------------------------------------ detach

test('--detach plans a native detach before the adoption; apply verifies freedom', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const ws = addMain(world, {});
  const candidate = addAgent(world, { title: 'Steer A', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id, labels: { [PARENT_LABEL]: 'coordinator' } });
  const entries = [{ local: '/p/demo' }];
  const runner = runnerFor(world);
  const [refused] = await runner.runPlans(entries, { adopt: { '*': { A: candidate.id } } });
  assert.match(refused.conflicts.find((c) => c.key === 'steer.A').reason, /--detach/);
  const [p] = await runner.runPlans(entries, { adopt: { '*': { A: candidate.id } }, detach: true });
  assert.deepEqual(keys(p), ['steer.A.detach', 'steer.A']);
  assert.equal(p.ops[0].kind, 'agent.detach');
  const authorization = createAuthorization([p], CONFIG, { entries, allowFork: false, adopt: { '*': { A: candidate.id } }, detach: true });
  const result = await applyPlans({
    authorization, config: CONFIG, confirm: authorization.hash, lookupReceipt: fakeLookup(world),
    runPlans: (list, options) => runner.runPlans(list, options),
    execute: createExecutors({ client: fakeClient(world), gh: strictGh(world), git: fakeGit(world), paseoCli: fakePaseoCli(world), sleep: async () => {} }),
  });
  assert.equal(result.report[0].status, 'complete', result.report[0].error);
  const adopted = world.agents.find((a) => a.id === candidate.id);
  assert.equal(adopted.labels[PARENT_LABEL], undefined);
  assert.equal(adopted.labels[LABEL.role], 'steer');
  const detachCall = world.calls.findIndex((c) => c[0] === 'sdk' && c[1] === 'agent.detach');
  const adoptCall = world.calls.findIndex((c) => c[0] === 'paseo' && c[1] === 'agent' && c[2] === 'update');
  assert.ok(detachCall !== -1 && adoptCall !== -1 && detachCall < adoptCall, 'detach runs before labelling');
  assert.ok(!world.calls.some((c) => c[0] === 'paseo' && c[1] === 'agent' && c[2] === 'detach'), 'no CLI subprocess for detach');
});

test('detach executor refuses parentless and missing agents', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const ws = addMain(world, {});
  const solo = addAgent(world, { title: 'solo', provider: 'codex', model: 'm', workspaceId: ws.id });
  const execute = createExecutors({ client: fakeClient(world), gh: strictGh(world), git: fakeGit(world), paseoCli: fakePaseoCli(world), sleep: async () => {} });
  const run = (params) => execute({ key: 'steer.A.detach', kind: 'agent.detach', params }, CONFIG);
  await assert.rejects(run({ agentId: 'agent-missing', parent: 'x' }), /missing or archived/);
  await assert.rejects(run({ agentId: solo.id }), /has no parent/);
});

test('status and handoff show the foreign worker workspace', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const ws = addMain(world, {});
  const steer = addSteer(world, ws);
  const foreign = {
    id: 'wks_foreign000000002', projectId: ws.projectId, workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout',
    title: 'side', name: 'side', metadata: {}, createdAt: new Date().toISOString(),
  };
  world.workspaces.push(foreign);
  addAgent(world, { title: 'Side work', provider: 'codex', model: 'm', workspaceId: foreign.id, labels: { [LABEL.scope]: 'demo', [LABEL.role]: 'worker', [LABEL.owner]: 'A' } });
  const [d] = await runnerFor(world).discoverAll([{ local: '/p/demo' }]);
  const status = steerStatus(d);
  assert.equal(status.workers.length, 1);
  const packet = buildHandoff(status, { from: { slot: 'A', id: steer.id }, to: { slot: 'A', id: steer.id }, epoch: 1, git: null, lastMessage: null, language: 'en' });
  assert.match(packet, new RegExp(`workspace ${foreign.id}`));
});

test('CLI usage documents --adopt-worker and --detach', () => {
  const out = execFileSync('node', ['src/cli.mjs', '--help'], { encoding: 'utf8' });
  assert.match(out, /--adopt-worker <agent-id>\[@A\]/);
  assert.match(out, /--detach/);
});
