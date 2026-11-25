// Self-takeover: `switch --to <own slot> --apply` called by the target steer itself. Fakes only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { switchSteer, SwitchRefused } from '../src/steer.mjs';
import { LABEL, METADATA_KEY } from '../src/paseo.mjs';

const REPO = 'example-owner/example-repo';

function world({ fromStatus = 'idle', toStatus = 'running', metaAfter = null } = {}) {
  const ws = {
    id: 'wks_0001', projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout', title: 'Main', name: 'Main',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 3 } }, createdAt: '2026-11-23T12:00:00.000Z',
  };
  const agents = [['A', fromStatus], ['B', toStatus]].map(([slot, status], i) => ({
    id: `agent-${i}`, status, archivedAt: null, title: `Steer ${slot}`, workspaceId: ws.id, provider: 'codex', model: 'm',
    labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: slot },
  }));
  const sent = [];
  const client = {
    workspaces: {
      ref: () => ({
        refresh: async () => structuredClone(ws),
        setMetadata: async (m) => { Object.assign(ws.metadata, metaAfter ?? m); },
      }),
    },
    agents: { list: async () => ({ entries: structuredClone(agents), pageInfo: { hasMore: false } }), ref: (id) => ({ send: async (p) => { sent.push([id, p]); }, timeline: { refetch: async () => ({ entries: [] }) }, waitForFinish: async () => {} }) },
  };
  const discovery = { forkName: REPO, mainWorkspace: structuredClone(ws), steers: { labelled: structuredClone(agents), legacy: [] }, workers: [], providers: [] };
  return { client, discovery, sent, ws };
}
const lock = (_n, fn) => fn({ verify() {} });
const run = (w, extra) => switchSteer({ client: w.client, discovery: w.discovery, toSlot: 'B', apply: true, lock, language: 'en', ...extra });

test('self-takeover with running target applies and sends nothing to itself', async () => {
  const w = world();
  const r = await run(w, { callerId: 'agent-1', wait: true, notifyPrevious: false });
  assert.equal(r.applied, true);
  assert.equal(r.selfTakeover, true);
  assert.equal(r.delivered, false);
  assert.equal(r.reply, null);
  assert.deepEqual(w.sent, [], 'no handoff message to oneself');
  assert.ok(r.packet.length > 0, 'brief is returned');
  assert.equal(w.ws.metadata[METADATA_KEY].activeSteer, 'B');
  assert.equal(w.ws.metadata[METADATA_KEY].epoch, 4);
});

test('self-takeover keeps --notify-previous working', async () => {
  const w = world();
  const r = await run(w, { callerId: 'agent-1', notifyPrevious: true });
  assert.equal(r.previousNotified, true);
  assert.deepEqual(w.sent.map(([id]) => id), ['agent-0']);
});

test('third party is refused for a running target and for a running previous steer', async () => {
  await assert.rejects(run(world(), { callerId: 'agent-9' }), SwitchRefused);
  await assert.rejects(run(world({ toStatus: 'idle', fromStatus: 'running' }), { callerId: 'agent-9' }), /Active Steer A is running/);
});

test('without a caller a running target is still refused', async () => {
  await assert.rejects(run(world(), { callerId: undefined }), SwitchRefused);
});

test('non-self switch still sends the handoff', async () => {
  const w = world({ toStatus: 'idle' });
  const r = await run(w, { callerId: null });
  assert.equal(r.delivered, true);
  assert.deepEqual(w.sent.map(([id]) => id), ['agent-1']);
});

test('self-takeover keeps the epoch check', async () => {
  const w = world();
  const orig = w.client.workspaces.ref;
  w.client.workspaces.ref = () => ({ ...orig(), refresh: async () => ({ ...structuredClone(w.ws), metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 4 } } }) });
  await assert.rejects(run(w, { callerId: 'agent-1' }), /Steer state changed/);
  assert.deepEqual(w.sent, []);
});
