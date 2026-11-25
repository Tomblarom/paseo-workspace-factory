// Befunde #2, #4, #5 (TODO §11): checkout disambiguation with --checkout,
// case-insensitive ids with canonical display, extended steer titles.
// Compact fakes drive the real discovery and planner; CLI flag checks spawn
// the CLI with a temporary config (validation errors only, no daemon).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRepoInput, GitHubNotFound } from '../src/github.mjs';
import { STEER_TITLE, STEER_DIGIT_TITLE } from '../src/discovery.mjs';
import { resolveScope, ScopeConflict } from '../src/scope.mjs';
import { idempotencyKey } from '../src/planner.mjs';
import { createRunner } from '../src/factory.mjs';
import { LABEL, METADATA_KEY } from '../src/paseo.mjs';

// ---------------------------------------------------------------- fixtures

const FIRMWARE = 'Example-Owner/Example-Repo';
const FW_PARENT = 'Upstream-Owner/Upstream-Repo';

const CONFIG = {
  version: 1,
  github: { owner: 'Example-Owner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    sol: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
    muse: { provider: 'muse', model: 'muse-spark', thinking: null, mode: 'allowAll' },
  },
  steers: { slots: { A: 'sol', B: 'muse' }, prepare: ['A', 'B'], initialActive: 'A' },
  workers: { defaultProfile: 'muse' },
};

const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'full-access' }] },
  { provider: 'muse', enabled: true, status: 'ready', models: [{ id: 'muse-spark', thinkingOptions: [] }], modes: [{ id: 'allowAll' }] },
];

const api = (fullName, extra = {}) => {
  const [owner, name] = fullName.split('/');
  return {
    full_name: fullName, name, owner: { login: owner }, fork: false, archived: false, default_branch: 'main',
    clone_url: `https://github.com/${fullName}.git`, ssh_url: `git@github.com:${fullName}.git`, html_url: `https://github.com/${fullName}`, ...extra,
  };
};
const ref = (fullName) => ({ full_name: fullName, clone_url: `https://github.com/${fullName}.git`, ssh_url: `git@github.com:${fullName}.git` });

function makeWorld() {
  return {
    repos: {
      [FIRMWARE]: api(FIRMWARE, { fork: true, parent: ref(FW_PARENT), source: ref(FW_PARENT) }),
      [FW_PARENT]: api(FW_PARENT),
    },
    checkouts: {}, // path -> { remotes, branch }
    projects: [],
    workspaces: [],
    agents: [],
    providers: structuredClone(PROVIDERS),
    seq: 0,
  };
}

function fakeGh(world) {
  return (args) => {
    const path = args.find((a) => typeof a === 'string' && a.startsWith('repos/'));
    const full = path.slice('repos/'.length);
    const hit = Object.keys(world.repos).find((k) => k.toLowerCase() === full.toLowerCase());
    if (!hit) throw new GitHubNotFound(`HTTP 404: Not Found (${full})`);
    return JSON.stringify(world.repos[hit]);
  };
}

function fakeGit(world) {
  return (cwd, args) => {
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return world.checkouts[cwd]?.branch ?? 'main';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function worldScan(world) {
  return () => Object.entries(world.checkouts).map(([path, c]) => ({
    path,
    linkedWorktree: Boolean(c.linkedWorktree),
    remotes: { ...c.remotes },
    repos: Object.fromEntries(Object.entries(c.remotes).map(([n, u]) => {
      try {
        return [n, parseRepoInput(u).fullName.toLowerCase()];
      } catch {
        return [n, null];
      }
    })),
  }));
}

function addProject(world, path) {
  let project = world.projects.find((p) => p.projectRootPath === path);
  if (!project) {
    project = { projectId: `prj_${++world.seq}`, projectRootPath: path, projectDisplayName: path.split('/').at(-1) };
    world.projects.push(project);
  }
  return project;
}

function addWorkspace(world, { path, title, metadata = {}, kind = 'local_checkout' }) {
  const project = addProject(world, path);
  const workspace = { id: `wks_${String(++world.seq).padStart(16, '0')}`, projectId: project.projectId, workspaceDirectory: path, workspaceKind: kind, title, name: title, metadata: structuredClone(metadata) };
  world.workspaces.push(workspace);
  return workspace;
}

function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}

function runnerFor(world, config = CONFIG) {
  return createRunner({
    config,
    client: null,
    gh: fakeGh(world),
    git: fakeGit(world),
    readState: async () => structuredClone({ projects: world.projects, workspaces: world.workspaces, agents: world.agents, providers: world.providers }),
    scan: worldScan(world),
    inspectTarget: () => { throw new Error('unexpected clone target inspection'); },
    realpath: (p) => p,
  });
}

const discover = async (world, entry, config) => (await runnerFor(world, config).discoverAll([entry]))[0];
const plan = async (world, entries = [FIRMWARE], options = {}) => runnerFor(world, options.config).runPlans(entries, options);

// ---------------------------------------------------------------- #2 checkout disambiguation

const sameOrigin = (world, ...paths) => {
  for (const path of paths) world.checkouts[path] = { remotes: { origin: `https://github.com/${FIRMWARE}.git`, upstream: `https://github.com/${FW_PARENT}.git` } };
};

test('#2: the Paseo project checkout disambiguates several clones with one origin', async () => {
  const world = makeWorld();
  sameOrigin(world, '/p/x/one', '/p/y/two');
  addProject(world, '/p/y/two');
  const d = await discover(world, FIRMWARE);
  assert.deepEqual(d.checkoutIssues, []);
  assert.equal(d.checkout?.path, '/p/y/two');
});

test('#2: a main workspace still wins over the project checkout', async () => {
  const world = makeWorld();
  sameOrigin(world, '/p/x/one', '/p/y/two');
  addWorkspace(world, { path: '/p/x/one', title: 'Main' });
  addProject(world, '/p/y/two');
  const d = await discover(world, FIRMWARE);
  assert.equal(d.checkout?.path, '/p/x/one');
});

test('#2: the project checkout wins over the expected path', async () => {
  const world = makeWorld();
  sameOrigin(world, '/p/Example-Repo', '/p/y/two');
  addProject(world, '/p/y/two');
  const d = await discover(world, FIRMWARE);
  assert.equal(d.expectedPath, '/p/Example-Repo');
  assert.equal(d.checkout?.path, '/p/y/two');
});

test('#2: two project checkouts stay ambiguous and the message names direct enrollment', async () => {
  const world = makeWorld();
  sameOrigin(world, '/p/x/one', '/p/y/two');
  addProject(world, '/p/x/one');
  addProject(world, '/p/y/two');
  const d = await discover(world, FIRMWARE);
  assert.equal(d.checkout, null);
  assert.equal(d.checkoutIssues.length, 1);
  assert.match(d.checkoutIssues[0], /workspace:<id> or --local <path>/);
  const [p] = await plan(world, [FIRMWARE]);
  assert.equal(p.conflicts[0].key, 'checkout');
});

test('#2: a retired entry "checkout" is refused with a pointer to direct enrollment', async () => {
  const world = makeWorld();
  sameOrigin(world, '/p/x/one');
  await assert.rejects(discover(world, { repo: FIRMWARE, checkout: '/p/y/two' }), /was retired/);
});

// ---------------------------------------------------------------- #2 retired --checkout flag (CLI validation)

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

function runCli(t, args) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-checkout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(CONFIG));
  const argv = ['--config', join(dir, 'config.json'), ...args];
  try {
    const stdout = execFileSync('node', [CLI, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('#2: --help names the retired bulk-provisioning flags', (t) => {
  const out = runCli(t, ['--help']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Retired: --repos-file, --allow-fork, --checkout/);
});

test('#2: retired --checkout is rejected as an unknown option', (t) => {
  const out = runCli(t, ['plan', FIRMWARE, '--checkout', '/p/x']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /checkout/i);
});

test('#2: plan with two entries is rejected (single-workspace enrollment)', (t) => {
  const out = runCli(t, ['plan', 'Example-Owner/a', 'Example-Owner/b']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /exactly one workspace entry/);
});

// ---------------------------------------------------------------- #4 case-insensitive ids

let scopeSeq = 0;
const scopeState = ({ workspaces = [], agents = [] } = {}) => ({ projects: [], workspaces, agents, providers: [] });
const scopeWs = ({ id, dir, kind = 'local_checkout', scope }) => ({
  id: id ?? `wks_${String(++scopeSeq).padStart(16, '0')}`,
  projectId: 'prj_1',
  workspaceDirectory: dir,
  workspaceKind: kind,
  title: dir.split('/').at(-1),
  name: dir.split('/').at(-1),
  metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, ...(scope ? { scope } : {}) } },
});

test('#4: scope ids match case-insensitively and resolve to the stored form', () => {
  const gh = scopeWs({ id: 'wks_case000000000001', dir: '/p/demo', scope: { id: 'Example/demo', kind: 'github', locator: 'Example/demo' } });
  const dir = scopeWs({ id: 'wks_case000000000002', dir: '/p/Notes', scope: { id: 'Notes', kind: 'dir', locator: '/p/Notes' } });
  const s = scopeState({ workspaces: [gh, dir] });
  assert.equal(resolveScope('example/demo', s).workspaceId, gh.id);
  assert.equal(resolveScope('example/demo', s).id, 'Example/demo');
  assert.equal(resolveScope('EXAMPLE/DEMO', s).workspaceId, gh.id);
  assert.equal(resolveScope('notes', s).id, 'Notes');
  assert.equal(resolveScope('NOTES', s).workspaceId, dir.id);
});

test('#4: case-variant duplicate ids are a duplicate-id conflict', () => {
  const a = scopeWs({ id: 'wks_case000000000011', dir: '/p/a', scope: { id: 'Demo', kind: 'dir', locator: '/p/a' } });
  const b = scopeWs({ id: 'wks_case000000000012', dir: '/p/b', scope: { id: 'demo', kind: 'dir', locator: '/p/b' } });
  const s = scopeState({ workspaces: [a, b] });
  assert.throws(() => resolveScope('DEMO', s), (error) => error instanceof ScopeConflict && error.code === 'duplicate-id');
});

test('#4: paths and folder aliases stay case-sensitive', () => {
  const wt = scopeWs({ id: 'wks_case000000000021', dir: '/wt/feat', kind: 'worktree', scope: { id: 'feat', kind: 'workspace', locator: 'wks_case000000000021' } });
  const s = scopeState({ workspaces: [wt] });
  assert.equal(resolveScope('/WT/FEAT', s), null);
  assert.equal(resolveScope('local/FEAT', s), null);
  assert.equal(resolveScope('/wt/feat', s).workspaceId, wt.id);
});

test('#4: github discovery returns the canonical fullName for lowercase input', async () => {
  const world = makeWorld();
  sameOrigin(world, '/p/Example-Repo');
  const d = await discover(world, 'example-owner/example-repo');
  assert.equal(d.forkName, FIRMWARE);
  assert.equal(d.scope?.id, FIRMWARE);
  assert.equal(d.checkout?.path, '/p/Example-Repo');
});

function worktreeWorld({ origin, liveScopeId = null }) {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: { origin } };
  world.projects.push({ projectId: 'prj_1', projectRootPath: '/p/demo', projectDisplayName: 'demo' });
  world.workspaces.push({
    id: 'wks_wt00000000000001', projectId: 'prj_1', workspaceDirectory: '/wt/feat', workspaceKind: 'worktree',
    title: 'feat', name: 'feat', metadata: {},
  });
  if (liveScopeId) {
    world.projects.push({ projectId: 'prj_2', projectRootPath: '/p/other', projectDisplayName: 'other' });
    world.workspaces.push({
      id: 'wks_gh00000000000002', projectId: 'prj_2', workspaceDirectory: '/p/other', workspaceKind: 'local_checkout',
      title: 'other', name: 'other', metadata: { [METADATA_KEY]: { main: true, scope: { id: liveScopeId, kind: 'github', locator: liveScopeId } } },
    });
  }
  return world;
}

test('#4: worktree parent keeps the canonical remote spelling without a live scope', async () => {
  const world = worktreeWorld({ origin: 'https://github.com/Example-Owner/Example-Repo.git' });
  const d = await discover(world, { local: '/wt/feat' });
  assert.deepEqual(d.scope?.parent, { id: 'Example-Owner/Example-Repo', kind: 'github' });
});

test('#4: worktree parent prefers the live scope id on case mismatch', async () => {
  const world = worktreeWorld({ origin: 'https://github.com/example-owner/example-repo.git', liveScopeId: 'Example-Owner/Example-Repo' });
  const d = await discover(world, { local: '/wt/feat' });
  assert.deepEqual(d.scope?.parent, { id: 'Example-Owner/Example-Repo', kind: 'github' });
});

test('#4: wsf idempotency keys stay lowercase', () => {
  assert.equal(
    idempotencyKey('Example-Owner/Example-Repo', 'steer', 'A', 'g1', '0123456789'),
    'wsf:example-owner/example-repo:steer:A:g1:0123456789',
  );
});

// ---------------------------------------------------------------- #5 steer titles

test('#5: STEER_TITLE matches letters with suffixes, group 1 is the uppercase slot', () => {
  for (const [title, slot] of [
    ['Steer A', 'A'], ['Steer A [kn]', 'A'], ['Steer A (kn)', 'A'], ['Steer A · fp', 'A'],
    ['steer a', 'A'], ['STEER B', 'B'], ['Steer C - x', 'C'], ['Steer D: y', 'D'],
  ]) {
    assert.equal(STEER_TITLE.test(title), true, title);
    assert.equal(title.match(STEER_TITLE)[1], slot, title);
  }
});

test('#5: STEER_TITLE rejects digits, extra letters and bare words', () => {
  for (const title of [
    'Steer 3', 'Steer AB', 'Steer A2', 'Steer A foo', 'Steer', 'Steer A ·',
    'Steer A [kn', 'Steer A (kn))', 'Assistant', 'Steer A [k]ihl',
  ]) {
    assert.equal(STEER_TITLE.test(title), false, title);
    assert.equal(title.match(STEER_TITLE), null, title);
  }
});

test('#5: STEER_DIGIT_TITLE matches digits with the same suffix rules only', () => {
  for (const title of ['Steer 3', 'Steer 3 [x]', 'steer 30 · y']) assert.equal(STEER_DIGIT_TITLE.test(title), true, title);
  for (const title of ['Steer A', 'Steer 3x', 'Steer 3 foo', 'Steer']) assert.equal(STEER_DIGIT_TITLE.test(title), false, title);
});

function legacyWorld(title, extraAgents = []) {
  const world = makeWorld();
  world.checkouts['/p/Example-Repo'] = { remotes: { origin: `https://github.com/${FIRMWARE}.git`, upstream: `https://github.com/${FW_PARENT}.git` } };
  const ws = addWorkspace(world, { path: '/p/Example-Repo', title: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: FIRMWARE, kind: 'github', locator: FIRMWARE } } } });
  const agent = addAgent(world, { title, provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id });
  for (const fields of extraAgents) addAgent(world, { provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id, ...fields });
  return { world, ws, agent };
}

test('#5: suffixed and lowercase legacy titles adopt without renaming', async () => {
  for (const title of ['Steer A [kn]', 'steer a']) {
    const { world, agent } = legacyWorld(title);
    const [p] = await plan(world, [FIRMWARE]);
    assert.match(p.conflicts.find((c) => c.key === 'steer.A').reason, new RegExp(`--adopt A=${agent.id}`), title);
    const [adopted] = await plan(world, [FIRMWARE], { adopt: { '*': { A: agent.id } } });
    const op = adopted.ops.find((o) => o.key === 'steer.A');
    assert.equal(op.kind, 'paseo.agent.adopt', title);
    assert.deepEqual(Object.keys(op.params).sort(), ['agentId', 'labels'], `${title}: adoption only labels`);
    assert.equal(agent.title, title, `${title}: suffix/case kept`);
  }
});

test('#5: "Steer 3" is only a digit candidate, never auto-assigned', async () => {
  const { world, agent } = legacyWorld('Steer 3', [
    { title: 'Steer 4 [x]' },
    { title: 'Steer 5', labels: { [LABEL.role]: 'worker', [LABEL.scope]: FIRMWARE, [LABEL.owner]: 'A' } },
    { title: 'Steer 6', archivedAt: 'then' },
  ]);
  const other = addWorkspace(world, { path: '/p/Example-Repo', title: 'Task' });
  addAgent(world, { title: 'Steer 7', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: other.id });
  const d = await discover(world, FIRMWARE);
  assert.deepEqual(d.steers.legacy, []);
  assert.deepEqual(d.steers.digitCandidates.map((a) => a.title).sort(), ['Steer 3', 'Steer 4 [x]']);
  assert.ok(d.steers.digitCandidates.some((a) => a.id === agent.id));
  const [p] = await plan(world, [FIRMWARE]);
  assert.equal(p.ops.find((o) => o.key === 'steer.A').kind, 'paseo.agent.create');
  assert.equal(p.conflicts.some((c) => c.key === 'steer.A'), false);
});

// ------------------------------------------------- planner follow-up: digit notes + adopt

test('digit candidates get a plan note with the explicit --adopt form', async () => {
  const { world, agent } = legacyWorld('Steer 3');
  const [p] = await plan(world, [FIRMWARE]);
  const note = p.notes.find((n) => n.includes(agent.id));
  assert.ok(note, p.notes.join('\n'));
  assert.match(note, /"Steer 3"/);
  assert.match(note, /^Assign candidate /);
  assert.match(note, new RegExp(`--adopt <slot>=${agent.id}`));
});

test('digit candidate adopts into any slot via --adopt, parented needs --detach', async () => {
  const { world, agent } = legacyWorld('Steer 3');
  const [adopted] = await plan(world, [FIRMWARE], { adopt: { '*': { B: agent.id } } });
  assert.equal(adopted.ops.find((o) => o.key === 'steer.B').kind, 'paseo.agent.adopt');
  assert.equal(adopted.ops.find((o) => o.key === 'steer.B').params.agentId, agent.id);

  const parented = legacyWorld('Steer 9');
  parented.agent.labels = { 'paseo.parent-agent-id': 'agent-parent' };
  const [refused] = await plan(parented.world, [FIRMWARE], { adopt: { '*': { A: parented.agent.id } } });
  assert.match(refused.conflicts.find((c) => c.key === 'steer.A').reason, /--detach/);
  const [detached] = await plan(parented.world, [FIRMWARE], { adopt: { '*': { A: parented.agent.id } }, detach: true });
  assert.equal(detached.ops.find((o) => o.key === 'steer.A.detach').kind, 'agent.detach');
  assert.equal(detached.ops.find((o) => o.key === 'steer.A').kind, 'paseo.agent.adopt');
});

// --------------------------------------- planner follow-up: case-insensitive scope.id

test('scope.id clashes are case-insensitive against live scopes', async () => {
  const world = makeWorld();
  world.checkouts['/p/taken'] = { remotes: {} };
  world.checkouts['/p/other'] = { remotes: {} };
  world.workspaces.push({
    id: 'wks_taken00000000001', projectId: 'prj_1', workspaceDirectory: '/p/taken', workspaceKind: 'local_checkout',
    title: 'Main', name: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: 'Taken', kind: 'dir', locator: '/p/taken' } } },
  });
  const [p] = await runnerFor(world).runPlans([{ local: '/p/other', name: 'taken' }]);
  assert.equal(p.status, 'conflict');
  assert.match(p.conflicts.find((c) => c.key === 'scope.id').reason, /already used/);
});
