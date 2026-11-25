// Bound rewind route (step 4): a fresh apply with requireRefreshMode:
// 'rewind' throws instead of silently falling back to a new agent. The
// packet travels on the error for the caller to keep. Fake state only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshSteer } from '../plugin/server/core/steer.mjs';
import { withLock } from '../plugin/server/core/lock.mjs';
import { LABEL, METADATA_KEY } from '../plugin/server/core/paseo.mjs';

const REPO = 'example-owner/example-repo';
const CONFIG = {
  version: 1,
  github: { owner: 'example-owner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    standard: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
  },
  steers: { slots: { A: 'standard', B: 'standard' }, prepare: ['A', 'B'], initialActive: 'A' },
  workers: { defaultProfile: 'standard' },
};
const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'full-access' }] },
];

function makeWorld() {
  return { workspaces: [], agents: [], providers: structuredClone(PROVIDERS), calls: [], receipts: new Map(), fingerprints: new Map(), seq: 0 };
}

function addWorkspace(world, { metadata }) {
  const ws = { id: `wks_${String(++world.seq).padStart(4, '0')}`, projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout', title: 'Main', name: 'Main', metadata: structuredClone(metadata), createdAt: new Date().toISOString() };
  world.workspaces.push(ws);
  return ws;
}

function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, lastUsage: null, ...fields };
  world.agents.push(agent);
  return agent;
}

function provisioned(world) {
  const ws = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } } });
  const steers = {
    A: addAgent(world, { provider: 'codex', model: 'gpt-6.2-sol', title: 'Steer A', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'A' } }),
    B: addAgent(world, { provider: 'codex', model: 'gpt-6.2-sol', title: 'Steer B', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'B' } }),
  };
  return { ws, steers };
}

function discoveryOf(world, extra = {}) {
  return {
    forkName: REPO,
    mainWorkspace: world.workspaces[0] ? structuredClone(world.workspaces[0]) : null,
    steers: { labelled: structuredClone(world.agents.filter((a) => a.labels?.[LABEL.role] === 'steer')), legacy: [], digitCandidates: [] },
    workers: [],
    agents: structuredClone(world.agents),
    providers: structuredClone(world.providers),
    ...extra,
  };
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  const agentHandle = (id) => ({
    id,
    refresh: async () => ({ agent: structuredClone(findAgent(id)) }),
    send: async (text) => {
      world.calls.push(['agent.send', id, text]);
    },
    timeline: { refetch: async () => ({ entries: [{ item: { type: 'assistant_message', text: 'Done.' } }] }) },
  });
  const workspaceHandle = (id) => ({
    id,
    refresh: async () => structuredClone(findWs(id)),
    setMetadata: async (patch) => {
      world.calls.push(['workspace.setMetadata', id, patch]);
      Object.assign(findWs(id).metadata, structuredClone(patch));
    },
    agents: {
      create: async (opts) => {
        world.calls.push(['agent.create', opts]);
        const agent = addAgent(world, {
          provider: opts.config.provider.split('/')[0], model: opts.config.provider.split('/')[1],
          title: opts.title, workspaceId: id, labels: { ...opts.labels },
        });
        if (opts.idempotencyKey) world.receipts.set(opts.idempotencyKey, agent.id);
        return agentHandle(agent.id);
      },
    },
  });
  return { workspaces: { ref: workspaceHandle }, agents: { ref: agentHandle } };
}

function rewindClientWith(world, timeline, { rewindError = null } = {}) {
  return async () => ({
    fetchAgentTimeline: async () => structuredClone(timeline),
    rewindAgent: async (agentId, messageId) => {
      world.calls.push(['rewindAgent', agentId, messageId]);
      if (rewindError) throw new Error(rewindError);
    },
    sendMessage: async (agentId, text) => {
      world.calls.push(['daemon.sendMessage', agentId, text]);
    },
    close: async () => {},
  });
}

const pointTimeline = { entries: [{ item: { type: 'user_message', messageId: 'msg-1' } }] };
const emptyTimeline = { entries: [] };

const fakeGit = () => (cwd, args) => {
  if (args[0] === 'rev-parse') return args.includes('--abbrev-ref') ? 'main' : 'a1b2c3d4e5f6a7b8c9d0';
  if (args[0] === 'status') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
};

const LOCK_TMP = mkdtempSync(join(tmpdir(), 'wsf-fresh-bound-'));
const testLock = (name, fn) => withLock(name, fn, { dir: LOCK_TMP });
const fakeLookup = async () => null;
const creates = (world) => world.calls.filter((c) => c[0] === 'agent.create');
const sends = (world) => world.calls.filter((c) => c[0] === 'agent.send' || c[0] === 'daemon.sendMessage');

test('a bound rewind that finds no point throws and creates nothing', async () => {
  const world = makeWorld();
  provisioned(world);
  // Preview with a point promises rewind.
  const dry = await freshSteer({
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: false,
    slot: 'B', git: fakeGit(), lock: testLock, language: 'en',
    rewindClient: rewindClientWith(world, pointTimeline),
  });
  assert.equal(dry.refreshMode, 'rewind');
  // At apply time the point is gone: the bound route throws, keeps the
  // packet on the error, and creates no new agent.
  const error = await freshSteer({
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true,
    slot: 'B', git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup, language: 'en',
    rewindClient: rewindClientWith(world, emptyTimeline), requireRefreshMode: 'rewind',
  }).then(() => null, (e) => e);
  assert.ok(error, 'bound apply throws');
  assert.match(error.message, /Bound rewind route failed \(no-point\)/);
  assert.match(error.message, /brief is kept/);
  assert.match(String(error.packet ?? ''), /Steer refresh for/);
  assert.equal(error.refreshMode, 'rewind');
  assert.deepEqual(creates(world), [], 'no new agent on a bound failure');
  assert.deepEqual(sends(world), [], 'nothing sent on a bound failure');
});

test('an unsupported error after dispatch is uncertain and retains the bound brief', async () => {
  const world = makeWorld();
  provisioned(world);
  const error = await freshSteer({
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true,
    slot: 'B', git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup, language: 'en',
    rewindClient: rewindClientWith(world, pointTimeline, { rewindError: 'rewind not supported' }),
    requireRefreshMode: 'rewind',
  }).then(() => null, (e) => e);
  assert.ok(error);
  assert.match(error.message, /uncertain outcome/);
  assert.match(String(error.packet ?? ''), /Steer refresh for/);
  assert.deepEqual(creates(world), []);
});

test('without binding the same failure still falls back to a new agent', async () => {
  const world = makeWorld();
  provisioned(world);
  const applied = await freshSteer({
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true,
    slot: 'B', git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup, language: 'en',
    rewindClient: rewindClientWith(world, emptyTimeline),
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.refreshMode, 'new-agent');
  assert.equal(creates(world).length, 1);
});

test('a bound rewind that lands returns rewound with no new agent', async () => {
  const world = makeWorld();
  provisioned(world);
  const applied = await freshSteer({
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true,
    slot: 'B', git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup, language: 'en',
    rewindClient: rewindClientWith(world, pointTimeline), requireRefreshMode: 'rewind',
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.refreshMode, 'rewind');
  assert.deepEqual(creates(world), []);
});
