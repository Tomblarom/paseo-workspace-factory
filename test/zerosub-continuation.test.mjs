// ZeroSub continuation tabs (Package B): fake-state unit tests. A Codex
// account-switch tab carries `zerosub.continued-from=<originId>` (stable
// source id, no copied labels) and/or a `zerosub-switch` timeline row with
// `continuedIn`; the factory moves role/slot to the live tab itself
// (kapybara-org/zerosub#119). Never touches live agents or RPC: all state
// below is built by hand.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCOUNT_METADATA_KEY, ACCOUNT_PIN_METHOD, ACCOUNT_PIN_PLUGIN_ID, CONTINUED_FROM_LABEL,
  continuedFromId, inheritContinuationLabels, normalizeZerosubState,
  resolveContinuations, suggestAccountPin, switchesFromTimeline, latestSwitchRow, parseSwitchData,
} from '../plugin/server/core/zerosub.mjs';
import { applyContinuations, discoverRepository, remapWorkerParents } from '../plugin/server/core/discovery.mjs';
import { resolveProfile } from '../plugin/server/core/models.mjs';
import { steerStatus } from '../plugin/server/core/steer.mjs';
import { LABEL, METADATA_KEY, PARENT_LABEL, parentOf } from '../plugin/server/core/paseo.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const FUTURE_5H = '2026-11-24T15:00:00Z';

// ---------------------------------------------------------------- core

test('continuedFromId reads the stable source id', () => {
  assert.equal(CONTINUED_FROM_LABEL, 'zerosub.continued-from');
  assert.equal(continuedFromId({ labels: { [CONTINUED_FROM_LABEL]: 'agent-o' } }), 'agent-o');
  assert.equal(continuedFromId({ labels: { [CONTINUED_FROM_LABEL]: '  agent-o  ' } }), 'agent-o');
  assert.equal(continuedFromId({ labels: {} }), null);
  assert.equal(continuedFromId({ labels: { [CONTINUED_FROM_LABEL]: '  ' } }), null);
  assert.equal(continuedFromId({ labels: { [CONTINUED_FROM_LABEL]: 42 } }), null);
  assert.equal(continuedFromId(null), null);
});

test('switchesFromTimeline reads the real zerosub-switch plugin row', () => {
  const row = (continuedIn, extra = {}) => ({ item: { type: 'plugin', kind: 'zerosub-switch', version: 1, data: { reason: 'exhausted', outcome: 'continued', continued: true, continuedIn, ...extra } } });
  const ref = (agentId) => ({ agentId, title: 'T' });
  assert.deepEqual(
    switchesFromTimeline('o', { entries: [{ item: { type: 'assistant_message', text: 'hi' } }, row(ref('c1'))] }),
    [{ agentId: 'o', continuedIn: 'c1' }],
  );
  // Last row wins; continuedIn also counts with outcome 'stayed'.
  assert.deepEqual(
    switchesFromTimeline('o', { entries: [row(ref('c1')), row(ref('c2'), { outcome: 'stayed' })] }),
    [{ agentId: 'o', continuedIn: 'c2' }],
  );
  // Old flat shape, other kinds, empty targets and self references are ignored.
  assert.deepEqual(switchesFromTimeline('o', { entries: [{ item: { type: 'zerosub-switch', continuedIn: 'c1' } }] }), []);
  assert.deepEqual(switchesFromTimeline('o', { entries: [{ item: { type: 'plugin', kind: 'other', data: { continuedIn: ref('c1') } } }] }), []);
  assert.deepEqual(switchesFromTimeline('o', { entries: [row(null), row(ref('  ')), row(ref('o'))] }), []);
  assert.deepEqual(switchesFromTimeline('o', null), []);
  assert.deepEqual(switchesFromTimeline('o', { entries: 'nope' }), []);
  assert.deepEqual(switchesFromTimeline('', { entries: [row(ref('c1'))] }), []);
  assert.equal(latestSwitchRow({ entries: [row(ref('c1'), { detail: 'x', family: 'claude', futureField: 1 })] }).continuedIn, 'c1');
  assert.equal(parseSwitchData({ reason: 'new-reason', detail: 'ignored' }).continued, false);
  assert.equal('detail' in parseSwitchData({ detail: 'x' }), false);
});

test('resolveContinuations follows label chains, skips archived/dangling/cyclic edges', () => {
  const agent = (id, labels = {}, extra = {}) => ({ id, status: 'idle', archivedAt: null, labels, ...extra });
  const pair = [agent('o'), agent('c', { [CONTINUED_FROM_LABEL]: 'o' })];
  assert.deepEqual(resolveContinuations(pair), { liveFor: { o: 'c' }, superseded: ['o'], live: ['c'] });
  // Chains resolve transitively to the final live tab.
  const chain = [agent('a'), agent('b', { [CONTINUED_FROM_LABEL]: 'a' }), agent('c', { [CONTINUED_FROM_LABEL]: 'b' })];
  assert.deepEqual(resolveContinuations(chain).liveFor, { a: 'c', b: 'c' });
  // An archived tab never supersedes its origin.
  assert.deepEqual(resolveContinuations([agent('o'), agent('c', { [CONTINUED_FROM_LABEL]: 'o' }, { archivedAt: '2026-11-24T10:00:00Z' })]), {
    liveFor: {}, superseded: [], live: [],
  });
  // Dangling, self-referencing and cyclic edges are ignored.
  assert.deepEqual(resolveContinuations([agent('c', { [CONTINUED_FROM_LABEL]: 'missing' })]).liveFor, {});
  assert.deepEqual(resolveContinuations([agent('c', { [CONTINUED_FROM_LABEL]: 'c' })]).liveFor, {});
  const cycle = [agent('a', { [CONTINUED_FROM_LABEL]: 'b' }), agent('b', { [CONTINUED_FROM_LABEL]: 'a' })];
  assert.deepEqual(resolveContinuations(cycle), { liveFor: {}, superseded: [], live: [] });
  // Several live continuations of one origin resolve deterministically.
  const multi = [agent('o'), agent('c2', { [CONTINUED_FROM_LABEL]: 'o' }), agent('c1', { [CONTINUED_FROM_LABEL]: 'o' })];
  assert.deepEqual(resolveContinuations(multi).liveFor, { o: 'c1' });
});

test('resolveContinuations merges timeline switches, labels win conflicts', () => {
  const agent = (id) => ({ id, status: 'idle', archivedAt: null, labels: {} });
  const agents = [agent('o'), agent('t')];
  assert.deepEqual(resolveContinuations(agents, [{ agentId: 'o', continuedIn: 't' }]).liveFor, { o: 't' });
  // Unknown ids, archived targets and malformed pairs are ignored.
  assert.deepEqual(resolveContinuations(agents, [{ agentId: 'o', continuedIn: 'missing' }]).liveFor, {});
  assert.deepEqual(resolveContinuations(agents, [{ agentId: 'missing', continuedIn: 't' }]).liveFor, {});
  assert.deepEqual(resolveContinuations([agent('o'), { ...agent('t'), archivedAt: '2026-11-24T10:00:00Z' }], [{ agentId: 'o', continuedIn: 't' }]).liveFor, {});
  assert.deepEqual(resolveContinuations(agents, [null, {}, { agentId: 'o' }]).liveFor, {});
  // The label is the stable signal and wins a conflicting switch row ...
  const conflict = [agent('o'), { ...agent('c1'), labels: { [CONTINUED_FROM_LABEL]: 'o' } }, agent('c2')];
  assert.deepEqual(resolveContinuations(conflict, [{ agentId: 'o', continuedIn: 'c2' }]).liveFor, { o: 'c1' });
  // ... while mixed label/switch chains still resolve transitively.
  const mixed = [agent('o'), { ...agent('c1'), labels: { [CONTINUED_FROM_LABEL]: 'o' } }, agent('c2')];
  assert.deepEqual(resolveContinuations(mixed, [{ agentId: 'c1', continuedIn: 'c2' }]).liveFor, { o: 'c2', c1: 'c2' });
});

test('inheritContinuationLabels fills missing keys, live labels win', () => {
  const live = { id: 'c', labels: { [CONTINUED_FROM_LABEL]: 'o', [LABEL.slot]: 'F' } };
  const origin = { id: 'o', labels: { [LABEL.repo]: 'proj', [LABEL.scope]: 'proj', [LABEL.role]: 'steer', [LABEL.slot]: 'E', [PARENT_LABEL]: 'p' } };
  assert.deepEqual(inheritContinuationLabels(live, origin), {
    [CONTINUED_FROM_LABEL]: 'o', [LABEL.slot]: 'F',
    [LABEL.repo]: 'proj', [LABEL.scope]: 'proj', [LABEL.role]: 'steer', [PARENT_LABEL]: 'p',
  });
  assert.deepEqual(inheritContinuationLabels(null, null), {});
});

test('suggestAccountPin names the roomiest account with creation metadata', () => {
  const zerosub = normalizeZerosubState({
    accounts: [
      { id: 'acc-full', family: 'claude', status: 'limited', usage: { windows: [{ id: 'five_hour', usedPercent: 99, resetsAt: FUTURE_5H }] } },
      { id: 'acc-roomy', family: 'claude', status: 'active', usage: { windows: [{ id: 'five_hour', usedPercent: 20, resetsAt: FUTURE_5H }] } },
    ],
    agents: [],
  }, { now: NOW });
  assert.deepEqual(suggestAccountPin(zerosub, 'claude', { now: NOW }), {
    pluginId: 'zerosub', method: 'zerosub.agents.account', accountId: 'acc-roomy',
    metadata: { 'zerosub.account': 'acc-roomy' },
  });
  assert.equal(ACCOUNT_PIN_PLUGIN_ID, 'zerosub');
  assert.equal(ACCOUNT_PIN_METHOD, 'zerosub.agents.account');
  assert.equal(ACCOUNT_METADATA_KEY, 'zerosub.account');
  assert.equal(suggestAccountPin(null, 'claude'), null);
  assert.equal(suggestAccountPin(zerosub, ''), null);
  assert.equal(suggestAccountPin(zerosub, 'codex', { now: NOW }), null);
  const exhausted = normalizeZerosubState({
    accounts: [{ id: 'acc-full', family: 'claude', status: 'limited', usage: { windows: [{ id: 'five_hour', usedPercent: 99, resetsAt: FUTURE_5H }] } }],
    agents: [],
  }, { now: NOW });
  assert.equal(suggestAccountPin(exhausted, 'claude', { now: NOW }), null);
});

// ---------------------------------------------------------------- discovery mapping

test('applyContinuations replaces the origin with the live tab and inherits its slot', () => {
  const origin = { id: 'o', status: 'idle', labels: { [LABEL.repo]: 'proj', [LABEL.scope]: 'proj', [LABEL.role]: 'steer', [LABEL.slot]: 'E' } };
  const cont = { id: 'c', status: 'idle', title: 'Steer E', labels: { [CONTINUED_FROM_LABEL]: 'o' } };
  const mapped = applyContinuations([origin], [origin, cont]);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].id, 'c');
  assert.equal(mapped[0].labels[LABEL.slot], 'E');
  assert.equal(mapped[0].labels[LABEL.role], 'steer');
  assert.equal(mapped[0].continuedFrom, 'o');
  // The origin record itself is untouched (copies, no mutation).
  assert.deepEqual(Object.keys(origin.labels).sort(), [LABEL.repo, LABEL.role, LABEL.scope, LABEL.slot].sort());
  assert.equal('continuedFrom' in origin, false);
  // A continuation already in the list is marked, never duplicated.
  const twice = applyContinuations([origin, cont], [origin, cont]);
  assert.deepEqual(twice.map((a) => a.id), ['c']);
  // Without continuations every agent passes through untouched.
  const plain = [{ id: 'x', labels: {} }];
  assert.deepEqual(applyContinuations(plain, plain), plain);
});

test('remapWorkerParents follows the live steer', () => {
  const origin = { id: 'o', labels: {} };
  const cont = { id: 'c', labels: { [CONTINUED_FROM_LABEL]: 'o' } };
  const worker = { id: 'w', labels: { [PARENT_LABEL]: 'o' } };
  const foreign = { id: 'f', labels: { [PARENT_LABEL]: 'someone-else' } };
  const mapped = remapWorkerParents([worker, foreign], [origin, cont, worker, foreign]);
  assert.equal(parentOf(mapped[0]), 'c');
  assert.equal(mapped[0].parentContinuedFrom, 'o');
  assert.equal(mapped[1], foreign);
  assert.deepEqual(remapWorkerParents([worker], [worker]), [worker]);
});

const DIR_CONFIG = {
  version: 1, github: { owner: 'Test', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p', workspaceTitle: 'Main',
  profiles: { codex: { provider: 'codex', model: 'codex' } },
  steers: { slots: { E: 'codex' }, prepare: ['E'], initialActive: 'E' },
  workers: { priority: ['codex'], defaultProfile: 'codex' },
};

function dirWorld() {
  const workspace = {
    id: 'wks_test0000000001', projectId: 'prj_1', workspaceDirectory: '/p/proj',
    workspaceKind: 'local_checkout', title: 'Main', name: 'Main',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'E', epoch: 1, scope: { id: 'proj', kind: 'dir', locator: '/p/proj' } } },
  };
  const origin = {
    id: 'agent-origin', workspaceId: workspace.id, status: 'idle', archivedAt: null,
    title: 'Steer E', provider: 'codex', model: 'codex',
    labels: { [LABEL.repo]: 'proj', [LABEL.scope]: 'proj', [LABEL.role]: 'steer', [LABEL.slot]: 'E' },
  };
  const cont = {
    id: 'agent-cont', workspaceId: workspace.id, status: 'idle', archivedAt: null,
    title: 'Steer E', provider: 'codex', model: 'codex', labels: { [CONTINUED_FROM_LABEL]: 'agent-origin' },
  };
  const worker = {
    id: 'agent-w1', workspaceId: workspace.id, status: 'idle', archivedAt: null,
    title: 'Worker 1', provider: 'codex', model: 'codex', labels: { [PARENT_LABEL]: 'agent-origin' },
  };
  return { workspace, origin, cont, worker };
}

function discoverDirWorld(world, { switches = [], agents = null } = {}) {
  return discoverRepository({ local: '/p/proj' }, {
    config: DIR_CONFIG,
    gh: () => { throw new Error('no github'); },
    git: () => { throw new Error('no git'); },
    checkouts: [{ path: '/p/proj', linkedWorktree: false, remotes: {}, repos: {} }],
    paseo: {
      projects: [{ projectId: 'prj_1', projectRootPath: '/p/proj' }],
      workspaces: [world.workspace],
      agents: agents ?? [world.origin, world.cont, world.worker],
      providers: [],
    },
    existsDir: () => true,
    zerosubSwitches: switches,
  });
}

test('discovery maps the continuation to the origin slot; the active steer follows', () => {
  const world = dirWorld();
  const discovery = discoverDirWorld(world);
  assert.deepEqual(discovery.steers.labelled.map((a) => a.id), ['agent-cont']);
  const holder = discovery.steers.labelled[0];
  assert.equal(holder.labels[LABEL.slot], 'E');
  assert.equal(holder.continuedFrom, 'agent-origin');
  // No duplicate slot: exactly one live holder, so the planner cannot conflict.
  assert.equal(discovery.steers.labelled.filter((a) => a.labels[LABEL.slot] === 'E' && !a.archivedAt).length, 1);
  // The origin's worker stays attached and now points at the live steer.
  assert.deepEqual(discovery.workers.map((w) => w.id), ['agent-w1']);
  assert.equal(parentOf(discovery.workers[0]), 'agent-cont');
  assert.equal(discovery.workers[0].parentContinuedFrom, 'agent-origin');
  // The active-steer pointer (slot E) resolves to the continuation.
  const status = steerStatus(discovery);
  assert.deepEqual(status.steers.map((s) => [s.slot, s.id]), [['E', 'agent-cont']]);
  assert.equal(status.workers[0].parentSlot, 'E');
});

test('discovery follows timeline switches the same way', () => {
  const world = dirWorld();
  const cont2 = { ...world.cont, id: 'agent-cont2', title: 'Something else', labels: {} };
  const discovery = discoverDirWorld(world, {
    agents: [world.origin, cont2, world.worker],
    switches: [{ agentId: 'agent-origin', continuedIn: 'agent-cont2' }],
  });
  assert.deepEqual(discovery.steers.labelled.map((a) => a.id), ['agent-cont2']);
  assert.equal(discovery.steers.labelled[0].labels[LABEL.slot], 'E');
  assert.equal(parentOf(discovery.workers[0]), 'agent-cont2');
});

// ---------------------------------------------------------------- worker pick pin

const PICK_CONFIG = {
  version: 1, github: { owner: 'Test', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/tmp/test', workspaceTitle: 'Main',
  profiles: {
    sonnet: { provider: 'claude', model: 'sonnet' },
    opus: { provider: 'claude', model: 'opus' },
  },
  steers: { slots: { D: 'sonnet' }, prepare: ['D'], initialActive: 'D' },
  workers: { priority: ['sonnet', 'opus'], defaultProfile: 'sonnet' },
};

const PICK_PROVIDERS = [
  { provider: 'claude', enabled: true, status: 'ready', models: [{ id: 'sonnet' }, { id: 'opus' }] },
];

function pickZerosub() {
  return normalizeZerosubState({
    accounts: [
      { id: 'acc-roomy', family: 'claude', status: 'active', usage: { windows: [{ id: 'five_hour', usedPercent: 20, resetsAt: FUTURE_5H }] } },
      { id: 'acc-full', family: 'claude', status: 'limited', usage: { windows: [{ id: 'five_hour', usedPercent: 99, resetsAt: FUTURE_5H }] } },
    ],
    agents: [],
  }, { now: NOW });
}

test('resolveProfile exposes the pin suggestion for the roomiest account', () => {
  const picked = resolveProfile(PICK_CONFIG, PICK_PROVIDERS, ['sonnet', 'opus'], { role: 'worker', repoPublic: true, zerosub: pickZerosub(), now: NOW });
  assert.equal(picked.profile.name, 'sonnet');
  assert.equal(picked.zerosubAccount, 'acc-roomy');
  assert.deepEqual(picked.zerosubPin, {
    pluginId: 'zerosub', method: 'zerosub.agents.account', accountId: 'acc-roomy',
    metadata: { 'zerosub.account': 'acc-roomy' },
  });
  const legacy = resolveProfile(PICK_CONFIG, PICK_PROVIDERS, ['sonnet'], { role: 'worker', repoPublic: true });
  assert.equal(legacy.zerosubAccount, null);
  assert.equal(legacy.zerosubPin, null);
  const exhausted = normalizeZerosubState({
    accounts: [{ id: 'acc-full', family: 'claude', status: 'limited', usage: { windows: [{ id: 'five_hour', usedPercent: 99, resetsAt: FUTURE_5H }] } }],
    agents: [],
  }, { now: NOW });
  const skipped = resolveProfile(PICK_CONFIG, PICK_PROVIDERS, ['sonnet'], { role: 'worker', repoPublic: true, zerosub: exhausted, now: NOW });
  assert.equal(skipped.profile, null);
  assert.equal(skipped.zerosubPin, null);
});
