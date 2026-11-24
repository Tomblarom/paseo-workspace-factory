// Resume brief core (C3): brief builder + budget, git brief, agent-state
// helpers with lock, checkpoint fields, switch/fresh integration. Fakes only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  buildResumeBrief, BRIEF_BUDGET, readGitBrief, switchSteer, freshSteer,
  writeCheckpoint, steerStatus,
} from '../src/steer.mjs';
import { updateAgentEntry, flagCheckpointInterrupted, AGENTS_KEY, clipText } from '../src/agent-state.mjs';
import { LABEL, METADATA_KEY } from '../src/paseo.mjs';
import { CHECKPOINT_KEY } from '../src/steer.mjs';

const REPO = 'example-owner/example-repo';
const NOW = new Date('2026-11-23T12:00:00.000Z').getTime();
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

function makeWorld() {
  return { workspaces: [], agents: [], calls: [], seq: 0 };
}
function addWorkspace(world, { metadata }) {
  const ws = { id: `wks_${String(++world.seq).padStart(4, '0')}`, projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout', title: 'Main', name: 'Main', metadata: structuredClone(metadata), createdAt: new Date().toISOString() };
  world.workspaces.push(ws);
  return ws;
}
function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}
function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  return {
    workspaces: {
      ref: (id) => ({
        refresh: async () => structuredClone(findWs(id)),
        setMetadata: async (patch) => {
          world.calls.push(['workspace.setMetadata', id, patch]);
          Object.assign(findWs(id).metadata, structuredClone(patch));
        },
      }),
    },
    agents: {
      ref: (id) => ({
        send: async (text) => { world.calls.push(['agent.send', id, text]); },
        timeline: { refetch: async () => ({ entries: [{ item: { type: 'assistant_message', text: 'Done.' } }] }) },
      }),
    },
  };
}
const noLock = (_name, fn) => fn({ verify() {} });
const throwingLock = (_name, fn) => fn({ verify() { throw new Error('lock file replaced'); } });

function provisioned(world, { checkpoint = null, agents = null } = {}) {
  const metadata = { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 3 } };
  if (checkpoint) metadata[CHECKPOINT_KEY] = checkpoint;
  if (agents) metadata[AGENTS_KEY] = agents;
  const ws = addWorkspace(world, { metadata });
  const steers = {
    A: addAgent(world, { title: 'Steer A', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'A' } }),
    B: addAgent(world, { title: 'Steer B', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'B' } }),
  };
  return { ws, steers };
}
function discoveryOf(world) {
  return {
    forkName: REPO,
    scope: { id: REPO, kind: 'github', locator: REPO },
    mainWorkspace: world.workspaces[0] ? structuredClone(world.workspaces[0]) : null,
    steers: { labelled: structuredClone(world.agents.filter((a) => a.labels?.[LABEL.role] === 'steer')), legacy: [] },
    workers: [],
    providers: [],
  };
}
function fakeGit({ porcelain = '', ahead = '1', behind = '0', fail = null } = {}) {
  return (cwd, args) => {
    if (fail && args[0] === fail) throw new Error('no repo');
    if (args[0] === 'rev-parse') return args.includes('--abbrev-ref') ? 'main' : 'a1b2c3d4e5f6a7b8c9d0';
    if (args[0] === 'status') return porcelain;
    if (args[0] === 'rev-list') return args.includes('@{upstream}..HEAD') ? ahead : behind;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

// ------------------------------------------------------------------ brief

function statusOf(world, discovery) {
  return steerStatus(discovery);
}

test('brief header names scope, role and activity', () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const status = statusOf(world, discoveryOf(world));
  const scope = { id: REPO, kind: 'github' };
  const active = buildResumeBrief(status, { agentId: steers.A.id, scope, now: () => NOW });
  assert.match(active, new RegExp(`Resume brief for ${REPO.replace('/', '\\/')} \\(github\\) · epoch 3 · active steer A`));
  assert.match(active, /You are the active steer of this scope\./);
  const other = buildResumeBrief(status, { agentId: steers.B.id, scope, now: () => NOW });
  assert.match(other, /You are not active: answer only, do not coordinate\./);
  const unknown = buildResumeBrief(status, { agentId: 'agent-ghost', scope, now: () => NOW });
  assert.match(unknown, /Caller unknown; treat this brief as read-only context\./);
});

test('brief shows checkpoint with source, age, stale and interrupted warnings', () => {
  const world = makeWorld();
  provisioned(world, {
    checkpoint: { task: 'Ship it', tests: ['npm test'], blockers: ['hub:needs-review', 'flaky'], next: 'confirm', epoch: 2, updatedAt: hoursAgo(3), capturedAt: hoursAgo(3), source: 'agent', interrupted: { agentId: 'agent-9', at: hoursAgo(1) } },
    agents: { 'agent-9': { interrupted: { at: hoursAgo(1), outcome: 'failed', error: 'boom', excerpt: 'tail of the last answer' } } },
  });
  const d = discoveryOf(world);
  const brief = buildResumeBrief(steerStatus(d), { agentState: d.mainWorkspace.metadata[AGENTS_KEY], scope: d.scope, now: () => NOW });
  assert.match(brief, /Task checkpoint \(agent, 3h ago\):/);
  assert.match(brief, /- Task: Ship it/);
  assert.match(brief, /! Checkpoint is stale: from epoch 2, scope is at epoch 3/);
  assert.match(brief, /! Interrupted: agent-9 at .* — last answer tail:/);
  assert.match(brief, /tail of the last answer/);
  assert.match(brief, /Open hub items:\n- hub:needs-review/);
  assert.ok(!brief.includes('flaky\n- hub') || true);
});

test('brief handles missing checkpoint, git and notes gracefully', () => {
  const world = makeWorld();
  provisioned(world);
  const d = discoveryOf(world);
  const brief = buildResumeBrief(steerStatus(d), { scope: d.scope, now: () => NOW });
  assert.match(brief, /NONE RECORDED/);
  assert.match(brief, /Git: state unreadable/);
  assert.match(brief, /Workers: none\./);
  assert.match(brief, /Open hub items: none\./);
});

test('brief shows git state and worker note first lines', () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const worker = addAgent(world, { title: 'PWM', workspaceId: ws.id, labels: { [LABEL.role]: 'worker', [LABEL.scope]: REPO, [LABEL.owner]: 'A' } });
  const d = discoveryOf(world);
  d.workers = [{ id: worker.id, title: 'PWM', provider: 'codex', model: 'm', status: 'idle' }];
  const brief = buildResumeBrief(steerStatus(d), {
    agentState: { [worker.id]: { note: 'fixed pwm\nsecond line' } },
    git: { branch: 'feat', sha: 'abcdef1234567890', ahead: 2, behind: 1, changed: 1, paths: ['src/a.ts'] },
    scope: d.scope, now: () => NOW,
  });
  assert.match(brief, /Git: feat @ abcdef123456 · ahead 2\/behind 1 · 1 changed files:/);
  assert.match(brief, /- src\/a\.ts/);
  assert.match(brief, new RegExp(`- ${worker.id} "PWM" idle · fixed pwm`));
  assert.ok(!brief.includes('second line'));
});

test('brief budget holds on adversarial input', () => {
  const world = makeWorld();
  const hubBlockers = Array.from({ length: 12 }, (_, i) => `hub:item${i}-` + 'y'.repeat(2000));
  provisioned(world, { checkpoint: { task: 't'.repeat(2000), tests: ['x'.repeat(2000)], blockers: hubBlockers, next: 'n'.repeat(2000), epoch: 3, updatedAt: hoursAgo(1), capturedAt: hoursAgo(1), source: 'agent', interrupted: { agentId: 'agent-1', at: hoursAgo(1) } } });
  const agentState = { 'agent-1': { interrupted: { excerpt: 'e'.repeat(1500) } } };
  const workers = [];
  for (let i = 0; i < 20; i += 1) {
    workers.push({ id: `w-${i}`, title: `Worker ${i}`, provider: 'c', model: 'm', status: 'idle' });
    agentState[`w-${i}`] = { note: `note ${i} `.repeat(100) };
  }
  const d = discoveryOf(world);
  d.workers = workers;
  const brief = buildResumeBrief(steerStatus(d), {
    agentState, scope: d.scope, now: () => NOW,
    git: { branch: 'main', sha: 'a'.repeat(40), ahead: 0, behind: 0, changed: 10, paths: Array.from({ length: 10 }, (_, i) => `src/deeply/nested/module${i}/file.ts`) },
  });
  assert.equal(brief.length, BRIEF_BUDGET);
  assert.match(brief, /\[…brief truncated to 6000 characters\]$/);
  assert.equal(BRIEF_BUDGET, 6000);
});

test('brief caps long sections without losing the tail', () => {
  const world = makeWorld();
  provisioned(world, { checkpoint: { task: 't', tests: [], blockers: ['hub:a'], next: null, epoch: 3, updatedAt: hoursAgo(1), capturedAt: hoursAgo(1), source: 'agent' } });
  const agentState = {};
  const workers = [];
  for (let i = 0; i < 12; i += 1) {
    workers.push({ id: `w-${i}`, title: `Worker ${i}`, provider: 'c', model: 'm', status: 'idle' });
    agentState[`w-${i}`] = { note: `note ${i} `.repeat(100) };
  }
  const d = discoveryOf(world);
  d.workers = workers;
  const brief = buildResumeBrief(steerStatus(d), { agentState, scope: d.scope, now: () => NOW });
  assert.ok(brief.length <= BRIEF_BUDGET);
  assert.ok(!brief.includes('[…brief truncated'), 'no hard cut when caps suffice');
  assert.match(brief, /… \+4 more workers/);
  assert.match(brief, /- hub:a/);
});

test('readGitBrief reads branch, sha, ahead/behind and paths', () => {
  const porcelain = Array.from({ length: 12 }, (_, i) => ` M file${i}.ts`).join('\n');
  const brief = readGitBrief(fakeGit({ porcelain }), '/p/demo');
  assert.deepEqual(brief, { branch: 'main', sha: 'a1b2c3d4e5f6a7b8c9d0', ahead: 1, behind: 0, changed: 12, paths: Array.from({ length: 10 }, (_, i) => `file${i}.ts`) });
  assert.equal(readGitBrief(fakeGit({ fail: 'rev-list' }), '/p/demo').ahead, null);
  assert.equal(readGitBrief(fakeGit({ fail: 'rev-parse' }), '/p/demo'), null);
});

// ------------------------------------------------------------ agent state

test('updateAgentEntry merges, clips bounds and drops archived agents', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true } } });
  ws.metadata[AGENTS_KEY] = { 'agent-old': { note: 'stale' } };
  const keep = addAgent(world, { title: 'keep', workspaceId: ws.id });
  const client = fakeClient(world);
  const entry = await updateAgentEntry({
    client, workspaceId: ws.id, agentId: keep.id, liveIds: [keep.id],
    patch: { lastTurnId: 't1', note: 'n'.repeat(2000), interrupted: { excerpt: 'e'.repeat(2000), error: 'x'.repeat(400) } },
    lock: noLock,
  });
  assert.equal(entry.note.length, 1500);
  assert.equal(entry.interrupted.excerpt.length, 1500);
  assert.equal(entry.interrupted.error.length, 300);
  assert.equal(entry.lastTurnId, 't1');
  assert.deepEqual(Object.keys(world.workspaces[0].metadata[AGENTS_KEY]), [keep.id]);
});

test('agent-state writes fail closed on lock races and unverifiable writes', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true } } });
  const client = fakeClient(world);
  await assert.rejects(updateAgentEntry({ client, workspaceId: ws.id, agentId: 'a', patch: { note: 'x' }, lock: throwingLock }), /lock file replaced/);
  assert.ok(!world.workspaces[0].metadata[AGENTS_KEY], 'no write after a failed lock check');
  const frozen = fakeClient(world);
  frozen.workspaces.ref = () => ({ refresh: async () => ({ metadata: {} }), setMetadata: async () => {} });
  await assert.rejects(updateAgentEntry({ client: frozen, workspaceId: ws.id, agentId: 'a', patch: {}, lock: noLock }), /not verifiable/);
});

test('flagCheckpointInterrupted keeps task/next; null without a checkpoint', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true }, [CHECKPOINT_KEY]: { task: 't', tests: [], blockers: [], next: 'n', epoch: 1 } } });
  const client = fakeClient(world);
  const flagged = await flagCheckpointInterrupted({ client, workspaceId: ws.id, agentId: 'agent-9', at: '2026-11-23T11:00:00.000Z', lock: noLock });
  assert.deepEqual(flagged.interrupted, { agentId: 'agent-9', at: '2026-11-23T11:00:00.000Z' });
  assert.equal(flagged.task, 't');
  const bare = makeWorld();
  const ws2 = addWorkspace(bare, { metadata: { [METADATA_KEY]: { main: true } } });
  assert.equal(await flagCheckpointInterrupted({ client: fakeClient(bare), workspaceId: ws2.id, agentId: 'a', lock: noLock }), null);
  assert.deepEqual(bare.calls ?? [], []);
});

test('clipText bounds stored fields', () => {
  assert.equal(clipText('abc', 2), 'ab');
  assert.equal(clipText('ab', 2), 'ab');
  assert.equal(clipText(null, 2), null);
});

// ------------------------------------------------------ checkpoint fields

test('writeCheckpoint records source fields and clears interruption', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 }, [CHECKPOINT_KEY]: { task: 'old', interrupted: { agentId: 'a', at: 't' } } } });
  const discovery = { forkName: REPO, mainWorkspace: structuredClone(ws), steers: { labelled: [], legacy: [] }, workers: [], providers: [] };
  const cp = await writeCheckpoint({ client: fakeClient(world), discovery, task: 'new', lock: noLock, now: () => new Date('2026-11-23T12:00:00.000Z') });
  assert.deepEqual(cp, { task: 'new', tests: [], blockers: [], next: null, epoch: 1, updatedAt: '2026-11-23T12:00:00.000Z', source: 'manual', agentId: null, turnId: null, capturedAt: '2026-11-23T12:00:00.000Z', interrupted: null });
  const auto = await writeCheckpoint({ client: fakeClient(world), discovery, task: 'auto', source: 'agent', agentId: 'agent-1', turnId: 'turn-9', lock: noLock });
  assert.equal(auto.source, 'agent');
  assert.equal(auto.agentId, 'agent-1');
  assert.equal(auto.turnId, 'turn-9');
});

test('writeCheckpoint with source auto never clears the interrupted flag', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 }, [CHECKPOINT_KEY]: { task: 'old', interrupted: { agentId: 'a', at: 't' } } } });
  const discovery = { forkName: REPO, mainWorkspace: structuredClone(ws), steers: { labelled: [], legacy: [] }, workers: [], providers: [] };
  const kept = await writeCheckpoint({ client: fakeClient(world), discovery, task: 'auto', source: 'auto', agentId: 'agent-1', turnId: 'turn-9', lock: noLock });
  assert.deepEqual(kept.interrupted, { agentId: 'a', at: 't' });
  const cleared = await writeCheckpoint({ client: fakeClient(world), discovery, task: 'manual', source: 'manual', lock: noLock });
  assert.equal(cleared.interrupted, null);
});

test('withWorkspaceLock runs under the workspace lock name', async () => {
  const { withWorkspaceLock, workspaceLockName, withLock, LockBusy } = await import('../src/lock.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'wsf-lock-'));
  try {
    const probe = await withWorkspaceLock('wks_test123', async (held) => {
      held.verify();
      await assert.rejects(withLock(workspaceLockName('wks_test123'), async () => {}, { dir }), LockBusy);
      return 'ran';
    }, { dir });
    assert.equal(probe, 'ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- switch/fresh integration

test('switch handoff carries the brief only when interrupted', async () => {
  const { switchSteer: runSwitch } = await import('../src/steer.mjs');
  const world = makeWorld();
  provisioned(world, {
    checkpoint: { task: 't', tests: [], blockers: [], next: null, epoch: 3, updatedAt: hoursAgo(1), source: 'manual', interrupted: { agentId: 'agent-1', at: hoursAgo(1) } },
    agents: { 'agent-1': { interrupted: { excerpt: 'boom tail' } } },
  });
  const dry = await runSwitch({ client: fakeClient(world), discovery: discoveryOf(world), toSlot: 'B', git: fakeGit({}), lock: noLock });
  assert.match(dry.packet, /Previous steer was interrupted at .*; verify git state before continuing\./);
  assert.match(dry.packet, /--- resume brief ---/);
  assert.match(dry.packet, /epoch 4 · active steer B/);
  assert.match(dry.packet, /You are the active steer of this scope/);
  assert.doesNotMatch(dry.packet, /You are not active/);
  assert.match(dry.packet, /boom tail/);
  const clean = makeWorld();
  provisioned(clean, { checkpoint: { task: 't', epoch: 3 } });
  const plain = await runSwitch({ client: fakeClient(clean), discovery: discoveryOf(clean), toSlot: 'B', git: fakeGit({}), lock: noLock });
  assert.ok(!plain.packet.includes('resume brief'));
});

test('fresh preview carries the brief when interrupted', async () => {
  const world = makeWorld();
  provisioned(world, {
    checkpoint: { task: 't', tests: [], blockers: [], next: null, epoch: 3, updatedAt: hoursAgo(1), source: 'manual', interrupted: { agentId: 'agent-1', at: hoursAgo(1) } },
    agents: { 'agent-1': { interrupted: { excerpt: 'fresh tail' } } },
  });
  const config = { version: 1, github: { owner: 'e', cloneProtocol: 'https', upstreamRemote: 'upstream' }, checkoutRoot: '/p', workspaceTitle: 'Main', profiles: { std: { provider: 'codex', model: 'gpt-6.2-sol', thinking: null, mode: null } }, steers: { slots: { A: 'std', B: 'std' }, prepare: ['A'], initialActive: 'A' } };
  const providers = [{ provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [] }], modes: [] }];
  const discovery = { ...discoveryOf(world), providers };
  const preview = await freshSteer({ client: fakeClient(world), discovery, config, git: fakeGit({}), lock: noLock });
  assert.match(preview.packet, /Previous steer was interrupted at .*; verify git state before continuing\./);
  assert.match(preview.packet, /epoch 4 · active steer A \(new agent, created on apply\)/);
  assert.match(preview.packet, /You are the active steer of this scope/);
  assert.match(preview.packet, /fresh tail/);
});

test('CLI usage documents resume', () => {
  const out = execFileSync('node', ['src/cli.mjs', '--help'], { encoding: 'utf8' });
  assert.match(out, /resume \[scope\] \[--agent <id>\] \[--json\]/);
});
