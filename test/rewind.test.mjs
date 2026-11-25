// Same-tab refresh via Paseo rewind: rewind module units plus freshSteer
// integration (steers/workers, preview rewind-vs-new-agent, fallback, failure
// side effects, double-click idempotency). Fake DaemonClient and fake state
// only; no daemon.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstRewindPoint, isRewindUnsupportedError, readRewindPoint, rewindAndBrief, rewindSameTab } from '../src/rewind.mjs';
import { buildRewindRecord, buildRefreshPacket, freshRewindIdempotent, freshSteer, steerStatus } from '../src/steer.mjs';
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

const LOCK_TMP = mkdtempSync(join(tmpdir(), 'wsf-rewind-'));
const testLock = (name, fn) => withLock(name, fn, { dir: LOCK_TMP });

/** Fake DaemonClient factory: timeline payload plus per-method behaviors ('ok' or an Error to throw). */
function fakeDaemon({ timeline = { entries: [] }, fetchFails = null, rewindFails = null, sendFails = null, calls = [] } = {}) {
  const factory = async ({ url, cliPath }) => {
    calls.push(['connect', url, cliPath]);
    return {
      fetchAgentTimeline: async (id, opts) => {
        calls.push(['fetchAgentTimeline', id, opts]);
        if (fetchFails) throw fetchFails;
        return structuredClone(timeline);
      },
      rewindAgent: async (id, messageId, mode) => {
        calls.push(['rewindAgent', id, messageId, mode]);
        if (rewindFails) throw rewindFails;
        return { ok: true };
      },
      sendMessage: async (id, text, opts) => {
        calls.push(['sendMessage', id, text, opts]);
        if (sendFails) throw sendFails;
        return {};
      },
      close: async () => { calls.push(['close']); },
    };
  };
  factory.calls = calls;
  return factory;
}

const userTimeline = (firstId = 'msg-first') => ({
  entries: [
    { item: { type: 'assistant_message', text: 'welcome' } },
    { item: { type: 'tool_call', kind: 'paseo-agent-message', messageId: 'tool-1' } },
    { item: { type: 'user_message', messageId: firstId, text: 'do the thing' } },
    { item: { type: 'user_message', messageId: 'msg-second', text: 'more' } },
  ],
});

// ------------------------------------------------------- firstRewindPoint

test('firstRewindPoint takes the first user_message id and skips tool calls', () => {
  assert.equal(firstRewindPoint(userTimeline('msg-a')), 'msg-a');
  assert.equal(firstRewindPoint({ rows: [{ type: 'user_message', messageId: 'r1' }] }), 'r1');
  assert.equal(firstRewindPoint({ items: [{ item: { type: 'user_message', messageId: 'i1' } }] }), 'i1');
  assert.equal(firstRewindPoint({ entries: [{ item: { type: 'tool_call', messageId: 'tool-1' } }] }), null);
  assert.equal(firstRewindPoint({ entries: [{ item: { type: 'assistant_message', text: 'x' } }] }), null);
  assert.equal(firstRewindPoint({ entries: [{ item: { type: 'user_message', text: 'no id' } }] }), null);
  assert.equal(firstRewindPoint({ entries: [] }), null);
  assert.equal(firstRewindPoint(null), null);
  assert.equal(firstRewindPoint({ entries: 'nope' }), null);
});

test('isRewindUnsupportedError matches provider-capability failures only', () => {
  assert.equal(isRewindUnsupportedError(new Error('rewind not supported for this provider')), true);
  assert.equal(isRewindUnsupportedError(new Error('Unsupported method')), true);
  assert.equal(isRewindUnsupportedError(new Error('socket closed')), false);
  assert.equal(isRewindUnsupportedError(new Error('could not find user message')), false);
  assert.equal(isRewindUnsupportedError(null), false);
});

// ------------------------------------------------------------- rewind core

test('readRewindPoint returns the id and fails soft to null', async () => {
  const daemon = fakeDaemon({ timeline: userTimeline('msg-x') });
  assert.equal(await readRewindPoint('agent-1', { createClient: daemon }), 'msg-x');
  assert.deepEqual(daemon.calls[1], ['fetchAgentTimeline', 'agent-1', { limit: 0, projection: 'canonical' }]);
  assert.deepEqual(daemon.calls.at(-1), ['close']);

  assert.equal(await readRewindPoint('agent-1', { createClient: fakeDaemon({ timeline: { entries: [] } }) }), null);
  assert.equal(await readRewindPoint('agent-1', { createClient: fakeDaemon({ fetchFails: new Error('gone') }) }), null);
  assert.equal(await readRewindPoint('agent-1', { createClient: async () => { throw new Error('refused'); } }), null);
  assert.equal(await readRewindPoint('', { createClient: fakeDaemon() }), null);
});

test('rewindSameTab rewinds to the first user message and closes', async () => {
  const daemon = fakeDaemon({ timeline: userTimeline('msg-a') });
  const out = await rewindSameTab('agent-9', { createClient: daemon });
  assert.deepEqual(out, { status: 'rewound', messageId: 'msg-a' });
  assert.deepEqual(daemon.calls.filter((c) => c[0] === 'rewindAgent'), [['rewindAgent', 'agent-9', 'msg-a', 'conversation']]);
  assert.deepEqual(daemon.calls.at(-1), ['close']);
});

test('rewindSameTab distinguishes no-point, unsupported, unavailable and failed', async () => {
  const noPoint = await rewindSameTab('a', { createClient: fakeDaemon({ timeline: { entries: [{ item: { type: 'tool_call', messageId: 't' } }] } }) });
  assert.deepEqual(noPoint, { status: 'no-point' });

  const unsupported = await rewindSameTab('a', { createClient: fakeDaemon({ timeline: userTimeline(), rewindFails: new Error('method not supported') }) });
  assert.equal(unsupported.status, 'unsupported');

  const noMethod = await rewindSameTab('a', {
    createClient: async () => ({ fetchAgentTimeline: async () => userTimeline(), close: async () => {} }),
  });
  assert.equal(noMethod.status, 'unsupported');

  const unavailable = await rewindSameTab('a', { createClient: async () => { throw new Error('refused'); } });
  assert.equal(unavailable.status, 'unavailable');

  const failed = await rewindSameTab('a', { createClient: fakeDaemon({ timeline: userTimeline(), rewindFails: new Error('could not find user message') }) });
  assert.deepEqual(failed, { status: 'failed', error: 'could not find user message' });
});

test('rewindAndBrief delivers the brief as user_message without a caller id', async () => {
  const daemon = fakeDaemon({ timeline: userTimeline('msg-a') });
  const out = await rewindAndBrief('agent-9', 'Resume brief body', { createClient: daemon });
  assert.equal(out.status, 'rewound');
  assert.equal(out.messageId, 'msg-a');
  assert.ok(typeof out.briefMessageId === 'string' && out.briefMessageId);
  const sends = daemon.calls.filter((c) => c[0] === 'sendMessage');
  assert.equal(sends.length, 1);
  assert.equal(sends[0][1], 'agent-9');
  assert.equal(sends[0][2], 'Resume brief body');
  assert.deepEqual(sends[0][3], { messageId: out.briefMessageId });
  assert.ok(!('sourceAgentId' in sends[0][3]), 'no caller id: the brief must arrive as user_message');
  assert.deepEqual(daemon.calls.at(-1), ['close']);
});

test('rewindAndBrief honors an explicit brief id and reports a failed send without losing the rewind', async () => {
  const daemon = fakeDaemon({ timeline: userTimeline() });
  const out = await rewindAndBrief('a', 'brief', { createClient: daemon, messageId: 'brief-1' });
  assert.equal(out.briefMessageId, 'brief-1');

  const failing = fakeDaemon({ timeline: userTimeline(), sendFails: new Error('agent is closed') });
  const failed = await rewindAndBrief('a', 'brief', { createClient: failing });
  assert.equal(failed.status, 'rewound');
  assert.equal(failed.briefMessageId, null);
  assert.equal(failed.sendError, 'agent is closed');
});

test('rewindAndBrief never sends without a landed rewind', async () => {
  for (const factory of [
    fakeDaemon({ timeline: { entries: [] } }),
    fakeDaemon({ timeline: userTimeline(), rewindFails: new Error('boom') }),
    fakeDaemon({ fetchFails: new Error('gone') }),
  ]) {
    const out = await rewindAndBrief('a', 'brief', { createClient: factory });
    assert.notEqual(out.status, 'rewound');
    assert.ok(factory.calls.every((c) => c[0] !== 'sendMessage'), 'no send without a rewind');
  }
  assert.deepEqual((await rewindAndBrief('', 'brief', { createClient: fakeDaemon() })).status, 'failed');
  assert.deepEqual((await rewindAndBrief('a', '  ', { createClient: fakeDaemon() })).status, 'failed');
});

// --------------------------------------------- record + idempotency helpers

test('buildRewindRecord marks cleared/refreshed with mode rewind and wipes the debt', () => {
  const patch = buildRewindRecord({
    checkpoint: { capturedAt: '2026-11-24T10:00:00.000Z' },
    messageId: 'msg-a', briefMessageId: 'brief-1', now: () => new Date('2026-11-24T12:00:00.000Z'),
  });
  assert.deepEqual(patch.cleared, { at: '2026-11-24T12:00:00.000Z', mode: 'rewind', checkpointAt: '2026-11-24T10:00:00.000Z' });
  assert.deepEqual(patch.refreshed, { at: '2026-11-24T12:00:00.000Z', mode: 'rewind', messageId: 'msg-a', briefMessageId: 'brief-1' });
  assert.equal(patch.freshHint, null);
  assert.equal(patch.compactions, 0);
  assert.equal(patch.lastActionFailed, null);
  const bare = buildRewindRecord({});
  assert.deepEqual(bare.refreshed, { at: bare.refreshed.at, mode: 'rewind' });
});

test('freshRewindIdempotent guards pending actions and rewound tabs', () => {
  assert.equal(freshRewindIdempotent(null), null);
  assert.equal(freshRewindIdempotent({}), null);
  assert.match(freshRewindIdempotent({ pendingAction: { kind: 'clear' } }), /already pending/);
  assert.match(
    freshRewindIdempotent({ cleared: { at: '2026-11-24T12:00:00.000Z', mode: 'rewind' }, lastTurnEndedAt: '2026-11-24T11:00:00.000Z' }),
    /already rewound after the last turn/,
  );
  assert.match(
    freshRewindIdempotent({ cleared: { at: '2026-11-24T12:00:00.000Z', mode: 'rewind' } }),
    /no new turn recorded/,
  );
  assert.equal(
    freshRewindIdempotent({ cleared: { at: '2026-11-24T10:00:00.000Z', mode: 'rewind' }, lastTurnEndedAt: '2026-11-24T11:00:00.000Z' }),
    null, 'a turn after the rewind re-arms the refresh',
  );
  assert.equal(freshRewindIdempotent({ cleared: { at: '2026-11-24T12:00:00.000Z', mode: 'clear' } }), null);
});

test('buildRefreshPacket heads the same tab when rewound', async () => {
  const world = makeWorld();
  provisioned(world);
  const status = steerStatus(discoveryOf(world));
  const from = status.steers.find((s) => s.slot === 'B');
  const packet = buildRefreshPacket(status, {
    kind: 'steer', slot: 'B', from, to: { id: from.id }, epoch: 1, git: null, rewound: true, language: 'en',
  });
  assert.match(packet, new RegExp(`Steer B keeps agent ${from.id} in the same tab \\(rewound context`));
  const workerPacket = buildRefreshPacket(status, {
    kind: 'worker', owner: 'A', title: 'Build', from, to: { id: from.id }, epoch: 1, git: null, rewound: true, language: 'en',
  });
  assert.match(workerPacket, new RegExp(`"Build" ${from.id} keeps its tab \\(rewound context`));
});

// ------------------------------------------------------- fresh preview mode

test('fresh --slot preview shows rewind vs new agent', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const rewind = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', git: fakeGit(), lock: testLock, language: 'en', rewindClient: fakeDaemon({ timeline: userTimeline() }) });
  assert.equal(rewind.refreshMode, 'rewind');
  assert.equal(rewind.from, steers.B.id);
  assert.equal(rewind.to, steers.B.id);
  assert.equal(rewind.applied, false);
  assert.equal(rewind.epochBumped, false);
  assert.equal(rewind.idempotencyKey, null);
  assert.match(rewind.packet, /keeps agent .* in the same tab \(rewound context/);
  assert.deepEqual(world.calls, [], 'preview reads only');

  const world2 = makeWorld();
  provisioned(world2);
  const fallback = await freshSteer({ client: fakeClient(world2), discovery: discoveryOf(world2), config: CONFIG, slot: 'B', git: fakeGit(), lock: testLock, language: 'en', rewindClient: fakeDaemon({ timeline: { entries: [] } }) });
  assert.equal(fallback.refreshMode, 'new-agent');
  assert.equal(fallback.to, null);
  assert.match(fallback.packet, /gets a new agent/);
  assert.ok(fallback.warnings.some((w) => /falling back to a new agent/.test(w)));

  const world3 = makeWorld();
  provisioned(world3);
  const legacy = await freshSteer({ client: fakeClient(world3), discovery: discoveryOf(world3), config: CONFIG, slot: 'B', git: fakeGit(), lock: testLock, language: 'en' });
  assert.equal(legacy.refreshMode, 'new-agent');
});

test('fresh preview and apply use the recorded resume brief when it is still a user message', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  ws.metadata[AGENTS_KEY] = { [steers.B.id]: { refreshed: { briefMessageId: 'brief-previous' } } };
  const timeline = userTimeline('original');
  timeline.entries.push({ item: { type: 'user_message', messageId: 'brief-previous' } });
  const daemon = fakeDaemon({ timeline });
  const run = (apply) => freshSteer({
    client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG,
    slot: 'B', language: 'en', lock: testLock, rewindClient: daemon, apply,
  });
  assert.equal((await run(false)).rewindPoint, 'brief-previous');
  assert.equal((await run(true)).rewindPoint, 'brief-previous');
  assert.deepEqual(daemon.calls.find(([method]) => method === 'rewindAgent'),
    ['rewindAgent', steers.B.id, 'brief-previous', 'conversation']);
  const withoutUserBrief = userTimeline('original');
  withoutUserBrief.entries.push({ item: { type: 'tool_call', messageId: 'brief-previous' } });
  assert.equal(await readRewindPoint(steers.B.id, {
    createClient: fakeDaemon({ timeline: withoutUserBrief }), previousBriefId: 'brief-previous',
  }), 'original');
});

// ------------------------------------------------------------- rewind apply

test('fresh --slot apply rewinds the same tab and records cleared/refreshed', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  world.workspaces[0].metadata[AGENTS_KEY] = { [steers.B.id]: { note: 'Rework the queue', noteAt: '2026-11-24T10:00:00.000Z', lastTurnEndedAt: '2026-11-24T11:00:00.000Z' } };
  const daemon = fakeDaemon({ timeline: userTimeline('msg-a') });
  const result = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', rewindClient: daemon });
  assert.equal(result.refreshMode, 'rewind');
  assert.equal(result.applied, true);
  assert.equal(result.from, steers.B.id);
  assert.equal(result.to, steers.B.id);
  assert.equal(result.epochBumped, false);
  assert.equal(result.delivered, true);
  assert.equal(result.rewindPoint, 'msg-a');
  assert.ok(result.briefMessageId);
  assert.match(result.packet, /Rework the queue/);
  assert.match(result.packet, /keeps agent .* in the same tab/);

  assert.equal(world.agents.length, 2, 'no new agent created');
  assert.ok(!world.calls.some((c) => c[0] === 'agent.create'), 'no creation');
  assert.ok(!world.calls.some((c) => c[0] === 'agent.send'), 'the brief goes through the DaemonClient, not the SDK send');
  assert.deepEqual(world.workspaces[0].metadata[METADATA_KEY], { main: true, activeSteer: 'A', epoch: 1 });

  const rewindCall = daemon.calls.find((c) => c[0] === 'rewindAgent');
  assert.deepEqual(rewindCall, ['rewindAgent', steers.B.id, 'msg-a', 'conversation']);
  const sendCall = daemon.calls.find((c) => c[0] === 'sendMessage');
  assert.equal(sendCall[1], steers.B.id);
  assert.deepEqual(sendCall[3], { messageId: result.briefMessageId });
  assert.ok(!('sourceAgentId' in sendCall[3]));

  const entry = world.workspaces[0].metadata[AGENTS_KEY][steers.B.id];
  assert.equal(entry.cleared.mode, 'rewind');
  assert.equal(entry.refreshed.mode, 'rewind');
  assert.equal(entry.refreshed.messageId, 'msg-a');
  assert.equal(entry.refreshed.briefMessageId, result.briefMessageId);
  assert.equal(entry.compactions, 0);
  const kept = world.agents.find((a) => a.id === steers.B.id);
  assert.equal(kept.title, 'Steer B');
  assert.deepEqual(kept.labels[LABEL.slot], 'B');
});

test('fresh --worker apply rewinds the same tab with its owner', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addAgent(world, {
    provider: 'muse', model: 'muse-spark-1.3-contributor', title: 'Build it', workspaceId: ws.id,
    labels: { [PARENT_LABEL]: steers.A.id, [LABEL.scope]: REPO, [LABEL.role]: 'worker', [LABEL.owner]: 'A' },
  });
  const daemon = fakeDaemon({ timeline: userTimeline() });
  const result = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, workerId: worker.id, apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', rewindClient: daemon });
  assert.equal(result.refreshMode, 'rewind');
  assert.equal(result.kind, 'worker');
  assert.equal(result.owner, 'A');
  assert.equal(result.to, worker.id);
  assert.match(result.packet, /keeps its tab \(rewound context/);
  assert.equal(world.agents.length, 3, 'no new worker created');
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY][worker.id].cleared.mode, 'rewind');
});

test('active fresh apply rewinds without an epoch bump or retire notice', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const daemon = fakeDaemon({ timeline: userTimeline() });
  const result = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', rewindClient: daemon });
  assert.equal(result.refreshMode, 'rewind');
  assert.equal(result.applied, true);
  assert.equal(result.from, steers.A.id);
  assert.equal(result.to, steers.A.id);
  assert.equal(result.epoch, 1);
  assert.equal(result.epochBumped, false);
  assert.match(result.packet, /keeps agent .* in the same tab/);
  assert.deepEqual(world.workspaces[0].metadata[METADATA_KEY], { main: true, activeSteer: 'A', epoch: 1 });
  assert.ok(!world.calls.some((c) => c[0] === 'agent.send'), 'no retire notice: the tab survives');
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY][steers.A.id].refreshed.mode, 'rewind');
});

// ------------------------------------------------------ fallback and failure

test('no rewind point falls back to a new parent-free agent', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const daemon = fakeDaemon({ timeline: { entries: [{ item: { type: 'tool_call', kind: 'paseo-agent-message', messageId: 'tool-1' } }] } });
  const result = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', rewindClient: daemon });
  assert.equal(result.refreshMode, 'new-agent');
  assert.equal(result.rewindFallback, 'no-point');
  assert.ok(result.to && result.to !== steers.B.id);
  assert.ok(result.warnings.some((w) => /No rewind point/.test(w)));
  assert.ok(!daemon.calls.some((c) => c[0] === 'sendMessage'), 'nothing sent through the rewind path');
  const created = world.agents.find((a) => a.id === result.to);
  assert.equal(created.labels[PARENT_LABEL], undefined);
  assert.deepEqual(world.calls.filter((c) => c[0] === 'agent.send').map((c) => c[1]), [result.to, steers.B.id]);
});

test('unsupported rewind falls back to a new agent', async () => {
  const world = makeWorld();
  provisioned(world);
  const daemon = fakeDaemon({ timeline: userTimeline(), rewindFails: new Error('rewindAgent not supported') });
  const result = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', rewindClient: daemon });
  assert.equal(result.refreshMode, 'new-agent');
  assert.equal(result.rewindFallback, 'unsupported');
  assert.ok(result.to);
});

test('rewind failure aborts with no side effects', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  world.workspaces[0].metadata[AGENTS_KEY] = { [steers.B.id]: { note: 'keep me', noteAt: '2026-11-24T10:00:00.000Z' } };
  const daemon = fakeDaemon({ timeline: userTimeline(), rewindFails: new Error('could not find user message') });
  await assert.rejects(
    freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', rewindClient: daemon }),
    /Rewind of .* failed \(could not find user message\); nothing sent, nothing recorded, no new agent created/,
  );
  assert.equal(world.agents.length, 2, 'no agent created');
  assert.deepEqual(world.calls, [], 'no send, no metadata write, no creation, no receipt lookup');
  assert.ok(!daemon.calls.some((c) => c[0] === 'sendMessage'), 'no brief sent');
  assert.deepEqual(world.workspaces[0].metadata[AGENTS_KEY][steers.B.id], { note: 'keep me', noteAt: '2026-11-24T10:00:00.000Z' });
  assert.deepEqual(world.workspaces[0].metadata[METADATA_KEY], { main: true, activeSteer: 'A', epoch: 1 });
});

// -------------------------------------------------------------- idempotency

test('double-click apply is idempotent: the second run rewinds nothing', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const daemon = fakeDaemon({ timeline: userTimeline() });
  const run = () => freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', rewindClient: daemon });
  const first = await run();
  assert.equal(first.applied, true);
  assert.equal(first.refreshMode, 'rewind');
  const rewinds = daemon.calls.filter((c) => c[0] === 'rewindAgent').length;
  assert.equal(rewinds, 1);

  const second = await run();
  assert.equal(second.applied, false);
  assert.equal(second.idempotent, true);
  assert.match(second.idempotentReason, /already rewound/);
  assert.equal(second.to, steers.B.id);
  assert.equal(daemon.calls.filter((c) => c[0] === 'rewindAgent').length, 1, 'no second rewind');
  assert.equal(daemon.calls.filter((c) => c[0] === 'sendMessage').length, 1, 'no second brief');
  assert.equal(world.agents.length, 2);
});

test('a pending cleanup action makes the rewind apply idempotent without daemon calls', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  world.workspaces[0].metadata[AGENTS_KEY] = { [steers.B.id]: { pendingAction: { kind: 'clear', at: '2026-11-24T11:00:00.000Z' } } };
  const daemon = fakeDaemon({ timeline: userTimeline() });
  const result = await freshSteer({ client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, slot: 'B', apply: true, git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), language: 'en', rewindClient: daemon });
  assert.equal(result.applied, false);
  assert.equal(result.idempotent, true);
  assert.match(result.idempotentReason, /already pending/);
  assert.deepEqual(daemon.calls, [], 'no daemon contact while an action is pending');
});
