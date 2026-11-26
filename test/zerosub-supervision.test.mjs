// ZeroSub supervision (Package A): fake-state unit tests for the wait-zerosub
// coexistence decision and the exhausted-quota
// wake time. Never touches the live RPC: all state is built by the helpers
// below, in the style of zerosub.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeZerosubState } from '../plugin/server/core/zerosub.mjs';
import {
  SUPERVISION_DEFAULTS,
  exhaustedWakeDecision,
  planWake,
  zerosubMoveDecision,
  zerosubPendingTarget,
} from '../plugin/server/core/supervision.mjs';
import { LABEL } from '../plugin/server/core/paseo.mjs';
import {
  accountForAgent,
  allAccountsExhausted,
  earliestReset,
} from '../plugin/server/core/quota.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const RESET_5H = '2026-11-24T15:00:00Z';
const RESET_LATE = '2026-11-24T18:00:00Z';
const RESET_WEEK = '2026-11-30T12:00:00Z';
const PAST = '2026-11-20T12:00:00Z';

function account(id, fiveHourPct, { family = 'claude', resetsAt = RESET_5H, status = 'active', limitedUntil = null } = {}) {
  return {
    id, family, label: id, kind: 'oauth', plan: 'pro',
    status, isDefault: false, limitedUntil,
    usage: {
      fetchedAt: '2026-11-24T11:59:00Z',
      windows: [{ id: 'five_hour', label: '5h', usedPercent: fiveHourPct, resetsAt }],
      cached: false,
    },
    agentCount: 1,
  };
}

function route(agentId, accountId, pendingAccountId = null) {
  return { agentId, family: 'claude', accountId, pinned: false, pendingAccountId, movable: true };
}

function state(accounts, agents) {
  return normalizeZerosubState({ accounts, agents }, { now: NOW });
}

function scopedAgent(id) {
  return { id, status: 'idle', archivedAt: null, labels: { [LABEL.scope]: 'example/repo', [LABEL.role]: 'worker' } };
}


// ------------------------------------------------- pending-move coexistence

test('zerosubPendingTarget reads the pending move of one agent', () => {
  const zerosub = state(
    [account('acc-old', 99), account('acc-new', 20)],
    [route('steer-e', 'acc-old', 'acc-new')],
  );
  assert.equal(zerosubPendingTarget(zerosub, 'steer-e'), 'acc-new');
  assert.equal(zerosubPendingTarget(zerosub, 'steer-d'), null);
  assert.equal(zerosubPendingTarget(zerosub, null), null);
  assert.equal(zerosubPendingTarget(null, 'steer-e'), null);
});

test('pending move waits until the route clears or 10 minutes pass', () => {
  assert.equal(SUPERVISION_DEFAULTS.zerosubPendingMinutes, 10);
  const zerosub = state(
    [account('acc-old', 99), account('acc-new', 20)],
    [route('steer-e', 'acc-old', 'acc-new')],
  );
  // First sighting (no pendingSince) starts the window now.
  assert.deepEqual(
    zerosubMoveDecision({ zerosub, agentId: 'steer-e', nowMs: NOW }),
    { decision: 'wait-zerosub', pending: 'acc-new', waitUntilMs: NOW + 10 * 60_000 },
  );
  // Recent sighting keeps waiting.
  const waiting = zerosubMoveDecision({ zerosub, agentId: 'steer-e', pendingSince: NOW - 9 * 60_000, nowMs: NOW });
  assert.equal(waiting.decision, 'wait-zerosub');
  assert.equal(waiting.waitUntilMs, NOW + 60_000);
  // ISO stamps work as well.
  const iso = zerosubMoveDecision({
    zerosub, agentId: 'steer-e',
    pendingSince: new Date(NOW - 9 * 60_000).toISOString(), nowMs: NOW,
  });
  assert.equal(iso.decision, 'wait-zerosub');
  // After the timeout supervision proceeds (the move is assumed stuck).
  assert.deepEqual(
    zerosubMoveDecision({ zerosub, agentId: 'steer-e', pendingSince: NOW - 10 * 60_000, nowMs: NOW }),
    { decision: 'proceed', pending: 'acc-new', reason: 'zerosub-timeout' },
  );
  // A custom timeout wins; an invalid one falls back to the default.
  assert.equal(
    zerosubMoveDecision({ zerosub, agentId: 'steer-e', pendingSince: NOW - 2 * 60_000, nowMs: NOW, zerosubPendingMinutes: 1 }).decision,
    'proceed',
  );
  assert.equal(
    zerosubMoveDecision({ zerosub, agentId: 'steer-e', pendingSince: NOW - 2 * 60_000, nowMs: NOW, zerosubPendingMinutes: -1 }).decision,
    'wait-zerosub',
  );
});

test('no pending move proceeds; cleared routes proceed', () => {
  const zerosub = state(
    [account('acc-old', 99), account('acc-new', 20)],
    [route('steer-e', 'acc-old', 'acc-new')],
  );
  assert.deepEqual(
    zerosubMoveDecision({ zerosub, agentId: 'steer-d', nowMs: NOW }),
    { decision: 'proceed', pending: null, reason: 'no-pending-move' },
  );
  assert.equal(zerosubMoveDecision({ zerosub: null, agentId: 'steer-e', nowMs: NOW }).decision, 'proceed');
  const moved = state(
    [account('acc-old', 99), account('acc-new', 20)],
    [route('steer-e', 'acc-new')],
  );
  assert.deepEqual(moved.pending, {});
  assert.equal(zerosubMoveDecision({ zerosub: moved, agentId: 'steer-e', nowMs: NOW }).decision, 'proceed');
});

test('planWake defers as wait-zerosub while the move is in flight', () => {
  const zerosub = state(
    [account('acc-old', 99), account('acc-new', 20)],
    [route('agent-1', 'acc-old', 'acc-new')],
  );
  const agent = scopedAgent('agent-1');
  assert.deepEqual(
    planWake({ agent, newState: 'blocked', nowMs: NOW, zerosub }),
    { action: 'defer', reason: 'wait-zerosub' },
  );
  // After the timeout the wake goes out.
  assert.deepEqual(
    planWake({ agent, newState: 'blocked', nowMs: NOW, zerosub, zerosubPendingSince: NOW - 11 * 60_000 }),
    { action: 'immediate', reason: 'blocked' },
  );
  // Moves of other agents do not defer this wake.
  assert.deepEqual(
    planWake({ agent: scopedAgent('agent-2'), newState: 'blocked', nowMs: NOW, zerosub }),
    { action: 'immediate', reason: 'blocked' },
  );
  // Without ZeroSub state the order is unchanged.
  assert.deepEqual(
    planWake({ agent, newState: 'blocked', nowMs: NOW }),
    { action: 'immediate', reason: 'blocked' },
  );
});

test('planWake keeps ineligible, quiet and not-actionable ahead of the zerosub wait', () => {
  const zerosub = state(
    [account('acc-old', 99), account('acc-new', 20)],
    [route('agent-1', 'acc-old', 'acc-new')],
  );
  const agent = scopedAgent('agent-1');
  assert.deepEqual(
    planWake({ agent: { id: 'agent-1', labels: {} }, newState: 'blocked', nowMs: NOW, zerosub }),
    { action: 'skip', reason: 'ineligible' },
  );
  assert.deepEqual(
    planWake({ agent, newState: 'blocked', nowMs: NOW, zerosub, draining: true }),
    { action: 'skip', reason: 'drain' },
  );
  assert.deepEqual(
    planWake({ agent, newState: 'running', nowMs: NOW, zerosub }),
    { action: 'skip', reason: 'not-actionable' },
  );
});

// ------------------------------------------------------- exhausted-quota wake

test('accountForAgent and allAccountsExhausted read the fake state', () => {
  const zerosub = state(
    [account('acc-a', 99), account('acc-b', 40)],
    [route('steer-d', 'acc-a')],
  );
  assert.equal(accountForAgent(zerosub, 'steer-d').id, 'acc-a');
  assert.equal(accountForAgent(zerosub, 'steer-x'), null);
  assert.equal(accountForAgent(null, 'steer-d'), null);
  assert.equal(allAccountsExhausted(zerosub, { now: NOW }), false);
  const full = state([account('acc-a', 99), account('acc-b', 95)], []);
  assert.equal(allAccountsExhausted(full, { now: NOW }), true);
  assert.equal(allAccountsExhausted(state([], []), { now: NOW }), false);
  assert.equal(allAccountsExhausted(null), false);
});

test('earliestReset spans all accounts and ignores past stamps', () => {
  const zerosub = state(
    [
      account('acc-a', 99, { resetsAt: RESET_LATE }),
      account('acc-b', 95, { resetsAt: RESET_5H }),
      account('acc-codex', 10, { family: 'codex', resetsAt: RESET_WEEK }),
    ],
    [],
  );
  assert.equal(earliestReset(zerosub, { now: NOW }), RESET_5H);
  const past = state([account('acc-a', 99, { resetsAt: PAST })], []);
  assert.equal(earliestReset(past, { now: NOW }), null);
  assert.equal(earliestReset(null, { now: NOW }), null);
});

test('all accounts exhausted: wake at the earliest resetsAt instead of polling', () => {
  const zerosub = state(
    [
      account('acc-a', 99, { resetsAt: RESET_LATE }),
      account('acc-b', 95, { resetsAt: RESET_5H }),
      account('acc-codex', 99, { family: 'codex', resetsAt: RESET_WEEK }),
    ],
    [],
  );
  assert.deepEqual(
    exhaustedWakeDecision({ zerosub, now: NOW }),
    { decision: 'wait-reset', reason: 'all-accounts-exhausted', wakeAt: RESET_5H },
  );
  // One account with room keeps the legacy behavior.
  const roomy = state([account('acc-a', 99), account('acc-b', 40)], []);
  assert.deepEqual(
    exhaustedWakeDecision({ zerosub: roomy, now: NOW }),
    { decision: 'proceed', reason: 'has-room', wakeAt: null },
  );
  assert.deepEqual(
    exhaustedWakeDecision({ zerosub: null, now: NOW }),
    { decision: 'proceed', reason: 'no-zerosub', wakeAt: null },
  );
});

test('exhausted wake can scope to one family', () => {
  const zerosub = state(
    [
      account('acc-a', 99, { resetsAt: RESET_LATE }),
      account('acc-b', 99, { resetsAt: RESET_5H }),
      account('acc-codex', 10, { family: 'codex', resetsAt: RESET_WEEK }),
    ],
    [],
  );
  assert.deepEqual(
    exhaustedWakeDecision({ zerosub, family: 'claude', now: NOW }),
    { decision: 'wait-reset', reason: 'family-exhausted:claude', wakeAt: RESET_5H },
  );
  assert.deepEqual(
    exhaustedWakeDecision({ zerosub, family: 'codex', now: NOW }),
    { decision: 'proceed', reason: 'has-room', wakeAt: null },
  );
  // An unknown family has no accounts, so nothing is exhausted.
  assert.equal(exhaustedWakeDecision({ zerosub, family: 'gemini', now: NOW }).reason, 'has-room');
});

test('exhausted without a future reset proceeds (nothing to wait for)', () => {
  const zerosub = state(
    [account('acc-a', 99, { resetsAt: null }), account('acc-b', 95, { resetsAt: null })],
    [],
  );
  assert.deepEqual(
    exhaustedWakeDecision({ zerosub, now: NOW }),
    { decision: 'proceed', reason: 'no-reset-known', wakeAt: null },
  );
  // Expired windows are stale, not exhausted: nothing waits for them.
  const stale = state(
    [account('acc-a', 99, { resetsAt: PAST }), account('acc-b', 95, { resetsAt: PAST })],
    [],
  );
  assert.deepEqual(
    exhaustedWakeDecision({ zerosub: stale, now: NOW }),
    { decision: 'proceed', reason: 'has-room', wakeAt: null },
  );
  const limited = state(
    [account('acc-a', 10, { status: 'limited', limitedUntil: RESET_5H, resetsAt: PAST })],
    [],
  );
  assert.deepEqual(
    exhaustedWakeDecision({ zerosub: limited, now: NOW }),
    { decision: 'wait-reset', reason: 'all-accounts-exhausted', wakeAt: RESET_5H },
  );
});
