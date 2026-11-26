// Steer creation route selection from host priorities, catalog, health and quota.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveProfile, resolveSteerAdd } from '../plugin/server/core/models.mjs';
import { normalizeZerosubState } from '../plugin/server/core/zerosub.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const RESET_5H = '2026-11-24T15:00:00Z';
const RESET_LATE = '2026-11-24T18:00:00Z';
const RESET_WEEK = '2026-11-30T12:00:00Z';
const PAST = '2026-11-20T12:00:00Z';

const CONFIG = {
  version: 1,
  github: { owner: 'Test', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/tmp/test',
  workspaceTitle: 'Main',
  profiles: {
    alpha: { provider: 'fake-x', model: 'x1' },
    beta: { provider: 'fake-y', model: 'y1' },
    gamma: { provider: 'fake-x', model: 'x2' },
  },
  steers: { slots: { A: 'alpha', B: 'beta' }, prepare: ['A', 'B'], initialActive: 'A', priority: ['alpha', 'beta', 'gamma'] },
};

const PROVIDERS = [
  { provider: 'fake-x', enabled: true, status: 'ready', models: [{ id: 'x1' }, { id: 'x2' }] },
  { provider: 'fake-y', enabled: true, status: 'ready', models: [{ id: 'y1' }] },
];

function acc(id, family, pct, { resetsAt = RESET_5H, status = 'active', limitedUntil = null } = {}) {
  return {
    id, family, label: id, kind: 'oauth', plan: 'pro',
    status, isDefault: false, limitedUntil,
    usage: {
      fetchedAt: '2026-11-24T11:59:00Z',
      windows: pct === null ? [] : [{ id: 'five_hour', label: '5h', usedPercent: pct, resetsAt }],
      cached: false,
    },
    agentCount: 0,
  };
}

function state(accounts) {
  return normalizeZerosubState({ accounts, agents: [] }, { now: NOW });
}

test('resolveSteerAdd with an explicit profile tries it alone and infers the advisor flag', () => {
  const picked = resolveSteerAdd(CONFIG, PROVIDERS, { profile: 'beta', now: NOW });
  assert.equal(picked.profile.name, 'beta');
  assert.equal(picked.advisorSlot, false);
  assert.deepEqual(picked.skipped, []);
  const tagged = structuredClone(CONFIG);
  tagged.profiles.gamma.advisor = true;
  const advisor = resolveSteerAdd(tagged, PROVIDERS, { profile: 'gamma', now: NOW });
  assert.equal(advisor.profile.name, 'gamma');
  assert.equal(advisor.advisorSlot, true);
  assert.throws(() => resolveSteerAdd(CONFIG, PROVIDERS, { profile: 'missing' }), /Unknown profile "missing"/);
  assert.throws(() => resolveSteerAdd(CONFIG, PROVIDERS, { profile: '  ' }), /non-empty profile name/);
});

test('resolveSteerAdd without a profile uses coordinator priority and reports skips', () => {
  const picked = resolveSteerAdd(CONFIG, PROVIDERS, { now: NOW });
  assert.equal(picked.profile.name, 'alpha');
  assert.deepEqual(picked.skipped, []);
  // Unhealthy first entry falls through to the next profile.
  const health = { alpha: { class: 'capacity', unhealthyUntil: new Date(NOW + 5 * 60_000).toISOString() } };
  const fell = resolveSteerAdd(CONFIG, PROVIDERS, { profileHealth: health, now: NOW });
  assert.equal(fell.profile.name, 'beta');
  assert.deepEqual(fell.skipped, [{ name: 'alpha', reason: 'recently failed: capacity' }]);
  // Catalog-missing first entry falls through as well.
  const down = [{ provider: 'fake-x', enabled: true, status: 'ready', models: [{ id: 'x2' }] }, PROVIDERS[1]];
  const catalog = resolveSteerAdd(CONFIG, down, { now: NOW });
  assert.equal(catalog.profile.name, 'beta');
  assert.match(catalog.skipped[0].reason, /model "x1" is not offered/);
  // Presets absent from the priority are ignored.
  const extra = structuredClone(CONFIG);
  extra.profiles.delta = { provider: 'fake-y', model: 'y1' };
  const gone = [
    { provider: 'fake-x', enabled: true, status: 'ready', models: [] },
    { provider: 'fake-y', enabled: true, status: 'ready', models: [{ id: 'y1' }] },
  ];
  const last = resolveSteerAdd(extra, gone, { now: NOW });
  assert.equal(last.profile.name, 'beta');
});

test('resolveSteerAdd keeps advisor profiles for advisor slots only', () => {
  const tagged = structuredClone(CONFIG);
  tagged.profiles.alpha.advisor = true;
  const plain = resolveSteerAdd(tagged, PROVIDERS, { now: NOW });
  assert.equal(plain.profile.name, 'beta');
  assert.match(plain.skipped[0].reason, /tagged as advisor/);
  const advisor = resolveSteerAdd(tagged, PROVIDERS, { advisorSlot: true, now: NOW });
  assert.equal(advisor.profile.name, 'alpha');
  assert.equal(advisor.advisorSlot, true);
  assert.match(advisor.skipped.map((s) => s.reason).join('; ') || 'none', /none|not tagged as advisor/);
  const noAdvisor = resolveSteerAdd(CONFIG, PROVIDERS, { advisorSlot: true, now: NOW });
  assert.equal(noAdvisor.profile, null);
  assert.ok(noAdvisor.skipped.every((s) => /not tagged as advisor/.test(s.reason)));
});

test('resolveSteerAdd applies privacy to automatic and explicit advisor choices', () => {
  const config = structuredClone(CONFIG);
  config.profiles.alpha.sensitive = true;
  config.profiles.gamma.advisor = true;
  config.profiles.gamma.sensitive = true;
  for (const repoPublic of [false, null, undefined]) {
    const automatic = resolveSteerAdd(config, PROVIDERS, { repoPublic });
    assert.equal(automatic.profile.name, 'beta');
    assert.match(automatic.skipped[0].reason, /public scope required/);
    for (const options of [{ profile: 'alpha' }, { profile: 'gamma' }, { advisorSlot: true }]) {
      const selected = resolveSteerAdd(config, PROVIDERS, { ...options, repoPublic });
      assert.equal(selected.profile, null);
      assert.ok(selected.skipped.some((s) => /public scope required/.test(s.reason)));
    }
  }
  assert.equal(resolveSteerAdd(config, PROVIDERS, { profile: 'gamma', repoPublic: true }).profile.name, 'gamma');
});

test('resolveSteerAdd reuses live-duplicate avoidance with the first entry exempt', () => {
  const dup = resolveSteerAdd(CONFIG, PROVIDERS, { usedProfiles: ['alpha'], now: NOW });
  assert.equal(dup.profile.name, 'alpha', 'explicit-first entry stays eligible like the slot profile');
  const down = [{ provider: 'fake-x', enabled: true, status: 'ready', models: [{ id: 'x2' }] }, PROVIDERS[1]];
  const fell = resolveSteerAdd(CONFIG, down, { usedProfiles: ['beta'], now: NOW });
  assert.equal(fell.profile.name, 'gamma');
  assert.ok(fell.skipped.some((s) => /already used by a live steer/.test(s.reason)));
});

test('resolveSteerAdd skips limited accounts and picks the roomiest', () => {
  const zerosub = state([
    acc('acc-roomy', 'fake-x', 20),
    acc('acc-full', 'fake-x', 10, { status: 'limited', limitedUntil: RESET_5H }),
    acc('acc-wait', 'fake-x', 10, { limitedUntil: RESET_5H }),
    acc('acc-high', 'fake-x', 60),
  ]);
  const picked = resolveSteerAdd(CONFIG, PROVIDERS, { profile: 'alpha', zerosub, now: NOW });
  assert.equal(picked.profile.name, 'alpha');
  assert.equal(picked.zerosubAccount, 'acc-roomy');
  assert.equal(picked.earliestReset, null);
});

test('resolveSteerAdd keeps warned accounts eligible and excludes exhausted accounts', () => {
  const zerosub = state([acc('acc-warn', 'fake-x', 93), acc('acc-roomy', 'fake-x', 20)]);
  const picked = resolveSteerAdd(CONFIG, PROVIDERS, { profile: 'alpha', zerosub, now: NOW });
  assert.equal(picked.zerosubAccount, 'acc-roomy');
  for (const pct of [93, 94]) {
    const onlyWarn = state([acc('acc-warn', 'fake-x', pct)]);
    const eligible = resolveSteerAdd(CONFIG, PROVIDERS, { profile: 'alpha', zerosub: onlyWarn, now: NOW });
    assert.equal(eligible.zerosubAccount, 'acc-warn', `${pct}%`);
  }
  const full = state([acc('acc-full', 'fake-x', 95, { resetsAt: RESET_5H })]);
  const none = resolveSteerAdd(CONFIG, PROVIDERS, { profile: 'alpha', zerosub: full, now: NOW });
  assert.equal(none.profile, null);
  assert.equal(none.skipped[0].reason, `accounts exhausted, earliest reset ${RESET_5H}`);
  assert.equal(none.earliestReset, RESET_5H);
  assert.equal(none.zerosubAccount, null);
  // Headroom order: lowest percent wins, unknown usage last, ties by id.
  const room = state([acc('acc-b', 'fake-x', 30), acc('acc-a', 'fake-x', 30), acc('acc-low', 'fake-x', 10)]);
  assert.equal(resolveSteerAdd(CONFIG, PROVIDERS, { profile: 'alpha', zerosub: room, now: NOW }).zerosubAccount, 'acc-low');
  const tie = state([acc('acc-b', 'fake-x', 20), acc('acc-a', 'fake-x', 20)]);
  assert.equal(resolveSteerAdd(CONFIG, PROVIDERS, { profile: 'alpha', zerosub: tie, now: NOW }).zerosubAccount, 'acc-a');
  const unknown = state([acc('acc-known', 'fake-x', 50), acc('acc-unknown', 'fake-x', null)]);
  assert.equal(resolveSteerAdd(CONFIG, PROVIDERS, { profile: 'alpha', zerosub: unknown, now: NOW }).zerosubAccount, 'acc-known');
});

test('resolveSteerAdd reports the earliest reset across account-blocked families', () => {
  const zerosub = state([
    acc('acc-x', 'fake-x', 95, { resetsAt: RESET_LATE }),
    acc('acc-y', 'fake-y', 99, { resetsAt: RESET_5H }),
  ]);
  const none = resolveSteerAdd(CONFIG, PROVIDERS, { zerosub, now: NOW });
  assert.equal(none.profile, null);
  assert.equal(none.skipped.length, 3);
  assert.ok(none.skipped.every((s) => s.reason.startsWith('accounts exhausted')));
  assert.equal(none.earliestReset, RESET_5H);
  // Without a future reset the reason stays actionable but bare.
  const unknown = state([acc('acc-x', 'fake-x', 95, { resetsAt: null })]);
  const bare = resolveSteerAdd(CONFIG, PROVIDERS, { profile: 'alpha', zerosub: unknown, now: NOW });
  assert.equal(bare.skipped[0].reason, 'accounts exhausted');
  assert.equal(bare.earliestReset, null);
  // An expired window does not block: its percent is stale.
  const past = state([acc('acc-x', 'fake-x', 95, { resetsAt: PAST })]);
  const roomy = resolveSteerAdd(CONFIG, PROVIDERS, { profile: 'alpha', zerosub: past, now: NOW });
  assert.equal(roomy.profile.name, 'alpha');
  assert.equal(roomy.zerosubAccount, 'acc-x');
  // Families blocked by other reasons do not set the reset.
  const down = [{ provider: 'fake-x', enabled: true, status: 'ready', models: [{ id: 'x2' }] }, PROVIDERS[1]];
  const mixed = resolveSteerAdd(CONFIG, down, { zerosub, now: NOW });
  assert.equal(mixed.profile, null);
  assert.equal(mixed.earliestReset, RESET_5H);
  const catalogOnly = resolveSteerAdd(CONFIG, down, { profile: 'alpha', zerosub: state([acc('acc-x', 'fake-x', 20)]), now: NOW });
  assert.equal(catalogOnly.profile, null);
  assert.match(catalogOnly.skipped[0].reason, /not offered/);
  assert.equal(catalogOnly.earliestReset, null);
});

test('resolveSteerAdd honors a custom exhaustion threshold independently of warning', () => {
  const zerosub = state([acc('acc-mid', 'fake-x', 85)]);
  const strict = resolveSteerAdd(CONFIG, PROVIDERS, { profile: 'alpha', zerosub, now: NOW, quotaExhaustedPct: 85 });
  assert.equal(strict.profile, null);
  const relaxed = resolveSteerAdd(CONFIG, PROVIDERS, { profile: 'alpha', zerosub, now: NOW, quotaExhaustedPct: 90 });
  assert.equal(relaxed.profile.name, 'alpha');
  assert.equal(relaxed.zerosubAccount, 'acc-mid');
});

test('resolveSteerAdd keeps pool families on the exhausted threshold', () => {
  const warned = resolveSteerAdd(CONFIG, PROVIDERS, { quotaSnapshot: { 'fake-x': { sessionPct: 80 } }, now: NOW });
  assert.equal(warned.profile.name, 'alpha', 'a warned pool without accounts stays eligible');
  const spent = resolveSteerAdd(CONFIG, PROVIDERS, { quotaSnapshot: { 'fake-x': { sessionPct: 95 } }, now: NOW });
  assert.equal(spent.profile.name, 'beta');
  assert.equal(spent.skipped[0].reason, 'pool exhausted');
});

test('resolveProfile applies the configured exhaustion threshold', () => {
  const zerosub = state([acc('acc-warn', 'fake-x', 80, { resetsAt: RESET_5H })]);
  const legacy = resolveProfile(CONFIG, PROVIDERS, ['alpha'], { role: 'steer', zerosub, now: NOW });
  assert.equal(legacy.profile.name, 'alpha');
  assert.equal(legacy.zerosubAccount, 'acc-warn');
  const strict = resolveProfile(CONFIG, PROVIDERS, ['alpha'], { role: 'steer', zerosub, now: NOW, quotaExhaustedPct: 75 });
  assert.equal(strict.profile, null);
  assert.match(strict.skipped[0].reason, /^accounts exhausted, earliest reset /);
  const added = resolveSteerAdd(CONFIG, PROVIDERS, { profile: 'alpha', zerosub, now: NOW });
  assert.equal(added.profile.name, 'alpha');
});
