import test from 'node:test';
import assert from 'node:assert/strict';
import { guardScope, scopeHolder } from '../plugin/server/core/scope-guard.mjs';
import { LABEL, METADATA_KEY, PARENT_LABEL } from '../plugin/server/core/paseo.mjs';
import { CONTINUED_FROM_LABEL } from '../plugin/server/core/zerosub.mjs';

const scopeId = 'example/repo';
const workspaceId = 'wks_1';
const agent = (id, slot, extra = {}) => ({ id, title: `Steer ${slot}`, workspaceId, labels: { [LABEL.scope]: scopeId, [LABEL.role]: 'steer', [LABEL.slot]: slot }, ...extra });
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

test('guard enforces the role of the live holder even without host settings', async () => {
  const args = fixture();
  args.agents[0].metadata = { [LABEL.steerRole]: 'advisor' };
  await assert.rejects(guardScope(args), /advisor steer/);
  args.agents[0].metadata[LABEL.steerRole] = 'coordinator';
  const config = { steers: { slots: { A: 'review' } }, profiles: { review: { advisor: true } } };
  assert.equal((await guardScope({ ...args, config })).holder.id, 'a');
});

test('same-slot titles remain ambiguous regardless of creation time', () => {
  const old = agent('old', 'A', { createdAt: '2026-01-01T00:00:00Z' });
  const current = agent('new', 'A', { createdAt: '2026-01-02T00:00:00Z' });
  assert.throws(() => scopeHolder({ agents: [old, current], workspaceId, scopeId, slot: 'A' }), /found 2/);
  assert.equal(scopeHolder({ agents: [old, { ...current, title: 'Retired A' }], workspaceId, scopeId, slot: 'A' }).id, 'old');
  assert.equal(scopeHolder({ agents: [{ ...old, archivedAt: '2026-01-03' }, current], workspaceId, scopeId, slot: 'A' }).id, 'new');
});

test('only parentless tabs in the main workspace participate in a slot', () => {
  const holder = agent('holder', 'A');
  const foreignWorkspace = agent('elsewhere', 'A', { workspaceId: 'wks_other' });
  const child = agent('child', 'A', { labels: { ...holder.labels, [PARENT_LABEL]: 'parent' } });
  assert.equal(scopeHolder({ agents: [holder, foreignWorkspace, child], workspaceId, scopeId, slot: 'A' }).id, holder.id);
});

test('a same-slot candidate remains ambiguous even with a recorded owner', async () => {
  const args = fixture();
  args.agents[0].createdAt = '2026-01-01T00:00:00Z';
  args.agents.push(agent('candidate', 'A', { createdAt: '2026-01-02T00:00:00Z' }));
  await assert.rejects(guardScope(args), /found 2/);
  args.state.activeAgentId = 'a';
  await assert.rejects(guardScope(args), /found 2/);
});

test('a continuation inherits membership from its origin or its own title', async () => {
  const args = fixture();
  args.state.activeAgentId = 'a';
  args.agents.push({ id: 'continued', workspaceId, labels: { [CONTINUED_FROM_LABEL]: 'a' } });
  assert.equal((await guardScope({ ...args, agentId: 'continued' })).holder.id, 'continued');
  await assert.rejects(guardScope(args), /Active steer changed/);
  args.agents[0].title = 'Retired A';
  args.agents[2].title = '▷ Steer A · continuation';
  assert.equal((await guardScope({ ...args, agentId: 'continued' })).holder.id, 'continued');
});

test('two live continuation tabs of one origin remain ambiguous', () => {
  const origin = agent('origin', 'A');
  const agents = [
    origin,
    { id: 'continued-1', title: 'Steer A', workspaceId, labels: { [CONTINUED_FROM_LABEL]: origin.id } },
    { id: 'continued-2', title: 'Steer A', workspaceId, labels: { [CONTINUED_FROM_LABEL]: origin.id } },
  ];
  assert.throws(() => scopeHolder({ agents, workspaceId, scopeId, slot: 'A' }), /found 2/);
});

test('an archived origin does not archive its live continuation', () => {
  const origin = agent('origin', 'A', { archivedAt: '2026-01-01' });
  const continued = { id: 'continued', title: 'Steer A', workspaceId, labels: { [CONTINUED_FROM_LABEL]: origin.id } };
  assert.equal(scopeHolder({ agents: [origin, continued], workspaceId, scopeId, slot: 'A' }).id, continued.id);
});

test('an errored origin cannot regain authority when its continuation is archived', async () => {
  const args = fixture();
  args.state.activeAgentId = 'a';
  args.agents[0].status = 'error';
  args.agents.push({ id: 'continued', workspaceId, archivedAt: '2026-01-01', labels: { [CONTINUED_FROM_LABEL]: 'a' } });
  await assert.rejects(guardScope(args), /continuation.*cannot resume/);
});
