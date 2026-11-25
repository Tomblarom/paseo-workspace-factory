import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configWarnings, validateConfig } from '../plugin/server/core/config.mjs';
import { resolveProfile } from '../plugin/server/core/models.mjs';
import { failoverChain } from '../plugin/server/core/supervision.mjs';
import { buildAssignment } from '../plugin/server/core/assign.mjs';
import { buildResumeBrief } from '../plugin/server/core/steer.mjs';
import { accountExhausted, formatQuotaLine, freshMaxUsedPct, parseUsageJson, profilePool, quotaExhausted } from '../plugin/server/core/quota.mjs';

const config = {
  version: 1, github: { owner: 'Test', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/tmp/test', workspaceTitle: 'Main',
  profiles: {
    a: { provider: 'claude', model: 'a', pool: 'shared' },
    b: { provider: 'codex', model: 'b' },
    c: { provider: 'muse', model: 'c' },
  },
  steers: { slots: { A: 'a', B: 'b', C: 'c' }, prepare: ['A', 'B', 'C'], initialActive: 'A' },
};

test('profile pools default to provider and accept an explicit pool', () => {
  assert.equal(profilePool(config.profiles.a), 'shared');
  assert.equal(profilePool(config.profiles.b), 'codex');
  assert.deepEqual(validateConfig(config), []);
  const bad = structuredClone(config);
  bad.profiles.a.pool = '';
  assert.ok(validateConfig(bad).some((error) => error.includes('pool must be a non-empty string')));
});

test('resolveProfile skips an exhausted quota pool', () => {
  const result = resolveProfile(config, [
    { provider: 'claude', enabled: true, status: 'ready', models: [{ id: 'a' }] },
    { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'b' }] },
  ], ['a', 'b'], { role: 'worker', quotaSnapshot: { shared: { sessionPct: 95 }, codex: { sessionPct: 10 } } });
  assert.equal(result.profile.name, 'b');
  assert.equal(result.skipped[0].reason, 'pool exhausted');
});

test('config warnings flag a single non-advisor quota pool', () => {
  const same = structuredClone(config);
  same.profiles.b.pool = 'shared';
  same.profiles.c.pool = 'shared';
  assert.ok(configWarnings(same).some((warning) => warning.includes('all non-advisor steer slots use quota pool "shared"')));
});

test('failoverChain prefers another pool when requested', () => {
  const chain = failoverChain({
    steers: [{ id: 'b', slot: 'B', provider: 'claude' }, { id: 'c', slot: 'C', provider: 'codex' }],
    activeSlot: 'A', failingPool: 'claude',
  });
  assert.deepEqual(chain.map((candidate) => candidate.steerId), ['c', 'b']);
});

test('quota warning is included in briefs and assignments only above threshold', () => {
  const status = {
    repo: 'example/repo', state: { epoch: 1, activeSteer: 'A' },
    steers: [{ slot: 'A', id: 'a' }], workers: [], openWorkers: [],
    checkpoint: null, workspace: { id: 'w', directory: '/tmp' },
  };
  const snapshot = { shared: { sessionPct: 78 } };
  const line = 'Quota: shared 78% (5h) — prefer codex';
  assert.match(buildResumeBrief(status, { config, quotaSnapshot: snapshot }), /Quota: shared 78% \(5h\) — prefer codex/);
  assert.match(buildAssignment(status, { slot: 'A', steerId: 'a', epoch: 1, task: 't', tests: [], blockers: [], next: null, config, quotaSnapshot: snapshot }), /Quota: shared 78%/);
  assert.equal(formatQuotaLine(config, { shared: { sessionPct: 74 } }), null);
  assert.ok(line.includes('prefer codex'));
});

test('account exhaustion ignores ordinary resets and expired windows', () => {
  const NOW = Date.parse('2026-11-24T12:00:00Z');
  const FUTURE = '2026-11-24T15:00:00Z';
  const PAST = '2026-11-20T12:00:00Z';
  const cases = [
    ['fresh threshold hit', { windows: [{ usedPct: 95, resetsAt: FUTURE }] }, true],
    ['healthy pool with ordinary future reset', { windows: [{ usedPct: 12, resetsAt: FUTURE }, { usedPct: 20, resetsAt: FUTURE }] }, false],
    ['explicit future limitedUntil', { limitedUntil: FUTURE, windows: [{ usedPct: 10, resetsAt: FUTURE }] }, true],
    ['past limitedUntil is not a hold', { limitedUntil: PAST, windows: [{ usedPct: 10, resetsAt: FUTURE }] }, false],
    ['limited status flag', { exhausted: true, windows: [{ usedPct: 10, resetsAt: FUTURE }] }, true],
    ['expired high window only', { windows: [{ usedPct: 99, resetsAt: PAST }] }, false],
    ['expired high plus fresh low window', { windows: [{ usedPct: 99, resetsAt: PAST }, { usedPct: 20, resetsAt: FUTURE }] }, false],
    ['window without reset counts', { windows: [{ usedPct: 95, resetsAt: null }] }, true],
    ['scalar fallback without windows', { maxUsedPct: 95 }, true],
    ['no data is not exhausted', {}, false],
  ];
  for (const [name, account, want] of cases) {
    assert.equal(accountExhausted(account, { now: NOW }), want, name);
  }
  assert.equal(freshMaxUsedPct({ windows: [{ usedPct: 99, resetsAt: PAST }] }, NOW), null);
  assert.equal(freshMaxUsedPct({ windows: [{ usedPct: 99, resetsAt: PAST }, { usedPct: 20, resetsAt: FUTURE }] }, NOW), 20);
  assert.equal(freshMaxUsedPct({ maxUsedPct: 55 }, NOW), 55);
});

test('pool exhaustion honors explicit limits but never an ordinary reset', () => {
  const NOW = Date.parse('2026-11-24T12:00:00Z');
  const FUTURE = '2026-11-24T15:00:00Z';
  const PAST = '2026-11-20T12:00:00Z';
  assert.equal(quotaExhausted({ p: { sessionPct: 10, resetsAt: FUTURE } }, 'p', 90, NOW), false);
  assert.equal(quotaExhausted({ p: { sessionPct: 10, limitUntil: FUTURE } }, 'p', 90, NOW), true);
  assert.equal(quotaExhausted({ p: { sessionPct: 10, limitedUntil: FUTURE } }, 'p', 90, NOW), true);
  assert.equal(quotaExhausted({ p: { sessionPct: 10, limitUntil: PAST } }, 'p', 90, NOW), false);
  assert.equal(quotaExhausted({ p: { sessionPct: 10, exhausted: true } }, 'p', 90, NOW), true);
  assert.equal(quotaExhausted({ p: { sessionPct: 95 } }, 'p', 90, NOW), true);
});

test('usage JSON parsing is fail-soft and extracts the 5h window', () => {
  const output = JSON.stringify([{ sourceLabel: 'claude', lastSuccessful: { report: { windows: [
    { id: 'five-hour', usedPct: 82, resetsAt: '2026-11-24T15:00:00Z' },
  ] } } }]);
  assert.deepEqual(parseUsageJson(output), { claude: { sessionPct: 82, resetsAt: '2026-11-24T15:00:00Z' } });
  assert.deepEqual(parseUsageJson('{broken'), {});
  assert.deepEqual(parseUsageJson(null), {});
});


test('model-scoped quota windows only count for their model family', async () => {
  const { accountExhausted, freshMaxUsedPct, earliestResetOf, windowAppliesToModel } = await import('../plugin/server/core/quota.mjs');
  const now = Date.parse('2026-11-25T23:00:00Z');
  const account = { family: 'antigravity', windows: [
    { id: 'agy-gemini-models-weekly', usedPct: 17, resetsAt: '2026-12-01T08:59:32Z' },
    { id: 'agy-claude-and-gpt-models-weekly', usedPct: 100, resetsAt: '2026-11-29T10:50:35Z' },
  ] };
  assert.equal(accountExhausted(account, { now, model: 'gemini-4-hydrogen' }), false);
  assert.equal(freshMaxUsedPct(account, now, 'gemini-4-hydrogen'), 17);
  assert.equal(earliestResetOf([account], { now, model: 'gemini-4-hydrogen' }), '2026-12-01T08:59:32Z');
  assert.equal(accountExhausted(account, { now, model: 'claude-sonnet-4-6' }), true);
  assert.equal(accountExhausted(account, { now }), true, 'without a model every window counts');
  assert.equal(windowAppliesToModel({ id: 'session-5h' }, 'gemini-4-hydrogen'), true, 'unscoped windows apply to all models');
});
