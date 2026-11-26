// ZeroSub flow: fake-state unit tests for pending account moves, continuation
// tabs and informative quota lines. Never touches the live RPC: all
// state is built by the helpers below, in the style of zerosub.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeZerosubState } from '../plugin/server/core/zerosub.mjs';
import { bestFamilyAccount, formatQuotaLine } from '../plugin/server/core/quota.mjs';
import { resolveProfile } from '../plugin/server/core/models.mjs';
import { failoverChain } from '../plugin/server/core/supervision.mjs';
import { buildResumeBrief } from '../plugin/server/core/steer.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const FUTURE_5H = '2026-11-24T15:00:00Z';

function account(id, fiveHourPct) {
  return {
    id, family: 'claude', label: id, kind: 'oauth', plan: 'pro',
    status: 'active', isDefault: false, limitedUntil: null,
    usage: {
      fetchedAt: '2026-11-24T11:59:00Z',
      windows: [{ id: 'five_hour', label: '5h', usedPercent: fiveHourPct, resetsAt: FUTURE_5H }],
      cached: false,
    },
    agentCount: 1,
  };
}

function route(agentId, accountId, pendingAccountId = null) {
  return { agentId, family: 'claude', accountId, pinned: false, pendingAccountId, movable: true };
}

const CONFIG = {
  version: 1, github: { owner: 'Test', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/tmp/test', workspaceTitle: 'Main',
  profiles: {
    sonnet: { provider: 'claude', model: 'sonnet' },
    opus: { provider: 'claude', model: 'opus' },
    codex: { provider: 'codex', model: 'codex' },
  },
  steers: { slots: { D: 'sonnet', E: 'opus', F: 'codex' }, prepare: ['D'], initialActive: 'D' },
  workers: { priority: ['sonnet', 'codex'], defaultProfile: 'sonnet' },
};

const PROVIDERS = [
  { provider: 'claude', enabled: true, status: 'ready', models: [{ id: 'sonnet' }, { id: 'opus' }] },
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'codex' }] },
];

const activeSteer = { slot: 'D', id: 'steer-d', provider: 'claude', model: 'sonnet' };

function briefStatus() {
  return {
    repo: 'example/repo', state: { epoch: 1, activeSteer: 'D' },
    steers: [activeSteer], workers: [], openWorkers: [],
    checkpoint: null, workspace: { id: 'w', directory: '/tmp' },
  };
}

test('pending move: normalized state keeps the current account and the pending target', () => {
  const zerosub = normalizeZerosubState({
    accounts: [account('acc-old', 99), account('acc-new', 20)],
    agents: [route('steer-e', 'acc-old', 'acc-new')],
  }, { now: NOW });
  assert.deepEqual(zerosub.agentAccount, { 'steer-e': 'acc-old' });
  assert.deepEqual(zerosub.pending, { 'steer-e': 'acc-new' });
  // The pending target does not change the family's roomiest account.
  assert.equal(bestFamilyAccount(zerosub, 'claude', { now: NOW }).id, 'acc-new');
});

test('pending move: failover waits until the route shows the new account', () => {
  const zerosub = normalizeZerosubState({
    accounts: [account('acc-old', 99), account('acc-new', 20)],
    agents: [
      route('steer-d', 'acc-old'),
      route('steer-e', 'acc-old', 'acc-new'),
      route('steer-f', 'acc-new'),
    ],
  }, { now: NOW });
  const steers = [
    { id: 'steer-d', slot: 'D', provider: 'claude' },
    { id: 'steer-e', slot: 'E', provider: 'claude' },
    { id: 'steer-f', slot: 'F', provider: 'claude' },
  ];
  // steer-e still runs on the exhausted old account, so it is excluded with it.
  const waiting = failoverChain({ steers, activeSlot: 'D', zerosub, failingAccountId: 'acc-old', now: NOW });
  assert.deepEqual(waiting.map((candidate) => candidate.steerId), ['steer-f']);
  // Structural order carries no quota score; admission checks the actual
  // runtime and pending move before a candidate can receive work.
  const healthy = failoverChain({ steers, activeSlot: 'D', zerosub, failingAccountId: 'acc-new', now: NOW });
  assert.deepEqual(healthy.map((candidate) => candidate.steerId), ['steer-e', 'steer-f']);
  // Completed move (route shows the new account, nothing pending): steer-e
  // survives the old account failing, in structural order.
  const moved = normalizeZerosubState({
    accounts: [account('acc-old', 99), account('acc-new', 20)],
    agents: [
      route('steer-d', 'acc-old'),
      route('steer-e', 'acc-new'),
      route('steer-f', 'acc-new'),
    ],
  }, { now: NOW });
  assert.deepEqual(moved.pending, {});
  const after = failoverChain({ steers, activeSlot: 'D', zerosub: moved, failingAccountId: 'acc-old', now: NOW });
  assert.deepEqual(after.map((candidate) => candidate.steerId), ['steer-e', 'steer-f']);
});

test('continuation tabs count as the same slot: no duplicate failover candidate', () => {
  const steers = [
    { id: 'steer-d', slot: 'D', provider: 'claude' },
    { id: 'steer-e', slot: 'E', provider: 'claude' },
    { id: 'steer-e-tab', slot: 'E', provider: 'claude' },
    { id: 'steer-f', slot: 'F', provider: 'claude' },
  ];
  assert.deepEqual(
    failoverChain({ steers, activeSlot: 'D' }).map((candidate) => candidate.slot),
    ['E', 'F'],
  );
  const zerosub = normalizeZerosubState({
    accounts: [account('acc-a', 80), account('acc-b', 30)],
    agents: [
      route('steer-d', 'acc-a'),
      route('steer-e', 'acc-a'),
      route('steer-e-tab', 'acc-a'),
      route('steer-f', 'acc-b'),
    ],
  }, { now: NOW });
  const chain = failoverChain({ steers, activeSlot: 'D', zerosub, now: NOW });
  assert.deepEqual(chain.map((candidate) => candidate.steerId), ['steer-e', 'steer-f']);
  // Quota cannot choose which duplicate tab owns a slot. Live holder
  // resolution happens before this structural chain is built.
  const split = normalizeZerosubState({
    accounts: [account('acc-a', 80), account('acc-b', 30)],
    agents: [
      route('steer-d', 'acc-a'),
      route('steer-e', 'acc-a'),
      route('steer-e-tab', 'acc-b'),
      route('steer-f', 'acc-a'),
    ],
  }, { now: NOW });
  const roomy = failoverChain({ steers, activeSlot: 'D', zerosub: split, now: NOW });
  assert.deepEqual(roomy.map((candidate) => candidate.steerId), ['steer-e', 'steer-f']);
});

test('below warnPct: no quota line', () => {
  const zerosub = normalizeZerosubState({
    accounts: [account('acc-a', 92), account('acc-b', 40)],
    agents: [route('steer-d', 'acc-a')],
  }, { now: NOW });
  assert.equal(formatQuotaLine(CONFIG, null, { agent: activeSteer, zerosub, now: NOW }), null);
  assert.equal(
    formatQuotaLine(CONFIG, null, { agent: activeSteer, warnPct: 95, zerosub, now: NOW }),
    null,
  );
  const tight = normalizeZerosubState({
    accounts: [account('acc-a', 79), account('acc-b', 40)],
    agents: [route('steer-d', 'acc-a')],
  }, { now: NOW });
  assert.equal(formatQuotaLine(CONFIG, null, { agent: activeSteer, warnPct: 80, zerosub: tight, now: NOW }), null);
  assert.equal(buildResumeBrief(briefStatus(), { config: CONFIG, zerosub, now: () => NOW }).includes('Quota:'), false);
  // Picking a profile for a new worker still prefers the roomiest account;
  // the informative quota line is gated by warnPct.
  const picked = resolveProfile(CONFIG, PROVIDERS, ['sonnet', 'codex'], { role: 'worker', repoPublic: true, zerosub, now: NOW });
  assert.equal(picked.profile.name, 'sonnet');
  assert.equal(picked.zerosubAccount, 'acc-b');
});

test('at warnPct and above: quota line, chain and pick prefer the roomiest account', () => {
  for (const pct of [93, 94]) {
    const zerosub = normalizeZerosubState({
      accounts: [account('acc-a', pct), account('acc-b', 40)],
      agents: [route('steer-d', 'acc-a'), route('steer-e', 'acc-b')],
    }, { now: NOW });
    assert.equal(
      formatQuotaLine(CONFIG, null, { agent: activeSteer, zerosub, now: NOW }),
      `Quota: claude (acc-a) ${pct}% used — prefer acc-b`,
    );
    const chain = failoverChain({
      steers: [
        { id: 'steer-d', slot: 'D', provider: 'claude' },
        { id: 'steer-e', slot: 'E', provider: 'claude' },
      ],
      activeSlot: 'D', zerosub, now: NOW,
    });
    assert.deepEqual(chain.map((candidate) => candidate.steerId), ['steer-e']);
    const picked = resolveProfile(CONFIG, PROVIDERS, ['sonnet', 'codex'], { role: 'worker', repoPublic: true, zerosub, now: NOW });
    assert.equal(picked.zerosubAccount, 'acc-b');
    assert.ok(buildResumeBrief(briefStatus(), { config: CONFIG, zerosub, now: () => NOW }).includes(`Quota: claude (acc-a) ${pct}% used — prefer acc-b`));
  }
  const custom = normalizeZerosubState({
    accounts: [account('acc-a', 80), account('acc-b', 40)],
    agents: [route('steer-d', 'acc-a')],
  }, { now: NOW });
  assert.equal(
    formatQuotaLine(CONFIG, null, { agent: activeSteer, warnPct: 80, zerosub: custom, now: NOW }),
    'Quota: claude (acc-a) 80% used — prefer acc-b',
  );
});
