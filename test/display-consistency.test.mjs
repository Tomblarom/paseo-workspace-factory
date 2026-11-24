// Display consistency (Worker B): parent wording (#8), candidate status (#7),
// multi-repo titles (#6). Offline units; the plan-level title selection lives
// in test/scope-titles.test.mjs, the candidates shape in test/scopes-view.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PARENT_LABEL, describeParent, parentOf } from '../src/paseo.mjs';
import { formatScopeCandidates, scopeCandidates } from '../src/scopes-view.mjs';
import { multipleReposActive, planHash, scopeRepoKey } from '../src/planner.mjs';
import { validateConfig } from '../src/config.mjs';

// ------------------------------------------------------------------ #8

test('describeParent renders "parent <id>" and stays null without a parent', () => {
  assert.equal(describeParent({ labels: { [PARENT_LABEL]: 'agent-1' } }), 'parent agent-1');
  assert.equal(describeParent({ labels: { [PARENT_LABEL]: '  agent-1  ' } }), 'parent agent-1');
  assert.equal(describeParent({ labels: {} }), null);
  assert.equal(describeParent({ labels: { [PARENT_LABEL]: '  ' } }), null);
  assert.equal(describeParent(null), null);
  for (const agent of [{ labels: { [PARENT_LABEL]: 'x' } }, { labels: {} }, null]) {
    assert.equal(describeParent(agent) !== null, parentOf(agent) !== null, 'guard equivalence with parentOf');
  }
});

// --------------------------------------------------------------- #7 + #8

test('candidates output shows status and the describeParent wording (no drift vs plan hints)', () => {
  const child = {
    id: 'agent-2', workspaceId: 'wks_plain', archivedAt: null, title: 'Child',
    provider: 'codex', model: 'gpt-6.2-sol', status: 'working', labels: { [PARENT_LABEL]: 'agent-1' },
  };
  const state = {
    workspaces: [{ id: 'wks_plain', projectId: 'proj-1', title: 'Scratch', workspaceDirectory: '/tmp/scratch', metadata: {} }],
    agents: [child],
    projects: [{ projectId: 'proj-1', kind: 'git' }],
    providers: [],
  };
  const [row] = scopeCandidates(state);
  assert.equal(row.agents[0].status, 'working');
  assert.equal(row.agents[0].parentId, 'agent-1');
  const text = formatScopeCandidates([row]);
  assert.ok(text.includes('agent-2 "Child" (codex/gpt-6.2-sol, working)'), 'same agent core as plan candidate hints');
  assert.ok(text.includes(describeParent(child)), 'parent wording pinned to describeParent()');
});

// ------------------------------------------------------------------ #6

test('scopeRepoKey strips the @branch suffix of worktree scopes', () => {
  assert.equal(scopeRepoKey('example/web'), 'example/web');
  assert.equal(scopeRepoKey('example/web@feat'), 'example/web');
  assert.equal(scopeRepoKey('notes@feat'), 'notes');
  assert.equal(scopeRepoKey('demo'), 'demo');
  assert.equal(scopeRepoKey('@scope'), '@scope');
});

test('multipleReposActive compares live repo keys within the entry project', () => {
  const discovery = (projectWorkspaceIds, liveScopes) => ({ projectWorkspaceIds, liveScopes });
  assert.equal(multipleReposActive(discovery(
    ['w1', 'w2'],
    [{ id: 'example/web', workspaceId: 'w1' }, { id: 'example/other', workspaceId: 'w2' }],
  )), true);
  assert.equal(multipleReposActive(discovery(
    ['w1', 'w2'],
    [{ id: 'example/web', workspaceId: 'w1' }, { id: 'example/web@feat', workspaceId: 'w2' }],
  )), false, 'worktree counts as its parent repo');
  assert.equal(multipleReposActive(discovery(
    ['w1'],
    [{ id: 'example/web', workspaceId: 'w1' }, { id: 'example/other', workspaceId: 'w2' }],
  )), false, 'scopes outside the project are ignored');
  assert.equal(multipleReposActive(discovery(
    ['w1', 'w2'],
    [{ id: 'alice/web', workspaceId: 'w1' }, { id: 'bob/web', workspaceId: 'w2' }],
  )), true, 'same short name, different repos');
  assert.equal(multipleReposActive({}), false, 'legacy discovery without scope data');
  assert.equal(multipleReposActive(null), false);
});

const BASE_CONFIG = {
  version: 1,
  github: { owner: 'example', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: { sol: { provider: 'codex', model: 'gpt-6.2-sol' } },
  steers: { slots: { A: 'sol' }, prepare: ['A'], initialActive: 'A' },
};

test('workspaceTitleMultiRepo is optional, null-tolerant and non-empty when set', () => {
  assert.deepEqual(validateConfig(BASE_CONFIG), []);
  assert.deepEqual(validateConfig({ ...BASE_CONFIG, workspaceTitleMultiRepo: '{repo} · {subject}' }), []);
  assert.deepEqual(validateConfig({ ...BASE_CONFIG, workspaceTitleMultiRepo: null }), []);
  for (const bad of ['', '   ', 42, {}]) {
    assert.match(
      validateConfig({ ...BASE_CONFIG, workspaceTitleMultiRepo: bad }).join('\n'),
      /workspaceTitleMultiRepo must be a non-empty string/,
    );
  }
});

test('planHash covers workspaceTitleMultiRepo but keeps old hashes when unset', () => {
  const plans = [{ repo: 'example/web', status: 'complete', ops: [], conflicts: [] }];
  const unset = planHash(plans, BASE_CONFIG);
  assert.equal(planHash(plans, { ...BASE_CONFIG, workspaceTitleMultiRepo: null }), unset, 'null keeps the hash');
  assert.notEqual(planHash(plans, { ...BASE_CONFIG, workspaceTitleMultiRepo: '{repo} · {subject}' }), unset, 'setting it changes the hash');
  assert.notEqual(
    planHash(plans, { ...BASE_CONFIG, workspaceTitleMultiRepo: '{repo}!' }),
    planHash(plans, { ...BASE_CONFIG, workspaceTitleMultiRepo: '{repo}?' }),
    'changing it changes the hash',
  );
});
