import test from 'node:test';
import assert from 'node:assert/strict';
import { guardScope, scopeHolder } from '../src/scope-guard.mjs';
import { LABEL, METADATA_KEY } from '../src/paseo.mjs';
import { CONTINUED_FROM_LABEL } from '../src/zerosub.mjs';

const scopeId = 'example/repo';
const workspaceId = 'wks_1';
const agent = (id, slot, extra = {}) => ({ id, workspaceId, labels: { [LABEL.scope]: scopeId, [LABEL.role]: 'steer', [LABEL.slot]: slot }, ...extra });
const page = (entries) => ({ entries, pageInfo: { hasMore: false } });
function fixture() {
  const state = { activeSteer: 'A', epoch: 1, scope: { id: scopeId } };
  const agents = [agent('a', 'A'), agent('b', 'B')];
  const client = {
    projects: { list: async () => ({ projects: [] }) },
    providers: { snapshot: async () => ({ entries: [] }) },
    workspaces: { list: async () => page([]), ref: () => ({ refresh: async () => ({ metadata: { [METADATA_KEY]: state } }) }) },
    agents: { list: async () => page(agents) },
  };
  return { state, agents, client, held: { verify() {} }, workspaceId, scopeId, epoch: 1, agentId: 'a' };
}

test('guard requires the expected epoch even after A → B → A', async () => {
  const args = fixture();
  assert.equal((await guardScope(args)).holder.id, 'a');
  args.state.activeSteer = 'B'; args.state.epoch = 2;
  await assert.rejects(guardScope(args), /changed/);
  args.state.activeSteer = 'A'; args.state.epoch = 3;
  await assert.rejects(guardScope(args), /changed/);
});

test('guard checks exact holder, scope and lock identity', async () => {
  const args = fixture();
  await assert.rejects(guardScope({ ...args, agentId: 'b' }), /Active steer changed/);
  await assert.rejects(guardScope({ ...args, scopeId: 'other/repo' }), /Scope state changed/);
  await assert.rejects(guardScope({ ...args, held: { verify() { throw Error('lock replaced'); } } }), /lock replaced/);
});

test('guard rejects an advisor configured as active holder', async () => {
  const args = fixture();
  const config = { steers: { slots: { A: 'advisor' } }, profiles: { advisor: { advisor: true } } };
  await assert.rejects(guardScope({ ...args, config }), /advisor steer/);
});

test('holder applies newer-wins and fails closed on ties', () => {
  const old = agent('old', 'A', { createdAt: '2026-01-01T00:00:00Z' });
  const current = agent('new', 'A', { createdAt: '2026-01-02T00:00:00Z' });
  assert.equal(scopeHolder({ agents: [old, current], workspaceId, scopeId, slot: 'A' }).id, 'new');
  assert.throws(() => scopeHolder({ agents: [old, { ...current, createdAt: old.createdAt }], workspaceId, scopeId, slot: 'A' }), /one active/);
});

test('an unregistered fresh candidate cannot become the holder', async () => {
  const args = fixture();
  args.agents[0].createdAt = '2026-01-01T00:00:00Z';
  args.agents.push(agent('candidate', 'A', { createdAt: '2026-01-02T00:00:00Z' }));
  await assert.rejects(guardScope(args), /ambiguous legacy/);
  args.state.activeAgentId = 'a';
  assert.equal((await guardScope(args)).holder.id, 'a');
  await assert.rejects(guardScope({ ...args, agentId: 'candidate' }), /Active steer changed/);
});

test('recorded owner resolves to its live continuation', async () => {
  const args = fixture();
  args.state.activeAgentId = 'a';
  args.agents.push({ id: 'continued', workspaceId, labels: { [CONTINUED_FROM_LABEL]: 'a' } });
  assert.equal((await guardScope({ ...args, agentId: 'continued' })).holder.id, 'continued');
  await assert.rejects(guardScope(args), /Active steer changed/);
});
