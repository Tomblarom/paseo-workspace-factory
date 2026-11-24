import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configWarnings, validateConfig } from '../src/config.mjs';
import { resolveProfile } from '../src/models.mjs';
import { failoverChain } from '../src/supervision.mjs';
import { buildAssignment } from '../src/assign.mjs';
import { buildResumeBrief } from '../src/steer.mjs';
import { formatQuotaLine, parseUsageJson, profilePool } from '../src/quota.mjs';

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
  ], ['a', 'b'], { role: 'worker', quotaSnapshot: { shared: { sessionPct: 90 }, codex: { sessionPct: 10 } } });
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

test('usage JSON parsing is fail-soft and extracts the 5h window', () => {
  const output = JSON.stringify([{ sourceLabel: 'claude', lastSuccessful: { report: { windows: [
    { id: 'five-hour', usedPct: 82, resetsAt: '2026-11-24T15:00:00Z' },
  ] } } }]);
  assert.deepEqual(parseUsageJson(output), { claude: { sessionPct: 82, limitUntil: '2026-11-24T15:00:00Z' } });
  assert.deepEqual(parseUsageJson('{broken'), {});
  assert.deepEqual(parseUsageJson(null), {});
});
