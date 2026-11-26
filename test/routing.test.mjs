import test from 'node:test';
import assert from 'node:assert/strict';
import { planRoutes } from '../plugin/server/core/routing.mjs';

const route = (kind, evidence = {}, extra = {}) => ({
  id: kind, kind, eligible: true, evidence, confidence: 'estimated', ...extra,
});

test('all five route kinds can win from evidence; moves have no fixed priority', () => {
  const kinds = ['continue', 'move', 'handover', 'renewal', 'create'];
  for (const winner of kinds) {
    const candidates = kinds.map((kind) => route(kind, {
      uncachedInputTokens: kind === winner ? 1_000 : 20_000,
      preparationTurns: kind === winner ? 1 : 0,
    }));
    const plan = planRoutes({ due: true, candidates });
    assert.equal(plan.selected.kind, winner);
    assert.equal(plan.reason, 'selected by uncachedInputTokens');
  }
});

test('strategies use deterministic priorities without invented cost weights', () => {
  const candidates = [
    route('move', { uncachedInputTokens: 1_000, preparationTurns: 1, preferenceRank: 1 }),
    route('handover', { uncachedInputTokens: 5_000, preparationTurns: 0, preferenceRank: 2 }),
    route('create', { uncachedInputTokens: 10_000, preparationTurns: 2, preferenceRank: 0 }),
  ];
  for (const [strategy, expected] of [['efficiency', 'move'], ['balanced', 'handover'], ['preference', 'create']]) {
    assert.equal(planRoutes({ due: true, strategy, candidates }).selected.kind, expected);
  }
});

test('no due work selects no effect even with eligible candidates', () => {
  assert.equal(planRoutes({ candidates: [route('move')] }).selected, null);
});

test('hard restrictions exclude cheap or preferred alternatives in every strategy', () => {
  const candidates = [
    route('continue', { uncachedInputTokens: 0 }, { eligible: false, reason: 'provider limit' }),
    route('move', { uncachedInputTokens: 0 }, { eligible: false, reason: 'user pin' }),
    route('create', { preferenceRank: 0 }, { eligible: false, reason: 'creation not approved' }),
    route('renewal', { uncachedInputTokens: 0 }, { eligible: undefined }),
    route('handover', { uncachedInputTokens: 50_000, preferenceRank: 5 }),
  ];
  for (const strategy of ['efficiency', 'balanced', 'preference']) {
    const plan = planRoutes({ due: true, strategy, candidates });
    assert.equal(plan.selected.kind, 'handover');
    assert.equal(plan.excluded.length, 4);
    assert.equal(plan.excluded[3].reason, 'eligibility not established');
  }
});

test('a preserved conversation does not imply a warm destination cache', () => {
  const plan = planRoutes({ due: true, candidates: [
    route('move', {}, { conversationPreserved: true, cache: 'unknown' }),
    route('handover', { uncachedInputTokens: 8_000 }, { confidence: 'observed' }),
  ] });
  assert.equal(plan.selected.kind, 'handover');
  assert.equal(plan.ranked[1].evidence.uncachedInputTokens, null);
});

test('unlike quota percentages never determine the winner or imply cost', () => {
  const plan = planRoutes({ due: true, candidates: [
    route('continue', {}, { quota: { provider: 'claude', usedPercent: 90, window: '5h' } }),
    route('handover', {}, { quota: { provider: 'codex', usedPercent: 1, window: 'weekly' } }),
  ] });
  assert.equal(plan.selected.kind, 'continue');
  assert.equal(plan.reason, 'equal evidence; retained candidate order');
  assert.equal(plan.selected.confidence, 'estimated');
});

test('preview keeps the binding for execution and reports excluded route reasons', () => {
  const observation = { epoch: 16, holderId: 'holder', settingsRevision: 'revision', accountId: 'source' };
  const plan = planRoutes({ due: true, observation, candidates: [
    route('move', {}, { eligible: false, reason: 'move RPC unsupported' }),
    route('handover', { preparationTurns: 1 }),
  ] });
  assert.deepEqual(plan.observation, observation);
  assert.equal(plan.selected.id, 'handover');
  assert.equal(plan.excluded[0].reason, 'move RPC unsupported');
  assert.equal(plan.reason, 'only eligible route');
});

test('missing routes wait, exact ties are stable, malformed policies fail explicitly', () => {
  assert.equal(planRoutes({ due: true }).reason, 'no eligible route');
  const candidates = [route('renewal'), route('move')];
  assert.equal(planRoutes({ due: true, candidates }).selected.id, 'renewal');
  assert.equal(planRoutes({ due: true, candidates: [...candidates].reverse() }).selected.id, 'move');
  assert.throws(() => planRoutes({ strategy: 'comfort' }), /Unknown routing strategy/);
  assert.throws(() => planRoutes({ candidates: [route('move'), route('move')] }), /unique ids/);
  assert.throws(() => planRoutes({ candidates: [route('unknown')] }), /Unknown route kind/);
});

test('missing and invalid cost evidence is unknown, never free', () => {
  const plan = planRoutes({ due: true, candidates: [
    route('move', { uncachedInputTokens: -1, preparationTurns: NaN, latencyMs: Infinity }),
    route('continue', { uncachedInputTokens: 0 }),
  ] });
  assert.equal(plan.selected.kind, 'continue');
  assert.deepEqual(plan.ranked[1].evidence, {
    uncachedInputTokens: null, preparationTurns: null, latencyMs: null, preferenceRank: null,
  });
});

test('explicit target is a constraint; cheaper automatic alternatives never replace it', () => {
  const candidates = [
    route('handover', { preparationTurns: 0 }, { id: 'cheap', agentId: 'standby' }),
    route('renewal', { preparationTurns: 1 }, { id: 'requested', agentId: 'chosen' }),
  ];
  const plan = planRoutes({ due: true, candidates, intent: { mode: 'explicit', agentId: 'chosen' } });
  assert.equal(plan.selected.id, 'requested');
  assert.equal(plan.alternatives[0].id, 'cheap');
  candidates[1].eligible = false;
  candidates[1].reason = 'quota exhausted';
  const blocked = planRoutes({ due: true, candidates, intent: { mode: 'explicit', agentId: 'chosen' } });
  assert.equal(blocked.selected, null);
  assert.equal(blocked.reason, 'requested route unavailable');
  assert.equal(blocked.excluded.find((item) => item.id === 'requested').reason, 'quota exhausted');
  assert.equal(blocked.alternatives[0].agentId, 'standby');
});

test('explicit provider/model selection keeps eligibility and preparation checks', () => {
  const candidates = [
    route('continue', {}, { agentId: 'other', provider: 'claude', model: 'm' }),
    route('renewal', {}, { agentId: 'chosen', provider: 'codex', model: 'g' }),
  ];
  const plan = planRoutes({ due: true, candidates, intent: { mode: 'explicit', provider: 'codex', model: 'g' } });
  assert.equal(plan.selected.kind, 'renewal');
  assert.equal(plan.selected.agentId, 'chosen');
  assert.throws(() => planRoutes({ intent: { mode: 'explicit' } }), /target steer or provider\/model/);
});
