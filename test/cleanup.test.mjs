// Cleanup report and plan tests: candidate rules, loss inventory, op planning
// and the destructive executors over fakes. No daemon, no filesystem, no git.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureRuntime } from '../src/runtime.mjs';

// Locked executors (scope.retire) take real workspace locks; keep them in a
// throwaway state dir instead of the production one (per-file processes).
configureRuntime({ runtime: { stateDir: mkdtempSync(join(tmpdir(), 'wsf-cleanup-')) } });
import { METADATA_KEY } from '../src/paseo.mjs';
import { attachProjectArchivedAgents, collectCleanupCandidates, formatCandidate, planCleanupOps, opConverged, createCleanupRunPlans, selectApplyRunPlans, SCRATCH_LABEL } from '../src/cleanup.mjs';
import { planHash } from '../src/planner.mjs';
import { normalizeEntry } from '../src/discovery.mjs';
import { applyPlans, createAuthorization, createExecutors, memoryProgress } from '../src/apply.mjs';

// ---------------------------------------------------------------- fakes

function fakeGit(behavior = {}) {
  return (cwd, args) => {
    const files = behavior[cwd] ?? {};
    if (args[0] === 'status') {
      if (files.missing) throw new Error(`not a repo: ${cwd}`);
      return [...(files.dirty ? [' M edited'] : []), ...(files.untracked ?? []).map((f) => `?? ${f}`), ...(files.ignored ?? []).map((f) => `!! ${f}`)].join('\n');
    }
    if (args[0] === 'symbolic-ref') {
      if (files.detached) throw new Error('exit 1');
      return 'refs/heads/main';
    }
    if (args[0] === 'rev-list') {
      if (files.ahead === undefined || files.ahead === null) throw new Error('no upstream');
      return String(files.ahead);
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

const project = (projectId, rootPath, projectKind = 'git') => ({ projectId, projectKey: `test-key-${projectId}`, projectRootPath: rootPath, projectDisplayName: rootPath, projectKind });
const workspace = (id, fields = {}) => ({ id, projectId: 'prj_1', workspaceDirectory: `/p/${id}`, workspaceKind: 'local_checkout', title: id, name: id, metadata: {}, ...fields });
const agent = (id, fields = {}) => ({ id, status: 'idle', archivedAt: null, labels: {}, workspaceId: 'wks_1', ...fields });
const byKind = (candidates, kind) => candidates.filter((c) => c.kind === kind);

// ---------------------------------------------------------------- rules

test('scratch: labelled agents and metadata flags mark the scope; orphans stay visible', () => {
  const state = {
    projects: [project('prj_1', '/p/demo')],
    workspaces: [
      workspace('wks_1', { metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } } }),
      workspace('wks_2', { metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 }, [SCRATCH_LABEL]: true } }),
      workspace('wks_3'),
    ],
    agents: [
      agent('agent-1', { workspaceId: 'wks_1', labels: { [SCRATCH_LABEL]: 'true' } }),
      agent('agent-2', { workspaceId: 'wks_1', labels: { [SCRATCH_LABEL]: 'true' }, archivedAt: 'archived' }),
      agent('agent-3', { workspaceId: 'wks_gone', labels: { [SCRATCH_LABEL]: 'true' } }),
    ],
  };
  const found = byKind(collectCleanupCandidates(state, { existsDir: () => true }), 'scratch');
  assert.deepEqual(found.map((c) => c.id).sort(), ['agent-3', 'wks_1', 'wks_2']);
  assert.match(found.find((c) => c.id === 'wks_1').detail, /2 scratch agent/);
  assert.match(found.find((c) => c.id === 'wks_2').detail, /marked at creation/);
  assert.equal(found.find((c) => c.id === 'wks_1').loss.agents, 1, 'only live agents count as loss');
  assert.match(found.find((c) => c.id === 'agent-3').action, /archive scratch agent/);
  for (const candidate of found) assert.ok(candidate.action.length > 0);
});

test('missing directory: only gone directories are reported', () => {
  const state = {
    projects: [project('prj_1', '/p/demo')],
    workspaces: [workspace('wks_1', { workspaceDirectory: '/p/gone' }), workspace('wks_2', { workspaceDirectory: '/p/here' }), workspace('wks_3', { workspaceDirectory: null })],
    agents: [],
  };
  const found = byKind(collectCleanupCandidates(state, { existsDir: (p) => p === '/p/here' }), 'missing-directory');
  assert.deepEqual(found.map((c) => c.id), ['wks_1']);
  assert.match(found[0].action, /no files at risk/);
});

test('empty projects are reported; projects with workspaces are not', () => {
  const state = {
    projects: [project('prj_empty', '/p/empty'), project('prj_full', '/p/full')],
    workspaces: [workspace('wks_1', { projectId: 'prj_full', workspaceDirectory: '/p/full' })],
    agents: [],
  };
  const found = byKind(collectCleanupCandidates(state, { existsDir: () => true }), 'empty-project');
  assert.deepEqual(found.map((c) => c.id), ['prj_empty']);
  assert.equal(found[0].loss.agents, 0);
  assert.match(found[0].action, /delete project/);
});

test('duplicate project paths yield one candidate per path', () => {
  const state = {
    projects: [project('prj_a', '/p/shared'), project('prj_b', '/p/shared'), project('prj_c', '/p/alone')],
    workspaces: [workspace('wks_1', { projectId: 'prj_a', workspaceDirectory: '/p/shared' })],
    agents: [agent('agent-1', { workspaceId: 'wks_1', status: 'running' })],
  };
  const found = byKind(collectCleanupCandidates(state, { existsDir: () => true }), 'duplicate-project-path');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, '/p/shared');
  assert.match(found[0].detail, /prj_a, prj_b/);
  assert.equal(found[0].loss.agents, 1);
  assert.equal(found[0].loss.running, 1);
  assert.match(found[0].action, /manual choice/);
});

test('non_git projects without a scope are reported; scoped and git ones are not', () => {
  const state = {
    projects: [project('prj_plain', '/p/plain', 'non_git'), project('prj_scoped', '/p/scoped', 'non_git'), project('prj_git', '/p/git', 'git')],
    workspaces: [
      workspace('wks_1', { projectId: 'prj_plain', workspaceDirectory: '/p/plain' }),
      workspace('wks_2', { projectId: 'prj_scoped', workspaceDirectory: '/p/scoped', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } } }),
      workspace('wks_3', { projectId: 'prj_git', workspaceDirectory: '/p/git' }),
    ],
    agents: [],
  };
  const found = byKind(collectCleanupCandidates(state, { existsDir: () => true }), 'non-git-no-scope');
  assert.deepEqual(found.map((c) => c.id), ['prj_plain']);
  assert.match(found[0].action, /adopt a workspace as scope/);
});

test('retired scopes are reported with their move target', () => {
  const state = {
    projects: [project('prj_1', '/p/demo')],
    workspaces: [
      workspace('wks_old', { metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 4, retired: true, movedTo: 'wks_new' } } }),
      workspace('wks_new', { metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } } }),
    ],
    agents: [],
  };
  const found = byKind(collectCleanupCandidates(state, { existsDir: () => true }), 'retired-scope');
  assert.deepEqual(found.map((c) => c.id), ['wks_old']);
  assert.match(found[0].detail, /wks_new/);
  assert.match(found[0].action, /archive retired scope/);
});

// ---------------------------------------------------------------- inventory

test('loss inventory counts live agents and reads git per directory', () => {
  const state = {
    projects: [project('prj_1', '/p/demo')],
    workspaces: [workspace('wks_1', { workspaceDirectory: '/p/gone' })],
    agents: [
      agent('agent-1', { workspaceId: 'wks_1', status: 'running' }),
      agent('agent-2', { workspaceId: 'wks_1', status: 'idle' }),
      agent('agent-3', { workspaceId: 'wks_1', archivedAt: 'archived' }),
    ],
  };
  const git = fakeGit({ '/p/gone': { dirty: true, untracked: ['a', 'b'], ignored: ['c'], detached: true, ahead: null } });
  const [candidate] = byKind(collectCleanupCandidates(state, { git, existsDir: () => false }), 'missing-directory');
  assert.equal(candidate.loss.agents, 2);
  assert.equal(candidate.loss.running, 1);
  assert.equal(candidate.loss.worktree, false);
  assert.deepEqual(candidate.loss.git, { dirty: true, untracked: 2, ignored: 1, detached: true, ahead: null, ignoredPaths: ['c'] });
  assert.match(formatCandidate(candidate), /git dirty, \+2 untracked, \+1 ignored \(c\), detached, upstream unknown/);
});

test('worktree and git details surface in the loss inventory', () => {
  const state = {
    projects: [project('prj_1', '/p/demo')],
    workspaces: [workspace('wks_1', { workspaceDirectory: '/p/gone', workspaceKind: 'worktree', project: { checkout: { isPaseoOwnedWorktree: true } } })],
    agents: [agent('agent-1', { workspaceId: 'wks_1', status: 'running' })],
  };
  const [candidate] = byKind(collectCleanupCandidates(state, { git: fakeGit({ '/p/gone': { dirty: true, ahead: 2 } }), existsDir: () => false }), 'missing-directory');
  assert.equal(candidate.loss.agents, 1);
  assert.equal(candidate.loss.running, 1);
  assert.equal(candidate.loss.worktree, true);
  assert.deepEqual(candidate.loss.git, { dirty: true, untracked: 0, ignored: 0, detached: false, ahead: 2, ignoredPaths: [] });
});

// ---------------------------------------------------------------- planning

const PLAN_CONFIG = {
  version: 1,
  github: { owner: 'example-owner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: { std: { provider: 'codex', model: 'gpt-6.2-sol', thinking: null, mode: null } },
  steers: { slots: { A: 'std' }, prepare: ['A'], initialActive: 'A' },
};

function planWorld() {
  return {
    projects: [project('prj_1', '/p/demo'), project('prj_empty', '/p/empty')],
    workspaces: [
      workspace('wks_scratch', { workspaceDirectory: '/p/scratch', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } } }),
      workspace('wks_gone', { workspaceDirectory: '/p/gone' }),
    ],
    agents: [
      agent('agent-1', { workspaceId: 'wks_scratch', labels: { [SCRATCH_LABEL]: 'true' } }),
      agent('agent-2', { workspaceId: 'wks_scratch' }),
    ],
    calls: [],
  };
}

test('planning maps candidates to ops; destructive ones become hints without the flag', () => {
  const state = planWorld();
  const full = planCleanupOps(state, { allowDestructive: true, existsDir: (p) => p !== '/p/gone' });
  assert.deepEqual(full.ops.map((op) => op.key).sort(), ['project.delete.prj_1', 'project.delete.prj_empty', 'workspace.archive.wks_gone', 'workspace.archive.wks_scratch']);
  const archive = full.ops.find((op) => op.key === 'workspace.archive.wks_scratch');
  assert.deepEqual(archive.params, { workspaceId: 'wks_scratch', agents: ['agent-1', 'agent-2'], allowIgnored: false });
  assert.ok(archive.loss && archive.summary.length > 0);
  assert.deepEqual(full.hints, []);

  const cautious = planCleanupOps(state, { existsDir: (p) => p !== '/p/gone' });
  assert.deepEqual(cautious.ops, []);
  assert.equal(cautious.hints.length, 4);
  assert.ok(cautious.hints.every((h) => h.reason.startsWith('needs --allow-destructive')));
});

test('planning chains project deletes only in full plans; --only filters strictly', () => {
  const state = {
    projects: [project('prj_1', '/p/demo')],
    workspaces: [workspace('wks_scratch', { workspaceDirectory: '/p/scratch' })],
    agents: [agent('agent-1', { workspaceId: 'wks_scratch', labels: { [SCRATCH_LABEL]: 'true' } })],
    calls: [],
  };
  const full = planCleanupOps(state, { allowDestructive: true, existsDir: () => true });
  assert.deepEqual(full.ops.map((op) => op.key), ['workspace.archive.wks_scratch', 'project.delete.prj_1']);

  const partial = planCleanupOps(state, { allowDestructive: true, only: ['wks_scratch'], existsDir: () => true });
  assert.deepEqual(partial.ops.map((op) => op.key), ['workspace.archive.wks_scratch']);

  assert.throws(() => planCleanupOps(state, { allowDestructive: true, only: ['wks_nope'], existsDir: () => true }), /Unknown cleanup candidate/);
  assert.throws(() => planCleanupOps(state, { allowDestructive: true, only: ['wks_scratch', 'wks_nope'], existsDir: () => true }), /wks_nope/);
});

test('duplicate paths, scopeless projects and orphan agents always stay hints', () => {
  const state = {
    projects: [project('prj_a', '/p/shared'), project('prj_b', '/p/shared'), project('prj_plain', '/p/plain', 'non_git')],
    workspaces: [
      workspace('wks_1', { projectId: 'prj_a', workspaceDirectory: '/p/shared' }),
      workspace('wks_3', { projectId: 'prj_b', workspaceDirectory: '/p/shared' }),
      workspace('wks_2', { projectId: 'prj_plain', workspaceDirectory: '/p/plain' }),
    ],
    agents: [agent('agent-9', { workspaceId: 'wks_gone', labels: { [SCRATCH_LABEL]: 'true' } })],
    calls: [],
  };
  const planned = planCleanupOps(state, { allowDestructive: true, existsDir: () => true });
  assert.deepEqual(planned.ops, []);
  assert.deepEqual(planned.hints.map((h) => h.id).sort(), ['/p/shared', 'agent-9', 'prj_plain']);
});

test('convergence: vanished targets are done, anything else is drift', () => {
  const state = planWorld();
  assert.equal(opConverged({ kind: 'workspace.archive', params: { workspaceId: 'wks_missing' } }, state), true);
  assert.equal(opConverged({ kind: 'workspace.archive', params: { workspaceId: 'wks_scratch' } }, state), false);
  assert.equal(opConverged({ kind: 'project.delete', params: { projectId: 'prj_gone' } }, state), true);
  assert.equal(opConverged({ kind: 'project.delete', params: { projectId: 'prj_1' } }, state), false);
  assert.equal(opConverged({ kind: 'scope.retire', params: { workspaceId: 'wks_scratch' } }, state), false);
  state.workspaces[0].metadata[METADATA_KEY] = { main: true, activeSteer: null, epoch: 2, retired: true };
  assert.equal(opConverged({ kind: 'scope.retire', params: { workspaceId: 'wks_scratch' } }, state), true);
  assert.equal(opConverged({ kind: 'paseo.clone', params: {} }, state), false);
});

test('ignored files surface with count and first paths', () => {
  const state = {
    projects: [project('prj_1', '/p/demo')],
    workspaces: [workspace('wks_1', { workspaceDirectory: '/p/gone' })],
    agents: [],
  };
  const git = fakeGit({ '/p/gone': { ignored: ['.env', 'node_modules/', 'secrets/key', '"my docs/"', 'a', 'b', 'overflow/'], ahead: 0 } });
  const [candidate] = byKind(collectCleanupCandidates(state, { git, existsDir: () => false }), 'missing-directory');
  assert.equal(candidate.loss.git.ignored, 7);
  assert.deepEqual(candidate.loss.git.ignoredPaths, ['.env', 'node_modules', 'secrets/key', 'my docs', 'a']);
  assert.match(formatCandidate(candidate), /\+7 ignored \(\.env, node_modules, secrets\/key, my docs, a, …\)/);
});

test('allowIgnored flows from planning into hashed params and rediscovery', async () => {
  const world = execWorld();
  const flagged = planCleanupOps(world, { allowDestructive: true, allowIgnored: true, only: ['wks_scratch'], existsDir: () => true, git: cleanGit });
  assert.equal(flagged.ops[0].params.allowIgnored, true);
  const authorization = cleanupAuthorization(flagged.ops, { allowDestructive: true, allowIgnored: true, only: ['wks_scratch'] });
  const [fresh] = await createCleanupRunPlans(authorization, { client: fakeExecClient(world), git: cleanGit, existsDir: () => true })();
  assert.equal(fresh.ops[0].params.allowIgnored, true);
  assert.equal(planHash([fresh], PLAN_CONFIG), authorization.hash);
});

test('archive refuses non-allowlisted ignored files unless explicitly allowed', async () => {
  const run = (ignored, params) => {
    const world = execWorld();
    return executorsFor(world, fakeGit({ '/p/wt': { ahead: 0, ignored } }))({ key: 'x', kind: 'workspace.archive', params: { workspaceId: 'wks_wt', agents: [], ...params } }, PLAN_CONFIG);
  };
  const buildOnly = await run(['node_modules/', 'dist/', 'target/x', '__pycache__/', '.venv/', 'build/out.js'], {});
  assert.equal(buildOnly.archived, true);
  await assert.rejects(run(['.env', 'node_modules/'], {}), /ignored files would be deleted \(\.env\)/);
  const allowed = await run(['.env'], { allowIgnored: true });
  assert.equal(allowed.archived, true);
  await assert.rejects(run(['pkg/dist/out.js'], {}), /pkg\/dist\/out\.js/);
  await assert.rejects(run(['"weird name/"'], {}), /weird name/);
});

test('one compact line per candidate; git stays silent without a git function', () => {
  const candidate = {
    kind: 'scratch', id: 'wks_1', title: 'WSF integration x', path: '/p/x', detail: 'scratch scope',
    action: 'archive scratch workspace and its agents',
    loss: { agents: 2, running: 1, worktree: false, git: { dirty: false, untracked: 0, ignored: 0, detached: false, ahead: 0 } },
  };
  const line = formatCandidate(candidate);
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /scratch wks_1 "WSF integration x" \/p\/x/);
  assert.match(line, /agents 2 \(1 running\)/);
  assert.match(line, /git clean, up to date/);
  assert.match(line, /→ archive scratch workspace/);

  const state = { projects: [], workspaces: [workspace('wks_1', { workspaceDirectory: '/p/gone' })], agents: [] };
  const [missing] = byKind(collectCleanupCandidates(state, { existsDir: () => false }), 'missing-directory');
  assert.equal(missing.loss.git, null);
  assert.match(formatCandidate(missing), /git n\/a/);
});

// ---------------------------------------------------------------- executors

function execWorld() {
  return {
    projects: [project('prj_1', '/p/demo'), project('prj_empty', '/p/empty')],
    workspaces: [
      workspace('wks_scratch', { workspaceDirectory: '/p/scratch', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 2 } } }),
      workspace('wks_wt', { workspaceDirectory: '/p/wt', workspaceKind: 'worktree', project: { checkout: { isPaseoOwnedWorktree: true } } }),
    ],
    agents: [
      agent('agent-1', { workspaceId: 'wks_scratch', labels: { [SCRATCH_LABEL]: 'true' } }),
      agent('agent-2', { workspaceId: 'wks_scratch' }),
    ],
    providers: [],
    calls: [],
  };
}

function fakeExecClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  const page = (entries) => async () => ({ entries: structuredClone(entries()), pageInfo: { hasMore: false } });
  return {
    projects: { list: async () => ({ projects: structuredClone(world.projects) }) },
    providers: { snapshot: async () => ({ entries: structuredClone(world.providers ?? []) }) },
    workspaces: {
      list: page(() => world.workspaces),
      ref: (id) => ({
        refresh: async () => structuredClone(findWs(id)),
        setMetadata: async (patch) => {
          world.calls.push(['workspace.setMetadata', id, patch]);
          for (const [key, value] of Object.entries(structuredClone(patch))) {
            if (value === null) delete findWs(id).metadata[key];
            else findWs(id).metadata[key] = value;
          }
        },
      }),
      archive: async (id) => {
        world.calls.push(['workspace.archive', id]);
        if (world.hooks?.injectAtArchive) world.agents.push({ status: 'idle', archivedAt: null, labels: {}, ...world.hooks.injectAtArchive });
        world.workspaces = world.workspaces.filter((w) => w.id !== id);
        for (const a of world.agents) if (a.workspaceId === id) a.archivedAt = 'archived';
        return { requestId: 'r', workspaceId: id, archivedAt: 'archived', error: null };
      },
    },
    agents: {
      list: async (opts = {}) => {
        const keys = opts.filter?.projectKeys;
        const withArchived = opts.filter?.includeArchived === true;
        const keyOf = (a) => {
          if (a.projectId) return world.projects.find((p) => p.projectId === a.projectId)?.projectKey;
          return world.projects.find((p) => p.projectId === findWs(a.workspaceId)?.projectId)?.projectKey;
        };
        const agents = world.agents
          .filter((a) => (withArchived || !a.archivedAt))
          .filter((a) => (!keys || keys.includes(keyOf(a))));
        return { entries: structuredClone(agents.map((a) => ({ agent: a }))), pageInfo: { hasMore: false } };
      },
      ref: (id) => ({ refresh: async () => ({ agent: structuredClone(findAgent(id)) }) }),
    },
  };
}

function fakeExecPaseoCli(world) {
  return (args) => {
    world.calls.push(['paseo', ...args]);
    if (args[0] === 'project' && args[1] === 'delete') {
      world.projects = world.projects.filter((p) => p.projectId !== args[2]);
      world.workspaces = world.workspaces.filter((w) => w.projectId !== args[2]);
      return { deleted: args[2] };
    }
    throw new Error(`unexpected paseo ${args.join(' ')}`);
  };
}

const cleanGit = fakeGit({ '/p/scratch': { ahead: 0 }, '/p/wt': { ahead: 0 } });
const executorsFor = (world, git = cleanGit) => createExecutors({ client: fakeExecClient(world), git, paseoCli: fakeExecPaseoCli(world) });

test('archive executes on a clean idle workspace and verifies agent archival', async () => {
  const world = execWorld();
  const result = await executorsFor(world)({ key: 'workspace.archive.wks_scratch', kind: 'workspace.archive', params: { workspaceId: 'wks_scratch', agents: ['agent-1', 'agent-2'] } }, PLAN_CONFIG);
  assert.deepEqual(result, { workspaceId: 'wks_scratch', archived: true });
  assert.ok(!world.workspaces.some((w) => w.id === 'wks_scratch'));
  assert.ok(world.agents.every((a) => a.archivedAt));
});

test('archive refuses running agents, agent drift, dirty worktrees and missing targets', async () => {
  const run = (world, params, git) => executorsFor(world, git)({ key: 'workspace.archive.x', kind: 'workspace.archive', params }, PLAN_CONFIG);
  const busy = execWorld();
  busy.agents[0].status = 'running';
  await assert.rejects(run(busy, { workspaceId: 'wks_scratch', agents: ['agent-1', 'agent-2'] }), /never archived/);

  const added = execWorld();
  added.agents.push(agent('agent-9', { workspaceId: 'wks_scratch' }));
  await assert.rejects(run(added, { workspaceId: 'wks_scratch', agents: ['agent-1', 'agent-2'] }), /added: agent-9/);

  const gone = execWorld();
  gone.agents[0].archivedAt = 'archived';
  await assert.rejects(run(gone, { workspaceId: 'wks_scratch', agents: ['agent-1', 'agent-2'] }), /gone: agent-1/);

  await assert.rejects(run(execWorld(), { workspaceId: 'wks_missing', agents: [] }), /missing; refusing/);
  await assert.rejects(run(execWorld(), { workspaceId: 'wks_scratch' }), /planned agent list/);

  const dirty = { '/p/wt': { dirty: true, ahead: 0 } };
  await assert.rejects(run(execWorld(), { workspaceId: 'wks_wt', agents: [] }, fakeGit(dirty)), /uncommitted/);
  await assert.rejects(run(execWorld(), { workspaceId: 'wks_wt', agents: [] }, fakeGit({ '/p/wt': { ahead: 2 } })), /unpushed/);
  await assert.rejects(run(execWorld(), { workspaceId: 'wks_wt', agents: [] }, fakeGit({ '/p/wt': { ahead: null } })), /no upstream/);
  await assert.rejects(run(execWorld(), { workspaceId: 'wks_wt', agents: [] }, fakeGit({ '/p/wt': { detached: true, ahead: 0 } })), /detached/);

  const nonWorktree = execWorld();
  const ok = await run(nonWorktree, { workspaceId: 'wks_scratch', agents: ['agent-1', 'agent-2'] }, fakeGit({}));
  assert.equal(ok.archived, true);
});

test('project delete executes only on empty projects', async () => {
  const world = execWorld();
  const execute = executorsFor(world);
  const result = await execute({ key: 'project.delete.prj_empty', kind: 'project.delete', params: { projectId: 'prj_empty' } }, PLAN_CONFIG);
  assert.deepEqual(result, { projectId: 'prj_empty', deleted: true });
  assert.ok(!world.projects.some((p) => p.projectId === 'prj_empty'));

  await assert.rejects(execute({ key: 'x', kind: 'project.delete', params: { projectId: 'prj_1' } }, PLAN_CONFIG), /not empty.*wks_scratch, wks_wt/);
  await assert.rejects(execute({ key: 'x', kind: 'project.delete', params: { projectId: 'prj_gone' } }, PLAN_CONFIG), /missing; refusing/);
});

test('scope retire clears the active steer, bumps the epoch and keeps agents', async () => {
  const world = execWorld();
  const execute = executorsFor(world);
  const result = await execute({ key: 'scope.retire.wks_scratch', kind: 'scope.retire', params: { workspaceId: 'wks_scratch', epoch: 2 } }, PLAN_CONFIG);
  assert.equal(result.retired, true);
  assert.equal(result.epoch, 3);
  const meta = world.workspaces.find((w) => w.id === 'wks_scratch').metadata[METADATA_KEY];
  assert.equal(meta.retired, true);
  assert.equal(meta.activeSteer, null);
  assert.equal(meta.previousSteer, 'A');
  assert.ok(meta.retiredAt);
  assert.ok(world.agents.every((a) => !a.archivedAt));

  const again = await execute({ key: 'scope.retire.wks_scratch', kind: 'scope.retire', params: { workspaceId: 'wks_scratch', epoch: 3 } }, PLAN_CONFIG);
  assert.equal(again.already, true);

  await assert.rejects(execute({ key: 'x', kind: 'scope.retire', params: { workspaceId: 'wks_scratch', epoch: 2 } }, PLAN_CONFIG), /Scope state changed/);
  await assert.rejects(execute({ key: 'x', kind: 'scope.retire', params: { workspaceId: 'wks_wt', epoch: 1 } }, PLAN_CONFIG), /no factory state/);
});

test('two simultaneous retires serialize on the workspace lock; exactly one wins', async () => {
  const world = execWorld();
  const execute = executorsFor(world);
  const op = { key: 'scope.retire.wks_scratch', kind: 'scope.retire', params: { workspaceId: 'wks_scratch', epoch: 2 } };
  const results = await Promise.allSettled([execute(op, PLAN_CONFIG), execute(op, PLAN_CONFIG)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /Scope state changed|held by another process/);
  assert.equal(world.workspaces.find((w) => w.id === 'wks_scratch').metadata[METADATA_KEY].epoch, 3);
});

// ---------------------------------------------------------------- apply loop

function cleanupAuthorization(ops, { allowDestructive = true, allowIgnored = false, only = null } = {}) {
  const plans = [{ repo: 'cleanup', input: 'cleanup', status: 'pending', ops, conflicts: [], notes: [], observed: {} }];
  return { ...createAuthorization(plans, PLAN_CONFIG, { entries: [{ cleanup: { allowDestructive, allowIgnored, only } }] }), kind: 'cleanup' };
}

test('cleanup ops flow through the hash-confirmed apply loop', async () => {
  const world = execWorld();
  const { ops } = planCleanupOps(world, { allowDestructive: true, existsDir: () => true, git: cleanGit });
  assert.deepEqual(ops.map((op) => op.key), ['workspace.archive.wks_scratch', 'project.delete.prj_empty']);
  const authorization = cleanupAuthorization(ops);
  const outcome = await applyPlans({
    authorization, config: PLAN_CONFIG, confirm: authorization.hash, progress: memoryProgress(),
    runPlans: createCleanupRunPlans(authorization, { client: fakeExecClient(world), git: cleanGit, existsDir: () => true }),
    execute: executorsFor(world),
  });
  assert.equal(outcome.report[0].status, 'complete');
  assert.deepEqual(outcome.report[0].executed.map((e) => e.key), ['workspace.archive.wks_scratch', 'project.delete.prj_empty']);
  assert.ok(!world.workspaces.some((w) => w.id === 'wks_scratch'));
  assert.ok(!world.projects.some((p) => p.projectId === 'prj_empty'));
  assert.ok(world.workspaces.some((w) => w.id === 'wks_wt'), 'untargeted workspace untouched');
});

test('mid-run drift stops loudly instead of skipping the op', async () => {
  const world = execWorld();
  const { ops } = planCleanupOps(world, { allowDestructive: true, only: ['wks_scratch'], existsDir: () => true, git: cleanGit });
  const authorization = cleanupAuthorization(ops, { allowDestructive: true, only: ['wks_scratch'] });
  const inner = createCleanupRunPlans(authorization, { client: fakeExecClient(world), git: cleanGit, existsDir: () => true });
  let calls = 0;
  const outcome = await applyPlans({
    authorization, config: PLAN_CONFIG, confirm: authorization.hash, progress: memoryProgress(),
    runPlans: async (...args) => {
      calls += 1;
      if (calls === 2) world.agents.find((a) => a.id === 'agent-1').labels = {};
      return inner(...args);
    },
    execute: executorsFor(world),
  }).catch((error) => error);
  assert.match(outcome.message ?? outcome.report?.[0]?.error ?? '', /Conflict appeared during apply.*cleanup drift/s);
  assert.ok(world.workspaces.some((w) => w.id === 'wks_scratch'), 'nothing archived after drift');
});

test('dispatch routes by plan kind and refuses mixed authorizations', async () => {
  const world = execWorld();
  const { ops } = planCleanupOps(world, { allowDestructive: true, only: ['wks_scratch'], existsDir: () => true, git: cleanGit });
  const cleanupAuth = cleanupAuthorization(ops, { allowDestructive: true, only: ['wks_scratch'] });
  const repoRunner = async () => { throw new Error('repo runner must not run'); };
  const selected = selectApplyRunPlans(cleanupAuth, { repoRunPlans: repoRunner, client: fakeExecClient(world), git: cleanGit, existsDir: () => true });
  assert.notEqual(selected, repoRunner);
  const [fresh] = await selected();
  assert.deepEqual(fresh.ops.map((op) => op.key), ops.map((op) => op.key));

  const repoAuth = createAuthorization([{ repo: 'example-owner/example-repo', input: 'x', status: 'pending', ops: [], conflicts: [], notes: [], observed: {} }], PLAN_CONFIG, { entries: ['example-owner/example-repo'] });
  assert.equal(selectApplyRunPlans(repoAuth, { repoRunPlans: repoRunner }), repoRunner);
  assert.equal(selectApplyRunPlans({ ...repoAuth, kind: undefined }, { repoRunPlans: repoRunner }), repoRunner);

  const mixed = createAuthorization([{ repo: 'example-owner/example-repo', input: 'x', status: 'pending', ops, conflicts: [], notes: [], observed: {} }], PLAN_CONFIG, { entries: ['example-owner/example-repo'] });
  assert.throws(() => selectApplyRunPlans(mixed, { repoRunPlans: repoRunner }), /mixes a repository plan with cleanup ops/);
});

test('cross-runner execution is impossible in either direction', async () => {
  const world = execWorld();
  const { ops } = planCleanupOps(world, { allowDestructive: true, existsDir: () => true, git: cleanGit });
  const cleanupAuth = cleanupAuthorization(ops);
  assert.throws(() => normalizeEntry(cleanupAuth.entries[0], PLAN_CONFIG), /needs "repo"/);
  const repoAuth = createAuthorization([{ repo: 'example-owner/example-repo', input: 'x', status: 'pending', ops: [], conflicts: [], notes: [], observed: {} }], PLAN_CONFIG, { entries: ['example-owner/example-repo'] });
  assert.throws(() => createCleanupRunPlans(repoAuth, { client: fakeExecClient(world) }), /Not a cleanup authorization/);
});

test('newly appeared unauthorized ops are never executed', async () => {
  const world = execWorld();
  const { ops } = planCleanupOps(world, { allowDestructive: true, existsDir: () => true, git: cleanGit });
  assert.deepEqual(ops.map((op) => op.key), ['workspace.archive.wks_scratch', 'project.delete.prj_empty']);
  const authorization = cleanupAuthorization(ops);
  const inner = createCleanupRunPlans(authorization, { client: fakeExecClient(world), git: cleanGit, existsDir: () => true });
  let calls = 0;
  const outcome = await applyPlans({
    authorization, config: PLAN_CONFIG, confirm: authorization.hash, progress: memoryProgress(),
    runPlans: async (...args) => {
      calls += 1;
      if (calls === 2) {
        world.workspaces.push({ id: 'wks_new', projectId: 'prj_1', workspaceDirectory: '/p/new', workspaceKind: 'local_checkout', title: 'new', name: 'new', metadata: {} });
        world.agents.push({ id: 'agent-9', status: 'idle', archivedAt: null, labels: { [SCRATCH_LABEL]: 'true' }, workspaceId: 'wks_new' });
      }
      return inner(...args);
    },
    execute: executorsFor(world),
  });
  assert.equal(outcome.report[0].status, 'failed');
  assert.match(outcome.report[0].error, /not part of the confirmed plan/);
  assert.ok(!world.workspaces.some((w) => w.id === 'wks_scratch'), 'authorized archive ran');
  assert.ok(world.workspaces.some((w) => w.id === 'wks_new'), 'unauthorized newcomer untouched');
  assert.ok(!world.agents.find((a) => a.id === 'agent-9').archivedAt);
});

test('archived members surface in inventory, summary and plan baseline', async () => {
  const world = execWorld();
  world.projects.push(project('prj_old', '/p/old'));
  world.agents.push(
    { id: 'agent-old', status: 'idle', archivedAt: 'archived', labels: {}, workspaceId: 'wks_vanished', title: 'Old worker', projectId: 'prj_old' },
    { id: 'agent-live', status: 'idle', archivedAt: null, labels: {}, workspaceId: 'wks_vanished', title: 'Live stray', projectId: 'prj_old' },
  );
  const enriched = await attachProjectArchivedAgents(world, fakeExecClient(world));
  assert.deepEqual(enriched.projectArchivedAgents.prj_old, [{ id: 'agent-old', title: 'Old worker' }]);
  assert.deepEqual(enriched.projectArchivedAgents.prj_1, []);

  const planned = planCleanupOps(enriched, { allowDestructive: true, existsDir: () => true, git: cleanGit });
  const op = planned.ops.find((o) => o.key === 'project.delete.prj_old');
  assert.ok(op);
  assert.deepEqual(op.params.archivedAgents, ['agent-old']);
  assert.match(op.summary, /\(irreversible: 1 archived agent vanishes permanently\)/);
  assert.equal(op.loss.archivedAgents.count, 1);
  const line = planned.candidates.find((c) => c.id === 'prj_old');
  assert.match(line ? formatCandidate(line) : '', /1 archived agent \(Old worker\)/);

  const plain = planned.ops.find((o) => o.key === 'project.delete.prj_empty');
  assert.match(plain.summary, /\(irreversible\)/);
  assert.ok(!plain.summary.includes('vanish'));
});

test('delete refuses archived drift and missing project keys', async () => {
  const world = execWorld();
  world.projects.push(project('prj_old', '/p/old'));
  world.agents.push({ id: 'agent-old', status: 'idle', archivedAt: 'archived', labels: {}, workspaceId: 'wks_vanished', title: 'Old', projectId: 'prj_old' });
  const execute = executorsFor(world);
  const op = (params) => ({ key: 'x', kind: 'project.delete', params });

  const ok = await execute(op({ projectId: 'prj_old', archivedAgents: ['agent-old'] }), PLAN_CONFIG);
  assert.equal(ok.deleted, true);

  const drifted = execWorld();
  drifted.projects.push(project('prj_old', '/p/old'));
  drifted.agents.push({ id: 'agent-old', status: 'idle', archivedAt: 'archived', labels: {}, workspaceId: 'wks_vanished', title: 'Old', projectId: 'prj_old' });
  const executeDrifted = executorsFor(drifted);
  await assert.rejects(executeDrifted(op({ projectId: 'prj_old', archivedAgents: [] }), PLAN_CONFIG), /archived members changed since plan \(added: agent-old/);
  drifted.agents.find((a) => a.id === 'agent-old').archivedAt = null;
  await assert.rejects(executeDrifted(op({ projectId: 'prj_old', archivedAgents: ['agent-old'] }), PLAN_CONFIG), /gone: agent-old/);

  const keyless = execWorld();
  keyless.projects.push({ projectId: 'prj_nokey', projectRootPath: '/p/nokey', projectDisplayName: 'n', projectKind: 'git' });
  await assert.rejects(executorsFor(keyless)(op({ projectId: 'prj_nokey', archivedAgents: [] }), PLAN_CONFIG), /without a project key/);
});

test('archive reports co-archived unplanned agents loudly', async () => {
  const world = execWorld();
  world.agents.push(agent('agent-pre', { workspaceId: 'wks_scratch', archivedAt: 'archived' }));
  world.hooks = { injectAtArchive: { id: 'agent-race', workspaceId: 'wks_scratch' } };
  await assert.rejects(
    executorsFor(world)({ key: 'x', kind: 'workspace.archive', params: { workspaceId: 'wks_scratch', agents: ['agent-1', 'agent-2'] } }, PLAN_CONFIG),
    /archived unplanned agent\(s\) agent-race/,
  );
});

test('missing-directory worktrees stay manual hints, never ops', () => {
  const state = {
    projects: [project('prj_1', '/p/demo')],
    workspaces: [
      workspace('wks_wt', { workspaceDirectory: '/p/gone', workspaceKind: 'worktree', project: { checkout: { isPaseoOwnedWorktree: true } } }),
      workspace('wks_plain', { workspaceDirectory: '/p/gone2' }),
    ],
    agents: [],
  };
  const planned = planCleanupOps(state, { allowDestructive: true, existsDir: () => false });
  assert.deepEqual(planned.ops.map((op) => op.key), ['workspace.archive.wks_plain']);
  const hint = planned.hints.find((h) => h.id === 'wks_wt');
  assert.ok(hint);
  assert.match(hint.reason, /^manual:/);
});

test('snapshot fallback attributes archived agents of live workspaces', () => {
  const world = execWorld();
  world.agents.push(agent('agent-arch', { workspaceId: 'wks_scratch', archivedAt: 'archived' }));
  world.agents.push(agent('agent-wt', { workspaceId: 'wks_wt', labels: { [SCRATCH_LABEL]: 'true' } }));
  const full = planCleanupOps(world, { allowDestructive: true, existsDir: () => true, git: cleanGit });
  const chained = full.ops.find((o) => o.key === 'project.delete.prj_1');
  assert.ok(chained);
  assert.deepEqual(chained.params.archivedAgents, ['agent-arch']);
});

test('rediscovery validates authorizations and stays silent on convergence', async () => {
  const world = execWorld();
  const { ops } = planCleanupOps(world, { allowDestructive: true, existsDir: () => true, git: cleanGit });
  const authorization = cleanupAuthorization(ops);
  assert.throws(() => createCleanupRunPlans({ ...authorization, entries: ['local/demo'] }, { client: fakeExecClient(world) }), /Not a cleanup authorization/);

  const runPlans = createCleanupRunPlans(authorization, { client: fakeExecClient(world), git: cleanGit, existsDir: () => true });
  const [fresh] = await runPlans();
  assert.equal(fresh.status, 'pending');
  assert.equal(planHash([fresh], PLAN_CONFIG), authorization.hash);

  world.workspaces = world.workspaces.filter((w) => w.id !== 'wks_scratch');
  world.projects = world.projects.filter((p) => p.projectId !== 'prj_empty');
  const [converged] = await runPlans();
  assert.equal(converged.status, 'complete');
  assert.deepEqual(converged.conflicts, []);
});
