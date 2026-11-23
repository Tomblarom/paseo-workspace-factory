// Worktree adoption: an existing Paseo worktree workspace becomes the factory
// main workspace without a new project or duplicate workspace. Same fake world
// shapes as local-mode.test.mjs; gh must never be called.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { normalizeEntry, isWorktreeWorkspace } from '../src/discovery.mjs';
import { createRunner } from '../src/factory.mjs';
import { applyPlans, createExecutors, createAuthorization } from '../src/apply.mjs';
import { switchSteer, steerStatus, writeCheckpoint } from '../src/steer.mjs';
import { LABEL, METADATA_KEY } from '../src/paseo.mjs';

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

const WT_DIR = '/wt/mobile-tab-swipe';
const MAIN_PROJ = '/p/mainproj';

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
    seq: 0,
  };
}

function strictGh(world) {
  return (args) => {
    world.calls.push(['gh', ...args]);
    throw new Error('gh must not be called for worktree adoption');
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
    if (args[0] === 'rev-parse') return args.includes('--abbrev-ref') ? 'feature-branch' : 'b1c2d3e4f5a6b7c8d9e0';
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

/** Worktree workspace: directory differs from its owning project root. */
function addWorktree(world, { mainPath = MAIN_PROJ, worktreePath = WT_DIR, title = 'Main Project · Feature', metadata = {}, id } = {}) {
  const project = addProject(world, mainPath);
  const workspace = {
    id: id ?? `wks_${String(++world.seq).padStart(16, '0')}`,
    projectId: project.projectId,
    workspaceDirectory: worktreePath,
    workspaceKind: 'worktree',
    project: { checkout: { isPaseoOwnedWorktree: true } },
    title,
    name: title,
    metadata: structuredClone(metadata),
    createdAt: new Date(Date.now() + 1000).toISOString(),
  };
  world.workspaces.push(workspace);
  return workspace;
}

function addPlainWorkspace(world, { path, title = 'Main', metadata = {} }) {
  const project = addProject(world, path);
  const workspace = {
    id: `wks_${String(++world.seq).padStart(16, '0')}`,
    projectId: project.projectId,
    workspaceDirectory: path,
    workspaceKind: 'local_checkout',
    title,
    name: title,
    metadata: structuredClone(metadata),
    createdAt: new Date(Date.now() + 1000).toISOString(),
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
        const workspace = addPlainWorkspace(world, { path: source.path, title, metadata });
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
    if (args[0] === 'clone') throw new Error('clone must not run for worktrees');
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
    inspectTarget: () => { throw new Error('clone target must not be inspected for worktrees'); },
    realpath: (p) => p,
    existsDir: fakeExistsDir(world),
  });
}

const noLock = (_name, fn) => fn({ verify() {} });
const keys = (p) => p.ops.map((op) => op.key);
const ghCalls = (world) => world.calls.filter((c) => c[0] === 'gh');

test('normalizeEntry accepts workspace ids as object, prefixed and bare strings', () => {
  assert.deepEqual(normalizeEntry({ workspace: 'wks_abc123' }, CONFIG).workspaceId, 'wks_abc123');
  assert.deepEqual(normalizeEntry({ workspaceId: 'wks_abc123' }, CONFIG).workspaceId, 'wks_abc123');
  assert.deepEqual(normalizeEntry('workspace:wks_abc123', CONFIG).workspaceId, 'wks_abc123');
  assert.deepEqual(normalizeEntry('worktree:wks_abc123', CONFIG).workspaceId, 'wks_abc123');
  assert.deepEqual(normalizeEntry('wks_abc123', CONFIG).workspaceId, 'wks_abc123');
  assert.equal(normalizeEntry('workspace:wks_abc123', CONFIG).repo, 'workspace:wks_abc123');
  assert.throws(() => normalizeEntry({ workspace: '  ' }, CONFIG), /non-empty "workspace"/);
  assert.throws(() => normalizeEntry({}, CONFIG), /needs "repo", "local" or "workspace"/);
});

test('isWorktreeWorkspace matches kind and owned flag', () => {
  assert.equal(isWorktreeWorkspace({ workspaceKind: 'worktree' }), true);
  assert.equal(isWorktreeWorkspace({ workspaceKind: 'local_checkout', project: { checkout: { isPaseoOwnedWorktree: true } } }), true);
  assert.equal(isWorktreeWorkspace({ workspaceKind: 'local_checkout' }), false);
  assert.equal(isWorktreeWorkspace(null), false);
});

test('explicit worktree path adopts the worktree workspace without gh calls', async () => {
  const world = makeWorld();
  world.checkouts[WT_DIR] = { remotes: {}, linkedWorktree: true };
  const wt = addWorktree(world, {});
  const [d] = await runnerFor(world).discoverAll([{ local: WT_DIR }]);
  assert.equal(ghCalls(world).length, 0);
  assert.equal(d.forkName, 'mainproj@feature-branch');
  assert.deepEqual(d.scope, { id: 'mainproj@feature-branch', kind: 'workspace', locator: wt.id, parent: { id: 'mainproj', kind: 'dir' } });
  assert.equal(d.mainWorkspace?.id, wt.id);
  assert.ok(d.worktree);
  assert.equal(d.worktree.workspaceId, wt.id);
  assert.equal(d.checkout?.path, WT_DIR);
  assert.deepEqual(d.checkoutIssues, []);
  // The owning project (root elsewhere) is attached; no new project is needed.
  assert.equal(d.projects.length, 1);
  assert.equal(d.projects[0].projectRootPath, MAIN_PROJ);
});

test('worktree path without a scanned checkout is still adopted', async () => {
  const world = makeWorld();
  world.localDirs.add(WT_DIR);
  const wt = addWorktree(world, {});
  const [d] = await runnerFor(world).discoverAll([{ local: WT_DIR }]);
  assert.equal(d.mainWorkspace?.id, wt.id);
  assert.equal(d.checkout?.path, WT_DIR);
  assert.equal(d.checkout?.worktree, true);
  assert.deepEqual(d.checkoutIssues, []);
});

test('fresh worktree plans only metadata adoption and steers', async () => {
  const world = makeWorld();
  world.checkouts[WT_DIR] = { remotes: {}, linkedWorktree: true };
  addWorktree(world, {});
  const [p] = await runnerFor(world).runPlans([{ local: WT_DIR }]);
  assert.equal(ghCalls(world).length, 0);
  assert.equal(p.repo, 'mainproj@feature-branch');
  assert.equal(p.status, 'pending');
  assert.deepEqual(keys(p), ['workspace.main.adopt', 'steer.A', 'steer.B']);
  const adopt = p.ops.find((op) => op.key === 'workspace.main.adopt');
  assert.equal(adopt.kind, 'paseo.workspace.metadata');
  assert.match(adopt.summary, /worktree workspace/);
  const steer = p.ops.find((op) => op.key === 'steer.A').params;
  assert.equal(steer.labels[LABEL.repo], 'mainproj@feature-branch');
  assert.equal(steer.labels[LABEL.scope], 'mainproj@feature-branch');
  assert.ok(!keys(p).some((k) => k === 'paseo.project' || k === 'workspace.main'));
});

test('adopt and slots work in worktree mode', async () => {
  const world = makeWorld();
  world.checkouts[WT_DIR] = { remotes: {}, linkedWorktree: true };
  const wt = addWorktree(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } } });
  const legacy = addAgent(world, { title: 'Steer A', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: wt.id });
  const [needConfirm] = await runnerFor(world).runPlans([{ local: WT_DIR }]);
  assert.match(needConfirm.conflicts.find((c) => c.key === 'steer.A').reason, new RegExp(`--adopt A=${legacy.id}`));
  const [adopted] = await runnerFor(world).runPlans([{ local: WT_DIR }], { adopt: { '*': { A: legacy.id } } });
  assert.equal(adopted.ops.find((o) => o.key === 'steer.A').kind, 'paseo.agent.adopt');
  const [slots] = await runnerFor(world).runPlans([{ local: WT_DIR }], { slots: ['B'] });
  assert.deepEqual(keys(slots).filter((k) => k.startsWith('steer.')), ['steer.B']);
  assert.equal(ghCalls(world).length, 0);
});

test('existing worktree agents are listed, never renamed or archived', async () => {
  const world = makeWorld();
  world.checkouts[WT_DIR] = { remotes: {}, linkedWorktree: true };
  const wt = addWorktree(world, {});
  const top = addAgent(world, { title: 'Feature work', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: wt.id });
  addAgent(world, { title: 'Review child', provider: 'muse', model: 'muse-spark-1.3-contributor', workspaceId: wt.id, labels: { 'paseo.parent-agent-id': top.id } });
  const [p] = await runnerFor(world).runPlans([{ local: WT_DIR }]);
  const note = p.notes.find((n) => n.startsWith('Existing worktree agents kept'));
  assert.ok(note, p.notes.join('\n'));
  assert.match(note, /Feature work/);
  assert.match(note, /Review child/);
  assert.match(note, /not renamed or archived/);
  assert.ok(p.ops.every((op) => op.kind !== 'paseo.agent.adopt' || !note.includes(op.params.agentId)));
  assert.equal(ghCalls(world).length, 0);
});

test('status, checkpoint and switch resolve via folder name and workspace id', async () => {
  const world = makeWorld();
  world.checkouts[WT_DIR] = { remotes: {}, linkedWorktree: true };
  const wt = addWorktree(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } } });
  for (const [slot, [provider, model]] of Object.entries({ A: ['codex', 'gpt-6.2-sol'], B: ['muse', 'muse-spark-1.3-contributor'] })) {
    addAgent(world, { provider, model, title: `Steer ${slot}`, workspaceId: wt.id, labels: { [LABEL.repo]: 'local/mobile-tab-swipe', [LABEL.role]: 'steer', [LABEL.slot]: slot } });
  }
  const [byPath] = await runnerFor(world).discoverAll([{ local: WT_DIR }]);
  const [byFolder] = await runnerFor(world).discoverAll(['local/mobile-tab-swipe']);
  const [byId] = await runnerFor(world).discoverAll([{ workspace: wt.id }]);
  const [byPrefixed] = await runnerFor(world).discoverAll([`workspace:${wt.id}`]);
  const [byBare] = await runnerFor(world).discoverAll([wt.id]);
  for (const d of [byFolder, byId, byPrefixed, byBare]) {
    assert.equal(d.forkName, 'mainproj@feature-branch');
    assert.equal(d.mainWorkspace?.id, byPath.mainWorkspace?.id);
    assert.ok(d.worktree);
  }
  const status = steerStatus(byId);
  assert.equal(status.repo, 'mainproj@feature-branch');
  assert.deepEqual(status.steers.map((s) => s.slot), ['A', 'B']);
  assert.ok(status.worktree);
  assert.equal(status.worktree.workspaceId, wt.id);
  const cp = await writeCheckpoint({ client: fakeClient(world), discovery: byFolder, task: 'Worktree task', lock: noLock });
  assert.equal(cp.task, 'Worktree task');
  const switched = await switchSteer({ client: fakeClient(world), discovery: byId, toSlot: 'B', git: fakeGit(world), lock: noLock });
  assert.equal(switched.to, 'B');
  assert.match(switched.packet, /mainproj@feature-branch/);
  assert.equal(ghCalls(world).length, 0);
});

test('ambiguous folder names are conflicts; path or id disambiguates', async () => {
  const world = makeWorld();
  world.checkouts['/p/a/demo'] = { remotes: {} };
  world.checkouts['/p/b/demo'] = { remotes: {} };
  world.checkouts['/wt/x/demo'] = { remotes: {}, linkedWorktree: true };
  const wt = addWorktree(world, { mainPath: '/p/mainproj', worktreePath: '/wt/x/demo', title: 'Main Project · demo' });
  const [p] = await runnerFor(world).runPlans(['local/demo']);
  assert.equal(p.status, 'conflict');
  assert.match(p.conflicts[0].reason, /Several local directories match/);
  const [byPath] = await runnerFor(world).runPlans([{ local: '/wt/x/demo' }]);
  assert.equal(byPath.status, 'pending');
  assert.ok(keys(byPath).includes('workspace.main.adopt'));
  const [d] = await runnerFor(world).discoverAll([{ local: '/wt/x/demo' }]);
  assert.equal(d.mainWorkspace?.id, wt.id);
  const [byId] = await runnerFor(world).discoverAll([{ workspace: wt.id }]);
  assert.equal(byId.mainWorkspace?.id, wt.id);
  assert.equal(ghCalls(world).length, 0);
});

test('two worktrees sharing one folder are a conflict', async () => {
  const world = makeWorld();
  world.checkouts['/wt/a/same'] = { remotes: {}, linkedWorktree: true };
  world.checkouts['/wt/b/same'] = { remotes: {}, linkedWorktree: true };
  addWorktree(world, { mainPath: '/p/proj-a', worktreePath: '/wt/a/same', title: 'A · same' });
  const second = addWorktree(world, { mainPath: '/p/proj-b', worktreePath: '/wt/b/same', title: 'B · same' });
  const [p] = await runnerFor(world).runPlans(['local/same']);
  assert.equal(p.status, 'conflict');
  assert.match(p.conflicts[0].reason, /Several local directories match/);
  const [d] = await runnerFor(world).discoverAll([{ workspace: second.id }]);
  assert.equal(d.mainWorkspace?.id, second.id);
  assert.deepEqual(d.checkoutIssues, []);
});

test('normal local discovery is unchanged when worktrees do not match', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  world.checkouts[WT_DIR] = { remotes: {}, linkedWorktree: true };
  addWorktree(world, {});
  const [p] = await runnerFor(world).runPlans([{ local: '/p/demo' }]);
  assert.equal(p.repo, 'demo');
  assert.deepEqual(keys(p), ['paseo.project', 'workspace.main', 'steer.A', 'steer.B']);
  const [d] = await runnerFor(world).discoverAll(['local/demo']);
  assert.equal(d.worktree ?? null, null);
  assert.equal(d.mainWorkspace, null);
});

test('unknown or non-worktree workspace ids are conflicts', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const plain = addPlainWorkspace(world, { path: '/p/demo' });
  const [missing] = await runnerFor(world).runPlans([{ workspace: 'wks_doesnotexist0001' }]);
  assert.equal(missing.status, 'conflict');
  assert.match(missing.conflicts[0].reason, /not found/);
  const [notWorktree] = await runnerFor(world).runPlans([{ workspace: plain.id }]);
  assert.equal(notWorktree.status, 'conflict');
  assert.match(notWorktree.conflicts[0].reason, /not a worktree workspace/);
  assert.equal(ghCalls(world).length, 0);
});

test('apply adopts the worktree with fakes and creates no project or workspace', async () => {
  const world = makeWorld();
  world.checkouts[WT_DIR] = { remotes: {}, linkedWorktree: true };
  const wt = addWorktree(world, {});
  const entries = [{ local: WT_DIR }];
  const runner = runnerFor(world);
  const plans = await runner.runPlans(entries);
  const authorization = createAuthorization(plans, CONFIG, { entries, allowFork: false, adopt: {} });
  const result = await applyPlans({
    authorization, config: CONFIG, confirm: authorization.hash,
    lookupReceipt: fakeLookup(world),
    runPlans: (list, options) => runner.runPlans(list, options),
    execute: createExecutors({ client: fakeClient(world), gh: strictGh(world), git: fakeGit(world), paseoCli: fakePaseoCli(world), sleep: async () => {} }),
  });
  assert.equal(result.report[0].status, 'complete', result.report[0].error);
  assert.equal(ghCalls(world).length, 0);
  assert.equal(world.calls.some((c) => c[0] === 'paseo' && c[1] === 'project'), false);
  assert.equal(world.calls.some((c) => c[0] === 'workspace.create'), false);
  assert.ok(world.calls.some((c) => c[0] === 'workspace.setMetadata' && c[1] === wt.id));
  assert.equal(world.workspaces.length, 1, 'no duplicate workspace');
  const [after] = await runner.runPlans(entries);
  assert.equal(after.status, 'complete');
});

test('CLI usage documents worktree adoption', () => {
  const out = execFileSync('node', ['src/cli.mjs', '--help'], { encoding: 'utf8' });
  assert.match(out, /worktree/);
  assert.match(out, /workspace:<id>/);
});
