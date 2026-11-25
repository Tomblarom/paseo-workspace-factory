// Hub scope (S5b): --hub entries plan a hub-kind scope, at most one live;
// an existing dir scope converts via scope.convert (metadata only). Fakes only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { normalizeEntry } from '../plugin/server/core/discovery.mjs';
import { createRunner } from '../plugin/server/core/factory.mjs';
import { applyPlans, createExecutors, createAuthorization } from '../plugin/server/core/apply.mjs';
import { LABEL, METADATA_KEY } from '../plugin/server/core/paseo.mjs';

const CONFIG = {
  version: 1,
  github: { owner: 'example', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    sol: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
  },
  steers: { slots: { A: 'sol' }, prepare: ['A'], initialActive: 'A' },
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
  path, linkedWorktree: Boolean(c.linkedWorktree), remotes: { ...(c.remotes ?? {}) }, repos: {},
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
function addMain(world, { path = '/p/admin', scope } = {}) {
  const project = addProject(world, path);
  const ws = {
    id: `wks_${String(++world.seq).padStart(16, '0')}`, projectId: project.projectId,
    workspaceDirectory: path, workspaceKind: 'local_checkout', title: 'Main', name: 'Main',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 3, ...(scope ? { scope } : {}) } },
    createdAt: new Date().toISOString(),
  };
  world.workspaces.push(ws);
  return ws;
}
function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  const agentHandle = (id) => ({ id, refresh: async () => ({ agent: structuredClone(findAgent(id)) }) });
  const workspaceHandle = (id) => ({
    id,
    refresh: async () => structuredClone(findWs(id)),
    setMetadata: async (patch) => {
      world.calls.push(['workspace.setMetadata', id, patch]);
      Object.assign(findWs(id).metadata, structuredClone(patch));
    },
    agents: {
      create: async (opts) => {
        const [provider, ...rest] = opts.config.provider.split('/');
        const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, title: opts.title, provider, model: rest.join('/'), workspaceId: id, labels: { ...opts.labels } };
        world.agents.push(agent);
        if (opts.idempotencyKey) world.receipts.set(opts.idempotencyKey, agent.id);
        return agentHandle(agent.id);
      },
    },
  });
  return {
    projects: { list: async () => ({ projects: structuredClone(world.projects) }) },
    workspaces: {
      ref: workspaceHandle,
      create: async ({ source, title, metadata, idempotencyKey }) => {
        const project = addProject(world, source.path);
        const ws = {
          id: `wks_${String(++world.seq).padStart(16, '0')}`, projectId: project.projectId,
          workspaceDirectory: source.path, workspaceKind: 'local_checkout', title, name: title,
          metadata: structuredClone(metadata), createdAt: new Date().toISOString(),
        };
        world.workspaces.push(ws);
        world.receipts.set(idempotencyKey, ws.id);
        return workspaceHandle(ws.id);
      },
    },
    agents: { ref: agentHandle },
  };
}
function fakePaseoCli(world) {
  return (args) => {
    world.calls.push(['paseo', ...args]);
    if (args[0] === 'project') return { projectId: addProject(world, args[2]).projectId, path: args[2] };
    throw new Error(`unexpected paseo ${args.join(' ')}`);
  };
}
function fakeLookup(world) {
  return async (kind, key) => {
    if (!world.receipts.has(key)) return null;
    const id = world.receipts.get(key);
    if (kind === 'agent') return { kind, idempotencyKey: key, phase: 'completed', error: null, agentId: id };
    return { kind, idempotencyKey: key, phase: 'completed', error: null, workspaceId: id, workspace: { id } };
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
const ghCalls = (world) => world.calls.filter((c) => c[0] === 'gh');

test('normalizeEntry keeps a boolean hub flag and rejects junk', () => {
  assert.equal(normalizeEntry({ local: '/p/admin', hub: true }, CONFIG).hub, true);
  assert.equal('hub' in normalizeEntry({ local: '/p/admin' }, CONFIG), false);
  assert.equal('hub' in normalizeEntry({ local: '/p/admin', hub: false }, CONFIG), false);
  assert.throws(() => normalizeEntry({ local: '/p/admin', hub: 'yes' }, CONFIG), /must be a boolean/);
});

test('hub enrollment adopts the existing workspace with id --name else hub', async () => {
  const world = makeWorld();
  world.checkouts['/p/admin'] = { remotes: {} };
  const project = addProject(world, '/p/admin');
  world.workspaces.push({
    id: 'wks_hubfresh00000001', projectId: project.projectId, workspaceDirectory: '/p/admin',
    workspaceKind: 'local_checkout', title: 'Main', name: 'Main', metadata: {}, createdAt: new Date().toISOString(),
  });
  const [plain] = await runnerFor(world).runPlans([{ local: '/p/admin', hub: true }]);
  assert.equal(plain.repo, 'hub');
  assert.deepEqual(plain.ops.find((o) => o.key === 'workspace.main.adopt').params.metadata[METADATA_KEY].scope, { id: 'hub', kind: 'hub', locator: '/p/admin' });
  const [named] = await runnerFor(world).runPlans([{ local: '/p/admin', hub: true, name: 'ops' }]);
  assert.equal(named.repo, 'ops');
  assert.equal(named.ops.find((o) => o.key === 'workspace.main.adopt').params.metadata[METADATA_KEY].scope.kind, 'hub');
  assert.equal(ghCalls(world).length, 0);
});

test('hub dir without a workspace is a conflict (K13: enroll existing workspaces)', async () => {
  const world = makeWorld();
  world.checkouts['/p/admin'] = { remotes: {} };
  const [p] = await runnerFor(world).runPlans([{ local: '/p/admin', hub: true }]);
  assert.equal(p.status, 'conflict');
  assert.match(p.conflicts.find((c) => c.key === 'workspace.main').reason, /No factory main workspace/);
});

test('hub on a worktree workspace adopts with hub kind', async () => {
  const world = makeWorld();
  world.checkouts['/wt/ops'] = { remotes: {}, linkedWorktree: true };
  const project = addProject(world, '/p/mainproj');
  const wt = {
    id: 'wks_hubwt00000000001', projectId: project.projectId, workspaceDirectory: '/wt/ops', workspaceKind: 'worktree',
    title: 'ops', name: 'ops', metadata: {}, createdAt: new Date().toISOString(),
  };
  world.workspaces.push(wt);
  const [d] = await runnerFor(world).discoverAll([{ workspace: wt.id, hub: true }]);
  assert.equal(d.forkName, 'hub');
  assert.deepEqual(d.scope, { id: 'hub', kind: 'hub', locator: wt.id });
  const [p] = await runnerFor(world).runPlans([{ workspace: wt.id, hub: true }]);
  assert.ok(keys(p).includes('workspace.main.adopt'));
  assert.ok(!keys(p).includes('paseo.project'), 'no new project for hub adoption');
});

test('a second live hub is a conflict; two hub entries are rejected (K13: one entry)', async () => {
  const world = makeWorld();
  world.checkouts['/p/admin'] = { remotes: {} };
  world.checkouts['/p/other'] = { remotes: {} };
  addMain(world, { path: '/p/admin', scope: { id: 'hub', kind: 'hub', locator: '/p/admin' } });
  const [second] = await runnerFor(world).runPlans([{ local: '/p/other', hub: true }]);
  assert.equal(second.status, 'conflict');
  assert.match(second.conflicts.find((c) => c.key === 'scope.hub').reason, /at most one hub/);
  const fresh = makeWorld();
  fresh.checkouts['/p/a'] = { remotes: {} };
  fresh.checkouts['/p/b'] = { remotes: {} };
  await assert.rejects(runnerFor(fresh).runPlans([{ local: '/p/a', hub: true }, { local: '/p/b', hub: true, name: 'hub2' }]), /exactly one workspace entry/);
});

test('dir scope converts to hub in metadata only; steers, epoch and checkpoint stay', async () => {
  const world = makeWorld();
  world.checkouts['/p/admin'] = { remotes: {} };
  const ws = addMain(world, { path: '/p/admin', scope: { id: 'admin', kind: 'dir', locator: '/p/admin' } });
  ws.metadata[`${METADATA_KEY}.checkpoint`] = { task: 'Keep lights on', tests: [], blockers: [], epoch: 3, updatedAt: '2026-11-23T00:00:00.000Z' };
  world.agents.push({ id: 'agent-1', status: 'idle', archivedAt: null, title: 'Steer A', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id, labels: { [LABEL.repo]: 'admin', [LABEL.role]: 'steer', [LABEL.slot]: 'A', [LABEL.scope]: 'admin' } });
  const entries = [{ local: '/p/admin', hub: true }];
  const runner = runnerFor(world);
  const [p] = await runner.runPlans(entries);
  assert.deepEqual(keys(p), ['scope.convert']);
  assert.equal(p.ops[0].kind, 'scope.convert');
  assert.deepEqual(p.ops[0].params.scope, { id: 'admin', kind: 'hub', locator: '/p/admin' });
  const authorization = createAuthorization([p], CONFIG, { entries, allowFork: false, adopt: {} });
  const result = await applyPlans({
    authorization, config: CONFIG, confirm: authorization.hash, lookupReceipt: fakeLookup(world),
    runPlans: (list, options) => runner.runPlans(list, options),
    execute: createExecutors({ client: fakeClient(world), gh: strictGh(world), git: fakeGit(world), paseoCli: fakePaseoCli(world), sleep: async () => {} }),
  });
  assert.equal(result.report[0].status, 'complete', result.report[0].error);
  const meta = world.workspaces[0].metadata[METADATA_KEY];
  assert.deepEqual(meta.scope, { id: 'admin', kind: 'hub', locator: '/p/admin' });
  assert.equal(meta.epoch, 3);
  assert.equal(meta.activeSteer, 'A');
  assert.equal(world.workspaces[0].metadata[`${METADATA_KEY}.checkpoint`].task, 'Keep lights on');
  assert.equal(world.agents.length, 1, 'no steer recreated');
  assert.ok(world.calls.every((c) => c[1] !== 'rename' && c[0] !== 'paseo'), 'hub op writes nothing outside the hub workspace metadata');
  const [after] = await runner.runPlans(entries);
  assert.equal(after.status, 'complete');
});

test('convert keeps the stored id unless --name renames; other kinds refuse', async () => {
  const world = makeWorld();
  world.checkouts['/p/admin'] = { remotes: {} };
  addMain(world, { path: '/p/admin', scope: { id: 'admin', kind: 'dir', locator: '/p/admin' } });
  const [renamed] = await runnerFor(world).runPlans([{ local: '/p/admin', hub: true, name: 'ops' }]);
  assert.equal(renamed.ops.find((o) => o.key === 'scope.convert').params.scope.id, 'ops');
  const wt = makeWorld();
  wt.checkouts['/wt/x'] = { remotes: {}, linkedWorktree: true };
  const project = addProject(wt, '/p/mainproj');
  wt.workspaces.push({
    id: 'wks_wt00000000000001', projectId: project.projectId, workspaceDirectory: '/wt/x', workspaceKind: 'worktree',
    title: 'x', name: 'x', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: 'mainproj@x', kind: 'workspace', locator: 'wks_wt000000000001' } } },
  });
  const [refused] = await runnerFor(wt).runPlans([{ local: '/wt/x', hub: true }]);
  assert.match(refused.conflicts.find((c) => c.key === 'scope.convert').reason, /only dir scopes convert/);
});

test('CLI rejects removed plan command with /factory pointer', () => {
  assert.throws(() => execFileSync('node', ['src/cli.mjs', 'plan', '--hub', '/tmp/hub'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /\/factory plan/);
});
