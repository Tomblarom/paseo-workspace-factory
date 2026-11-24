import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LABEL, METADATA_KEY, PARENT_LABEL } from '../src/paseo.mjs';
import { startScopedWorker } from '../src/workers.mjs';

function setup() {
  const workspaceId = 'wks_example';
  const scope = 'example/project';
  const parentId = 'example-steer';
  const state = { activeSteer: 'B', epoch: 3, scope: { id: scope } };
  const requests = [];
  const workspace = {
    refresh: async () => ({ metadata: { [METADATA_KEY]: state } }),
    agents: {
      create: async (request) => {
        requests.push(request);
        return { refresh: async () => ({ agent: {
          id: 'example-worker', workspaceId,
          labels: { ...request.labels, [PARENT_LABEL]: request.parent }, metadata: request.metadata,
        } }) };
      },
    },
  };
  return {
    requests, state,
    options: {
      client: { workspaces: { ref: () => workspace } },
      status: { state: structuredClone(state), workspace: { id: workspaceId }, repo: scope,
        steers: [{ id: parentId, slot: 'B', workspaceId }] },
      callerId: parentId,
      profile: { name: 'worker', provider: 'codex', model: 'example', mode: 'full-access' },
      accountId: 'example-account', title: 'Check unit tests', prompt: 'Review the synthetic fixture.',
    },
  };
}

test('worker start previews without changes and pins the account at native creation', async () => {
  const { options, requests } = setup();
  const preview = await startScopedWorker(options);
  assert.equal(preview.accountId, 'example-account');
  assert.deepEqual(requests, []);
  const actual = await startScopedWorker({ ...options, apply: true });
  assert.equal(actual.agentId, 'example-worker');
  const [request] = requests;
  assert.equal(request.parent, options.callerId);
  assert.deepEqual(request.labels, {
    [LABEL.scope]: 'example/project', [LABEL.role]: 'worker', [LABEL.owner]: 'B',
  });
  assert.deepEqual(request.metadata, { 'zerosub.account': 'example-account' });
  assert.equal(request.config.modeId, 'full-access');
  await startScopedWorker({ ...options, accountId: null, apply: true });
  assert.equal(requests[1].metadata, undefined);
  assert.equal(requests[1].idempotencyKey, request.idempotencyKey);
});

test('worker start requires the active steer and rejects a stale epoch', async () => {
  const { options, requests, state } = setup();
  await assert.rejects(startScopedWorker({ ...options, callerId: 'other-agent', apply: true }), /active steer/);
  state.epoch++;
  await assert.rejects(startScopedWorker({ ...options, apply: true }), /changed since discovery/);
  assert.deepEqual(requests, []);
});
