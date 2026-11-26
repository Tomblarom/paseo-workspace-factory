import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./ts-resolve-hooks.mjs', import.meta.url);

const { createFactoryResultStores } = await import('../client/factory-store.ts');
const {
  createFactorySteerFeed,
  enrollmentPlan,
  pendingWorkspaceWork,
  steerConditions,
  workspaceSteers,
} = await import('../client/factory-workspace-state.ts');

const steer = (agentId, overrides = {}) => ({
  agentId, workspaceId: 'wks_main', slot: 'A', active: false, advisor: false,
  state: 'running', liveStatus: 'running', warmth: 'cold', tokens: 128_000,
  large: true, limited: true, awaitingUpdate: false, quotaRows: [], headerFacts: ['Estimated'],
  permissionNeeded: true, stagedBrief: true, ...overrides,
});

test('only one eligible steer may control the current workspace', () => {
  const active = steer('a', { active: true });
  const elsewhere = steer('b', { active: true, workspaceId: 'wks_other' });
  assert.equal(workspaceSteers([active, elsewhere], 'wks_main').controller, active);
  assert.deepEqual(workspaceSteers([active, elsewhere], 'wks_main').steers, [active]);
  const twoActive = workspaceSteers([active, steer('c', { active: true, slot: 'C' })], 'wks_main');
  assert.equal(twoActive.controller, undefined);
  assert.equal(twoActive.ambiguous, true);
  const advisor = workspaceSteers([steer('d', { active: true, advisor: true })], 'wks_main');
  assert.equal(advisor.controller, undefined);
  assert.equal(advisor.advisorAssigned, true);
  assert.equal(workspaceSteers([steer('e', { active: true, state: 'retired' })], 'wks_main').controller, undefined);
  const collision = workspaceSteers([steer('f', { state: 'unknown', detail: 'Membership ambiguous' })], 'wks_main', 'A');
  assert.equal(collision.ambiguous, true);
});

test('running, large context, quota and pending actions remain visible together', () => {
  const active = steer('a', { active: true });
  const conditions = steerConditions(active);
  assert.equal(conditions.runtime, 'Running');
  assert.equal(conditions.context, `${active.tokens.toLocaleString()} tokens · large, cache cold (estimated)`);
  assert.equal(conditions.quota, 'Limited');
  assert.equal(conditions.attention, 'Permission requested · Brief staged');
  assert.deepEqual(pendingWorkspaceWork({
    openWorkers: [{ id: 'registered', state: 'blocked' }],
    pendingWorkerWakeCount: 2,
    workers: [{ id: 'registered', status: 'running' }, { id: 'unregistered', status: 'running' }],
  }, [active]), [
    'Blocked workers (1)', 'Worker updates queued (2)', 'Workers in progress (1)',
    'Steer briefs staged (1)', 'Steer permission requests (1)',
  ]);
  const unknown = steerConditions(steer('b', {
    state: 'unknown', liveStatus: null, tokens: null, warmth: 'unknown', headerFacts: [], large: false, limited: false,
  }));
  assert.equal(unknown.runtime, 'Unknown');
  assert.equal(unknown.context, 'Size unknown, cache unknown');
  assert.equal(unknown.quota, 'Unknown');
});

test('the existing steer feed retains the last rows through a disconnect', () => {
  const feed = createFactorySteerFeed();
  let updates = 0;
  const unsubscribe = feed.subscribe(() => { updates += 1; });
  assert.equal(feed.getSnapshot().rows, null);
  const rows = [steer('a')];
  feed.update(rows);
  feed.disconnect();
  assert.equal(feed.getSnapshot().rows, rows);
  assert.equal(feed.getSnapshot().disconnected, true);
  unsubscribe();
  feed.update([]);
  assert.equal(feed.getSnapshot().disconnected, false);
  assert.deepEqual(feed.getSnapshot().rows, []);
  assert.equal(updates, 2);
});

test('setup reuses the existing plan routes from the workspace status hint', () => {
  const statusError = (hint) => new Error(`Workspace "New" is not managed by the factory yet. To set it up, preview a plan: /factory plan ${hint}`);
  assert.deepEqual(enrollmentPlan(statusError('workspace:wks_main'), 'wks_main'), { repos: ['workspace:wks_main'] });
  assert.deepEqual(enrollmentPlan(statusError('--local "/a workspace"'), 'wks_main'), { local: ['/a workspace'] });
  assert.equal(enrollmentPlan(statusError('workspace:wks_other'), 'wks_main'), undefined);
  assert.equal(enrollmentPlan(statusError('--local'), 'wks_main'), undefined);
  assert.equal(enrollmentPlan(new Error('RPC disconnected'), 'wks_main'), undefined);
});

test('a result goes to its originating workspace and host registration', () => {
  const firstHost = createFactoryResultStores();
  const secondHost = createFactoryResultStores();
  let notifications = 0;
  firstHost('one').subscribe(() => { notifications += 1; });
  const preview = { kind: 'resumePreview', at: 'now', workspaceId: 'target', agentId: 'steer' };
  firstHost('one').setResult(preview);
  assert.equal(firstHost('one').getResult(), preview);
  assert.equal(firstHost('two').getResult(), null);
  assert.equal(secondHost('one').getResult(), null);
  assert.equal(notifications, 1);
});
