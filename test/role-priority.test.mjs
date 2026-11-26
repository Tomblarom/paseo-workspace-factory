import test from 'node:test';
import assert from 'node:assert/strict';
import { steerFallbackList, resolveSteerAdd, planAdvisorTag } from '../plugin/server/core/models.mjs';
import { planSteerAdd } from '../plugin/server/core/steer-add.mjs';

function fixture() {
  const p = (model, advisor = false) => ({ provider: 'codex', model, thinking: null, mode: null, advisor, sensitive: false });
  const config = { version: 1, github: { owner: 'example', cloneProtocol: 'https', upstreamRemote: 'upstream' },
    checkoutRoot: '/tmp/priorities', workspaceTitle: 'Main',
    profiles: { fast: p('fast'), preferred: p('preferred'), expert: p('expert', true), unused: p('unused') },
    steers: { slots: { A: 'fast', B: 'preferred', C: 'expert' }, prepare: ['A', 'B', 'C'], initialActive: 'A', priority: ['preferred', 'fast'] },
    advisors: { priority: ['expert'] }, workers: { priority: ['fast'], defaultProfile: 'fast' } };
  const catalog = [{ provider: 'codex', enabled: true, status: 'ready', modes: [],
    models: Object.values(config.profiles).map((p) => ({ id: p.model })) }];
  return { config, catalog };
}

test('migrated host priorities are independent of the steer identity letter', () => {
  const { config, catalog } = fixture();
  const args = { workspaceId: 'wks' };
  const first = planSteerAdd(config, catalog, [], args);
  const next = planSteerAdd(config, catalog, [{ id: 'a', workspaceId: 'wks', title: 'Steer A' }], args);
  assert.deepEqual([first.slot, next.slot], ['A', 'B']);
  assert.equal(first.profile.name, 'preferred');
  assert.equal(next.profile.name, 'preferred');
  assert.deepEqual(config.steers.priority, ['preferred', 'fast']);
});

test('creation uses its role priority; explicit one-run choice leaves all preferences untouched', () => {
  const { config, catalog } = fixture();
  const before = structuredClone(config);
  assert.equal(resolveSteerAdd(config, catalog).profile.name, 'preferred');
  assert.equal(resolveSteerAdd(config, catalog, { advisorSlot: true }).profile.name, 'expert');
  assert.equal(resolveSteerAdd(config, catalog, { profile: 'fast' }).profile.name, 'fast');
  assert.deepEqual(config, before);
});

test('an empty explicit role priority never falls back to unrelated named presets', () => {
  const { config, catalog } = fixture();
  config.steers.priority = [];
  assert.equal(resolveSteerAdd(config, catalog).profile, null);
  config.advisors.priority = [];
  assert.equal(resolveSteerAdd(config, catalog, { advisorSlot: true }).profile, null);
});

test('intentional preset retag moves its existing priority entry and preserves unrelated role orders', () => {
  const { config, catalog } = fixture();
  const plan = planAdvisorTag(config, catalog, { spec: 'preferred', on: true });
  assert.deepEqual(plan.config.steers.priority, ['fast']);
  assert.deepEqual(plan.config.advisors.priority, ['expert', 'preferred']);
  assert.deepEqual(config.steers.priority, ['preferred', 'fast']);
  const reverse = planAdvisorTag(plan.config, catalog, { spec: 'preferred', on: false });
  assert.deepEqual(reverse.config.steers.priority, ['fast', 'preferred']);
  assert.deepEqual(reverse.config.advisors.priority, ['expert']);
});

test('legacy settings retain their fallback until migration, without requiring new lists', () => {
  const { config } = fixture();
  delete config.steers.priority; delete config.advisors;
  assert.deepEqual(steerFallbackList(config, 'B'), ['preferred', 'expert', 'fast']);
});
