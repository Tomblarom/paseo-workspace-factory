// Usage display and fresh-steer tests. A tiny simulated world (main workspace,
// steers, daemon receipts) drives the real steerStatus, switchSteer and
// freshSteer, including the real agent-create executor.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSteerCreate } from '../plugin/server/core/steer-create.mjs';
import { validateConfig } from '../plugin/server/core/config.mjs';
import { switchSteer, freshSteer, steerStatus, agentUsage, writeCheckpoint } from '../plugin/server/core/steer.mjs';
import { withLock } from '../plugin/server/core/lock.mjs';
import { resolveSteerHolders } from '../plugin/server/core/discovery.mjs';
import { LABEL, METADATA_KEY, PARENT_LABEL } from '../plugin/server/core/paseo.mjs';

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
    A: addAgent(world, { provider: 'codex', model: 'gpt-6.2-sol', effectiveThinkingOptionId: 'high', currentModeId: 'full-access', title: 'Steer A', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'A' } }),
    B: addAgent(world, { provider: 'muse', model: 'muse-spark-1.3-contributor', title: 'Steer B', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'B' } }),
  };
  return { ws, steers };
}

function discoveryOf(world) {
  return {
    forkName: REPO,
    mainWorkspace: world.workspaces[0] ? structuredClone(world.workspaces[0]) : null,
    steers: { labelled: structuredClone(resolveSteerHolders(world.agents.filter((a) => a.labels?.[LABEL.role] === 'steer'), world.agents)), legacy: [] },
    workers: structuredClone(world.agents.filter((a) => a.labels?.[PARENT_LABEL])),
    providers: structuredClone(world.providers),
  };
}

function fakePaseoCli(world) {
  return (args) => {
    assert.deepEqual(args.slice(0, 2), ['agent', 'update']);
    assert.equal(args[3], '--name');
    world.agents.find((agent) => agent.id === args[2]).title = args[4];
  };
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  const agentHandle = (id) => ({
    id,
    refresh: async () => ({ agent: structuredClone(findAgent(id)) }),
    archive: async () => {
      world.calls.push(['agent.archive', id]);
      if (world.hooks?.archiveFails) throw new Error('archive failed');
      const archivedAt = '2026-11-25T00:00:00Z';
      findAgent(id).archivedAt = archivedAt;
      return { archivedAt };
    },
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
      if (world.hooks.dropAuthorityReply && patch[METADATA_KEY]?.epoch === 2) throw new Error('lost authority reply');
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
        const agent = addAgent(world, { provider, model, title: opts.title, workspaceId: id, labels: { ...opts.labels }, metadata: structuredClone(opts.metadata ?? {}), currentModeId: opts.config.modeId, effectiveThinkingOptionId: opts.config.thinkingOptionId });
        if (opts.idempotencyKey) {
          world.receipts.set(opts.idempotencyKey, agent.id);
          world.fingerprints.set(opts.idempotencyKey, fingerprint);
        }
        if (world.hooks.dropResponseAfterCreate) throw new Error('socket closed before agent.create response');
        return agentHandle(agent.id);
      },
    },
  });
  return { workspaces: { ref: workspaceHandle }, agents: { ref: agentHandle, list: async () => ({ entries: structuredClone(world.agents), pageInfo: { hasMore: false } }) } };
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
  const fresh = (extra = {}) => freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, git: fakeGit(), lock: testLock, language: 'en', ...extra });
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

test('fresh apply: new agent of the same profile, epoch bump, archive confirmation and one destination brief', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  await writeCheckpoint({ client: fakeClient(world), discovery: discoveryOf(world), task: 'Ship it', tests: ['npm test'], blockers: [], lock: testLock });
  const result = await freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en' });
  assert.equal(result.applied, true);
  assert.equal(result.checkpoint, true);
  assert.equal(result.delivered, true);
  assert.equal(result.previousNotified, false);
  assert.equal(result.reused, false);
  assert.equal(result.from, steers.A.id);
  assert.ok(result.to && result.to !== steers.A.id);
  assert.match(result.packet, new RegExp(`Steer A \\(${result.to}\\) is now active`));
  assert.match(result.packet, /Task: Ship it/);

  const created = world.agents.find((a) => a.id === result.to);
  assert.equal(created.title, '▷ Steer A');
  assert.equal(created.provider, 'codex');
  assert.equal(created.model, 'gpt-6.2-sol');
  assert.deepEqual(created.labels, { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'A', [LABEL.scope]: REPO });
  assert.ok(world.calls.some((c) => c[0] === 'receipt.lookup' && c[2] === result.idempotencyKey));

  const state = world.workspaces[0].metadata[METADATA_KEY];
  assert.deepEqual({ ...state, switchedAt: undefined }, { main: true, activeSteer: 'A', activeAgentId: result.to, epoch: 2, previousSteer: 'A', switchedAt: undefined });
  assert.ok(Number.isFinite(Date.parse(state.switchedAt)));

  const sends = world.calls.filter((c) => c[0] === 'agent.send');
  assert.deepEqual(sends.map((c) => c[1]), [result.to]);

  const old = world.agents.find((a) => a.id === steers.A.id);
  assert.deepEqual(old.labels, { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'A' });
  assert.ok(old.archivedAt);
});

test('fresh apply labels the new steer with the resolved scope id', async () => {
  const world = makeWorld();
  provisioned(world);
  const discovery = { ...discoveryOf(world), scope: { id: 'notes', kind: 'dir', locator: '/p/demo' } };
  const result = await freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery, config: CONFIG, apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en' });
  assert.equal(result.applied, true);
  const created = world.agents.find((a) => a.id === result.to);
  assert.equal(created.labels[LABEL.scope], 'notes');
  assert.equal(created.labels[LABEL.repo], REPO, 'wsf.repo keeps the discovery name for compatibility');
});

test('fresh apply recovers an interrupted create through its receipt instead of recreating', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const run = (extra = {}) => freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', ...extra });

  world.hooks.dropResponseAfterCreate = true;
  await assert.rejects(run({ apply: true }), /socket closed before agent.create response/);
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].epoch, 1);
  const orphan = world.agents.find((a) => a.labels?.[LABEL.slot] === 'A' && a.id !== steers.A.id);
  assert.ok(orphan, 'the agent exists although its response was lost');
  assert.equal(orphan.metadata[LABEL.steerRole], 'coordinator');
  world.hooks.dropResponseAfterCreate = false;

  // A second preview can use the reservation even with both tabs live and
  // after the original model and host profile disappear from the catalog.
  world.providers = [];
  const changed = { ...CONFIG, profiles: {}, steers: { slots: {}, priority: [] } };
  const preview = await run({ config: changed });
  assert.equal(preview.from, steers.A.id);
  assert.equal(preview.model, orphan.model);
  const recovered = await run({ apply: true, config: changed });
  assert.equal(recovered.reused, true);
  assert.equal(recovered.to, orphan.id);
  assert.equal(recovered.from, steers.A.id);
  assert.equal(world.agents.length, 3, 'no second agent created');
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].epoch, 2);
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].previousSteer, 'A');
});

test('fresh refuses without state, on duplicates, stale epoch, busy steer, bad profile or bad receipt', async () => {
  const empty = makeWorld();
  await assert.rejects(
    freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(empty), client: fakeClient(empty), discovery: discoveryOf(empty), config: CONFIG, lock: testLock, language: 'en' }),
    /No factory main workspace/,
  );

  const world = makeWorld();
  const { steers } = provisioned(world);
  const run = (extra = {}) => freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', ...extra });

  steers.A.status = 'running';
  await assert.rejects(run(), /Active Steer A is running/);
  steers.A.status = 'idle';

  const stale = discoveryOf(world);
  world.workspaces[0].metadata[METADATA_KEY].epoch = 2;
  await assert.rejects(
    freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: stale, config: CONFIG, apply: true, lock: testLock, lookupReceipt: fakeLookup(world), language: 'en' }),
    /Steer state changed/,
  );
  world.workspaces[0].metadata[METADATA_KEY].epoch = 1;

  const withoutProfile = { ...CONFIG, steers: { slots: { A: 'missing' }, prepare: ['A'], initialActive: 'A' } };
  const unprofiled = await run({ config: withoutProfile });
  assert.equal(unprofiled.model, steers.A.model);
  assert.equal(unprofiled.profile, 'standard');
  world.providers = [];
  await assert.rejects(run(), /not startable/);
  world.providers = structuredClone(PROVIDERS);

  await assert.rejects(
    freshSteer({ archivePrevious: true, paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true, lock: testLock, language: 'en' }),
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

  // A completed fresh renames the old tab, freeing the slot for the new holder.
  await run({ apply: true });
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].epoch, 2);
  assert.equal(steers.A.title, 'Steer A');
  assert.ok(steers.A.archivedAt);
  const next = await run();
  assert.notEqual(next.from, steers.A.id);
});

// ---------------------------------------------------------------- ambiguity guards and live status

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

test('status ignores archived tabs and legacy scope metadata', async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const applied = await freshSteer({ archivePrevious: true, client: fakeClient(world), discovery: discoveryOf(world),
    config: CONFIG, apply: true, lock: testLock, lookupReceipt: fakeLookup(world), language: 'en' });
  Object.assign(ws.metadata[METADATA_KEY], { previousSteer: applied.from, retired: true, movedTo: '/old' });
  const status = steerStatus(discoveryOf(world));
  assert.equal(status.steers.some((agent) => agent.id === applied.from), false);
  assert.deepEqual(status.steers.map(({ slot }) => slot), ['A', 'B']);
  assert.equal(status.state.previousSteer, undefined);
  assert.equal(status.state.retired, undefined);
  assert.equal(status.state.movedTo, undefined);
  const preview = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG });
  assert.equal(preview.from, applied.to);
  assert.equal(preview.model, status.steers.find((agent) => agent.id === applied.to).model);
  ws.metadata[METADATA_KEY].activeAgentId = applied.from;
  assert.equal(steerStatus(discoveryOf(world)).state.activeAgentId, undefined);
});

test('Fresh recovers a legacy creation receipt with its original config and account pin', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const client = fakeClient(world);
  const old = buildSteerCreate({
    keyScope: REPO, repo: REPO, scopeId: REPO, slot: 'A', workspaceId: ws.id,
    profile: CONFIG.profiles.standard, title: '▷ Steer A', keyParts: ['steer', 'A', 'fresh-e1'],
  });
  const request = { config: old.request.config, title: old.request.title, labels: old.request.labels,
    idempotencyKey: old.idempotencyKey, metadata: { 'zerosub.account': 'original-pin' } };
  const handle = await client.workspaces.ref(ws.id).agents.create(request);
  world.providers = [];
  const changed = { ...CONFIG, profiles: {}, steers: { slots: {}, priority: [], activeMarker: '' } };
  const lookupReceipt = fakeLookup(world);
  const fresh = (apply) => freshSteer({ archivePrevious: true, client, discovery: discoveryOf(world), config: changed, apply, lookupReceipt,
    send: false, notifyPrevious: false, lock: testLock, paseoCli: fakePaseoCli(world) });
  const preview = await fresh(false);
  assert.equal(preview.from, steers.A.id);
  assert.equal(preview.idempotencyKey, old.idempotencyKey);
  const applied = await fresh(true);
  assert.equal(applied.to, (await handle.refresh()).agent.id);
  assert.equal(applied.reused, true);
  assert.deepEqual(world.calls.filter(([name]) => name === 'agent.create').map(([, request]) => request), [request, request]);
});

test('Fresh reconciles a committed active epoch when its metadata reply was lost', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const lookupReceipt = fakeLookup(world);
  const fresh = (apply) => freshSteer({ archivePrevious: true, client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG,
    apply, lookupReceipt, send: false, notifyPrevious: false, lock: testLock, paseoCli: fakePaseoCli(world) });
  const preview = await fresh(false);
  world.hooks.dropAuthorityReply = true;
  await assert.rejects(fresh(true), /lost authority reply/);
  assert.equal(ws.metadata[METADATA_KEY].epoch, 2);
  assert.equal(steers.A.title, 'Steer A');
  const recovery = await fresh(false);
  assert.equal(recovery.from, preview.from);
  assert.equal(recovery.epoch, preview.epoch);
  assert.equal(recovery.idempotencyKey, preview.idempotencyKey);
  const result = await fresh(true);
  assert.equal(result.to, ws.metadata[METADATA_KEY].activeAgentId);
  assert.equal(result.epoch, 2);
  assert.equal(result.reused, true);
  assert.equal(steers.A.title, 'Steer A');
  assert.ok(steers.A.archivedAt);
  assert.equal(world.calls.filter(([name]) => name === 'agent.create').length, 1);
});
