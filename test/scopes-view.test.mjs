// Offline tests for the hub overview (plugin/server/core/scopes-view.mjs) with fake Paseo state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeRows, scopeCandidates, formatScopeRows, formatScopeCandidates } from '../plugin/server/core/scopes-view.mjs';

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

function steer({ id, workspaceId, slot, repo, provider = 'codex', model = 'gpt-6.2-sol', used = 12000, max = 200000, archivedAt = null }) {
  return {
    id, workspaceId, archivedAt, title: `Steer ${slot}`, provider, model, status: 'idle',
    labels: { 'wsf.role': 'steer', 'wsf.repo': repo, 'wsf.slot': slot },
    ...(used === null ? {} : { lastUsage: { contextWindowUsedTokens: used, contextWindowMaxTokens: max } }),
  };
}

function mainWorkspace({ id, dir, scope, activeSteer, epoch, checkpoint = null, title = 'Main' }) {
  return {
    id, projectId: 'proj-1', title, name: title, workspaceDirectory: dir,
    metadata: {
      wsf: { main: true, activeSteer, epoch, ...(scope ? { scope } : {}) },
      ...(checkpoint ? { 'wsf.checkpoint': checkpoint } : {}),
    },
  };
}

function githubState() {
  const workspace = mainWorkspace({
    id: 'wks_main1', dir: '/home/you/projects/web', activeSteer: 'A', epoch: 3,
    scope: { id: 'example/web', kind: 'github', locator: 'example/web' },
    checkpoint: { task: 'Ship it', tests: ['npm test'], blockers: ['hub:needs-review', 'flaky test'], next: 'Cut a release', epoch: 3, updatedAt: ago(2.5 * 3600_000) },
  });
  return {
    workspaces: [workspace],
    agents: [steer({ id: 'steer-a', workspaceId: 'wks_main1', slot: 'A', repo: 'example/web' })],
    projects: [{ projectId: 'proj-1', projectRootPath: '/home/you/projects/web' }],
    providers: [],
  };
}

test('scope row carries id, kind, active steer, epoch, checkpoint age, next and escalations', () => {
  const [row] = scopeRows(githubState(), { now: () => NOW });
  assert.equal(row.id, 'example/web');
  assert.equal(row.kind, 'github');
  assert.deepEqual(row.active, { slot: 'A', id: 'steer-a', model: 'codex/gpt-6.2-sol', status: 'idle' });
  assert.equal(row.epoch, 3);
  assert.equal(row.checkpoint.updatedAt, ago(2.5 * 3600_000));
  assert.equal(row.checkpoint.ageMs, 2.5 * 3600_000);
  assert.equal(row.checkpoint.next, 'Cut a release');
  assert.deepEqual(row.checkpoint.escalations, ['hub:needs-review']);
  assert.deepEqual(row.usage, { usedTokens: 12000, maxTokens: 200000 });
  assert.equal(row.legacyAlias, undefined);
  assert.equal(row.hints, undefined);
});

test('scope row does not select an active holder when the slot is ambiguous', () => {
  const state = githubState();
  state.agents.push(steer({ id: 'another-a', workspaceId: 'wks_main1', slot: 'A', repo: 'example/web' }));
  const [row] = scopeRows(state, { now: () => NOW });
  assert.equal(row.active, null);
});

test('missing checkpoint, usage and active steer stay null without crashing', () => {
  const workspace = mainWorkspace({ id: 'wks_main2', dir: '/home/you/projects/empty', activeSteer: 'B', epoch: 1 });
  const state = {
    workspaces: [workspace],
    agents: [steer({ id: 'steer-a', workspaceId: 'wks_main2', slot: 'A', repo: 'example/empty', used: null })],
    projects: [], providers: [],
  };
  const [row] = scopeRows(state, { now: () => NOW });
  assert.equal(row.checkpoint, null);
  assert.equal(row.usage, null);
  assert.equal(row.active, null);
  assert.equal(row.epoch, 1);
  const text = formatScopeRows([row]);
  assert.match(text, /steer -/);
  assert.match(text, /cp none/);
  assert.match(text, /ctx n\/a/);
});

test('dir scopes show the deprecated local alias and workspaces without metadata are skipped', () => {
  const state = githubState();
  state.workspaces.push(mainWorkspace({ id: 'wks_dir1', dir: '/home/you/notes', activeSteer: 'A', epoch: 1 }));
  state.workspaces.push({ id: 'wks_plain', projectId: 'proj-1', title: 'Scratch', workspaceDirectory: '/tmp/scratch', metadata: {} });
  const rows = scopeRows(state, { now: () => NOW });
  assert.equal(rows.length, 2);
  const dir = rows.find((r) => r.workspaceId === 'wks_dir1');
  assert.equal(dir.kind, 'dir');
  assert.equal(dir.legacyAlias, 'local/notes');
  assert.match(formatScopeRows([dir]), /alias local\/notes \(deprecated\)/);
});

test('one text line per scope carries all hub fields', () => {
  const text = formatScopeRows(scopeRows(githubState(), { now: () => NOW }));
  assert.equal(text.split('\n').length, 1);
  assert.match(text, /example\/web \[github\]/);
  assert.match(text, /steer A codex\/gpt-6\.2-sol/);
  assert.match(text, /epoch 3/);
  assert.match(text, /cp 2h/);
  assert.match(text, /next: "Cut a release"/);
  assert.match(text, /hub: hub:needs-review/);
  assert.match(text, /ctx 12000\/200000 \(6%\)/);
  assert.equal(formatScopeRows([]), '(no live scopes)');
});

test('candidates list unadopted workspaces with agents and a plan suggestion', () => {
  const state = githubState();
  state.workspaces.push(
    { id: 'wks_plain', projectId: 'proj-1', title: 'Scratch', name: 'Scratch', workspaceDirectory: '/tmp/scratch', metadata: {} },
    { id: 'wks_wt', projectId: 'proj-1', title: 'Feature', name: 'Feature', workspaceDirectory: '/home/you/web-wt', workspaceKind: 'worktree', metadata: {} },
  );
  state.projects.push({ projectId: 'proj-1', kind: 'git' });
  state.agents.push(
    { id: 'agent-1', workspaceId: 'wks_plain', archivedAt: null, title: 'Explore', provider: 'codex', model: 'gpt-6.2-sol', status: 'idle', labels: {} },
    { id: 'agent-2', workspaceId: 'wks_plain', archivedAt: null, title: 'Child', provider: 'codex', model: 'gpt-6.2-sol', status: 'idle', labels: { 'paseo.parent-agent-id': 'agent-1' } },
    { id: 'agent-old', workspaceId: 'wks_plain', archivedAt: '2026-01-01', title: 'Old', provider: 'codex', model: 'm', status: 'closed', labels: {} },
  );
  const rows = scopeCandidates(state);
  assert.equal(rows.length, 2);
  const plain = rows.find((r) => r.workspaceId === 'wks_plain');
  assert.equal(plain.title, 'Scratch');
  assert.equal(plain.projectKind, 'git');
  assert.equal(plain.worktree, false);
  assert.deepEqual(plain.agents, [
    { id: 'agent-1', title: 'Explore', provider: 'codex', model: 'gpt-6.2-sol', status: 'idle', parentId: null },
    { id: 'agent-2', title: 'Child', provider: 'codex', model: 'gpt-6.2-sol', status: 'idle', parentId: 'agent-1' },
  ]);
  assert.equal(plain.suggestedPlan, '/factory plan --local /tmp/scratch');
  const wt = rows.find((r) => r.workspaceId === 'wks_wt');
  assert.equal(wt.worktree, true);
  assert.equal(wt.suggestedPlan, '/factory plan workspace:wks_wt');
  const text = formatScopeCandidates(rows);
  assert.match(text, /wks_plain "Scratch" \/tmp\/scratch/);
  assert.match(text, /plan: \/factory plan workspace:wks_wt/);
  assert.match(text, /agent-1 "Explore" \(codex\/gpt-6\.2-sol, idle\)/);
  assert.match(text, /agent-2 "Child" \(codex\/gpt-6\.2-sol, idle\) parent agent-1/);
  assert.equal(formatScopeCandidates([]), '(no adoption candidates)');
});

test('composer candidate suggestions use slash syntax and quote local paths', () => {
  const state = { workspaces: [{ id: 'wks_plain', workspaceDirectory: '/tmp/my project', metadata: {} }] };
  assert.equal(scopeCandidates(state, { factoryCmd: '/factory' })[0].suggestedPlan, '/factory plan --local "/tmp/my project"');
  assert.equal(scopeCandidates(state, { factoryCmd: 'paseo-factory' })[0].suggestedPlan, "paseo-factory plan --local '/tmp/my project'");
});
