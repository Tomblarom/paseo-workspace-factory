// Model CLI logic (plugin/server/core/models.mjs) with a mocked provider catalog.
// Fixtures mirror the CONFIG/PROVIDERS shape in test/workspace-factory.test.mjs
// and reuse validateConfig()/validateProfilesAgainstCatalog() from plugin/server/core/config.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from '../plugin/server/core/config.mjs';
import {
  flagValue, formatCatalog, parseProviderModel,
  planWorkerSet,
} from '../plugin/server/core/models.mjs';

const CONFIG = {
  version: 1,
  github: { owner: 'TestOwner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/tmp/wsf-test',
  workspaceTitle: 'Main',
  profiles: {
    sol: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
    muse: { provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null, mode: 'allowAll' },
  },
  steers: { slots: { A: 'sol' }, prepare: ['A'], initialActive: 'A' },
  workers: { defaultProfile: 'muse' },
};

const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }, { id: 'low' }] }], modes: [{ id: 'auto' }, { id: 'full-access' }] },
  { provider: 'muse', enabled: true, status: 'ready', models: [{ id: 'muse-spark-1.3-contributor', thinkingOptions: [{ id: 'max' }] }], modes: [{ id: 'onRequest' }, { id: 'allowAll' }] },
  { provider: 'copilot', enabled: true, status: 'ready', models: [{ id: 'claude-sonnet-5.5', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'allow-all' }] },
  { provider: 'opencode', enabled: false, status: 'unavailable', models: [], modes: [] },
];

test('parseProviderModel splits on the first slash and rejects junk', () => {
  assert.deepEqual(parseProviderModel('codex/gpt-6.2-sol'), { provider: 'codex', model: 'gpt-6.2-sol' });
  assert.deepEqual(parseProviderModel('p/org/model'), { provider: 'p', model: 'org/model' });
  for (const bad of ['noprovider', '/nomodel', 'provider/', '', null, undefined]) {
    assert.throws(() => parseProviderModel(bad), /<provider>\/<model>/, String(bad));
  }
});

test('flagValue: undefined keeps, "null"/"" means null', () => {
  assert.equal(flagValue(undefined), undefined);
  assert.equal(flagValue('null'), null);
  assert.equal(flagValue(''), null);
  assert.equal(flagValue('high'), 'high');
});

test('formatCatalog lists providers, models, thinking options and modes', () => {
  const text = formatCatalog(PROVIDERS);
  assert.match(text, /codex ready \(enabled\)/);
  assert.match(text, /gpt-6\.2-sol thinking: high, low/);
  assert.match(text, /modes: auto, full-access/);
  assert.match(text, /opencode unavailable \(disabled\)/);
  assert.match(text, /\(no models\)/);
  assert.deepEqual(JSON.parse(formatCatalog(PROVIDERS, { json: true })), PROVIDERS);
});

test('worker set 1 with a profile name inserts it at the front', () => {
  const planned = planWorkerSet(CONFIG, PROVIDERS, { n: 1, spec: 'sol' });
  assert.equal(planned.profileName, 'sol');
  assert.deepEqual(planned.after, ['sol', 'muse']);
  assert.equal(planned.config.workers.defaultProfile, 'sol');
  assert.match(planned.summary, /\[muse\] → \[sol, muse\]/);
  assert.throws(() => planWorkerSet(CONFIG, PROVIDERS, { n: 1, spec: 'missing' }), /Unknown profile/);
  assert.throws(() => planWorkerSet(CONFIG, PROVIDERS, { n: 1, spec: 'sol', thinking: 'high' }), /takes no --thinking/);
  const broken = structuredClone(CONFIG);
  broken.profiles.sol.model = 'nope';
  const stored = planWorkerSet(broken, PROVIDERS, { n: 1, spec: 'sol' });
  assert.match(stored.warnings.join('\n'), /not startable/);
  assert.deepEqual(stored.after, ['sol', 'muse']);
});

test('worker set 1 with provider/model creates the profile and inserts it', () => {
  const planned = planWorkerSet(CONFIG, PROVIDERS, {
    n: 1, spec: 'codex/gpt-6.2-sol', thinking: 'low', mode: 'auto', profile: 'worker-low',
  });
  assert.equal(planned.profileName, 'worker-low');
  assert.equal(planned.config.workers.defaultProfile, 'worker-low');
  assert.deepEqual(validateConfig(planned.config), []);
  const derived = planWorkerSet(CONFIG, PROVIDERS, { n: 1, spec: 'muse/muse-spark-1.3-contributor' });
  assert.equal(derived.profileName, 'muse-muse-spark-1.3-contributor', 'omitted flags form a different combination, no merge');
  assert.deepEqual(derived.config.profiles['muse-muse-spark-1.3-contributor'], { provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null });
  const moved = planWorkerSet(CONFIG, PROVIDERS, { n: 1, spec: 'muse' });
  assert.deepEqual(moved.after, ['muse'], 're-inserting the same profile moves it, no duplicate');
  const stored = planWorkerSet(CONFIG, PROVIDERS, { n: 1, spec: 'codex/nope' });
  assert.match(stored.warnings.join('\n'), /not startable/);
});
