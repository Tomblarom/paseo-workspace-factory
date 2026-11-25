// worker list/pick agreement: both derive from resolveWorkerPick plus the same
// quota/ZeroSub snapshot, so the list marks the profile pick would return and
// skipped rows show the pick skip reason. Table over ZeroSub states.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWorkerPick, workerListRows } from '../src/models.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const RESET = '2026-11-24T15:00:00Z';

const CONFIG = {
  version: 1,
  github: { owner: 'Test', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/tmp/test',
  workspaceTitle: 'Main',
  quota: { warnPct: 75, exhaustedPct: 90 },
  profiles: {
    primary: { provider: 'claude', model: 'sonnet' },
    fallback: { provider: 'codex', model: 'gpt' },
  },
  steers: { slots: { A: 'primary' }, prepare: ['A'], initialActive: 'A' },
  workers: { priority: ['primary', 'fallback'], defaultProfile: 'primary' },
};

const PROVIDERS = [
  { provider: 'claude', enabled: true, status: 'ready', models: [{ id: 'sonnet', thinkingOptions: [] }], modes: [] },
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt', thinkingOptions: [] }], modes: [] },
];

function account(id, family, usedPct) {
  return {
    id, family, label: id, status: 'active', limitedUntil: null,
    windows: [{ id: 'five_hour', usedPct, resetsAt: RESET }],
    maxUsedPct: usedPct, exhausted: false,
  };
}

function zerosub(...accounts) {
  return { accounts, agentAccount: {}, pending: {}, waiting: {}, version: null };
}

const CASES = [
  {
    name: 'first profile exhausted',
    zerosub: zerosub(account('a1', 'claude', 95), account('b1', 'codex', 10)),
    quotaSnapshot: null,
    expectPick: 'fallback',
    expectReason: /^accounts exhausted, earliest reset 2026-11-24T15:00:00Z$/,
  },
  {
    name: 'unknown quota',
    zerosub: null,
    quotaSnapshot: null,
    expectPick: 'primary',
    expectReason: null,
  },
  {
    name: 'all exhausted',
    zerosub: zerosub(account('a1', 'claude', 95), account('b1', 'codex', 99)),
    quotaSnapshot: null,
    expectPick: null,
    expectReason: /^accounts exhausted, earliest reset /,
  },
  {
    name: 'healthy',
    zerosub: zerosub(account('a1', 'claude', 20), account('b1', 'codex', 10)),
    quotaSnapshot: { claude: { sessionPct: 20 }, codex: { sessionPct: 10 } },
    expectPick: 'primary',
    expectReason: null,
  },
];

for (const { name, zerosub: snapshot, quotaSnapshot, expectPick, expectReason } of CASES) {
  test(`list and pick agree: ${name}`, () => {
    const selection = resolveWorkerPick(CONFIG, PROVIDERS, {
      repoPublic: true, quotaSnapshot, zerosub: snapshot, now: NOW,
    });
    assert.equal(selection.profile?.name ?? null, expectPick, `${name}: pick`);
    const rows = workerListRows(CONFIG, PROVIDERS, selection);
    assert.equal(rows.length, 2);
    const marked = rows.find((row) => row.chosen)?.profile ?? null;
    assert.equal(marked, expectPick, `${name}: list marks the pick`);
    for (const skipped of selection.skipped) {
      const row = rows.find((r) => r.profile === skipped.name);
      assert.ok(row, `${name}: skipped ${skipped.name} has a row`);
      assert.equal(row.startable, false, `${name}: skipped row is not startable`);
      assert.equal(row.issues[0], skipped.reason, `${name}: skipped row shows the pick reason`);
    }
    const pickedRow = rows.find((row) => row.profile === expectPick);
    if (expectPick) {
      assert.equal(pickedRow.startable, true, `${name}: picked row is startable`);
      assert.deepEqual(pickedRow.issues, [], `${name}: picked row has no issues`);
    } else {
      assert.ok(rows.every((row) => !row.chosen), `${name}: no row marked when nothing is pickable`);
      assert.ok(rows.every((row) => !row.startable), `${name}: every row blocked when all exhausted`);
    }
    if (expectReason) {
      assert.match(rows[0].issues[0], expectReason, `${name}: first row carries the reset reason`);
    }
  });
}

test('pool exhaustion without ZeroSub also agrees (quota snapshot path)', () => {
  const selection = resolveWorkerPick(CONFIG, PROVIDERS, {
    repoPublic: true, quotaSnapshot: { claude: { sessionPct: 95 }, codex: { sessionPct: 10 } }, zerosub: null, now: NOW,
  });
  assert.equal(selection.profile?.name, 'fallback');
  const rows = workerListRows(CONFIG, PROVIDERS, selection);
  assert.equal(rows.find((row) => row.chosen)?.profile, 'fallback');
  assert.equal(rows[0].startable, false);
  assert.equal(rows[0].issues[0], 'pool exhausted');
});
