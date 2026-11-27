// ZeroSub account integration (first slice): pure unit tests with fake state.
// Never touches the live RPC: readZerosubState is only exercised with an
// injected client factory.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeZerosubState, readZerosubState } from '../plugin/server/core/zerosub.mjs';
import { resolveProfile } from '../plugin/server/core/models.mjs';
import { failoverChain } from '../plugin/server/core/supervision.mjs';
import { accountExhausted, bestFamilyAccount, earliestFamilyReset, familyExhausted, formatQuotaLine } from '../plugin/server/core/quota.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const FUTURE_5H = '2026-11-24T15:00:00Z';
const FUTURE_WEEK = '2026-11-30T12:00:00Z';
const PAST = '2026-11-20T12:00:00Z';

// Fake `zerosub.state` payload (shape only, no real data).
function fakeRaw() {
  return {
    accounts: [
      {
        id: 'acc-roomy', family: 'claude', label: 'Roomy', kind: 'oauth', plan: 'pro',
        status: 'active', isDefault: true, limitedUntil: null,
        email: 'someone@example.test', organization: 'Example', home: '/home/someone',
        usage: {
          fetchedAt: '2026-11-24T11:59:00Z',
          windows: [
            { id: 'five_hour', label: '5h', usedPercent: 20, resetsAt: FUTURE_5H },
            { id: 'seven_day', label: 'week', usedPercent: 55, resetsAt: FUTURE_WEEK },
          ],
          cached: false,
        },
        agentCount: 2,
      },
      {
        id: 'acc-full', family: 'claude', label: 'Full', kind: 'oauth', plan: 'pro',
        status: 'limited', isDefault: false, limitedUntil: FUTURE_5H,
        usage: {
          fetchedAt: '2026-11-24T11:59:00Z',
          windows: [{ id: 'five_hour', label: '5h', usedPercent: 99, resetsAt: FUTURE_5H }],
          cached: false,
        },
        agentCount: 1,
      },
      {
        id: 'acc-codex', family: 'codex', label: 'Codex', kind: 'token', plan: 'team',
        status: 'active', isDefault: true, limitedUntil: null,
        usage: {
          fetchedAt: '2026-11-24T11:59:00Z',
          windows: [{ id: 'primary', label: 'primary', usedPercent: 10, resetsAt: FUTURE_WEEK }],
          cached: true,
        },
        agentCount: 0,
      },
    ],
    agents: [
      { agentId: 'steer-d', family: 'claude', accountId: 'acc-full', pinned: false, pendingAccountId: null, movable: true },
      { agentId: 'steer-e', family: 'claude', accountId: 'acc-full', pinned: true, pendingAccountId: 'acc-roomy', movable: true },
      { agentId: 'steer-f', family: 'claude', accountId: 'acc-roomy', pinned: false, pendingAccountId: null, movable: true },
    ],
    logins: [{ id: 'login-1' }],
    providers: { claude: { ok: true } },
  };
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

test('normalizeZerosubState maps accounts, routes and pending moves', () => {
  const state = normalizeZerosubState(fakeRaw(), { now: NOW });
  assert.equal(state.accounts.length, 3);
  const roomy = state.accounts.find((account) => account.id === 'acc-roomy');
  assert.deepEqual(roomy, {
    id: 'acc-roomy', family: 'claude', label: 'Roomy', status: 'active', limitedUntil: null,
    windows: [
      { id: 'five_hour', minutes: 300, usedPct: 20, resetsAt: FUTURE_5H },
      { id: 'seven_day', usedPct: 55, resetsAt: FUTURE_WEEK },
    ],
    sampledAt: '2026-11-24T11:59:00Z', maxUsedPct: 55, exhausted: false,
  });
  const full = state.accounts.find((account) => account.id === 'acc-full');
  assert.equal(full.maxUsedPct, 99);
  assert.equal(full.exhausted, true);
  assert.deepEqual(state.agentAccount, { 'steer-d': 'acc-full', 'steer-e': 'acc-full', 'steer-f': 'acc-roomy' });
  assert.deepEqual(state.pending, { 'steer-e': 'acc-roomy' });
  assert.deepEqual(state.waiting, {});
  assert.equal(state.version, null);
});

test('normalizeZerosubState drops email/organization/home and tolerates missing fields', () => {
  const state = normalizeZerosubState(fakeRaw(), { now: NOW });
  assert.equal(JSON.stringify(state).includes('someone@example.test'), false);
  assert.equal(JSON.stringify(state).includes('Example'), false);
  assert.equal(JSON.stringify(state).includes('/home/someone'), false);
  assert.deepEqual(normalizeZerosubState(null), { accounts: [], agentAccount: {}, pending: {}, waiting: {}, version: null });
  assert.deepEqual(normalizeZerosubState({}), { accounts: [], agentAccount: {}, pending: {}, waiting: {}, version: null });
  assert.deepEqual(normalizeZerosubState({ accounts: [null, { label: 'no id' }, { id: 'a1' }] }, { now: NOW }), {
    accounts: [{ id: 'a1', family: '', label: '', status: '', limitedUntil: null, windows: [], maxUsedPct: null, exhausted: false }],
    agentAccount: {},
    pending: {},
    waiting: {},
    version: null,
  });
  const past = normalizeZerosubState({ accounts: [{ id: 'a2', status: 'active', limitedUntil: PAST }] }, { now: NOW });
  assert.equal(past.accounts[0].exhausted, false);
});

test('normalizeZerosubState keeps version, waiting and model windows', () => {
  const raw = fakeRaw();
  raw.version = '2';
  raw.agents[1].waiting = 'restart';
  raw.agents[2].waiting = 'bogus';
  raw.accounts[0].usage.windows.push({ id: 'opus-only', usedPercent: 10, resetsAt: FUTURE_5H, models: ['opus', ''] });
  raw.accounts[0].usage.windows.push({ id: 'sonnet-only', usedPercent: 10, resetsAt: FUTURE_5H, model: 'sonnet' });
  const state = normalizeZerosubState(raw, { now: NOW });
  assert.equal(state.version, '2');
  assert.deepEqual(state.waiting, { 'steer-e': 'restart' });
  const roomy = state.accounts.find((account) => account.id === 'acc-roomy');
  assert.deepEqual(roomy.windows[2], { id: 'opus-only', usedPct: 10, resetsAt: FUTURE_5H, models: ['opus'] });
  assert.deepEqual(roomy.windows[3], { id: 'sonnet-only', usedPct: 10, resetsAt: FUTURE_5H, models: ['sonnet'] });
  assert.equal('models' in roomy.windows[0], false);
});

test('normalizeZerosubState excludes expired windows from maxUsedPct', () => {
  const raw = fakeRaw();
  raw.accounts[0].usage.windows = [
    { id: 'five_hour', label: '5h', usedPercent: 99, resetsAt: PAST },
    { id: 'seven_day', label: 'week', usedPercent: 20, resetsAt: FUTURE_WEEK },
  ];
  const state = normalizeZerosubState(raw, { now: NOW });
  const roomy = state.accounts.find((account) => account.id === 'acc-roomy');
  assert.equal(roomy.maxUsedPct, 20);
  assert.equal(roomy.windows.length, 2);
  const stale = normalizeZerosubState(
    { accounts: [{ id: 'a-stale', usage: { windows: [{ id: 'w', usedPercent: 99, resetsAt: PAST }] } }] },
    { now: NOW },
  );
  assert.equal(stale.accounts[0].maxUsedPct, null);
});

test('readZerosubState normalizes RPC output and returns null on any failure', async () => {
  const factory = async () => ({
    calls: [],
    async invokePluginRpc(pluginId, method, input) {
      this.calls.push([pluginId, method, input]);
      return fakeRaw();
    },
    async close() {},
  });
  const client = await factory();
  const state = await readZerosubState({ createClient: async () => client });
  assert.equal(state.accounts.length, 3);
  assert.deepEqual(client.calls, [['zerosub', 'zerosub.state', {}]]);
  assert.equal(await readZerosubState({ createClient: async () => { throw new Error('no daemon'); } }), null);
  assert.equal(await readZerosubState({
    createClient: async () => ({ invokePluginRpc: async () => { throw new Error('no such plugin'); }, close: async () => {} }),
  }), null);
});

test('resolveProfile prefers the account with the most room', () => {
  const zerosub = normalizeZerosubState(fakeRaw(), { now: NOW });
  const picked = resolveProfile(CONFIG, PROVIDERS, ['sonnet', 'codex'], { role: 'worker', repoPublic: true, zerosub, now: NOW });
  assert.equal(picked.profile.name, 'sonnet');
  assert.equal(picked.zerosubAccount, 'acc-roomy');
  assert.equal(bestFamilyAccount(zerosub, 'claude', { now: NOW }).id, 'acc-roomy');
  // A family without accounts keeps the usage-snapshot behavior.
  const rawNoCodex = fakeRaw();
  rawNoCodex.accounts = rawNoCodex.accounts.filter((account) => account.family !== 'codex');
  const withoutCodex = normalizeZerosubState(rawNoCodex, { now: NOW });
  const snapshot = resolveProfile(CONFIG, PROVIDERS, ['codex'], {
    role: 'worker', repoPublic: true, zerosub: withoutCodex, quotaSnapshot: { codex: { sessionPct: 95 } }, now: NOW,
  });
  assert.equal(snapshot.profile, null);
  assert.equal(snapshot.skipped[0].reason, 'pool exhausted');
});

test('resolveProfile skips a family whose accounts are all exhausted', () => {
  const raw = fakeRaw();
  raw.accounts[0].usage.windows[0].usedPercent = 95;
  raw.accounts[0].usage.windows[1].usedPercent = 96;
  const zerosub = normalizeZerosubState(raw, { now: NOW });
  assert.equal(familyExhausted(zerosub, 'claude', { now: NOW }), true);
  assert.equal(accountExhausted(zerosub.accounts[0], { now: NOW }), true);
  const picked = resolveProfile(CONFIG, PROVIDERS, ['sonnet', 'codex'], { role: 'worker', repoPublic: true, zerosub, now: NOW });
  assert.equal(picked.profile.name, 'codex');
  assert.match(picked.skipped[0].reason, /^accounts exhausted, earliest reset /);
});

test('all-exhausted families report the earliest resetsAt', () => {
  const raw = fakeRaw();
  raw.accounts[0].usage.windows[0].usedPercent = 95;
  raw.accounts[0].usage.windows[1].usedPercent = 96;
  raw.accounts[0].usage.windows[0].resetsAt = '2026-11-24T18:00:00Z';
  raw.accounts[0].usage.windows[1].resetsAt = '2026-11-24T14:00:00Z';
  const zerosub = normalizeZerosubState(raw, { now: NOW });
  assert.equal(earliestFamilyReset(zerosub, 'claude', { now: NOW }), '2026-11-24T14:00:00Z');
  const picked = resolveProfile(CONFIG, PROVIDERS, ['sonnet'], { role: 'worker', repoPublic: true, zerosub, now: NOW });
  assert.equal(picked.profile, null);
  assert.equal(picked.skipped[0].reason, 'accounts exhausted, earliest reset 2026-11-24T14:00:00Z');
});

test('failoverChain retains candidate slots for route admission', () => {
  const steers = [
    { id: 'steer-d', slot: 'D', provider: 'claude' },
    { id: 'steer-e', slot: 'E', provider: 'claude' },
    { id: 'steer-f', slot: 'F', provider: 'claude' },
  ];
  const chain = failoverChain({ steers, activeSlot: 'D' });
  assert.deepEqual(chain.map((candidate) => candidate.steerId), ['steer-e', 'steer-f']);
});

test('quota line uses real account percents with ZeroSub state', () => {
  const zerosub = normalizeZerosubState(fakeRaw(), { now: NOW });
  assert.equal(
    formatQuotaLine(CONFIG, null, { agent: { id: 'steer-d', provider: 'claude', model: 'sonnet' }, zerosub, now: NOW }),
    'Quota: claude (acc-full) 99% used — prefer acc-roomy',
  );
  assert.equal(formatQuotaLine(CONFIG, null, { currentPool: 'codex', zerosub, now: NOW }), null);
});

test('behavior without ZeroSub state is unchanged', () => {
  const legacy = resolveProfile(CONFIG, PROVIDERS, ['sonnet', 'codex'], {
    role: 'worker', repoPublic: true, quotaSnapshot: { claude: { sessionPct: 95 }, codex: { sessionPct: 10 } },
  });
  assert.equal(legacy.profile.name, 'codex');
  assert.equal(legacy.skipped[0].reason, 'pool exhausted');
  assert.equal(legacy.zerosubAccount, null);
  const chain = failoverChain({
    steers: [{ id: 'b', slot: 'B', provider: 'claude' }, { id: 'c', slot: 'C', provider: 'codex' }],
    activeSlot: 'A', failingPool: 'claude',
  });
  assert.deepEqual(chain.map((candidate) => candidate.steerId), ['c', 'b']);
  assert.equal(formatQuotaLine(CONFIG, { claude: { sessionPct: 74 } }), null);
});
