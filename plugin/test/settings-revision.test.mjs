import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-resolve-hooks.mjs', import.meta.url);
const { createConfigLoader } = await import('../server/config.ts');
const { listModels, setModels, resetCatalogCache } = await import('../server/models-rpc.ts');

function fixture({ advanceOnRead = false, advanceDuringCatalog = false } = {}) {
  resetCatalogCache();
  const profile = (model) => ({ provider: 'codex', model, thinking: null, mode: null, advisor: false, sensitive: false });
  const values = { profiles: { alpha: profile('alpha'), beta: profile('beta') }, slots: { A: 'alpha' },
    prepare: ['A'], initialActive: 'A', workerPriority: ['alpha'], quota: { exhaustedPct: 90, warnPct: 70 },
    githubOwner: 'example', checkoutRoot: '/tmp/revision-test' };
  const state = { status: 'ready', revision: 'r1', values };
  let reads = 0;
  const advance = () => {
    state.revision = 'r2';
    state.values.profiles.alpha.model = 'changed-elsewhere';
    state.values.workerPriority = ['beta'];
    state.values.quota.exhaustedPct = 85;
  };
  const hostSettings = { read: async () => {
    reads++;
    if (advanceOnRead && reads > 1) advance();
    return state;
  } };
  const loader = createConfigLoader(hostSettings);
  const ctx = { paseo: { providers: { snapshot: async () => {
    if (advanceDuringCatalog) advance();
    return { entries: [{ provider: 'codex', enabled: true, status: 'ready', modes: [],
      models: [{ id: 'alpha' }, { id: 'beta' }, { id: 'changed-elsewhere' }] }] };
  } } } };
  return { hostSettings, loader, ctx, state, reads: () => reads };
}

test('model edit builds values and revision from one settings read', async () => {
  const f = fixture({ advanceOnRead: true });
  const out = await setModels({ action: 'worker-set', n: '1', spec: 'beta' }, f.ctx, f.loader, f.hostSettings);
  assert.equal(out.revision, 'r1');
  assert.deepEqual(out.values.workerPriority, ['beta', 'alpha']);
  assert.equal(out.values.profiles.alpha.model, 'alpha');
  assert.equal(out.values.quota.exhaustedPct, 90);
  assert.equal(f.reads(), 1);
});

test('model list keeps its revision paired with displayed preferences during a concurrent save', async () => {
  const f = fixture({ advanceDuringCatalog: true });
  const out = await listModels({}, f.ctx, f.loader, f.hostSettings, Date.now, async () => null);
  assert.equal(f.state.revision, 'r2');
  assert.equal(out.revision, 'r1');
  assert.equal(out.workers[0].profile, 'alpha');
  assert.equal(out.workers[0].model, 'alpha');
  assert.equal(f.reads(), 1);
});

test('a pending model edit retains the original revision and values when settings change during catalog lookup', async () => {
  const f = fixture({ advanceDuringCatalog: true });
  const out = await setModels({ action: 'worker-set', n: '1', spec: 'beta' }, f.ctx, f.loader, f.hostSettings);
  assert.equal(f.state.revision, 'r2');
  assert.equal(out.revision, 'r1');
  assert.equal(out.values.profiles.alpha.model, 'alpha');
  assert.equal(out.values.quota.exhaustedPct, 90);
  assert.notEqual(out.revision, f.state.revision, 'native revision guard will refuse the stale save');
});

test('snapshot-based loader still validates the supplied settings and never rereads them', async () => {
  const f = fixture();
  await assert.rejects(f.loader.loadEffectiveConfig({ status: 'invalid', error: 'migration failed' }), /invalid: migration failed/);
  const state = { status: 'ready', revision: 'r', values: { ...f.state.values, checkoutRoot: 'relative' } };
  await assert.rejects(f.loader.loadEffectiveConfig(state), /checkoutRoot/);
  assert.equal(f.reads(), 0);
});
