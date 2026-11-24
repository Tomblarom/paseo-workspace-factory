// Plan fixes (Steer D packages 1-4): --domain passthrough for workspace:/local/
// string entries, planning existing scopes by scope id, foreign-worker
// candidate exclusion with hints, half-labelled steer conflicts.
// Fakes only; no daemon, no GitHub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeEntry } from '../src/discovery.mjs';
import { createRunner } from '../src/factory.mjs';
import { scopeCandidates, formatScopeCandidates } from '../src/scopes-view.mjs';
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

const SLOT_PROVIDER = { A: ['codex', 'gpt-6.2-sol'], B: ['muse', 'muse-spark-1.3-contributor'] };

function makeWorld() {
  return {
    checkouts: {}, localDirs: new Set(), projects: [], workspaces: [], agents: [],
    providers: structuredClone(PROVIDERS), calls: [], receipts: new Map(), seq: 0,
  };
}

function strictGh(world) {
  return (args) => {
    world.calls.push(['gh', ...args]);
    throw new Error('gh must not be called in these tests');
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
    if (args[0] === 'rev-parse') return args.includes('--abbrev-ref') ? 'main' : 'b1c2d3e4f5a6b7c8d9e0';
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

function provisionDir(world, { path, id, kind = 'dir', domain, epoch = 1, title = 'Main' }) {
  world.checkouts[path] = { remotes: {} };
  const project = addProject(world, path);
  const ws = {
    id: `wks_${String(++world.seq).padStart(16, '0')}`,
    projectId: project.projectId, workspaceDirectory: path, workspaceKind: 'local_checkout',
    title, name: title,
    metadata: {
      [METADATA_KEY]: { main: true, activeSteer: 'A', epoch, scope: { id, kind, locator: path, ...(domain ? { domain } : {}) } },
    },
    createdAt: new Date().toISOString(),
  };
  world.workspaces.push(ws);
  const steers = {};
  for (const [slot, [provider, model]] of Object.entries(SLOT_PROVIDER)) {
    const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, provider, model, title: `Steer ${slot}`, workspaceId: ws.id, labels: { [LABEL.repo]: id, [LABEL.role]: 'steer', [LABEL.slot]: slot, [LABEL.scope]: id } };
    world.agents.push(agent);
    steers[slot] = agent;
  }
  return { ws, steers };
}

function addWorktree(world, { mainPath, worktreePath, scope, title = 'Worktree' }) {
  const project = addProject(world, mainPath);
  const ws = {
    id: `wks_${String(++world.seq).padStart(16, '0')}`,
    projectId: project.projectId, workspaceDirectory: worktreePath, workspaceKind: 'worktree',
    project: { checkout: { isPaseoOwnedWorktree: true } },
    title, name: title,
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: structuredClone(scope) } },
    createdAt: new Date().toISOString(),
  };
  world.workspaces.push(ws);
  const steers = {};
  for (const [slot, [provider, model]] of Object.entries(SLOT_PROVIDER)) {
    const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, provider, model, title: `Steer ${slot}`, workspaceId: ws.id, labels: { [LABEL.repo]: scope.id, [LABEL.role]: 'steer', [LABEL.slot]: slot, [LABEL.scope]: scope.id } };
    world.agents.push(agent);
    steers[slot] = agent;
  }
  return { ws, steers };
}

function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}

function runnerFor(world, config = CONFIG) {
  return createRunner({
    config, client: null, gh: strictGh(world), git: fakeGit(world),
    readState: async () => structuredClone({ projects: world.projects, workspaces: world.workspaces, agents: world.agents, providers: world.providers }),
    scan: worldScan(world),
    inspectTarget: () => { throw new Error('no clones in these tests'); },
    realpath: (p) => p, existsDir: fakeExistsDir(world),
  });
}

const keys = (p) => p.ops.map((op) => op.key);
const ghCalls = (world) => world.calls.filter((c) => c[0] === 'gh');

// ------------------------------------------------------------ package 1: --domain passthrough

test('1: normalizeEntry keeps --domain on workspace:/local/ string entries', () => {
  assert.equal(normalizeEntry({ repo: 'workspace:wks_abc123', domain: 'team-a' }, CONFIG).domain, 'team-a');
  assert.equal(normalizeEntry({ repo: 'wks_abc123', domain: 'team-a' }, CONFIG).domain, 'team-a');
  assert.equal(normalizeEntry({ repo: 'local/web', domain: 'team-a' }, CONFIG).domain, 'team-a');
  assert.equal(normalizeEntry({ repo: 'local/web', domain: '' }, CONFIG).domain, '');
  assert.equal('domain' in normalizeEntry('workspace:wks_abc123', CONFIG), false);
  assert.equal('domain' in normalizeEntry('local/web', CONFIG), false);
});

test('1: plan local/<x> --domain plans a scope.domain op', async () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/team-a', id: 'team-a' });
  const { ws } = provisionDir(world, { path: '/p/web', id: 'web', epoch: 4 });
  const [p] = await runnerFor(world).runPlans([{ repo: 'local/web', domain: 'team-a' }]);
  assert.equal(ghCalls(world).length, 0);
  assert.deepEqual(keys(p), ['scope.domain']);
  assert.deepEqual(p.ops[0].params, { workspaceId: ws.id, domain: 'team-a', epoch: 4 });
});

test('1: plan workspace:<id> --domain plans a scope.domain op (worktree)', async () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/team-a', id: 'team-a' });
  world.checkouts['/wt/feat'] = { remotes: {}, linkedWorktree: true };
  const wtId = `wks_${String(99).padStart(16, '0')}`;
  const { ws } = addWorktree(world, { mainPath: '/p/mainproj', worktreePath: '/wt/feat', scope: { id: 'feat', kind: 'workspace', locator: wtId } });
  ws.metadata[METADATA_KEY].scope.locator = ws.id;
  const [p] = await runnerFor(world).runPlans([{ repo: `workspace:${ws.id}`, domain: 'team-a' }]);
  assert.equal(ghCalls(world).length, 0);
  assert.deepEqual(keys(p), ['scope.domain']);
  assert.deepEqual(p.ops[0].params, { workspaceId: ws.id, domain: 'team-a', epoch: 1 });
});

// ------------------------------------------------------------ package 2: plan by scope id

test('2: plan addresses an existing dir scope by scope id, case-insensitively', async () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/team-a', id: 'team-a' });
  const { ws } = provisionDir(world, { path: '/p/web', id: 'web', epoch: 4 });
  const [plain] = await runnerFor(world).runPlans(['web']);
  assert.equal(ghCalls(world).length, 0);
  assert.equal(plain.status, 'complete', JSON.stringify(plain.conflicts));
  const [upper] = await runnerFor(world).runPlans(['WEB']);
  assert.equal(upper.status, 'complete');
  const [domained] = await runnerFor(world).runPlans([{ repo: 'web', domain: 'team-a' }]);
  assert.deepEqual(keys(domained), ['scope.domain']);
  assert.deepEqual(domained.ops[0].params, { workspaceId: ws.id, domain: 'team-a', epoch: 4 });
});

test('2: plan workspace:<id> on a non-worktree scope plans metadata, not a worktree conflict', async () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/team-a', id: 'team-a' });
  const { ws } = provisionDir(world, { path: '/p/web', id: 'web' });
  const [bare] = await runnerFor(world).runPlans([`workspace:${ws.id}`]);
  assert.equal(bare.status, 'complete', JSON.stringify(bare.conflicts));
  const [domained] = await runnerFor(world).runPlans([{ repo: `workspace:${ws.id}`, domain: 'team-a' }]);
  assert.deepEqual(keys(domained), ['scope.domain']);
  assert.ok(!domained.conflicts.some((c) => /not a worktree workspace/.test(c.reason)));
});

test('2: scope-id plans stay metadata-only (--retitle, --slots); unknown ids still fail', async () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/team-a', id: 'team-a' });
  const { ws, steers } = provisionDir(world, { path: '/p/web', id: 'web', title: 'Old title' });
  const [noted] = await runnerFor(world).runPlans(['web']);
  assert.ok(!keys(noted).includes('workspace.retitle'));
  assert.ok(noted.notes.some((n) => n.includes('"Old title"') && n.includes('--retitle')));
  const [retitled] = await runnerFor(world).runPlans(['web'], { retitle: true });
  assert.deepEqual(keys(retitled), ['workspace.retitle']);
  assert.equal(retitled.ops[0].params.title, 'Main');

  steers.B.archivedAt = '2026-01-01';
  const [narrowed] = await runnerFor(world).runPlans(['web'], { retitle: true, slots: ['A'] });
  assert.deepEqual(keys(narrowed), ['workspace.retitle'], 'unlisted slot B is not planned');
  const [full] = await runnerFor(world).runPlans(['web'], { retitle: true });
  assert.deepEqual(keys(full).sort(), ['steer.B', 'workspace.retitle'].sort());

  await assert.rejects(() => runnerFor(world).runPlans(['no-such-scope']), /Not a GitHub repository/);
  const [missing] = await runnerFor(world).runPlans([{ workspace: 'wks_doesnotexist0001' }]);
  assert.match(missing.conflicts[0].reason, /not found/);
  world.checkouts['/p/plain'] = { remotes: {} };
  const project = addProject(world, '/p/plain');
  const plain = { id: 'wks_plain0000000001', projectId: project.projectId, workspaceDirectory: '/p/plain', workspaceKind: 'local_checkout', title: 'Plain', name: 'Plain', metadata: {}, createdAt: new Date().toISOString() };
  world.workspaces.push(plain);
  const [notWorktree] = await runnerFor(world).runPlans([{ workspace: plain.id }]);
  assert.match(notWorktree.conflicts[0].reason, /not a worktree workspace/);
  assert.equal(ws.id.slice(0, 4), 'wks_');
});

// ------------------------------------------------------------ package 3: foreign workers are no candidates

test('3: candidates parented to another scope\'s steer are excluded with a worker hint', async () => {
  const world = makeWorld();
  const { ws: web, steers: webSteers } = provisionDir(world, { path: '/p/web', id: 'web' });
  const { steers: otherSteers } = provisionDir(world, { path: '/p/other', id: 'other' });
  const foreignLettered = addAgent(world, { title: 'Steer C', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: web.id, labels: { 'paseo.parent-agent-id': otherSteers.A.id } });
  const foreignDigit = addAgent(world, { title: 'Steer 9', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: web.id, labels: { 'paseo.parent-agent-id': otherSteers.B.id } });
  const sameScope = addAgent(world, { title: 'Steer D', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: web.id, labels: { 'paseo.parent-agent-id': webSteers.A.id } });
  const free = addAgent(world, { title: 'Steer E', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: web.id });

  const [d] = await runnerFor(world).discoverAll([{ local: '/p/web' }]);
  assert.deepEqual(d.steers.legacy.map((a) => a.id).sort(), [sameScope.id, free.id].sort());
  assert.deepEqual(d.steers.digitCandidates, []);
  assert.deepEqual(d.steers.foreignWorkers.map((w) => [w.agent.id, w.hint]).sort(), [
    [foreignDigit.id, 'Worker von other Steer B'],
    [foreignLettered.id, 'Worker von other Steer A'],
  ].sort());

  const [p] = await runnerFor(world).runPlans([{ local: '/p/web' }]);
  assert.ok(p.notes.some((n) => n.includes('Worker von other Steer A') && n.includes(foreignLettered.id)), p.notes.join('\n'));
  assert.ok(p.notes.some((n) => n.includes('Worker von other Steer B') && n.includes(foreignDigit.id)), p.notes.join('\n'));
  assert.ok(!p.notes.some((n) => n.includes('--adopt') && n.includes(foreignLettered.id)), 'no adopt hint for foreign workers');

  webSteers.B.archivedAt = '2026-01-01';
  const [refused] = await runnerFor(world).runPlans([{ local: '/p/web' }], { adopt: { '*': { B: foreignLettered.id } } });
  assert.match(refused.conflicts.find((c) => c.key === 'steer.B').reason, /Worker von other Steer A/);
  assert.match(refused.conflicts.find((c) => c.key === 'steer.B').reason, /cannot become steers/);
});

test('3: scope candidates hint workers of labelled steers', () => {
  const state = {
    projects: [{ projectId: 'prj_1', projectRootPath: '/p/web' }],
    workspaces: [
      { id: 'wks_main1', projectId: 'prj_1', title: 'Main', name: 'Main', workspaceDirectory: '/p/web', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: 'web', kind: 'dir', locator: '/p/web' } } } },
      { id: 'wks_plain', projectId: 'prj_1', title: 'Scratch', name: 'Scratch', workspaceDirectory: '/tmp/scratch', metadata: {} },
    ],
    agents: [
      { id: 'steer-a', workspaceId: 'wks_main1', archivedAt: null, title: 'Steer A', provider: 'codex', model: 'm', status: 'idle', labels: { [LABEL.repo]: 'web', [LABEL.role]: 'steer', [LABEL.slot]: 'A', [LABEL.scope]: 'web' } },
      { id: 'agent-w', workspaceId: 'wks_plain', archivedAt: null, title: 'Helper', provider: 'codex', model: 'm', status: 'idle', labels: { 'paseo.parent-agent-id': 'steer-a' } },
      { id: 'agent-f', workspaceId: 'wks_plain', archivedAt: null, title: 'Free', provider: 'codex', model: 'm', status: 'idle', labels: {} },
    ],
    providers: [],
  };
  const [row] = scopeCandidates(state);
  assert.equal(row.workspaceId, 'wks_plain');
  assert.equal(row.agents.find((a) => a.id === 'agent-w').hint, 'Worker von web Steer A');
  assert.equal('hint' in row.agents.find((a) => a.id === 'agent-f'), false);
  assert.match(formatScopeCandidates([row]), /agent-w "Helper" \(codex\/m, idle\) parent steer-a · Worker von web Steer A/);
});

// ------------------------------------------------------------ package 4: half-labelled steers

test('4: half-labelled steers are conflicts; closed+labelled stays visible, archived/scope-less closed drops out', async () => {
  const world = makeWorld();
  const { ws, steers } = provisionDir(world, { path: '/p/web', id: 'web' });
  const half = addAgent(world, { title: 'Steer C', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id, labels: { [LABEL.role]: 'steer', [LABEL.slot]: 'C' } });
  const slotless = addAgent(world, { title: 'Odd', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id, labels: { [LABEL.role]: 'steer' } });
  const closedScoped = addAgent(world, { title: 'Steer F', provider: 'codex', model: 'gpt-6.2-sol', status: 'closed', workspaceId: ws.id, labels: { [LABEL.role]: 'steer', [LABEL.slot]: 'F', [LABEL.scope]: 'web' } });
  const closedBare = addAgent(world, { title: 'Steer D', provider: 'codex', model: 'gpt-6.2-sol', status: 'closed', workspaceId: ws.id, labels: { [LABEL.role]: 'steer', [LABEL.slot]: 'D' } });
  const archived = addAgent(world, { title: 'Steer E', provider: 'codex', model: 'gpt-6.2-sol', archivedAt: '2026-01-01', workspaceId: ws.id, labels: { [LABEL.role]: 'steer', [LABEL.slot]: 'E' } });
  steers.A.archivedAt = '2026-01-01';
  const closedFull = addAgent(world, { title: 'Steer A', provider: 'codex', model: 'gpt-6.2-sol', status: 'closed', workspaceId: ws.id, labels: { [LABEL.repo]: 'web', [LABEL.role]: 'steer', [LABEL.slot]: 'A', [LABEL.scope]: 'web' } });

  const [d] = await runnerFor(world).discoverAll([{ local: '/p/web' }]);
  assert.deepEqual(d.steers.halfLabelled.map((a) => a.id).sort(), [half.id, slotless.id, closedScoped.id].sort());
  assert.ok(d.steers.labelled.some((a) => a.id === closedFull.id), 'closed+labelled stays visible');
  assert.ok(!d.steers.labelled.some((a) => a.id === half.id));

  const [p] = await runnerFor(world).runPlans([{ local: '/p/web' }]);
  assert.equal(p.status, 'conflict');
  assert.match(p.conflicts.find((c) => c.key === 'steer.C').reason, new RegExp(`Half-labelled Steer C ${half.id}`));
  assert.match(p.conflicts.find((c) => c.key === 'steer.C').reason, /without wsf\.scope\/wsf\.repo/);
  assert.match(p.conflicts.find((c) => c.key === 'steer.F').reason, new RegExp(`Half-labelled Steer F ${closedScoped.id}`));
  assert.match(p.conflicts.find((c) => c.key === `labels.half.${slotless.id}`).reason, /Half-labelled/);
  assert.ok(!p.conflicts.some((c) => c.key === 'steer.A'), 'closed fully-labelled Steer A counts as live');
  assert.ok(!keys(p).includes('steer.A'), 'no recreation of the closed Steer A');
  assert.ok(!p.conflicts.some((c) => c.reason.includes(closedFull.id)), 'no half conflict for the closed labelled steer');
  assert.ok(!p.conflicts.some((c) => c.reason.includes(closedBare.id)), 'closed without scope is ignored');
  assert.ok(!p.conflicts.some((c) => c.reason.includes(archived.id)), 'archived agents are ignored');
});
