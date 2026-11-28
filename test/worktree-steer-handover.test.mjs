import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverRepository, steerTitleLabelPatches } from '../plugin/server/core/discovery.mjs';
import { LABEL, METADATA_KEY } from '../plugin/server/core/paseo.mjs';
import { CHECKPOINT_KEY, resolveTargetEntry, steerStatus, switchSteer } from '../plugin/server/core/steer.mjs';

const CONFIG = {
  version: 1,
  github: { owner: 'Tomblarom', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/home/code/projects',
  workspaceTitle: 'Main',
  profiles: {
    sol: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access', advisor: false, sensitive: false },
    opus: { provider: 'claude', model: 'claude-opus-5-5', thinking: 'high', mode: 'default', advisor: false, sensitive: false },
  },
  steers: { slots: { A: 'sol', E: 'opus' }, prepare: ['A'], initialActive: 'A', priority: ['sol', 'opus'] },
  advisors: { priority: [] },
  workers: { priority: ['sol'], defaultProfile: 'sol' },
};

const noLock = async (_name, fn) => fn({ verify() {} });

function makeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id);
  const findAgent = (id) => world.agents.find((a) => a.id === id);
  return {
    projects: { list: async () => ({ projects: world.projects }) },
    workspaces: {
      list: async () => ({ workspaces: world.workspaces }),
      ref: (id) => ({
        refresh: async () => findWs(id),
        setMetadata: async (entries, value) => {
          const ws = findWs(id);
          ws.metadata = typeof entries === 'string'
            ? { ...ws.metadata, [entries]: value }
            : { ...ws.metadata, ...entries };
          return ws;
        },
        update: async (patch) => {
          const ws = findWs(id);
          if (patch.metadata) ws.metadata = { ...ws.metadata, ...patch.metadata };
          return ws;
        },
      }),
    },
    agents: {
      list: async () => ({ entries: world.agents, items: world.agents, agents: world.agents }),
      ref: (id) => ({
        refresh: async () => ({ agent: findAgent(id) }),
        timeline: { refetch: async () => ({ items: [] }) },
        rename: async (title) => {
          const agent = findAgent(id);
          agent.title = title;
          return { agent };
        },
        update: async (patch) => {
          const agent = findAgent(id);
          if (patch.title !== undefined) agent.title = patch.title;
          if (patch.labels) agent.labels = { ...agent.labels, ...patch.labels };
          return { agent };
        },
        send: async (input) => {
          const text = typeof input === 'string' ? input : input.text;
          world.sends.push({ agentId: id, text });
          return { ok: true };
        },
      }),
    },
  };
}

test('scope-only Steer E in a PR worktree is discovered and receives handover isolated from another workspace', async () => {
  const project = { projectId: 'prj_mqb', projectRootPath: '/home/code/projects/mqb_contitool-main' };
  const mainWs = {
    id: 'wks_94a676f1b8dc71dd',
    projectId: project.projectId,
    title: 'Main',
    name: 'Main',
    workspaceDirectory: '/home/code/projects/mqb_contitool-main',
    metadata: {
      [METADATA_KEY]: {
        main: true,
        activeSteer: 'E',
        activeAgentId: 'agt_main_e',
        epoch: 1,
        scope: { id: 'mqb_contitool', kind: 'dir', locator: '/home/code/projects/mqb_contitool-main' },
      },
    },
  };
  const prWs = {
    id: 'wks_8651bfa8dc723870',
    projectId: project.projectId,
    title: 'Cluster EEPROM over OBD',
    name: 'Cluster EEPROM over OBD',
    workspaceDirectory: '/home/code/.paseo/worktrees/2rsd4kjd/pq-cluster-eeprom-obd',
    workspaceKind: 'worktree',
    metadata: {
      [METADATA_KEY]: {
        main: true,
        activeSteer: 'A',
        activeAgentId: 'agt_pr_a',
        epoch: 1,
        scope: {
          id: 'Tomblarom/mqb_contitool@pq-cluster-eeprom-obd',
          kind: 'workspace',
          locator: 'wks_8651bfa8dc723870',
          parent: { id: 'Tomblarom/mqb_contitool', kind: 'github' },
        },
      },
      [CHECKPOINT_KEY]: {
        task: 'Verify PR worktree handover target',
        tests: ['switch preview targets PR Steer E'],
        blockers: [],
        next: 'Continue PR work on Steer E',
        status: 'done',
        epoch: 1,
        updatedAt: '2026-11-27T16:17:47.985Z',
        source: 'agent',
        agentId: 'agt_pr_a',
      },
    },
  };

  // Main workspace: Steer E in error state (with wsf.repo) and Steer C with wsf.scope only.
  const mainE = {
    id: 'agt_main_e',
    workspaceId: mainWs.id,
    title: 'Steer E',
    provider: 'claude',
    model: 'claude-opus-5-5',
    status: 'error',
    archivedAt: null,
    labels: { [LABEL.repo]: 'mqb_contitool', [LABEL.role]: 'steer', [LABEL.slot]: 'E', [LABEL.scope]: 'mqb_contitool', [LABEL.steerRole]: 'coordinator' },
  };
  const mainC = {
    id: 'agt_main_c',
    workspaceId: mainWs.id,
    title: 'Steer C',
    provider: 'codex',
    model: 'gpt-6.2-sol',
    status: 'idle',
    archivedAt: null,
    labels: { [LABEL.role]: 'steer', [LABEL.slot]: 'C', [LABEL.scope]: 'mqb_contitool', [LABEL.steerRole]: 'coordinator' },
  };

  // PR worktree: active Steer A and a newly titled Steer E labelled by steerTitleLabelPatches (no wsf.repo).
  const prA = {
    id: 'agt_pr_a',
    workspaceId: prWs.id,
    title: 'Steer A',
    provider: 'codex',
    model: 'gpt-6.2-sol',
    status: 'idle',
    archivedAt: null,
    labels: {
      [LABEL.repo]: 'Tomblarom/mqb_contitool@pq-cluster-eeprom-obd',
      [LABEL.role]: 'steer',
      [LABEL.slot]: 'A',
      [LABEL.scope]: 'Tomblarom/mqb_contitool@pq-cluster-eeprom-obd',
    },
  };
  const prE = {
    id: 'agt_pr_e',
    workspaceId: prWs.id,
    title: 'Steer E',
    provider: 'claude',
    model: 'claude-opus-5-5',
    status: 'idle',
    archivedAt: null,
    labels: {},
  };

  const world = { projects: [project], workspaces: [mainWs, prWs], agents: [mainE, mainC, prA, prE], sends: [] };
  const paseoState = { projects: world.projects, workspaces: world.workspaces, agents: world.agents, providers: [] };

  const patches = steerTitleLabelPatches(paseoState, CONFIG);
  const prEPatch = patches.find((patch) => patch.agentId === prE.id);
  assert.ok(prEPatch, 'steerTitleLabelPatches labels the visible Steer E tab in the PR worktree');
  assert.equal(prEPatch.labels[LABEL.scope], 'Tomblarom/mqb_contitool@pq-cluster-eeprom-obd');
  assert.equal(prEPatch.labels[LABEL.repo], undefined, 'non-github worktree scope omits legacy wsf.repo');
  prE.labels = { ...prE.labels, ...prEPatch.labels };

  const prTarget = resolveTargetEntry('Tomblarom/mqb_contitool@pq-cluster-eeprom-obd', paseoState);
  assert.deepEqual(prTarget.entry, { workspace: prWs.id });
  const prDiscovery = discoverRepository(prTarget.entry, {
    config: CONFIG, gh: null, git: null, checkouts: [], paseo: paseoState, realpath: (p) => p, existsDir: () => true,
  });
  const prStatus = steerStatus(prDiscovery, { config: CONFIG });
  assert.deepEqual(prStatus.steers.map((s) => `${s.slot}:${s.id}`), [`A:${prA.id}`, `E:${prE.id}`]);

  const mainTarget = resolveTargetEntry('mqb_contitool', paseoState);
  assert.deepEqual(mainTarget.entry, { local: mainWs.workspaceDirectory, workspaceId: mainWs.id });
  const mainDiscovery = discoverRepository(mainTarget.entry, {
    config: CONFIG, gh: null, git: null, checkouts: [], paseo: paseoState, realpath: (p) => p, existsDir: () => true,
  });
  const mainStatus = steerStatus(mainDiscovery, { config: CONFIG });
  assert.deepEqual(mainStatus.steers.map((s) => `${s.slot}:${s.id}`), [`C:${mainC.id}`, `E:${mainE.id}`]);

  const client = makeClient(world);
  const preview = await switchSteer({
    client,
    discovery: prDiscovery,
    toSlot: 'E',
    apply: false,
    config: CONFIG,
    lock: noLock,
  });
  assert.equal(preview.workspaceId, prWs.id);
  assert.equal(preview.fromId, prA.id);
  assert.equal(preview.toId, prE.id);
  assert.equal(preview.epoch, 2);
  assert.match(preview.packet, /Verify PR worktree handover target/);

  const applied = await switchSteer({
    client,
    discovery: prDiscovery,
    toSlot: 'E',
    apply: true,
    send: true,
    config: CONFIG,
    lock: noLock,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.delivered, true);
  assert.equal(applied.toId, prE.id);
  assert.equal(prWs.metadata[METADATA_KEY].activeSteer, 'E');
  assert.equal(prWs.metadata[METADATA_KEY].activeAgentId, prE.id);
  assert.equal(prWs.metadata[METADATA_KEY].epoch, 2);
  assert.equal(mainWs.metadata[METADATA_KEY].epoch, 1, 'same-named Steer E in the other workspace stays untouched');
  assert.equal(world.sends.filter((s) => s.agentId === prE.id).length, 1);
  assert.equal(world.sends.filter((s) => s.agentId === mainE.id).length, 0);
});
