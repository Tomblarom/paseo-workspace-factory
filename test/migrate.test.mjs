// K16a migration tests: dry-run output, backup before the first write,
// conflict skip, fold-equals-lazy-fold, idempotency, archived-agent handling.
// Fakes only; no daemon, no live apply.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LABEL, METADATA_KEY, PARENT_LABEL, readPaseoState } from '../src/paseo.mjs';
import { AGENTS_KEY } from '../src/agent-state.mjs';
import { readSteerAction } from '../src/steer-action.mjs';
import { actionFact, ACTION_FACTS } from '../src/action-facts.mjs';
import { configureRuntime } from '../src/runtime.mjs';
import {
  LEGACY_AGENT_FIELDS, classifyLegacyKey, foldAgentEntry, foldableFields,
  planMigration, formatMigration, migrationEmpty, migrationBackup,
  applyMigration, formatMigrationResult,
} from '../src/migrate.mjs';

// The apply path takes the real workspace lock; keep lock files in a
// throwaway state dir instead of the production one (per-file processes).
configureRuntime({ runtime: { stateDir: mkdtempSync(join(tmpdir(), 'wsf-migrate-')) } });

// ---------------------------------------------------------------- fixtures

function makeWorld() {
  return { projects: [], workspaces: [], agents: [], providers: [], calls: [], seq: 0 };
}

function addWorkspace(world, { metadata, title = 'Main' }) {
  const ws = {
    id: `wks_${String(++world.seq).padStart(4, '0')}`, projectId: 'prj_1',
    workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout', title, name: title,
    metadata: structuredClone(metadata), createdAt: '2026-11-23T00:00:00.000Z',
  };
  world.workspaces.push(ws);
  if (!world.projects.some((p) => p.projectId === ws.projectId)) {
    world.projects.push({ projectId: ws.projectId, projectRootPath: '/p/demo', projectDisplayName: 'demo' });
  }
  return ws;
}

function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}

function listClient(world) {
  const page = (entries) => async () => ({ entries, pageInfo: { hasMore: false } });
  return {
    projects: { list: async () => ({ projects: world.projects }) },
    workspaces: { list: page(world.workspaces) },
    agents: { list: page(world.agents.map((agent) => ({ agent }))) },
    providers: { snapshot: async () => ({ entries: world.providers }) },
  };
}

const stateOf = (world) => readPaseoState(listClient(world));

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  return {
    workspaces: {
      ref: (id) => ({
        refresh: async () => structuredClone(findWs(id)),
        setMetadata: async (patch) => {
          world.calls.push(['workspace.setMetadata', id, structuredClone(patch)]);
          for (const [key, value] of Object.entries(structuredClone(patch))) {
            if (value === null) delete findWs(id).metadata[key];
            else findWs(id).metadata[key] = value;
          }
        },
      }),
    },
    agents: {
      ref: (id) => ({ refresh: async () => ({ agent: structuredClone(findAgent(id)) }) }),
    },
  };
}

function fakePaseoCli(world, { refuseArchived = true } = {}) {
  return (args) => {
    world.calls.push(['paseo', ...args]);
    if (args[0] === 'agent' && args[1] === 'update') {
      const agent = world.agents.find((a) => a.id === args[2]);
      if (!agent) throw new Error(`Agent ${args[2]} is missing`);
      if (agent.archivedAt && refuseArchived) throw new Error(`Agent ${args[2]} is archived`);
      for (const pair of args[4].split(',')) {
        const [k, v] = pair.split('=');
        agent.labels[k] = v;
      }
      return { id: agent.id };
    }
    throw new Error(`unexpected paseo ${args.join(' ')}`);
  };
}

const LEGACY_STATE = { main: true, activeSteer: 'A', epoch: 3 };

// ---------------------------------------------------------------- planning

test('dry-run lists per workspace and agent what would change', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: {
    'ari.wsf': LEGACY_STATE,
    [AGENTS_KEY]: { 'agent-1': { stagedBrief: { packet: 'hello', at: 't' } } },
  } });
  const steer = addAgent(world, {
    provider: 'codex', model: 'm', title: 'Steer A', workspaceId: ws.id,
    labels: { 'ari.wsf.role': 'steer', 'ari.wsf.slot': 'A' },
  });
  const plan = planMigration(await stateOf(world));
  assert.equal(plan.workspaces.length, 1);
  assert.deepEqual(plan.workspaces[0].renames, [{ oldKey: 'ari.wsf', newKey: 'wsf' }]);
  assert.deepEqual(plan.workspaces[0].folds, [{ agentId: 'agent-1', fields: ['stagedBrief'] }]);
  assert.equal(plan.agents.length, 1);
  assert.equal(plan.agents[0].agentId, steer.id);
  assert.deepEqual(plan.agents[0].migrate, ['ari.wsf.role', 'ari.wsf.slot']);
  assert.deepEqual(plan.agents[0].labels, { 'wsf.role': 'steer', 'wsf.slot': 'A' });
  assert.deepEqual(plan.summary, {
    workspaces: 1, workspaceRenames: 1, workspaceRemovals: 0, workspaceConflicts: 0,
    folds: 1, agents: 1, agentMigrations: 2, agentConflicts: 0, archivedAgents: 0, total: 4,
  });
  assert.equal(migrationEmpty(plan), false);
  const text = formatMigration(plan);
  assert.match(text, new RegExp(`workspace ${ws.id}.*rename ari\\.wsf -> wsf`));
  assert.match(text, /fold wsf\.agents\[agent-1\] fields stagedBrief/);
  assert.match(text, new RegExp(`agent ${steer.id}.*migrates ari\\.wsf\\.role, ari\\.wsf\\.slot`));
});

test('clean state plans nothing and formats as nothing to migrate', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: { [METADATA_KEY]: LEGACY_STATE, [AGENTS_KEY]: {} } });
  addAgent(world, {
    provider: 'codex', model: 'm', title: 'Steer A', workspaceId: ws.id,
    labels: { [LABEL.role]: 'steer', [LABEL.slot]: 'A', [LABEL.scope]: 'demo' },
  });
  // Both-exist-equal agent labels linger and count as done.
  addAgent(world, {
    provider: 'codex', model: 'm', title: 'Steer B', workspaceId: ws.id,
    labels: { 'ari.wsf.role': 'steer', 'wsf.role': 'steer' },
  });
  const plan = planMigration(await stateOf(world));
  assert.deepEqual(plan.workspaces, []);
  assert.deepEqual(plan.agents, []);
  assert.equal(migrationEmpty(plan), true);
  assert.match(formatMigration(plan), /\(nothing to migrate\)/);
});

test('both-exist-different metadata is a conflict: wsf kept, old skipped', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: {
    'ari.wsf.checkpoint': { task: 'old', updatedAt: '2026-11-23T00:00:00.000Z' },
    'wsf.checkpoint': { task: 'new', updatedAt: '2026-11-24T00:00:00.000Z' },
  } });
  const plan = planMigration(await stateOf(world));
  assert.equal(plan.workspaces.length, 1);
  assert.deepEqual(plan.workspaces[0].renames, []);
  assert.equal(plan.workspaces[0].conflicts.length, 1);
  assert.match(plan.workspaces[0].conflicts[0].detail, /keeping wsf/);
  assert.equal(plan.workspaces[0].conflicts[0].newer, 'wsf');
  // Conflicts alone carry no write: total counts only actionable changes.
  assert.equal(plan.summary.total, 0);
  const out = await applyMigration({
    client: fakeClient(world), paseoCli: fakePaseoCli(world),
    plan, paseoState: await stateOf(world),
    stateDir: mkdtempSync(join(tmpdir(), 'wsf-migrate-conflict-')),
  });
  assert.equal(out.workspaces[0].ok, true);
  assert.deepEqual(world.workspaces[0].metadata['wsf.checkpoint'], { task: 'new', updatedAt: '2026-11-24T00:00:00.000Z' });
  assert.deepEqual(world.workspaces[0].metadata['ari.wsf.checkpoint'], { task: 'old', updatedAt: '2026-11-23T00:00:00.000Z' });
  assert.match(formatMigrationResult(out), /1 conflict\(s\) skipped/);
});

test('both-exist-equal metadata drops the old key; agent label conflicts keep wsf', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: {
    'ari.wsf': { ...LEGACY_STATE }, [METADATA_KEY]: { ...LEGACY_STATE },
  } });
  const agent = addAgent(world, {
    provider: 'codex', model: 'm', title: 'Steer A', workspaceId: ws.id,
    labels: { 'ari.wsf.slot': 'A', 'wsf.slot': 'B' },
  });
  const plan = planMigration(await stateOf(world));
  assert.deepEqual(plan.workspaces[0].removals, [{ oldKey: 'ari.wsf', newKey: 'wsf' }]);
  assert.equal(plan.agents.length, 1);
  assert.deepEqual(plan.agents[0].migrate, []);
  assert.equal(plan.agents[0].conflicts.length, 1);
  assert.deepEqual(plan.agents[0].labels, {});
  const out = await applyMigration({
    client: fakeClient(world), paseoCli: fakePaseoCli(world),
    plan, paseoState: await stateOf(world),
    stateDir: mkdtempSync(join(tmpdir(), 'wsf-migrate-equal-')),
  });
  assert.equal(out.workspaces[0].ok, true);
  assert.equal(world.workspaces[0].metadata['ari.wsf'], undefined);
  assert.deepEqual(world.workspaces[0].metadata[METADATA_KEY], LEGACY_STATE);
  // No label write for a pure conflict.
  assert.ok(!world.calls.some((c) => c[0] === 'paseo'));
  assert.equal(agent.labels['wsf.slot'], 'B');
});

test('classifyLegacyKey distinguishes pending, equal and conflict', () => {
  assert.equal(classifyLegacyKey({ 'ari.wsf.role': 'steer' }, 'ari.wsf.role', ['ari.wsf.role']).status, 'rename');
  assert.equal(classifyLegacyKey({ 'ari.wsf.role': 'steer', 'wsf.role': 'steer' }, 'ari.wsf.role', []).status, 'equal');
  assert.equal(classifyLegacyKey({ 'ari.wsf.role': 'steer', 'wsf.role': 'worker' }, 'ari.wsf.role', []).status, 'conflict');
  // Without a pending list, a missing new key still reads as rename.
  assert.equal(classifyLegacyKey({ 'ari.wsf.role': 'steer' }, 'ari.wsf.role').status, 'rename');
});

// ---------------------------------------------------------------- folding

test('fold covers every legacy per-agent field', () => {
  assert.deepEqual([...LEGACY_AGENT_FIELDS].sort(), [
    'actionVerified', 'cleared', 'freshHint', 'lastActionFailed', 'lastSteerDeliveryId',
    'pendingAction', 'pendingWakeBrief', 'refreshed', 'stagedBrief',
  ].sort());
  assert.deepEqual(foldableFields({ note: 'x' }), []);
  assert.deepEqual(foldableFields({ stagedBrief: {}, cleared: {} }).sort(), ['cleared', 'stagedBrief']);
});

test('fold equals the lazy fold: same action and facts, legacy keys gone', async () => {
  const entries = [
    { pendingWakeBrief: { wakeId: 'w1', note: 'wake', events: [{ workerId: 'w', state: 'done' }], epoch: 3 }, pendingAction: { kind: 'clear' }, stagedBrief: { packet: 'other' }, lastSteerDeliveryId: 'last', cleared: { mode: 'clear' }, actionVerified: true },
    { pendingAction: { kind: 'clear', at: 't', messageId: 'm' }, refreshed: { briefMessageId: 'b' } },
    { stagedBrief: { packet: 'staged' } },
    { lastSteerDeliveryId: 'last' },
    { cleared: { mode: 'rewind' }, lastActionFailed: { at: 't' }, freshHint: { at: 't', reason: 'big' } },
  ];
  for (const entry of entries) {
    const beforeAction = readSteerAction(entry, 'wks_1');
    const beforeFacts = Object.fromEntries(ACTION_FACTS.map((key) => [key, actionFact(entry, key)]));
    const { changed, folded, fields } = foldAgentEntry(entry, 'wks_1');
    assert.equal(changed, true, JSON.stringify(entry));
    assert.ok(fields.length > 0);
    for (const field of LEGACY_AGENT_FIELDS) assert.equal(Object.hasOwn(folded, field), false, field);
    // Random wake ids (stage fold) differ per call, and folded actions carry
    // the facts inside: compare the delivery shape, facts separately below.
    // Facts-only entries fold null into a memory holder for the facts.
    const norm = (action) => {
      if (!action) return action;
      const { facts: _drop, ...rest } = action;
      return rest.kind === 'stage' ? { ...rest, wakeId: 'stage' } : rest;
    };
    const afterAction = readSteerAction(folded, 'wks_1');
    if (beforeAction === null) {
      assert.equal(afterAction?.kind, 'memory', 'facts-only entries fold into a memory action');
    } else {
      assert.deepEqual(norm(afterAction), norm(beforeAction));
    }
    for (const key of ACTION_FACTS) assert.deepEqual(actionFact(folded, key), beforeFacts[key], key);
  }
  const clean = { note: 'x', action: { kind: 'delivery', wakeId: 'w', phase: 'done' } };
  assert.deepEqual(foldAgentEntry(clean, 'wks_1'), { changed: false, folded: clean, fields: [] });
});

// ---------------------------------------------------------------- apply

test('backup is written before the first write and holds the exact old values', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: {
    'ari.wsf': LEGACY_STATE, [AGENTS_KEY]: { 'agent-1': { stagedBrief: { packet: 'p' } } },
  } });
  const steer = addAgent(world, {
    provider: 'codex', model: 'm', title: 'Steer A', workspaceId: ws.id,
    labels: { 'ari.wsf.role': 'steer' },
  });
  const state = await stateOf(world);
  const plan = planMigration(state);
  const stateDir = mkdtempSync(join(tmpdir(), 'wsf-migrate-backup-'));
  let backupSeenAtFirstWrite = null;
  const client = fakeClient(world);
  const rawSetMetadata = client.workspaces.ref(ws.id).setMetadata;
  void rawSetMetadata;
  const gated = {
    ...client,
    workspaces: {
      ref: (id) => {
        const ref = client.workspaces.ref(id);
        return {
          ...ref,
          setMetadata: async (patch) => {
            backupSeenAtFirstWrite = readdirSync(stateDir).filter((f) => f.startsWith('migrate-backup-'));
            return ref.setMetadata(patch);
          },
        };
      },
    },
  };
  const out = await applyMigration({ client: gated, paseoCli: fakePaseoCli(world), plan, paseoState: state, stateDir });
  assert.ok(out.backupPath.startsWith(stateDir));
  assert.deepEqual(backupSeenAtFirstWrite, [out.backupPath.split('/').pop()], 'backup file exists before the first metadata write');
  const backup = JSON.parse(readFileSync(out.backupPath, 'utf8'));
  assert.equal(backup.workspaces[0].workspaceId, ws.id);
  assert.deepEqual(backup.workspaces[0].metadata['ari.wsf'], LEGACY_STATE);
  assert.deepEqual(backup.workspaces[0].metadata[AGENTS_KEY]['agent-1'], { stagedBrief: { packet: 'p' } });
  assert.equal(backup.agents[0].agentId, steer.id);
  assert.deepEqual(backup.agents[0].labels, { 'ari.wsf.role': 'steer' });
  // And the writes landed: rename, fold and label set, verified by re-read.
  assert.deepEqual(world.workspaces[0].metadata[METADATA_KEY], LEGACY_STATE);
  assert.equal(world.workspaces[0].metadata['ari.wsf'], undefined);
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY]['agent-1'].stagedBrief, undefined);
  assert.equal(world.agents.find((a) => a.id === steer.id).labels['wsf.role'], 'steer');
});

test('migrationBackup carries full touched records for a restore', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: { 'ari.wsf': LEGACY_STATE } });
  addAgent(world, { provider: 'codex', model: 'm', workspaceId: ws.id, labels: { 'ari.wsf.role': 'steer' } });
  const state = await stateOf(world);
  const backup = migrationBackup(planMigration(state), state);
  assert.ok(Date.parse(backup.createdAt));
  assert.equal(backup.workspaces.length, 1);
  assert.equal(backup.agents.length, 1);
});

test('apply is idempotent: a second run reports nothing to do', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: {
    'ari.wsf': LEGACY_STATE, [AGENTS_KEY]: { 'agent-1': { lastSteerDeliveryId: 'last' } },
  } });
  addAgent(world, {
    provider: 'codex', model: 'm', title: 'Steer A', workspaceId: ws.id,
    labels: { 'ari.wsf.role': 'steer', 'ari.wsf.slot': 'A' },
  });
  const first = planMigration(await stateOf(world));
  assert.equal(migrationEmpty(first), false);
  const out = await applyMigration({
    client: fakeClient(world), paseoCli: fakePaseoCli(world),
    plan: first, paseoState: await stateOf(world),
    stateDir: mkdtempSync(join(tmpdir(), 'wsf-migrate-idem-')),
  });
  assert.equal(out.summary.failed ?? 0, 0);
  const second = planMigration(await stateOf(world));
  assert.deepEqual(second.workspaces, []);
  assert.deepEqual(second.agents, []);
  assert.equal(migrationEmpty(second), true);
  assert.match(formatMigration(second), /\(nothing to migrate\)/);
});

test('archived agents migrate when the API allows, else they are reported skipped', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: { [METADATA_KEY]: LEGACY_STATE } });
  const archived = addAgent(world, {
    provider: 'codex', model: 'm', title: 'Steer F', workspaceId: ws.id,
    archivedAt: '2026-11-24T00:00:00.000Z', labels: { 'ari.wsf.role': 'steer', 'ari.wsf.slot': 'F' },
  });
  const plan = planMigration(await stateOf(world));
  assert.equal(plan.agents.length, 1);
  assert.equal(plan.agents[0].archived, true);
  assert.equal(plan.summary.archivedAgents, 1);
  // Refusing API: reported as skipped, run stays green for the rest.
  const refused = await applyMigration({
    client: fakeClient(world), paseoCli: fakePaseoCli(world, { refuseArchived: true }),
    plan, paseoState: await stateOf(world),
    stateDir: mkdtempSync(join(tmpdir(), 'wsf-migrate-arch-refuse-')),
  });
  assert.equal(refused.agents[0].skipped, true);
  assert.match(refused.agents[0].error, /archived agent not migrated/);
  assert.equal(world.agents.find((a) => a.id === archived.id).labels['wsf.role'], undefined);
  assert.match(formatMigrationResult(refused), /SKIPPED/);
  // Allowing API: the archived agent migrates like a live one.
  const allowed = await applyMigration({
    client: fakeClient(world), paseoCli: fakePaseoCli(world, { refuseArchived: false }),
    plan, paseoState: await stateOf(world),
    stateDir: mkdtempSync(join(tmpdir(), 'wsf-migrate-arch-allow-')),
  });
  assert.equal(allowed.agents[0].ok, true);
  assert.equal(world.agents.find((a) => a.id === archived.id).labels['wsf.role'], 'steer');
  assert.equal(world.agents.find((a) => a.id === archived.id).labels['wsf.slot'], 'F');
});

// ---------------------------------------------------------------- cli/docs

test('CLI usage documents migrate, not labels', () => {
  const out = execFileSync('node', ['src/cli.mjs', '--help'], { encoding: 'utf8' });
  assert.match(out, /migrate \[--apply\] \[--json\]/);
  assert.doesNotMatch(out, /labels \[scope\|agent-id\]/);
});
