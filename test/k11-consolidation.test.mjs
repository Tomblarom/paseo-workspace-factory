// K11 consolidation: one daemon snapshot per call, one holder selector.
// Fake state only; no daemon. The runner reuses a passed snapshot instead
// of re-reading, and every holder pick (liveSlotHolders, scopeHolder,
// resolveWakeTarget) agrees on plain labels, ZeroSub multi-hop
// continuations and same-slot newer-wins cases.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from '../src/factory.mjs';
import { liveSlotHolders, resolveSteerHolders } from '../src/discovery.mjs';
import { LABEL, METADATA_KEY } from '../src/paseo.mjs';
import { scopeHolder } from '../src/scope-guard.mjs';
import { resolveWakeTarget } from '../src/supervision.mjs';
import { CONTINUED_FROM_LABEL } from '../src/zerosub.mjs';

// ---------------------------------------------------------------- fixtures

const SCOPE = 'web';
const MAIN = 'wks_main';
const CONFIG = {
  version: 1,
  github: { owner: 'example-owner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: mkdtempSync(join(tmpdir(), 'k11-')),
  workspaceTitle: 'Main',
  profiles: {
    standard: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
  },
  steers: { slots: { A: 'standard', B: 'standard', C: 'standard' }, prepare: ['A'], initialActive: 'A' },
  workers: { defaultProfile: 'standard' },
};

function agent(id, over = {}) {
  return {
    id, status: 'idle', archivedAt: null, workspaceId: MAIN,
    provider: 'codex', model: 'gpt-6.2-sol', title: `Steer ${id}`, labels: {},
    ...over,
  };
}

const steerLabels = (slot, scope = SCOPE) => ({ [LABEL.scope]: scope, [LABEL.role]: 'steer', [LABEL.slot]: slot });

function scopeState(agents) {
  return {
    projects: [{ projectId: 'prj_1', projectRootPath: join(CONFIG.checkoutRoot, SCOPE) }],
    workspaces: [{
      id: MAIN, projectId: 'prj_1', workspaceDirectory: join(CONFIG.checkoutRoot, SCOPE),
      workspaceKind: 'local_checkout', title: 'Main', name: 'Main',
      metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: SCOPE, kind: 'dir', locator: SCOPE } } },
    }],
    agents,
    providers: [],
  };
}

/** Status/supervision row shape for one resolved agent (slot/id/archivedAt/superseded/retired). */
const rowOf = (a) => ({ slot: a.labels?.[LABEL.slot] ?? null, id: a.id, archivedAt: a.archivedAt ?? null, retired: false, superseded: a.superseded === true });

// ------------------------------------------------------- one snapshot

test('discoverAll and runPlans reuse a passed snapshot instead of re-reading', async () => {
  const agents = [agent('a1', { labels: steerLabels('A') })];
  const state = scopeState(agents);
  let reads = 0;
  const runner = createRunner({
    config: CONFIG, client: {}, gh: () => { throw new Error('no gh'); }, git: () => { throw new Error('no git'); },
    readState: async () => { reads += 1; return structuredClone(state); },
    scan: () => [],
    existsDir: () => true,
  });
  await runner.discoverAll(['web']);
  assert.equal(reads, 1);
  await runner.discoverAll(['web'], { state });
  assert.equal(reads, 1);
  await runner.runPlans(['web'], { state });
  assert.equal(reads, 1);
});

// ------------------------------------------------------- one selector

function agreementWorld() {
  const holderA = agent('holder-a', { labels: steerLabels('A') });
  const originB = agent('origin-b', { labels: steerLabels('B') });
  const midB = agent('mid-b', { labels: { [CONTINUED_FROM_LABEL]: 'origin-b' } });
  const liveB = agent('live-b', { labels: { [CONTINUED_FROM_LABEL]: 'mid-b' } });
  const oldC = agent('old-c', { labels: steerLabels('C'), createdAt: '2026-11-24T09:00:00.000Z' });
  const newC = agent('new-c', { labels: steerLabels('C'), createdAt: '2026-11-24T10:00:00.000Z' });
  const agents = [holderA, originB, midB, liveB, oldC, newC];
  const labelled = agents.filter((a) => a.labels?.[LABEL.role] === 'steer');
  const resolved = resolveSteerHolders(labelled, agents, []);
  return { agents, resolved };
}

test('holder selectors agree on labelled, ZeroSub multi-hop and same-slot cases', () => {
  const { agents, resolved } = agreementWorld();
  const rows = resolved.map(rowOf);
  const viaHelper = (slot) => liveSlotHolders(resolved, slot).map((a) => a.id);
  const viaGuard = (slot) => scopeHolder({ agents, workspaceId: MAIN, scopeId: SCOPE, slot }).id;
  const viaWake = (slot) => resolveWakeTarget({ activeSteer: slot }, rows);
  for (const [slot, winner] of [['A', 'holder-a'], ['B', 'live-b'], ['C', 'new-c']]) {
    assert.deepEqual(viaHelper(slot), [winner], `liveSlotHolders picks ${winner} for slot ${slot}`);
    assert.equal(viaGuard(slot), winner, `scopeHolder picks ${winner} for slot ${slot}`);
    assert.equal(viaWake(slot), winner, `resolveWakeTarget picks ${winner} for slot ${slot}`);
  }
});

test('holder selectors agree that tied timestamps stay ambiguous', () => {
  const tied = [
    agent('t1', { labels: steerLabels('A'), createdAt: '2026-11-24T10:00:00.000Z' }),
    agent('t2', { labels: steerLabels('A'), createdAt: '2026-11-24T10:00:00.000Z' }),
  ];
  const resolved = resolveSteerHolders(tied, tied, []);
  assert.deepEqual(liveSlotHolders(resolved, 'A').map((a) => a.id).sort(), ['t1', 't2']);
  assert.equal(resolveWakeTarget({ activeSteer: 'A' }, resolved.map(rowOf)), null);
  assert.throws(() => scopeHolder({ agents: tied, workspaceId: MAIN, scopeId: SCOPE, slot: 'A' }), /one active/);
});

test('liveSlotHolders skips archived, superseded and retired rows; empty without a slot', () => {
  const rows = [
    { slot: 'A', id: 'live', archivedAt: null, retired: false, superseded: false },
    { slot: 'A', id: 'old', archivedAt: null, retired: false, superseded: true },
    { slot: 'A', id: 'gone', archivedAt: 'x', retired: false, superseded: false },
    { slot: 'A', id: 'prev', archivedAt: null, retired: true, superseded: false },
  ];
  assert.deepEqual(liveSlotHolders(rows, 'A').map((r) => r.id), ['live']);
  assert.deepEqual(liveSlotHolders(rows, 'A', { includeRetired: true }).map((r) => r.id), ['live', 'prev']);
  assert.deepEqual(liveSlotHolders(rows, null), []);
  assert.deepEqual(liveSlotHolders(rows, ''), []);
});
