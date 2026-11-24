// Refresh paths: fresh for non-active steers and workers, parent-free creation,
// worker register pruning, same-slot superseded handling and slot-profile
// suggestions. Fake state only; no daemon.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshSteer, steerStatus, switchSteer } from '../src/steer.mjs';
import { markSupersededSlotHolders } from '../src/discovery.mjs';
import { planRepository } from '../src/planner.mjs';
import { createExecutors } from '../src/apply.mjs';
import { planSteerAdd } from '../src/steer-add.mjs';
import { WORKERS_KEY, formatWorkersPruneText, pruneWorkerRegister, staleWorkerEntries } from '../src/supervision.mjs';
import { formatSlotProfileSuggestion, suggestSlotProfile } from '../src/models.mjs';
import { scopeRows } from '../src/scopes-view.mjs';
import { withLock } from '../src/lock.mjs';
import { LABEL, METADATA_KEY, PARENT_LABEL } from '../src/paseo.mjs';
import { AGENTS_KEY } from '../src/agent-state.mjs';

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

function discoveryOf(world, extra = {}) {
  return {
    forkName: REPO,
    mainWorkspace: world.workspaces[0] ? structuredClone(world.workspaces[0]) : null,
    steers: { labelled: structuredClone(world.agents.filter((a) => a.labels?.[LABEL.role] === 'steer')), legacy: [], digitCandidates: [] },
    workers: structuredClone(world.agents.filter((a) => !a.archivedAt && (a.labels?.[PARENT_LABEL] || a.labels?.[LABEL.role] === 'worker'))),
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
        const slash = opts.config.provider.indexOf('/');
        const provider = opts.config.provider.slice(0, slash);
        const model = opts.config.provider.slice(slash + 1);
        const agent = addAgent(world, {
          provider, model, title: opts.title, workspaceId: id,
          labels: { ...opts.labels, ...(opts.parent ? { [PARENT_LABEL]: opts.parent } : {}) },
          currentModeId: opts.config.modeId,
        });
        if (opts.idempotencyKey) {
          world.receipts.set(opts.idempotencyKey, agent.id);
          world.fingerprints.set(opts.idempotencyKey, fingerprint);
        }
        return agentHandle(agent.id);
      },
    },
  });
  return { workspaces: { ref: workspaceHandle }, agents: { ref: agentHandle } };
}

function fakeLookup(world) {
  return async (kind, key) => {
    world.calls.push(['receipt.lookup', kind, key]);
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

const LOCK_TMP = mkdtempSync(join(tmpdir(), 'wsf-refresh-'));
const testLock = (name, fn) => withLock(name, fn, { dir: LOCK_TMP });

// ------------------------------------------------------- non-active steer

test('fresh --slot previews a non-active refresh without takeover or writes', async () => {
  const world = makeWorld();
  provisioned(world);
  const result = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', git: fakeGit(), lock: testLock, language: 'en' });
  assert.equal(result.applied, false);
  assert.equal(result.kind, 'steer');
  assert.equal(result.slot, 'B');
  assert.equal(result.to, null);
  assert.equal(result.epoch, 1);
  assert.equal(result.epochBumped, false);
  assert.equal(result.profile, 'cheap');
  assert.match(result.idempotencyKey, /^wsf:example-owner\/example-repo:steer:B:fresh-e1-[A-Za-z0-9]+:[0-9a-f]{10}$/);
  assert.match(result.packet, /Steer refresh for example-owner\/example-repo: Steer B gets a new agent at epoch 1 \(no takeover; active stays Steer A\)/);
  assert.match(result.packet, /You are Steer B of this scope \(not active: answer only, do not coordinate\)/);
  assert.match(result.packet, /Agent note: none recorded/);
  assert.deepEqual(world.calls, [], 'preview reads only');
});

test('fresh --slot apply creates an unmarked same-slot agent and leaves epoch and active steer untouched', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  world.workspaces[0].metadata[AGENTS_KEY] = { [steers.B.id]: { note: 'Rework the queue', noteAt: '2026-11-24T10:00:00.000Z' } };
  const result = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en' });
  assert.equal(result.applied, true);
  assert.equal(result.epochBumped, false);
  assert.equal(result.from, steers.B.id);
  assert.ok(result.to && result.to !== steers.B.id);
  assert.match(result.packet, new RegExp(`Steer B gets a new agent at epoch 1`));
  assert.match(result.packet, /Rework the queue/);
  assert.match(result.packet, /Notiz von|Note of/);

  const created = world.agents.find((a) => a.id === result.to);
  assert.equal(created.title, 'Steer B');
  assert.equal(created.provider, 'muse');
  assert.equal(created.model, 'muse-spark-1.3-contributor');
  assert.deepEqual(created.labels, { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'B', [LABEL.scope]: REPO });
  assert.equal(created.labels[PARENT_LABEL], undefined);

  const state = world.workspaces[0].metadata[METADATA_KEY];
  assert.deepEqual(state, { main: true, activeSteer: 'A', epoch: 1 });
  assert.ok(!world.calls.some((c) => c[0] === 'workspace.setMetadata'), 'no state write for a non-active refresh');

  const sends = world.calls.filter((c) => c[0] === 'agent.send');
  assert.deepEqual(sends.map((c) => c[1]), [result.to, steers.B.id]);
  assert.match(sends[1][2], /continues Steer B/);
  assert.equal(ws.id, created.workspaceId);
});

test('fresh --slot refuses busy, missing and ambiguous targets, and slot+worker together', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const run = (extra = {}) => freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', ...extra });
  steers.B.status = 'running';
  await assert.rejects(run({ slot: 'B' }), /Steer B is running/);
  steers.B.status = 'idle';
  await assert.rejects(run({ slot: 'Z' }), /No live Steer Z to refresh/);
  await assert.rejects(run({ slot: '1' }), /Not a steer slot/);
  await assert.rejects(run({ slot: 'B', workerId: steers.A.id }), /either --slot or --worker/);
  addAgent(world, { provider: 'muse', model: 'm', title: 'Steer B', workspaceId: world.workspaces[0].id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'B' } });
  await assert.rejects(run({ slot: 'B' }), /several live agents/);
});

test('fresh --slot with an explicit active slot behaves like the default takeover', async () => {
  const world = makeWorld();
  provisioned(world);
  const result = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'a', git: fakeGit(), lock: testLock, language: 'en' });
  assert.equal(result.slot, 'A');
  assert.equal(result.epoch, 2);
  assert.equal(result.epochBumped, true);
  assert.match(result.packet, /is now active/);
});

// ------------------------------------------------------------------ worker

function provisionedWithWorker(world) {
  const { ws, steers } = provisioned(world);
  const worker = addAgent(world, {
    provider: 'muse', model: 'muse-spark-1.3-contributor', title: 'Build it', workspaceId: ws.id,
    labels: { [PARENT_LABEL]: steers.A.id, [LABEL.scope]: REPO, [LABEL.role]: 'worker', [LABEL.owner]: 'A' },
  });
  return { ws, steers, worker };
}

test('fresh --worker previews and applies a same-role refresh without an epoch change', async () => {
  const world = makeWorld();
  const { steers, worker } = provisionedWithWorker(world);
  world.workspaces[0].metadata[AGENTS_KEY] = { [worker.id]: { note: 'Halfway through the build', noteAt: '2026-11-24T11:00:00.000Z' } };
  const preview = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, workerId: worker.id, git: fakeGit(), lock: testLock, language: 'en' });
  assert.equal(preview.kind, 'worker');
  assert.equal(preview.owner, 'A');
  assert.equal(preview.epoch, 1);
  assert.equal(preview.epochBumped, false);
  assert.equal(preview.profile, 'cheap');
  assert.match(preview.idempotencyKey, /^wsf:example-owner\/example-repo:worker:A:fresh-e1-[A-Za-z0-9]+:[0-9a-f]{10}$/);
  assert.match(preview.packet, new RegExp(`Worker refresh for example-owner/example-repo: "Build it" ${worker.id} → new agent, created on apply \\(owner Steer A, epoch unchanged\\)`));
  assert.match(preview.packet, /Halfway through the build/);
  assert.deepEqual(world.calls, [], 'preview reads only');

  const result = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, workerId: worker.id, apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en' });
  assert.equal(result.applied, true);
  assert.equal(result.from, worker.id);
  assert.ok(result.to && result.to !== worker.id);
  const created = world.agents.find((a) => a.id === result.to);
  assert.equal(created.title, 'Build it');
  assert.equal(created.provider, 'muse');
  assert.equal(created.model, 'muse-spark-1.3-contributor');
  assert.deepEqual(created.labels, { [LABEL.scope]: REPO, [LABEL.role]: 'worker', [LABEL.owner]: 'A', [PARENT_LABEL]: steers.A.id });
  assert.deepEqual(world.workspaces[0].metadata[METADATA_KEY], { main: true, activeSteer: 'A', epoch: 1 });
  const sends = world.calls.filter((c) => c[0] === 'agent.send');
  assert.deepEqual(sends.map((c) => c[1]), [result.to, worker.id]);
  assert.match(sends[1][2], /continues this worker/);
});

test('fresh --worker accepts a unique prefix and refuses unknown, ambiguous and busy workers', async () => {
  const world = makeWorld();
  const { worker } = provisionedWithWorker(world);
  const run = (extra = {}) => freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', ...extra });
  const prefix = await run({ workerId: worker.id.slice(0, 8) });
  assert.equal(prefix.from, worker.id);
  await assert.rejects(run({ workerId: 'no-such-worker' }), /not a live worker/);
  worker.status = 'running';
  await assert.rejects(run({ workerId: worker.id }), new RegExp(`Worker ${worker.id} is running`));
  worker.status = 'idle';
  addAgent(world, {
    provider: 'muse', model: 'm', title: 'Other', workspaceId: world.workspaces[0].id,
    labels: { [PARENT_LABEL]: world.agents[0].id, [LABEL.scope]: REPO, [LABEL.role]: 'worker', [LABEL.owner]: 'A' },
  });
  await assert.rejects(run({ workerId: 'agent-' }), /ambiguous.*full agent id/);
});

// ------------------------------------------------------------- parent link

test('fresh creates the steer without a parent link even when the caller is an agent', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const seen = [];
  const client = fakeClient(world);
  const execute = async (op) => {
    seen.push(op);
    const handle = await client.workspaces.ref(op.params.workspaceId).agents.create({
      config: op.params.config, title: op.params.title, labels: op.params.labels, idempotencyKey: op.params.idempotencyKey,
    });
    return { agentId: handle.id };
  };
  const saved = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = steers.A.id; // the calling agent must never become the parent
  try {
    const result = await freshSteer({ client, discovery: discoveryOf(world), config: CONFIG, apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), execute, language: 'en' });
    assert.ok(seen.length >= 1);
    for (const op of seen) assert.ok(!('parent' in op.params), 'steer create op carries no parent');
    const created = world.agents.find((a) => a.id === result.to);
    assert.equal(created.labels[PARENT_LABEL], undefined);
  } finally {
    if (saved === undefined) delete process.env.PASEO_AGENT_ID; else process.env.PASEO_AGENT_ID = saved;
  }
});

test('fresh refuses a parented agent from a custom executor before any state write', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const execute = async (op) => {
    const agent = addAgent(world, {
      provider: 'codex', model: 'gpt-6.2-sol', title: op.params.title, workspaceId: op.params.workspaceId,
      labels: { ...op.params.labels, [PARENT_LABEL]: steers.A.id },
    });
    return { agentId: agent.id };
  };
  await assert.rejects(
    freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), execute, language: 'en' }),
    /has parent .* refusing a parented fresh agent/,
  );
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].epoch, 1, 'no state write after the refusal');
});

test('the fresh executor flag detaches an inherited parent; without it creation still fails closed', async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const agents = new Map();
  let seq = 0;
  const client = {
    workspaces: {
      ref: (id) => ({
        agents: {
          create: async (opts) => {
            const agentId = `fresh-${++seq}`;
            agents.set(agentId, { id: agentId, workspaceId: id, archivedAt: null, labels: { ...opts.labels, [PARENT_LABEL]: 'caller-agent' } });
            return { id: agentId, refresh: async () => ({ agent: structuredClone(agents.get(agentId)) }) };
          },
        },
      }),
    },
  };
  const cliCalls = [];
  const paseoCli = (args) => {
    cliCalls.push(args);
    delete agents.get(args[2]).labels[PARENT_LABEL];
    return {};
  };
  const op = (clear) => ({
    key: 'steer.A.fresh', kind: 'paseo.agent.create', summary: 'fresh', params: {
      workspaceId: ws.id, title: 'Steer A', config: { provider: 'codex/gpt-6.2-sol' }, labels: { a: 'b' },
      ...(clear ? { clearInheritedParent: true } : {}), idempotencyKey: 'k',
    },
  });
  const run = createExecutors({ client, paseoCli });
  const cleared = await run(op(true));
  assert.equal(cleared.parent, null);
  assert.deepEqual(cliCalls, [['agent', 'detach', cleared.agentId]]);
  await assert.rejects(run(op(false)), /PARENT VIOLATION/);
});

test('fresh --worker keeps the previous parent and never the calling agent', async () => {
  const world = makeWorld();
  const { steers, worker } = provisionedWithWorker(world);
  const seen = [];
  const client = fakeClient(world);
  const execute = async (op) => {
    seen.push(op);
    const handle = await client.workspaces.ref(op.params.workspaceId).agents.create({
      config: op.params.config, title: op.params.title, labels: op.params.labels, parent: op.params.parent, idempotencyKey: op.params.idempotencyKey,
    });
    return { agentId: handle.id };
  };
  const saved = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = 'caller-other';
  try {
    const result = await freshSteer({ client, discovery: discoveryOf(world), config: CONFIG, workerId: worker.id, apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), execute, language: 'en' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].params.parent, steers.A.id);
    const created = world.agents.find((a) => a.id === result.to);
    assert.equal(created.labels[PARENT_LABEL], steers.A.id);
  } finally {
    if (saved === undefined) delete process.env.PASEO_AGENT_ID; else process.env.PASEO_AGENT_ID = saved;
  }
});

// ---------------------------------------------------- worker register prune

function workerEntry(task, state) {
  return { task, startedBy: 'A', startedAt: '2026-11-24T09:00:00.000Z', epoch: 1, state, status: null, resumes: 0, lastWakeAt: null, pendingWake: null };
}

test('staleWorkerEntries flags archived and unknown agents, never live ones', () => {
  const register = { 'w-live': workerEntry('a', 'running'), 'w-arch': workerEntry('b', 'blocked'), 'w-gone': workerEntry('c', 'running') };
  const agents = [{ id: 'w-live', archivedAt: null }, { id: 'w-arch', archivedAt: '2026-11-24T00:00:00.000Z' }];
  assert.deepEqual(staleWorkerEntries(register, agents), [
    { id: 'w-arch', reason: 'archived', state: 'blocked', task: 'b' },
    { id: 'w-gone', reason: 'unknown', state: 'running', task: 'c' },
  ]);
});

test('pruneWorkerRegister removes stale entries under the lock and verifies the write', async () => {
  const world = makeWorld();
  provisioned(world);
  world.workspaces[0].metadata[WORKERS_KEY] = { 'w-live': workerEntry('a', 'running'), 'w-arch': workerEntry('b', 'blocked'), 'w-gone': workerEntry('c', 'running') };
  const agents = [{ id: 'w-live', archivedAt: null }, { id: 'w-arch', archivedAt: '2026-11-24T00:00:00.000Z' }];
  const client = fakeClient(world);
  const { removed, register } = await pruneWorkerRegister({ client, workspaceId: world.workspaces[0].id, agents, lock: testLock });
  assert.deepEqual(removed.map((r) => r.id), ['w-arch', 'w-gone']);
  assert.deepEqual(Object.keys(register), ['w-live']);
  assert.deepEqual(Object.keys(world.workspaces[0].metadata[WORKERS_KEY]), ['w-live']);
  assert.equal(world.calls.filter((c) => c[0] === 'workspace.setMetadata').length, 1);
  const again = await pruneWorkerRegister({ client, workspaceId: world.workspaces[0].id, agents, lock: testLock });
  assert.deepEqual(again.removed, []);
  assert.equal(world.calls.filter((c) => c[0] === 'workspace.setMetadata').length, 1, 'no write when nothing is stale');
});

test('formatWorkersPruneText previews and reports removals', () => {
  const stale = [{ id: 'w-arch', reason: 'archived', state: 'blocked', task: 'b' }];
  const preview = formatWorkersPruneText(REPO, 1, stale);
  assert.match(preview, /prune preview: 1 stale entry/);
  assert.match(preview, /w-arch blocked "b" · agent archived/);
  assert.match(preview, /--prune --apply/);
  const applied = formatWorkersPruneText(REPO, 1, stale, { applied: true });
  assert.match(applied, /pruned 1 stale entry/);
  assert.ok(!applied.includes('--apply'));
  assert.match(formatWorkersPruneText(REPO, 1, []), /nothing to prune/);
});

// ------------------------------------------------------- superseded holders

function slotAgent(id, slot, createdAt) {
  return { id, archivedAt: null, labels: { [LABEL.role]: 'steer', [LABEL.slot]: slot }, ...(createdAt === undefined ? {} : { createdAt }) };
}

test('markSupersededSlotHolders marks older holders only with a unique newest timestamp', () => {
  const marked = markSupersededSlotHolders([
    slotAgent('old', 'B', '2026-11-24T09:00:00.000Z'),
    slotAgent('new', 'B', '2026-11-24T10:00:00.000Z'),
    slotAgent('solo', 'A', '2026-11-24T08:00:00.000Z'),
  ]);
  assert.equal(marked.find((a) => a.id === 'old').superseded, true);
  assert.equal(marked.find((a) => a.id === 'new').superseded, undefined);
  assert.equal(marked.find((a) => a.id === 'solo').superseded, undefined);

  const missing = markSupersededSlotHolders([slotAgent('a', 'B'), slotAgent('b', 'B', '2026-11-24T10:00:00.000Z')]);
  assert.ok(missing.every((a) => a.superseded === undefined), 'missing timestamps stay ambiguous');
  const tied = markSupersededSlotHolders([slotAgent('a', 'B', '2026-11-24T10:00:00.000Z'), slotAgent('b', 'B', '2026-11-24T10:00:00.000Z')]);
  assert.ok(tied.every((a) => a.superseded === undefined), 'tied timestamps stay ambiguous');
  const archived = markSupersededSlotHolders([{ ...slotAgent('old', 'B', '2026-11-24T09:00:00.000Z'), archivedAt: 'x' }, slotAgent('new', 'B', '2026-11-24T10:00:00.000Z')]);
  assert.ok(archived.every((a) => a.superseded === undefined), 'archived agents never participate');
});

test('status marks the older holder superseded; switch and refresh follow the newest', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  steers.B.createdAt = '2026-11-24T09:00:00.000Z';
  const newer = addAgent(world, {
    provider: 'muse', model: 'muse-spark-1.3-contributor', title: 'Steer B', workspaceId: ws.id,
    createdAt: '2026-11-24T10:00:00.000Z', labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'B' },
  });
  // discovery marks superseded holders; the fake discoveryOf mirrors it here
  const withMarks = () => {
    const discovery = discoveryOf(world);
    discovery.steers.labelled = markSupersededSlotHolders(discovery.steers.labelled);
    return discovery;
  };
  const status = steerStatus(withMarks());
  assert.equal(status.steers.find((s) => s.id === steers.B.id).superseded, true);
  assert.equal(status.steers.find((s) => s.id === newer.id).superseded, false);
  const switched = await switchSteer({ client: fakeClient(world), discovery: withMarks(), toSlot: 'B', lock: testLock, language: 'en' });
  assert.equal(switched.to, 'B');
  assert.match(switched.packet, new RegExp(`Steer B \\(${newer.id}\\) is now active`));
  const refreshed = await freshSteer({ client: fakeClient(world), discovery: withMarks(), config: CONFIG, slot: 'B', git: fakeGit(), lock: testLock, language: 'en' });
  assert.equal(refreshed.from, newer.id);
});

test('active fresh proceeds past a completed-fresh extra but refuses unexplained ones', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  steers.A.createdAt = '2026-11-24T09:00:00.000Z';
  const newer = addAgent(world, {
    provider: 'codex', model: 'gpt-6.2-sol', title: 'Steer A', workspaceId: ws.id,
    createdAt: '2026-11-24T10:00:00.000Z', labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'A' },
  });
  const withMarks = () => {
    const discovery = discoveryOf(world);
    discovery.steers.labelled = markSupersededSlotHolders(discovery.steers.labelled);
    return discovery;
  };
  world.workspaces[0].metadata[METADATA_KEY].previousSteer = steers.A.id; // a completed fresh explains the extra
  const preview = await freshSteer({ client: fakeClient(world), discovery: withMarks(), config: CONFIG, git: fakeGit(), lock: testLock, language: 'en' });
  assert.equal(preview.from, newer.id);
  world.workspaces[0].metadata[METADATA_KEY].previousSteer = 'someone-else';
  await assert.rejects(
    freshSteer({ client: fakeClient(world), discovery: withMarks(), config: CONFIG, git: fakeGit(), lock: testLock, language: 'en' }),
    /rerun with --apply to recover it/,
  );
});

test('scopes selects the newest holder as active and lists superseded ones', () => {
  const ws = {
    id: 'wks_main1', projectId: 'proj-1', title: 'Main', name: 'Main', workspaceDirectory: '/p/demo',
    metadata: { wsf: { main: true, activeSteer: 'B', epoch: 2, scope: { id: REPO, kind: 'github', locator: REPO } } },
  };
  const base = { workspaceId: ws.id, archivedAt: null, title: 'Steer B', provider: 'muse', model: 'm', status: 'idle', labels: { 'wsf.role': 'steer', 'wsf.repo': REPO, 'wsf.slot': 'B' } };
  const [row] = scopeRows({ workspaces: [ws], agents: [{ ...base, id: 'old-b', createdAt: '2026-11-24T09:00:00.000Z' }, { ...base, id: 'new-b', createdAt: '2026-11-24T10:00:00.000Z' }], projects: [], providers: [] }, { now: () => Date.now() });
  assert.equal(row.active.id, 'new-b');
  assert.deepEqual(row.superseded, [{ slot: 'B', id: 'old-b' }]);
});

// ------------------------------------------------- slot-profile suggestions

test('suggestSlotProfile distinguishes existing, ambiguous and missing matches', () => {
  assert.deepEqual(suggestSlotProfile(CONFIG, 'codex', 'gpt-6.2-sol'), { kind: 'existing', profile: 'standard' });
  assert.deepEqual(suggestSlotProfile(CONFIG, 'nope', 'nope'), { kind: 'none' });
  const twin = structuredClone(CONFIG);
  twin.profiles.twin = { provider: 'codex', model: 'gpt-6.2-sol', thinking: null, mode: null };
  assert.deepEqual(suggestSlotProfile(twin, 'codex', 'gpt-6.2-sol'), { kind: 'ambiguous', profiles: ['standard', 'twin'] });
  assert.equal(formatSlotProfileSuggestion(CONFIG, 'B', 'codex', 'gpt-6.2-sol'), 'paseo-factory steer set B "standard"');
  assert.equal(formatSlotProfileSuggestion(CONFIG, 'B', 'nope', 'nope'), 'paseo-factory steer set B nope/nope');
  assert.match(formatSlotProfileSuggestion(twin, 'B', 'codex', 'gpt-6.2-sol'), /one of "standard", "twin"/);
});

test('fresh with a fallback suggests aligning the slot profile afterwards', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  steers.B.provider = 'codex';
  steers.B.model = 'gpt-6.2-sol'; // B no longer occupies the cheap pair
  world.providers = world.providers.filter((p) => p.provider === 'muse'); // standard unstartable
  const result = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, git: fakeGit(), lock: testLock, language: 'en' });
  assert.equal(result.profile, 'cheap');
  assert.equal(result.fallbackFrom, 'standard');
  assert.equal(result.profileSuggestion, 'paseo-factory steer set A "cheap"');
  assert.ok(result.warnings.some((w) => w.includes('using fallback "cheap"')));
});

test('steer add sets the slot profile matching the created steer', () => {
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], { slot: 'C', scopeId: 'notes', workspaceId: 'wks_main', repo: 'notes' });
  assert.ok(plan.profile);
  assert.equal(plan.config.steers.slots.C, plan.profileName);
  const stored = plan.config.profiles[plan.profileName];
  assert.equal(`${stored.provider}/${stored.model}`, `${plan.profile.provider}/${plan.profile.model}`);
  assert.equal(plan.op.params.config.provider, `${stored.provider}/${stored.model}`);
});

test('fresh warns when the live steer runs another model and suggests keeping it', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  steers.B.provider = 'codex';
  steers.B.model = 'gpt-6.2-sol'; // slot B profile cheap names muse/...
  const result = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', git: fakeGit(), lock: testLock, language: 'en' });
  assert.equal(result.profile, 'cheap', 'fresh recreates with the slot profile');
  assert.ok(result.warnings.some((w) => w.includes('runs codex/gpt-6.2-sol') && w.includes('names muse/muse-spark-1.3-contributor')));
  assert.equal(result.profileSuggestion, 'paseo-factory steer set B "standard"');
});

// ------------------------------------------------------- planner integration

function planDiscovery(labelled, { legacy = [], scopeId = 'notes' } = {}) {
  const ws = {
    id: 'wks_main', projectId: 'prj_1', title: 'Main', name: 'Main', workspaceDirectory: '/p/notes', workspaceKind: 'local_checkout',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: scopeId, kind: 'dir', locator: '/p/notes' } } },
    createdAt: '2026-11-24T00:00:00.000Z',
  };
  return {
    input: '/p/notes', parentDir: '/p', local: true, localPath: '/p/notes',
    github: { local: true, fork: { status: 'local' }, upstream: null, source: null, notes: [] },
    forkName: scopeId, scope: { id: scopeId, kind: 'dir', locator: '/p/notes' },
    requestedName: null, requestedSubject: null, requestedDomain: undefined, liveScopes: [],
    expectedPath: '/p/notes', cloneTarget: null,
    checkout: { path: '/p/notes', linkedWorktree: false, remotes: {}, repos: {}, local: true },
    checkoutIssues: [], relatedCheckouts: [], upstreamRemote: null,
    projects: [{ projectId: 'prj_1', projectRootPath: '/p/notes' }],
    mainCandidates: [ws], otherLocalWorkspaces: [], mainWorkspace: ws,
    steers: { labelled, legacy, digitCandidates: [], foreignWorkers: [], halfLabelled: [] },
    workers: [], agents: [...labelled, ...legacy], projectWorkspaceIds: ['wks_main'],
    providers: structuredClone(PROVIDERS),
  };
}

function labelledSteer(id, slot, provider, model, createdAt) {
  return {
    id, workspaceId: 'wks_main', archivedAt: null, title: `Steer ${slot}`, provider, model, status: 'idle',
    ...(createdAt === undefined ? {} : { createdAt }),
    labels: { [LABEL.scope]: 'notes', [LABEL.role]: 'steer', [LABEL.slot]: slot },
  };
}

test('plan keeps a superseded extra as a note but conflicts on several live holders', () => {
  const marked = markSupersededSlotHolders([
    labelledSteer('a', 'A', 'codex', 'gpt-6.2-sol'),
    labelledSteer('b-old', 'B', 'muse', 'muse-spark-1.3-contributor', '2026-11-24T09:00:00.000Z'),
    labelledSteer('b-new', 'B', 'muse', 'muse-spark-1.3-contributor', '2026-11-24T10:00:00.000Z'),
  ]);
  const plan = planRepository(planDiscovery(marked), CONFIG, {});
  assert.deepEqual(plan.conflicts, []);
  assert.match(plan.notes.join('\n'), /Steer B has superseded agent\(s\) b-old; newest b-new wins/);

  const live = planRepository(planDiscovery([
    labelledSteer('a', 'A', 'codex', 'gpt-6.2-sol'),
    labelledSteer('b-old', 'B', 'muse', 'muse-spark-1.3-contributor'),
    labelledSteer('b-new', 'B', 'muse', 'muse-spark-1.3-contributor'),
  ]), CONFIG, {});
  assert.match(live.conflicts.find((c) => c.key === 'steer.B').reason, /Several agents are labelled as Steer B/);
});

test('plan suggests the slot profile matching an adopted steer', () => {
  const candidate = {
    id: 'cand-b', workspaceId: 'wks_main', archivedAt: null, title: 'Steer B', provider: 'codex', model: 'gpt-6.2-sol', status: 'idle',
    labels: {},
  };
  const plan = planRepository(planDiscovery([labelledSteer('a', 'A', 'codex', 'gpt-6.2-sol')], { legacy: [candidate] }), CONFIG, { adopt: { B: 'cand-b' } });
  assert.equal(plan.ops.find((o) => o.key === 'steer.B').kind, 'paseo.agent.adopt');
  assert.match(plan.notes.join('\n'), /Adopted Steer B runs codex\/gpt-6\.2-sol; profile "cheap" names muse\/muse-spark-1\.3-contributor \(kept\) — to match the slot profile to the live steer: paseo-factory steer set B "standard"/);
});
