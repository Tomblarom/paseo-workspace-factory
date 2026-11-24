// Active-steer tab marker ("● Steer E"): title parsing tolerates the prefix,
// switch --apply / fresh move it via `paseo agent update --name`. Fakes only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { STEER_TITLE, STEER_DIGIT_TITLE, ACTIVE_STEER_MARKER, activeMarker, stripActiveMarker, markSteerTitle } from '../src/discovery.mjs';
import { switchSteer, freshSteer, applyActiveMarker } from '../src/steer.mjs';
import { withLock } from '../src/lock.mjs';
import { LABEL, METADATA_KEY } from '../src/paseo.mjs';

const REPO = 'example-owner/example-repo';
const CONFIG = {
  version: 1,
  github: { owner: 'example-owner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    standard: { provider: 'codex', model: 'gpt-6.2-sol' },
    cheap: { provider: 'muse', model: 'muse-spark-1.3-contributor' },
  },
  steers: { slots: { A: 'standard', B: 'cheap' }, prepare: ['A', 'B'], initialActive: 'A' },
  workers: { defaultProfile: 'cheap' },
};
const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol' }] },
  { provider: 'muse', enabled: true, status: 'ready', models: [{ id: 'muse-spark-1.3-contributor' }] },
];

function makeWorld() {
  return { workspaces: [], agents: [], providers: structuredClone(PROVIDERS), calls: [], cli: [], seq: 0 };
}

function provisioned(world, titles = {}) {
  const ws = { id: 'wks_0001', projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout', title: 'Main', name: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } }, createdAt: new Date().toISOString() };
  world.workspaces.push(ws);
  const steers = {};
  for (const [slot, profile] of [['A', 'codex'], ['B', 'muse']]) {
    const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, title: titles[slot] ?? `Steer ${slot}`, provider: profile, model: 'm', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: slot, [LABEL.scope]: REPO } };
    world.agents.push(agent);
    steers[slot] = agent;
  }
  return { ws, steers };
}

function discoveryOf(world) {
  return {
    forkName: REPO,
    mainWorkspace: structuredClone(world.workspaces[0]),
    steers: { labelled: structuredClone(world.agents.filter((a) => a.labels?.[LABEL.role] === 'steer')), legacy: [] },
    workers: [],
    providers: structuredClone(world.providers),
  };
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const agentHandle = (id) => ({
    id,
    refresh: async () => ({ agent: structuredClone(world.agents.find((a) => a.id === id) ?? null) }),
    send: async (text) => { world.calls.push(['agent.send', id, text]); },
    timeline: { refetch: async () => ({ entries: [] }) },
  });
  const workspaceHandle = (id) => ({
    id,
    refresh: async () => structuredClone(findWs(id)),
    setMetadata: async (patch) => { Object.assign(findWs(id).metadata, structuredClone(patch)); },
    agents: {
      create: async (opts) => {
        world.calls.push(['agent.create', opts]);
        const [provider, model] = opts.config.provider.split('/');
        const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, provider, model, title: opts.title, workspaceId: id, labels: { ...opts.labels } };
        world.agents.push(agent);
        return agentHandle(agent.id);
      },
    },
  });
  return { workspaces: { ref: workspaceHandle }, agents: { ref: agentHandle } };
}

const fakePaseoCli = (world, { fail = false } = {}) => (args) => {
  world.cli.push(args);
  if (fail) throw new Error('paseo agent failed: daemon unreachable');
  return '{}';
};

const LOCK_TMP = mkdtempSync(join(tmpdir(), 'wsf-marker-'));
const testLock = (name, fn) => withLock(name, fn, { dir: LOCK_TMP });

// ---------------------------------------------------------------- parsing

test('marker: STEER_TITLE tolerates the marker prefix, group 1 stays the slot', () => {
  assert.equal(ACTIVE_STEER_MARKER, '●');
  for (const [title, slot] of [
    ['● Steer E', 'E'], ['● Steer A [kn]', 'A'], ['● Steer A (kn)', 'A'], ['● Steer A · fp', 'A'],
    ['● steer b', 'B'], ['● STEER C - x', 'C'], ['* Steer D', 'D'],
  ]) {
    assert.equal(STEER_TITLE.test(title), true, title);
    assert.equal(title.match(STEER_TITLE)[1], slot, title);
  }
  for (const title of ['Steer 3', 'Steer AB', 'Steer A foo', 'Steer', 'Assistant', 'My Steer A', '9 Steer A', '● Steer', '● Assistant']) {
    assert.equal(STEER_TITLE.test(title), false, title);
    assert.equal(title.match(STEER_TITLE), null, title);
  }
});

test('marker: STEER_DIGIT_TITLE tolerates the marker prefix too', () => {
  for (const title of ['● Steer 3', '● Steer 30 · y']) assert.equal(STEER_DIGIT_TITLE.test(title), true, title);
  assert.equal(STEER_DIGIT_TITLE.test('● Steer E'), false);
});

test('marker: helpers are idempotent and the config default disables with empty', () => {
  assert.equal(activeMarker(null), '●');
  assert.equal(activeMarker(CONFIG), '●');
  assert.equal(activeMarker({ steers: { activeMarker: '▶' } }), '▶');
  assert.equal(activeMarker({ steers: { activeMarker: '' } }), '');
  assert.equal(markSteerTitle('Steer A'), '● Steer A');
  assert.equal(markSteerTitle('● Steer A'), '● Steer A');
  assert.equal(markSteerTitle('Steer A [kn]'), '● Steer A [kn]');
  assert.equal(stripActiveMarker('● Steer A'), 'Steer A');
  assert.equal(stripActiveMarker('● Steer A'), 'Steer A');
  assert.equal(stripActiveMarker('Steer A'), 'Steer A');
  assert.equal(markSteerTitle('Steer A', ''), 'Steer A');
  assert.equal(markSteerTitle('Steer A', '▶'), '▶ Steer A');
  assert.equal(stripActiveMarker('▶ Steer A', '▶'), 'Steer A');
});

test('marker: steers.activeMarker validates as an optional string', () => {
  assert.deepEqual(validateConfig(CONFIG), []);
  assert.deepEqual(validateConfig({ ...CONFIG, steers: { ...CONFIG.steers, activeMarker: '▶' } }), []);
  assert.deepEqual(validateConfig({ ...CONFIG, steers: { ...CONFIG.steers, activeMarker: '' } }), []);
  assert.match(validateConfig({ ...CONFIG, steers: { ...CONFIG.steers, activeMarker: 42 } }).join(';'), /activeMarker/);
});

// ---------------------------------------------------------------- switch

test('marker: switch --apply marks the new active steer and unmarks the old one', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world, { A: '● Steer A' });
  const result = await switchSteer({
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG,
    toSlot: 'B', apply: true, send: false, lock: testLock, paseoCli: fakePaseoCli(world),
  });
  assert.equal(result.applied, true);
  assert.equal(result.renameError, null);
  assert.deepEqual(world.cli, [
    ['agent', 'update', steers.B.id, '--name', '● Steer B'],
    ['agent', 'update', steers.A.id, '--name', 'Steer A'],
  ]);
});

test('marker: switch skips renames that are already correct and stays silent without a CLI', async () => {
  const world = makeWorld();
  provisioned(world, { A: '● Steer A' });
  const dry = await switchSteer({
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG,
    toSlot: 'B', apply: false, lock: testLock, paseoCli: fakePaseoCli(world),
  });
  assert.equal(dry.renameError, null);
  assert.deepEqual(world.cli, [], 'dry-run renames nothing');

  const world2 = makeWorld();
  provisioned(world2, { A: '● Steer A' });
  const silent = await switchSteer({
    client: fakeClient(world2), discovery: discoveryOf(world2), config: CONFIG,
    toSlot: 'B', apply: true, send: false, lock: testLock,
  });
  assert.equal(silent.applied, true);
  assert.equal(silent.renameError, null);
  assert.deepEqual(world2.cli, [], 'no paseoCli means no rename');

  const world3 = makeWorld();
  const { steers } = provisioned(world3, { A: '● Steer A', B: '● Steer B' });
  const partial = await switchSteer({
    client: fakeClient(world3), discovery: discoveryOf(world3), config: CONFIG,
    toSlot: 'B', apply: true, send: false, lock: testLock, paseoCli: fakePaseoCli(world3),
  });
  assert.equal(partial.renameError, null);
  assert.deepEqual(world3.cli, [['agent', 'update', steers.A.id, '--name', 'Steer A']], 'B is already marked');
});

test('marker: switch records rename failures but the switch stands', async () => {
  const world = makeWorld();
  provisioned(world, { A: '● Steer A' });
  const result = await switchSteer({
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG,
    toSlot: 'B', apply: true, send: false, lock: testLock, paseoCli: fakePaseoCli(world, { fail: true }),
  });
  assert.equal(result.applied, true);
  assert.match(result.renameError, /daemon unreachable/);
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].activeSteer, 'B');
});

test('marker: switch with a disabled marker renames nothing', async () => {
  const world = makeWorld();
  provisioned(world, { A: '● Steer A' });
  const config = { ...CONFIG, steers: { ...CONFIG.steers, activeMarker: '' } };
  const result = await switchSteer({
    client: fakeClient(world), discovery: discoveryOf(world), config,
    toSlot: 'B', apply: true, send: false, lock: testLock, paseoCli: fakePaseoCli(world),
  });
  assert.equal(result.applied, true);
  assert.equal(result.renameError, null);
  assert.deepEqual(world.cli, []);
});

// ---------------------------------------------------------------- fresh

test('marker: fresh creates the new steer marked and unmarks the retired one', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world, { A: '● Steer A' });
  const result = await freshSteer({
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG,
    apply: true, lock: testLock, lookupReceipt: async () => null, language: 'en', paseoCli: fakePaseoCli(world),
  });
  assert.equal(result.applied, true);
  assert.equal(result.renameError, null);
  const created = world.agents.find((a) => a.id === result.to);
  assert.equal(created.title, '● Steer A');
  assert.deepEqual(world.cli, [['agent', 'update', steers.A.id, '--name', 'Steer A']]);
});

test('marker: fresh with a disabled marker creates plain titles and renames nothing', async () => {
  const world = makeWorld();
  provisioned(world);
  const config = { ...CONFIG, steers: { ...CONFIG.steers, activeMarker: '' } };
  const result = await freshSteer({
    client: fakeClient(world), discovery: discoveryOf(world), config,
    apply: true, lock: testLock, lookupReceipt: async () => null, language: 'en', paseoCli: fakePaseoCli(world),
  });
  assert.equal(result.applied, true);
  assert.equal(world.agents.find((a) => a.id === result.to).title, 'Steer A');
  assert.deepEqual(world.cli, []);
});

// ---------------------------------------------------------------- helper

test('marker: applyActiveMarker never throws and skips same-agent pairs', () => {
  assert.equal(applyActiveMarker({ paseoCli: null, marker: '●', mark: { id: 'a' }, unmark: null }), null);
  assert.equal(applyActiveMarker({ paseoCli: () => { throw new Error('boom'); }, marker: '', mark: { id: 'a' }, unmark: null }), null);
  const err = applyActiveMarker({
    paseoCli: () => { throw new Error('boom'); }, marker: '●',
    mark: { id: 'a', title: 'Steer A', slot: 'A' }, unmark: { id: 'a', title: 'Steer A', slot: 'A' },
  });
  assert.equal(err, 'boom');
});
