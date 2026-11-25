// Display consistency (Worker B): parent wording (#8), candidate status (#7).
// Offline units; the candidates shape lives in test/scopes-view.test.mjs.
// (K13 retired the multi-repo title helpers: scopeRepoKey,
// multipleReposActive, renderWorkspaceTitle, isFactoryHandleTitle.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { PARENT_LABEL, describeParent, parentOf } from '../plugin/server/core/paseo.mjs';
import { formatScopeCandidates, scopeCandidates } from '../plugin/server/core/scopes-view.mjs';
import { planHash } from '../plugin/server/core/planner.mjs';
import { validateConfig } from '../plugin/server/core/config.mjs';

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

// ------------------------------------------------------------------ #6 (K13)

const BASE_CONFIG = {
  version: 1,
  github: { owner: 'example' },
  checkoutRoot: '/p',
  profiles: { sol: { provider: 'codex', model: 'gpt-6.2-sol' } },
  steers: { slots: { A: 'sol' }, prepare: ['A'], initialActive: 'A' },
};

test('retired K13 knobs are optional: old configs load, new configs omit them', () => {
  assert.deepEqual(validateConfig(BASE_CONFIG), []);
  const legacy = {
    ...BASE_CONFIG,
    github: { owner: 'example', cloneProtocol: 'https', upstreamRemote: 'upstream' },
    workspaceTitle: 'Main',
    workspaceTitleMultiRepo: '{repo} · {subject}',
  };
  assert.deepEqual(validateConfig(legacy), []);
  assert.deepEqual(validateConfig({ ...BASE_CONFIG, workspaceTitleMultiRepo: null }), []);
  for (const bad of ['', '   ', 42, {}]) {
    assert.match(
      validateConfig({ ...BASE_CONFIG, workspaceTitleMultiRepo: bad }).join('\n'),
      /workspaceTitleMultiRepo must be a non-empty string/,
    );
  }
});

test('planHash ignores the retired title/clone knobs', () => {
  const plans = [{ repo: 'example/web', status: 'complete', ops: [], conflicts: [] }];
  const base = planHash(plans, BASE_CONFIG);
  assert.equal(planHash(plans, {
    ...BASE_CONFIG,
    github: { owner: 'example', cloneProtocol: 'ssh', upstreamRemote: 'up' },
    workspaceTitle: 'Main',
    workspaceTitleMultiRepo: '{repo} · {subject}',
  }), base, 'retired knobs do not change the hash');
  assert.notEqual(planHash(plans, { ...BASE_CONFIG, github: { owner: 'other' } }), base, 'the owner still matters');
});
