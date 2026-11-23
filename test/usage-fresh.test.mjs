// Usage display and fresh-steer tests. A tiny simulated world (main workspace,
// steers, daemon receipts) drives the real steerStatus, switchSteer and
// freshSteer, including the real agent-create executor.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { switchSteer, freshSteer, steerStatus, agentUsage, writeCheckpoint } from '../src/steer.mjs';
import { withLock } from '../src/lock.mjs';
import { LABEL, METADATA_KEY, PARENT_LABEL } from '../src/paseo.mjs';

// ---------------------------------------------------------------- fixtures

const REPO = 'example-owner/example-repo';
const CONFIG = {
  version: 1,
  github: { owner: 'example-owner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    standard: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
    cheap: { provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null, mode: 'allowAll' },
  },
  steers: { slots: { A: 'standard', B: 'cheap' }, prepare: ['A', 'B'], initialActive: 'A' },
  workers: { defaultProfile: 'cheap' },
};
const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'full-access' }] },
  { provider: 'muse', enabled: true, status: 'ready', models: [{ id: 'muse-spark-1.3-contributor', thinkingOptions: [] }], modes: [{ id: 'allowAll' }] },
];

function makeWorld() {
  return { workspaces: [], agents: [], providers: structuredClone(PROVIDERS), calls: [], receipts: new Map(), fingerprints: new Map(), seq: 0, hooks: {} };
}

function addWorkspace(world, { metadata, title = 'Main' }) {
  const ws = { id: `wks_${String(++world.seq).padStart(4, '0')}`, projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout', title, name: title, metadata: structuredClone(metadata), createdAt: new Date().toISOString() };
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
    B: addAgent(world, { provider: 'muse', model: 'muse-spark-1.3-contributor', title: 'Steer B', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'B' } }),
  };
  return { ws, steers };
}

function discoveryOf(world) {
  return {
    forkName: REPO,
    mainWorkspace: world.workspaces[0] ? structuredClone(world.workspaces[0]) : null,
    steers: { labelled: structuredClone(world.agents.filter((a) => a.labels?.[LABEL.role] === 'steer')), legacy: [] },
    workers: structuredClone(world.agents.filter((a) => a.labels?.[PARENT_LABEL])),
    providers: structuredClone(world.providers),
  };
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  const agentHandle = (id) => ({
    id,
    refresh: async () => ({ agent: structuredClone(findAgent(id)) }),
    send: async (text) => {
      if (world.hooks.sendFails) throw new Error('agent unreachable');
      world.calls.push(['agent.send', id, text]);
    },
    timeline: { refetch: async () => ({ entries: [{ item: { type: 'assistant_message', text: world.hooks.lastMessage ?? 'Done.' } }] }) },
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
        const fingerprint = JSON.stringify({ ...opts, idempotencyKey: undefined });
        if (opts.idempotencyKey && world.receipts.has(opts.idempotencyKey)) {
          if (world.fingerprints.get(opts.idempotencyKey) !== fingerprint) throw new Error('agent_request_key_conflict');
          return agentHandle(world.receipts.get(opts.idempotencyKey));
        }
        const [provider, model] = opts.config.provider.split('/');
        const agent = addAgent(world, { provider, model, title: opts.title, workspaceId: id, labels: { ...opts.labels }, currentModeId: opts.config.modeId });
        if (opts.idempotencyKey) {
          world.receipts.set(opts.idempotencyKey, agent.id);
          world.fingerprints.set(opts.idempotencyKey, fingerprint);
        }
        if (world.hooks.dropResponseAfterCreate) throw new Error('socket closed before agent.create response');
        return agentHandle(agent.id);
      },
    },
  });
  return { workspaces: { ref: workspaceHandle }, agents: { ref: agentHandle } };
}

function fakeLookup(world) {
  return async (kind, key) => {
    world.calls.push(['receipt.lookup', kind, key]);
    if (world.hooks.lookupFails) throw new Error('socket closed');
    if (world.hooks.receiptOverride?.[key] !== undefined) return world.hooks.receiptOverride[key];
    if (!world.receipts.has(key)) return null;
    const id = world.receipts.get(key);
    return { kind, idempotencyKey: key, phase: 'completed', error: null, agentId: id, workspaceId: world.agents.find((a) => a.id === id)?.workspaceId ?? null };
  };
}

const fakeGit = () => (cwd, args) => {
  if (args[0] === 'rev-parse') return args.includes('--abbrev-ref') ? 'main' : 'a1b2c3d4e5f6a7b8c9d0';
  if (args[0] === 'status') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
};

const LOCK_TMP = mkdtempSync(join(tmpdir(), 'wsf-fresh-'));
const testLock = (name, fn) => withLock(name, fn, { dir: LOCK_TMP });

// ---------------------------------------------------------------- usage

test('usage: context numbers surface per agent; missing data is null, never invented', () => {
  assert.deepEqual(
    agentUsage({ lastUsage: { contextWindowUsedTokens: 127618, contextWindowMaxTokens: 1000000 } }),
    { usedTokens: 127618, maxTokens: 1000000 },
  );
  assert.deepEqual(
    agentUsage({ LastUsage: { ContextWindowUsedTokens: 1, ContextWindowMaxTokens: 2 } }),
    { usedTokens: 1, maxTokens: 2 },
  );
  assert.equal(agentUsage({ lastUsage: null }), null);
  assert.equal(agentUsage({}), null);
  assert.equal(agentUsage({ lastUsage: { inputTokens: 5, outputTokens: 3 } }), null);
  assert.equal(agentUsage({ lastUsage: { contextWindowUsedTokens: 5 } }), null);
});

test('status: usage per steer and worker, threshold warnings, default off', () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  steers.A.lastUsage = { contextWindowUsedTokens: 812345, contextWindowMaxTokens: 1000000 };
  steers.B.lastUsage = null;
  const worker = addAgent(world, {
    provider: 'muse', model: 'muse-spark-1.3-contributor', title: 'Worker 1', workspaceId: ws.id,
    labels: { [PARENT_LABEL]: steers.A.id }, lastUsage: { contextWindowUsedTokens: 10, contextWindowMaxTokens: 100 },
  });

  const plain = steerStatus(discoveryOf(world));
  assert.deepEqual(plain.steers.find((s) => s.slot === 'A').usage, { usedTokens: 812345, maxTokens: 1000000 });
  assert.equal(plain.steers.find((s) => s.slot === 'B').usage, null);
  assert.deepEqual(plain.workers[0].usage, { usedTokens: 10, maxTokens: 100 });
  assert.deepEqual(plain.usageWarnings, []);

  const warned = steerStatus(discoveryOf(world), { warnContextTokens: 500000 });
  assert.deepEqual(warned.usageWarnings, [{ kind: 'steer', slot: 'A', id: steers.A.id, usedTokens: 812345, maxTokens: 1000000 }]);

  const both = steerStatus(discoveryOf(world), { warnContextTokens: 5 });
  assert.deepEqual(both.usageWarnings.map((w) => w.kind), ['steer', 'worker']);
  assert.equal(both.usageWarnings[1].id, worker.id);
});

test('config: usage.warnContextTokens is optional and must be a positive integer', () => {
  assert.deepEqual(validateConfig(CONFIG), []);
  assert.deepEqual(validateConfig({ ...CONFIG, usage: { warnContextTokens: 500000 } }), []);
  for (const bad of [0, -1, 1.5, '500000', NaN]) {
    assert.match(validateConfig({ ...CONFIG, usage: { warnContextTokens: bad } }).join(';'), /warnContextTokens/, String(bad));
  }
  assert.match(validateConfig({ ...CONFIG, usage: 'warn' }).join(';'), /usage must be an object/);
});

// ---------------------------------------------------------------- fresh preview

test('fresh preview: handoff for a new same-slot agent, deterministic, nothing written', async () => {
  const world = makeWorld();
  provisioned(world);
  const fresh = (extra = {}) => freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, git: fakeGit(), lock: testLock, language: 'en', ...extra });
  const first = await fresh();
  assert.equal(first.applied, false);
  assert.equal(first.slot, 'A');
  assert.equal(first.to, null);
  assert.equal(first.epoch, 2);
  assert.equal(first.profile, 'standard');
  assert.match(first.idempotencyKey, /^wsf:example-owner\/example-repo:steer:A:fresh-e1:[0-9a-f]{10}$/);
  assert.match(first.packet, /Steer handoff for example-owner\/example-repo: epoch 1 → 2/);
  assert.match(first.packet, /\(new agent, created on apply\) is now active/);
  assert.match(first.packet, /Task checkpoint: NONE RECORDED/);
  assert.match(first.packet, /Git: main @ a1b2c3d4e5f6 · clean/);
  const second = await fresh();
  assert.equal(second.packet, first.packet);
  assert.equal(second.idempotencyKey, first.idempotencyKey);
  assert.deepEqual(world.calls, [], 'preview reads only: no create, metadata write, send or receipt lookup');
  const noGit = await fresh({ git: undefined });
  assert.match(noGit.packet, /state unreadable/);
});

// ---------------------------------------------------------------- fresh apply

test('fresh apply: new agent of the same profile, epoch bump, both deliveries; the old steer keeps chat and labels', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  await writeCheckpoint({ client: fakeClient(world), discovery: discoveryOf(world), task: 'Ship it', tests: ['npm test'], blockers: [], lock: testLock });
  const result = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en' });
  assert.equal(result.applied, true);
  assert.equal(result.checkpoint, true);
  assert.equal(result.delivered, true);
  assert.equal(result.previousNotified, true);
  assert.equal(result.reused, false);
  assert.equal(result.from, steers.A.id);
  assert.ok(result.to && result.to !== steers.A.id);
  assert.match(result.packet, new RegExp(`Steer A \\(${result.to}\\) is now active`));
  assert.match(result.packet, /Task: Ship it/);

  const created = world.agents.find((a) => a.id === result.to);
  assert.equal(created.title, 'Steer A');
  assert.equal(created.provider, 'codex');
  assert.equal(created.model, 'gpt-6.2-sol');
  assert.deepEqual(created.labels, { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'A', [LABEL.scope]: REPO });
  assert.ok(world.calls.some((c) => c[0] === 'receipt.lookup' && c[2] === result.idempotencyKey));

  const state = world.workspaces[0].metadata[METADATA_KEY];
  assert.deepEqual({ ...state, switchedAt: undefined }, { main: true, activeSteer: 'A', epoch: 2, previousSteer: steers.A.id, switchedAt: undefined });
  assert.ok(Number.isFinite(Date.parse(state.switchedAt)));

  const sends = world.calls.filter((c) => c[0] === 'agent.send');
  assert.deepEqual(sends.map((c) => c[1]), [result.to, steers.A.id]);
  assert.match(sends[1][2], /no longer coordinate/);

  const old = world.agents.find((a) => a.id === steers.A.id);
  assert.deepEqual(old.labels, { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'A' });
  assert.equal(old.archivedAt, null);
});

test('fresh apply labels the new steer with the resolved scope id', async () => {
  const world = makeWorld();
  provisioned(world);
  const discovery = { ...discoveryOf(world), scope: { id: 'notes', kind: 'dir', locator: '/p/demo' } };
  const result = await freshSteer({ client: fakeClient(world), discovery, config: CONFIG, apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en' });
  assert.equal(result.applied, true);
  const created = world.agents.find((a) => a.id === result.to);
  assert.equal(created.labels[LABEL.scope], 'notes');
  assert.equal(created.labels[LABEL.repo], REPO, 'wsf.repo keeps the discovery name for compatibility');
});

test('fresh apply recovers an interrupted create through its receipt instead of recreating', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const run = (extra = {}) => freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', ...extra });

  world.hooks.dropResponseAfterCreate = true;
  await assert.rejects(run({ apply: true }), /socket closed before agent.create response/);
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].epoch, 1);
  const orphan = world.agents.find((a) => a.labels?.[LABEL.slot] === 'A' && a.id !== steers.A.id);
  assert.ok(orphan, 'the agent exists although its response was lost');
  world.hooks.dropResponseAfterCreate = false;

  await assert.rejects(run(), /several live agents.*rerun with --apply to recover it/);
  const recovered = await run({ apply: true });
  assert.equal(recovered.reused, true);
  assert.equal(recovered.to, orphan.id);
  assert.equal(recovered.from, steers.A.id);
  assert.equal(world.agents.length, 3, 'no second agent created');
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].epoch, 2);
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].previousSteer, steers.A.id);
});

test('fresh refuses without state, on duplicates, stale epoch, busy steer, bad profile or bad receipt', async () => {
  const empty = makeWorld();
  await assert.rejects(
    freshSteer({ client: fakeClient(empty), discovery: discoveryOf(empty), config: CONFIG, lock: testLock, language: 'en' }),
    /No factory main workspace/,
  );

  const world = makeWorld();
  const { steers } = provisioned(world);
  const run = (extra = {}) => freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', ...extra });

  steers.A.status = 'running';
  await assert.rejects(run(), /Active Steer A is running/);
  steers.A.status = 'idle';

  const stale = discoveryOf(world);
  world.workspaces[0].metadata[METADATA_KEY].epoch = 2;
  await assert.rejects(
    freshSteer({ client: fakeClient(world), discovery: stale, config: CONFIG, apply: true, lock: testLock, lookupReceipt: fakeLookup(world), language: 'en' }),
    /Steer state changed/,
  );
  world.workspaces[0].metadata[METADATA_KEY].epoch = 1;

  const withoutProfile = { ...CONFIG, steers: { slots: { A: 'missing' }, prepare: ['A'], initialActive: 'A' } };
  await assert.rejects(
    freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: withoutProfile, lock: testLock, language: 'en' }),
    /unknown profile/,
  );
  world.providers = [];
  await assert.rejects(run(), /not startable/);
  world.providers = structuredClone(PROVIDERS);

  await assert.rejects(
    freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true, lock: testLock, language: 'en' }),
    /refusing to create without a receipt/,
  );
  world.hooks.lookupFails = true;
  await assert.rejects(run({ apply: true }), /receipt lookup failed/);
  world.hooks.lookupFails = false;

  const key = (await run()).idempotencyKey;
  world.hooks.receiptOverride = { [key]: { kind: 'agent', idempotencyKey: key, phase: 'failed', error: 'boom', agentId: null } };
  await assert.rejects(run({ apply: true }), /recovery stopped.*boom/);
  world.hooks.receiptOverride = { [key]: { kind: 'agent', idempotencyKey: key, phase: 'completed', error: null, agentId: 'agent-1', outcomeUnknown: true } };
  await assert.rejects(run({ apply: true }), /unknown outcome/);
  world.hooks.receiptOverride = undefined;

  // A completed fresh leaves two holders; rerunning stops until the retired one is archived.
  await run({ apply: true });
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].epoch, 2);
  await assert.rejects(run({ apply: true }), /several live agents.*archive the retired one/);
  world.agents.find((a) => a.id === steers.A.id).archivedAt = 'archived';
  const again = await run();
  assert.equal(again.from !== steers.A.id, true);
});

// ---------------------------------------------------------------- ambiguity guards and retired marking

test('switch refuses an ambiguous target or source slot instead of picking one silently', async () => {
  const dup = makeWorld();
  const { ws } = provisioned(dup);
  addAgent(dup, { provider: 'muse', model: 'm', title: 'Steer B', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'B' } });
  await assert.rejects(
    switchSteer({ client: fakeClient(dup), discovery: discoveryOf(dup), toSlot: 'B', lock: testLock, language: 'en' }),
    /Steer B has several live agents/,
  );

  const fromDup = makeWorld();
  const second = provisioned(fromDup);
  addAgent(fromDup, { provider: 'codex', model: 'm', title: 'Steer A', workspaceId: second.ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'A' } });
  await assert.rejects(
    switchSteer({ client: fakeClient(fromDup), discovery: discoveryOf(fromDup), toSlot: 'B', lock: testLock, language: 'en' }),
    /Active Steer A has several live agents/,
  );
});

test('status marks the retired holder after a fresh; a slot-valued previousSteer marks nothing', async () => {
  const world = makeWorld();
  provisioned(world);
  const applied = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true, lock: testLock, lookupReceipt: fakeLookup(world), language: 'en' });
  const status = steerStatus(discoveryOf(world));
  assert.equal(status.steers.find((s) => s.id === applied.from).retired, true);
  assert.equal(status.steers.find((s) => s.id === applied.to).retired, false);
  assert.equal(status.steers.find((s) => s.slot === 'B').retired, false);

  world.workspaces[0].metadata[METADATA_KEY].previousSteer = 'B'; // a switch records a slot letter
  assert.ok(steerStatus(discoveryOf(world)).steers.every((s) => !s.retired));

  world.workspaces[0].metadata[METADATA_KEY].previousSteer = applied.from;
  world.agents.find((a) => a.id === applied.from).archivedAt = 'archived';
  const after = steerStatus(discoveryOf(world));
  assert.ok(after.steers.every((s) => !s.retired));
  assert.equal(after.steers.filter((s) => s.slot === 'A').length, 1);
});
