// Scope core (S2), read side: stored scope fields, derivation, address
// resolution (id -> workspace id -> path -> legacy alias). Fakes only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LABEL, METADATA_KEY } from '../src/paseo.mjs';
import { listScopes, resolveScope, scopeToEntry, ScopeConflict } from '../src/scope.mjs';
import { resolveTargetEntry } from '../src/steer.mjs';

let seq = 0;
const state = ({ workspaces = [], agents = [] } = {}) => ({
  projects: [], workspaces, agents, providers: [],
});
const mainMeta = (extra = {}) => ({ [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, ...extra } });
const ws = ({ id, dir, kind = 'local_checkout', title, metadata = mainMeta(), projectId = 'prj_1' }) => ({
  id: id ?? `wks_${String(++seq).padStart(16, '0')}`,
  projectId,
  workspaceDirectory: dir,
  workspaceKind: kind,
  title: title ?? dir.split('/').at(-1),
  name: title ?? dir.split('/').at(-1),
  metadata: structuredClone(metadata),
});
const steer = ({ workspaceId, repo, slot = 'A', archived = false }) => ({
  id: `agent-${++seq}`, status: 'idle', archivedAt: archived ? 'then' : null, title: `Steer ${slot}`,
  provider: 'codex', model: 'm', workspaceId,
  labels: { [LABEL.repo]: repo, [LABEL.role]: 'steer', [LABEL.slot]: slot },
});

test('listScopes reads stored scope fields for all kinds', () => {
  const s = state({
    workspaces: [
      ws({ id: 'wks_gh00000000000001', dir: '/p/demo', metadata: mainMeta({ scope: { id: 'Example/demo', kind: 'github', locator: 'Example/demo' } }) }),
      ws({ id: 'wks_dir0000000000002', dir: '/p/notes', metadata: mainMeta({ scope: { id: 'notes', kind: 'dir', locator: '/p/notes' } }) }),
      ws({ id: 'wks_wt00000000000003', dir: '/wt/feat', kind: 'worktree', metadata: mainMeta({ scope: { id: 'demo@feat', kind: 'workspace', locator: 'wks_wt00000000000003', parent: 'Example/demo' } }) }),
      ws({ id: 'wks_hub0000000000004', dir: '/p/hub', metadata: mainMeta({ scope: { id: 'hub', kind: 'hub', locator: '/p/hub' } }) }),
      ws({ id: 'wks_plain00000000005', dir: '/p/other', metadata: {} }),
    ],
  });
  const scopes = listScopes(s);
  assert.deepEqual(scopes.map((x) => [x.id, x.kind]), [
    ['Example/demo', 'github'], ['notes', 'dir'], ['demo@feat', 'workspace'], ['hub', 'hub'],
  ]);
  assert.equal(scopes[2].parent, 'Example/demo');
  assert.equal(scopes[0].workspaceId, 'wks_gh00000000000001');
});

test('listScopes derives missing scope fields', () => {
  const gh = ws({ id: 'wks_gh00000000000011', dir: '/p/demo' });
  const wt = ws({ id: 'wks_wt00000000000012', dir: '/wt/feat', kind: 'worktree' });
  const bare = ws({ id: 'wks_bare000000000013', dir: '/p/bare' });
  const s = state({
    workspaces: [gh, wt, bare],
    agents: [
      steer({ workspaceId: gh.id, repo: 'Example/demo' }),
      steer({ workspaceId: wt.id, repo: 'local/feat' }),
    ],
  });
  const byId = Object.fromEntries(listScopes(s).map((x) => [x.workspaceId, x]));
  assert.deepEqual([byId[gh.id].kind, byId[gh.id].id, byId[gh.id].locator], ['github', 'Example/demo', 'Example/demo']);
  assert.deepEqual([byId[wt.id].kind, byId[wt.id].id, byId[wt.id].locator], ['workspace', 'feat', wt.id]);
  assert.deepEqual([byId[bare.id].kind, byId[bare.id].id], ['dir', 'bare']);
});

test('resolveScope follows id, workspace id, path, alias', () => {
  const gh = ws({ id: 'wks_gh00000000000021', dir: '/p/demo' });
  const wt = ws({ id: 'wks_wt00000000000022', dir: '/wt/feat', kind: 'worktree' });
  const s = state({ workspaces: [gh, wt], agents: [steer({ workspaceId: gh.id, repo: 'Example/demo' })] });
  assert.equal(resolveScope('Example/demo', s).workspaceId, gh.id);
  assert.equal(resolveScope('feat', s).workspaceId, wt.id);
  assert.equal(resolveScope('wks_wt00000000000022', s).workspaceId, wt.id);
  assert.equal(resolveScope('workspace:wks_gh00000000000021', s).workspaceId, gh.id);
  assert.equal(resolveScope('worktree:wks_wt00000000000022', s).workspaceId, wt.id);
  assert.equal(resolveScope('/wt/feat', s).workspaceId, wt.id);
  const alias = resolveScope('local/feat', s);
  assert.equal(alias.workspaceId, wt.id);
  assert.equal(alias.deprecatedAlias, true);
  assert.equal(resolveScope('local/demo', s), null, 'github scopes are not alias targets; legacy discovery handles them');
  assert.equal(resolveScope('Example/unknown', s), null);
  assert.equal(resolveScope('wks_nonexistent00001', s), null);
  assert.equal(resolveScope('/p/elsewhere', s), null);
});

test('resolveScope reports ambiguity and duplicate ids with candidates', () => {
  const a = ws({ id: 'wks_a0000000000000031', dir: '/wt/x/same', kind: 'worktree' });
  const b = ws({ id: 'wks_b0000000000000032', dir: '/wt/y/same', kind: 'worktree' });
  const s = state({ workspaces: [a, b] });
  assert.throws(() => resolveScope('local/same', s), (error) => {
    assert.ok(error instanceof ScopeConflict);
    assert.equal(error.code, 'ambiguous');
    assert.deepEqual(error.candidates.map((c) => c.workspaceId).sort(), [a.id, b.id].sort());
    assert.deepEqual(Object.keys(error.candidates[0]).sort(), ['id', 'kind', 'path', 'workspaceId']);
    return true;
  });
  assert.throws(() => resolveScope('same', s), /several live scopes/);
  const dup = state({ workspaces: [a, { ...b, id: 'wks_c0000000000000033' }] });
  assert.throws(() => resolveScope('same', dup), (error) => error instanceof ScopeConflict && error.code === 'duplicate-id');
});

test('two scopes on one directory make path resolution ambiguous', () => {
  const a = ws({ id: 'wks_a0000000000000041', dir: '/p/shared' });
  const b = ws({ id: 'wks_b0000000000000042', dir: '/p/shared' });
  const s = state({ workspaces: [a, b] });
  assert.throws(() => resolveScope('/p/shared', s), (error) => error instanceof ScopeConflict && error.candidates.length === 2);
  assert.equal(resolveScope(`workspace:${a.id}`, s).workspaceId, a.id);
});

test('scopeToEntry maps every kind back to a discovery entry', () => {
  assert.equal(scopeToEntry({ kind: 'github', locator: 'Example/demo' }), 'Example/demo');
  assert.deepEqual(scopeToEntry({ kind: 'dir', locator: '/p/notes', directory: '/p/notes' }), { local: '/p/notes' });
  assert.deepEqual(scopeToEntry({ kind: 'workspace', locator: 'wks_wt00000000000003', workspaceId: 'wks_wt00000000000003' }), { workspace: 'wks_wt00000000000003' });
  assert.deepEqual(scopeToEntry({ kind: 'hub', locator: '/p/hub' }), { local: '/p/hub' });
  assert.deepEqual(scopeToEntry({ kind: 'hub', locator: 'wks_hub0000000000004' }), { workspace: 'wks_hub0000000000004' });
});

test('resolveTargetEntry passes unknown addresses through and maps known ones', () => {
  const gh = ws({ id: 'wks_gh00000000000051', dir: '/p/demo' });
  const wt = ws({ id: 'wks_wt00000000000052', dir: '/wt/feat', kind: 'worktree' });
  const s = state({ workspaces: [gh, wt], agents: [steer({ workspaceId: gh.id, repo: 'Example/demo' })] });
  const unknown = resolveTargetEntry('Example/unknown', s);
  assert.equal(unknown.entry, 'Example/unknown');
  assert.equal(unknown.scope, null);
  const github = resolveTargetEntry('Example/demo', s);
  assert.equal(github.entry, 'Example/demo', 'github maps back verbatim');
  assert.equal(github.deprecatedAlias, false);
  const wrongCase = resolveTargetEntry('example/demo', s);
  assert.equal(wrongCase.scope?.id, 'Example/demo', 'id match is case-insensitive; the stored id is the canonical form');
  assert.equal(wrongCase.entry, 'Example/demo');
  assert.equal(wrongCase.deprecatedAlias, false);
  const alias = resolveTargetEntry('local/feat', s);
  assert.deepEqual(alias.entry, { workspace: wt.id });
  assert.equal(alias.deprecatedAlias, true);
  const obj = resolveTargetEntry({ local: '/wt/feat' }, s);
  assert.deepEqual(obj.entry, { workspace: wt.id });
  const idObj = resolveTargetEntry({ workspace: gh.id }, s);
  assert.equal(idObj.entry, 'Example/demo');
});
