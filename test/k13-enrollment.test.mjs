// K13: plan/apply is single-workspace enrollment + repair. Old stored plan
// artifacts must not crash load/status/apply: apply refuses retired kinds
// and multi-entry plans with a clear message. Fakes only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeEntry } from '../plugin/server/core/discovery.mjs';
import { createRunner } from '../plugin/server/core/factory.mjs';
import { planHash } from '../plugin/server/core/planner.mjs';
import { applyPlans, createAuthorization, memoryProgress, storeAuthorization, ApplyRefused } from '../plugin/server/core/apply.mjs';
import { METADATA_KEY } from '../plugin/server/core/paseo.mjs';

const CONFIG = {
  version: 1,
  github: { owner: 'example' },
  checkoutRoot: '/p',
  profiles: { sol: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' } },
  steers: { slots: { A: 'sol' }, prepare: ['A'], initialActive: 'A' },
  workers: { defaultProfile: 'sol' },
};
const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'full-access' }] },
];

function makeWorld() {
  return { checkouts: {}, projects: [], workspaces: [], agents: [], providers: structuredClone(PROVIDERS), seq: 0 };
}
function runnerFor(world, config = CONFIG) {
  return createRunner({
    config, client: null, gh: () => { throw new Error('no gh'); }, git: () => { throw new Error('no git'); },
    readState: async () => structuredClone({ projects: world.projects, workspaces: world.workspaces, agents: world.agents, providers: world.providers }),
    scan: () => Object.entries(world.checkouts).map(([path, c]) => ({ path, linkedWorktree: false, remotes: { ...(c.remotes ?? {}) }, repos: {} })),
    realpath: (p) => p, existsDir: (p) => world.checkouts[p] !== undefined,
  });
}

test('runPlans takes exactly one entry (multi-repo plans retired)', async () => {
  const world = makeWorld();
  world.checkouts['/p/a'] = { remotes: {} };
  world.checkouts['/p/b'] = { remotes: {} };
  await assert.rejects(runnerFor(world).runPlans([{ local: '/p/a' }, { local: '/p/b' }]), /exactly one workspace entry/);
  await assert.rejects(runnerFor(world).runPlans([]), /exactly one workspace entry/);
});

test('retired entry keys fail closed with a pointer (checkout, subject)', () => {
  assert.throws(() => normalizeEntry({ local: '/p/a', checkout: '/p/a' }, CONFIG), /was retired/);
  assert.throws(() => normalizeEntry({ repo: 'example/a', checkout: '/p/a' }, CONFIG), /was retired/);
  assert.throws(() => normalizeEntry({ local: '/p/a', subject: 'x' }, CONFIG), /was retired/);
});

test('enrollment without an existing workspace is a conflict, never a create', async () => {
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const [p] = await runnerFor(world).runPlans([{ local: '/p/demo' }]);
  assert.equal(p.status, 'conflict');
  assert.ok(p.ops.every((o) => o.kind !== 'paseo.workspace.create'), 'no workspace.create op exists anymore');
  assert.match(p.conflicts.find((c) => c.key === 'workspace.main').reason, /No factory main workspace/);
});

test('MAIN_TITLE recognition still finds Main-titled workspaces (kept behavior)', async () => {
  for (const title of ['Main', 'demo · Main']) {
    const world = makeWorld();
    world.checkouts['/p/demo'] = { remotes: {} };
    world.projects.push({ projectId: 'prj_1', projectRootPath: '/p/demo', projectDisplayName: 'demo' });
    const ws = {
      id: 'wks_maintitle0000001', projectId: 'prj_1', workspaceDirectory: '/p/demo',
      workspaceKind: 'local_checkout', title, name: title, metadata: {},
    };
    world.workspaces.push(ws);
    const [d] = await runnerFor(world).discoverAll([{ local: '/p/demo' }]);
    assert.equal(d.mainWorkspace?.id, ws.id, title);
  }
});

test('old multi-entry authorizations are refused, not crashed on', async () => {
  const plans = [
    { repo: 'a', status: 'pending', ops: [], conflicts: [] },
    { repo: 'b', status: 'pending', ops: [], conflicts: [] },
  ];
  const authorization = { version: 1, hash: planHash(plans, CONFIG), createdAt: new Date().toISOString(), entries: [{ local: '/p/a' }, { local: '/p/b' }], adopt: {}, adoptWorker: {}, detach: false, plans };
  await assert.rejects(
    applyPlans({ authorization, config: CONFIG, confirm: authorization.hash, runPlans: async () => { throw new Error('must not replan'); }, execute: async () => { throw new Error('must not execute'); } }),
    /single-workspace since K13/,
  );
});

test('old plans with retired kinds are refused with a clear message', async () => {
  for (const kind of ['github.fork', 'paseo.clone', 'git.remote.add', 'paseo.project.add', 'paseo.workspace.create', 'paseo.workspace.retitle', 'paseo.project.rename']) {
    const plans = [{ repo: 'example/web', status: 'pending', ops: [{ key: 'retired.x', kind, summary: 'old', params: {} }], conflicts: [] }];
    const authorization = { version: 1, hash: planHash(plans, CONFIG), createdAt: new Date().toISOString(), entries: [{ local: '/p/web' }], adopt: {}, adoptWorker: {}, detach: false, plans };
    await assert.rejects(
      applyPlans({ authorization, config: CONFIG, confirm: authorization.hash, runPlans: async () => { throw new Error('must not replan'); }, execute: async () => { throw new Error('must not execute'); } }),
      new RegExp(`retired operation retired\\.x \\(${kind}\\)`),
      kind,
    );
  }
});

test('new authorizations omit retired options; old ones compare by kept fields', async () => {
  const plans = [{ repo: 'demo', status: 'complete', ops: [], conflicts: [] }];
  const auth = createAuthorization(plans, CONFIG, { entries: [{ local: '/p/demo' }], adopt: {} });
  assert.equal('allowFork' in auth, false);
  assert.equal('retitle' in auth, false);
  assert.equal('renameProject' in auth, false);
  // storeAuthorization treats retired fields as absent on both sides.
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'wsf-k13-'));
  const first = storeAuthorization(dir, auth, CONFIG);
  assert.equal(first.status, 'created');
  const legacy = { ...structuredClone(auth), allowFork: true, retitle: true, renameProject: 'x' };
  const kept = storeAuthorization(dir, legacy, CONFIG);
  assert.equal(kept.status, 'kept', 'retired fields do not fork the authorization');
  const { rmSync } = await import('node:fs');
  rmSync(dir, { recursive: true, force: true });
});

test('damaged authorizations are refused, not crashed on', async () => {
  await assert.rejects(applyPlans({ authorization: null, config: CONFIG, confirm: 'x' }), ApplyRefused);
  const broken = { version: 1, hash: '0'.repeat(16), createdAt: new Date().toISOString(), entries: {}, plans: null };
  await assert.rejects(
    applyPlans({ authorization: broken, config: CONFIG, confirm: broken.hash, runPlans: async () => [], execute: async () => ({}) }),
    /damaged/,
  );
});
