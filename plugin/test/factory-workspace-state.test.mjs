import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';

register('./ts-resolve-hooks.mjs', import.meta.url);

const { createFactoryResultStores } = await import('../client/factory-store.ts');
const {
  createFactorySteerFeed,
  enrollmentPlan,
  handoverRouteLabel,
  pendingWorkspaceWork,
  steerActionEligibility,
  steerConditions,
  steerModelName,
  workspaceSteers,
} = await import('../client/factory-workspace-state.ts');

const steer = (agentId, overrides = {}) => ({
  agentId, workspaceId: 'wks_main', scopeId: 'local/example', slot: 'A', active: false, advisor: false,
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
  const collision = workspaceSteers([steer('f', { state: 'unknown', detail: 'Membership ambiguous' })], 'wks_main', 'A');
  assert.equal(collision.ambiguous, true);
});

test('running, large context, quota and pending actions remain visible together', () => {
  const active = steer('a', { active: true, warmth: 'warm' });
  const conditions = steerConditions(active);
  assert.equal(conditions.runtime, 'Running');
  assert.equal(conditions.context, `${active.tokens.toLocaleString()} tokens · large`);
  assert.equal(conditions.cache, 'Warm (estimated)');
  assert.equal(conditions.quota, 'Quota limited');
  assert.equal(conditions.attention, 'Permission requested · Brief staged');
  const unknown = steerConditions(steer('b', {
    state: 'unknown', liveStatus: null, tokens: null, warmth: 'unknown', headerFacts: [], large: false, limited: false,
  }));
  assert.equal(unknown.runtime, 'Unknown');
  assert.equal(unknown.context, 'Context unknown');
  assert.equal(unknown.cache, 'Cache unknown');
  assert.equal(unknown.quota, 'Quota unknown');
  const quotaRows = [{ usedPct: 35.2, stale: false }, { usedPct: 79.9, stale: false }];
  assert.equal(steerConditions(steer('a', { limited: false, quotaRows })).quota, '80% used');
  assert.equal(steerConditions(steer('a', { limited: false, quotaRows: [...quotaRows, { usedPct: 99, stale: true }] })).quota,
    'Awaiting quota update');
});

test('a namespaced steer model takes its display name from the provider catalog', () => {
  const catalog = [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }];
  assert.equal(steerModelName('anthropic/claude-opus-5-5', catalog), 'Opus 5.5');
  assert.equal(steerModelName('anthropic/claude-opus-5-5', [...catalog,
    { id: 'anthropic/claude-opus-5-5', label: 'Hosted Opus' }]), 'Hosted Opus');
  assert.equal(steerModelName('arbitrary/model', catalog), 'arbitrary/model');
});

test('handover names the live model, thinking and ZeroSub account', () => {
  const catalog = [{ id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', defaultThinkingOptionId: 'high',
    thinkingOptions: [{ id: 'high', label: 'High' }] }];
  assert.equal(handoverRouteLabel({ model: 'openai/gpt-6.2-sol', thinking: 'high', accountAlias: 'Subscription 2' }, catalog),
    'GPT-6.2 Sol, High, ZeroSub Subscription 2');
  assert.equal(handoverRouteLabel({ model: 'gpt-6.2-sol', thinking: null }, catalog),
    'GPT-6.2 Sol, High, ZeroSub account unknown');
  assert.equal(handoverRouteLabel({ model: null, thinking: null }), 'Model unknown, Default thinking, ZeroSub account unknown');
});

test('attention preserves the affected steer and metrics only count observed work', () => {
  const active = steer('a', { active: true });
  const recovering = steer('b', { slot: 'B', state: 'needs-resume', permissionNeeded: false, stagedBrief: false,
    detail: 'Last reply failed · recovery pending' });
  const pending = pendingWorkspaceWork({
    openWorkers: [{ id: 'registered', state: 'blocked' }],
    pendingWorkerWakeCount: 2,
    workers: [{ id: 'registered', status: 'running' }, { id: 'unregistered', status: 'running' }],
  }, [active, recovering]);
  assert.equal(pending.workerCount, 2);
  assert.equal(pending.workerRunning, 1);
  assert.deepEqual(pending.workerItems, ['Blocked workers (1)', 'Worker updates queued (2)']);
  assert.equal(pending.operationCount, 5);
  assert.deepEqual(pending.steerItems.map(({ kind, steer: row }) => [kind, row.agentId]),
    [['permission', 'a'], ['brief', 'a'], ['recovery', 'b']]);
  assert.equal(pending.steerItems[2].detail, recovering.detail);
  assert.equal(pendingWorkspaceWork(undefined, [active]).operationCount, null);
  assert.equal(pendingWorkspaceWork(undefined, []).workerCount, null);
});

test('reset and recovery can both be available while preserving the menu guards', () => {
  const idle = { liveStatus: 'idle', state: 'warm', permissionNeeded: false, limited: false };
  assert.deepEqual(steerActionEligibility(steer('a', idle)), { reset: null, resume: 'No recovery pending' });
  const recovery = { ...idle, state: 'needs-resume' };
  assert.deepEqual(steerActionEligibility(steer('b', recovery)), { reset: null, resume: null });
  const permission = steerActionEligibility(steer('b', { ...recovery, permissionNeeded: true }));
  assert.match(permission.reset, /permission/);
  assert.equal(permission.resume, permission.reset);
  assert.deepEqual(steerActionEligibility(steer('b', { ...recovery, limited: true })), {
    reset: null, resume: 'Quota depleted',
  });
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


test('the overview shows checkpoint tests and blockers without expanding a control', () => {
  const source = readFileSync(new URL('../client/factory-workspace-status.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Checkpoint details|showCheckpoint/);
  assert.match(source, /\{checkpoint \? \([\s\S]*?checkpointConfidence[\s\S]*?tests\.map[\s\S]*?blockers\.map/);
});
