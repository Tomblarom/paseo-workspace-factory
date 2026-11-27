// Cleanup report tests: candidate rules, loss inventory and formatting.
// The report is read-only; every action names the native Paseo command that
// performs it. Fakes only; no daemon, no filesystem, no git.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { METADATA_KEY } from '../plugin/server/core/paseo.mjs';
import { collectCleanupCandidates, formatCandidate, SCRATCH_LABEL } from '../plugin/server/core/cleanup.mjs';
import { createExecutors } from '../plugin/server/core/apply.mjs';

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
  assert.match(found.find((c) => c.id === 'wks_1').detail, /1 scratch agent/);
  assert.match(found.find((c) => c.id === 'wks_2').detail, /marked at creation/);
  assert.equal(found.find((c) => c.id === 'wks_1').loss.agents, 1, 'only live agents count as loss');
  assert.match(found.find((c) => c.id === 'agent-3').action, /paseo archive <agent-id>/);
  assert.match(found.find((c) => c.id === 'wks_1').action, /paseo workspace archive <workspace-id>/);
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
  assert.match(found[0].action, /paseo workspace archive/);
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
  assert.match(found[0].action, /paseo project delete <project-id>/);
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
  assert.match(found[0].action, /paseo project delete/);
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
  assert.match(found[0].action, /paseo workspace archive/);
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

test('one compact line per candidate; git stays silent without a git function', () => {
  const candidate = {
    kind: 'scratch', id: 'wks_1', title: 'WSF integration x', path: '/p/x', detail: 'scratch scope',
    action: 'archive the scratch workspace natively (`paseo workspace archive <workspace-id>`)',
    loss: { agents: 2, running: 1, worktree: false, git: { dirty: false, untracked: 0, ignored: 0, detached: false, ahead: 0 } },
  };
  const line = formatCandidate(candidate);
  assert.equal(line.split('\n').length, 1);
  assert.match(line, /scratch wks_1 "WSF integration x" \/p\/x/);
  assert.match(line, /agents 2 \(1 running\)/);
  assert.match(line, /git clean, up to date/);
  assert.match(line, /→ archive the scratch workspace/);

  const state = { projects: [], workspaces: [workspace('wks_1', { workspaceDirectory: '/p/gone' })], agents: [] };
  const [missing] = byKind(collectCleanupCandidates(state, { existsDir: () => false }), 'missing-directory');
  assert.equal(missing.loss.git, null);
  assert.match(formatCandidate(missing), /git n\/a/);
});

test('cleanup ignores archived agents of live workspaces', () => {
  const state = {
    projects: [project('prj_plain', '/p/plain', 'non_git')],
    workspaces: [workspace('wks_1', { projectId: 'prj_plain', workspaceDirectory: '/p/plain' })],
    agents: [agent('agent-arch', { workspaceId: 'wks_1', archivedAt: 'archived' })],
  };
  const [candidate] = byKind(collectCleanupCandidates(state, { existsDir: () => true }), 'non-git-no-scope');
  assert.equal(candidate.loss.agents, 0);
  assert.doesNotMatch(formatCandidate(candidate), /agent-arch/);
});

test('removed destructive op kinds fail closed with no executor', async () => {
  const execute = createExecutors({});
  await assert.rejects(execute({ key: 'x', kind: 'workspace.archive', params: {} }, {}), /No executor for workspace\.archive/);
  await assert.rejects(execute({ key: 'x', kind: 'project.delete', params: {} }, {}), /No executor for project\.delete/);
});
