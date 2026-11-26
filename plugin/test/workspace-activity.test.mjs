import assert from 'node:assert/strict';
import test from 'node:test';

import { projectWorkspaceActivity, WORKSPACE_ACTIVITY_LIMIT } from '../server/workspace-activity.ts';

const workspaceId = 'wks_main';
const otherWorkspaceId = 'wks_other';
const at = (minute) => new Date(Date.UTC(2026, 10, 26, 20, minute)).toISOString();
const member = (id, workspace = workspaceId) => ({ id, workspaceId: workspace });
const observation = (metadata = {}, agents = []) => ({
  workspace: {
    id: workspaceId,
    metadata: {
      wsf: { main: true, epoch: 5, activeSteer: 'B', scope: { kind: 'workspace', id: 'Main', locator: workspaceId } },
      ...metadata,
    },
  },
  agents,
});
const project = (metadata, agents) => projectWorkspaceActivity(workspaceId, observation(metadata, agents));

test('projects only the exact Factory workspace and its verified agent membership', () => {
  const delivery = { kind: 'delivery', phase: 'sent', observedAt: at(2) };
  const snapshot = observation({
    'wsf.agents': {
      local: { action: { ...delivery, authority: { agentId: 'local', scopeId: 'main' } } },
      foreign: { action: { ...delivery, observedAt: at(3) } },
      unknown: { action: { ...delivery, observedAt: at(4) } },
      wrongScope: { action: { ...delivery, authority: { agentId: 'wrongScope', scopeId: 'Other' }, observedAt: at(5) } },
      wrongTarget: { action: { ...delivery, authority: { agentId: 'foreign', scopeId: 'Main' }, observedAt: at(6) } },
      foreignBatch: { action: { ...delivery, batch: { workspaceId: otherWorkspaceId }, observedAt: at(7) } },
    },
    'wsf.workers': { foreign: { state: 'done', pendingWake: { state: 'done', queuedAt: at(8) } } },
  }, [member('local'), member('foreign', otherWorkspaceId), member('wrongScope'), member('wrongTarget'), member('foreignBatch')]);

  assert.equal(projectWorkspaceActivity(otherWorkspaceId, snapshot), null);
  assert.equal(projectWorkspaceActivity(workspaceId, { ...snapshot, workspace: null }), null);
  assert.equal(project({ wsf: null }), null);
  assert.equal(project({ wsf: { main: true, scope: { kind: 'workspace', locator: otherWorkspaceId } } }), null);
  assert.deepEqual(projectWorkspaceActivity(workspaceId, snapshot), {
    kind: 'recent-recorded-activity',
    events: [{ kind: 'delivery', state: 'delivered', reason: 'dispatch-acknowledged', observedAt: at(2) }],
  });
});

test('keeps send attempts uncertain until the delivery phase records acknowledgment', () => {
  const action = { kind: 'activate', phase: 'uncertain', epoch: 4, queuedAt: at(1), attemptedAt: at(2), observedAt: at(3) };
  const metadata = { 'wsf.agents': { steer: { action } } };
  const snapshot = structuredClone(metadata);
  assert.deepEqual(project(metadata, [member('steer')]).events, [
    { kind: 'delivery', state: 'uncertain', reason: 'delivery-unconfirmed', observedAt: at(2) },
  ]);
  assert.deepEqual(metadata, snapshot);
  action.phase = 'blocked';
  assert.deepEqual(project(metadata, [member('steer')]).events, [
    { kind: 'delivery', state: 'uncertain', reason: 'delivery-blocked-after-attempt', observedAt: at(2) },
  ]);
  action.phase = 'done';
  assert.deepEqual(project(metadata, [member('steer')]).events, [
    { kind: 'delivery', state: 'delivered', reason: 'dispatch-acknowledged', observedAt: at(3) },
  ]);
});

test('projects a completed worker with a queued wake from an earlier epoch', () => {
  const metadata = {
    'wsf.workers': {
      completed: { state: 'done', epoch: 4, lastWakeAt: at(1), pendingWake: { state: 'done', queuedAt: at(4) } },
      reported: { state: 'done', epoch: 5, lastWakeAt: at(3), pendingWake: null },
    },
    'wsf.agents': {
      steer: {
        action: { kind: 'delivery', phase: 'done', observedAt: at(5) },
        stagedBrief: { kind: 'stage', phase: 'staged', epoch: 4, queuedAt: at(2) },
      },
    },
  };
  assert.deepEqual(project(metadata, ['completed', 'reported', 'steer'].map((id) => member(id))).events, [
    { kind: 'delivery', state: 'delivered', reason: 'dispatch-acknowledged', observedAt: at(5) },
    { kind: 'worker-wake', state: 'pending', reason: 'worker-completed', observedAt: at(4) },
    { kind: 'worker-wake', state: 'recorded', reason: 'wake-recorded', observedAt: at(3) },
    { kind: 'delivery', state: 'pending', reason: 'brief-staged', observedAt: at(2) },
  ]);
});

test('uses unknown timestamps without substituting a queue time or the current time', () => {
  const metadata = {
    wsf: { main: true, epoch: 5, activeSteer: 'B', previousSteer: 'A', switchedAt: '2026-02-30T20:00:00.000Z' },
    'wsf.agents': {
      blocked: { action: { phase: 'blocked', renewal: 'rewind', queuedAt: at(1) } },
      done: { action: { kind: 'switch', phase: 'done', queuedAt: at(1), attemptedAt: at(2) } },
      attempted: { action: { kind: 'delivery', phase: 'uncertain', queuedAt: at(1), attemptedAt: 'corrupt time' } },
      receiptPointer: { action: { phase: 'done', wakeId: 'older-receipt' } },
    },
    'wsf.workers': { worker: { state: 'done', pendingWake: { state: 'done' }, startedAt: at(0) } },
  };
  assert.deepEqual(project(metadata, Object.keys({ ...metadata['wsf.agents'], ...metadata['wsf.workers'] }).map((id) => member(id))).events, [
    { kind: 'holder-change', state: 'recorded', reason: 'slot-changed', observedAt: null },
    { kind: 'delivery', state: 'uncertain', reason: 'delivery-unconfirmed', observedAt: null },
    { kind: 'delivery', state: 'blocked', reason: 'delivery-blocked', observedAt: null },
    { kind: 'delivery', state: 'delivered', reason: 'dispatch-acknowledged', observedAt: null },
    { kind: 'worker-wake', state: 'pending', reason: 'worker-completed', observedAt: null },
  ]);
});

test('publishes allowlisted fields from the holder, renewal, recovery and assignment records', () => {
  const sentinel = 'secret-sentinel';
  const metadata = {
    wsf: { main: true, epoch: 5, activeSteer: 'B', previousSteer: sentinel, switchedAt: at(2) },
    'wsf.checkpoint': { task: sentinel, next: sentinel, blockers: [sentinel] },
    'wsf.assignment': { by: sentinel, requesterWorkspaceId: sentinel, at: at(1), reportedAt: at(6), report: { text: sentinel } },
    'wsf.agents': {
      steer: {
        needsResume: { reason: 'limit', at: at(7), error: sentinel },
        action: {
          kind: 'delivery', phase: 'uncertain', attemptedAt: at(5), wakeId: sentinel, packet: sentinel, note: sentinel,
          lastError: sentinel, sendOptions: { credentials: sentinel }, reason: sentinel,
          facts: {
            cleared: { mode: 'rewind', at: at(3), sessionId: sentinel },
            refreshed: { mode: 'rewind', at: at(3), messageId: sentinel },
            lastActionFailed: { at: at(4), error: sentinel },
          },
        },
      },
      unverified: { action: { kind: 'memory', facts: { cleared: { mode: 'clear', at: at(3) } } } },
    },
    'wsf.workers': { worker: { state: 'done', task: sentinel, pendingWake: { state: sentinel, queuedAt: sentinel } } },
  };
  const view = project(metadata, ['steer', 'unverified', 'worker'].map((id) => member(id)));
  assert.deepEqual(view.events, [
    { kind: 'recovery', state: 'pending', reason: 'provider-limit', observedAt: at(7) },
    { kind: 'assignment', state: 'delivered', reason: 'assignment-report-delivered', observedAt: at(6) },
    { kind: 'delivery', state: 'uncertain', reason: 'delivery-unconfirmed', observedAt: at(5) },
    { kind: 'renewal', state: 'uncertain', reason: 'renewal-unconfirmed', observedAt: at(4) },
    { kind: 'renewal', state: 'confirmed', reason: 'context-rewound', observedAt: at(3) },
    { kind: 'holder-change', state: 'recorded', reason: 'holder-replaced', observedAt: at(2) },
    { kind: 'worker-wake', state: 'pending', reason: 'worker-update', observedAt: null },
  ]);
  assert.equal(JSON.stringify(view).includes(sentinel), false);
});

test('caps the view at the most recent recorded events', () => {
  const count = WORKSPACE_ACTIVITY_LIMIT + 5;
  const agents = Array.from({ length: count }, (_, index) => member(`worker-${index}`));
  const workers = Object.fromEntries(agents.map(({ id }, index) => [id, { lastWakeAt: at(index) }]));
  const { events } = project({ 'wsf.workers': workers }, agents.reverse());
  assert.equal(events.length, WORKSPACE_ACTIVITY_LIMIT);
  assert.deepEqual(events.map(({ observedAt }) => observedAt),
    Array.from({ length: WORKSPACE_ACTIVITY_LIMIT }, (_, index) => at(count - 1 - index)));
});
