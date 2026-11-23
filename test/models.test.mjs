// Model CLI logic (src/models.mjs) with a mocked provider catalog.
// Fixtures mirror the CONFIG/PROVIDERS shape in test/workspace-factory.test.mjs
// and reuse validateConfig()/validateProfilesAgainstCatalog() from src/config.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../src/config.mjs';
import {
  flagValue, formatCatalog, parseProviderModel, planSlotRemove, planSlotSet,
  planWorkerDefault, previewConfig, writeConfigAtomic,
} from '../src/models.mjs';

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

test('slot set on a new slot derives <provider>-<model> and stays valid', () => {
  const before = structuredClone(CONFIG);
  const planned = planSlotSet(CONFIG, PROVIDERS, {
    slot: 'B', provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null, mode: 'allowAll',
  });
  assert.equal(planned.profileName, 'muse-muse-spark-1.3-contributor');
  assert.equal(planned.config.steers.slots.B, planned.profileName);
  assert.deepEqual(planned.config.profiles[planned.profileName], {
    provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null, mode: 'allowAll',
  });
  assert.match(planned.summary, /Slot B → profile/);
  assert.match(planned.hint, /Existing steers are unchanged/);
  assert.deepEqual(validateConfig(planned.config), []);
  assert.deepEqual(CONFIG, before, 'input config is not mutated');
});

test('slot set on an existing slot reuses its profile and keeps omitted flags', () => {
  const planned = planSlotSet(CONFIG, PROVIDERS, {
    slot: 'A', provider: 'codex', model: 'gpt-6.2-sol', thinking: undefined, mode: undefined,
  });
  assert.equal(planned.profileName, 'sol');
  assert.equal(planned.config.profiles.sol.thinking, 'high');
  assert.equal(planned.config.profiles.sol.mode, 'full-access');
});

test('slot set with --profile creates and points at the named profile', () => {
  const planned = planSlotSet(CONFIG, PROVIDERS, {
    slot: 'B', provider: 'codex', model: 'gpt-6.2-sol', thinking: 'low', mode: 'auto', profile: 'custom',
  });
  assert.equal(planned.profileName, 'custom');
  assert.equal(planned.config.steers.slots.B, 'custom');
  assert.deepEqual(validateConfig(planned.config), []);
  assert.throws(() => planSlotSet(CONFIG, PROVIDERS, {
    slot: 'B', provider: 'codex', model: 'gpt-6.2-sol', profile: '  ',
  }), /--profile must be a non-empty name/);
});

test('slot set validates against the catalog including knownLimits', () => {
  assert.throws(() => planSlotSet(CONFIG, PROVIDERS, { slot: 'B', provider: 'nope', model: 'x' }), /not startable.*not configured/);
  assert.throws(() => planSlotSet(CONFIG, PROVIDERS, { slot: 'B', provider: 'codex', model: 'nope' }), /not startable.*not offered/);
  assert.throws(() => planSlotSet(CONFIG, PROVIDERS, {
    slot: 'B', provider: 'codex', model: 'gpt-6.2-sol', thinking: 'ultra', mode: 'auto',
  }), /not startable.*thinking "ultra"/);
  assert.throws(() => planSlotSet(CONFIG, PROVIDERS, {
    slot: 'B', provider: 'codex', model: 'gpt-6.2-sol', mode: 'nope',
  }), /not startable.*mode "nope"/);
  assert.throws(() => planSlotSet(CONFIG, PROVIDERS, {
    slot: 'B', provider: 'copilot', model: 'claude-sonnet-5.5', thinking: 'high', mode: 'allow-all',
  }), /not startable.*Copilot rejects a reasoning effort/);
  const limited = structuredClone(CONFIG);
  limited.knownLimits = [{ provider: 'codex', model: 'gpt-6.2-sol', field: 'mode', reason: 'custom limit hit' }];
  assert.throws(() => planSlotSet(limited, PROVIDERS, {
    slot: 'B', provider: 'codex', model: 'gpt-6.2-sol', mode: 'auto',
  }), /not startable.*custom limit hit/);
  for (const bad of ['a', 'AA', '', null]) {
    assert.throws(() => planSlotSet(CONFIG, PROVIDERS, { slot: bad, provider: 'codex', model: 'gpt-6.2-sol' }), /single capital letter/, String(bad));
  }
});

test('slot rm keeps the profile and repairs prepare/initialActive', () => {
  const two = structuredClone(CONFIG);
  two.profiles.extra = { provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null, mode: 'allowAll' };
  two.steers.slots.B = 'extra';
  two.steers.prepare = ['A', 'B'];
  const removed = planSlotRemove(two, 'B');
  assert.deepEqual(removed.config.steers.slots, { A: 'sol' });
  assert.deepEqual(removed.config.steers.prepare, ['A']);
  assert.equal(removed.config.steers.initialActive, 'A');
  assert.ok(removed.config.profiles.extra, 'profile is kept');
  assert.match(removed.summary, /Slot B removed/);
  assert.deepEqual(validateConfig(removed.config), []);

  const active = structuredClone(two);
  active.steers.initialActive = 'B';
  const moved = planSlotRemove(active, 'B');
  assert.equal(moved.config.steers.initialActive, 'A');

  const onlyPrepare = structuredClone(two);
  onlyPrepare.steers.prepare = ['B'];
  const repaired = planSlotRemove(onlyPrepare, 'B');
  assert.deepEqual(repaired.config.steers.prepare, ['A']);

  assert.throws(() => planSlotRemove(CONFIG, 'A'), /at least one slot must remain/);
  assert.throws(() => planSlotRemove(CONFIG, 'Z'), /not defined/);
});

test('worker-default with a profile name validates and sets the default', () => {
  const planned = planWorkerDefault(CONFIG, PROVIDERS, { spec: 'sol' });
  assert.equal(planned.profileName, 'sol');
  assert.equal(planned.config.workers.defaultProfile, 'sol');
  assert.throws(() => planWorkerDefault(CONFIG, PROVIDERS, { spec: 'missing' }), /Unknown profile/);
  assert.throws(() => planWorkerDefault(CONFIG, PROVIDERS, { spec: 'sol', thinking: 'high' }), /takes no --thinking/);
  const broken = structuredClone(CONFIG);
  broken.profiles.sol.model = 'nope';
  assert.throws(() => planWorkerDefault(broken, PROVIDERS, { spec: 'sol' }), /not startable/);
});

test('worker-default with provider/model creates the profile and sets the default', () => {
  const planned = planWorkerDefault(CONFIG, PROVIDERS, {
    spec: 'codex/gpt-6.2-sol', thinking: 'low', mode: 'auto', profile: 'worker-low',
  });
  assert.equal(planned.profileName, 'worker-low');
  assert.equal(planned.config.workers.defaultProfile, 'worker-low');
  assert.deepEqual(validateConfig(planned.config), []);
  const derived = planWorkerDefault(CONFIG, PROVIDERS, { spec: 'muse/muse-spark-1.3-contributor' });
  assert.equal(derived.profileName, 'muse-muse-spark-1.3-contributor');
  assert.throws(() => planWorkerDefault(CONFIG, PROVIDERS, { spec: 'codex/nope' }), /not startable/);
});

test('atomic write keeps the file mode and leaves no tmp file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wsf-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  writeFileSync(file, '{}\n');
  chmodSync(file, 0o640);
  const planned = planSlotSet(CONFIG, PROVIDERS, {
    slot: 'B', provider: 'codex', model: 'gpt-6.2-sol', thinking: 'low', mode: 'auto',
  });
  await writeConfigAtomic(file, planned.config);
  assert.equal(statSync(file).mode & 0o777, 0o640);
  assert.equal(readFileSync(file, 'utf8'), previewConfig(planned.config));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), planned.config);
  assert.ok(!readdirSync(dir).some((name) => name.includes('.tmp.')), 'no tmp file left');

  const fresh = join(dir, 'new.json');
  await writeConfigAtomic(fresh, CONFIG);
  assert.equal(statSync(fresh).mode & 0o777, 0o600);
});
