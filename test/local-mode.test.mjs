// Local mode without GitHub: {"local": <path>} entries and "local/<folder>" names.
// Same fake world shapes as workspace-factory.test.mjs; gh must never be called.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { normalizeEntry } from '../plugin/server/core/discovery.mjs';
import { createRunner } from '../plugin/server/core/factory.mjs';
import { applyPlans, createExecutors, createAuthorization } from '../plugin/server/core/apply.mjs';
import { switchSteer, steerStatus, writeCheckpoint } from '../plugin/server/core/steer.mjs';
import { LABEL, METADATA_KEY } from '../plugin/server/core/paseo.mjs';

const CONFIG = {
  version: 1,
  github: { owner: 'example', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    sol: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
    muse: { provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null, mode: 'allowAll' },
  },
  steers: { slots: { A: 'sol', B: 'muse' }, prepare: ['A', 'B'], initialActive: 'A' },
  workers: { defaultProfile: 'muse' },
};

const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'full-access' }] },
  { provider: 'muse', enabled: true, status: 'ready', models: [{ id: 'muse-spark-1.3-contributor', thinkingOptions: [] }], modes: [{ id: 'allowAll' }] },
];

function makeWorld() {
  return {
    checkouts: {},
    localDirs: new Set(),
    projects: [],
    workspaces: [],
    agents: [],
    providers: structuredClone(PROVIDERS),
    calls: [],
    receipts: new Map(),
    fingerprints: new Map(),
    seq: 0,
    hooks: {},
  };
}

function strictGh(world) {
  return (args) => {
    world.calls.push(['gh', ...args]);
    throw new Error('gh must not be called in local mode');
  };
}

function fakeGit(world) {
  return (cwd, args) => {
    world.calls.push(['git', cwd, ...args]);
    const checkout = world.checkouts[cwd];
    if (!checkout) throw new Error(`not a repo: ${cwd}`);
    if (args[0] === 'config') {
      const lines = Object.entries(checkout.remotes ?? {}).map(([n, u]) => `remote.${n}.url ${u}`);
      if (!lines.length) throw new Error('exit 1');
      return lines.join('\n');
    }
    if (args[0] === 'rev-parse') return args.includes('--abbrev-ref') ? 'main' : 'a1b2c3d4e5f6a7b8c9d0';
    if (args[0] === 'status') return '';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function worldScan(world) {
  return () => Object.entries(world.checkouts).map(([path, c]) => ({
    path,
    linkedWorktree: Boolean(c.linkedWorktree),
    remotes: { ...(c.remotes ?? {}) },
    repos: {},
  }));
}

function fakeExistsDir(world) {
  return (p) => world.checkouts[p] !== undefined || world.localDirs.has(p);
}

function addProject(world, path) {
  let project = world.projects.find((p) => p.projectRootPath === path);
  if (!project) {
    project = { projectId: `prj_${++world.seq}`, projectRootPath: path, projectDisplayName: path.split('/').at(-1) };
    world.projects.push(project);
  }
  return project;
}

function addWorkspace(world, { path, title, metadata = {}, kind = 'local_checkout', id }) {
  const project = addProject(world, path);
  const workspace = { id: id ?? `wks_${String(++world.seq).padStart(16, '0')}`, projectId: project.projectId, workspaceDirectory: path, workspaceKind: kind, title, name: title, metadata: structuredClone(metadata), createdAt: new Date(Date.now() + 1000).toISOString() };
  world.workspaces.push(workspace);
  return workspace;
}

function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  const agentHandle = (id) => ({
    id,
    refresh: async () => ({ agent: structuredClone(findAgent(id)) }),
    send: async (text) => { world.calls.push(['agent.send', id, text]); },
    timeline: { refetch: async () => ({ entries: [{ item: { type: 'assistant_message', text: 'ok' } }] }) },
  });
  const workspaceHandle = (id) => ({
    id,
    refresh: async () => structuredClone(findWs(id)),
    setMetadata: async (patch) => {
      world.calls.push(['workspace.setMetadata', id, patch]);
      Object.assign(findWs(id).metadata, structuredClone(patch));
    },
    agents: {
      create: async (opts) => {
        world.calls.push(['agent.create', opts]);
        const [provider, ...rest] = opts.config.provider.split('/');
        const agent = addAgent(world, { provider, model: rest.join('/'), title: opts.title, workspaceId: id, labels: { ...opts.labels } });
        if (opts.idempotencyKey) world.receipts.set(opts.idempotencyKey, agent.id);
        return agentHandle(agent.id);
      },
    },
  });
  return {
    workspaces: {
      ref: workspaceHandle,
      create: async ({ source, title, metadata, idempotencyKey }) => {
        world.calls.push(['workspace.create', { source, title, metadata, idempotencyKey }]);
        const workspace = addWorkspace(world, { path: source.path, title, metadata });
        world.receipts.set(idempotencyKey, workspace.id);
        return workspaceHandle(workspace.id);
      },
    },
    agents: { ref: agentHandle, list: async () => ({ entries: structuredClone(world.agents), pageInfo: { hasMore: false } }) },
  };
}

function fakePaseoCli(world) {
  return (args) => {
    world.calls.push(['paseo', ...args]);
    if (args[0] === 'clone') throw new Error('clone must not run in local mode');
    if (args[0] === 'project') return { projectId: addProject(world, args[2]).projectId, path: args[2] };
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
    if (kind === 'agent') return { kind, idempotencyKey: key, phase: 'completed', error: null, agentId: id };
    return { kind, idempotencyKey: key, phase: 'completed', error: null, workspaceId: id, workspace: { id } };
  };
}

function runnerFor(world, config = CONFIG) {
  return createRunner({
    config,
    client: null,
    gh: strictGh(world),
    git: fakeGit(world),
    readState: async () => structuredClone({ projects: world.projects, workspaces: world.workspaces, agents: world.agents, providers: world.providers }),
    scan: worldScan(world),
    inspectTarget: () => { throw new Error('clone target must not be inspected in local mode'); },
    realpath: (p) => p,
    existsDir: fakeExistsDir(world),
  });
}

const noLock = (_name, fn) => fn({ verify() {} });
const keys = (p) => p.ops.map((op) => op.key);
const ghCalls = (world) => world.calls.filter((c) => c[0] === 'gh');

function provisionedLocal(world, path = '/p/demo') {
  world.checkouts[path] = { remotes: {} };
  const ws = addWorkspace(world, { path, title: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: path.split('/').at(-1), kind: 'dir', locator: path } } } });
  const steers = {};
  for (const [slot, [provider, model]] of Object.entries({ A: ['codex', 'gpt-6.2-sol'], B: ['muse', 'muse-spark-1.3-contributor'] })) {
    steers[slot] = addAgent(world, { provider, model, title: `Steer ${slot}`, workspaceId: ws.id, labels: { [LABEL.repo]: 'local/demo', [LABEL.role]: 'steer', [LABEL.slot]: slot } });
  }
  return { ws, steers };
}

test('normalizeEntry accepts {local: path} and local/<folder>', () => {
  assert.deepEqual(normalizeEntry({ local: '/p/demo' }, CONFIG), { repo: 'local/demo', local: '/p/demo', parentDir: '/p' });
  assert.deepEqual(normalizeEntry('local/demo', CONFIG), { repo: 'local/demo', localName: 'demo', parentDir: '/p' });
  assert.deepEqual(normalizeEntry({ repo: 'local/demo' }, CONFIG).localName, 'demo');
  assert.throws(() => normalizeEntry({ local: '  ' }, CONFIG), /non-empty "local"/);
  assert.throws(() => normalizeEntry('local/', CONFIG), /Not a local repository name/);
  assert.throws(() => normalizeEntry('local/a/b', CONFIG), /Not a local repository name/);
  assert.throws(() => normalizeEntry({}, CONFIG), /needs "repo", "local" or "workspace"/);
});

test('discovery with a local path makes no gh calls and names the repo after the folder', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const [d] = await runnerFor(world).discoverAll([{ local: '/p/demo' }]);
  assert.equal(ghCalls(world).length, 0);
  assert.equal(d.forkName, 'demo');
  assert.deepEqual(d.scope, { id: 'demo', kind: 'dir', locator: '/p/demo' });
  assert.equal(d.local, true);
  assert.equal(d.checkout?.path, '/p/demo');
  assert.deepEqual(d.checkoutIssues, []);
  assert.equal(d.github?.local, true);
});

test('local enrollment adopts the existing workspace and plans steers (K13: no provisioning)', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  addWorkspace(world, { path: '/p/demo', title: 'Main', metadata: {} });
  const [p] = await runnerFor(world).runPlans([{ local: '/p/demo' }]);
  assert.equal(ghCalls(world).length, 0);
  assert.equal(p.repo, 'demo');
  assert.equal(p.status, 'pending');
  assert.deepEqual(keys(p), ['workspace.main.adopt', 'steer.A', 'steer.B']);
  assert.ok(!keys(p).some((k) => k.startsWith('github.') || k.startsWith('checkout.')));
  const steer = p.ops.find((op) => op.key === 'steer.A').params;
  assert.equal(steer.labels[LABEL.repo], 'demo');
  assert.equal(steer.labels[LABEL.scope], 'demo');
  assert.deepEqual(p.ops.find((op) => op.key === 'workspace.main.adopt').params.metadata[METADATA_KEY].scope, { id: 'demo', kind: 'dir', locator: '/p/demo' });
});

test('local directory without a workspace is a conflict (K13: enroll existing workspaces)', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const [p] = await runnerFor(world).runPlans([{ local: '/p/demo' }]);
  assert.equal(p.status, 'conflict');
  assert.match(p.conflicts.find((c) => c.key === 'workspace.main').reason, /No factory main workspace/);
  assert.equal(ghCalls(world).length, 0);
});

test('plain folder without git remotes is usable in local mode', async () => {
  const world = makeWorld();
  world.localDirs.add('/p/plain');
  addWorkspace(world, { path: '/p/plain', title: 'Main', metadata: {} });
  const [p] = await runnerFor(world).runPlans([{ local: '/p/plain' }]);
  assert.equal(p.repo, 'plain');
  assert.ok(keys(p).includes('workspace.main.adopt'));
  assert.equal(ghCalls(world).length, 0);
});

test('adopt and slots work in local mode', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const ws = addWorkspace(world, { path: '/p/demo', title: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } } });
  const legacy = addAgent(world, { title: 'Steer A', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id });
  const [needConfirm] = await runnerFor(world).runPlans([{ local: '/p/demo' }]);
  assert.match(needConfirm.conflicts.find((c) => c.key === 'steer.A').reason, new RegExp(`--adopt A=${legacy.id}`));
  const [adopted] = await runnerFor(world).runPlans([{ local: '/p/demo' }], { adopt: { '*': { A: legacy.id } } });
  assert.equal(adopted.ops.find((o) => o.key === 'steer.A').kind, 'paseo.agent.adopt');
  const [slots] = await runnerFor(world).runPlans([{ local: '/p/demo' }], { slots: ['B'] });
  assert.deepEqual(keys(slots).filter((k) => k.startsWith('steer.')), ['steer.B']);
  assert.equal(ghCalls(world).length, 0);
});

test('status, checkpoint and switch work with the local/<folder> name', async () => {
  const world = makeWorld();
  provisionedLocal(world);
  const [direct] = await runnerFor(world).discoverAll([{ local: '/p/demo' }]);
  const [named] = await runnerFor(world).discoverAll(['local/demo']);
  assert.equal(named.forkName, 'demo');
  assert.equal(named.checkout?.path, direct.checkout?.path);
  assert.equal(named.mainWorkspace?.id, direct.mainWorkspace?.id);
  const status = steerStatus(named);
  assert.equal(status.repo, 'demo');
  assert.deepEqual(status.steers.map((s) => s.slot), ['A', 'B']);
  const cp = await writeCheckpoint({ client: fakeClient(world), discovery: named, task: 'Local task', lock: noLock });
  assert.equal(cp.task, 'Local task');
  const switched = await switchSteer({ client: fakeClient(world), discovery: named, toSlot: 'B', git: fakeGit(world), lock: noLock });
  assert.equal(switched.to, 'B');
  assert.match(switched.packet, /Steer handoff for demo:/);
  assert.equal(ghCalls(world).length, 0);
});

test('apply runs without gh and stores the local authorization', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  addWorkspace(world, { path: '/p/demo', title: 'Main', metadata: {} });
  const entries = [{ local: '/p/demo' }];
  const runner = runnerFor(world);
  const plans = await runner.runPlans(entries);
  const authorization = createAuthorization(plans, CONFIG, { entries, adopt: {} });
  assert.deepEqual(authorization.entries, entries);
  const result = await applyPlans({
    authorization, config: CONFIG, confirm: authorization.hash,
    lookupReceipt: fakeLookup(world),
    runPlans: (list, options) => runner.runPlans(list, options),
    execute: createExecutors({ client: fakeClient(world), paseoCli: fakePaseoCli(world) }),
  });
  assert.equal(result.report[0].status, 'complete', result.report[0].error);
  assert.equal(ghCalls(world).length, 0);
  assert.equal(world.calls.some((c) => c[0] === 'paseo' && c[1] === 'clone'), false);
  const [after] = await runner.runPlans(entries);
  assert.equal(after.status, 'complete');
});

test('missing local path is a checkout conflict without clone', async () => {
  const world = makeWorld();
  const [p] = await runnerFor(world).runPlans([{ local: '/p/missing' }]);
  assert.equal(p.status, 'conflict');
  assert.equal(p.conflicts[0].key, 'checkout');
  assert.match(p.conflicts[0].reason, /does not exist/);
  assert.deepEqual(p.ops, []);
  assert.equal(ghCalls(world).length, 0);
});

test('ambiguous local/<folder> lookup is a conflict', async () => {
  const world = makeWorld();
  world.checkouts['/p/a/demo'] = { remotes: {} };
  world.checkouts['/p/b/demo'] = { remotes: {} };
  const [p] = await runnerFor(world).runPlans(['local/demo']);
  assert.equal(p.status, 'conflict');
  assert.match(p.conflicts[0].reason, /Several local directories match/);
  assert.equal(ghCalls(world).length, 0);
});

test('CLI usage points plan to /factory', () => {
  const out = execFileSync('node', ['src/cli.mjs', '--help'], { encoding: 'utf8' });
  assert.match(out, /Setup and management commands .*\/factory/);
});
