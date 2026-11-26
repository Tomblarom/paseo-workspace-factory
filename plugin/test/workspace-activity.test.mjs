import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./ts-resolve-hooks.mjs', import.meta.url);
const { getWorkspaceActivity, projectWorkspaceActivity, WORKSPACE_ACTIVITY_LIMIT } = await import('../server/workspace-activity.ts');
const { factoryWorkspaceActivity } = await import('../shared/workspace-activity.ts');

const workspaceId = 'wks_main';
const otherWorkspaceId = 'wks_other';
const at = (minute) => new Date(Date.UTC(2026, 10, 26, 20, minute)).toISOString();
const member = (id, workspace = workspaceId) => ({ id, workspaceId: workspace });
const steer = (id, slot, workspace) => ({
  ...member(id, workspace),
  labels: { 'wsf.role': 'steer', 'wsf.slot': slot },
});
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
  }, [steer('local', 'B'), steer('foreign', 'D', otherWorkspaceId), member('wrongScope'), member('wrongTarget'), member('foreignBatch')]);

  assert.equal(projectWorkspaceActivity(otherWorkspaceId, snapshot), null);
  assert.equal(projectWorkspaceActivity(workspaceId, { ...snapshot, workspace: null }), null);
  assert.equal(project({ wsf: null }), null);
  assert.equal(project({ wsf: { main: true, scope: { kind: 'workspace', locator: otherWorkspaceId } } }), null);
  assert.deepEqual(projectWorkspaceActivity(workspaceId, snapshot), {
    kind: 'recent-recorded-activity',
    events: [{ kind: 'delivery', state: 'delivered', reason: 'dispatch-acknowledged', observedAt: at(2), participant: 'Steer B' }],
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
    { kind: 'worker-wake', state: 'pending', reason: 'worker-completed', observedAt: at(4), participant: 'Worker' },
    { kind: 'worker-wake', state: 'recorded', reason: 'wake-recorded', observedAt: at(3), participant: 'Worker' },
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
    { kind: 'holder-change', state: 'recorded', reason: 'slot-changed', observedAt: null, from: 'Steer A', participant: 'Steer B' },
    { kind: 'delivery', state: 'uncertain', reason: 'delivery-unconfirmed', observedAt: null },
    { kind: 'delivery', state: 'blocked', reason: 'delivery-blocked', observedAt: null, renewal: 'rewind' },
    { kind: 'delivery', state: 'delivered', reason: 'dispatch-acknowledged', observedAt: null },
    { kind: 'worker-wake', state: 'pending', reason: 'worker-completed', observedAt: null, participant: 'Worker' },
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
    { kind: 'holder-change', state: 'recorded', reason: 'holder-replaced', observedAt: at(2), participant: 'Steer B' },
    { kind: 'worker-wake', state: 'pending', reason: 'worker-update', observedAt: null, participant: 'Worker' },
  ]);
  assert.equal(JSON.stringify(view).includes(sentinel), false);
});

test('groups a switch with the action reserved at its commit, even with an intervening event', () => {
  const action = { kind: 'activate', epoch: 5, phase: 'uncertain', queuedAt: at(2), attemptedAt: at(4) };
  const metadata = {
    wsf: { main: true, epoch: 5, activeSteer: 'B', activeAgentId: 'local', previousSteer: 'A', switchedAt: at(2) },
    'wsf.agents': { local: { action }, nearby: { action: { ...action, kind: 'switch' } } },
    'wsf.workers': { worker: { lastWakeAt: at(3) } },
  };
  const agents = [steer('local', 'B'), steer('nearby', 'C'), member('worker')];
  const events = project(metadata, agents).events;
  const group = { kind: 'holder-change', index: 0 };
  assert.deepEqual(events.map((event) => [event.kind, event.participant, event.group]), [
    ['delivery', 'Steer B', group],
    ['delivery', 'Steer C', undefined],
    ['worker-wake', 'Worker', undefined],
    ['holder-change', 'Steer B', group],
  ]);
  assert.equal(events[0].state, 'uncertain');
  assert.equal(events[3].from, 'Steer A');

  for (const patch of [{ epoch: 4 }, { queuedAt: at(1) }, { kind: 'delivery' }]) {
    metadata['wsf.agents'].local.action = { ...action, ...patch };
    assert.ok(project(metadata, agents).events.every((event) => !event.group));
  }
});

test('groups only the exact replacement and its authority-bound Fresh brief', () => {
  const brief = { kind: 'fresh-delivery', phase: 'done', epoch: 5, observedAt: at(4) };
  const metadata = {
    wsf: { main: true, epoch: 5, activeSteer: 'B', activeAgentId: 'replacement', previousSteer: 'retired', switchedAt: at(3) },
    'wsf.agents': {
      replacement: { action: { ...brief, authority: { agentId: 'replacement' } } },
      other: { action: brief },
    },
  };
  const agents = [
    steer('retired', 'B', otherWorkspaceId),
    { ...steer('replacement', 'B'), createdAt: at(2) },
    { ...steer('other', 'B'), createdAt: at(2) },
  ];
  const events = project(metadata, agents).events;
  const group = { kind: 'holder-change', index: 1 };
  assert.deepEqual(events.map((event) => [event.kind, event.group]), [
    ['delivery', undefined], ['delivery', group], ['holder-change', group], ['creation', undefined], ['creation', group],
  ]);
  assert.equal(events[2].from, undefined);
});

test('groups recovery by its saved reference and rewind by the acknowledged brief ID', () => {
  const action = {
    kind: 'delivery', phase: 'sent', renewal: 'rewind', wakeId: 'brief-ref', needsResumeAt: at(1), observedAt: at(4),
    facts: {
      cleared: { mode: 'rewind', at: at(3) },
      refreshed: { mode: 'rewind', at: at(3), briefMessageId: 'brief-ref' },
    },
  };
  const metadata = {
    'wsf.agents': { target: { action, needsResume: { reason: 'daemon-restart', at: at(1) } } },
  };
  const agents = [steer('target', 'B')];
  const events = project(metadata, agents).events;
  assert.deepEqual(events.map(({ reason, group }) => [reason, group]), [
    ['dispatch-acknowledged', { kind: 'recovery', index: 0 }],
    ['context-rewound', { kind: 'recovery', index: 0 }],
    ['daemon-restart', { kind: 'recovery', index: 0 }],
  ]);
  assert.equal(JSON.stringify(events).includes('brief-ref'), false);
  action.needsResumeAt = at(0);
  action.wakeId = 'different-brief';
  action.queuedAt = at(3);
  assert.ok(project(metadata, agents).events.every((event) => !event.group));
});

test('projects takeover cause and grouped rewind attempts without confirming delivery', () => {
  const secret = 'sensitive-pool-name';
  const reason = `quota exhausted for pool (${secret})`;
  const action = {
    phase: 'blocked', renewal: 'rewind', queuedAt: at(2), observedAt: at(5),
    rewindAttempt: { at: at(3), phase: 'uncertain' },
    batch: { workspaceId, epoch: 4, takeover: { scopeId: 'Main', activeSlot: 'A', reason } },
  };
  const metadata = {
    'wsf.checkpoint': { source: 'failover', epoch: 4, updatedAt: at(5), failover: { previousSteer: 'A', reason }, task: secret },
    'wsf.agents': { target: { action } },
  };
  const agents = [steer('target', 'B')];
  const events = project(metadata, agents).events;
  const group = { kind: 'takeover-request', index: 1 };
  assert.deepEqual(events, [
    { kind: 'takeover-request', state: 'recorded', reason: 'takeover-recorded', observedAt: at(5), from: 'Steer A', cause: 'quota-exhausted' },
    { kind: 'renewal', state: 'uncertain', reason: 'renewal-unconfirmed', observedAt: at(3), participant: 'Steer B', group },
    { kind: 'takeover-request', state: 'blocked', reason: 'delivery-blocked', observedAt: null, participant: 'Steer B', from: 'Steer A',
      cause: 'quota-exhausted', renewal: 'rewind', group },
  ]);
  assert.equal(JSON.stringify(events).includes(secret), false);

  action.phase = 'uncertain';
  action.attemptedAt = at(4);
  assert.deepEqual(project(metadata, agents).events.map(({ reason }) => reason), ['takeover-recorded', 'delivery-unconfirmed']);
  action.phase = 'done';
  assert.deepEqual(project(metadata, agents).events.map(({ reason }) => reason), ['dispatch-acknowledged']);
  action.batch.epoch = 3;
  assert.deepEqual(project(metadata, agents).events.map(({ reason }) => reason), ['dispatch-acknowledged', 'takeover-recorded']);
  action.batch.workspaceId = otherWorkspaceId;
  assert.deepEqual(project(metadata, agents).events.map(({ reason }) => reason), ['takeover-recorded']);
});

test('leaves a verified clear ungrouped when its receipt cannot identify the delivery', () => {
  const action = {
    phase: 'sent', renewal: 'clear', observedAt: at(4), attemptedAt: at(3), queuedAt: at(1),
    facts: { actionVerified: true, cleared: { mode: 'clear', at: at(2), sessionId: 'private-session' } },
  };
  const events = project({ 'wsf.agents': { target: { action } } }, [steer('target', 'private label')]).events;
  assert.deepEqual(events, [
    { kind: 'delivery', state: 'delivered', reason: 'dispatch-acknowledged', observedAt: at(4), participant: 'Steer', renewal: 'clear' },
    { kind: 'renewal', state: 'confirmed', reason: 'context-cleared', observedAt: at(2), participant: 'Steer' },
  ]);
});

test('links a clear reservation nested in the delivery and omits its private fields', () => {
  const action = {
    phase: 'renewing', renewal: 'clear', queuedAt: at(1),
    cleanup: { kind: 'clear', reason: 'resume', at: at(2), messageId: 'private-clear-id', sessionId: 'private-session' },
  };
  const metadata = { 'wsf.agents': { target: { action } } };
  const agents = [steer('target', 'B')];
  const group = { kind: 'renewal', index: 0 };
  const events = project(metadata, agents).events;
  assert.deepEqual(events.map(({ reason, group }) => [reason, group]), [
    ['clear-reserved', group], ['waiting-for-renewal', group],
  ]);
  assert.equal(JSON.stringify(events).includes('private-'), false);

  action.cleanup.uncertain = true;
  assert.deepEqual(project(metadata, agents).events.map(({ state }) => state), ['uncertain', 'pending']);
  action.cleanup.reason = 'idle';
  assert.deepEqual(project(metadata, agents).events.map(({ reason }) => reason), ['waiting-for-renewal']);
});

test('assignment labels require exact workspace membership and use the recorded report target', () => {
  const assignment = { by: 'requester', at: at(1), requesterWorkspaceId: otherWorkspaceId };
  const metadata = { 'wsf.assignment': assignment };
  const agents = [steer('requester', 'A'), steer('target', 'B')];
  assert.equal(project(metadata, agents).events[0].from, undefined);
  assignment.requesterWorkspaceId = workspaceId;
  assert.equal(project(metadata, agents).events[0].from, 'Steer A');
  assignment.reportedAt = at(2);
  assignment.reportTarget = { workspaceId, agentId: 'target' };
  const [report] = project(metadata, agents).events;
  assert.equal(report.participant, 'Steer B');
  assert.equal(report.from, undefined);
  assignment.reportTarget.workspaceId = otherWorkspaceId;
  assert.equal(project(metadata, agents).events[0].participant, undefined);
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

test('applies the event cap before surfacing any group and keeps the contract bounded', () => {
  const metadata = {
    'wsf.agents': {
      target: {
        needsResume: { reason: 'failed', at: at(0) },
        action: { kind: 'delivery', needsResumeAt: at(0), phase: 'sent', observedAt: at(30) },
      },
    },
    'wsf.workers': Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`worker-${i}`, { lastWakeAt: at(i + 1) }])),
  };
  const agents = [member('target'), ...Object.keys(metadata['wsf.workers']).map((id) => member(id))];
  const activity = project(metadata, agents);
  assert.equal(activity.events.length, 20);
  assert.ok(activity.events.every((event) => !event.group));
  const payload = { workspaceId, ...activity };
  assert.deepEqual(factoryWorkspaceActivity.output.parse(payload), payload);
  assert.equal(factoryWorkspaceActivity.output.safeParse({ ...payload, events: [...payload.events, payload.events[0]] }).success, false);
  assert.equal(factoryWorkspaceActivity.output.safeParse({
    ...payload, events: [{ ...payload.events[0], participant: 'Steer A\n' }],
  }).success, false);
});

test('the activity RPC reads the exact workspace and native creation timestamps without writing', async () => {
  const { workspace } = observation({ 'wsf.workers': { worker: { state: 'done' } } });
  const agents = [
    { ...member('worker'), createdAt: at(1), archivedAt: at(3) },
    { ...member('steer'), createdAt: at(2), labels: { 'wsf.role': 'steer' } },
    { ...member('unrelated'), createdAt: at(3) },
    { ...member('foreign', otherWorkspaceId), createdAt: at(4), labels: { 'wsf.role': 'steer' } },
  ];
  const paseo = {
    workspaces: { ref: (id) => ({ refresh: async () => id === workspaceId ? workspace : null }) },
    agents: { list: async ({ filter }) => {
      assert.equal(filter.includeArchived, true);
      return { entries: agents.map((agent) => ({ agent })) };
    } },
  };
  assert.deepEqual(await getWorkspaceActivity({ workspaceId }, { paseo }), {
    workspaceId,
    kind: 'recent-recorded-activity',
    events: [
      { kind: 'creation', state: 'recorded', reason: 'steer-created', observedAt: at(2), participant: 'Steer' },
      { kind: 'creation', state: 'recorded', reason: 'worker-created', observedAt: at(1), participant: 'Worker' },
    ],
  });
  await assert.rejects(getWorkspaceActivity({ workspaceId: otherWorkspaceId }, { paseo }), /enrolled Factory workspace/);
});
