// Retired-scope rules and scope relocation tests. Retired scopes refuse
// coordination (switch/fresh) and steer planning; relocate moves a scope to a
// new main workspace with fresh steers and retires the old one with movedTo.
// Fakes only; no daemon, no filesystem, no git.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureRuntime } from '../src/runtime.mjs';
import { LABEL, METADATA_KEY, PARENT_LABEL } from '../src/paseo.mjs';
import { steerStatus, switchSteer } from '../src/steer.mjs';
import { freshSteer } from '../src/steer.mjs';
import { planRepository } from '../src/planner.mjs';
import { withLock } from '../src/lock.mjs';
import { relocateScope, parseRelocateTarget } from '../src/relocate.mjs';

// Locked paths take real workspace locks; keep them in a throwaway state dir
// instead of the production one (per-file processes).
configureRuntime({ runtime: { stateDir: mkdtempSync(join(tmpdir(), 'wsf-relocate-')) } });

// ---------------------------------------------------------------- fixtures

const REPO = 'example-owner/example-repo';
const CONFIG = {
  version: 1,
  github: { owner: 'example-owner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    std: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
    cheap: { provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null, mode: 'allowAll' },
  },
  steers: { slots: { A: 'std', B: 'cheap' }, prepare: ['A', 'B'], initialActive: 'A' },
  workers: { defaultProfile: 'cheap' },
};
const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'full-access' }] },
  { provider: 'muse', enabled: true, status: 'ready', models: [{ id: 'muse-spark-1.3-contributor', thinkingOptions: [] }], modes: [{ id: 'allowAll' }] },
];

function makeWorld() {
  return { projects: [], workspaces: [], agents: [], providers: structuredClone(PROVIDERS), calls: [], receipts: new Map(), fingerprints: new Map(), seq: 0, hooks: {} };
}

function addWorkspace(world, { path, title = 'Main', metadata = {}, id } = {}) {
  const ws = { id: id ?? `wks_${String(++world.seq).padStart(4, '0')}`, projectId: 'prj_1', workspaceDirectory: path, workspaceKind: 'local_checkout', title, name: title, metadata: structuredClone(metadata), createdAt: '2026-11-23T00:00:00.000Z' };
  world.workspaces.push(ws);
  if (!world.projects.some((p) => p.projectId === ws.projectId)) {
    world.projects.push({ projectId: ws.projectId, projectKey: `test-key-${ws.projectId}`, projectRootPath: path, projectDisplayName: 'demo', projectKind: ws.projectKind ?? 'git' });
  }
  return ws;
}

function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}

function provisioned(world) {
  const ws = addWorkspace(world, {
    path: '/p/demo',
    metadata: {
      [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 3 },
      [`${METADATA_KEY}.checkpoint`]: { task: 'Ship it', tests: ['npm test'], blockers: [], next: 'tag', epoch: 3, updatedAt: '2026-11-23T00:00:00.000Z' },
    },
  });
  const steers = {
    A: addAgent(world, { provider: 'codex', model: 'gpt-6.2-sol', title: 'Steer A', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'A' } }),
    B: addAgent(world, { provider: 'muse', model: 'muse-spark-1.3-contributor', title: 'Steer B', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'B' } }),
  };
  addAgent(world, { provider: 'muse', model: 'm', title: 'Worker 1', workspaceId: ws.id, labels: { [PARENT_LABEL]: steers.A.id } });
  return { ws, steers };
}

function discoveryOf(world, forkName = REPO) {
  return {
    forkName,
    mainWorkspace: world.workspaces[0] ? structuredClone(world.workspaces[0]) : null,
    steers: { labelled: structuredClone(world.agents.filter((a) => a.labels?.[LABEL.role] === 'steer')), legacy: [] },
    workers: structuredClone(world.agents.filter((a) => a.labels?.[PARENT_LABEL])),
    providers: structuredClone(world.providers),
  };
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  const fingerprint = (opts) => JSON.stringify({ ...opts, idempotencyKey: undefined });
  const agentHandle = (id) => ({
    id,
    refresh: async () => ({ agent: structuredClone(findAgent(id)) }),
    send: async (text) => {
      world.calls.push(['agent.send', id, text]);
    },
    timeline: { refetch: async () => ({ entries: [{ item: { type: 'assistant_message', text: 'Done.' } }] }) },
  });
  const workspaceHandle = (id) => ({
    id,
    refresh: async () => structuredClone(findWs(id)),
    setMetadata: async (patch) => {
      world.calls.push(['workspace.setMetadata', id, patch]);
      for (const [key, value] of Object.entries(structuredClone(patch))) {
        if (value === null) delete findWs(id).metadata[key];
        else findWs(id).metadata[key] = value;
      }
    },
    agents: {
      create: async (opts) => {
        world.calls.push(['agent.create', opts]);
        if (opts.idempotencyKey && world.receipts.has(opts.idempotencyKey)) {
          if (world.fingerprints.get(opts.idempotencyKey) !== fingerprint(opts)) throw new Error('agent_request_key_conflict');
          return agentHandle(world.receipts.get(opts.idempotencyKey));
        }
        const [provider, model] = opts.config.provider.split('/');
        const agent = addAgent(world, { provider, model, title: opts.title, workspaceId: id, labels: { ...opts.labels } });
        if (opts.idempotencyKey) {
          world.receipts.set(opts.idempotencyKey, agent.id);
          world.fingerprints.set(opts.idempotencyKey, fingerprint(opts));
        }
        if (world.hooks.dropAgentCreate?.(opts)) throw new Error('socket closed before agent.create response');
        return agentHandle(agent.id);
      },
    },
  });
  return {
    workspaces: {
      ref: workspaceHandle,
      create: async ({ source, title, metadata, idempotencyKey }) => {
        world.calls.push(['workspace.create', { source, title, metadata, idempotencyKey }]);
        const print = JSON.stringify({ source, title, metadata });
        if (idempotencyKey && world.receipts.has(idempotencyKey)) {
          if (world.fingerprints.get(idempotencyKey) !== print) throw new Error('workspace_request_key_conflict');
          return workspaceHandle(world.receipts.get(idempotencyKey));
        }
        const ws = addWorkspace(world, { path: source.path, title, metadata });
        if (idempotencyKey) {
          world.receipts.set(idempotencyKey, ws.id);
          world.fingerprints.set(idempotencyKey, print);
        }
        return workspaceHandle(ws.id);
      },
    },
    agents: { ref: agentHandle },
  };
}

function fakeLookup(world) {
  return async (kind, key) => {
    world.calls.push(['receipt.lookup', kind, key]);
    if (!world.receipts.has(key)) return null;
    const id = world.receipts.get(key);
    return kind === 'agent'
      ? { kind, idempotencyKey: key, phase: 'completed', error: null, agentId: id }
      : { kind, idempotencyKey: key, phase: 'completed', error: null, workspaceId: id, workspace: { id } };
  };
}

const fakeReadState = (world) => async () => structuredClone({ projects: world.projects, workspaces: world.workspaces, agents: world.agents, providers: world.providers });

const fakeGit = () => (cwd, args) => {
  if (args[0] === 'rev-parse') return args.includes('--abbrev-ref') ? 'main' : 'a1b2c3d4e5f6a7b8c9d0';
  if (args[0] === 'status') return '';
  throw new Error(`unexpected git ${args.join(' ')}`);
};

const LOCK_TMP = mkdtempSync(join(tmpdir(), 'wsf-relocate-lock-'));
const testLock = (name, fn) => withLock(name, fn, { dir: LOCK_TMP });
const existingDirs = (...dirs) => (path) => dirs.includes(path);

// ---------------------------------------------------------------- retired rules (S1)

function retiredDiscovery(world) {
  world.workspaces[0].metadata[METADATA_KEY] = { main: true, activeSteer: null, epoch: 4, previousSteer: 'A', retired: true, movedTo: '/p/moved' };
  return discoveryOf(world);
}

test('switch and fresh refuse retired scopes, naming the successor', async () => {
  const world = makeWorld();
  provisioned(world);
  const discovery = retiredDiscovery(world);
  await assert.rejects(
    switchSteer({ client: fakeClient(world), discovery, toSlot: 'B', lock: testLock, language: 'en' }),
    /Scope example-owner\/example-repo is retired \(moved to \/p\/moved\); coordinate in the successor scope/,
  );
  await assert.rejects(
    freshSteer({ client: fakeClient(world), discovery, config: CONFIG, lock: testLock, language: 'en' }),
    /already retired|is retired/,
  );
  assert.deepEqual(world.calls, [], 'no writes to a retired scope');
});

test('planner reports retired scopes as conflict and plans no steers', () => {
  const world = makeWorld();
  provisioned(world);
  const discovery = {
    local: true,
    github: { local: true, fork: { status: 'local' }, upstream: null, source: null, notes: [] },
    forkName: 'local/demo',
    expectedPath: '/p/demo',
    cloneTarget: null,
    checkout: { path: '/p/demo', linkedWorktree: false, remotes: {}, repos: {}, local: true },
    checkoutIssues: [],
    relatedCheckouts: [],
    upstreamRemote: null,
    projects: [{ projectId: 'prj_1' }],
    mainCandidates: [],
    otherLocalWorkspaces: [],
    mainWorkspace: {
      id: 'wks_0001', projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout',
      title: 'Main', name: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: null, epoch: 2, retired: true, movedTo: '/p/moved' } },
    },
    steers: { labelled: [], legacy: [] },
    workers: [],
    providers: structuredClone(PROVIDERS),
  };
  discovery.mainCandidates = [discovery.mainWorkspace];
  const plan = planRepository(discovery, CONFIG, {});
  assert.equal(plan.status, 'conflict');
  assert.ok(plan.conflicts.some((c) => c.key === 'workspace.main' && /retired, movedTo \/p\/moved/.test(c.reason)), JSON.stringify(plan.conflicts));
  assert.ok(!plan.ops.some((op) => op.key.startsWith('steer.')), JSON.stringify(plan.ops.map((op) => op.key)));
});

test('status carries retired state and null active steer stays robust', async () => {
  const world = makeWorld();
  provisioned(world);
  const status = steerStatus(retiredDiscovery(world));
  assert.equal(status.state.retired, true);
  assert.equal(status.state.movedTo, '/p/moved');
  assert.equal(status.state.activeSteer, null);

  const nulled = makeWorld();
  provisioned(nulled);
  nulled.workspaces[0].metadata[METADATA_KEY].activeSteer = null;
  const preview = await switchSteer({ client: fakeClient(nulled), discovery: discoveryOf(nulled), toSlot: 'B', lock: testLock, language: 'en' });
  assert.equal(preview.to, 'B');
  assert.equal(preview.applied, false);
});

// ---------------------------------------------------------------- relocate

const relocate = (world, extra = {}) => relocateScope({
  client: fakeClient(world), discovery: discoveryOf(world), config: CONFIG, to: '/p/moved',
  git: fakeGit(), lock: testLock, lookupReceipt: fakeLookup(world), readState: fakeReadState(world),
  existsDir: existingDirs('/p/demo', '/p/moved'), language: 'en', ...extra,
});

test('target parsing: paths, project ids and junk', () => {
  const projects = [{ projectId: 'prj_1', projectRootPath: '/p/one' }];
  assert.deepEqual(parseRelocateTarget('/p/moved', projects), { kind: 'path', dir: '/p/moved' });
  assert.deepEqual(parseRelocateTarget('project:prj_1', projects), { kind: 'project', dir: '/p/one', projectId: 'prj_1' });
  assert.deepEqual(parseRelocateTarget('prj_1', projects), { kind: 'project', dir: '/p/one', projectId: 'prj_1' });
  assert.throws(() => parseRelocateTarget('project:prj_gone', projects), /does not exist/);
  assert.throws(() => parseRelocateTarget('relative/path', projects), /neither a path nor project/);
  assert.throws(() => parseRelocateTarget('', projects), /needs --to/);
});

test('preview inventories the move, shows keys and packets, writes nothing', async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const first = await relocate(world);
  assert.equal(first.applied, false);
  assert.equal(first.scope, REPO);
  assert.equal(first.fromWorkspace, ws.id);
  assert.equal(first.toWorkspace, null);
  assert.equal(first.toDir, '/p/moved');
  assert.equal(first.epoch, 1);
  assert.equal(first.movedTo, '/p/moved');
  assert.equal(first.checkpoint, true);
  assert.match(first.workspaceKey, /^wsf:example-owner\/example-repo:relocate:workspace:[0-9a-f]{10}$/);
  assert.deepEqual(first.steers.map((s) => s.slot), ['A', 'B']);
  assert.ok(first.steers.every((s) => s.to === null && s.reused === false && /^wsf:/.test(s.idempotencyKey)));
  assert.equal(first.packets.length, 2);
  assert.match(first.packets[0].packet, new RegExp(`Scope relocated: ${ws.id} → /p/moved`));
  assert.match(first.packets[0].packet, /Task: Ship it/);
  assert.match(first.packets[0].packet, /\(new agent, created on apply\) is now active/);

  const second = await relocate(world);
  assert.deepEqual(second, first, 'same state, same preview');
  assert.deepEqual(world.calls.filter((c) => c[0] !== 'receipt.lookup'), [], 'preview reads only (receipt lookups happen on apply)');
  assert.ok(!world.calls.some((c) => c[0] === 'receipt.lookup'), 'no receipt lookup in preview');
});

test('preview refuses missing, occupied and retired targets plus busy and unstartable scopes', async () => {
  const missing = makeWorld();
  provisioned(missing);
  await assert.rejects(relocate(missing, { to: '/p/void', existsDir: existingDirs('/p/demo') }), /does not exist or is not a directory/);
  await assert.rejects(relocate(missing, { to: '/p/demo' }), /already the main workspace/);

  const occupied = makeWorld();
  provisioned(occupied);
  addWorkspace(occupied, { path: '/p/moved', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } } });
  await assert.rejects(relocate(occupied), /foreign factory state/);

  const retired = makeWorld();
  provisioned(retired);
  retired.workspaces[0].metadata[METADATA_KEY] = { main: true, activeSteer: null, epoch: 4, retired: true, movedTo: '/p/moved' };
  await assert.rejects(relocate(retired), /already retired \(moved to \/p\/moved\)/);

  const busy = makeWorld();
  const { steers } = provisioned(busy);
  steers.A.status = 'running';
  await assert.rejects(relocate(busy), /Active Steer A is running/);

  const unstartable = makeWorld();
  provisioned(unstartable);
  unstartable.providers = [];
  await assert.rejects(relocate(unstartable), /not startable/);

  const stray = makeWorld();
  const { ws } = provisioned(stray);
  addAgent(stray, { provider: 'codex', model: 'm', title: 'Steer Z', workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: 'Z' } });
  await assert.rejects(relocate(stray), /without a configured slot/);
});

test('apply creates the new scope, retires the old one with movedTo, delivers handoffs', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const result = await relocate(world, { apply: true });
  assert.equal(result.applied, true);
  assert.equal(result.toDir, '/p/moved');
  assert.equal(result.movedTo, '/p/moved');
  assert.equal(result.adoptedWorkspace, false);
  assert.ok(result.toWorkspace && result.toWorkspace !== ws.id);

  const fresh = world.workspaces.find((w) => w.id === result.toWorkspace);
  assert.deepEqual(fresh.metadata[METADATA_KEY], { main: true, activeSteer: 'A', epoch: 1 });
  assert.deepEqual(fresh.metadata[`${METADATA_KEY}.checkpoint`], { task: 'Ship it', tests: ['npm test'], blockers: [], next: 'tag', epoch: 1, updatedAt: '2026-11-23T00:00:00.000Z' });
  assert.deepEqual(result.steers.map((s) => s.slot), ['A', 'B']);
  assert.ok(result.steers.every((s) => s.to && !s.reused));
  for (const steer of result.steers) {
    const created = world.agents.find((a) => a.id === steer.to);
    assert.equal(created.workspaceId, result.toWorkspace);
    assert.equal(created.title, `Steer ${steer.slot}`);
    assert.deepEqual(created.labels, { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: steer.slot });
    assert.ok(!created.labels['paseo.parent-agent-id']);
  }
  assert.equal(world.agents.find((a) => a.id === result.steers[0].to).provider, 'codex');
  assert.equal(world.agents.find((a) => a.id === result.steers[1].to).provider, 'muse');

  const old = world.workspaces.find((w) => w.id === ws.id).metadata[METADATA_KEY];
  assert.equal(old.retired, true);
  assert.equal(old.activeSteer, null);
  assert.equal(old.epoch, 4);
  assert.equal(old.previousSteer, 'A');
  assert.equal(old.movedTo, '/p/moved');
  assert.ok(old.retiredAt);
  const sets = world.calls.filter((c) => c[0] === 'workspace.setMetadata' && c[1] === ws.id);
  assert.ok(sets.length >= 2);
  assert.deepEqual(Object.keys(sets[0][2]), [METADATA_KEY], 'movedTo first');
  assert.ok(sets[0][2][METADATA_KEY].movedTo && !sets[0][2][METADATA_KEY].retired);

  assert.deepEqual(result.delivered.sort(), result.steers.map((s) => s.to).sort());
  assert.deepEqual(result.previousNotified.sort(), [steers.A.id, steers.B.id].sort());
  assert.deepEqual(result.deliveryErrors, []);
  assert.deepEqual(result.notifyErrors, []);
  assert.match(result.packets[0].packet, /Scope relocated: wks_0001 → \/p\/moved/);
  const notice = world.calls.find((c) => c[0] === 'agent.send' && c[1] === steers.A.id)[2];
  assert.match(notice, /Scope relocated to \/p\/moved/);
  assert.match(notice, /no longer coordinate/);

  await assert.rejects(relocate(world, { apply: true }), /already retired \(moved to \/p\/moved\)/);
});

test('apply adopts a bare workspace at the target', async () => {
  const world = makeWorld();
  provisioned(world);
  const bare = addWorkspace(world, { path: '/p/moved' });
  const preview = await relocate(world);
  assert.equal(preview.toWorkspace, bare.id);
  assert.equal(preview.adoptedWorkspace, true);
  const result = await relocate(world, { apply: true });
  assert.equal(result.toWorkspace, bare.id);
  assert.equal(result.adoptedWorkspace, true);
  assert.ok(!world.calls.some((c) => c[0] === 'workspace.create'));
  assert.equal(world.workspaces.find((w) => w.id === bare.id).metadata[METADATA_KEY].epoch, 1);
});

test('interrupted apply resumes through receipts without duplicates', async () => {
  const world = makeWorld();
  provisioned(world);
  world.hooks.dropAgentCreate = (opts) => opts.title === 'Steer B';
  await assert.rejects(relocate(world, { apply: true }), /socket closed before agent.create response/);
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].epoch, 3, 'no retire write happened');
  world.hooks.dropAgentCreate = null;
  const result = await relocate(world, { apply: true });
  assert.equal(result.applied, true);
  assert.ok(result.steers.every((s) => s.reused), 'both recovered, none recreated');
  assert.equal(world.workspaces.filter((w) => w.workspaceDirectory === '/p/moved').length, 1);
  assert.equal(world.agents.filter((a) => a.labels?.[LABEL.slot] === 'B' && !a.archivedAt).length, 2, 'old plus relocated holder');
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].epoch, 4);
});

test('project targets resolve to their root path', async () => {
  const world = makeWorld();
  provisioned(world);
  world.projects.push({ projectId: 'prj_x', projectKey: 'k', projectRootPath: '/p/other', projectDisplayName: 'o', projectKind: 'git' });
  const preview = await relocate(world, { to: 'project:prj_x', existsDir: existingDirs('/p/demo', '/p/other') });
  assert.equal(preview.toDir, '/p/other');
  assert.equal(preview.movedTo, '/p/other');
});
