import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyProfileFailure, profileIsUnhealthy, recordProfileFailure } from '../src/quota.mjs';
import { resolveProfile } from '../src/models.mjs';

const config = {
  profiles: {
    first: { provider: 'codex', model: 'first' },
    next: { provider: 'muse', model: 'next' },
  },
};

const providers = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'first' }], modes: [] },
  { provider: 'muse', enabled: true, status: 'ready', models: [{ id: 'next' }], modes: [] },
];

test('classifyProfileFailure recognizes capacity, quota, limit and auth failures', () => {
  assert.equal(classifyProfileFailure('503 MODEL_CAPACITY_EXHAUSTED'), 'capacity');
  assert.equal(classifyProfileFailure('quota exceeded'), 'quota');
  assert.equal(classifyProfileFailure('429 rate limit exceeded'), 'limit');
  assert.equal(classifyProfileFailure('401 unauthorized'), 'auth');
  assert.equal(classifyProfileFailure('connection reset'), 'other');
});

test('recordProfileFailure creates a ten-minute unhealthy mark', () => {
  const now = Date.parse('2026-11-24T10:00:00.000Z');
  const record = recordProfileFailure('first', '503 MODEL_CAPACITY_EXHAUSTED', { now });
  assert.equal(record.class, 'capacity');
  assert.equal(record.reason, 'recently failed: capacity');
  assert.equal(record.unhealthyUntil, '2026-11-24T10:10:00.000Z');
  assert.equal(profileIsUnhealthy({ first: record }, 'first', now + 9 * 60_000), true);
  assert.equal(profileIsUnhealthy({ first: record }, 'first', now + 10 * 60_000), false);
});

test('resolveProfile skips recently failed profiles and returns the next entry', () => {
  const now = Date.parse('2026-11-24T10:00:00.000Z');
  const record = recordProfileFailure('first', '503 MODEL_CAPACITY_EXHAUSTED', { now });
  const result = resolveProfile(config, providers, ['first', 'next'], {
    role: 'worker',
    repoPublic: true,
    profileHealth: { first: record },
    now: now + 60_000,
  });
  assert.equal(result.profile.name, 'next');
  assert.deepEqual(result.skipped, [{ name: 'first', reason: 'recently failed: capacity' }]);
});
