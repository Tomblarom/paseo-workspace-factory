// Workspace titles (S8): workspaceTitle template ({name}, {subject}),
// --retitle op vs note, --rename-project op. Fakes only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { normalizeEntry } from '../src/discovery.mjs';
import { renderWorkspaceTitle, isFactoryHandleTitle } from '../src/planner.mjs';
import { createRunner } from '../src/factory.mjs';
import { applyPlans, createExecutors, createAuthorization } from '../src/apply.mjs';
import { LABEL, METADATA_KEY } from '../src/paseo.mjs';

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
const withTitle = (workspaceTitle) => ({ ...structuredClone(CONFIG), workspaceTitle });

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

function addProject(world, path, displayName) {
  let project = world.projects.find((p) => p.projectRootPath === path);
  if (!project) {
    project = { projectId: `prj_${++world.seq}`, projectRootPath: path, projectDisplayName: displayName ?? path.split('/').at(-1) };
    world.projects.push(project);
  }
  return project;
}
function addMain(world, { path = '/p/demo', title = 'Main', scope = { id: 'demo', kind: 'dir', locator: '/p/demo' } } = {}) {
  const project = addProject(world, path);
  const ws = {
    id: `wks_${String(++world.seq).padStart(16, '0')}`, projectId: project.projectId,
    workspaceDirectory: path, workspaceKind: 'local_checkout', title, name: title,
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope } },
    createdAt: new Date().toISOString(),
  };
  world.workspaces.push(ws);
  return ws;
}
function addSteer(world, ws, slot = 'A') {
  return world.agents[world.agents.push({ id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, title: `Steer ${slot}`, provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id, labels: { [LABEL.repo]: 'demo', [LABEL.role]: 'steer', [LABEL.slot]: slot, [LABEL.scope]: 'demo' } }) - 1];
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  const agentHandle = (id) => ({ id, refresh: async () => ({ agent: structuredClone(findAgent(id)) }) });
  const workspaceHandle = (id) => ({
    id,
    refresh: async () => structuredClone(findWs(id)),
    setMetadata: async (patch) => { Object.assign(findWs(id).metadata, structuredClone(patch)); },
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
    if (args[0] === 'project' && args[1] === 'rename') {
      const project = world.projects.find((p) => p.projectId === args[2]);
      if (!project) throw new Error('project missing');
      project.projectDisplayName = args[3];
      return { projectId: project.projectId };
    }
    if (args[0] === 'workspace' && args[1] === 'rename') {
      const ws = world.workspaces.find((w) => w.id === args[2]);
      if (!ws) throw new Error('workspace missing');
      ws.title = args[3];
      ws.name = args[3];
      return { id: ws.id };
    }
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

// ---------------------------------------------------------------- template

test('renderWorkspaceTitle substitutes {name} and {subject}; errors fail closed', () => {
  assert.deepEqual(renderWorkspaceTitle('Main', 'demo', null), { title: 'Main' });
  assert.deepEqual(renderWorkspaceTitle('{name} · Main', 'demo', null), { title: 'demo · Main' });
  assert.deepEqual(renderWorkspaceTitle('{name} · Main', 'Example/demo', null), { title: 'demo · Main' });
  assert.deepEqual(renderWorkspaceTitle('{name} · {subject}', 'demo', 'USB pass'), { title: 'demo · USB pass' });
  assert.match(renderWorkspaceTitle('{name} · {subject}', 'demo', null).error, /--subject/);
  assert.match(renderWorkspaceTitle('{Name} · Main', 'demo', null).error, /unknown placeholder/);
});

test('renderWorkspaceTitle substitutes {repo} without owner and @branch; errors name the field', () => {
  assert.deepEqual(renderWorkspaceTitle('{repo} · Main', 'demo', null), { title: 'demo · Main' });
  assert.deepEqual(renderWorkspaceTitle('{repo} · Main', 'Example/demo', null), { title: 'demo · Main' });
  assert.deepEqual(renderWorkspaceTitle('{repo} · Main', 'Example/demo@feat', null), { title: 'demo · Main' });
  assert.deepEqual(renderWorkspaceTitle('{repo} · Main', 'notes@feat', null), { title: 'notes · Main' });
  assert.deepEqual(renderWorkspaceTitle('{repo} · {subject}', 'Example/demo', 'USB pass'), { title: 'demo · USB pass' });
  assert.match(renderWorkspaceTitle('{repo} · {subject}', 'demo', null).error, /workspaceTitle template needs/);
  assert.match(renderWorkspaceTitle('{repo} · {subject}', 'demo', null, 'workspaceTitleMultiRepo').error, /workspaceTitleMultiRepo template needs/);
  assert.match(renderWorkspaceTitle('{bogus}', 'demo', null).error, /supported: \{name\}, \{repo\}, \{subject\}/);
});

test('normalizeEntry keeps subject; titles allow spaces and slashes', () => {
  assert.equal(normalizeEntry({ local: '/p/demo', subject: 'USB pass / tab' }, CONFIG).subject, 'USB pass / tab');
  assert.equal('subject' in normalizeEntry({ local: '/p/demo' }, CONFIG), false);
  assert.throws(() => normalizeEntry({ local: '/p/demo', subject: '  ' }, CONFIG), /Subject must not be empty/);
  assert.throws(() => normalizeEntry({ local: '/p/demo', subject: 'a\u0000b' }, CONFIG), /control characters/);
});

test('created workspaces use the rendered template title', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const [p] = await runnerFor(world, withTitle('{name} · Main')).runPlans([{ local: '/p/demo' }]);
  assert.equal(p.ops.find((o) => o.key === 'workspace.main').params.title, 'demo · Main');
  const [s] = await runnerFor(world, withTitle('{name} · {subject}')).runPlans([{ local: '/p/demo', subject: 'USB pass' }]);
  assert.equal(s.ops.find((o) => o.key === 'workspace.main').params.title, 'demo · USB pass');
});

test('template errors are conflicts and block the plan', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const [missing] = await runnerFor(world, withTitle('{name} · {subject}')).runPlans([{ local: '/p/demo' }]);
  assert.equal(missing.status, 'conflict');
  assert.match(missing.conflicts.find((c) => c.key === 'workspace.title').reason, /--subject/);
  assert.ok(!keys(missing).includes('workspace.main'));
  const [unknown] = await runnerFor(world, withTitle('{bogus}')).runPlans([{ local: '/p/demo' }]);
  assert.match(unknown.conflicts.find((c) => c.key === 'workspace.title').reason, /unknown placeholder/);
});

// ------------------------------------------------------- multi-repo titles

const withMulti = (workspaceTitleMultiRepo) => ({ ...structuredClone(CONFIG), workspaceTitleMultiRepo });

function sharedProjectWorld(title = 'Main') {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  world.checkouts['/p/other'] = { remotes: {} };
  const wsA = addMain(world, { path: '/p/demo', title });
  addSteer(world, wsA);
  const wsB = addMain(world, { path: '/p/other', title, scope: { id: 'other', kind: 'dir', locator: '/p/other' } });
  wsB.projectId = wsA.projectId; // both scopes live in one Paseo project
  return world;
}

test('workspaceTitleMultiRepo wins only when several repos share the project', async () => {
  const config = withMulti('{repo} · {subject}');
  // Non-handle titles prove the template selection by the rendered value
  // (the "Main" handle itself is exempt from retitling, see below).
  const [multi] = await runnerFor(sharedProjectWorld('Old Title'), config).runPlans([{ local: '/p/demo', subject: 'USB pass' }], { retitle: true });
  assert.equal(multi.ops.find((o) => o.key === 'workspace.retitle').params.title, 'demo · USB pass');
  const solo = makeWorld();
  solo.checkouts['/p/demo'] = { remotes: {} };
  const soloMain = addMain(solo, { path: '/p/demo', title: 'Old Title' });
  addSteer(solo, soloMain);
  const [single] = await runnerFor(solo, config).runPlans([{ local: '/p/demo', subject: 'USB pass' }], { retitle: true });
  assert.equal(single.ops.find((o) => o.key === 'workspace.retitle').params.title, 'Main', 'single repo keeps workspaceTitle');
  const [unset] = await runnerFor(sharedProjectWorld('Old Title'), CONFIG).runPlans([{ local: '/p/demo', subject: 'USB pass' }], { retitle: true });
  assert.equal(unset.ops.find((o) => o.key === 'workspace.retitle').params.title, 'Main', 'unset multi template keeps workspaceTitle');
});

test('multi template errors name workspaceTitleMultiRepo and block the title', async () => {
  const [missing] = await runnerFor(sharedProjectWorld('Old Title'), withMulti('{repo} · {subject}')).runPlans([{ local: '/p/demo' }], { retitle: true });
  assert.equal(missing.status, 'conflict');
  assert.match(missing.conflicts.find((c) => c.key === 'workspace.title').reason, /workspaceTitleMultiRepo template needs \{subject\}/);
  assert.ok(!keys(missing).includes('workspace.retitle'));
});

// ---------------------------------------------------------------- retitle

test('deviating title is only reported; --retitle plans the rename op', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const ws = addMain(world, { title: 'Old Title' });
  addSteer(world, ws);
  const runner = runnerFor(world, withTitle('{name} · Main'));
  const [reported] = await runner.runPlans([{ local: '/p/demo' }]);
  assert.ok(!keys(reported).includes('workspace.retitle'));
  assert.match(reported.notes.join('\n'), /--retitle/);
  const [planned] = await runner.runPlans([{ local: '/p/demo' }], { retitle: true });
  const op = planned.ops.find((o) => o.key === 'workspace.retitle');
  assert.equal(op.kind, 'paseo.workspace.retitle');
  assert.deepEqual(op.params, { workspaceId: ws.id, from: 'Old Title', title: 'demo · Main' });
  const [same] = await runnerFor(world, withTitle('Old Title')).runPlans([{ local: '/p/demo' }]);
  assert.ok(!keys(same).includes('workspace.retitle'));
  assert.ok(!same.notes.join('\n').includes('--retitle'), 'matching title: no note, no op');
});

test('retitle apply renames and verifies; rerun is clean', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const ws = addMain(world, { title: 'Old Title' });
  addSteer(world, ws);
  const config = withTitle('{name} · Main');
  const runner = runnerFor(world, config);
  const entries = [{ local: '/p/demo' }];
  const plans = await runner.runPlans(entries, { retitle: true });
  const authorization = createAuthorization(plans, config, { entries, allowFork: false, adopt: {}, retitle: true });
  assert.equal(authorization.retitle, true);
  const result = await applyPlans({
    authorization, config, confirm: authorization.hash, lookupReceipt: fakeLookup(world),
    runPlans: (list, options) => runner.runPlans(list, options),
    execute: createExecutors({ client: fakeClient(world), gh: strictGh(world), git: fakeGit(world), paseoCli: fakePaseoCli(world), sleep: async () => {} }),
  });
  assert.equal(result.report[0].status, 'complete', result.report[0].error);
  assert.equal(world.workspaces[0].title, 'demo · Main');
  assert.ok(world.calls.some((c) => c[0] === 'paseo' && c[1] === 'workspace' && c[2] === 'rename'));
  const [after] = await runner.runPlans(entries, { retitle: true });
  assert.equal(after.status, 'complete');
});

test('retitle executor refuses missing workspaces and already-correct titles', async () => {
  const world = makeWorld();
  const ws = addMain(world, { title: 'demo · Main' });
  const execute = createExecutors({ client: fakeClient(world), gh: strictGh(world), git: fakeGit(world), paseoCli: fakePaseoCli(world), sleep: async () => {} });
  const run = (params) => execute({ key: 'workspace.retitle', kind: 'paseo.workspace.retitle', params }, CONFIG);
  await assert.rejects(run({ workspaceId: 'wks_missing', title: 'x' }), /missing/);
  await assert.rejects(run({ workspaceId: ws.id, title: 'demo · Main' }), /already titled/);
  await assert.rejects(run({ workspaceId: ws.id, title: '  ' }), /needs a title/);
});

// ----------------------------------------------- #6 "Main" is the factory handle

test('isFactoryHandleTitle accepts Main and the own repo-prefixed handle only', () => {
  assert.equal(isFactoryHandleTitle('Main', 'demo'), true);
  assert.equal(isFactoryHandleTitle('demo · Main', 'demo'), true);
  assert.equal(isFactoryHandleTitle('demo · Main', 'Example/demo'), true);
  assert.equal(isFactoryHandleTitle('demo · Main', 'Example/demo@feat'), true);
  assert.equal(isFactoryHandleTitle('demo@feat · Main', 'Example/demo@feat'), true);
  assert.equal(isFactoryHandleTitle('garbage · Main', 'demo'), false);
  assert.equal(isFactoryHandleTitle('Main · x', 'demo'), false);
  assert.equal(isFactoryHandleTitle('main', 'demo'), false);
  assert.equal(isFactoryHandleTitle('', 'demo'), false);
  assert.equal(isFactoryHandleTitle(null, 'demo'), false);
});

test('MAIN_TITLE recognition covers Main and <Repo> · Main without metadata', async () => {
  for (const title of ['Main', 'demo · Main']) {
    const world = makeWorld();
    world.checkouts['/p/demo'] = { remotes: {} };
    const project = addProject(world, '/p/demo');
    const ws = {
      id: `wks_${String(++world.seq).padStart(16, '0')}`, projectId: project.projectId,
      workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout', title, name: title, metadata: {},
    };
    world.workspaces.push(ws);
    const [d] = await runnerFor(world).discoverAll([{ local: '/p/demo' }]);
    assert.equal(d.mainWorkspace?.id, ws.id, title);
  }
});

test('handle titles are exempt from the title template: no conflict, note or op', async () => {
  for (const title of ['Main', 'demo · Main']) {
    const world = makeWorld();
    world.checkouts['/p/demo'] = { remotes: {} };
    const ws = addMain(world, { title });
    addSteer(world, ws);
    // Template needs {subject} and none is given — an exempt main needs no rendering.
    const [p] = await runnerFor(world, withTitle('{name} · {subject}')).runPlans([{ local: '/p/demo' }], { retitle: true });
    assert.equal(p.status, 'complete', `${title}: ${JSON.stringify(p.conflicts)}`);
    assert.ok(!keys(p).includes('workspace.retitle'), title);
    assert.ok(!p.notes.join('\n').includes('template expects'), title);
    // Even a renderable mismatch is left alone, under either template.
    const [mismatch] = await runnerFor(world, withTitle('{name} · {subject}')).runPlans([{ local: '/p/demo', subject: 'USB pass' }], { retitle: true });
    assert.equal(mismatch.status, 'complete', title);
    assert.ok(!keys(mismatch).includes('workspace.retitle'), title);
    const [multi] = await runnerFor(sharedProjectWorld(title), withMulti('{repo} · {subject}')).runPlans([{ local: '/p/demo', subject: 'USB pass' }], { retitle: true });
    assert.ok(!keys(multi).includes('workspace.retitle'), `${title} under workspaceTitleMultiRepo`);
  }
  // A wrongly prefixed handle is still reported and fixed toward the template.
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const ws = addMain(world, { title: 'garbage · Main' });
  addSteer(world, ws);
  const runner = runnerFor(world, withTitle('{name} · Main'));
  const [reported] = await runner.runPlans([{ local: '/p/demo' }]);
  assert.match(reported.notes.join('\n'), /template expects "demo · Main"/);
  const [planned] = await runner.runPlans([{ local: '/p/demo' }], { retitle: true });
  assert.equal(planned.ops.find((o) => o.key === 'workspace.retitle').params.title, 'demo · Main');
});

test('renderWorkspaceTitle never renders a double repo prefix', () => {
  assert.deepEqual(renderWorkspaceTitle('{repo} · {subject}', 'Example/demo', 'demo · USB pass'), { title: 'demo · USB pass' });
  assert.deepEqual(renderWorkspaceTitle('{name} · {subject}', 'demo', 'demo · USB pass'), { title: 'demo · USB pass' });
  assert.deepEqual(renderWorkspaceTitle('{repo} · {subject}', 'Example/demo', 'USB pass'), { title: 'demo · USB pass' });
  assert.deepEqual(renderWorkspaceTitle('{repo} · {subject}', 'Example/demo', 'demo'), { title: 'demo · demo' });
  assert.deepEqual(renderWorkspaceTitle('{subject}', 'demo', 'demo · USB pass'), { title: 'demo · USB pass' });
});

// ---------------------------------------------------------- rename-project

test('--rename-project plans the op only onto one differing project', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const ws = addMain(world, {});
  addSteer(world, ws);
  const runner = runnerFor(world);
  const [planned] = await runner.runPlans([{ local: '/p/demo' }], { renameProject: 'Shiny' });
  const op = planned.ops.find((o) => o.key === 'project.rename');
  assert.equal(op.kind, 'paseo.project.rename');
  assert.equal(op.params.name, 'Shiny');
  const [same] = await runner.runPlans([{ local: '/p/demo' }], { renameProject: 'demo' });
  assert.ok(!keys(same).includes('project.rename'));
  const fresh = makeWorld();
  fresh.checkouts['/p/new'] = { remotes: {} };
  const [missing] = await runnerFor(fresh).runPlans([{ local: '/p/new' }], { renameProject: 'Shiny' });
  assert.match(missing.conflicts.find((c) => c.key === 'project.rename').reason, /no Paseo project/);
});

test('project rename apply verifies the new display name', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const ws = addMain(world, {});
  addSteer(world, ws);
  const runner = runnerFor(world);
  const entries = [{ local: '/p/demo' }];
  const plans = await runner.runPlans(entries, { renameProject: 'Shiny' });
  const authorization = createAuthorization(plans, CONFIG, { entries, allowFork: false, adopt: {}, renameProject: 'Shiny' });
  const result = await applyPlans({
    authorization, config: CONFIG, confirm: authorization.hash, lookupReceipt: fakeLookup(world),
    runPlans: (list, options) => runner.runPlans(list, options),
    execute: createExecutors({ client: fakeClient(world), gh: strictGh(world), git: fakeGit(world), paseoCli: fakePaseoCli(world), sleep: async () => {} }),
  });
  assert.equal(result.report[0].status, 'complete', result.report[0].error);
  assert.equal(world.projects[0].projectDisplayName, 'Shiny');
});

test('CLI usage documents --retitle, --rename-project and --subject', () => {
  const out = execFileSync('node', ['src/cli.mjs', '--help'], { encoding: 'utf8' });
  assert.match(out, /--retitle/);
  assert.match(out, /--rename-project <name>/);
  assert.match(out, /--subject <text>/);
  assert.match(out, /\{name\}, \{subject\}/);
});
