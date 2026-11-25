// Workspace factory tests. A simulated world (GitHub, checkouts, Paseo daemon)
// drives the real discovery, planner, apply loop and executors.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRepoInput, resolveGitHub, GitHubNotFound } from '../src/github.mjs';
import { scanCheckouts, classifyCheckouts, isWithin, inspectCloneTarget } from '../src/local.mjs';
import { validateConfig, validateProfilesAgainstCatalog } from '../src/config.mjs';
import { planHash } from '../src/planner.mjs';
import { createRunner } from '../src/factory.mjs';
import { applyPlans, createExecutors, createAuthorization, memoryProgress, storeAuthorization, fileProgress, withApplyLock, ApplyRefused } from '../src/apply.mjs';
import { verifyCleanup, performCleanup } from './integration-cleanup.mjs';
import { WORKSPACE_REF } from '../src/planner.mjs';
import { switchSteer, steerStatus, SwitchRefused, writeCheckpoint, CHECKPOINT_KEY, parseCheckpointBlock, buildHandoff } from '../src/steer.mjs';
import { configureRuntime, daemonHost } from '../src/runtime.mjs';
import { defaultConfigPath } from '../src/config.mjs';
import { acquireLock, withLock, LockBusy } from '../src/lock.mjs';
import { mkdtempSync, writeFileSync as writeFile, rmSync, mkdirSync, symlinkSync, renameSync, lstatSync, realpathSync, readFileSync, readdirSync, closeSync, openSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LABEL, METADATA_KEY, PARENT_LABEL } from '../src/paseo.mjs';

// ---------------------------------------------------------------- fixtures

const CONFIG = {
  version: 1,
  github: { owner: 'example-owner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    sol: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
    muse: { provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null, mode: 'allowAll' },
    agy: { provider: 'antigravity', model: 'gemini-3.8-flash-high', thinking: null, mode: 'yolo' },
  },
  steers: { slots: { A: 'sol', B: 'muse', C: 'agy' }, prepare: ['A', 'B', 'C'], initialActive: 'A' },
  workers: { defaultProfile: 'muse' },
};

const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }, { id: 'low' }] }], modes: [{ id: 'auto' }, { id: 'full-access' }] },
  { provider: 'muse', enabled: true, status: 'ready', models: [{ id: 'muse-spark-1.3-contributor', thinkingOptions: [{ id: 'max' }] }], modes: [{ id: 'onRequest' }, { id: 'allowAll' }] },
  { provider: 'antigravity', enabled: true, status: 'ready', models: [{ id: 'gemini-3.8-flash-high', thinkingOptions: [] }], modes: [{ id: 'default' }, { id: 'yolo' }] },
  { provider: 'opencode', enabled: false, status: 'unavailable', models: [], modes: [] },
];

const api = (fullName, extra = {}) => {
  const [owner, name] = fullName.split('/');
  return {
    full_name: fullName, name, owner: { login: owner }, fork: false, archived: false, default_branch: 'main',
    clone_url: `https://github.com/${fullName}.git`, ssh_url: `git@github.com:${fullName}.git`, html_url: `https://github.com/${fullName}`, ...extra,
  };
};
const ref = (fullName) => ({ full_name: fullName, clone_url: `https://github.com/${fullName}.git`, ssh_url: `git@github.com:${fullName}.git` });

const FIRMWARE = 'example-owner/example-repo';
const FW_PARENT = 'upstream-owner/upstream-repo';
const FW_SOURCE = 'source-owner/source-repo';

function makeWorld() {
  return {
    repos: {
      [FIRMWARE]: api(FIRMWARE, { fork: true, default_branch: 'master', parent: ref(FW_PARENT), source: ref(FW_SOURCE) }),
      [FW_PARENT]: api(FW_PARENT, { fork: true, parent: ref(FW_SOURCE), source: ref(FW_SOURCE) }),
      [FW_SOURCE]: api(FW_SOURCE),
    },
    forks: {},
    checkouts: {}, // path -> { remotes, linkedWorktree }
    occupied: new Set(),
    inodes: {},
    symlinks: new Set(),
    projects: [],
    workspaces: [],
    agents: [],
    providers: structuredClone(PROVIDERS),
    calls: [],
    receipts: new Map(),
    fingerprints: new Map(),
    seq: 0,
    hooks: {},
  };
}

function fakeGh(world) {
  return (args) => {
    world.calls.push(['gh', ...args]);
    if (args[0] === 'repo' && args[1] === 'fork') {
      const upstream = world.repos[args[2]];
      const full = `example-owner/${upstream.name}`;
      world.repos[full] = api(full, { fork: true, parent: ref(upstream.full_name), source: ref(upstream.source?.full_name ?? upstream.full_name) });
      return '';
    }
    if (args[0] === 'repo' && args[1] === 'list') return JSON.stringify(world.ownerForks ?? []);
    const path = args.find((a) => a.startsWith('repos/'));
    if (path.includes('/forks')) {
      const base = path.slice('repos/'.length).split('/forks')[0];
      const owner = args.at(-1).match(/== "(.+?)"/)[1];
      return (world.forks[base] ?? []).filter((f) => f.split('/')[0].toLowerCase() === owner).join('\n');
    }
    const full = path.slice('repos/'.length);
    if (world.hooks.ghError) throw world.hooks.ghError;
    const hit = Object.keys(world.repos).find((k) => k.toLowerCase() === full.toLowerCase());
    if (!hit) throw new GitHubNotFound(`HTTP 404: Not Found (${full})`);
    return JSON.stringify(world.repos[hit]);
  };
}

function fakeGit(world) {
  return (cwd, args) => {
    world.calls.push(['git', cwd, ...args]);
    const checkout = world.checkouts[cwd];
    if (!checkout) throw new Error(`not a repo: ${cwd}`);
    if (args[0] === 'config') {
      const lines = Object.entries(checkout.remotes).map(([n, u]) => `remote.${n}.url ${u}`);
      if (!lines.length) throw new Error('exit 1');
      return lines.join('\n');
    }
    if (args[0] === 'remote' && args[1] === 'add') {
      checkout.remotes[args[2]] = args[3];
      return '';
    }
    if (args[0] === 'status') return [checkout.dirty ? ' M file' : '', ...(checkout.untracked ?? []).map((f) => `?? ${f}`), ...(args.includes('--ignored') ? (checkout.ignored ?? []).map((f) => `!! ${f}`) : [])].filter(Boolean).join('\n');
    if (args[0] === 'rev-parse') return args.includes('--abbrev-ref') ? (checkout.branch ?? 'main') : (checkout.sha ?? 'a1b2c3d4e5f6a7b8c9d0');
    if (args[0] === 'symbolic-ref') {
      if (checkout.detached) throw new Error('exit 1');
      return 'refs/heads/main';
    }
    if (args[0] === 'rev-list') {
      if (checkout.ahead === undefined) throw new Error('no upstream');
      return String(checkout.ahead);
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function worldScan(world) {
  return () => Object.entries(world.checkouts).map(([path, c]) => ({
    path,
    linkedWorktree: Boolean(c.linkedWorktree),
    remotes: { ...c.remotes },
    repos: Object.fromEntries(Object.entries(c.remotes).map(([n, u]) => {
      try {
        return [n, parseRepoInput(u).fullName.toLowerCase()];
      } catch {
        return [n, null];
      }
    })),
  }));
}

function addProject(world, path) {
  let project = world.projects.find((p) => p.projectRootPath === path);
  if (!project) {
    project = { projectId: `prj_${++world.seq}`, projectRootPath: path, projectDisplayName: path.split('/').at(-1) };
    world.projects.push(project);
  }
  return project;
}

function addWorkspace(world, { path, title, metadata = {}, kind = 'local_checkout', id, createdAt = new Date(Date.now() + 1000).toISOString() }) {
  const project = addProject(world, path);
  const workspace = { id: id ?? `wks_${String(++world.seq).padStart(16, '0')}`, projectId: project.projectId, workspaceDirectory: path, workspaceKind: kind, title, name: title, metadata: structuredClone(metadata), createdAt, gitRuntime: { currentBranch: 'main', isDirty: false } };
  world.workspaces.push(workspace);
  return workspace;
}

function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, pendingPermissions: [], ...fields };
  world.agents.push(agent);
  return agent;
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? world.hiddenWorkspaces?.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  const createAgent = (opts) => {
    world.calls.push(['agent.create', opts]);
    const fingerprint = JSON.stringify({ ...opts, idempotencyKey: undefined });
    if (opts.idempotencyKey && world.receipts.has(opts.idempotencyKey)) {
      if (world.fingerprints.get(opts.idempotencyKey) !== fingerprint) throw new Error('agent_request_key_conflict');
      return agentHandle(world.receipts.get(opts.idempotencyKey));
    }
    if (world.hooks.failCreate?.(opts)) throw new Error(`simulated failure creating ${opts.title}`);
    const [provider, model] = opts.config.provider.split('/');
    const labels = { ...opts.labels };
    if (opts.parent) labels[PARENT_LABEL] = String(opts.parent);
    if (world.hooks.injectParent) labels[PARENT_LABEL] = world.hooks.injectParent;
    const agent = addAgent(world, { provider, model, title: opts.title, workspaceId: opts.workspaceId, labels, currentModeId: opts.config.modeId, cwd: findWs(opts.workspaceId).workspaceDirectory });
    if (opts.idempotencyKey) {
      world.receipts.set(opts.idempotencyKey, agent.id);
      world.fingerprints.set(opts.idempotencyKey, fingerprint);
    }
    if (world.hooks.dropResponseAfterCreate?.(opts)) throw new Error('socket closed before agent.create response');
    return agentHandle(agent.id);
  };
  const agentHandle = (id) => ({
    id,
    refresh: async () => ({ agent: structuredClone(findAgent(id)) }),
    send: async (text) => {
      if (world.hooks.sendFails) throw new Error('agent unreachable');
      world.calls.push(['agent.send', id, text]);
    },
    archive: async () => {
      findAgent(id).archivedAt = 'now';
      world.calls.push(['agent.archive', id]);
      return { archivedAt: 'now' };
    },
    timeline: { refetch: async () => ({ entries: [{ item: { type: 'assistant_message', text: world.hooks.lastMessage ?? 'Stand: Tests grün.' } }] }) },
    backgroundWork: { list: async () => [] },
  });
  const workspaceHandle = (id) => ({
    id,
    refresh: async () => {
      const snapshot = structuredClone(findWs(id));
      if (world.hooks.delayMs) await new Promise((r) => setTimeout(r, world.hooks.delayMs));
      return snapshot;
    },
    setMetadata: async (patch) => {
      if (world.hooks.delayMs) await new Promise((r) => setTimeout(r, world.hooks.delayMs));
      world.calls.push(['workspace.setMetadata', id, patch]);
      if (world.hooks.beforeSetMetadata) world.hooks.beforeSetMetadata();
      Object.assign(findWs(id).metadata, structuredClone(patch));
    },
    agents: { create: async (opts) => createAgent({ ...opts, workspaceId: id }) },
  });
  return {
    workspaces: {
      ref: workspaceHandle,
      create: async ({ source, title, metadata, idempotencyKey }) => {
        world.calls.push(['workspace.create', { source, title, metadata, idempotencyKey }]);
        const fingerprint = JSON.stringify({ source, title, metadata });
        if (world.receipts.has(idempotencyKey)) {
          if (world.fingerprints.get(idempotencyKey) !== fingerprint) throw new Error('workspace_request_key_conflict');
          return workspaceHandle(world.receipts.get(idempotencyKey));
        }
        const workspace = addWorkspace(world, { path: source.path, title, metadata });
        world.receipts.set(idempotencyKey, workspace.id);
        world.fingerprints.set(idempotencyKey, fingerprint);
        return workspaceHandle(workspace.id);
      },
      archive: async (id) => {
        world.calls.push(['workspace.archive', id]);
        return { workspaceId: id };
      },
    },
    agents: { ref: agentHandle, list: async () => ({ entries: structuredClone(world.agents), pageInfo: { hasMore: false } }) },
  };
}

function fakePaseoCli(world) {
  return (args) => {
    world.calls.push(['paseo', ...args]);
    if (args[0] === 'clone') {
      const [, repo, , parentDir] = args;
      const path = `${parentDir}/${repo.split('/')[1]}`;
      world.checkouts[path] = { remotes: { origin: `https://github.com/${repo}.git` } };
      if (world.hooks.cloneWithoutProject) return { checkoutPath: path, projectId: 'prj_lost' };
      return { checkoutPath: path, projectId: addProject(world, path).projectId };
    }
    if (args[0] === 'project') return { projectId: addProject(world, args[2]).projectId, path: args[2] };
    if (args[0] === 'agent' && args[1] === 'update') {
      const agent = world.agents.find((a) => a.id === args[2]);
      for (const pair of args[4].split(',')) {
        const [k, v] = pair.split('=');
        agent.labels[k] = v;
      }
      return { id: agent.id };
    }
    throw new Error(`unexpected paseo ${args.join(' ')}`);
  };
}

/** Filesystem view of the simulated world (same answers at plan and apply time). */
function worldFs(world) {
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const exists = (p) => p === '/p' || world.occupied.has(p) || world.symlinks.has(p) || p in world.checkouts || Object.keys(world.checkouts).some((c) => c.startsWith(`${p}/`));
  return {
    lstatSync: (p, opts) => {
      if (!exists(p)) throw enoent();
      const ino = world.inodes[p] ?? 7;
      return { isSymbolicLink: () => world.symlinks.has(p), isDirectory: () => !world.symlinks.has(p), dev: opts?.bigint ? 1n : 1, ino: opts?.bigint ? BigInt(ino) : ino };
    },
    realpathSync: (p) => p,
  };
}

/** Simulated `creation.subscribe` lookup over the fake daemon receipts. */
function fakeLookup(world) {
  return async (kind, key) => {
    world.calls.push(['receipt.lookup', kind, key]);
    if (world.hooks.lookupFails) throw new Error('socket closed');
    if (world.hooks.receiptOverride?.[key] !== undefined) return world.hooks.receiptOverride[key];
    if (!world.receipts.has(key)) return null;
    const id = world.receipts.get(key);
    if (kind === 'agent') {
      const agent = world.agents.find((a) => a.id === id);
      return { kind, idempotencyKey: key, phase: 'completed', error: null, agentId: id, workspaceId: agent?.workspaceId ?? null };
    }
    return { kind, idempotencyKey: key, phase: 'completed', error: null, workspaceId: id, workspace: { id } };
  };
}

function runnerFor(world, config = CONFIG) {
  return createRunner({
    config,
    client: null,
    gh: fakeGh(world),
    git: fakeGit(world),
    readState: async () => structuredClone({ projects: world.projects, workspaces: world.workspaces, agents: world.agents, providers: world.providers }),
    scan: worldScan(world),
    inspectTarget: (root, parentDir, expectedPath) => inspectCloneTarget(root, parentDir, expectedPath, worldFs(world)),
    realpath: (p) => p,
  });
}

async function plan(world, entries = [FIRMWARE], options = {}) {
  return (await runnerFor(world, options.config).runPlans(entries, options)).map((p) => p);
}

function executorsFor(world) {
  return createExecutors({ client: fakeClient(world), gh: fakeGh(world), git: fakeGit(world), paseoCli: fakePaseoCli(world), sleep: async () => {}, fs: worldFs(world) });
}

async function authorize(world, entries = [FIRMWARE], { config = CONFIG, allowFork = false, adopt = {}, slots } = {}) {
  const plans = await runnerFor(world, config).runPlans(entries, { allowFork, adopt, ...(slots ? { slots } : {}) });
  return createAuthorization(plans, config, { entries, allowFork, adopt, ...(slots ? { slots } : {}) });
}

/** Dry-run + confirm + apply; `tamper` rewrites what rediscovery observes. */
async function apply(world, entries = [FIRMWARE], { config = CONFIG, allowFork = false, adopt = {}, slots, journal, authorization, progress, tamper, execute } = {}) {
  const auth = authorization ?? (await authorize(world, entries, { config, allowFork, adopt, ...(slots ? { slots } : {}) }));
  const runner = runnerFor(world, config);
  return applyPlans({
    authorization: auth, config, confirm: auth.hash, progress, journal, lookupReceipt: fakeLookup(world),
    runPlans: async (list, options) => {
      const plans = await runner.runPlans(list, options);
      return tamper ? tamper(plans) : plans;
    },
    execute: execute ?? executorsFor(world),
  });
}

/** A fully provisioned firmware repository, as apply would leave it. */
function provisioned(world) {
  world.checkouts['/p/example-repo'] = { remotes: { origin: `https://github.com/${FIRMWARE}.git`, upstream: `https://github.com/${FW_PARENT}.git` } };
  const ws = addWorkspace(world, { path: '/p/example-repo', title: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: FIRMWARE, kind: 'github', locator: FIRMWARE } } } });
  const steers = {};
  for (const [slot, [provider, model]] of Object.entries({ A: ['codex', 'gpt-6.2-sol'], B: ['muse', 'muse-spark-1.3-contributor'], C: ['antigravity', 'gemini-3.8-flash-high'] })) {
    steers[slot] = addAgent(world, { provider, model, title: `Steer ${slot}`, workspaceId: ws.id, labels: { [LABEL.repo]: FIRMWARE, [LABEL.role]: 'steer', [LABEL.slot]: slot } });
  }
  return { ws, steers };
}

const keys = (p) => p.ops.map((op) => op.key);

// ---------------------------------------------------------------- GitHub

test('repository input: URL, SSH, shorthand, .git and trailing slash; rejects junk', () => {
  for (const input of ['https://github.com/example-owner/example-repo', 'https://github.com/example-owner/example-repo.git', 'https://github.com/example-owner/example-repo/', 'git@github.com:example-owner/example-repo.git', 'ssh://git@github.com/example-owner/example-repo', 'example-owner/example-repo']) {
    assert.equal(parseRepoInput(input).fullName, FIRMWARE, input);
  }
  for (const input of ['', 'example-repo', 'https://gitlab.com/a/b', '../etc', 'a/b/c', '../x', 'https://github.com/a']) {
    assert.throws(() => parseRepoInput(input), /Not a GitHub repository/, input);
  }
});

test('own fork: direct parent and original source are kept apart', () => {
  const result = resolveGitHub(fakeGh(makeWorld()), FIRMWARE, 'example-owner');
  assert.equal(result.fork.status, 'present');
  assert.equal(result.upstream.fullName, FW_PARENT);
  assert.equal(result.source.fullName, FW_SOURCE);
});

test('upstream input reuses an existing (renamed) fork in the same network', () => {
  const world = makeWorld();
  world.forks[FW_PARENT] = [FIRMWARE];
  const result = resolveGitHub(fakeGh(world), FW_PARENT, 'example-owner');
  assert.equal(result.fork.status, 'present');
  assert.equal(result.fork.repo.fullName, FIRMWARE);
  assert.equal(result.upstream.fullName, FW_PARENT);
});

test('same-named repository outside the fork network is a conflict, not a fork', () => {
  const world = makeWorld();
  world.repos['example-owner/source-repo'] = api('example-owner/source-repo');
  const result = resolveGitHub(fakeGh(world), FW_SOURCE, 'example-owner');
  assert.equal(result.fork.status, 'conflict');
});

test('renamed fork is found through the fork list; missing fork is reported', () => {
  const world = makeWorld();
  world.repos['example-owner/renamed-repo'] = api('example-owner/renamed-repo', { fork: true, parent: ref(FW_SOURCE), source: ref(FW_SOURCE) });
  world.forks[FW_SOURCE] = ['someone/x', 'example-owner/renamed-repo'];
  assert.equal(resolveGitHub(fakeGh(world), FW_SOURCE, 'example-owner').fork.repo.fullName, 'example-owner/renamed-repo');
  world.forks[FW_SOURCE] = ['example-owner/renamed-repo', 'example-owner/second-repo'];
  assert.equal(resolveGitHub(fakeGh(world), FW_SOURCE, 'example-owner').fork.status, 'conflict');
  const fresh = makeWorld();
  delete fresh.repos[FIRMWARE];
  assert.deepEqual(resolveGitHub(fakeGh(fresh), FW_PARENT, 'example-owner').fork, { status: 'missing', planned: 'example-owner/upstream-repo' });
});

test('source input finds a fork of an intermediate fork through the owner fork list', () => {
  const world = makeWorld();
  world.repos['example-owner/other'] = api('example-owner/other', { fork: true, parent: ref('y/x'), source: ref('y/x') });
  world.ownerForks = [{ nameWithOwner: 'example-owner/other' }, { nameWithOwner: FIRMWARE }];
  const result = resolveGitHub(fakeGh(world), FW_SOURCE, 'example-owner');
  assert.equal(result.fork.repo.fullName, FIRMWARE);
  assert.equal(result.upstream.fullName, FW_PARENT, 'the fork parent, not the requested source, is upstream');
});

test('permission errors are not mistaken for a missing fork', () => {
  const world = makeWorld();
  world.hooks.ghError = new Error('gh api failed: HTTP 403: Resource not accessible');
  assert.throws(() => resolveGitHub(fakeGh(world), FIRMWARE, 'example-owner'), /403/);
});

// ---------------------------------------------------------------- local checkouts

test('scan finds nested checkouts, skips hidden/build dirs, dedups symlinks, marks worktrees', () => {
  const tree = {
    '/p': ['a', 'group', '.hidden', 'node_modules', 'link'],
    '/p/group': ['deep'],
    '/p/group/deep': ['repo'],
  };
  const gitDirs = { '/p/a': 'dir', '/p/group/deep/repo': 'file', '/p/.hidden/x': 'dir', '/elsewhere/known': 'dir' };
  const real = { '/p/link': '/p/a' };
  const fs = {
    existsSync: (p) => p.endsWith('/.git') && p.slice(0, -5) in gitDirs || p.endsWith('/.git') && real[p.slice(0, -5)] !== undefined,
    readdirSync: (dir) => (tree[dir] ?? []).map((name) => ({ name, isDirectory: () => true })),
    realpathSync: (p) => real[p] ?? p,
    lstatSync: (p) => ({ isFile: () => gitDirs[p.slice(0, -5)] === 'file' }),
  };
  const git = (cwd) => (cwd === '/p/a' ? 'remote.origin.url https://github.com/Example-Owner/a.git' : '');
  const found = scanCheckouts({ roots: ['/p'], knownDirs: ['/elsewhere/known', '/not/a/repo'], git, fs });
  assert.deepEqual(found.map((c) => c.path).sort(), ['/elsewhere/known', '/p/a', '/p/group/deep/repo']);
  assert.equal(found.find((c) => c.path === '/p/a').repos.origin, 'example-owner/a');
  assert.equal(found.find((c) => c.path === '/p/group/deep/repo').linkedWorktree, true);
});

test('only origin == fork is reusable; fork under another remote or upstream clones are related', () => {
  const mk = (path, remotes, linkedWorktree = false) => ({ path, linkedWorktree, remotes, repos: Object.fromEntries(Object.entries(remotes).map(([n, u]) => [n, parseRepoInput(u).fullName.toLowerCase()])) });
  const { exact, related } = classifyCheckouts([
    mk('/p/good', { origin: `https://github.com/${FIRMWARE}` }),
    mk('/p/other-remote', { origin: `https://github.com/${FW_PARENT}`, mine: `https://github.com/${FIRMWARE}` }),
    mk('/p/source', { origin: `https://github.com/${FW_SOURCE}` }),
    mk('/p/wt', { origin: `https://github.com/${FIRMWARE}` }, true),
    mk('/p/unrelated', { origin: 'https://github.com/x/y' }),
  ], { fork: FIRMWARE, upstream: FW_PARENT, source: FW_SOURCE });
  assert.deepEqual(exact.map((c) => c.path), ['/p/good']);
  assert.deepEqual(related.map((c) => c.path), ['/p/other-remote', '/p/source']);
});

test('path containment rejects traversal and sibling prefixes', () => {
  assert.equal(isWithin('/p', '/p/a/b'), true);
  assert.equal(isWithin('/p', '/p'), true);
  assert.equal(isWithin('/p', '/p/../etc'), false);
  assert.equal(isWithin('/p', '/px/a'), false);
});

// ---------------------------------------------------------------- planning

test('fresh repository: clone, upstream remote, main workspace, three parent-free steers', async () => {
  const [p] = await plan(makeWorld());
  assert.equal(p.status, 'pending');
  assert.deepEqual(keys(p), ['checkout.clone', 'checkout.upstream-remote', 'workspace.main', 'steer.A', 'steer.B', 'steer.C']);
  const steer = p.ops.find((op) => op.key === 'steer.A').params;
  assert.equal(steer.title, 'Steer A');
  assert.equal('parent' in steer, false);
  assert.equal('prompt' in steer, false);
  assert.deepEqual(steer.config, { provider: 'codex/gpt-6.2-sol', modeId: 'full-access', thinkingOptionId: 'high' });
  assert.equal(p.ops.find((op) => op.key === 'workspace.main').params.title, 'Main');
  assert.equal(p.ops.find((op) => op.key === 'checkout.upstream-remote').params.url, `https://github.com/${FW_PARENT}.git`);
});

test('fully provisioned repository plans nothing', async () => {
  const world = makeWorld();
  provisioned(world);
  const [p] = await plan(world);
  assert.equal(p.status, 'complete');
  assert.deepEqual(p.ops, []);
});

test('checkout without Paseo project (interrupted clone registration) registers the project', async () => {
  const world = makeWorld();
  world.checkouts['/p/example-repo'] = { remotes: { origin: `https://github.com/${FIRMWARE}`, upstream: `https://github.com/${FW_PARENT}` } };
  const [p] = await plan(world);
  assert.deepEqual(keys(p), ['paseo.project', 'workspace.main', 'steer.A', 'steer.B', 'steer.C']);
});

test('occupied target directory is a conflict and nothing else is planned on it', async () => {
  const world = makeWorld();
  world.checkouts['/p/example-repo'] = { remotes: { origin: `https://github.com/${FW_SOURCE}` } };
  const [p] = await plan(world);
  assert.equal(p.status, 'conflict');
  assert.match(p.conflicts[0].reason, /already exists/);
  world.checkouts = {};
  world.occupied.add('/p/example-repo');
  assert.equal((await plan(world))[0].status, 'conflict');
});

test('several checkouts of the fork need an explicit choice', async () => {
  const world = makeWorld();
  for (const path of ['/p/x/one', '/p/y/two']) world.checkouts[path] = { remotes: { origin: `https://github.com/${FIRMWARE}`, upstream: `https://github.com/${FW_PARENT}` } };
  const [p] = await plan(world);
  assert.equal(p.status, 'conflict');
  assert.deepEqual(p.ops, []);
  const [chosen] = await plan(world, [{ repo: FIRMWARE, checkout: '/p/y/two' }]);
  assert.equal(chosen.ops.find((op) => op.key === 'workspace.main').params.path, '/p/y/two');
});

test('upstream remote: missing is added, a different URL is a conflict', async () => {
  const world = makeWorld();
  world.checkouts['/p/example-repo'] = { remotes: { origin: `git@github.com:${FIRMWARE}.git` } };
  addProject(world, '/p/example-repo');
  assert.ok(keys((await plan(world))[0]).includes('checkout.upstream-remote'));
  world.checkouts['/p/example-repo'].remotes.upstream = `https://github.com/${FW_SOURCE}`;
  const [p] = await plan(world);
  assert.equal(p.conflicts[0].key, 'checkout.upstream-remote');
});

test('two main workspaces on the checkout are a conflict; task workspaces are not adopted', async () => {
  const world = makeWorld();
  world.checkouts['/p/example-repo'] = { remotes: { origin: `https://github.com/${FIRMWARE}`, upstream: `https://github.com/${FW_PARENT}` } };
  addWorkspace(world, { path: '/p/example-repo', title: 'Fix spindle PWM' });
  let [p] = await plan(world);
  assert.equal(p.ops.find((op) => op.key === 'workspace.main').kind, 'paseo.workspace.create');
  assert.ok(p.notes.some((n) => n.includes('Fix spindle PWM')));
  addWorkspace(world, { path: '/p/example-repo', title: 'Main' });
  addWorkspace(world, { path: '/p/example-repo', title: 'example-repo · Main' });
  [p] = await plan(world);
  assert.equal(p.conflicts[0].key, 'workspace.main');
});

test('existing Main workspace without factory metadata is adopted, not recreated', async () => {
  const world = makeWorld();
  world.checkouts['/p/example-repo'] = { remotes: { origin: `https://github.com/${FIRMWARE}`, upstream: `https://github.com/${FW_PARENT}` } };
  const ws = addWorkspace(world, { path: '/p/example-repo', title: 'Main' });
  const [p] = await plan(world);
  assert.equal(p.ops[0].kind, 'paseo.workspace.metadata');
  assert.equal(p.ops.find((op) => op.key === 'steer.A').params.workspaceId, ws.id);
});

test('parent-linked steers are conflicts, never reused (labelled or legacy title)', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  steers.B.labels[PARENT_LABEL] = 'main-agent';
  let [p] = await plan(world);
  assert.deepEqual(p.conflicts.map((c) => c.key), ['steer.B']);
  const legacyWorld = makeWorld();
  legacyWorld.checkouts['/p/example-repo'] = { remotes: { origin: `https://github.com/${FIRMWARE}`, upstream: `https://github.com/${FW_PARENT}` } };
  const ws = addWorkspace(legacyWorld, { path: '/p/example-repo', title: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } } });
  addAgent(legacyWorld, { title: 'Steer A', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id, labels: { [PARENT_LABEL]: 'coordinator-main' } });
  [p] = await plan(legacyWorld);
  assert.equal(p.conflicts[0].key, 'steer.A');
  assert.match(p.conflicts[0].reason, /has parent coordinator-main/);
});

function legacyWorld(agents) {
  const world = makeWorld();
  world.checkouts['/p/example-repo'] = { remotes: { origin: `https://github.com/${FIRMWARE}`, upstream: `https://github.com/${FW_PARENT}` } };
  const ws = addWorkspace(world, { path: '/p/example-repo', title: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: FIRMWARE, kind: 'github', locator: FIRMWARE } } } });
  const created = agents.map((fields) => addAgent(world, { provider: 'claude', model: 'claude-opus-5-5', workspaceId: ws.id, ...fields }));
  return { world, ws, created };
}

test('unlabelled "Steer A" is only a candidate: no adoption without explicit confirmation', async () => {
  const { world, created: [legacy] } = legacyWorld([{ title: 'Steer A' }]);
  const [p] = await plan(world);
  const blocked = p.conflicts.find((c) => c.key === 'steer.A');
  assert.match(blocked.reason, new RegExp(`--adopt A=${legacy.id}`));
  assert.equal(p.ops.some((op) => op.key === 'steer.A'), false);
});

test('confirmed adoption labels the candidate without renaming it and reports model drift', async () => {
  const { world, created: [legacy] } = legacyWorld([{ title: 'Steer A' }]);
  const adopt = { '*': { A: legacy.id } };
  const [p] = await plan(world, [FIRMWARE], { adopt });
  const op = p.ops.find((o) => o.key === 'steer.A');
  assert.equal(op.kind, 'paseo.agent.adopt');
  assert.ok(p.notes.some((n) => n.includes('claude/claude-opus-5-5')));
  const { report } = await apply(world, [FIRMWARE], { adopt });
  assert.equal(report[0].status, 'complete', report[0].error);
  const update = world.calls.find((c) => c[0] === 'paseo' && c[1] === 'agent');
  assert.equal(update.includes('--name'), false, 'title is never changed');
  assert.equal(world.agents.find((a) => a.id === legacy.id).title, 'Steer A');
  assert.equal(world.agents.find((a) => a.id === legacy.id).labels[LABEL.slot], 'A');
});

test('invalid or ambiguous adoption is refused', async () => {
  // wrong id
  let { world } = legacyWorld([{ title: 'Steer A' }]);
  let [p] = await plan(world, [FIRMWARE], { adopt: { '*': { A: 'agent-999' } } });
  assert.match(p.conflicts.find((c) => c.key === 'steer.A').reason, /does not name/);
  // two candidates, even when one is confirmed
  ({ world } = legacyWorld([{ title: 'Steer A' }, { title: 'Steer A' }]));
  const first = world.agents[0].id;
  [p] = await plan(world, [FIRMWARE], { adopt: { '*': { A: first } } });
  assert.match(p.conflicts.find((c) => c.key === 'steer.A').reason, /Several unlabelled/);
  // parented candidate
  ({ world } = legacyWorld([{ title: 'Steer A', labels: { [PARENT_LABEL]: 'main' } }]));
  [p] = await plan(world, [FIRMWARE], { adopt: { '*': { A: world.agents[0].id } } });
  assert.match(p.conflicts.find((c) => c.key === 'steer.A').reason, /has parent main/);
  // slot not prepared, or slot already labelled with another agent (double adoption)
  const labelled = makeWorld();
  const { steers } = provisioned(labelled);
  [p] = await plan(labelled, [FIRMWARE], { adopt: { '*': { A: 'agent-x1', Z: steers.B.id } } });
  assert.deepEqual(p.conflicts.map((c) => c.key).sort(), ['steer.A', 'steer.Z']);
  // an agent titled "Steer A" that already has a different factory role is not a candidate
  ({ world } = legacyWorld([{ title: 'Steer A', labels: { [LABEL.role]: 'worker' } }]));
  [p] = await plan(world);
  assert.equal(p.ops.find((o) => o.key === 'steer.A').kind, 'paseo.agent.create');
});

test('labelled steer with a changed model configuration is reused, only reported', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  steers.A.model = 'gpt-6.1-sol';
  const [p] = await plan(world);
  assert.equal(p.status, 'complete');
  assert.ok(p.notes.some((n) => n.includes('codex/gpt-6.1-sol') && n.includes('kept, no recreation')));
});

test('steer outside the main workspace and duplicate slot labels are conflicts', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  steers.A.workspaceId = 'wks_elsewhere';
  addAgent(world, { title: 'Steer C copy', provider: 'muse', model: 'm', workspaceId: steers.C.workspaceId, labels: { ...steers.C.labels } });
  const [p] = await plan(world);
  assert.deepEqual(p.conflicts.map((c) => c.key).sort(), ['steer.A', 'steer.C']);
});

test('archived steer slot is recreated under a new idempotency generation', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  steers.B.archivedAt = '2026-11-01';
  const [p] = await plan(world);
  assert.deepEqual(keys(p), ['steer.B']);
  assert.match(p.ops[0].params.idempotencyKey, /:steer:B:g2:[0-9a-f]{10}$/);
});

test('profiles are validated against the live provider catalog per slot', async () => {
  const world = makeWorld();
  world.providers.find((e) => e.provider === 'muse').modes = [{ id: 'onRequest' }];
  const [p] = await plan(world);
  assert.deepEqual(p.conflicts.map((c) => c.key), [], 'slot B falls back to the next startable profile instead of conflicting');
  assert.ok(p.notes.some((n) => /Steer B: profile "muse" is not startable.*mode "allowAll" is not available.*using fallback "agy"/.test(n)), `fallback note names the reason and the fallback: ${JSON.stringify(p.notes)}`);
  assert.equal(p.ops.find((o) => o.key === 'steer.B').params.config.provider, 'antigravity/gemini-3.8-flash-high');
  assert.ok(keys(p).includes('steer.A') && keys(p).includes('steer.C'));
});

test('steer slots conflict with the tried reasons only when no fallback is startable', async () => {
  const world = makeWorld();
  for (const e of world.providers) e.modes = [];
  const [p] = await plan(world);
  assert.equal(p.status, 'conflict');
  assert.deepEqual(p.conflicts.map((c) => c.key).sort(), ['steer.A', 'steer.B', 'steer.C']);
  assert.match(p.conflicts.find((c) => c.key === 'steer.B').reason, /Profile "muse" for Steer B is not startable.*no fallback available; tried/);
});

test('role is independent of provider: a different slot assignment only changes the profile', async () => {
  const config = structuredClone(CONFIG);
  config.steers.slots = { A: 'agy', B: 'sol', C: 'muse' };
  const [p] = await plan(makeWorld(), [FIRMWARE], { config });
  assert.equal(p.ops.find((op) => op.key === 'steer.A').params.config.provider, 'antigravity/gemini-3.8-flash-high');
  assert.equal(p.ops.find((op) => op.key === 'steer.A').params.title, 'Steer A');
});

test('missing fork needs --allow-fork', async () => {
  const world = makeWorld();
  delete world.repos[FIRMWARE];
  let [p] = await plan(world, [FW_PARENT]);
  assert.equal(p.conflicts[0].key, 'github.fork');
  [p] = await plan(world, [FW_PARENT], { allowFork: true });
  assert.equal(p.ops[0].kind, 'github.fork');
});

test('workers of the steers are reported even in other worktree workspaces', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const wt = addWorkspace(world, { path: '/home/user/.paseo/worktrees/x/fix', title: 'fix', kind: 'worktree' });
  addAgent(world, { title: 'Worker 1 · PWM', workspaceId: wt.id, provider: 'muse', model: 'm', labels: { [PARENT_LABEL]: steers.A.id } });
  const [p] = await plan(world);
  assert.equal(p.status, 'complete');
  assert.ok(p.notes.some((n) => n.includes('Worker 1 · PWM')));
});

test('plan hash is stable for the same state and changes with config', async () => {
  const world = makeWorld();
  const a = planHash(await plan(world), CONFIG);
  assert.equal(planHash(await plan(world), CONFIG), a);
  const config = structuredClone(CONFIG);
  config.profiles.sol.thinking = 'low';
  assert.notEqual(planHash(await plan(world, [FIRMWARE], { config }), config), a);
});

// ---------------------------------------------------------------- apply

test('apply refuses without the stored hash, after config change or after state drift', async () => {
  const world = makeWorld();
  const auth = await authorize(world);
  const runner = runnerFor(world);
  const args = { authorization: auth, config: CONFIG, runPlans: (l, o) => runner.runPlans(l, o), execute: executorsFor(world) };
  await assert.rejects(applyPlans({ ...args, confirm: undefined }), ApplyRefused);
  await assert.rejects(applyPlans({ ...args, confirm: 'deadbeefdeadbeef' }), ApplyRefused);
  const changed = structuredClone(CONFIG);
  changed.profiles.muse.model = 'muse-spark-1.2';
  await assert.rejects(applyPlans({ ...args, config: changed, confirm: auth.hash }), /does not match the current config/);
  const tampered = structuredClone(auth);
  tampered.plans[0].ops[0].params.parentDir = '/p/elsewhere';
  await assert.rejects(applyPlans({ ...args, authorization: tampered, confirm: auth.hash }), /altered/);
  world.checkouts['/p/example-repo'] = { remotes: { origin: `https://github.com/${FIRMWARE}` } }; // someone cloned meanwhile
  await assert.rejects(applyPlans({ ...args, confirm: auth.hash }), /State changed since the dry-run/);
  assert.equal(world.calls.filter((c) => !['gh', 'git'].includes(c[0])).length, 0, 'no writes');
});

test('apply provisions end to end, verifies parent freedom, and a rerun is a no-op', async () => {
  const world = makeWorld();
  const events = [];
  const { report } = await apply(world, [FIRMWARE], { journal: (e) => events.push(e) });
  assert.equal(report[0].status, 'complete', report[0].error);
  assert.deepEqual(report[0].executed.map((e) => e.key), ['checkout.clone', 'checkout.upstream-remote', 'workspace.main', 'steer.A', 'steer.B', 'steer.C']);
  const steers = world.agents.filter((a) => a.labels[LABEL.role] === 'steer');
  assert.equal(steers.length, 3);
  assert.ok(steers.every((a) => !(PARENT_LABEL in a.labels)));
  const creates = world.calls.filter((c) => c[0] === 'agent.create').map((c) => c[1]);
  assert.ok(creates.every((o) => o.parent === undefined && o.prompt === undefined && o.idempotencyKey));
  assert.deepEqual(world.checkouts['/p/example-repo'].remotes.upstream, `https://github.com/${FW_PARENT}.git`);
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].activeSteer, 'A');
  assert.equal(events.filter((e) => e.event === 'done').length, 6);

  const before = world.calls.length;
  const rerun = await apply(world);
  assert.equal(rerun.report[0].status, 'complete');
  assert.deepEqual(rerun.report[0].executed, []);
  assert.equal(world.calls.slice(before).filter((c) => !['gh', 'git'].includes(c[0])).length, 0, 'second apply writes nothing');
  assert.equal(world.projects.length, 1);
  assert.equal(world.workspaces.length, 1);
});

test('failure mid-way stops the repo; the next run continues with only the missing steps', async () => {
  const world = makeWorld();
  world.hooks.failCreate = (opts) => opts.title === 'Steer B';
  const first = await apply(world);
  assert.equal(first.report[0].status, 'failed');
  assert.match(first.report[0].error, /Steer B/);
  assert.deepEqual(first.report[0].executed.map((e) => e.key), ['checkout.clone', 'checkout.upstream-remote', 'workspace.main', 'steer.A']);
  delete world.hooks.failCreate;
  const second = await apply(world);
  assert.deepEqual(second.report[0].executed.map((e) => e.key), ['steer.B', 'steer.C']);
  assert.equal(world.agents.filter((a) => a.labels[LABEL.slot] === 'A').length, 1, 'no duplicate Steer A');
});

test('recovery resumes the same confirmed plan with its stored progress', async () => {
  const world = makeWorld();
  const authorization = await authorize(world);
  const progress = memoryProgress();
  world.hooks.failCreate = (opts) => opts.title === 'Steer B';
  const first = await apply(world, [FIRMWARE], { authorization, progress });
  assert.equal(first.report[0].status, 'failed');
  delete world.hooks.failCreate;
  const resumed = await apply(world, [FIRMWARE], { authorization, progress });
  assert.equal(resumed.report[0].status, 'complete', resumed.report[0].error);
  assert.deepEqual(resumed.report[0].executed.map((e) => e.key), ['steer.B', 'steer.C']);
  const wsId = world.workspaces[0].id;
  assert.ok(world.agents.every((a) => a.workspaceId === wsId), 'reference resolved from the verified workspace result');
  const keys = world.calls.filter((c) => c[0] === 'agent.create').map((c) => c[1].idempotencyKey);
  const authorizedKeys = authorization.plans[0].ops.filter((o) => o.kind === 'paseo.agent.create').map((o) => o.params.idempotencyKey);
  assert.ok(keys.every((k) => authorizedKeys.includes(k)), 'executed with the authorized idempotency keys');
  // the old confirmation without its progress cannot be reused on the changed state
  await assert.rejects(apply(world, [FIRMWARE], { authorization: structuredClone(authorization), progress: memoryProgress() }), /State changed since the dry-run/);
});

test('clone without project registration recovers through project registration', async () => {
  const world = makeWorld();
  world.hooks.cloneWithoutProject = true;
  const first = await apply(world);
  assert.equal(first.report[0].status, 'complete');
  assert.ok(first.report[0].executed.some((e) => e.key === 'paseo.project'));
  assert.equal(world.projects.length, 1);
});

test('a parent appearing on a created steer is detected and stops apply', async () => {
  const world = makeWorld();
  world.hooks.injectParent = 'coordinator-agent';
  const { report } = await apply(world);
  assert.equal(report[0].status, 'failed');
  assert.match(report[0].error, /PARENT VIOLATION/);
  assert.equal(world.agents.length, 1, 'stopped after the first steer');
});

test('an operation that was not confirmed aborts apply', async () => {
  const world = makeWorld();
  let step = 0;
  const { report } = await apply(world, [FIRMWARE], {
    tamper: (plans) => {
      if (step++ > 0) plans[0].ops.unshift({ key: 'surprise', kind: 'paseo.clone', params: {} });
      return plans;
    },
  });
  assert.match(report[0].error, /not part of the confirmed plan/);
  assert.equal(world.calls.filter((c) => c[0] === 'paseo').length, 0);
});

/** Applies with one observed field altered after the start check; nothing must be written. */
async function applyWithObservedChange(mutate, { prepare } = {}) {
  const world = makeWorld();
  if (prepare) prepare(world);
  let step = 0;
  const result = await apply(world, [FIRMWARE], {
    tamper: (plans) => {
      if (step++ > 0) mutate(plans[0]);
      return plans;
    },
  });
  return { world, report: result.report[0] };
}

test('rediscovered parameters never extend the authorization (clone path, remotes, repo, kind)', async () => {
  const cases = [
    ['clone path', (p) => (p.ops[0].params.expectedPath = '/p/other/example-repo'), /expectedPath differs/],
    ['clone parent', (p) => (p.ops[0].params.parentDir = '/p/other'), /parentDir differs/],
    ['clone repo', (p) => (p.ops[0].params.repo = 'example-owner/evil'), /repo differs/],
    ['repository identity', (p) => (p.repo = 'example-owner/other'), /identity changed/],
    ['operation kind', (p) => (p.ops[0].kind = 'git.remote.add'), /kind git.remote.add instead of paseo.clone/],
  ];
  for (const [name, mutate, expected] of cases) {
    const { world, report } = await applyWithObservedChange(mutate);
    assert.equal(report.status, 'failed', name);
    assert.match(report.error, expected, name);
    assert.equal(world.calls.filter((c) => c[0] === 'paseo').length, 0, `${name}: nothing cloned`);
  }
  // upstream remote URL drift after the clone step
  let step = 0;
  const world = makeWorld();
  const { report } = await apply(world, [FIRMWARE], {
    tamper: (plans) => {
      const op = plans[0].ops.find((o) => o.key === 'checkout.upstream-remote');
      if (step++ > 0 && op) op.params.url = 'https://github.com/attacker/fw.git';
      return plans;
    },
  });
  assert.match(report[0].error, /url differs/);
  assert.equal(world.checkouts['/p/example-repo'].remotes.upstream, undefined, 'remote not added');
});

test('changed provider/model or workspace placement of a steer is refused', async () => {
  const cases = [
    ['model', (op) => (op.params.config.provider = 'codex/gpt-6.2-astra'), /config differs/],
    ['labels', (op) => (op.params.labels['wsf.slot'] = 'Z'), /labels differs/],
    ['title', (op) => (op.params.title = 'Steer Z'), /title differs/],
    ['workspace', (op) => (op.params.workspaceId = 'wks_foreign000000001'), /workspaceId differs/],
  ];
  for (const [name, change, expected] of cases) {
    const world = makeWorld();
    const { report } = await apply(world, [FIRMWARE], {
      tamper: (plans) => {
        const op = plans[0].ops.find((o) => o.key === 'steer.A');
        if (op && typeof op.params.workspaceId === 'string') change(op);
        return plans;
      },
    });
    assert.equal(report[0].status, 'failed', name);
    assert.match(report[0].error, expected, name);
    assert.equal(world.agents.length, 0, `${name}: no agent created`);
  }
});

test('symbolic workspace reference resolves only from this plan\'s verified result', async () => {
  // Someone else's Main workspace appears after the dry-run: the steer would target it.
  const world = makeWorld();
  const authorization = await authorize(world);
  assert.deepEqual(authorization.plans[0].ops.find((o) => o.key === 'steer.A').params.workspaceId, WORKSPACE_REF);
  let step = 0;
  const { report } = await apply(world, [FIRMWARE], {
    authorization,
    tamper: (plans) => {
      if (step++ === 3) {
        // after clone + remote: a foreign Main workspace was created, so the plan skips workspace.main
        const foreign = addWorkspace(world, { path: '/p/example-repo', title: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: FIRMWARE, kind: 'github', locator: FIRMWARE } } } });
        world.hooks.foreign = foreign.id;
        return runnerFor(world).runPlans([FIRMWARE]);
      }
      return plans;
    },
  });
  assert.equal(report[0].status, 'failed');
  assert.match(report[0].error, /main workspace reference is unresolved/);
  assert.equal(world.calls.filter((c) => c[0] === 'receipt.lookup').length, 0, 'a never-attempted create is not reconciled');
  assert.equal(world.agents.length, 0);
});

test('executor guards: unsafe or changed clone targets and foreign remotes are refused', async () => {
  const world = makeWorld();
  const execute = executorsFor(world);
  const guard = inspectCloneTarget('/p', '/p', '/p/example-repo', worldFs(world));
  const clone = (params) => execute({ kind: 'paseo.clone', params: { repo: FIRMWARE, protocol: 'https', parentDir: '/p', expectedPath: '/p/example-repo', guard, ...params } }, CONFIG);
  await assert.rejects(clone({ parentDir: '/etc', expectedPath: '/etc/example-repo' }), /unsafe/);
  world.occupied.add('/p/example-repo');
  await assert.rejects(clone({}), /already exists/);
  world.occupied.clear();
  world.inodes['/p'] = 99; // parent replaced since the dry-run
  await assert.rejects(clone({}), /changed since the dry-run/);
  world.checkouts['/p/r'] = { remotes: { origin: `https://github.com/${FIRMWARE}`, upstream: 'x' } };
  await assert.rejects(execute({ kind: 'git.remote.add', params: { path: '/p/r', origin: FIRMWARE, name: 'upstream', url: 'y' } }, CONFIG), /already exists/);
  world.checkouts['/p/s'] = { remotes: { origin: 'https://github.com/someone/else' } };
  await assert.rejects(execute({ kind: 'git.remote.add', params: { path: '/p/s', origin: FIRMWARE, name: 'upstream', url: 'y' } }, CONFIG), /origin is/);
  assert.equal(world.calls.filter((c) => c[0] === 'paseo' || (c[0] === 'git' && c[3] === 'remote')).length, 0);
});

test('adopting a legacy steer re-checks the agent before labelling', async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { path: '/p/x', title: 'Main' });
  const agent = addAgent(world, { title: 'Steer A', workspaceId: ws.id, labels: { [PARENT_LABEL]: 'late-parent' } });
  await assert.rejects(executorsFor(world)({ kind: 'paseo.agent.adopt', params: { agentId: agent.id, labels: { [LABEL.role]: 'steer' } } }, CONFIG), /has parent late-parent/);
  assert.equal(world.calls.filter((c) => c[0] === 'paseo').length, 0);
});

test('apply aborted after the daemon already created a steer resumes without a duplicate', async () => {
  const world = makeWorld();
  world.hooks.dropResponseAfterCreate = (opts) => opts.title === 'Steer B';
  const first = await apply(world);
  assert.equal(first.report[0].status, 'failed');
  assert.match(first.report[0].error, /socket closed/);
  assert.equal(world.agents.filter((a) => a.labels[LABEL.slot] === 'B').length, 1, 'the daemon did create Steer B');
  delete world.hooks.dropResponseAfterCreate;
  const second = await apply(world);
  assert.deepEqual(second.report[0].executed.map((e) => e.key), ['steer.C']);
  assert.equal(world.agents.filter((a) => a.labels[LABEL.slot] === 'B').length, 1);
});

test('changed config after an aborted create uses a new key instead of a key conflict', async () => {
  const world = makeWorld();
  world.hooks.failCreate = (opts) => opts.title === 'Steer B';
  await apply(world);
  delete world.hooks.failCreate;
  const config = structuredClone(CONFIG);
  config.profiles.muse.mode = 'onRequest';
  const [before] = await plan(world);
  const [after] = await plan(world, [FIRMWARE], { config });
  assert.notEqual(before.ops[0].params.idempotencyKey, after.ops[0].params.idempotencyKey);
  const { report } = await apply(world, [FIRMWARE], { config });
  assert.equal(report[0].status, 'complete', report[0].error);
});

// ---------------------------------------------------------------- steer switching

async function discoveryOf(world) {
  return (await runnerFor(world).discoverAll([FIRMWARE]))[0];
}

const LOCK_TMP = mkdtempSync(join(tmpdir(), 'wsf-lock-'));
const testLock = (name, fn) => withLock(name, fn, { dir: LOCK_TMP });
const noLock = (_name, fn) => fn({ verify() {} });

test('switch dry-run: deterministic handoff, missing checkpoint flagged, nothing written', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  world.checkouts['/p/example-repo'].sha = 'f00dfeedbeef00112233';
  world.checkouts['/p/example-repo'].untracked = ['notes.txt'];
  addAgent(world, { title: 'Worker 1 · Tests', provider: 'muse', model: 'm', workspaceId: 'wks_wt', labels: { [PARENT_LABEL]: steers.A.id } });
  world.hooks.lastMessage = 'Als Nächstes Spindel-PWM. '.repeat(200);
  const result = await switchSteer({ client: fakeClient(world), discovery: await discoveryOf(world), toSlot: 'B', git: fakeGit(world), lock: testLock, language: 'de' });
  assert.equal(result.applied, false);
  assert.equal(result.checkpoint, false);
  assert.match(result.packet, /Aufgaben-Checkpoint: KEINER DOKUMENTIERT/);
  assert.match(result.packet, /Git: main @ f00dfeedbeef · 1 geänderte\/untracked Pfade/);
  assert.match(result.packet, /Worker 1 · Tests/);
  assert.match(result.packet, /Unverifizierter Hinweis/);
  assert.ok(result.packetChars < 2000, `bounded size (${result.packetChars} chars)`);
  const again = await switchSteer({ client: fakeClient(world), discovery: await discoveryOf(world), toSlot: 'B', git: fakeGit(world), lock: testLock, language: 'de' });
  assert.equal(again.packet, result.packet, 'same state, same text');
  assert.equal(world.calls.filter((c) => c[0].startsWith('workspace.') || c[0] === 'agent.send').length, 0);
});

test('handoff uses a documented checkpoint and flags one from an older epoch', async () => {
  const world = makeWorld();
  provisioned(world);
  await writeCheckpoint({ client: fakeClient(world), discovery: await discoveryOf(world), task: 'Spindel-PWM entprellen', tests: ['pytest tests/test_pwm.py'], blockers: ['Datenblatt fehlt'], lock: testLock, language: 'de' });
  let result = await switchSteer({ client: fakeClient(world), discovery: await discoveryOf(world), toSlot: 'B', git: fakeGit(world), lock: testLock, language: 'de' });
  assert.match(result.packet, /Auftrag: Spindel-PWM entprellen/);
  assert.match(result.packet, /Tests: pytest tests\/test_pwm.py/);
  assert.match(result.packet, /Offene Blocker: Datenblatt fehlt/);
  assert.doesNotMatch(result.packet, /NICHT aus der aktuellen Epoch/);
  world.workspaces[0].metadata[METADATA_KEY].epoch = 3;
  result = await switchSteer({ client: fakeClient(world), discovery: await discoveryOf(world), toSlot: 'B', git: fakeGit(world), lock: testLock, language: 'de' });
  assert.match(result.packet, /NICHT aus der aktuellen Epoch/);
});

test('switch apply: locked check-and-write, one handoff; a failed delivery keeps the switch', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const result = await switchSteer({ client: fakeClient(world), discovery: await discoveryOf(world), toSlot: 'C', apply: true, git: fakeGit(world), lock: testLock });
  assert.equal(result.applied && result.delivered, true);
  assert.deepEqual({ ...world.workspaces[0].metadata[METADATA_KEY], switchedAt: undefined }, { main: true, activeSteer: 'C', activeAgentId: steers.C.id, epoch: 2, previousSteer: 'A', scope: { id: FIRMWARE, kind: 'github', locator: FIRMWARE }, switchedAt: undefined });
  assert.deepEqual(world.calls.filter((c) => c[0] === 'agent.send').map((c) => c[1]), [steers.C.id]);
  world.hooks.sendFails = true;
  const next = await switchSteer({ client: fakeClient(world), discovery: await discoveryOf(world), toSlot: 'A', apply: true, lock: testLock });
  assert.equal(next.applied, true);
  assert.equal(next.delivered, false);
  assert.match(next.deliveryError, /unreachable/);
});

test('two simultaneous switches from the same state: exactly one succeeds (and without the lock both would)', async () => {
  for (const [lock, expectedWinners] of [[testLock, 1], [noLock, 2]]) {
    const world = makeWorld();
    provisioned(world);
    world.hooks.delayMs = 15; // widen the read/check/write window
    const discovery = await discoveryOf(world);
    const results = await Promise.allSettled([
      switchSteer({ client: fakeClient(world), discovery, toSlot: 'B', apply: true, send: false, lock }),
      switchSteer({ client: fakeClient(world), discovery, toSlot: 'C', apply: true, send: false, lock }),
    ]);
    const winners = results.filter((r) => r.status === 'fulfilled');
    assert.equal(winners.length, expectedWinners, lock === noLock ? 'race demonstration' : 'lock + epoch check');
    if (lock === testLock) {
      assert.match(results.find((r) => r.status === 'rejected').reason.message, /is held by|Steer state changed/);
      assert.equal(world.workspaces[0].metadata[METADATA_KEY].epoch, 2);
      assert.equal(world.workspaces[0].metadata[METADATA_KEY].activeSteer, winners[0].value.to);
    }
  }
});

// Real processes against a real lock directory. CONTENDER tries once (busy/acquired),
// HOLDER keeps the lock for the given milliseconds after printing "holding".
const LOCK_URL = new URL('../src/lock.mjs', import.meta.url).href;
function lockProcess(dir, mode, holdMs = 0) {
  const code = `import { acquireLock } from ${JSON.stringify(LOCK_URL)};
try {
  const held = await acquireLock('workspace-wks_x', { dir: ${JSON.stringify(dir)} });
  console.log(${JSON.stringify(mode)} === 'hold' ? 'holding' : 'acquired');
  await new Promise((r) => setTimeout(r, ${holdMs}));
  await held.release();
} catch (e) { console.log(e.name === 'LockBusy' || /held by another/.test(e.message) ? 'busy' : 'error ' + e.message); }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code]);
  child.output = new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('holding')) child.emit('holding');
    });
    child.on('close', () => resolve(out.trim()));
  });
  child.holding = new Promise((resolve) => child.once('holding', resolve));
  return child;
}
const tryOnce = (dir) => lockProcess(dir, 'try').output;

test('lock: six parallel processes, exactly one enters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsf-par-'));
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => lockProcess(dir, 'hold', 600).output));
  assert.equal(outcomes.filter((o) => o === 'holding').length, 1, outcomes.join(','));
  assert.equal(outcomes.filter((o) => o === 'busy').length, 5, outcomes.join(','));
  rmSync(dir, { recursive: true, force: true });
});

test('lock: a live holder is never taken over, however long it holds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsf-live-'));
  const holder = lockProcess(dir, 'hold', 2500);
  await holder.holding;
  for (const wait of [0, 800, 1600]) {
    await new Promise((r) => setTimeout(r, wait ? 800 : 0));
    assert.equal(await tryOnce(dir), 'busy', `contender after ~${wait} ms`);
  }
  assert.equal(await holder.output, 'holding');
  assert.equal(await tryOnce(dir), 'acquired', 'free after the holder released');
  rmSync(dir, { recursive: true, force: true });
});

test('lock: killing the holder process releases the lock; the lock file stays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsf-kill-'));
  const holder = lockProcess(dir, 'hold', 60_000);
  await holder.holding;
  const before = lstatSync(join(dir, 'workspace-wks_x.lock')).ino;
  holder.kill('SIGKILL');
  await holder.output;
  let outcome = 'busy';
  for (let i = 0; i < 20 && outcome === 'busy'; i += 1) {
    outcome = await tryOnce(dir); // the helper notices the closed pipe within moments
    if (outcome === 'busy') await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(outcome, 'acquired');
  assert.equal(lstatSync(join(dir, 'workspace-wks_x.lock')).ino, before, 'same lock file, never deleted');
  rmSync(dir, { recursive: true, force: true });
});

test('lock: a foreign flock -u does not release it; deleting or replacing the file is detected before writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsf-foreign-'));
  const path = join(dir, 'workspace-wks_x.lock');
  const held = await acquireLock('workspace-wks_x', { dir });
  try {
  held.verify();
  await new Promise((resolve) => spawn('sh', ['-c', 'exec 9<>"$1"; flock -u 9; true', 'x', path]).on('close', resolve));
  assert.equal(await tryOnce(dir), 'busy', 'foreign unlock has no effect on our descriptor');
  // replace the file with a new inode: our holder must refuse to write
  writeFile(`${path}.new`, '');
  renameSync(`${path}.new`, path);
  assert.throws(() => held.verify(), /was replaced/);
  // the documented limit: a newcomer can lock the new inode, but the old holder aborts before writing
  assert.equal(await tryOnce(dir), 'acquired');
  rmSync(path);
  assert.throws(() => held.verify(), /cannot be verified/);
  } finally {
    await held.release();
  }
  await assert.rejects(acquireLock('../escape', { dir }), /Invalid lock name/);
  rmSync(dir, { recursive: true, force: true });
});

test('lock: a symlinked lock path is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsf-sym-'));
  symlinkSync(join(dir, 'elsewhere'), join(dir, 'workspace-wks_y.lock'));
  await assert.rejects(acquireLock('workspace-wks_y', { dir }), /symlink/);
  rmSync(dir, { recursive: true, force: true });
});

const openFds = () => readdirSync('/proc/self/fd').length;
const lockFds = (path) => readdirSync('/proc/self/fd').filter((fd) => {
  try {
    return realpathSync(`/proc/self/fd/${fd}`) === path;
  } catch {
    return false;
  }
});

test('lock: the holding Node process has no helper child; its own descriptor keeps the lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsf-fd-'));
  const code = `import { acquireLock } from ${JSON.stringify(LOCK_URL)};
import { execFileSync } from 'node:child_process';
const held = await acquireLock('workspace-wks_x', { dir: ${JSON.stringify(dir)} });
const kids = execFileSync('ps', ['-o', 'args=', '--ppid', String(process.pid)]).toString().split('\\n').filter((l) => l && !l.startsWith('ps '));
console.log(JSON.stringify({ kids }));
await new Promise((r) => setTimeout(r, 800));
held.verify();
await held.release();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code]);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await tryOnce(dir), 'busy', 'held by the open descriptor although flock already exited');
  await new Promise((resolve) => child.on('close', resolve));
  assert.deepEqual(JSON.parse(out.trim().split('\n')[0]).kids, [], 'no lock-holding helper process');
  assert.equal(await tryOnce(dir), 'acquired', 'free after release');
  rmSync(dir, { recursive: true, force: true });
});

test('lock: failed acquisitions leave no open descriptor; an invalid descriptor fails verify', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wsf-fdleak-')));
  const path = join(dir, 'workspace-wks_x.lock');
  const held = await acquireLock('workspace-wks_x', { dir });
  assert.equal(lockFds(path).length, 1, 'exactly our descriptor');
  const before = openFds();
  for (let i = 0; i < 5; i += 1) await assert.rejects(acquireLock('workspace-wks_x', { dir }), LockBusy);
  symlinkSync(join(dir, 'target'), join(dir, 'workspace-wks_s.lock'));
  await assert.rejects(acquireLock('workspace-wks_s', { dir }), /symlink/);
  writeFile(join(dir, 'plain'), '');
  mkdirSync(join(dir, 'workspace-wks_d.lock'));
  await assert.rejects(acquireLock('workspace-wks_d', { dir }), /cannot be opened|not a regular file/);
  assert.equal(openFds(), before, 'busy, symlink and directory attempts closed what they opened');
  assert.equal(lockFds(path).length, 1);
  // someone closes our descriptor behind the lock's back: verify must fail, and the lock is gone
  const [fd] = lockFds(path);
  closeSync(Number(fd));
  assert.throws(() => held.verify(), /descriptor is no longer valid|no longer refers/);
  assert.equal(await tryOnce(dir), 'acquired', 'closing the descriptor released the kernel lock');
  // the freed number is reused for another file: still not our lock
  const reused = openSync(join(dir, 'plain'), 'r');
  assert.equal(String(reused), fd, 'descriptor number reused');
  assert.throws(() => held.verify(), /no longer refers to the locked file/);
  closeSync(reused);
  await held.release();
  rmSync(dir, { recursive: true, force: true });
});

test('lock: a lock file replaced between open and flock is refused and its descriptor closed', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wsf-swap-')));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const path = join(dir, 'workspace-wks_x.lock');
  writeFile(join(bin, 'flock'), `#!/bin/sh\nprintf '' > "${path}.new" && mv "${path}.new" "${path}"\nexec /usr/bin/flock "$@"\n`, { mode: 0o755 });
  const before = openFds();
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    await assert.rejects(acquireLock('workspace-wks_x', { dir }), /was replaced while locking/);
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(openFds(), before, 'descriptor of the replaced file closed');
  assert.equal(await tryOnce(dir), 'acquired', 'nothing left locked');
  rmSync(dir, { recursive: true, force: true });
});

test('guard failure prevents even the first progress write', async () => {
  const world = makeWorld();
  const authorization = await authorize(world);
  let saves = 0;
  const progress = { load: () => null, save: () => { saves += 1; } };
  const runner = runnerFor(world);
  await assert.rejects(applyPlans({
    authorization, config: CONFIG, confirm: authorization.hash, progress, lookupReceipt: fakeLookup(world),
    guard: () => { throw new Error('Lock file was replaced'); },
    runPlans: (l, o) => runner.runPlans(l, o), execute: executorsFor(world),
  }), /was replaced/);
  assert.equal(saves, 0, 'no progress written');
  assert.equal(world.calls.filter((c) => !['gh', 'git'].includes(c[0])).length, 0, 'no mutation');
});

// Clone-target checks on a real temporary filesystem.
test('clone target: canonical root, symlink components, existing targets and swapped parents', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wsf-fs-')));
  const root = join(base, 'projects');
  const outside = join(base, 'outside');
  mkdirSync(join(root, 'group'), { recursive: true });
  mkdirSync(outside);
  let r = inspectCloneTarget(root, join(root, 'group', 'new'), join(root, 'group', 'new', 'Repo'));
  assert.equal(r.ok, true);
  assert.equal(r.anchor, join(root, 'group'), 'deepest existing directory');
  symlinkSync(outside, join(root, 'escape'));
  r = inspectCloneTarget(root, join(root, 'escape'), join(root, 'escape', 'Repo'));
  assert.match(r.reason, /is a symlink/);
  r = inspectCloneTarget(root, join(root, 'escape', 'deep'), join(root, 'escape', 'deep', 'Repo'));
  assert.match(r.reason, /is a symlink/);
  symlinkSync(join(base, 'missing'), join(root, 'group', 'Dangling'));
  assert.match(inspectCloneTarget(root, join(root, 'group'), join(root, 'group', 'Dangling')).reason, /already exists/);
  assert.match(inspectCloneTarget(root, outside, join(outside, 'Repo')).reason, /not a direct child/);
  assert.match(inspectCloneTarget(root, join(root, 'group'), join(root, 'Repo')).reason, /not a direct child/);
  // a root that is itself reached through a symlink is canonicalized
  symlinkSync(root, join(base, 'rootlink'));
  r = inspectCloneTarget(join(base, 'rootlink'), join(base, 'rootlink', 'group'), join(base, 'rootlink', 'group', 'Repo'));
  assert.equal(r.root, root);
  // parent swapped between plan and apply: identity changes
  const before = inspectCloneTarget(root, join(root, 'group'), join(root, 'group', 'Repo'));
  renameSync(join(root, 'group'), join(root, 'group-old'));
  mkdirSync(join(root, 'group'));
  const after = inspectCloneTarget(root, join(root, 'group'), join(root, 'group', 'Repo'));
  assert.notEqual(after.anchorId, before.anchorId);
  rmSync(join(root, 'group'), { recursive: true });
  symlinkSync(outside, join(root, 'group'));
  assert.match(inspectCloneTarget(root, join(root, 'group'), join(root, 'group', 'Repo')).reason, /is a symlink/);
  rmSync(base, { recursive: true, force: true });
});

test('clone executor on a real filesystem: swapped parent refused, symlinked result refused, good clone verified', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wsf-exec-')));
  const root = join(base, 'projects');
  mkdirSync(join(root, 'group'), { recursive: true });
  const config = { ...CONFIG, checkoutRoot: root };
  const expectedPath = join(root, 'group', 'example-repo');
  const world = makeWorld();
  let cloneMode = 'good';
  const paseoCli = (args) => {
    world.calls.push(['paseo', ...args]);
    if (cloneMode === 'symlink') symlinkSync(base, expectedPath);
    else mkdirSync(expectedPath);
    world.checkouts[expectedPath] = { remotes: { origin: `https://github.com/${FIRMWARE}.git` } };
    return { checkoutPath: expectedPath, projectId: 'prj_1' };
  };
  const execute = createExecutors({ client: fakeClient(world), gh: fakeGh(world), git: fakeGit(world), paseoCli, sleep: async () => {} });
  const op = () => {
    const t = inspectCloneTarget(root, join(root, 'group'), expectedPath);
    return { kind: 'paseo.clone', params: { repo: FIRMWARE, parentDir: join(root, 'group'), protocol: 'https', expectedPath, guard: { root: t.root, anchor: t.anchor, anchorId: t.anchorId } } };
  };
  const planned = op();
  renameSync(join(root, 'group'), join(root, 'group-old'));
  mkdirSync(join(root, 'group'));
  await assert.rejects(execute(planned, config), /changed since the dry-run/);
  assert.equal(world.calls.length, 0, 'no clone after a parent swap');
  cloneMode = 'symlink';
  await assert.rejects(execute(op(), config), /not a plain directory/);
  rmSync(expectedPath);
  cloneMode = 'good';
  const result = await execute(op(), config);
  assert.equal(result.checkoutPath, expectedPath);
  rmSync(base, { recursive: true, force: true });
});

test('switch refuses changed state, busy steers, parented targets and no-ops', async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const discovery = await discoveryOf(world);
  ws.metadata[METADATA_KEY].epoch = 7; // changed after discovery
  await assert.rejects(switchSteer({ client: fakeClient(world), discovery, toSlot: 'B', apply: true, lock: testLock }), /Steer state changed/);
  assert.equal(world.calls.filter((c) => c[0] === 'workspace.setMetadata').length, 0);
  ws.metadata[METADATA_KEY].epoch = 1;
  steers.A.status = 'running';
  await assert.rejects(switchSteer({ client: fakeClient(world), discovery: await discoveryOf(world), toSlot: 'B', lock: testLock }), SwitchRefused);
  steers.A.status = 'idle';
  steers.B.labels[PARENT_LABEL] = 'x';
  await assert.rejects(switchSteer({ client: fakeClient(world), discovery: await discoveryOf(world), toSlot: 'B', lock: testLock }), /has parent/);
  await assert.rejects(switchSteer({ client: fakeClient(world), discovery: await discoveryOf(world), toSlot: 'A', lock: testLock }), /already active/);
});

// ---------------------------------------------------------------- friction fixes from the smoke test

test('CHECKPOINT block is parsed from a steer answer; none/keine become empty lists', () => {
  const answer = `Ergebnis in 3 Zeilen.\n\nCHECKPOINT\ntask: Smoke-Test abgeschlossen\ntests: keine\nblockers: release.yaml verweist auf fehlende Action\nnext: nur Übernahme bestätigen\n`;
  assert.deepEqual(parseCheckpointBlock(answer), { task: 'Smoke-Test abgeschlossen', tests: [], blockers: ['release.yaml verweist auf fehlende Action'], next: 'nur Übernahme bestätigen' });
  assert.deepEqual(parseCheckpointBlock('```\nCHECKPOINT\n- task: done\n- tests: npm test\n```'), { task: 'done', tests: ['npm test'], blockers: [], next: null });
  assert.equal(parseCheckpointBlock('no block here'), null);
  assert.equal(parseCheckpointBlock('CHECKPOINT\ntests: x'), null, 'a task line is required');
  const twoBlocks = 'CHECKPOINT\ntask: old\n\nmore text\nCHECKPOINT\ntask: new';
  assert.equal(parseCheckpointBlock(twoBlocks).task, 'new', 'the last block wins');
});

test('checkpoint next step is stored and shown; handoff is English by default', async () => {
  const world = makeWorld();
  provisioned(world);
  const cp = await writeCheckpoint({ client: fakeClient(world), discovery: await discoveryOf(world), task: 'Review CI', next: 'only confirm the takeover', lock: testLock });
  assert.equal(cp.next, 'only confirm the takeover');
  const result = await switchSteer({ client: fakeClient(world), discovery: await discoveryOf(world), toSlot: 'B', git: fakeGit(world), lock: testLock, language: 'en' });
  assert.match(result.packet, /Steer handoff for example-owner\/example-repo: epoch 1 → 2/);
  assert.match(result.packet, /- Next step: only confirm the takeover/);
  const status = steerStatus(await discoveryOf(world));
  const noNext = buildHandoff({ ...status, checkpoint: { task: 'x', epoch: 1 } }, { from: status.steers[0], to: status.steers[1], epoch: 1, language: 'de' });
  assert.match(noNext, /Nächster Schritt: nicht dokumentiert/);
});

test('switch --wait returns the reply of the new steer; --notify-previous sends one notice', async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  world.hooks.lastMessage = 'Übernahme bestätigt.';
  const client = fakeClient(world);
  const original = client.agents.ref;
  client.agents.ref = (id) => ({ ...original(id), waitForFinish: async () => ({ status: 'idle' }) });
  const result = await switchSteer({ client, discovery: await discoveryOf(world), toSlot: 'C', apply: true, wait: true, notifyPrevious: true, lock: testLock, language: 'en' });
  assert.equal(result.reply, 'Übernahme bestätigt.');
  assert.equal(result.previousNotified, true);
  const sends = world.calls.filter((c) => c[0] === 'agent.send');
  assert.deepEqual(sends.map((c) => c[1]), [steers.C.id, steers.A.id]);
  assert.match(sends[1][2], /Steer C .* is active as of epoch 2/);
  // default: no notice, no wait
  const quiet = makeWorld();
  provisioned(quiet);
  const r2 = await switchSteer({ client: fakeClient(quiet), discovery: await discoveryOf(quiet), toSlot: 'B', apply: true, lock: testLock });
  assert.equal(r2.reply, null);
  assert.equal(quiet.calls.filter((c) => c[0] === 'agent.send').length, 1);
});

test('known provider exceptions: Copilot Claude models reject a thinking level', () => {
  const config = structuredClone(CONFIG);
  config.profiles.cop = { provider: 'copilot', model: 'claude-sonnet-5.5', thinking: 'high', mode: 'allow-all' };
  config.profiles.copOk = { provider: 'copilot', model: 'claude-sonnet-5.5', thinking: null, mode: 'allow-all' };
  const catalog = [...PROVIDERS, { provider: 'copilot', enabled: true, status: 'ready', models: [{ id: 'claude-sonnet-5.5', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'allow-all' }] }];
  const problems = validateProfilesAgainstCatalog(config, catalog, ['cop', 'copOk']);
  assert.match(problems.cop.join(), /Copilot rejects a reasoning effort/);
  assert.equal(problems.copOk, undefined);
});

test('knownLimits extends the built-in exceptions: exact model and pattern, only when the field is set', () => {
  const config = structuredClone(CONFIG);
  config.knownLimits = [
    { provider: 'codex', model: 'gpt-6.2-sol', field: 'thinking', reason: 'Test limit: no thinking on this model' },
    { provider: 'muse', modelPattern: '-contributor$', field: 'mode', reason: 'Test limit: no custom mode on contributor models' },
  ];
  config.profiles.flat = { provider: 'codex', model: 'gpt-6.2-sol', thinking: null, mode: 'full-access' };
  const problems = validateProfilesAgainstCatalog(config, PROVIDERS, ['sol', 'muse', 'agy', 'flat']);
  assert.match(problems.sol.join(), /Test limit: no thinking/);
  assert.match(problems.muse.join(), /Test limit: no custom mode/);
  assert.equal(problems.agy, undefined);
  assert.equal(problems.flat, undefined, 'rule does not fire when the profile leaves the field unset');
});

test('knownLimits mismatch falls back with the reason instead of failing at apply', async () => {
  const config = structuredClone(CONFIG);
  config.knownLimits = [{ provider: 'codex', modelPattern: '^gpt-', field: 'thinking', reason: 'Test limit: codex rejects thinking here' }];
  const [p] = await plan(makeWorld(), [FIRMWARE], { config });
  assert.equal(p.status, 'pending');
  assert.deepEqual(p.conflicts.map((c) => c.key), [], 'slot A falls back while another profile is startable');
  assert.ok(p.notes.some((n) => /Steer A: profile "sol" is not startable.*Test limit: codex rejects thinking here.*using fallback "muse"/.test(n)), `fallback note names the reason and the fallback: ${JSON.stringify(p.notes)}`);
  assert.equal(p.ops.find((o) => o.key === 'steer.A').params.config.provider, 'muse/muse-spark-1.3-contributor');
  assert.ok(keys(p).includes('steer.B') && keys(p).includes('steer.C'), 'unaffected slots are still planned');
});

test('knownLimits entries are validated', () => {
  const good = structuredClone(CONFIG);
  good.knownLimits = [{ provider: 'codex', model: 'gpt-6.2-sol', field: 'thinking', reason: 'why' }];
  assert.deepEqual(validateConfig(good), []);
  const bad = structuredClone(CONFIG);
  bad.knownLimits = [
    { provider: '', field: 'thinking', reason: 'why' },
    { provider: 'codex', model: 'm', modelPattern: '([', field: 'prompt', reason: '' },
    'nope',
  ];
  const errors = validateConfig(bad).join('\n');
  for (const fragment of ['knownLimits[0].provider', 'needs model or modelPattern', 'not a valid regular expression', 'must be thinking or mode', 'reason is required', 'must be an object']) {
    assert.match(errors, new RegExp(fragment.replace(/[[\]]/g, '\\$&')));
  }
  assert.ok(validateConfig({ ...structuredClone(CONFIG), knownLimits: {} }).some((e) => /knownLimits must be an array/.test(e)));
});

test('runtime settings: environment beats config beats defaults; config path lookup', () => {
  const saved = { ...process.env };
  try {
    delete process.env.PASEO_FACTORY_STATE_DIR;
    delete process.env.PASEO_FACTORY_PASEO_BIN;
    delete process.env.PASEO_WS_URL;
    process.env.XDG_STATE_HOME = '/xdg/state';
    let r = configureRuntime({});
    assert.equal(r.stateDir, '/xdg/state/paseo-workspace-factory');
    assert.equal(r.lockDir, '/xdg/state/paseo-workspace-factory/locks');
    assert.equal(r.paseo.bin, 'paseo');
    assert.equal(r.handoffLanguage, 'en');
    r = configureRuntime({ handoffLanguage: 'de', runtime: { stateDir: '/cfg/state', paseo: { url: 'ws://10.0.0.5:7000/ws', bin: '/opt/paseo' } } });
    assert.deepEqual([r.stateDir, r.paseo.bin, daemonHost(), r.handoffLanguage], ['/cfg/state', '/opt/paseo', '10.0.0.5:7000', 'de']);
    process.env.PASEO_FACTORY_STATE_DIR = '/env/state';
    assert.equal(configureRuntime({ runtime: { stateDir: '/cfg/state' } }).stateDir, '/env/state');
    process.env.PASEO_FACTORY_CONFIG = '/env/config.json';
    assert.equal(defaultConfigPath(), '/env/config.json');
    delete process.env.PASEO_FACTORY_CONFIG;
    process.env.XDG_CONFIG_HOME = '/xdg/config';
    assert.equal(defaultConfigPath(), '/xdg/config/paseo-workspace-factory/config.json');
    assert.deepEqual(validateConfig({ ...CONFIG, handoffLanguage: 'fr' }).filter((e) => /handoffLanguage/.test(e)).length, 1);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    configureRuntime({});
  }
});

// ---------------------------------------------------------------- recovery of an unrecorded workspace.main

/** Executor that dies right after (or right before) the daemon performs `key`. */
function dyingAt(world, key, { before = false } = {}) {
  const real = executorsFor(world);
  let died = false;
  return async (op, cfg) => {
    if (op.key === key && before && !died) {
      died = true;
      throw new Error('process died before the request reached the daemon');
    }
    const out = await real(op, cfg);
    if (op.key === key && !died) {
      died = true;
      throw new Error('process died before recording the result');
    }
    return out;
  };
}

async function crashAfterWorkspaceCreate({ firstOp = false } = {}) {
  const world = makeWorld();
  if (firstOp) {
    world.checkouts['/p/example-repo'] = { remotes: { origin: `https://github.com/${FIRMWARE}`, upstream: `https://github.com/${FW_PARENT}` } };
    addProject(world, '/p/example-repo');
  }
  const authorization = await authorize(world);
  const progress = memoryProgress();
  const first = await apply(world, [FIRMWARE], { authorization, progress, execute: dyingAt(world, 'workspace.main') });
  assert.equal(first.report[0].status, 'failed');
  assert.equal(progress.load().results[FIRMWARE]?.['workspace.main'], undefined, 'result was not stored');
  assert.ok(progress.load().attempted.includes(`${FIRMWARE}#workspace.main`), 'the attempt was recorded');
  assert.equal(world.workspaces.length, 1, 'the daemon did create it');
  const key = authorization.plans[0].ops.find((o) => o.key === 'workspace.main').params.idempotencyKey;
  return { world, authorization, progress, key };
}

test('crash after workspace create: resume recovers the id from the daemon receipt, no second workspace', async () => {
  for (const firstOp of [false, true]) {
    const { world, authorization, progress, key } = await crashAfterWorkspaceCreate({ firstOp });
    const events = [];
    const resumed = await apply(world, [FIRMWARE], { authorization, progress, journal: (e) => events.push(e) });
    assert.equal(resumed.report[0].status, 'complete', resumed.report[0].error);
    assert.equal(world.workspaces.length, 1, 'no second workspace');
    assert.ok(world.agents.every((a) => a.workspaceId === world.workspaces[0].id));
    assert.deepEqual(events.filter((e) => e.event === 'recovered').map((e) => e.output), [{ workspaceId: world.workspaces[0].id, recovered: true, via: 'receipt' }]);
    assert.deepEqual(world.calls.filter((c) => c[0] === 'receipt.lookup').map((c) => c.slice(1)), [['workspace', key]]);
    const creates = world.calls.filter((c) => c[0] === 'workspace.create').map((c) => c[1]);
    assert.equal(creates.length, 2, 'original plus one identical confirmation');
    assert.deepEqual(creates[1], creates[0], 'same request, same key');
  }
});

test('crash recovery stops safely when the receipt is missing, unknown, failed, foreign or contradicted', async () => {
  const scenarios = [
    ['receipt outcome unknown', ({ world, key }) => (world.hooks.receiptOverride = { [key]: { phase: 'failed', outcomeUnknown: true, error: 'workspace_request_outcome_unknown', workspaceId: world.workspaces[0].id } }), /unknown outcome/],
    ['receipt failed', ({ world, key }) => (world.hooks.receiptOverride = { [key]: { phase: 'failed', error: 'provision failed', workspaceId: world.workspaces[0].id } }), /phase failed/],
    ['receipt names another workspace', ({ world, key }) => (world.hooks.receiptOverride = { [key]: { phase: 'completed', workspaceId: 'wks_0000000000000999', workspace: { id: 'wks_0000000000000999' } } }), /receipt names wks_0000000000000999/],
    ['receipt ambiguous', ({ world, key }) => (world.hooks.receiptOverride = { [key]: { phase: 'completed', workspaceId: world.workspaces[0].id, workspace: { id: 'wks_0000000000000998' } } }), /no unambiguous workspace/],
    ['receipt lookup unavailable', ({ world }) => (world.hooks.lookupFails = true), /receipt lookup failed/],
    ['identical request rejected', ({ world, key }) => world.fingerprints.set(key, 'other'), /identical request was rejected/],
    ['identical request returns a different workspace', ({ world, key }) => {
      const ghost = { ...structuredClone(world.workspaces[0]), id: 'wks_0000000000000777' };
      world.hiddenWorkspaces = [ghost]; // not listed by discovery, but returned for the key
      world.receipts.set(key, ghost.id);
      world.hooks.receiptOverride = { [key]: { phase: 'completed', workspaceId: world.workspaces[0].id, workspace: { id: world.workspaces[0].id } } };
    }, /identical request returned wks_0000000000000777/],
    ['metadata changed after creation', ({ world }) => (world.workspaces[0].metadata[METADATA_KEY].activeSteer = 'C'), /different factory metadata/],
    ['created before the dry-run', ({ world }) => (world.workspaces[0].createdAt = '2020-01-01T00:00:00.000Z'), /not created after the dry-run/],
  ];
  for (const [name, inject, expected] of scenarios) {
    const crash = await crashAfterWorkspaceCreate();
    inject(crash);
    const resumed = await apply(crash.world, [FIRMWARE], { authorization: crash.authorization, progress: crash.progress });
    assert.equal(resumed.report[0].status, 'failed', name);
    assert.match(resumed.report[0].error, expected, name);
    assert.equal(crash.world.agents.length, 0, `${name}: no steer`);
    assert.equal(crash.world.workspaces.length, 1, `${name}: no second workspace`);
  }
});

test('request that never reached the daemon: an identical-looking foreign workspace is not adopted', async () => {
  const world = makeWorld();
  const authorization = await authorize(world);
  const progress = memoryProgress();
  const first = await apply(world, [FIRMWARE], { authorization, progress, execute: dyingAt(world, 'workspace.main', { before: true }) });
  assert.equal(first.report[0].status, 'failed');
  const wsOp = authorization.plans[0].ops.find((o) => o.key === 'workspace.main');
  addWorkspace(world, { path: wsOp.params.path, title: wsOp.params.title, metadata: wsOp.params.metadata }); // created by someone else
  const resumed = await apply(world, [FIRMWARE], { authorization, progress });
  assert.match(resumed.report[0].error, /no receipt although discovery no longer lists it as pending/);
  assert.equal(world.workspaces.length, 1);
  assert.equal(world.calls.filter((c) => c[0] === 'workspace.create').length, 0, 'nothing re-sent without a receipt');
  assert.equal(world.agents.length, 0);
});

test('a never-attempted workspace.main is never reconstructed', async () => {
  const world = makeWorld();
  const authorization = await authorize(world);
  let step = 0;
  const { report } = await apply(world, [FIRMWARE], {
    authorization,
    tamper: (plans) => {
      if (step++ === 3) {
        addWorkspace(world, { path: '/p/example-repo', title: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: FIRMWARE, kind: 'github', locator: FIRMWARE } } } });
        return runnerFor(world).runPlans([FIRMWARE]);
      }
      return plans;
    },
  });
  assert.match(report[0].error, /main workspace reference is unresolved/);
  assert.equal(world.calls.filter((c) => c[0] === 'receipt.lookup').length, 0);
});

test('resume after a crash with a changed configuration is refused before any call', async () => {
  const { world, authorization, progress } = await crashAfterWorkspaceCreate();
  const changed = structuredClone(CONFIG);
  changed.profiles.sol.thinking = 'low';
  const before = world.calls.length;
  await assert.rejects(apply(world, [FIRMWARE], { authorization, progress, config: changed }), /does not match the current config/);
  assert.equal(world.calls.slice(before).filter((c) => !['gh', 'git'].includes(c[0])).length, 0);
});

// ---------------------------------------------------------------- P0.1: no unverified replay of attempted creates

/** First run: the executor marks the attempt but the request never reaches the daemon. */
async function attemptedWithoutArrival(key) {
  const world = makeWorld();
  const authorization = await authorize(world);
  const progress = memoryProgress();
  await apply(world, [FIRMWARE], { authorization, progress, execute: dyingAt(world, key, { before: true }) });
  assert.ok(progress.load().attempted.includes(`${FIRMWARE}#${key}`));
  return { world, authorization, progress };
}

test('P0.1 workspace.main still pending, no receipt: one first execution, never a blind repeat', async () => {
  const { world, authorization, progress } = await attemptedWithoutArrival('workspace.main');
  const creates = () => world.calls.filter((c) => c[0] === 'workspace.create').length;
  assert.equal(creates(), 0, 'the request never arrived');
  const events = [];
  const resumed = await apply(world, [FIRMWARE], { authorization, progress, journal: (e) => events.push(e) });
  assert.equal(resumed.report[0].status, 'complete', resumed.report[0].error);
  assert.ok(events.some((e) => e.event === 'retry-allowed' && e.key === 'workspace.main'));
  assert.equal(creates(), 1, 'exactly one create after the receipt showed nothing arrived');
  assert.equal(world.workspaces.length, 1);
});

test('P0.1 workspace.main still pending with a completed receipt: recovered, no second create', async () => {
  const { world, authorization, progress, key } = await crashAfterWorkspaceCreate();
  const ws = world.workspaces[0];
  world.workspaces = []; // discovery does not list it, the daemon still has it
  world.hiddenWorkspaces = [ws];
  const resumed = await apply(world, [FIRMWARE], { authorization, progress });
  assert.equal(resumed.report[0].status, 'failed');
  assert.match(resumed.report[0].error, /still pending after it ran/);
  assert.equal(progress.load().results[FIRMWARE]['workspace.main'].workspaceId, ws.id, 'result recovered from the receipt');
  assert.equal(world.calls.filter((c) => c[0] === 'workspace.create').length, 2, 'original + identical confirmation, no new object');
  assert.equal(world.hiddenWorkspaces.length + world.workspaces.length, 1);
  assert.deepEqual(world.calls.filter((c) => c[0] === 'receipt.lookup').map((c) => c[2]), [key]);
});

test('P0.1 already skipped workspace: recovered before the next step, even with no ops left', async () => {
  const { world, authorization, progress } = await crashAfterWorkspaceCreate();
  // steers were created by a previous resume that died before recording workspace.main
  const resumed = await apply(world, [FIRMWARE], { authorization, progress });
  assert.equal(resumed.report[0].status, 'complete', resumed.report[0].error);
  const stored = progress.load().results[FIRMWARE];
  delete stored['workspace.main']; // lose it again after everything ran
  const lost = memoryProgress({ ...progress.load(), results: { [FIRMWARE]: stored } });
  const again = await apply(world, [FIRMWARE], { authorization, progress: lost });
  assert.equal(again.report[0].status, 'complete', again.report[0].error);
  assert.equal(lost.load().results[FIRMWARE]['workspace.main'].via, 'receipt');
  assert.equal(world.workspaces.length, 1);
});

test('P0.1 outcomeUnknown or failed receipt for a pending workspace.main: no replay', async () => {
  for (const receipt of [{ phase: 'failed', outcomeUnknown: true, error: 'workspace_request_outcome_unknown' }, { phase: 'failed', error: 'provision failed' }, { phase: 'accepted' }]) {
    const { world, authorization, progress } = await attemptedWithoutArrival('workspace.main');
    const key = authorization.plans[0].ops.find((o) => o.key === 'workspace.main').params.idempotencyKey;
    world.hooks.receiptOverride = { [key]: receipt };
    const resumed = await apply(world, [FIRMWARE], { authorization, progress });
    assert.equal(resumed.report[0].status, 'failed', JSON.stringify(receipt));
    assert.match(resumed.report[0].error, /Recovery stopped/);
    assert.equal(world.calls.filter((c) => c[0] === 'workspace.create').length, 0, 'no create at all');
  }
});

test('P0.1 progress without a prior attempt never adopts; agents are reconciled the same way', async () => {
  // no attempt recorded: an observed workspace is not adopted
  const world = makeWorld();
  const authorization = await authorize(world);
  const progress = memoryProgress({ hash: authorization.hash, started: true, results: {}, attempted: [] });
  addWorkspace(world, { path: '/p/example-repo', title: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } } });
  world.checkouts['/p/example-repo'] = { remotes: { origin: `https://github.com/${FIRMWARE}.git`, upstream: `https://github.com/${FW_PARENT}.git` } };
  const resumed = await apply(world, [FIRMWARE], { authorization, progress });
  assert.equal(resumed.report[0].status, 'failed');
  assert.equal(world.calls.filter((c) => c[0] === 'receipt.lookup').length, 0);
  assert.equal(world.agents.length, 0);
  // steer created, result lost, discovery already sees it: receipt confirms, no duplicate
  const crash = makeWorld();
  const auth = await authorize(crash);
  const prog = memoryProgress();
  await apply(crash, [FIRMWARE], { authorization: auth, progress: prog, execute: dyingAt(crash, 'steer.B') });
  const done = await apply(crash, [FIRMWARE], { authorization: auth, progress: prog });
  assert.equal(done.report[0].status, 'complete', done.report[0].error);
  assert.equal(crash.agents.filter((a) => a.labels[LABEL.slot] === 'B').length, 1);
  assert.equal(prog.load().results[FIRMWARE]['steer.B'].via, 'receipt');
  // steer attempted, no receipt, but a steer for the slot is observed: refuse
  const odd = makeWorld();
  const auth2 = await authorize(odd);
  const prog2 = memoryProgress();
  await apply(odd, [FIRMWARE], { authorization: auth2, progress: prog2, execute: dyingAt(odd, 'steer.B', { before: true }) });
  addAgent(odd, { title: 'Steer B', provider: 'muse', model: 'muse-spark-1.3-contributor', workspaceId: odd.workspaces[0].id, labels: { [LABEL.repo]: FIRMWARE, [LABEL.role]: 'steer', [LABEL.slot]: 'B' } });
  const refused = await apply(odd, [FIRMWARE], { authorization: auth2, progress: prog2 });
  assert.match(refused.report[0].error, /no receipt although discovery no longer lists it as pending/);
});

test('P0.1 defensive paths: contradicting observation and unreconciled attempts are refused', async () => {
  // no receipt, discovery lists the steer as pending yet reports a steer for the slot
  const odd = makeWorld();
  const auth = await authorize(odd);
  const prog = memoryProgress();
  await apply(odd, [FIRMWARE], { authorization: auth, progress: prog, execute: dyingAt(odd, 'steer.B', { before: true }) });
  const res = await apply(odd, [FIRMWARE], {
    authorization: auth, progress: prog,
    tamper: (plans) => {
      plans[0].observed.steers.B = 'agent-ghost';
      return plans;
    },
  });
  assert.match(res.report[0].error, /no receipt but agent-ghost is observed/);
  assert.equal(odd.agents.filter((a) => a.labels[LABEL.slot] === 'B').length, 0);
  // a steer attempt recorded while its workspace was never attempted by this plan
  const world = makeWorld();
  const authorization = await authorize(world);
  const progress = memoryProgress({ hash: authorization.hash, started: true, results: {}, attempted: [`${FIRMWARE}#steer.A`] });
  world.checkouts['/p/example-repo'] = { remotes: { origin: `https://github.com/${FIRMWARE}.git`, upstream: `https://github.com/${FW_PARENT}.git` } };
  addWorkspace(world, { path: '/p/example-repo', title: 'Main', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: FIRMWARE, kind: 'github', locator: FIRMWARE } } } });
  const report = await apply(world, [FIRMWARE], { authorization, progress });
  assert.match(report.report[0].error, /attempted before without a stored result; refusing to repeat it unverified/);
  assert.equal(world.agents.length, 0);
});

// ---------------------------------------------------------------- P0.2: global apply lock

test('P0.2 two concurrent applies on one plan: exactly one enters, the other fails before any mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsf-apply-'));
  const world = makeWorld();
  const authorization = await authorize(world);
  const progress = memoryProgress();
  const run = () => withApplyLock((held) => apply(world, [FIRMWARE], { authorization, progress }).then((r) => (held.verify(), r)), { dir });
  const results = await Promise.allSettled([run(), run()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /held by another process/);
  assert.equal(world.workspaces.length, 1);
  assert.equal(world.agents.length, 3);
  assert.equal(world.calls.filter((c) => c[0] === 'paseo' && c[1] === 'clone').length, 1, 'one clone');
  rmSync(dir, { recursive: true, force: true });
});

test('P0.2 apply lock across real processes; a replaced lock file stops apply before the next mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsf-apply-proc-'));
  const applyUrl = new URL('../src/apply.mjs', import.meta.url).href;
  const contender = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { withApplyLock } from ${JSON.stringify(applyUrl)};
      try { await withApplyLock(() => new Promise((r) => setTimeout(r, 500)), { dir: ${JSON.stringify(dir)} }); console.log('entered'); }
      catch (e) { console.log(/held by another/.test(e.message) ? 'busy' : 'error ' + e.message); }`]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => resolve(out.trim()));
  });
  assert.deepEqual((await Promise.all([contender(), contender(), contender()])).sort(), ['busy', 'busy', 'entered']);

  const world = makeWorld();
  const authorization = await authorize(world);
  const real = executorsFor(world);
  const lockFile = join(dir, 'factory-apply.lock');
  const outcome = await withApplyLock(async (held) => {
    const runner = runnerFor(world);
    return applyPlans({
      authorization, config: CONFIG, confirm: authorization.hash, lookupReceipt: fakeLookup(world), guard: () => held.verify(),
      runPlans: (l, o) => runner.runPlans(l, o),
      execute: async (op, cfg) => {
        const out = await real(op, cfg);
        if (op.key === 'checkout.clone') {
          writeFile(`${lockFile}.new`, '');
          renameSync(`${lockFile}.new`, lockFile); // someone replaced the lock file
        }
        return out;
      },
    });
  }, { dir });
  assert.equal(outcome.report[0].status, 'failed');
  assert.match(outcome.report[0].error, /was replaced/);
  assert.deepEqual(world.calls.filter((c) => c[0] === 'paseo' || c[0] === 'workspace.create' || c[0] === 'agent.create').map((c) => c[0] + ':' + (c[1] ?? '')), ['paseo:clone'], 'nothing after the replacement');

  // replaced before the very first operation: not even the clone runs
  const fresh = makeWorld();
  const auth2 = await authorize(fresh);
  let observations = 0;
  const early = await withApplyLock(async (held) => {
    const runner = runnerFor(fresh);
    return applyPlans({
      authorization: auth2, config: CONFIG, confirm: auth2.hash, lookupReceipt: fakeLookup(fresh), guard: () => held.verify(),
      runPlans: async (l, o) => {
        if (++observations === 2) {
          writeFile(`${lockFile}.new`, '');
          renameSync(`${lockFile}.new`, lockFile);
        }
        return runner.runPlans(l, o);
      },
      execute: executorsFor(fresh),
    });
  }, { dir });
  assert.match(early.report[0].error, /was replaced/);
  assert.equal(fresh.calls.filter((c) => c[0] === 'paseo').length, 0, 'no clone after an early replacement');
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- P1.1: immutable authorizations

test('P1.1 repeated dry-run keeps the stored authorization and its createdAt; damage aborts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsf-auth-'));
  const world = makeWorld();
  const first = await authorize(world);
  const stored = storeAuthorization(dir, first, CONFIG);
  assert.equal(stored.status, 'created');
  await new Promise((r) => setTimeout(r, 5));
  const second = await authorize(world);
  assert.equal(second.hash, first.hash);
  assert.notEqual(second.createdAt, first.createdAt);
  const kept = storeAuthorization(dir, second, CONFIG);
  assert.equal(kept.status, 'kept');
  assert.equal(kept.authorization.createdAt, first.createdAt, 'original createdAt preserved');
  assert.equal(JSON.parse(readFileSync(stored.file, 'utf8')).createdAt, first.createdAt);
  // begun apply with progress, then another dry-run of the same state, then recovery
  const progress = fileProgress(join(dir, `${first.hash}.progress.json`));
  world.hooks.failCreate = (opts) => opts.title === 'Steer B';
  await apply(world, [FIRMWARE], { authorization: kept.authorization, progress });
  delete world.hooks.failCreate;
  assert.equal(storeAuthorization(dir, first, CONFIG).authorization.createdAt, first.createdAt);
  const resumed = await apply(world, [FIRMWARE], { authorization: JSON.parse(readFileSync(stored.file, 'utf8')), progress });
  assert.equal(resumed.report[0].status, 'complete', resumed.report[0].error);
  // tampered and corrupt files are never replaced
  const tampered = JSON.parse(readFileSync(stored.file, 'utf8'));
  tampered.plans[0].ops[0].params.parentDir = '/p/elsewhere';
  writeFile(stored.file, JSON.stringify(tampered));
  assert.throws(() => storeAuthorization(dir, first, CONFIG), /differs from this dry-run or is damaged/);
  writeFile(stored.file, '{broken');
  assert.throws(() => storeAuthorization(dir, first, CONFIG), /unreadable/);
  assert.equal(readFileSync(stored.file, 'utf8'), '{broken', 'left untouched');
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temporary files left');
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- live-test cleanup (mocks only)

function cleanupFixture() {
  const scratch = '/scratch/run-abc';
  const manifest = { scratch, workspace: 'wks_00000000000000aa', agent: 'agent-it', phases: { functional: 'passed' } };
  const workspace = { id: manifest.workspace, workspaceDirectory: scratch, workspaceKind: 'local_checkout', metadata: { [METADATA_KEY]: { main: true } } };
  const agent = { id: 'agent-it', workspaceId: manifest.workspace, labels: { 'wsf.role': 'integration-test' }, archivedAt: null };
  const calls = [];
  const state = { workspace, agent, refreshFails: false, agentMissing: false };
  const client = {
    workspaces: {
      ref: () => ({ refresh: async () => { if (state.refreshFails) throw new Error('socket closed'); return state.workspace && structuredClone(state.workspace); } }),
      archive: async (id) => { calls.push(['workspace.archive', id]); return { workspaceId: id }; },
    },
    agents: {
      ref: (id) => ({
        refresh: async () => (state.agentMissing ? null : { agent: structuredClone(state.agent) }),
        archive: async () => { calls.push(['agent.archive', id]); return { archivedAt: 'now' }; },
      }),
    },
  };
  const realpath = (p) => (p.startsWith('/scratch') ? p : (() => { throw new Error('ENOENT'); })());
  const verify = (overrides = {}) => verifyCleanup({ manifest, client, agents: [state.agent], scratchBase: '/scratch', realpath, ...overrides });
  return { manifest, state, client, calls, verify };
}

test('cleanup archives only fully verified objects', async () => {
  const f = cleanupFixture();
  const verification = await f.verify();
  assert.equal(verification.ok, true, verification.reasons.join('; '));
  const outcome = await performCleanup({ verification, client: f.client });
  assert.equal(outcome.status, 'complete');
  assert.deepEqual(f.calls, [['agent.archive', 'agent-it'], ['workspace.archive', 'wks_00000000000000aa']]);
});

test('cleanup is fail-closed: missing or contradicting evidence archives nothing', async () => {
  const cases = [
    ['workspace refresh fails', (f) => (f.state.refreshFails = true), /refresh failed/],
    ['workspace snapshot missing', (f) => (f.state.workspace = null), /snapshot missing/],
    ['agent snapshot missing', (f) => (f.state.agentMissing = true), /agent snapshot missing/],
    ['agent in another workspace', (f) => (f.state.agent.workspaceId = 'wks_00000000000000bb'), /belongs to/],
    ['agent without test label', (f) => (f.state.agent.labels = {}), /integration-test label/],
    ['agent with parent', (f) => (f.state.agent.labels[PARENT_LABEL] = 'x'), /has parent/],
    ['workspace elsewhere', (f) => (f.state.workspace.workspaceDirectory = '/scratch/run-other'), /not the scratch path/],
    ['worktree workspace', (f) => (f.state.workspace.workspaceKind = 'worktree'), /not local_checkout/],
    ['workspace id mismatch', (f) => (f.state.workspace.id = 'wks_00000000000000cc'), /id mismatch/],
    ['scratch outside base', (f) => (f.manifest.scratch = '/scratch/run-abc/../../etc'), /not a run directory|unresolvable/],
    ['malformed workspace id', (f) => (f.manifest.workspace = '../wks'), /malformed/],
  ];
  for (const [name, mutate, expected] of cases) {
    const f = cleanupFixture();
    mutate(f);
    const verification = await f.verify();
    assert.equal(verification.ok, false, name);
    assert.match(verification.reasons.join('; '), expected, name);
    const outcome = await performCleanup({ verification, client: f.client });
    assert.equal(outcome.status, 'refused', name);
    assert.deepEqual(f.calls, [], `${name}: no archive call`);
  }
  // unreadable agent list and foreign agents in the workspace
  let f = cleanupFixture();
  assert.match((await f.verify({ agents: null })).reasons.join(), /agent list unavailable/);
  f = cleanupFixture();
  const verification = await f.verify({ agents: [f.state.agent, { id: 'someone-else', workspaceId: f.manifest.workspace, archivedAt: null }] });
  assert.match(verification.reasons.join(), /not created by this run/);
  assert.deepEqual(f.calls, []);
});

// ---------------------------------------------------------------- config

test('config validation catches broken references', () => {
  assert.deepEqual(validateConfig(CONFIG), []);
  const bad = structuredClone(CONFIG);
  bad.steers.slots.D = 'missing';
  bad.steers.slots.ab = 'sol';
  bad.steers.initialActive = 'C2';
  bad.checkoutRoot = 'relative';
  const errors = validateConfig(bad).join('\n');
  for (const fragment of ['unknown profile "missing"', 'single capital letter', 'initialActive', 'absolute path']) assert.match(errors, new RegExp(fragment));
});

test('catalog validation reports disabled providers, unknown models, thinking and modes', () => {
  const config = structuredClone(CONFIG);
  config.profiles.x = { provider: 'opencode', model: 'a' };
  config.profiles.y = { provider: 'codex', model: 'gpt-9' };
  config.profiles.z = { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'ultra', mode: 'yolo' };
  const problems = validateProfilesAgainstCatalog(config, PROVIDERS, ['sol', 'x', 'y', 'z']);
  assert.equal(problems.sol, undefined);
  assert.match(problems.x[0], /disabled/);
  assert.match(problems.y[0], /not offered/);
  assert.equal(problems.z.length, 2);
});

// ---------------------------------------------------------------- free slot selection (TODO 1.1-1.3)

test('steer slots A-Z are free: any letters, any order, no minimum beyond one slot', () => {
  const free = structuredClone(CONFIG);
  free.steers = { slots: { Z: 'sol', Q: 'muse', M: 'agy' }, prepare: ['Q', 'Z'], initialActive: 'Q' };
  assert.deepEqual(validateConfig(free), []);
  const single = structuredClone(CONFIG);
  single.steers = { slots: { M: 'sol' }, prepare: ['M'], initialActive: 'M' };
  assert.deepEqual(validateConfig(single), []);
  const noSlots = structuredClone(CONFIG);
  noSlots.steers = { slots: {}, prepare: [], initialActive: 'A' };
  assert.ok(validateConfig(noSlots).some((e) => /at least one slot/.test(e)));
  const noPrepare = structuredClone(CONFIG);
  noPrepare.steers = { slots: { A: 'sol' }, prepare: [], initialActive: 'A' };
  assert.ok(validateConfig(noPrepare).some((e) => /prepare/.test(e)));
});

test('adopt accepts any defined slot outside prepare and plans only the adoption', async () => {
  const config = structuredClone(CONFIG);
  config.steers.slots.D = 'sol';
  const { world, created: [legacy] } = legacyWorld([{ title: 'Steer D' }]);
  const [p] = await plan(world, [FIRMWARE], { config, adopt: { '*': { D: legacy.id } } });
  assert.deepEqual(keys(p), ['steer.D']);
  assert.equal(p.ops[0].kind, 'paseo.agent.adopt');
  const unknown = structuredClone(CONFIG);
  const { world: w2, created: [other] } = legacyWorld([{ title: 'Steer Z' }]);
  const [q] = await plan(w2, [FIRMWARE], { config: unknown, adopt: { '*': { Z: other.id } } });
  assert.match(q.conflicts.find((c) => c.key === 'steer.Z').reason, /not defined in steers.slots/);
});

test('default factory starts with exactly one steer', async () => {
  const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(example.steers.slots), ['A']);
  assert.deepEqual(example.steers.prepare, ['A']);
  assert.equal(example.steers.initialActive, 'A');
  assert.deepEqual(validateConfig({ ...example, checkoutRoot: '/p' }), []);
  const config = structuredClone(CONFIG);
  config.steers = { slots: { A: 'sol' }, prepare: ['A'], initialActive: 'A' };
  const [p] = await plan(makeWorld(), [FIRMWARE], { config });
  assert.deepEqual(keys(p), ['checkout.clone', 'checkout.upstream-remote', 'workspace.main', 'steer.A']);
});

test('plan --slots overrides prepare for this run and adjusts initialActive', async () => {
  const config = structuredClone(CONFIG);
  config.steers.slots.D = 'sol';
  let [p] = await plan(makeWorld(), [FIRMWARE], { config, slots: ['D'] });
  assert.deepEqual(keys(p), ['checkout.clone', 'checkout.upstream-remote', 'workspace.main', 'steer.D']);
  assert.equal(p.ops.find((o) => o.key === 'workspace.main').params.metadata[METADATA_KEY].activeSteer, 'D');
  [p] = await plan(makeWorld(), [FIRMWARE], { config, slots: ['B', 'C'] });
  assert.deepEqual(keys(p).filter((k) => k.startsWith('steer.')), ['steer.B', 'steer.C']);
  assert.equal(p.ops.find((o) => o.key === 'workspace.main').params.metadata[METADATA_KEY].activeSteer, 'B');
  [p] = await plan(makeWorld(), [FIRMWARE], { config, slots: ['A', 'C'] });
  assert.equal(p.ops.find((o) => o.key === 'workspace.main').params.metadata[METADATA_KEY].activeSteer, 'A', 'initialActive kept when included');
  const { report } = await apply(makeWorld(), [FIRMWARE], { config, slots: ['C'] });
  assert.equal(report[0].status, 'complete', report[0].error);
  assert.deepEqual(report[0].executed.map((e) => e.key), ['checkout.clone', 'checkout.upstream-remote', 'workspace.main', 'steer.C']);
});

test('plan --slots must be a subset of defined slots', async () => {
  const [p] = await plan(makeWorld(), [FIRMWARE], { slots: ['Z'] });
  assert.match(p.conflicts.find((c) => c.key === 'steer.Z').reason, /not defined in steers.slots/);
  assert.equal(p.ops.some((o) => o.key === 'steer.Z'), false);
});
