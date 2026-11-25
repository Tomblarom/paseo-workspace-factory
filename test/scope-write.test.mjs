// Scope write side (S3) and multi-entry planning (S4): scope ids in metadata
// and steer labels, parent@branch worktree ids, --name, collision conflicts,
// the non-destructive scope supplement, and scoped --adopt. Fakes only.
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
    checkouts: {}, localDirs: new Set(), projects: [], workspaces: [], agents: [],
    providers: structuredClone(PROVIDERS), calls: [], receipts: new Map(), seq: 0,
  };
}

function strictGh(world) {
  return (args) => {
    world.calls.push(['gh', ...args]);
    throw new Error('gh must not be called for dir/workspace scopes');
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
    if (args[0] === 'rev-parse') return args.includes('--abbrev-ref') ? (checkout.branch ?? 'main') : 'b1c2d3e4f5a6b7c8d9e0';
    if (args[0] === 'status') return '';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function worldScan(world) {
  return () => Object.entries(world.checkouts).map(([path, c]) => ({
    path, linkedWorktree: Boolean(c.linkedWorktree), remotes: { ...(c.remotes ?? {}) }, repos: {},
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

function addWorktree(world, { mainPath = '/p/mainproj', worktreePath, title, metadata = {}, id } = {}) {
  const project = addProject(world, mainPath);
  const workspace = {
    id: id ?? `wks_${String(++world.seq).padStart(16, '0')}`,
    projectId: project.projectId, workspaceDirectory: worktreePath, workspaceKind: 'worktree',
    project: { checkout: { isPaseoOwnedWorktree: true } },
    title: title ?? worktreePath.split('/').at(-1), name: title ?? worktreePath.split('/').at(-1),
    metadata: structuredClone(metadata), createdAt: new Date(Date.now() + 1000).toISOString(),
  };
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
    timeline: { refetch: async () => ({ entries: [] }) },
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
        const project = addProject(world, source.path);
        const workspace = {
          id: `wks_${String(++world.seq).padStart(16, '0')}`, projectId: project.projectId,
          workspaceDirectory: source.path, workspaceKind: 'local_checkout', title, name: title,
          metadata: structuredClone(metadata), createdAt: new Date().toISOString(),
        };
        world.workspaces.push(workspace);
        world.receipts.set(idempotencyKey, workspace.id);
        return workspaceHandle(workspace.id);
      },
    },
    agents: { ref: agentHandle },
  };
}

function fakePaseoCli(world) {
  return (args) => {
    world.calls.push(['paseo', ...args]);
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
    config, client: null, gh: strictGh(world), git: fakeGit(world),
    readState: async () => structuredClone({ projects: world.projects, workspaces: world.workspaces, agents: world.agents, providers: world.providers }),
    scan: worldScan(world),
    inspectTarget: () => { throw new Error('no clones in scope tests'); },
    realpath: (p) => p, existsDir: fakeExistsDir(world),
  });
}

const keys = (p) => p.ops.map((op) => op.key);
const ghCalls = (world) => world.calls.filter((c) => c[0] === 'gh');

// ------------------------------------------------------------------ S3 names

test('normalizeEntry keeps a valid per-entry name and rejects bad ones', () => {
  assert.equal(normalizeEntry({ local: '/p/demo', name: 'notes' }, CONFIG).name, 'notes');
  assert.equal(normalizeEntry({ repo: 'local/demo', name: 'notes' }, CONFIG).name, 'notes');
  assert.equal(normalizeEntry({ workspace: 'wks_abc', name: 'notes' }, CONFIG).name, 'notes');
  assert.equal('name' in normalizeEntry({ local: '/p/demo' }, CONFIG), false);
  for (const bad of ['', '  ', 'a/b', 'a:b', 'x'.repeat(101), '.', '..']) {
    assert.throws(() => normalizeEntry({ local: '/p/demo', name: bad }, CONFIG), /Scope name/, JSON.stringify(bad));
  }
  assert.throws(() => normalizeEntry({ local: '/p/demo', name: 42 }, CONFIG), /Scope name must be a string/);
});

test('dir scope id is --name or the folder; metadata and steer labels carry it', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const project = addProject(world, '/p/demo');
  world.workspaces.push({
    id: 'wks_dirid0000000001', projectId: project.projectId, workspaceDirectory: '/p/demo',
    workspaceKind: 'local_checkout', title: 'Main', name: 'Main', metadata: {}, createdAt: new Date().toISOString(),
  });
  const [named] = await runnerFor(world).runPlans([{ local: '/p/demo', name: 'notes' }]);
  assert.equal(named.repo, 'notes');
  assert.deepEqual(named.ops.find((o) => o.key === 'workspace.main.adopt').params.metadata[METADATA_KEY].scope, { id: 'notes', kind: 'dir', locator: '/p/demo' });
  const steer = named.ops.find((o) => o.key === 'steer.A').params;
  assert.equal(steer.labels[LABEL.scope], 'notes');
  assert.equal(steer.labels[LABEL.repo], 'notes', 'wsf.repo keeps the scope id for compatibility');
  const [folder] = await runnerFor(world).runPlans([{ local: '/p/demo' }]);
  assert.equal(folder.repo, 'demo');
  assert.equal(ghCalls(world).length, 0);
});

test('worktree id is <parent>@<branch> with a github parent from the project origin', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: { origin: 'https://github.com/Example/demo.git' } };
  world.checkouts['/wt/feat'] = { remotes: {}, linkedWorktree: true, branch: 'feat' };
  addWorktree(world, { mainPath: '/p/demo', worktreePath: '/wt/feat' });
  const [d] = await runnerFor(world).discoverAll([{ local: '/wt/feat' }]);
  assert.deepEqual(d.scope.parent, { id: 'Example/demo', kind: 'github' });
  assert.equal(d.forkName, 'Example/demo@feat');
  assert.equal(ghCalls(world).length, 0, 'parent detection is local git data, no network');
});

test('github parent prefers the live scope id so the link stays resolvable', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: { origin: 'https://github.com/Example/demo.git' } };
  world.checkouts['/wt/feat'] = { remotes: {}, linkedWorktree: true, branch: 'feat' };
  const live = {
    id: 'wks_live000000000001', projectId: 'prj_live', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout',
    title: 'Main', name: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: 'Example/demo', kind: 'github', locator: 'Example/demo' } } },
  };
  world.workspaces.push(live);
  addWorktree(world, { mainPath: '/p/demo', worktreePath: '/wt/feat' });
  const [d] = await runnerFor(world).discoverAll([{ local: '/wt/feat' }]);
  assert.deepEqual(d.scope.parent, { id: 'Example/demo', kind: 'github' });
  assert.equal(d.forkName, 'Example/demo@feat');
});

test('detached worktree and --name override fall back to folder or name', async () => {
  const world = makeWorld();
  world.checkouts['/wt/old'] = { remotes: {}, linkedWorktree: true, branch: 'HEAD' };
  addWorktree(world, { mainPath: '/p/mainproj', worktreePath: '/wt/old' });
  const [detached] = await runnerFor(world).discoverAll([{ local: '/wt/old' }]);
  assert.equal(detached.forkName, 'old');
  assert.deepEqual(detached.scope.parent, { id: 'mainproj', kind: 'dir' });
  const [named] = await runnerFor(world).discoverAll([{ local: '/wt/old', name: 'rescue' }]);
  assert.equal(named.forkName, 'rescue');
});

test('worktree without project info gets no parent and the folder id', async () => {
  const world = makeWorld();
  world.checkouts['/wt/lone'] = { remotes: {}, linkedWorktree: true, branch: 'feat' };
  world.workspaces.push({
    id: 'wks_lone000000000001', projectId: 'prj_missing', workspaceDirectory: '/wt/lone', workspaceKind: 'worktree',
    title: 'lone', name: 'lone', metadata: {},
  });
  const [d] = await runnerFor(world).discoverAll([{ local: '/wt/lone' }]);
  assert.equal(d.forkName, 'lone');
  assert.equal(d.scope.parent, undefined);
});

test('stored scope wins over recomputation (stable id across branch switches)', async () => {
  const world = makeWorld();
  world.checkouts['/wt/feat'] = { remotes: {}, linkedWorktree: true, branch: 'newbranch' };
  const wt = addWorktree(world, {
    mainPath: '/p/demo', worktreePath: '/wt/feat',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 2, scope: { id: 'demo@old', kind: 'workspace', locator: 'wks_x', parent: { id: 'demo', kind: 'dir' } } } },
  });
  const [d] = await runnerFor(world).discoverAll([{ local: '/wt/feat' }]);
  assert.equal(d.forkName, 'demo@old');
  assert.equal(d.scope.locator, 'wks_x');
  assert.equal(d.mainWorkspace?.id, wt.id);
  const [p] = await runnerFor(world).runPlans([{ local: '/wt/feat' }]);
  assert.ok(!keys(p).includes('workspace.main.scope'), 'stored scope needs no supplement');
});

// ------------------------------------------------------- S3 collisions

test('id collision with a live scope is a conflict with a --name hint', async () => {
  const world = makeWorld();
  world.checkouts['/p/taken'] = { remotes: {} };
  world.checkouts['/p/other'] = { remotes: {} };
  world.workspaces.push({
    id: 'wks_taken00000000001', projectId: 'prj_1', workspaceDirectory: '/p/taken', workspaceKind: 'local_checkout',
    title: 'Main', name: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: 'taken', kind: 'dir', locator: '/p/taken' } } },
  });
  const [p] = await runnerFor(world).runPlans([{ local: '/p/other', name: 'taken' }]);
  assert.equal(p.status, 'conflict');
  assert.match(p.conflicts.find((c) => c.key === 'scope.id').reason, /--name/);
  const [self] = await runnerFor(world).runPlans([{ local: '/p/taken' }]);
  assert.ok(!self.conflicts.some((c) => c.key === 'scope.id'), 'own scope id is not a collision');
});

test('K13: runPlans takes exactly one entry; same-scope collisions use --name', async () => {
  const world = makeWorld();
  world.checkouts['/p/a/demo'] = { remotes: {} };
  world.checkouts['/p/b/demo'] = { remotes: {} };
  await assert.rejects(runnerFor(world).runPlans([{ local: '/p/a/demo' }, { local: '/p/b/demo' }]), /exactly one workspace entry/);
  await assert.rejects(runnerFor(world).runPlans([]), /exactly one workspace entry/);
  const [named] = await runnerFor(world).runPlans([{ local: '/p/b/demo', name: 'demo-b' }]);
  assert.ok(!named.conflicts.some((c) => c.key === 'scope.id'));
});

// ------------------------------------------------------- S3 supplement

test('existing main without scope gets a non-destructive supplement op', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const project = addProject(world, '/p/demo');
  const ws = {
    id: 'wks_main000000000001', projectId: project.projectId, workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout',
    title: 'Main', name: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 4 } }, createdAt: new Date().toISOString(),
  };
  world.workspaces.push(ws);
  for (const [slot, [provider, model]] of Object.entries({ A: ['codex', 'gpt-6.2-sol'], B: ['muse', 'muse-spark-1.3-contributor'] })) {
    addAgent(world, { provider, model, title: `Steer ${slot}`, workspaceId: ws.id, labels: { [LABEL.repo]: 'local/demo', [LABEL.role]: 'steer', [LABEL.slot]: slot } });
  }
  const entries = [{ local: '/p/demo' }];
  const runner = runnerFor(world);
  const [p] = await runner.runPlans(entries);
  assert.deepEqual(keys(p), ['workspace.main.scope']);
  const op = p.ops[0];
  assert.equal(op.kind, 'paseo.workspace.scope');
  assert.deepEqual(op.params.scope, { id: 'demo', kind: 'dir', locator: '/p/demo' });
  const authorization = createAuthorization([p], CONFIG, { entries, allowFork: false, adopt: {} });
  const result = await applyPlans({
    authorization, config: CONFIG, confirm: authorization.hash, lookupReceipt: fakeLookup(world),
    runPlans: (list, options) => runner.runPlans(list, options),
    execute: createExecutors({ client: fakeClient(world), gh: strictGh(world), git: fakeGit(world), paseoCli: fakePaseoCli(world), sleep: async () => {} }),
  });
  assert.equal(result.report[0].status, 'complete', result.report[0].error);
  assert.deepEqual(world.workspaces[0].metadata[METADATA_KEY], { main: true, activeSteer: 'A', epoch: 4, scope: { id: 'demo', kind: 'dir', locator: '/p/demo' } });
  const [after] = await runner.runPlans(entries);
  assert.equal(after.status, 'complete');
  assert.equal(ghCalls(world).length, 0);
});

test('scope executor refuses invalid scopes, missing mains and existing scopes', async () => {
  const world = makeWorld();
  const ws = {
    id: 'wks_main000000000002', projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout',
    title: 'Main', name: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } },
  };
  world.workspaces.push(ws);
  const execute = createExecutors({ client: fakeClient(world), gh: strictGh(world), git: fakeGit(world), paseoCli: fakePaseoCli(world), sleep: async () => {} });
  const run = (params) => execute({ key: 'workspace.main.scope', kind: 'paseo.workspace.scope', params }, CONFIG);
  await assert.rejects(run({ workspaceId: ws.id, scope: { id: '', kind: 'dir' } }), /valid scope/);
  await assert.rejects(run({ workspaceId: 'wks_missing', scope: { id: 'demo', kind: 'dir', locator: '/p/demo' } }), /no factory main metadata/);
  const out = await run({ workspaceId: ws.id, scope: { id: 'demo', kind: 'dir', locator: '/p/demo' } });
  assert.deepEqual(out, { workspaceId: ws.id, scope: 'demo' });
  await assert.rejects(run({ workspaceId: ws.id, scope: { id: 'demo', kind: 'dir', locator: '/p/demo' } }), /already carries scope/);
});

test('legacy local/ steer labels still match (no duplicate steers planned)', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const project = addProject(world, '/p/demo');
  const ws = {
    id: 'wks_main000000000003', projectId: project.projectId, workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout',
    title: 'Main', name: 'Main',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: 'demo', kind: 'dir', locator: '/p/demo' } } },
    createdAt: new Date().toISOString(),
  };
  world.workspaces.push(ws);
  for (const [slot, [provider, model]] of Object.entries({ A: ['codex', 'gpt-6.2-sol'], B: ['muse', 'muse-spark-1.3-contributor'] })) {
    addAgent(world, { provider, model, title: `Steer ${slot}`, workspaceId: ws.id, labels: { [LABEL.repo]: 'local/demo', [LABEL.role]: 'steer', [LABEL.slot]: slot } });
  }
  const [p] = await runnerFor(world).runPlans([{ local: '/p/demo' }]);
  assert.equal(p.status, 'complete', JSON.stringify(p.conflicts));
  assert.deepEqual(p.ops, []);
});

// ------------------------------------------------------- S4 single entry (K13)

test('plan enrolls one local scope at a time without gh calls', async () => {
  const world = makeWorld();
  world.checkouts['/p/one'] = { remotes: {} };
  world.checkouts['/p/two'] = { remotes: {} };
  const [a] = await runnerFor(world).runPlans([{ local: '/p/one' }]);
  assert.equal(a.repo, 'one');
  const [b] = await runnerFor(world).runPlans([{ local: '/p/two' }]);
  assert.equal(b.repo, 'two');
  assert.equal(ghCalls(world).length, 0);
});

test('adopt maps by slot for the single entry ("*" fallback or exact scope id)', async () => {
  const world = makeWorld();
  world.checkouts['/p/one'] = { remotes: {} };
  const project = addProject(world, '/p/one');
  const ws = {
    id: 'wks_one0000000001', projectId: project.projectId, workspaceDirectory: '/p/one', workspaceKind: 'local_checkout',
    title: 'Main', name: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } }, createdAt: new Date().toISOString(),
  };
  world.workspaces.push(ws);
  addAgent(world, { title: 'Steer A', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id });
  const one = world.agents.find((a) => a.workspaceId === 'wks_one0000000001');
  const [single] = await runnerFor(world).runPlans([{ local: '/p/one' }], { adopt: { '*': { A: one.id } } });
  assert.equal(single.ops.find((o) => o.key === 'steer.A').params.agentId, one.id);
  const [exact] = await runnerFor(world).runPlans([{ local: '/p/one' }], { adopt: { one: { A: one.id } } });
  assert.equal(exact.ops.find((o) => o.key === 'steer.A').params.agentId, one.id);
});

test('CLI usage points plan to /factory and omits retired flags', () => {
  const out = execFileSync('node', ['src/cli.mjs', '--help'], { encoding: 'utf8' });
  assert.match(out, /\/factory in the Paseo composer/);
  assert.doesNotMatch(out, /--repos-file|--allow-fork|--checkout/);
});
