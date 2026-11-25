import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROFILE_HEALTH_KEY, classifyProfileFailure, profileIsUnhealthy, readProfileHealth, recordProfileFailure, storeProfileFailure } from '../src/quota.mjs';
import { withLock } from '../src/lock.mjs';
import { resolveProfile } from '../src/models.mjs';

const LOCK_TMP = mkdtempSync(join(tmpdir(), 'wsf-profile-health-'));
const testLock = (name, fn) => withLock(name, fn, { dir: LOCK_TMP });
const NOW = Date.parse('2026-11-24T10:00:00.000Z');

/** Fake workspace ref with live metadata and daemon-like shallow top-level patches. */
function fakeClient(metadata) {
  const live = { metadata: structuredClone(metadata) };
  const calls = [];
  return {
    live,
    calls,
    client: {
      workspaces: {
        ref: () => ({
          refresh: async () => ({ metadata: live.metadata }),
          setMetadata: async (patch) => {
            calls.push(Object.keys(patch));
            Object.assign(live.metadata, structuredClone(patch));
          },
        }),
      },
    },
  };
}

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

test('failure write keeps a concurrent switch: the epoch survives', async () => {
  const { live, calls, client } = fakeClient({ wsf: { main: true, activeSteer: 'A', epoch: 1 } });
  const stale = structuredClone(live.metadata); // discovery read before the switch
  assert.equal(stale.wsf.epoch, 1);
  live.metadata.wsf = { ...live.metadata.wsf, activeSteer: 'B', epoch: 2 }; // the switch lands first
  const record = await storeProfileFailure({ client, workspaceId: 'wks_test', profile: 'first', text: '503 MODEL_CAPACITY_EXHAUSTED', lock: testLock, now: NOW });
  assert.equal(record.class, 'capacity');
  assert.equal(live.metadata.wsf.epoch, 2);
  assert.equal(live.metadata.wsf.activeSteer, 'B');
  assert.deepEqual(Object.keys(live.metadata[PROFILE_HEALTH_KEY]), ['first']);
  assert.ok(calls.length > 0, 'health was written');
  assert.ok(calls.every((keys) => keys.length === 1 && keys[0] === PROFILE_HEALTH_KEY), `only the health key is patched, got ${JSON.stringify(calls)}`);
});

test('health reads the top-level key only; nested marks are ignored', () => {
  const nested = recordProfileFailure('first', 'quota exceeded', { now: NOW });
  assert.equal(readProfileHealth({ wsf: { profileHealth: { first: nested } } }), null);
  const current = recordProfileFailure('next', '503 capacity', { now: NOW });
  assert.deepEqual(readProfileHealth({ [PROFILE_HEALTH_KEY]: { next: current } }), { next: current });
  assert.equal(readProfileHealth({ wsf: {} }), null);
  assert.equal(readProfileHealth(null), null);
});
