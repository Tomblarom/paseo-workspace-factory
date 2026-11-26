// Role prompts (TODO 22, priority C): hook targeting is steer-only on
// interactive opens, and `worker start` appends the worker block while the
// idempotency key still covers the raw task only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LABEL, METADATA_KEY, PARENT_LABEL } from '../server/core/paseo.mjs';
import {
  ADVISOR_ROLE_PROMPT,
  STEER_ROLE_PROMPT,
  WORKER_ROLE_PROMPT,
  factoryCliCommand,
  rolePromptForOpen,
  withFactoryCli,
} from '../server/core/role-prompts.mjs';
import { idempotencyKey, requestDigest } from '../server/core/steer-create.mjs';
import { startScopedWorker } from '../server/core/workers.mjs';

const STEER = { [LABEL.scope]: 'o/r', [LABEL.role]: 'steer', [LABEL.slot]: 'B' };
const WORKER = { [LABEL.scope]: 'o/r', [LABEL.role]: 'worker', [LABEL.owner]: 'B' };

test('hook targeting: interactive steer gets the steer text, advisor slot the advisor text', () => {
  assert.equal(rolePromptForOpen({ labels: STEER, purpose: 'interactive' }), STEER_ROLE_PROMPT);
  assert.equal(rolePromptForOpen({ labels: STEER, purpose: 'interactive', isAdvisor: true }), ADVISOR_ROLE_PROMPT);
  assert.notEqual(STEER_ROLE_PROMPT, ADVISOR_ROLE_PROMPT);
});

test('hook targeting: workers, non-factory agents and history opens get nothing', () => {
  assert.equal(rolePromptForOpen({ labels: WORKER, purpose: 'interactive' }), null);
  assert.equal(rolePromptForOpen({ labels: {}, purpose: 'interactive' }), null);
  assert.equal(rolePromptForOpen({ labels: null, purpose: 'interactive' }), null);
  assert.equal(rolePromptForOpen({ purpose: 'interactive' }), null);
  assert.equal(rolePromptForOpen({ labels: STEER, purpose: 'history' }), null);
  assert.equal(rolePromptForOpen({ labels: STEER }), null);
});

test('role texts are static and name the real CLI', () => {
  for (const text of [STEER_ROLE_PROMPT, ADVISOR_ROLE_PROMPT, WORKER_ROLE_PROMPT]) {
    assert.ok(text.length > 100, 'role text is not empty');
    assert.doesNotMatch(text, /<factory>/, 'no placeholder left');
  }
  assert.match(STEER_ROLE_PROMPT, /Exactly one steer coordinates/);
  assert.match(STEER_ROLE_PROMPT, /paseo-factory resume/);
  assert.match(ADVISOR_ROLE_PROMPT, /never coordinate or take over/);
  assert.match(WORKER_ROLE_PROMPT, /do not coordinate/);
  assert.match(WORKER_ROLE_PROMPT, /CHECKPOINT/);
});

function setup() {
  const workspaceId = 'wks_roleprompt0001';
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
    requests,
    options: {
      client: { workspaces: { ref: () => workspace }, agents: { list: async () => ({ entries: [{ id: parentId, workspaceId, labels: { [LABEL.scope]: scope, [LABEL.role]: 'steer', [LABEL.slot]: 'B' } }], pageInfo: { hasMore: false } }) } },
      status: { state: structuredClone(state), workspace: { id: workspaceId }, repo: scope,
        steers: [{ id: parentId, slot: 'B', workspaceId }] },
      callerId: parentId,
      profile: { name: 'worker', provider: 'codex', model: 'example', mode: 'full-access' },
      accountId: null, title: 'Check unit tests', prompt: 'Review the synthetic fixture.', promptOptions: { factoryRoot: '/srv/factory' },
    },
  };
}

test('CLI name renders once per host: checkout CLI when known, else paseo-factory', () => {
  assert.equal(factoryCliCommand({ factoryRoot: '/srv/factory' }), 'node /srv/factory/src/cli.mjs');
  assert.equal(factoryCliCommand({ factoryRoot: null }), 'paseo-factory');
  assert.equal(factoryCliCommand({}), 'paseo-factory');
  assert.equal(factoryCliCommand(), 'paseo-factory');
  assert.equal(withFactoryCli(STEER_ROLE_PROMPT), STEER_ROLE_PROMPT);
  const rendered = withFactoryCli(STEER_ROLE_PROMPT, { factoryRoot: '/srv/factory' });
  assert.match(rendered, /node \/srv\/factory\/src\/cli\.mjs resume/);
  assert.doesNotMatch(rendered, /paseo-factory/);
  assert.equal(withFactoryCli(ADVISOR_ROLE_PROMPT, { factoryRoot: '/srv/factory' }), ADVISOR_ROLE_PROMPT);
});

test('worker start appends the role block after the task, before findings', async () => {
  const { options, requests } = setup();
  await startScopedWorker({ ...options, apply: true });
  const [request] = requests;
  const roleBlock = withFactoryCli(WORKER_ROLE_PROMPT, options.promptOptions);
  assert.ok(request.prompt.startsWith(`${options.prompt}\n\n${roleBlock}`));
  assert.match(request.prompt, /FINDINGS\.md/);
  assert.ok(request.prompt.indexOf(roleBlock) < request.prompt.indexOf('FINDINGS.md'));
});

test('worker start names the runnable CLI per host in both forms', async () => {
  const { options, requests } = setup();
  await startScopedWorker({ ...options, apply: true });
  assert.match(requests[0].prompt, /node \/srv\/factory\/src\/cli\.mjs resume/);
  assert.doesNotMatch(requests[0].prompt, /paseo-factory/);
  await startScopedWorker({ ...options, apply: true, promptOptions: {} });
  assert.match(requests[1].prompt, /`paseo-factory resume`/);
});

test('worker idempotency key covers the raw task, not the appended text', async () => {
  const { options, requests } = setup();
  await startScopedWorker({ ...options, apply: true });
  await startScopedWorker({ ...options, apply: true, promptOptions: { findingsInPrompts: false } });
  await startScopedWorker({ ...options, apply: true, promptOptions: {} });
  const [withFindings, withoutFindings, noRoot] = requests;
  assert.equal(withFindings.idempotencyKey, withoutFindings.idempotencyKey);
  assert.equal(withFindings.idempotencyKey, noRoot.idempotencyKey);
  const expected = idempotencyKey('example/project', 'worker', 'B', 'e3',
    requestDigest({ parentId: options.callerId, title: options.title, prompt: options.prompt }));
  assert.equal(withFindings.idempotencyKey, expected);
});
