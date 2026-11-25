// Domain as a role on scopes (#1, pilot): child scopes carry scope.domain (logical,
// never a parent); assign routes Hub → Domain → Kind; scopes groups by domain.
// Fakes only; no daemon, no GitHub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeEntry } from '../src/discovery.mjs';
import { listScopes, sameScopeId, domainOfScope, domainFirstPlanOrder } from '../src/scope.mjs';
import { createRunner } from '../src/factory.mjs';
import { applyPlans, createExecutors, createAuthorization } from '../src/apply.mjs';
import { assignScope, buildAssignment } from '../src/assign.mjs';
import { steerStatus, buildResumeBrief, CHECKPOINT_KEY } from '../src/steer.mjs';
import { scopeRows, formatScopeRows } from '../src/scopes-view.mjs';
import { LABEL, METADATA_KEY } from '../src/paseo.mjs';

const CONFIG = {
  version: 1,
  github: { owner: 'example', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    sol: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
    muse: { provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null, mode: 'allowAll' },
  },
  steers: { slots: { A: 'sol', B: 'muse' }, prepare: ['A', 'B'], initialActive: 'A' },
  workers: { defaultProfile: 'muse' },
};

const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'full-access' }] },
  { provider: 'muse', enabled: true, status: 'ready', models: [{ id: 'muse-spark-1.3-contributor', thinkingOptions: [] }], modes: [{ id: 'allowAll' }] },
];

const SLOT_PROVIDER = { A: ['codex', 'gpt-6.2-sol'], B: ['muse', 'muse-spark-1.3-contributor'] };

function makeWorld() {
  return {
    checkouts: {}, localDirs: new Set(), projects: [], workspaces: [], agents: [],
    providers: structuredClone(PROVIDERS), calls: [], receipts: new Map(), seq: 0,
  };
}

function strictGh(world) {
  return (args) => {
    world.calls.push(['gh', ...args]);
    throw new Error('gh must not be called for dir scopes');
  };
}

function fakeGit(world) {
  return (cwd, args) => {
    world.calls.push(['git', cwd, ...args]);
    const checkout = world.checkouts[cwd];
    if (!checkout) throw new Error(`not a repo: ${cwd}`);
    if (args[0] === 'config') {
      const lines = Object.entries(checkout.remotes ?? {}).map(([n, u]) => `remote.${n}.url ${u}`);
      if (!lines.length) throw new Error('exit 1');
      return lines.join('\n');
    }
    if (args[0] === 'rev-parse') return args.includes('--abbrev-ref') ? 'main' : 'b1c2d3e4f5a6b7c8d9e0';
    if (args[0] === 'status') return '';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function worldScan(world) {
  return () => Object.entries(world.checkouts).map(([path, c]) => ({
    path, linkedWorktree: Boolean(c.linkedWorktree), remotes: { ...(c.remotes ?? {}) }, repos: {},
  }));
}

function fakeExistsDir(world) {
  return (p) => world.checkouts[p] !== undefined || world.localDirs.has(p);
}

function addProject(world, path) {
  let project = world.projects.find((p) => p.projectRootPath === path);
  if (!project) {
    project = { projectId: `prj_${++world.seq}`, projectRootPath: path, projectDisplayName: path.split('/').at(-1) };
    world.projects.push(project);
  }
  return project;
}

function provisionDir(world, { path, id, kind = 'dir', domain, epoch = 1, checkpoint = null }) {
  world.checkouts[path] = { remotes: {} };
  const project = addProject(world, path);
  const ws = {
    id: `wks_${String(++world.seq).padStart(16, '0')}`,
    projectId: project.projectId, workspaceDirectory: path, workspaceKind: 'local_checkout',
    title: 'Main', name: 'Main',
    metadata: {
      [METADATA_KEY]: { main: true, activeSteer: 'A', epoch, scope: { id, kind, locator: path, ...(domain ? { domain } : {}) } },
      ...(checkpoint ? { [CHECKPOINT_KEY]: checkpoint } : {}),
    },
    createdAt: new Date().toISOString(),
  };
  world.workspaces.push(ws);
  for (const [slot, [provider, model]] of Object.entries(SLOT_PROVIDER)) {
    world.agents.push({ id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, provider, model, title: `Steer ${slot}`, workspaceId: ws.id, labels: { [LABEL.repo]: id, [LABEL.role]: 'steer', [LABEL.slot]: slot, [LABEL.scope]: id } });
  }
  return ws;
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  const agentHandle = (id) => ({
    id,
    refresh: async () => ({ agent: structuredClone(findAgent(id)) }),
    send: async (text) => { world.calls.push(['agent.send', id, text]); },
    timeline: { refetch: async () => ({ entries: [] }) },
  });
  const workspaceHandle = (id) => ({
    id,
    refresh: async () => structuredClone(findWs(id)),
    setMetadata: async (patch) => {
      world.calls.push(['workspace.setMetadata', id, patch]);
      Object.assign(findWs(id).metadata, structuredClone(patch));
    },
    agents: {
      create: async (opts) => {
        world.calls.push(['agent.create', opts]);
        const [provider, ...rest] = opts.config.provider.split('/');
        const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, provider, model: rest.join('/'), title: opts.title, workspaceId: id, labels: { ...opts.labels } };
        world.agents.push(agent);
        if (opts.idempotencyKey) world.receipts.set(opts.idempotencyKey, agent.id);
        return agentHandle(agent.id);
      },
    },
  });
  return {
    workspaces: {
      ref: workspaceHandle,
      create: async ({ source, title, metadata, idempotencyKey }) => {
        world.calls.push(['workspace.create', { source, title, metadata, idempotencyKey }]);
        const project = addProject(world, source.path);
        const workspace = {
          id: `wks_${String(++world.seq).padStart(16, '0')}`, projectId: project.projectId,
          workspaceDirectory: source.path, workspaceKind: 'local_checkout', title, name: title,
          metadata: structuredClone(metadata), createdAt: new Date().toISOString(),
        };
        world.workspaces.push(workspace);
        world.receipts.set(idempotencyKey, workspace.id);
        return workspaceHandle(workspace.id);
      },
    },
    agents: { ref: agentHandle },
  };
}

function fakePaseoCli(world) {
  return (args) => {
    world.calls.push(['paseo', ...args]);
    if (args[0] === 'project') return { projectId: addProject(world, args[2]).projectId, path: args[2] };
    throw new Error(`unexpected paseo ${args.join(' ')}`);
  };
}

function fakeLookup(world) {
  return async (kind, key) => {
    if (!world.receipts.has(key)) return null;
    const id = world.receipts.get(key);
    if (kind === 'agent') return { kind, idempotencyKey: key, phase: 'completed', error: null, agentId: id };
    return { kind, idempotencyKey: key, phase: 'completed', error: null, workspaceId: id, workspace: { id } };
  };
}

function runnerFor(world, config = CONFIG) {
  return createRunner({
    config, client: null, gh: strictGh(world), git: fakeGit(world),
    readState: async () => structuredClone({ projects: world.projects, workspaces: world.workspaces, agents: world.agents, providers: world.providers }),
    scan: worldScan(world),
    inspectTarget: () => { throw new Error('no clones in domain tests'); },
    realpath: (p) => p, existsDir: fakeExistsDir(world),
  });
}

const keys = (p) => p.ops.map((op) => op.key);
const noLock = (_name, fn) => fn({ verify() {} });

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

function runCli(t, args, { reposFile = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-domain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(CONFIG));
  const argv = ['--config', join(dir, 'config.json'), ...args];
  if (reposFile) {
    const reposPath = join(dir, 'repos.json');
    writeFileSync(reposPath, JSON.stringify(reposFile));
    argv.push('--repos-file', reposPath);
  }
  try {
    const stdout = execFileSync('node', [CLI, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('domain helpers: sameScopeId compares case-insensitively, domainOfScope reads the pointer', () => {
  assert.equal(sameScopeId('Team-A', 'team-a'), true);
  assert.equal(sameScopeId('a', 'b'), false);
  assert.equal(sameScopeId(undefined, 'a'), false);
  assert.equal(domainOfScope({ id: 'w', kind: 'dir', domain: 'team-a' }), 'team-a');
  assert.equal(domainOfScope({ id: 'w', kind: 'dir' }), null);
  assert.equal(domainOfScope({ id: 'w', kind: 'dir', domain: 42 }), null);
  assert.equal(domainOfScope(null), null);
});

test('listScopes carries the stored domain pointer', () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/web', id: 'web', domain: 'team-a' });
  provisionDir(world, { path: '/p/plain', id: 'plain' });
  const scopes = listScopes({ workspaces: world.workspaces, agents: world.agents, projects: [] });
  assert.equal(scopes.find((s) => s.id === 'web').domain, 'team-a');
  assert.equal('domain' in scopes.find((s) => s.id === 'plain'), false);
});

test('normalizeEntry accepts a domain id, "" clears, hub combo is refused', () => {
  assert.equal(normalizeEntry({ local: '/p/web', domain: 'team-a' }, CONFIG).domain, 'team-a');
  assert.equal(normalizeEntry({ local: '/p/web', domain: '' }, CONFIG).domain, '');
  assert.equal(normalizeEntry({ repo: 'example/web', domain: 'example/team' }, CONFIG).domain, 'example/team');
  assert.equal('domain' in normalizeEntry({ local: '/p/web' }, CONFIG), false);
  assert.throws(() => normalizeEntry({ local: '/p/web', domain: 42 }, CONFIG), /Entry "domain" must be a string/);
  assert.throws(() => normalizeEntry({ local: '/p/web', domain: 'a:b' }, CONFIG), /must not contain ":"/);
  assert.throws(() => normalizeEntry({ local: '/p/web', hub: true, domain: 'team-a' }, CONFIG), /must not combine "hub" with "domain"/);
});

test('plan --domain sets the pointer with the canonical live spelling (epoch-checked op)', async () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/team-a', id: 'team-a' });
  const child = provisionDir(world, { path: '/p/web', id: 'web', epoch: 4 });
  const [d] = await runnerFor(world).discoverAll([{ local: '/p/web', domain: 'TEAM-A' }]);
  assert.equal(d.scope.domain, 'TEAM-A', 'requested pointer wins in the planned scope');
  const [p] = await runnerFor(world).runPlans([{ local: '/p/web', domain: 'TEAM-A' }]);
  assert.deepEqual(keys(p), ['scope.domain']);
  const op = p.ops.find((o) => o.key === 'scope.domain');
  assert.equal(op.kind, 'scope.domain');
  assert.deepEqual(op.params, { workspaceId: child.id, domain: 'team-a', epoch: 4 });
});

test('re-plan without --domain keeps the stored pointer silently; "" clears it', async () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/team-a', id: 'team-a' });
  provisionDir(world, { path: '/p/web', id: 'web', domain: 'team-a' });
  const [kept] = await runnerFor(world).runPlans([{ local: '/p/web' }]);
  assert.equal(kept.status, 'complete');
  assert.ok(!keys(kept).includes('scope.domain'));
  const [d] = await runnerFor(world).discoverAll([{ local: '/p/web' }]);
  assert.equal(d.scope.domain, 'team-a', 'stored pointer is kept');
  const [cleared] = await runnerFor(world).runPlans([{ local: '/p/web', domain: '' }]);
  assert.deepEqual(keys(cleared), ['scope.domain']);
  assert.equal(cleared.ops.find((o) => o.key === 'scope.domain').params.domain, null);
});

test('unknown, self and hub domains are conflicts; fresh mains inherit a valid pointer', async () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/team-a', id: 'team-a' });
  provisionDir(world, { path: '/p/web', id: 'web' });
  const [unknown] = await runnerFor(world).runPlans([{ local: '/p/web', domain: 'nope' }]);
  assert.match(unknown.conflicts.find((c) => c.key === 'scope.domain').reason, /not a live scope/);
  const [self] = await runnerFor(world).runPlans([{ local: '/p/web', domain: 'WEB' }]);
  assert.match(self.conflicts.find((c) => c.key === 'scope.domain').reason, /is the scope itself/);
  provisionDir(world, { path: '/p/admin', id: 'admin', kind: 'hub' });
  const [hub] = await runnerFor(world).runPlans([{ local: '/p/admin', domain: 'team-a' }]);
  assert.match(hub.conflicts.find((c) => c.key === 'scope.domain').reason, /not supported for hub/);
  world.checkouts['/p/new'] = { remotes: {} };
  const [fresh] = await runnerFor(world).runPlans([{ local: '/p/new', domain: 'team-a' }]);
  assert.deepEqual(fresh.ops.find((o) => o.key === 'workspace.main').params.metadata[METADATA_KEY].scope,
    { id: 'new', kind: 'dir', locator: '/p/new', domain: 'team-a' });
  const [freshUnknown] = await runnerFor(world).runPlans([{ local: '/p/new', domain: 'nope' }]);
  assert.match(freshUnknown.conflicts.find((c) => c.key === 'scope.domain').reason, /not a live scope/);
});

test('apply writes the domain epoch-checked; drift and retired scopes refuse', async () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/team-a', id: 'team-a' });
  const child = provisionDir(world, { path: '/p/web', id: 'web', epoch: 4 });
  const entries = [{ local: '/p/web', domain: 'team-a' }];
  const runner = runnerFor(world);
  const plans = await runner.runPlans(entries);
  const authorization = createAuthorization(plans, CONFIG, { entries, allowFork: false, adopt: {} });
  const execute = createExecutors({ client: fakeClient(world), gh: strictGh(world), git: fakeGit(world), paseoCli: fakePaseoCli(world), sleep: async () => {} });
  const result = await applyPlans({ authorization, config: CONFIG, confirm: authorization.hash, lookupReceipt: fakeLookup(world), runPlans: (list, options) => runner.runPlans(list, options), execute });
  assert.equal(result.report[0].status, 'complete', result.report[0].error);
  assert.equal(child.metadata[METADATA_KEY].scope.domain, 'team-a');
  assert.equal(child.metadata[METADATA_KEY].epoch, 4, 'pointer write keeps the epoch like assign');
  const [after] = await runner.runPlans(entries);
  assert.equal(after.status, 'complete');

  const drift = { key: 'scope.domain', kind: 'scope.domain', params: { workspaceId: child.id, domain: 'team-a', epoch: 3 } };
  await assert.rejects(() => execute(drift, CONFIG), /expected epoch 3, found 4/);
  child.metadata[METADATA_KEY].retired = true;
  const retired = { key: 'scope.domain', kind: 'scope.domain', params: { workspaceId: child.id, domain: null, epoch: 4 } };
  await assert.rejects(() => execute(retired, CONFIG), /retired/);
  delete child.metadata[METADATA_KEY].retired;
  const same = { key: 'scope.domain', kind: 'scope.domain', params: { workspaceId: child.id, domain: 'TEAM-A', epoch: 4 } };
  assert.deepEqual(await execute(same, CONFIG), { workspaceId: child.id, domain: 'team-a', already: true });
});

test('assign packet routes Hub → Domain → Kind; result carries domain fields', async () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/team-a', id: 'team-a' });
  provisionDir(world, { path: '/p/web', id: 'web', domain: 'team-a', epoch: 3 });
  const runner = runnerFor(world);
  const [childDiscovery] = await runner.discoverAll([{ local: '/p/web' }]);
  const child = await assignScope({
    client: fakeClient(world), discovery: childDiscovery, task: 'Ship it', lock: noLock, now: () => new Date('2026-11-23T12:00:00.000Z'),
  });
  assert.equal(child.domain, 'team-a');
  assert.deepEqual(child.domainChildren, []);
  assert.match(child.packet, /Domain team-a: prefix blockers for the domain steer with `domain:`, for the hub with `hub:`/);
  const [domainDiscovery] = await runner.discoverAll([{ local: '/p/team-a' }]);
  const domain = await assignScope({
    client: fakeClient(world), discovery: domainDiscovery, task: 'Coordinate', lock: noLock, now: () => new Date('2026-11-23T12:00:00.000Z'),
  });
  assert.equal(domain.domain, null);
  assert.deepEqual(domain.domainChildren, ['web']);
  assert.match(domain.packet, /Domain scope for 1 child scope\(s\) \(web\); lifecycle \(create\/archive\/delete\) stays with the hub/);
  assert.equal(buildAssignment({ repo: 'x' }, { slot: 'A', steerId: 's', epoch: 1, task: 't', tests: [], blockers: [], next: null }).includes('Domain'), false);
});

test('scopes groups domains with children, tags and inboxes', () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/admin', id: 'hub', kind: 'hub' });
  provisionDir(world, { path: '/p/team-a', id: 'team-a', checkpoint: { task: 'Coordinate', tests: [], blockers: [], next: null, epoch: 1, updatedAt: new Date().toISOString() } });
  provisionDir(world, {
    path: '/p/web', id: 'web', domain: 'team-a',
    checkpoint: { task: 'Ship', tests: [], blockers: ['domain:needs-api', 'hub:needs-release', 'flaky'], next: 'done', epoch: 1, updatedAt: new Date().toISOString() },
  });
  provisionDir(world, { path: '/p/other', id: 'other' });
  const state = { workspaces: world.workspaces, agents: world.agents, projects: world.projects };
  const rows = scopeRows(state);
  const web = rows.find((r) => r.id === 'web');
  assert.equal(web.domain, 'team-a');
  assert.deepEqual(web.checkpoint.domainEscalations, ['domain:needs-api']);
  const team = rows.find((r) => r.id === 'team-a');
  assert.deepEqual(team.children, ['web']);
  assert.deepEqual(team.inbox, ['web: domain:needs-api']);
  const hub = rows.find((r) => r.id === 'hub');
  assert.deepEqual(hub.inbox, ['web: hub:needs-release']);
  const text = formatScopeRows(rows);
  const lines = text.split('\n');
  assert.deepEqual(lines.map((l) => l.split(' [')[0]), ['hub', 'team-a', 'web', 'other']);
  assert.match(lines[2], /domain team-a/);
  assert.match(lines[1], /domain \(1 children\)/);
  assert.match(lines[2], /domain: domain:needs-api/);
  assert.match(lines[1], /inbox: web: domain:needs-api/);
  assert.match(lines[0], /inbox: web: hub:needs-release/);
});

test('status and resume brief show the domain and open domain items', async () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/team-a', id: 'team-a' });
  provisionDir(world, {
    path: '/p/web', id: 'web', domain: 'team-a',
    checkpoint: { task: 'Ship', tests: [], blockers: ['domain:needs-api'], next: null, epoch: 1, updatedAt: new Date().toISOString() },
  });
  const runner = runnerFor(world);
  const [childDiscovery] = await runner.discoverAll([{ local: '/p/web' }]);
  const status = steerStatus(childDiscovery);
  assert.equal(status.domain, 'team-a');
  assert.deepEqual(status.domainChildren, []);
  const [domainDiscovery] = await runner.discoverAll([{ local: '/p/team-a' }]);
  assert.deepEqual(steerStatus(domainDiscovery).domainChildren, ['web']);
  const brief = buildResumeBrief(status, { scope: childDiscovery.scope });
  assert.match(brief, /Resume brief for web \(dir\).*· domain team-a\./);
  assert.match(brief, /Open domain items \(escalated to the domain steer team-a\):\n- domain:needs-api/);
  const plain = buildResumeBrief(steerStatus(domainDiscovery), { scope: domainDiscovery.scope });
  assert.ok(!plain.includes('domain'), 'briefs without a domain stay unchanged');
});

test('same run creates the domain scope and its child, child entry first', async () => {
  const world = makeWorld();
  world.checkouts['/p/team-a'] = { remotes: {} };
  world.checkouts['/p/web'] = { remotes: {} };
  const runner = runnerFor(world);
  const entries = [{ local: '/p/web', domain: 'team-a' }, { local: '/p/team-a' }];
  const plans = await runner.runPlans(entries);
  assert.equal(plans[0].conflicts.length, 0, JSON.stringify(plans[0].conflicts));
  assert.equal(plans[1].conflicts.length, 0, JSON.stringify(plans[1].conflicts));
  assert.match(plans[0].notes.join('\n'), /Domain scope "team-a" is planned in this run; its entry is applied first/);
  assert.equal(plans[0].ops.find((o) => o.key === 'workspace.main').params.metadata[METADATA_KEY].scope.domain, 'team-a');
  // The plan layer orders domain first; entries travel with their plans.
  const order = domainFirstPlanOrder(plans);
  assert.deepEqual(order, [1, 0]);
  const orderedEntries = order.map((i) => entries[i]);
  const orderedPlans = order.map((i) => plans[i]);
  const authorization = createAuthorization(orderedPlans, CONFIG, { entries: orderedEntries, allowFork: false, adopt: {} });
  const execute = createExecutors({ client: fakeClient(world), gh: strictGh(world), git: fakeGit(world), paseoCli: fakePaseoCli(world), sleep: async () => {} });
  const result = await applyPlans({ authorization, config: CONFIG, confirm: authorization.hash, lookupReceipt: fakeLookup(world), runPlans: (list, options) => runner.runPlans(list, options), execute });
  assert.deepEqual(result.report.map((r) => r.status), ['complete', 'complete'], JSON.stringify(result.report));
  const scopes = listScopes({ workspaces: world.workspaces, agents: world.agents, projects: [] });
  assert.equal(scopes.find((s) => s.id === 'team-a').kind, 'dir');
  assert.equal(scopes.find((s) => s.id === 'web').domain, 'team-a');
  const state = { workspaces: world.workspaces, agents: world.agents, projects: world.projects };
  assert.deepEqual(scopeRows(state).find((r) => r.id === 'team-a').children, ['web']);
  assert.match(formatScopeRows(scopeRows(state)), /web \[dir\][^\n]*domain team-a/);
  const [childDiscovery] = await runner.discoverAll([{ local: '/p/web' }]);
  assert.equal(steerStatus(childDiscovery).domain, 'team-a');
});

test('existing child may point at a domain planned in the same run (sibling spelling wins)', async () => {
  const world = makeWorld();
  world.checkouts['/p/team-a'] = { remotes: {} };
  provisionDir(world, { path: '/p/web', id: 'web', epoch: 4 });
  const entries = [{ local: '/p/web', domain: 'TEAM-A' }, { local: '/p/team-a', name: 'Team-A' }];
  const plans = await runnerFor(world).runPlans(entries);
  assert.equal(plans[0].conflicts.length, 0, JSON.stringify(plans[0].conflicts));
  assert.equal(plans[1].conflicts.length, 0, JSON.stringify(plans[1].conflicts));
  assert.deepEqual(keys(plans[0]), ['scope.domain']);
  assert.equal(plans[0].ops.find((o) => o.key === 'scope.domain').params.domain, 'Team-A');
  assert.deepEqual(domainFirstPlanOrder(plans), [1, 0]);
});

test('unknown domains still conflict and name the same-run option', async () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/web', id: 'web' });
  const [p] = await runnerFor(world).runPlans([{ local: '/p/web', domain: 'nope' }]);
  assert.match(p.conflicts.find((c) => c.key === 'scope.domain').reason, /nor planned in this run/);
});

test('domainFirstPlanOrder: identity without edges, domain first, cycles terminate', () => {
  const main = (id, domain) => ({
    key: 'workspace.main',
    params: { metadata: { [METADATA_KEY]: { scope: { id, kind: 'dir', ...(domain ? { domain } : {}) } } } },
  });
  const plan = (repo, ops) => ({ repo, ops });
  assert.deepEqual(domainFirstPlanOrder([plan('a', []), plan('b', [])]), [0, 1]);
  const child = plan('web', [main('web', 'team-a')]);
  const domain = plan('team-a', [main('team-a')]);
  const other = plan('other', [main('other')]);
  assert.deepEqual(domainFirstPlanOrder([child, domain]), [1, 0]);
  assert.deepEqual(domainFirstPlanOrder([domain, child]), [0, 1]);
  assert.deepEqual(domainFirstPlanOrder([child, other, domain]), [2, 0, 1], 'unrelated plans keep relative order around the move');
  const viaOp = plan('web', [{ key: 'scope.domain', params: { workspaceId: 'wks_x', domain: 'team-a', epoch: 1 } }]);
  assert.deepEqual(domainFirstPlanOrder([viaOp, domain]), [1, 0], 'scope.domain op edges count too');
  const clearing = plan('web', [{ key: 'scope.domain', params: { workspaceId: 'wks_x', domain: null, epoch: 1 } }]);
  assert.deepEqual(domainFirstPlanOrder([clearing, domain]), [0, 1], 'clearing is no edge');
  const live = plan('web', [main('web', 'team-a')]);
  assert.deepEqual(domainFirstPlanOrder([live]), [0], 'live domains (no same-run plan) order nothing');
  const a = plan('a', [main('a', 'b')]);
  const b = plan('b', [main('b', 'a')]);
  assert.deepEqual(domainFirstPlanOrder([a, b]).sort(), [0, 1], 'cycles terminate with every plan kept');
});

test('scopes and status show the domain for the retired scope and its successor', async () => {
  const world = makeWorld();
  provisionDir(world, { path: '/p/team-a', id: 'team-a' });
  const old = provisionDir(world, { path: '/p/demo', id: 'web', domain: 'team-a', epoch: 4 });
  old.metadata[METADATA_KEY].retired = true;
  old.metadata[METADATA_KEY].movedTo = '/p/moved';
  old.metadata[METADATA_KEY].activeSteer = null;
  provisionDir(world, { path: '/p/moved', id: 'web', domain: 'team-a', epoch: 1 });
  const state = { workspaces: world.workspaces, agents: world.agents, projects: world.projects };
  const rows = scopeRows(state);
  assert.equal(rows.filter((r) => r.id === 'web').length, 2);
  const lines = formatScopeRows(rows).split('\n').filter((l) => l.startsWith('web '));
  assert.equal(lines.length, 2, 'both the retired and the successor row print');
  assert.ok(lines.every((l) => l.includes('domain team-a')), lines.join('\n'));
  const runner = runnerFor(world);
  const [fresh] = await runner.discoverAll([{ local: '/p/moved' }]);
  assert.equal(steerStatus(fresh).domain, 'team-a');
  const [stale] = await runner.discoverAll([{ local: '/p/demo' }]);
  assert.equal(steerStatus(stale).domain, 'team-a');
});

test('CLI --domain validation and usage', (t) => {
  let out = runCli(t, ['--help']);
  assert.match(out.stdout, /--domain <id>/);
  out = runCli(t, ['plan', 'example/a', 'example/b', '--domain', 'team-a']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /--domain needs exactly one repository entry/);
  out = runCli(t, ['status', 'example/a', '--domain', 'team-a']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /--domain is only accepted with plan/);
  out = runCli(t, ['plan', '--domain', 'team-a'], { reposFile: [{ local: '/p/web', domain: 'other' }] });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /--domain conflicts with the entry "domain"/);
});
