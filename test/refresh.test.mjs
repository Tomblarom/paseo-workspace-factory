// Refresh paths: fresh for non-active steers and workers, parent-free creation,
// worker register pruning, same-slot ambiguity and slot-profile
// suggestions. Fake state only; no daemon.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshSteer, steerStatus, switchSteer } from '../plugin/server/core/steer.mjs';
import { steerPrivacyAdmission } from '../plugin/server/core/config.mjs';
import { resolveSteerHolders } from '../plugin/server/core/discovery.mjs';
import { planRepository } from '../plugin/server/core/planner.mjs';
import { buildSteerCreate } from '../plugin/server/core/steer-create.mjs';
import { applyPlans, createAuthorization, createExecutors } from '../plugin/server/core/apply.mjs';
import { planSteerAdd } from '../plugin/server/core/steer-add.mjs';
import { WORKERS_KEY, formatWorkersPruneText, pruneWorkerRegister, staleWorkerEntries } from '../plugin/server/core/supervision.mjs';
import { formatSlotProfileSuggestion, suggestSlotProfile } from '../plugin/server/core/models.mjs';
import { scopeRows } from '../plugin/server/core/scopes-view.mjs';
import { withLock } from '../plugin/server/core/lock.mjs';
import { LABEL, METADATA_KEY, PARENT_LABEL } from '../plugin/server/core/paseo.mjs';
import { AGENTS_KEY } from '../plugin/server/core/agent-state.mjs';

// ---------------------------------------------------------------- fixtures

const REPO = 'example-owner/example-repo';
const CONFIG = {
  version: 1,
  github: { owner: 'example-owner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    standard: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
    cheap: { provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null, mode: 'allowAll', sensitive: false },
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
    B: addAgent(world, { provider: 'muse', model: 'muse-spark-1.3-contributor', currentModeId: 'allowAll', title: 'Steer B', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'B' } }),
  };
  return { ws, steers };
}

function discoveryOf(world, extra = {}) {
  return {
    forkName: REPO,
    mainWorkspace: world.workspaces[0] ? structuredClone(world.workspaces[0]) : null,
    steers: { labelled: structuredClone(resolveSteerHolders(world.agents.filter((a) => a.labels?.[LABEL.role] === 'steer'), world.agents)), legacy: [], digitCandidates: [] },
    workers: structuredClone(world.agents.filter((a) => !a.archivedAt && (a.labels?.[PARENT_LABEL] || a.labels?.[LABEL.role] === 'worker'))),
    agents: structuredClone(world.agents),
    providers: structuredClone(world.providers),
    github: { fork: { repo: { private: false } } },
    ...extra,
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
    send: async (text, options) => {
      if (world.hooks.sendFails) throw new Error('agent unreachable');
      world.calls.push(['agent.send', id, text, options]);
      world.hooks.afterSend?.(id);
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
          metadata: opts.metadata,
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
  return { workspaces: { ref: workspaceHandle }, agents: { ref: agentHandle, list: async () => ({ entries: structuredClone(world.agents), pageInfo: { hasMore: false } }) } };
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
  const result = await freshSteer({ paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', git: fakeGit(), lock: testLock, language: 'en' });
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

test('new-agent fresh admits sensitive steers only on proven public scope', async () => {
  for (const isPrivate of [false, true, undefined]) {
    for (const slot of ['A', 'B']) {
      const world = makeWorld();
      provisioned(world);
      const config = structuredClone(CONFIG);
      config.profiles.standard.sensitive = true;
      config.profiles.cheap.sensitive = true;
      const discovery = discoveryOf(world, { github: { fork: { repo: { private: isPrivate } } } });
      const action = () => freshSteer({
        client: fakeClient(world), discovery, config, slot, send: false, notifyPrevious: false, apply: isPrivate !== false,
        git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en',
      });
      if (isPrivate === false) assert.ok((await action()).profile);
      else await assert.rejects(action(), /public scope required/);
      assert.equal(world.calls.length, 0);
    }
  }
});

test('fresh --slot apply creates an unmarked same-slot agent and leaves epoch and active steer untouched', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  world.workspaces[0].metadata[AGENTS_KEY] = { [steers.B.id]: { note: 'Rework the queue', noteAt: '2026-11-24T10:00:00.000Z' } };
  const result = await freshSteer({ paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en' });
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
  assert.ok(!world.calls.some((c) => c[0] === 'workspace.setMetadata' && c[2]?.[METADATA_KEY]), 'no scope ownership write for a non-active refresh');

  const sends = world.calls.filter((c) => c[0] === 'agent.send');
  assert.deepEqual(sends.map((c) => c[1]), [result.to, steers.B.id]);
  assert.match(sends[1][2], /continues Steer B/);
  assert.equal(ws.id, created.workspaceId);
});

test('fresh --slot delivery failure keeps the pinned brief for a manual resend', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  world.hooks.sendFails = true;
  const result = await freshSteer({ paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', apply: true, notifyPrevious: false, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en' });
  assert.equal(result.applied, true);
  assert.equal(result.delivered, false);
  assert.match(result.deliveryError ?? '', /agent unreachable/);
  assert.match(result.packet, /Steer refresh for/);
  const entry = world.workspaces[0].metadata[AGENTS_KEY][result.to];
  assert.equal(entry.action.kind, 'fresh-delivery');
  assert.equal(entry.action.phase, 'uncertain');
  assert.equal(entry.action.packet, result.packet);
  assert.equal(world.agents.length, 3, 'the fresh steer stands');
});

test('fresh refuses a direct brief and notice when public visibility has no sanitized handoff', async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const config = structuredClone(CONFIG);
  config.profiles.cheap.sensitive = true;
  const result = await freshSteer({
    client: fakeClient(world), discovery: discoveryOf(world), config, slot: 'B',
    apply: true, paseoCli: fakePaseoCli(world), lock: testLock, lookupReceipt: fakeLookup(world),
  });
  assert.equal(result.applied, true);
  assert.equal(result.delivered, false);
  assert.match(result.deliveryError, /verified sanitized brief/);
  assert.equal(result.previousNotified, false);
  assert.deepEqual(world.calls.filter(([kind]) => kind === 'agent.send'), []);
  const action = ws.metadata[AGENTS_KEY][result.to].action;
  assert.equal(action.phase, 'ready');
  assert.equal(action.packet, result.packet);
  assert.equal(action.attemptedAt, undefined);
});

test('fresh checks each old-agent notice after delivery to the replacement', async () => {
  for (const kind of ['active', 'standby', 'worker']) {
    const world = makeWorld();
    const { steers, worker } = provisionedWithWorker(world);
    const previous = kind === 'active' ? steers.A : kind === 'standby' ? steers.B : worker;
    const target = kind === 'standby' ? { slot: 'B' } : kind === 'worker' ? { workerId: worker.id } : {};
    world.hooks.afterSend = () => { previous.provider = 'restricted'; };
    const config = structuredClone(CONFIG);
    config.profiles.restricted = { provider: 'restricted', model: 'm', sensitive: true };
    const result = await freshSteer({
      client: fakeClient(world), discovery: discoveryOf(world), config, ...target,
      apply: true, paseoCli: fakePaseoCli(world), lock: testLock, lookupReceipt: fakeLookup(world),
    });
    assert.equal(result.delivered, true, kind);
    assert.equal(result.previousNotified, false, kind);
    assert.deepEqual(world.calls.filter(([call]) => call === 'agent.send').map(([, id]) => id), [result.to], kind);
  }
});

test('fresh --slot retry after a failed retirement reuses the creation receipt', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  world.hooks.sendFails = true;
  let renameFails = true;
  const writer = (args) => {
    if (renameFails) throw new Error('rename failed');
    return fakePaseoCli(world)(args);
  };
  const liveConfig = structuredClone(CONFIG);
  const run = () => freshSteer({ paseoCli: writer, client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', apply: true, notifyPrevious: false, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en',
    admitTarget: (agent) => steerPrivacyAdmission(liveConfig, agent, true) });
  const first = await run();
  assert.equal(first.delivered, false);
  assert.match(first.renameError, /rename failed/);
  assert.equal(world.agents.length, 3, 'old + fresh agents share the slot, so no single holder resolves');
  const originalAction = structuredClone(world.workspaces[0].metadata[AGENTS_KEY][first.to].action);
  // A note written after the failure must not leak into the retried send:
  // recovery replays the pinned brief, it does not rebuild it.
  world.workspaces[0].metadata[AGENTS_KEY] = {
    ...world.workspaces[0].metadata[AGENTS_KEY],
    [steers.B.id]: { ...world.workspaces[0].metadata[AGENTS_KEY][steers.B.id], note: 'written after the failure', noteAt: '2026-11-24T12:00:00.000Z' },
  };
  world.hooks.sendFails = false;
  liveConfig.profiles.cheap.sensitive = true;
  const denied = await run();
  assert.equal(denied.to, first.to);
  assert.equal(denied.delivered, false);
  assert.match(denied.deliveryError, /verified sanitized brief/);
  assert.deepEqual(world.workspaces[0].metadata[AGENTS_KEY][first.to].action, originalAction);
  assert.deepEqual(world.calls.filter(([kind]) => kind === 'agent.send'), []);
  liveConfig.profiles.cheap.sensitive = false;
  renameFails = false;
  const second = await run();
  assert.equal(second.to, first.to, 'recovery reuses the created agent');
  assert.equal(second.from, steers.B.id, 'the old holder is still the refresh source');
  assert.equal(second.reused, true);
  assert.equal(second.delivered, true);
  assert.equal(second.idempotencyKey, first.idempotencyKey, 'the retry finds the receipt under the same stable key');
  assert.equal(world.agents.length, 3, 'no second agent created');
  const sends = world.calls.filter((c) => c[0] === 'agent.send' && c[1] === first.to);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][2], first.packet, 'the pinned brief is sent, not a rebuilt one');
  assert.equal(sends[0][3].messageId, originalAction.wakeId);
  assert.ok(!sends[0][2].includes('written after the failure'));
});

test('fresh --slot refuses busy, missing and ambiguous targets, and slot+worker together', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const run = (extra = {}) => freshSteer({ paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', ...extra });
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
  const result = await freshSteer({ paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'a', git: fakeGit(), lock: testLock, language: 'en' });
  assert.equal(result.slot, 'A');
  assert.equal(result.epoch, 2);
  assert.equal(result.epochBumped, true);
  assert.match(result.packet, /is now active/);
});

// ------------------------------------------------------------------ worker

function provisionedWithWorker(world) {
  const { ws, steers } = provisioned(world);
  const worker = addAgent(world, {
    provider: 'muse', model: 'muse-spark-1.3-contributor', currentModeId: 'allowAll', title: 'Build it', workspaceId: ws.id,
    labels: { [PARENT_LABEL]: steers.A.id, [LABEL.scope]: REPO, [LABEL.role]: 'worker', [LABEL.owner]: 'A' },
  });
  return { ws, steers, worker };
}

test('fresh --worker previews and applies a same-role refresh without an epoch change', async () => {
  const world = makeWorld();
  const { steers, worker } = provisionedWithWorker(world);
  world.workspaces[0].metadata[AGENTS_KEY] = { [worker.id]: { note: 'Halfway through the build', noteAt: '2026-11-24T11:00:00.000Z' } };
  const preview = await freshSteer({ paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, workerId: worker.id, git: fakeGit(), lock: testLock, language: 'en' });
  assert.equal(preview.kind, 'worker');
  assert.equal(preview.owner, 'A');
  assert.equal(preview.epoch, 1);
  assert.equal(preview.epochBumped, false);
  assert.equal(preview.profile, 'cheap');
  assert.match(preview.idempotencyKey, /^wsf:example-owner\/example-repo:worker:A:fresh-e1-[A-Za-z0-9]+:[0-9a-f]{10}$/);
  assert.match(preview.packet, new RegExp(`Worker refresh for example-owner/example-repo: "Build it" ${worker.id} → new agent, created on apply \\(owner Steer A, epoch unchanged\\)`));
  assert.match(preview.packet, /Halfway through the build/);
  assert.deepEqual(world.calls, [], 'preview reads only');

  const result = await freshSteer({ paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, workerId: worker.id, apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en' });
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

test('fresh --worker delivery retry replays the pinned action on the same agent', async () => {
  const world = makeWorld();
  const { worker } = provisionedWithWorker(world);
  world.hooks.sendFails = true;
  const run = () => freshSteer({ paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, workerId: worker.id, apply: true, notifyPrevious: false, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en' });
  const first = await run();
  assert.equal(first.delivered, false);
  const actionId = world.workspaces[0].metadata[AGENTS_KEY][first.to].action.wakeId;
  world.hooks.sendFails = false;
  const second = await run();
  assert.equal(second.to, first.to, 'recovery reuses the created agent');
  assert.equal(second.delivered, true);
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY][first.to].action.wakeId, actionId, 'recovery replays the pinned action, not a new one');
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY][first.to].action.phase, 'done');
  const sends = world.calls.filter((c) => c[0] === 'agent.send' && c[1] === first.to);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][2], first.packet, 'the pinned brief is sent, not a rebuilt one');
  assert.equal(world.agents.length, 4, 'no second agent created');
});

test('fresh --worker accepts a unique prefix and refuses unknown, ambiguous and busy workers', async () => {
  const world = makeWorld();
  const { worker } = provisionedWithWorker(world);
  const run = (extra = {}) => freshSteer({ paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', ...extra });
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
    const result = await freshSteer({ paseoCli: fakePaseoCli(world), client, discovery: discoveryOf(world), config: CONFIG, apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), execute, language: 'en' });
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
    freshSteer({ paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), execute, language: 'en' }),
    /failed placement verification.*PARENT VIOLATION/,
  );
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].epoch, 1, 'no state write after the refusal');
});

test('the fresh executor flag detaches an inherited parent; without it creation still fails closed', async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const agents = new Map();
  let seq = 0;
  const detached = [];
  const client = {
    workspaces: {
      ref: (id) => ({
        agents: {
          create: async (opts) => {
            const agentId = `fresh-${++seq}`;
            agents.set(agentId, { id: agentId, workspaceId: id, archivedAt: null, labels: { ...opts.labels, [PARENT_LABEL]: 'caller-agent' } });
            return {
              id: agentId,
              refresh: async () => ({ agent: structuredClone(agents.get(agentId)) }),
              detach: async () => {
                detached.push(agentId);
                delete agents.get(agentId).labels[PARENT_LABEL];
              },
            };
          },
        },
      }),
    },
  };
  const op = (clear) => ({
    key: 'steer.A.fresh', kind: 'paseo.agent.create', summary: 'fresh', params: {
      workspaceId: ws.id, title: 'Steer A', config: { provider: 'codex/gpt-6.2-sol' }, labels: { a: 'b' },
      ...(clear ? { clearInheritedParent: true } : {}), idempotencyKey: 'k',
    },
  });
  const run = createExecutors({ client });
  const cleared = await run(op(true));
  assert.equal(cleared.parent, null);
  assert.deepEqual(detached, [cleared.agentId]);
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
    const result = await freshSteer({ paseoCli: fakePaseoCli(world), client, discovery: discoveryOf(world), config: CONFIG, workerId: worker.id, apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), execute, language: 'en' });
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

// ------------------------------------------------------- ambiguous holders

test('switch and refresh refuse two live same-title holders', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  steers.B.createdAt = '2026-11-24T09:00:00.000Z';
  addAgent(world, {
    provider: 'muse', model: 'muse-spark-1.3-contributor', title: 'Steer B', workspaceId: ws.id,
    createdAt: '2026-11-24T10:00:00.000Z', labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'B' },
  });
  await assert.rejects(switchSteer({ client: fakeClient(world), discovery: discoveryOf(world), toSlot: 'B', lock: testLock, language: 'en' }), /several|ambiguous/i);
  await assert.rejects(freshSteer({ paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', git: fakeGit(), lock: testLock, language: 'en' }), /several|ambiguous/i);
});

test('scopes does not select an ambiguous holder', () => {
  const ws = {
    id: 'wks_main1', projectId: 'proj-1', title: 'Main', name: 'Main', workspaceDirectory: '/p/demo',
    metadata: { wsf: { main: true, activeSteer: 'B', epoch: 2, scope: { id: REPO, kind: 'github', locator: REPO } } },
  };
  const base = { workspaceId: ws.id, archivedAt: null, title: 'Steer B', provider: 'muse', model: 'm', status: 'idle', labels: { 'wsf.role': 'steer', 'wsf.repo': REPO, 'wsf.slot': 'B' } };
  const [row] = scopeRows({ workspaces: [ws], agents: [{ ...base, id: 'old-b', createdAt: '2026-11-24T09:00:00.000Z' }, { ...base, id: 'new-b', createdAt: '2026-11-24T10:00:00.000Z' }], projects: [], providers: [] }, { now: () => Date.now() });
  assert.equal(row.active, null);
});

// ------------------------------------------------- slot-profile suggestions

test('suggestSlotProfile distinguishes existing, ambiguous and missing matches', () => {
  assert.deepEqual(suggestSlotProfile(CONFIG, 'codex', 'gpt-6.2-sol'), { kind: 'existing', profile: 'standard' });
  assert.deepEqual(suggestSlotProfile(CONFIG, 'nope', 'nope'), { kind: 'none' });
  const twin = structuredClone(CONFIG);
  twin.profiles.twin = { provider: 'codex', model: 'gpt-6.2-sol', thinking: null, mode: null };
  assert.deepEqual(suggestSlotProfile(twin, 'codex', 'gpt-6.2-sol'), { kind: 'ambiguous', profiles: ['standard', 'twin'] });
  assert.equal(formatSlotProfileSuggestion(CONFIG, 'B', 'codex', 'gpt-6.2-sol'), '/factory steer set B "standard"');
  assert.equal(formatSlotProfileSuggestion(CONFIG, 'B', 'nope', 'nope'), '/factory steer set B nope/nope');
  assert.match(formatSlotProfileSuggestion(twin, 'B', 'codex', 'gpt-6.2-sol'), /one of "standard", "twin"/);
});

test('fresh uses an eligible fallback without suggesting a host preference edit', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  steers.B.provider = 'codex';
  steers.B.model = 'gpt-6.2-sol'; // B no longer occupies the cheap pair
  world.providers = world.providers.filter((p) => p.provider === 'muse'); // standard unstartable
  const result = await freshSteer({ paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, git: fakeGit(), lock: testLock, language: 'en' });
  assert.equal(result.profile, 'cheap');
  assert.equal(result.fallbackFrom, 'standard');
  assert.equal(result.profileSuggestion, null);
  assert.ok(result.warnings.some((w) => w.includes('Using fallback "cheap"')));
});

test('steer add builds the selected route without editing the host preferences', () => {
  const before = structuredClone(CONFIG);
  const plan = planSteerAdd(CONFIG, PROVIDERS, [], { scopeId: 'notes', workspaceId: 'wks_main', repo: 'notes' });
  assert.equal(plan.slot, 'A');
  assert.equal(plan.op.params.config.provider, `${plan.profile.provider}/${plan.profile.model}`);
  assert.deepEqual(CONFIG, before);
});

test('fresh preserves a live model that differs from the legacy slot profile', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  steers.B.provider = 'codex';
  steers.B.model = 'gpt-6.2-sol'; // slot B profile cheap names muse/...
  steers.B.currentModeId = 'full-access';
  steers.B.effectiveThinkingOptionId = 'high';
  const result = await freshSteer({ paseoCli: fakePaseoCli(world), client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', git: fakeGit(), lock: testLock, language: 'en' });
  assert.equal(result.profile, 'standard');
  assert.equal(result.provider, 'codex');
  assert.equal(result.model, 'gpt-6.2-sol');
  assert.equal(result.profileSuggestion, null);
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

test('planner applies sensitive scope admission before creating steers', () => {
  const config = structuredClone(CONFIG);
  config.profiles.standard.sensitive = true;
  config.profiles.cheap.sensitive = true;
  for (const isPrivate of [false, true, undefined]) {
    const discovery = planDiscovery([]);
    discovery.github.fork.repo = { private: isPrivate };
    const plan = planRepository(discovery, config, { slots: ['A'], legacyEnrollment: true });
    if (isPrivate === false) {
      assert.equal(plan.ops.find((op) => op.key === 'steer.A').params.config.provider, 'codex/gpt-6.2-sol');
    } else {
      assert.ok(!plan.ops.some((op) => op.key === 'steer.A'));
      assert.match(plan.conflicts.find((c) => c.key === 'steer.A').reason, /public scope required/);
    }
  }
});

test('planner apply rejects a sensitive creation if public evidence changes', async () => {
  const config = structuredClone(CONFIG);
  config.profiles.standard.sensitive = true;
  config.profiles.cheap.sensitive = true;
  const discovery = planDiscovery([]);
  discovery.github.fork.repo = { private: false };
  const options = { slots: ['A'], legacyEnrollment: true };
  const planned = planRepository(discovery, config, options);
  const authorization = createAuthorization([planned], config, { entries: ['notes'], slots: ['A'] });
  discovery.github.fork.repo.private = true;
  let executions = 0;
  await assert.rejects(applyPlans({
    authorization, config, confirm: authorization.hash,
    runPlans: async () => [planRepository(discovery, config, options)],
    execute: async () => { executions++; },
  }), /State changed since the dry-run/);
  assert.equal(executions, 0);
});

test('planner skips exhausted profiles and leaves the account choice to ZeroSub', () => {
  const zerosub = { accounts: [
    { id: 'full', family: 'codex', exhausted: true, windows: [] },
    { id: 'room', family: 'muse', exhausted: false, windows: [], maxUsedPct: 20 },
  ] };
  const discovery = planDiscovery([]);
  discovery.github.fork.repo = { private: false };
  const plan = planRepository(discovery, CONFIG, { slots: ['A'], zerosub, legacyEnrollment: true });
  const create = plan.ops.find((op) => op.key === 'steer.A');
  assert.equal(create.params.config.provider, 'muse/muse-spark-1.3-contributor');
  assert.equal(create.params.metadata, undefined);
});

test('executor omits old automatic pins for both create kinds even when ZeroSub is unavailable', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const client = fakeClient(world);
  let state = { accounts: [{ id: 'live', family: 'codex', exhausted: false, windows: [], maxUsedPct: 10 }] };
  const execute = createExecutors({ client, getZerosub: async () => state, lookupReceipt: fakeLookup(world) });
  const params = {
    workspaceId: ws.id, title: 'Steer C', config: { provider: 'codex/gpt-6.2-sol' },
    labels: { [LABEL.role]: 'steer', [LABEL.scope]: REPO, [LABEL.slot]: 'C' },
    metadata: { 'zerosub.account': 'planned', other: 'kept' }, idempotencyKey: 'live-steer',
  };
  const steer = await execute({ kind: 'paseo.agent.create', params });
  assert.equal(steer.accountId, null);
  assert.deepEqual(world.agents.find((agent) => agent.id === steer.agentId).metadata, { other: 'kept' });
  state = { accounts: [{ id: 'new', family: 'codex', exhausted: false, windows: [], maxUsedPct: 1 }] };
  const retry = await execute({ kind: 'paseo.agent.create', params });
  assert.equal(retry.agentId, steer.agentId);
  assert.equal(retry.accountId, null);
  const worker = await execute({ kind: 'paseo.agent.createWorker', params: {
    ...params, title: 'Worker', labels: { [LABEL.role]: 'worker', [LABEL.scope]: REPO },
    parent: steers.A.id, idempotencyKey: 'live-worker',
  } });
  assert.equal(worker.accountId, null);
  const fallback = createExecutors({ client, getZerosub: async () => { throw new Error('offline'); } });
  const created = await fallback({ kind: 'paseo.agent.create', params: { ...params, idempotencyKey: 'offline' } });
  assert.equal(created.accountId, null);
});

test('planner and executor use the configured exhaustion threshold, including receipt retries', async () => {
  const config = { ...CONFIG, quota: { exhaustedPct: 90 } };
  let state = { accounts: [
    { id: 'near', family: 'codex', exhausted: false, windows: [], maxUsedPct: 92 },
    { id: 'room', family: 'muse', exhausted: false, windows: [], maxUsedPct: 20 },
  ] };
  const discovery = planDiscovery([]);
  discovery.github.fork.repo = { private: false };
  const plan = planRepository(discovery, config, { slots: ['A'], zerosub: state, legacyEnrollment: true });
  assert.equal(plan.ops.find((op) => op.key === 'steer.A').params.config.provider, 'muse/muse-spark-1.3-contributor');
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const execute = createExecutors({ client: fakeClient(world), getZerosub: async () => state, lookupReceipt: fakeLookup(world) });
  const params = {
    workspaceId: ws.id, title: 'Steer C', config: { provider: 'codex/gpt-6.2-sol' },
    labels: { [LABEL.role]: 'steer', [LABEL.scope]: REPO, [LABEL.slot]: 'C' }, idempotencyKey: 'threshold',
  };
  await assert.rejects(execute({ kind: 'paseo.agent.create', params }, config), /All codex accounts are exhausted/);
  await assert.rejects(execute({ kind: 'paseo.agent.createWorker', params: {
    ...params, labels: { [LABEL.role]: 'worker', [LABEL.scope]: REPO }, parent: steers.A.id,
  } }, config), /All codex accounts are exhausted/);
  assert.equal(world.agents.length, 2);
  state.accounts[0].maxUsedPct = 89;
  const created = await execute({ kind: 'paseo.agent.create', params }, config);
  assert.equal(created.accountId, null);
  state.accounts[0].maxUsedPct = 92;
  const retry = await execute({ kind: 'paseo.agent.create', params }, config);
  assert.equal(retry.agentId, created.agentId);
  assert.equal(retry.accountId, null);
});

test('a lost response from the old executor replays its completed creation and reserved pin', async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const client = fakeClient(world);
  const originalRef = client.workspaces.ref;
  let loseResponse = true;
  client.workspaces.ref = (id) => {
    const handle = originalRef(id);
    const create = handle.agents.create;
    handle.agents.create = async (request) => {
      const created = await create(request);
      if (loseResponse) { loseResponse = false; throw new Error('response lost'); }
      return created;
    };
    return handle;
  };
  const build = (account) => buildSteerCreate({
    keyScope: REPO, repo: REPO, scopeId: REPO, slot: 'C', workspaceId: ws.id,
    profile: CONFIG.profiles.standard, keyParts: ['steer', 'C', 'g1'], metadata: { 'zerosub.account': account },
  });
  const first = build('old');
  const second = build('new');
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  let account = 'old';
  const execute = createExecutors({
    client, lookupReceipt: fakeLookup(world),
    getZerosub: async () => ({ accounts: [{ id: account, family: 'codex', exhausted: false, windows: [], maxUsedPct: 10 }] }),
  });
  const op = (plan) => ({ kind: 'paseo.agent.create', params: { ...plan.request, idempotencyKey: plan.idempotencyKey } });
  const legacy = op(first).params;
  const reservationKey = `${METADATA_KEY}.creation-pin.${createHash('sha256').update(legacy.idempotencyKey).digest('hex')}`;
  ws.metadata[reservationKey] = { key: legacy.idempotencyKey, metadata: legacy.metadata };
  const { workspaceId, config, title, labels, idempotencyKey, metadata } = legacy;
  await assert.rejects(client.workspaces.ref(workspaceId).agents.create({ config, title, labels, idempotencyKey, metadata }), /response lost/);
  account = 'new';
  const retried = await execute(op(second));
  assert.equal(retried.accountId, 'old');
  assert.equal(world.agents.length, 3);
  assert.equal(world.agents.at(-1).id, retried.agentId);
});

test('active Fresh settles a completed creation receipt on the next apply after restart', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const client = fakeClient(world);
  const originalRef = client.workspaces.ref;
  client.workspaces.ref = (id) => {
    const workspace = originalRef(id);
    return { ...workspace, setMetadata: async (patch) => {
      if (patch[METADATA_KEY]?.activeAgentId) throw new Error('authority write interrupted');
      return workspace.setMetadata(patch);
    } };
  };
  const options = { config: CONFIG, apply: true, notifyPrevious: false, lock: testLock, language: 'en' };
  await assert.rejects(freshSteer({ ...options, client, discovery: discoveryOf(world), lookupReceipt: fakeLookup(world) }), /authority write interrupted/);
  const creation = ws.metadata[AGENTS_KEY][steers.A.id].freshCreation;
  const key = creation.op.params.idempotencyKey;
  const created = world.receipts.get(key);
  assert.equal(world.agents.length, 3);
  assert.equal(ws.metadata[METADATA_KEY].epoch, 1);

  const restarted = structuredClone(world);
  const { freshSteer: reloadedFresh } = await import('../plugin/server/core/steer.mjs?fresh-create-restart');
  const resume = () => reloadedFresh({ ...options, client: fakeClient(restarted), discovery: discoveryOf(restarted),
    lookupReceipt: fakeLookup(restarted), paseoCli: fakePaseoCli(restarted) });
  const recovered = await resume();
  assert.equal(recovered.to, created);
  assert.equal(recovered.reused, true);
  assert.equal(recovered.delivered, true);
  assert.equal(restarted.workspaces[0].metadata[METADATA_KEY].epoch, 2);
  assert.equal(restarted.agents.length, 3);
  assert.ok(restarted.calls.filter(([kind]) => kind === 'agent.create').every(([, request]) => request.idempotencyKey === key));
  assert.equal(restarted.calls.filter(([kind]) => kind === 'agent.send').length, 1);
});

test('a failed receipt confirmation reuses the same unpinned agent on a later retry', async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const client = fakeClient(world);
  const originalRef = client.workspaces.ref;
  let failConfirmation = false;
  client.workspaces.ref = (id) => {
    const handle = originalRef(id);
    const create = handle.agents.create;
    handle.agents.create = async (request) => {
      const created = await create(request);
      if (failConfirmation) { failConfirmation = false; throw new Error('confirmation response lost'); }
      return created;
    };
    return handle;
  };
  let account = 'old';
  const execute = createExecutors({
    client, lookupReceipt: fakeLookup(world),
    getZerosub: async () => ({ accounts: [{ id: account, family: 'codex', exhausted: false, windows: [], maxUsedPct: 10 }] }),
  });
  const plan = buildSteerCreate({ keyScope: REPO, repo: REPO, scopeId: REPO, slot: 'C', workspaceId: ws.id,
    profile: CONFIG.profiles.standard, keyParts: ['steer', 'C', 'g1'] });
  const op = { kind: 'paseo.agent.create', params: { ...plan.request, idempotencyKey: plan.idempotencyKey } };
  const created = await execute(op);
  failConfirmation = true;
  await assert.rejects(execute(op), /confirmation response lost/);
  account = 'new';
  const retried = await execute(op);
  assert.equal(retried.agentId, created.agentId);
  assert.equal(retried.accountId, null);
  assert.equal(world.agents.length, 3);
});

test('apply permits account changes since preview but still executes the authorized operation', async () => {
  const op = { key: 'steer.A', kind: 'paseo.agent.create', params: {
    workspaceId: 'ws', idempotencyKey: 'key', labels: { [LABEL.slot]: 'A' },
    metadata: { 'zerosub.account': 'preview' },
  } };
  const plan = { repo: REPO, status: 'pending', ops: [op], conflicts: [] };
  const auth = createAuthorization([plan], CONFIG, { entries: [REPO] });
  let created = false;
  const result = await applyPlans({
    authorization: auth, config: CONFIG, confirm: auth.hash,
    runPlans: async () => [{
      ...plan, ops: created ? [] : [{ ...op, params: { ...op.params, metadata: { 'zerosub.account': 'latest' } } }],
    }],
    execute: async (observed) => {
      assert.equal(observed.params.metadata['zerosub.account'], 'preview');
      created = true;
      return { agentId: 'agent' };
    },
  });
  assert.equal(result.report[0].status, 'complete', result.report[0].error);
});

test('plan conflicts on several live holders', () => {
  const live = planRepository(planDiscovery([
    labelledSteer('a', 'A', 'codex', 'gpt-6.2-sol'),
    labelledSteer('b-old', 'B', 'muse', 'muse-spark-1.3-contributor'),
    labelledSteer('b-new', 'B', 'muse', 'muse-spark-1.3-contributor'),
  ]), CONFIG, {});
  assert.match(live.conflicts.find((c) => c.key === 'steer.B').reason, /Several live agents are titled Steer B/);
});

test('plan adopts a mismatched steer silently (K13: no drift suggestion)', () => {
  const candidate = {
    id: 'cand-b', workspaceId: 'wks_main', archivedAt: null, title: 'Steer B', provider: 'codex', model: 'gpt-6.2-sol', status: 'idle',
    labels: {},
  };
  const plan = planRepository(planDiscovery([labelledSteer('a', 'A', 'codex', 'gpt-6.2-sol')], { legacy: [candidate] }), CONFIG, { adopt: { B: 'cand-b' } });
  assert.equal(plan.ops.find((o) => o.key === 'steer.B').kind, 'paseo.agent.adopt');
  assert.ok(!plan.notes.join('\n').includes('Adopted Steer B runs'), 'K13 keeps the live model without a drift note');
});

test('Fresh preserves observed provider, model, thinking, mode and options for every role', async () => {
  for (const kind of ['active', 'standby', 'worker']) {
    const world = makeWorld();
    const { ws, steers, worker } = provisionedWithWorker(world);
    const source = kind === 'active' ? steers.A : kind === 'standby' ? steers.B : worker;
    Object.assign(source, {
      provider: 'codex', model: 'native-model', currentModeId: 'review',
      thinkingOptionId: 'low', effectiveThinkingOptionId: 'high',
      features: [{ id: 'legacyOption', value: false }],
      options: { service_tier: 'fast' },
    });
    world.providers[0].models.push({ id: 'native-model', thinkingOptions: [{ id: 'high' }] });
    world.providers[0].modes.push({ id: 'review' });
    const target = kind === 'standby' ? { slot: 'B' } : kind === 'worker' ? { workerId: worker.id } : {};
    const settingsBefore = structuredClone(CONFIG);
    const result = await freshSteer({ ...target, client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG,
      apply: true, send: false, notifyPrevious: false, lock: testLock, lookupReceipt: fakeLookup(world), paseoCli: fakePaseoCli(world) });
    const [, request] = world.calls.find(([name]) => name === 'agent.create');
    assert.deepEqual(request.config, {
      provider: 'codex/native-model', modeId: 'review', thinkingOptionId: 'high',
      options: { legacyOption: false, service_tier: 'fast' },
    });
    assert.equal(request.metadata?.['zerosub.account'], undefined);
    assert.equal(result.routeEvidence[0].source, 'live');
    assert.equal(result.profile, null);
    assert.equal(ws.metadata[METADATA_KEY].epoch, kind === 'active' ? 2 : 1);
    assert.equal(request.parent, kind === 'worker' ? steers.A.id : undefined);
    assert.deepEqual(CONFIG, settingsBefore);
  }
});

test('Fresh uses the preference of the live role when its route is unsupported', async () => {
  const world = makeWorld();
  const { steers, worker } = provisionedWithWorker(world);
  const config = structuredClone(CONFIG);
  const provider = world.providers[0];
  provider.models.push(...['coordinator-alt', 'advisor-alt', 'worker-alt'].map((id) => ({ id })));
  for (const role of ['coordinator', 'advisor', 'worker']) {
    config.profiles[role] = { provider: 'codex', model: `${role}-alt`, advisor: role === 'advisor' };
  }
  config.steers.priority = ['coordinator'];
  config.advisors = { priority: ['advisor'] };
  config.workers.priority = ['worker'];
  steers.B.metadata = { [LABEL.steerRole]: 'advisor' };
  for (const source of [steers.A, steers.B, worker]) source.model = 'no-longer-offered';
  const preview = (target) => freshSteer({ ...target, client: fakeClient(world), discovery: discoveryOf(world), config, lock: testLock });
  assert.equal((await preview({})).model, 'coordinator-alt');
  assert.equal((await preview({ slot: 'B' })).model, 'advisor-alt');
  assert.equal((await preview({ workerId: worker.id })).model, 'worker-alt');
  await assert.rejects(preview({ slot: 'B', provider: 'codex', model: 'coordinator-alt' }), /not tagged as advisor.*eligible alternatives: codex\/advisor-alt/);
  await assert.rejects(preview({ workerId: worker.id, provider: 'codex', model: 'advisor-alt' }), /tagged as advisor.*eligible alternatives: codex\/worker-alt/);
  assert.deepEqual(world.calls, []);
});

test('Fresh reconciles the original standby and worker requests after lost replies and settings changes', async () => {
  for (const kind of ['standby', 'worker']) {
    const world = makeWorld();
    const { ws, steers, worker } = provisionedWithWorker(world);
    const source = kind === 'standby' ? steers.B : worker;
    source.options = { fast_mode: true };
    const target = kind === 'standby' ? { slot: 'B' } : { workerId: worker.id };
    const client = fakeClient(world);
    const lookupReceipt = fakeLookup(world);
    const run = createExecutors({ client, lookupReceipt });
    let config = CONFIG;
    const fresh = (extra) => freshSteer({ ...target, client, discovery: discoveryOf(world), config,
      send: false, notifyPrevious: false, lock: testLock, lookupReceipt, paseoCli: fakePaseoCli(world), ...extra });

    await assert.rejects(fresh({ apply: true, execute: async (...args) => {
      await run(...args);
      throw new Error('lost create response');
    } }), /lost create response/);
    const first = world.calls.find(([name]) => name === 'agent.create')[1];
    const originalId = world.receipts.get(first.idempotencyKey);
    config = { ...CONFIG, profiles: {}, steers: { slots: {}, priority: [] }, workers: { priority: [] } };
    const created = world.agents.find((agent) => agent.id === originalId);
    created.metadata = { ...created.metadata, 'zerosub.account': 'bound-after-create' };
    world.providers = [];
    source.options.fast_mode = false;
    const preview = await fresh({});
    assert.equal(preview.idempotencyKey, first.idempotencyKey);
    assert.equal(preview.from, source.id);
    const result = await fresh({ apply: true });
    assert.equal(result.to, originalId);
    assert.equal(result.reused, true);
    assert.deepEqual(world.calls.filter(([name]) => name === 'agent.create').map(([, request]) => request), [first, first]);
    assert.equal(ws.metadata[METADATA_KEY].epoch, 1);
  }
});

test('Fresh uses account quota as selection evidence without pinning a new agent', async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const config = structuredClone(CONFIG);
  config.steers.priority = ['cheap'];
  const zerosub = {
    accounts: [
      { id: 'codex-limited', family: 'codex', exhausted: true },
      { id: 'muse-available', family: 'muse', maxUsedPct: 20 },
    ],
    agentAccount: { [world.agents[0].id]: 'codex-limited' },
  };
  const fresh = (extra) => freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config, zerosub,
    send: false, notifyPrevious: false, lock: testLock, lookupReceipt: fakeLookup(world),
    paseoCli: fakePaseoCli(world), ...extra });
  await assert.rejects(fresh({ provider: 'codex', model: 'gpt-6.2-sol' }), /accounts exhausted.*eligible alternatives: muse/);
  const result = await fresh({ apply: true });
  assert.equal(result.profile, 'cheap');
  assert.equal(result.routeEvidence.find((candidate) => candidate.profile === 'cheap').account, 'muse-available');
  const request = world.calls.find(([name]) => name === 'agent.create')[1];
  assert.equal(request.metadata['zerosub.account'], undefined);
  assert.equal(ws.metadata[METADATA_KEY].epoch, 2);
});
