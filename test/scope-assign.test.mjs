// Hub→scope assignment (S6): preview, epoch-checked checkpoint write and
// delivery to the active scope steer. Fakes only; no daemon, no GitHub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { assignScope, buildAssignment, AssignRefused, ASSIGNMENT_KEY } from '../plugin/server/core/assign.mjs';
import { LABEL, METADATA_KEY, PARENT_LABEL } from '../plugin/server/core/paseo.mjs';
import { CHECKPOINT_KEY, parseCheckpointBlock } from '../plugin/server/core/steer.mjs';

const REPO = 'example-owner/example-repo';

function makeWorld() {
  return { workspaces: [], agents: [], calls: [], seq: 0, hooks: {} };
}
function addWorkspace(world, { metadata, title = 'Main' }) {
  const ws = { id: `wks_${String(++world.seq).padStart(4, '0')}`, projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout', title, name: title, metadata: structuredClone(metadata), createdAt: new Date().toISOString() };
  world.workspaces.push(ws);
  return ws;
}
function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}
function provisioned(world, state = { main: true, activeSteer: 'A', epoch: 3 }) {
  const ws = addWorkspace(world, { metadata: { [METADATA_KEY]: { ...state } } });
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
    workers: [],
    providers: [],
  };
}
function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const agentHandle = (id) => ({
    refresh: async () => ({ agent: structuredClone(world.agents.find((agent) => agent.id === id) ?? null) }),
    send: async (text) => {
      if (world.hooks.sendFails) throw new Error('agent unreachable');
      world.calls.push(['agent.send', id, text]);
    },
  });
  return {
    workspaces: {
      ref: (id) => ({
        refresh: async () => structuredClone(findWs(id)),
        setMetadata: async (patch) => {
          world.calls.push(['workspace.setMetadata', id, patch]);
          Object.assign(findWs(id).metadata, structuredClone(patch));
        },
      }),
    },
    agents: { ref: agentHandle, list: async () => ({ entries: structuredClone(world.agents), pageInfo: { hasMore: false } }) },
  };
}
const noLock = (_name, fn) => fn({ verify() {} });
const assign = (world, discovery, extra = {}) => assignScope({
  client: fakeClient(world), discovery, task: 'Ship it', tests: ['npm test'], blockers: [], next: 'confirm takeover',
  lock: noLock, now: () => new Date('2026-11-23T12:00:00.000Z'), promptOptions: { factoryRoot: '/srv/factory' }, ...extra,
});

test('preview writes nothing and shows scope, steer, fields and packet', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const result = await assign(world, discoveryOf(world));
  assert.equal(result.applied, false);
  assert.equal(result.delivered, false);
  assert.deepEqual([result.scope, result.epoch, result.slot, result.steerId], [REPO, 3, 'A', steers.A.id]);
  assert.deepEqual(result.fields, { task: 'Ship it', tests: ['npm test'], blockers: [], next: 'confirm takeover' });
  assert.equal(result.previous, null);
  assert.match(result.packet, new RegExp(`Assignment for ${REPO.replace('/', '\\/')} \\(epoch 3\\)`));
  assert.match(result.packet, new RegExp(`Active steer A \\(${steers.A.id}\\)`));
  assert.match(result.packet, /- Task: Ship it/);
  assert.match(result.packet, /- Tests: npm test/);
  assert.match(result.packet, /- Open blockers: none recorded/);
  assert.match(result.packet, /- Next step: confirm takeover/);
  assert.match(result.packet, /FINDINGS\.md/);
  assert.equal(result.packetChars, result.packet.length);
  assert.deepEqual(world.calls, [], 'preview reads only');
  const withoutFindings = await assign(world, discoveryOf(world), { promptOptions: { findingsInPrompts: false } });
  assert.doesNotMatch(withoutFindings.packet, /FINDINGS\.md/);
});

test('preview names the replaced previous task', async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  ws.metadata[CHECKPOINT_KEY] = { task: 'Old work', tests: [], blockers: [], epoch: 2, updatedAt: '2026-11-23T00:00:00.000Z' };
  const result = await assign(world, discoveryOf(world));
  assert.equal(result.previous, 'Old work');
});

test('apply writes an epoch-stamped checkpoint and delivers the packet', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const result = await assign(world, discoveryOf(world), { apply: true });
  assert.equal(result.applied, true);
  assert.equal(result.delivered, true);
  assert.equal(result.deliveryError, null);
  assert.deepEqual(result.checkpoint, { task: 'Ship it', tests: ['npm test'], blockers: [], next: 'confirm takeover', epoch: 3, updatedAt: '2026-11-23T12:00:00.000Z', source: 'assign', assignedBy: null, capturedAt: '2026-11-23T12:00:00.000Z', interrupted: null });
  assert.deepEqual(world.workspaces[0].metadata[CHECKPOINT_KEY], result.checkpoint);
  const sends = world.calls.filter((c) => c[0] === 'agent.send');
  assert.deepEqual(sends.map((c) => c[1]), [steers.A.id]);
  assert.equal(sends[0][2], result.packet);
});

test('assigned checkpoints record source and assigner', async () => {
  const world = makeWorld();
  provisioned(world);
  const result = await assign(world, discoveryOf(world), { apply: true, assignedBy: 'hub-agent-1' });
  assert.equal(result.checkpoint.source, 'assign');
  assert.equal(result.checkpoint.assignedBy, 'hub-agent-1');
});

test('apply records the report target and the packet names it before the real block', async () => {
  const world = makeWorld();
  provisioned(world);
  const result = await assign(world, discoveryOf(world), { apply: true, assignedBy: 'hub-agent-1' });
  const record = world.workspaces[0].metadata[ASSIGNMENT_KEY];
  assert.equal(record.by, 'hub-agent-1');
  assert.equal(record.reportedAt, null);
  assert.equal(record.epoch, result.epoch);
  assert.match(result.packet, /the factory sends this block to the requester hub-agent-1 automatically/);
  assert.match(result.packet, /^status: done \| partial \| blocked$/m);
  // The rules' format example comes first: the last block is the real assignment.
  assert.equal(parseCheckpointBlock(result.packet).task, result.fields.task);
});

test('explicit reportTo wins; no requester clears the record', async () => {
  const world = makeWorld();
  provisioned(world);
  await assign(world, discoveryOf(world), { apply: true, assignedBy: 'hub-agent-1', reportTo: 'steer-e' });
  assert.equal(world.workspaces[0].metadata[ASSIGNMENT_KEY].by, 'steer-e');
  const again = makeWorld();
  provisioned(again);
  const result = await assign(again, discoveryOf(again), { apply: true });
  assert.equal(again.workspaces[0].metadata[ASSIGNMENT_KEY], null);
  assert.doesNotMatch(result.packet, /sends this block to the requester/);
});

test('epoch or steer drift between discovery and apply refuses without writes', async () => {
  const world = makeWorld();
  provisioned(world);
  const stale = discoveryOf(world);
  world.workspaces[0].metadata[METADATA_KEY].epoch = 4; // someone switched meanwhile
  await assert.rejects(assign(world, stale, { apply: true }), /Scope state changed.*A@3.*A@4/);
  world.workspaces[0].metadata[METADATA_KEY].epoch = 3;
  world.workspaces[0].metadata[METADATA_KEY].activeSteer = 'B';
  await assert.rejects(assign(world, stale, { apply: true }), /Scope state changed/);
  assert.ok(world.calls.every((c) => c[0] !== 'workspace.setMetadata' && c[0] !== 'agent.send'), 'no write, no delivery on drift');
});

test('assignment rejects a requester with a stale epoch', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const requester = { workspaceId: ws.id, scopeId: REPO, epoch: 1, agentId: steers.A.id };
  await assert.rejects(assign(world, discoveryOf(world), { apply: true, requester }), /Scope state changed/);
  assert.equal(ws.metadata[CHECKPOINT_KEY], undefined);
});

test('--expect-epoch binds apply to the previewed epoch', async () => {
  const world = makeWorld();
  provisioned(world);
  await assert.rejects(assign(world, discoveryOf(world), { apply: true, expectEpoch: 2 }), /epoch is 3, expected 2/);
  assert.deepEqual(world.calls, [], 'refused before the lock');
  const result = await assign(world, discoveryOf(world), { apply: true, expectEpoch: 3 });
  assert.equal(result.applied, true);
});

test('missing state, steer, ambiguity, parent and foreign workspace refuse', async () => {
  const empty = makeWorld();
  await assert.rejects(assign(empty, discoveryOf(empty), { apply: true }), /No factory main workspace/);
  const nosteer = makeWorld();
  addWorkspace(nosteer, { metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } } });
  await assert.rejects(assign(nosteer, discoveryOf(nosteer)), /No live Steer A/);
  const ambiguous = makeWorld();
  const { ws } = provisioned(ambiguous);
  addAgent(ambiguous, { provider: 'codex', model: 'm', title: 'Steer A again', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'A' } });
  await assert.rejects(assign(ambiguous, discoveryOf(ambiguous)), /several live agents/);
  const parented = makeWorld();
  const held = provisioned(parented);
  held.steers.A.labels[PARENT_LABEL] = 'coordinator';
  await assert.rejects(assign(parented, discoveryOf(parented)), /has parent/);
  const foreign = makeWorld();
  const out = provisioned(foreign);
  out.steers.A.workspaceId = 'wks_elsewhere';
  await assert.rejects(assign(foreign, discoveryOf(foreign)), /not in the main workspace/);
});


test('blank task refuses; no-send writes without delivery; failed delivery keeps the write', async () => {
  const world = makeWorld();
  provisioned(world);
  await assert.rejects(assign(world, discoveryOf(world), { task: '  ' }), /needs a task/);
  const silent = await assign(world, discoveryOf(world), { apply: true, send: false });
  assert.equal(silent.applied, true);
  assert.equal(silent.delivered, false);
  assert.ok(world.calls.every((c) => c[0] !== 'agent.send'));
  world.hooks.sendFails = true;
  const result = await assign(world, discoveryOf(world), { apply: true });
  assert.equal(result.applied, true);
  assert.equal(result.delivered, false);
  assert.match(result.deliveryError, /unreachable/);
  assert.equal(world.workspaces[0].metadata[CHECKPOINT_KEY].task, 'Ship it');
});

test('a running steer still receives the assignment', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  steers.A.status = 'running';
  const result = await assign(world, discoveryOf(world), { apply: true });
  assert.equal(result.applied, true);
  assert.equal(result.delivered, true);
});

test('buildAssignment is deterministic and complete', () => {
  const status = { repo: REPO };
  const fields = { slot: 'B', steerId: 'steer-b', epoch: 1, task: 't', tests: [], blockers: ['b'], next: null };
  assert.equal(buildAssignment(status, fields), buildAssignment(status, fields));
  assert.match(buildAssignment(status, fields), /- Next step: not recorded/);
});

test('CLI usage documents assign', () => {
  const out = execFileSync('node', ['plugin/cli.mjs', '--help'], { encoding: 'utf8' });
  assert.match(out, /assign <scope> --task <text>/);
});
