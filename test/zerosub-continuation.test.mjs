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
  resolveContinuations, suggestAccountPin, switchesFromTimeline,
} from '../src/zerosub.mjs';
import { applyContinuations, discoverRepository, remapWorkerParents } from '../src/discovery.mjs';
import { planLabelFixes } from '../src/labels.mjs';
import { assessWorker } from '../src/workers.mjs';
import { resolveProfile } from '../src/models.mjs';
import { steerStatus } from '../src/steer.mjs';
import { LABEL, METADATA_KEY, PARENT_LABEL, parentOf } from '../src/paseo.mjs';

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

test('switchesFromTimeline extracts the last continuedIn row', () => {
  const row = (continuedIn, extra = {}) => ({ item: { type: 'zerosub-switch', reason: 'exhausted', outcome: 'continued', continuedIn, continued: true, ...extra } });
  assert.deepEqual(
    switchesFromTimeline('o', { entries: [{ item: { type: 'assistant_message', text: 'hi' } }, row('c1')] }),
    [{ agentId: 'o', continuedIn: 'c1' }],
  );
  // Entry-level fields (no item wrapper) and last-row-wins.
  assert.deepEqual(
    switchesFromTimeline('o', { entries: [{ type: 'zerosub-switch', continuedIn: 'c1' }, { type: 'zerosub-switch', continuedIn: 'c2' }] }),
    [{ agentId: 'o', continuedIn: 'c2' }],
  );
  // Other types, empty targets and self references are ignored.
  assert.deepEqual(switchesFromTimeline('o', { entries: [{ item: { type: 'assistant_message', text: 'x' } }] }), []);
  assert.deepEqual(switchesFromTimeline('o', { entries: [row(''), row('  ')] }), []);
  assert.deepEqual(switchesFromTimeline('o', { entries: [row('o')] }), []);
  assert.deepEqual(switchesFromTimeline('o', null), []);
  assert.deepEqual(switchesFromTimeline('o', {}), []);
  assert.deepEqual(switchesFromTimeline('o', { entries: 'nope' }), []);
  assert.deepEqual(switchesFromTimeline('', { entries: [row('c1')] }), []);
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

// ---------------------------------------------------------------- labels audit

function scopeState(agents, workspace = null) {
  const ws = workspace ?? {
    id: 'wks_test0000000001', projectId: 'prj_1', workspaceDirectory: '/p/proj',
    workspaceKind: 'local_checkout', title: 'Main', name: 'Main',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'E', epoch: 1, scope: { id: 'proj', kind: 'dir', locator: '/p/proj' } } },
  };
  return { workspaces: [ws], agents };
}

test('labels audit never flags continuations or their superseded origins', () => {
  const ws = scopeState([]).workspaces[0];
  const origin = {
    id: 'agent-origin', workspaceId: ws.id, title: 'Steer E', archivedAt: null,
    labels: { [LABEL.repo]: 'proj', [LABEL.scope]: 'proj', [LABEL.role]: 'steer', [LABEL.slot]: 'E' },
  };
  const cont = {
    id: 'agent-cont', workspaceId: ws.id, title: 'Steer E', archivedAt: null,
    labels: { [CONTINUED_FROM_LABEL]: 'agent-origin' },
  };
  assert.deepEqual(planLabelFixes(scopeState([origin, cont])), []);
  assert.deepEqual(planLabelFixes(scopeState([origin, cont]), { address: 'agent-cont' }), []);
  // A superseded origin that alone would be flagged stays silent too.
  const partial = {
    id: 'agent-partial', workspaceId: ws.id, title: 'Steer F', archivedAt: null,
    labels: { [LABEL.role]: 'steer', [LABEL.slot]: 'F' },
  };
  const partialCont = {
    id: 'agent-partial-cont', workspaceId: ws.id, title: 'Steer F', archivedAt: null,
    labels: { [CONTINUED_FROM_LABEL]: 'agent-partial' },
  };
  assert.deepEqual(planLabelFixes(scopeState([partial, partialCont])), []);
});

test('labels audit still flags the same agents without a continuation', () => {
  const ws = scopeState([]).workspaces[0];
  const partial = {
    id: 'agent-partial', workspaceId: ws.id, title: 'Steer F', archivedAt: null,
    labels: { [LABEL.role]: 'steer', [LABEL.slot]: 'F' },
  };
  const rows = planLabelFixes(scopeState([partial]));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].labels, { [LABEL.repo]: 'proj', [LABEL.scope]: 'proj' });
  // A dangling continued-from falls back to normal classification: with its
  // own factory signal the agent is flagged like any other, without one it
  // stays unattributed (never claimed).
  const dangling = {
    id: 'agent-dangling', workspaceId: ws.id, title: 'Steer E', archivedAt: null,
    labels: { [LABEL.scope]: 'proj', [CONTINUED_FROM_LABEL]: 'agent-missing' },
  };
  const danglingRows = planLabelFixes(scopeState([dangling]));
  assert.equal(danglingRows.length, 1);
  assert.equal(danglingRows[0].agentId, 'agent-dangling');
  assert.ok(danglingRows[0].labels[LABEL.role]);
  const unattributed = {
    id: 'agent-unattributed', workspaceId: ws.id, title: 'Steer E', archivedAt: null,
    labels: { [CONTINUED_FROM_LABEL]: 'agent-missing' },
  };
  assert.deepEqual(planLabelFixes(scopeState([unattributed])), []);
});

// ---------------------------------------------------------------- worker assessment

test('assessWorker refuses superseded origins and assesses continuations as the same worker', () => {
  const ws = { id: 'w1', workspaceKind: 'worktree', project: { checkout: { isPaseoOwnedWorktree: true } } };
  const clean = { dirty: false, untracked: 0, ignored: 0, detached: false, ahead: 0 };
  const origin = { id: 'w-origin', status: 'idle', workspaceId: 'w1', labels: { [PARENT_LABEL]: 'steer-e' }, pendingPermissions: [] };
  const cont = { id: 'w-cont', status: 'idle', workspaceId: 'w1', labels: { [CONTINUED_FROM_LABEL]: 'w-origin' }, pendingPermissions: [] };
  const ctx = { agents: [origin, cont], workspaces: [ws], gitState: clean, backgroundWork: [], terminals: [] };
  const refused = assessWorker(origin, ctx);
  assert.equal(refused.archiveAgent, false);
  assert.deepEqual(refused.reasons, ['superseded by continuation w-cont; retire it instead']);
  // The continuation inherits the origin's parent: no 'has no parent' refusal.
  const live = assessWorker(cont, ctx);
  assert.equal(live.archiveAgent, true);
  assert.equal(live.reasons.some((r) => r.includes('has no parent')), false);
  // Subagents of the origin still belong to the live worker.
  const sub = { id: 'sub1', workspaceId: 'w9', labels: { [PARENT_LABEL]: 'w-origin' } };
  const withChild = assessWorker(cont, { ...ctx, agents: [origin, cont, sub] });
  assert.equal(withChild.archiveAgent, false);
  assert.ok(withChild.reasons.includes('has 1 live subagent(s)'));
  // Without a known origin the continuation is assessed as-is.
  const dangling = assessWorker(cont, { ...ctx, agents: [cont] });
  assert.equal(dangling.archiveAgent, false);
  assert.ok(dangling.reasons.includes('has no parent; not a delegated worker'));
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
