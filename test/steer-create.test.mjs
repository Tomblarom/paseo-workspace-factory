// One steer request builder + one placement verifier (K9): shared request,
// key and placement construction, placement checks for created/observed
// agents, and the fail-closed receipt lookup/validation/confirmation used by
// plan, steer add and fresh. Fake state only; no daemon.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LABEL, PARENT_LABEL } from '../plugin/server/core/paseo.mjs';
import {
  buildSteerCreate,
  checkedCreationReceipt,
  confirmCreationReceipt,
  idempotencyKey,
  lookupCreation,
  profileAgentConfig,
  requestDigest,
  shortHolderId,
  steerCreateKey,
  steerCreateLabels,
  SteerPlacementError,
  verifyCreatedAgent,
  verifySteerPlacement,
} from '../plugin/server/core/steer-create.mjs';

const PROFILE = { name: 'standard', provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' };

// ------------------------------------------------------------------ builder

test('buildSteerCreate produces the request, key and expected placement', () => {
  const { request, idempotencyKey: key, expected } = buildSteerCreate({
    keyScope: 'Example/Repo', repo: 'Example/Repo', scopeId: 'notes', slot: 'B',
    workspaceId: 'wks_1', profile: PROFILE, keyParts: ['steer', 'B', 'g1'],
  });
  assert.deepEqual(request, {
    workspaceId: 'wks_1',
    title: 'Steer B',
    labels: { [LABEL.repo]: 'Example/Repo', [LABEL.role]: 'steer', [LABEL.slot]: 'B', [LABEL.scope]: 'notes' },
    config: { provider: 'codex/gpt-6.2-sol', modeId: 'full-access', thinkingOptionId: 'high' },
  });
  assert.equal(key, `wsf:example/repo:steer:B:g1:${requestDigest(request)}`);
  assert.deepEqual(expected, {
    workspaceId: 'wks_1',
    labels: request.labels,
    slot: 'B',
    scopeId: 'notes',
    provider: 'codex',
    model: 'gpt-6.2-sol',
    parent: null,
  });
});

test('buildSteerCreate honors title, metadata pin and digest overrides', () => {
  const metadata = { 'zerosub.account': 'acc-1' };
  const pinned = buildSteerCreate({
    keyScope: 'r', repo: 'r', scopeId: 'r', slot: 'A', workspaceId: 'w',
    profile: { provider: 'p', model: 'm' }, title: '▷ Steer A',
    keyParts: ['steer', 'A', 'g1'], metadata, accountId: 'acc-1',
  });
  assert.equal(pinned.request.title, '▷ Steer A');
  assert.deepEqual(pinned.request.metadata, metadata);
  assert.ok(pinned.request.metadata !== metadata, 'the pin is copied, not shared');
  assert.equal(pinned.expected.accountId, 'acc-1');

  const plain = buildSteerCreate({
    keyScope: 'r', repo: 'r', scopeId: 'r', slot: 'A', workspaceId: 'w',
    profile: { provider: 'p', model: 'm' }, keyParts: ['steer', 'A', 'g1'],
  });
  assert.equal(plain.request.metadata, undefined);
  assert.equal(plain.expected.accountId, undefined);

  // A caller whose workspace id is unknown until apply digests its stable
  // inputs instead, so the key must not depend on the request.
  const preview = buildSteerCreate({
    keyScope: 'r', repo: 'r', scopeId: 'r', slot: 'A', workspaceId: null,
    profile: { provider: 'p', model: 'm' }, keyParts: ['steer', 'A', 'preview'],
    digestInput: { target: '/p/moved', title: 'Steer A' },
  });
  assert.equal(preview.idempotencyKey, steerCreateKey('r', ['steer', 'A', 'preview'], { target: '/p/moved', title: 'Steer A' }));
});

test('key helpers lowercase the scope and shorten holder ids', () => {
  assert.equal(idempotencyKey('Mixed/Case', 'steer', 'A'), 'wsf:mixed/case:steer:A');
  assert.equal(shortHolderId('agent-abc-123-XYZ'), 'agentabc');
  assert.equal(shortHolderId(null), 'x');
  assert.equal(shortHolderId('!!!'), 'x');
  assert.deepEqual(steerCreateLabels('repo', 'scope', 'C'), {
    [LABEL.repo]: 'repo', [LABEL.role]: 'steer', [LABEL.slot]: 'C', [LABEL.scope]: 'scope',
  });
  assert.deepEqual(profileAgentConfig({ provider: 'p', model: 'm' }), { provider: 'p/m' });
});

// ----------------------------------------------------------------- verifier

function placed(overrides = {}) {
  return {
    id: 'agent-new', workspaceId: 'wks_1', archivedAt: null,
    provider: 'codex', model: 'gpt-6.2-sol', status: 'idle',
    labels: { [LABEL.repo]: 'r', [LABEL.role]: 'steer', [LABEL.slot]: 'A', [LABEL.scope]: 'r' },
    metadata: { 'zerosub.account': 'acc-1' },
    ...overrides,
  };
}

const FULL = {
  workspaceId: 'wks_1',
  labels: { [LABEL.repo]: 'r', [LABEL.role]: 'steer', [LABEL.slot]: 'A', [LABEL.scope]: 'r' },
  parent: null, provider: 'codex', model: 'gpt-6.2-sol', accountId: 'acc-1',
};

test('verifySteerPlacement accepts a matching agent and skips absent expectations', () => {
  verifySteerPlacement(placed(), FULL);
  verifySteerPlacement(placed(), { labels: FULL.labels }); // occupant match: labels only
  verifySteerPlacement({ ...placed(), workspaceId: 'wks_other' }, { labels: FULL.labels, provider: 'codex', model: 'gpt-6.2-sol' });
});

test('verifySteerPlacement refuses missing, archived and misplaced agents', () => {
  assert.throws(() => verifySteerPlacement(null, FULL), (error) => {
    assert.ok(error instanceof SteerPlacementError);
    assert.match(error.message, /snapshot missing/);
    return true;
  });
  assert.throws(() => verifySteerPlacement(placed({ archivedAt: '2026-11-25T00:00:00Z' }), FULL), /is archived \(an old idempotency receipt\?\)/);
  assert.throws(() => verifySteerPlacement(placed({ workspaceId: 'wks_other' }), FULL), /landed in wks_other, expected wks_1/);
});

test('verifySteerPlacement refuses parented steers and wrong worker parents', () => {
  const parented = placed({ labels: { ...placed().labels, [PARENT_LABEL]: 'agent-caller' } });
  assert.throws(() => verifySteerPlacement(parented, FULL), /PARENT VIOLATION: agent agent-new has parent agent-caller; not continuing/);
  assert.throws(
    () => verifySteerPlacement(placed(), { ...FULL, parent: 'agent-owner' }),
    /parent is null, expected agent-owner/,
  );
  assert.throws(
    () => verifySteerPlacement(parented, { ...FULL, parent: 'agent-owner' }),
    /parent is agent-caller, expected agent-owner/,
  );
});

test('verifySteerPlacement refuses label, model and account mismatches', () => {
  const relabel = (labels) => placed({ labels: { ...placed().labels, ...labels } });
  assert.throws(() => verifySteerPlacement(relabel({ [LABEL.slot]: 'B' }), FULL), /label wsf\.slot is B, expected A/);
  assert.throws(() => verifySteerPlacement(relabel({ [LABEL.scope]: 'other' }), FULL), /label wsf\.scope is other, expected r/);
  assert.throws(
    () => verifySteerPlacement(placed({ provider: 'other', model: 'm' }), FULL),
    /runs other\/m, expected codex\/gpt-6\.2-sol/,
  );
  assert.throws(
    () => verifySteerPlacement(placed({ metadata: { 'zerosub.account': 'acc-2' } }), FULL),
    /account is acc-2, expected acc-1/,
  );
  assert.throws(
    () => verifySteerPlacement(placed({ metadata: {} }), FULL),
    /account is none, expected acc-1/,
  );
});

test('verifyCreatedAgent fails open on an unreadable snapshot and maps mismatches', async () => {
  const failing = { agents: { ref: () => ({ refresh: async () => { throw new Error('gone'); } }) } };
  await verifyCreatedAgent(failing, 'agent-new', FULL, (message) => new Error(`mapped: ${message}`));
  const missing = { agents: { ref: () => ({ refresh: async () => ({ agent: null }) }) } };
  await verifyCreatedAgent(missing, 'agent-new', FULL, (message) => new Error(`mapped: ${message}`));

  const mismatch = { agents: { ref: () => ({ refresh: async () => ({ agent: placed({ workspaceId: 'wks_other' }) }) }) } };
  await assert.rejects(
    verifyCreatedAgent(mismatch, 'agent-new', FULL, (message) => new Error(`mapped: ${message}`)),
    /mapped: Agent agent-new landed in wks_other/,
  );
});

// ------------------------------------------------------------------ receipts

const fail = (message) => new Error(`stopped: ${message}`);

test('lookupCreation never reads a failure as "no receipt"', async () => {
  await assert.rejects(lookupCreation(null, 'agent', 'k', fail), /needs a receipt lookup; refusing to create/);
  await assert.rejects(
    lookupCreation(async () => { throw new Error('boom'); }, 'agent', 'k', fail),
    /receipt lookup failed \(boom\); refusing to create/,
  );
  assert.equal(await lookupCreation(async () => null, 'agent', 'k', fail), null);
  assert.deepEqual(await lookupCreation(async () => ({ phase: 'completed' }), 'agent', 'k', fail), { phase: 'completed' });
});

test('checkedCreationReceipt accepts only completed receipts with an id', () => {
  const key = 'wsf:r:steer:A:g1:digest';
  assert.equal(checkedCreationReceipt({ idempotencyKey: key, phase: 'completed', agentId: 'a-1' }, key, fail), 'a-1');
  assert.throws(() => checkedCreationReceipt({ idempotencyKey: 'wsf:other', phase: 'completed', agentId: 'a-1' }, key, fail), /belongs to a different key/);
  assert.throws(() => checkedCreationReceipt({ idempotencyKey: key, phase: 'completed', outcomeUnknown: true, error: 'x' }, key, fail), /unknown outcome \(x\)/);
  assert.throws(() => checkedCreationReceipt({ idempotencyKey: key, phase: 'accepted' }, key, fail), /phase accepted/);
  assert.throws(() => checkedCreationReceipt({ idempotencyKey: key, phase: 'failed', error: 'boom' }, key, fail), /phase failed \(boom\)/);
  assert.throws(() => checkedCreationReceipt({ idempotencyKey: key, phase: 'completed' }, key, fail), /names no agent/);
  assert.equal(
    checkedCreationReceipt({ idempotencyKey: key, phase: 'completed', workspace: { id: 'w-1' } }, key, fail, {
      idOf: (receipt) => receipt.workspace?.id ?? receipt.workspaceId, missing: 'the receipt names no unambiguous workspace',
    }),
    'w-1',
  );
});

test('confirmCreationReceipt re-sends the identical request and checks the id', async () => {
  const op = { key: 'k', params: { idempotencyKey: 'key-1' } };
  const ok = await confirmCreationReceipt(async () => ({ agentId: 'a-1' }), op, undefined, 'a-1', fail);
  assert.deepEqual(ok, { id: 'a-1', confirmed: { agentId: 'a-1' } });
  await assert.rejects(
    confirmCreationReceipt(async () => { throw new Error('agent_request_key_conflict'); }, op, undefined, 'a-1', fail),
    /identical request was rejected \(agent_request_key_conflict\)/,
  );
  await assert.rejects(
    confirmCreationReceipt(async () => ({ agentId: 'a-2' }), op, undefined, 'a-1', fail),
    /identical request returned a-2, receipt says a-1/,
  );
});

test('same key with a changed request is refused by the daemon, surfaced on confirm', async () => {
  // Minimal daemon: one receipt per key, exact-request fingerprint like the
  // real creation service (an identical re-send returns the agent, anything
  // else conflicts and creates nothing).
  const receipts = new Map();
  const fingerprints = new Map();
  const create = async (opts) => {
    const fingerprint = JSON.stringify({ ...opts, idempotencyKey: undefined });
    if (receipts.has(opts.idempotencyKey)) {
      if (fingerprints.get(opts.idempotencyKey) !== fingerprint) throw new Error('agent_request_key_conflict');
      return { agentId: receipts.get(opts.idempotencyKey) };
    }
    const agentId = `agent-${receipts.size + 1}`;
    receipts.set(opts.idempotencyKey, agentId);
    fingerprints.set(opts.idempotencyKey, fingerprint);
    return { agentId };
  };
  const first = buildSteerCreate({
    keyScope: 'r', repo: 'r', scopeId: 'r', slot: 'A', workspaceId: 'wks_1',
    profile: PROFILE, keyParts: ['steer', 'A', 'g1'],
  });
  const created = await create({ ...first.request, idempotencyKey: first.idempotencyKey });
  assert.equal(receipts.size, 1);

  // Same key, changed request (another model): the daemon refuses.
  const changed = { ...first.request, config: { provider: 'other/m' } };
  await assert.rejects(create({ ...changed, idempotencyKey: first.idempotencyKey }), /agent_request_key_conflict/);
  assert.equal(receipts.size, 1, 'the conflicting request created nothing');

  // Recovery surfaces the refusal instead of adopting an unrelated agent.
  const op = { key: 'steer.A', kind: 'paseo.agent.create', params: { ...changed, idempotencyKey: first.idempotencyKey } };
  await assert.rejects(
    confirmCreationReceipt(async (attempt) => create(attempt.params), op, undefined, created.agentId, fail),
    /identical request was rejected \(agent_request_key_conflict\)/,
  );
});
