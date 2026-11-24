// Adoption checks (Befunde a–c): unlabelled steer candidates stay visible in
// plan and status (workers name a parent candidate instead of "Steer ?");
// adopting a restricted-provider agent with a profile mismatch is a conflict
// unless the repo is provably public; adopting a high-context steer hints at
// fresh. Fakes only; no daemon.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubNotFound, remoteToFullName } from '../src/github.mjs';
import { createRunner } from '../src/factory.mjs';
import { steerStatus } from '../src/steer.mjs';
import { LABEL, METADATA_KEY, PARENT_LABEL } from '../src/paseo.mjs';

const CONFIG = {
  version: 1,
  github: { owner: 'example', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/p',
  workspaceTitle: 'Main',
  profiles: {
    sol: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
    muse: { provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null, mode: 'allowAll' },
    sonnet: { provider: 'copilot', model: 'claude-sonnet-4.5', thinking: null, mode: null },
  },
  steers: { slots: { A: 'sol', B: 'muse', C: 'sonnet' }, prepare: ['A'], initialActive: 'A' },
  workers: { defaultProfile: 'muse' },
  usage: { warnContextTokens: 800000 },
};

const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'full-access' }] },
  { provider: 'muse', enabled: true, status: 'ready', models: [{ id: 'muse-spark-1.3-contributor', thinkingOptions: [] }], modes: [{ id: 'allowAll' }] },
  { provider: 'copilot', enabled: true, status: 'ready', models: [{ id: 'claude-sonnet-4.5', thinkingOptions: [] }], modes: [] },
];

const WEB = 'example/web';

function makeWorld() {
  return {
    repos: {}, checkouts: {}, localDirs: new Set(), projects: [], workspaces: [], agents: [],
    providers: structuredClone(PROVIDERS), calls: [], receipts: new Map(), seq: 0,
  };
}

const ghApi = (fullName, extra = {}) => {
  const [owner, name] = fullName.split('/');
  return {
    full_name: fullName, name, owner: { login: owner }, fork: false, archived: false, default_branch: 'main',
    clone_url: `https://github.com/${fullName}.git`, ssh_url: `git@github.com:${fullName}.git`, html_url: `https://github.com/${fullName}`, ...extra,
  };
};

function fakeGh(world) {
  return (args) => {
    const path = args.find((a) => typeof a === 'string' && a.startsWith('repos/'));
    const full = path.slice('repos/'.length);
    const hit = Object.keys(world.repos ?? {}).find((k) => k.toLowerCase() === full.toLowerCase());
    if (!hit) throw new GitHubNotFound(`HTTP 404: Not Found (${full})`);
    return JSON.stringify(world.repos[hit]);
  };
}

function fakeGit(world) {
  return (cwd, args) => {
    const checkout = world.checkouts[cwd];
    if (!checkout) throw new Error(`not a repo: ${cwd}`);
    if (args[0] === 'config') {
      const lines = Object.entries(checkout.remotes ?? {}).map(([n, u]) => `remote.${n}.url ${u}`);
      if (!lines.length) throw new Error('exit 1');
      return lines.join('\n');
    }
    if (args[0] === 'rev-parse') return 'main';
    if (args[0] === 'status') return '';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

function worldScan(world) {
  return () => Object.entries(world.checkouts).map(([path, c]) => ({
    path,
    linkedWorktree: Boolean(c.linkedWorktree),
    remotes: { ...(c.remotes ?? {}) },
    repos: Object.fromEntries(Object.entries(c.remotes ?? {}).map(([n, u]) => [n, remoteToFullName(u)])),
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

function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: 'idle', archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}

/** Owned github repo with an unlabelled candidate per slot and a worker below B. */
function githubWorld({ repoPrivate = false } = {}) {
  const world = makeWorld();
  world.repos = { [WEB]: ghApi(WEB, { private: repoPrivate }) };
  world.checkouts['/p/web'] = { remotes: { origin: `https://github.com/${WEB}.git` } };
  const project = addProject(world, '/p/web');
  const ws = {
    id: `wks_${String(++world.seq).padStart(16, '0')}`, projectId: project.projectId,
    workspaceDirectory: '/p/web', workspaceKind: 'local_checkout', title: 'Main', name: 'Main',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: WEB, kind: 'github', locator: WEB } } },
    createdAt: new Date().toISOString(),
  };
  world.workspaces.push(ws);
  const agents = {
    candA: addAgent(world, { title: 'Steer A', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id, lastUsage: { contextWindowUsedTokens: 900000, contextWindowMaxTokens: 1000000 } }),
    candB: addAgent(world, { title: 'Steer B [fp]', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id }),
    candC: addAgent(world, { title: 'Steer C [fp]', provider: 'muse', model: 'muse-spark-1.3-contributor', workspaceId: ws.id }),
    candZ: addAgent(world, { title: 'Steer Z', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id }),
    digit: addAgent(world, { title: 'Steer 3', provider: 'muse', model: 'muse-spark-1.3-contributor', workspaceId: ws.id }),
  };
  agents.worker = addAgent(world, { title: 'Build', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id, labels: { [PARENT_LABEL]: agents.candB.id } });
  return { world, ws, agents };
}

function runnerFor(world, config = CONFIG) {
  return createRunner({
    config, client: null, gh: fakeGh(world), git: fakeGit(world),
    readState: async () => structuredClone({ projects: world.projects, workspaces: world.workspaces, agents: world.agents, providers: world.providers }),
    scan: worldScan(world),
    inspectTarget: () => { throw new Error('no clones here'); },
    realpath: (p) => p, existsDir: fakeExistsDir(world),
  });
}

// ------------------------------------------------------------------ (a) candidates

test('(a) plan lists unlabelled candidates of slots outside the plan', async () => {
  const { world, agents } = githubWorld();
  const [p] = await runnerFor(world).runPlans([WEB]);
  assert.match(p.conflicts.find((c) => c.key === 'steer.A').reason, new RegExp(`--adopt A=${agents.candA.id}`));
  const notes = p.notes.join('\n');
  assert.match(notes, new RegExp(`Unlabelled candidate "Steer B \\[fp\\]" ${agents.candB.id}.*outside this plan's slots \\(A\\); adopt with --adopt B=${agents.candB.id} or add the slot via --slots`));
  assert.match(notes, new RegExp(`Unlabelled candidate "Steer C \\[fp\\]" ${agents.candC.id}.*--adopt C=${agents.candC.id}`));
  assert.match(notes, new RegExp(`Unlabelled candidate "Steer Z" ${agents.candZ.id}.*slot Z, which is not defined in steers\\.slots`));
  assert.ok(!notes.includes('"Steer A"'), 'planned slots conflict above, never in the notes');
});

test('(a) status names a parent candidate and lists all unlabelled candidates', async () => {
  const { world, agents } = githubWorld();
  const [d] = await runnerFor(world).discoverAll([WEB]);
  const status = steerStatus(d);
  const worker = status.workers.find((w) => w.id === agents.worker.id);
  assert.equal(worker.parentSlot, null);
  assert.deepEqual(worker.parentCandidate, { id: agents.candB.id, title: 'Steer B [fp]', slot: 'B' });
  const byId = new Map(status.candidates.map((c) => [c.id, c]));
  assert.equal(byId.get(agents.candB.id).slot, 'B');
  assert.equal(byId.get(agents.candC.id).slot, 'C');
  assert.equal(byId.get(agents.digit.id).slot, null);
  assert.deepEqual([byId.get(agents.candB.id).provider, byId.get(agents.candB.id).model], ['codex', 'gpt-6.2-sol']);
});

// ------------------------------------------------------------------ (b) privacy

test('(b) restricted-provider mismatch on a private repo is a conflict', async () => {
  const { world, agents } = githubWorld({ repoPrivate: true });
  const [p] = await runnerFor(world).runPlans([WEB], { adopt: { '*': { C: agents.candC.id } } });
  assert.match(p.conflicts.find((c) => c.key === 'steer.C').reason,
    /Cannot adopt .* \(muse\/muse-spark-1\.3-contributor\) as Steer C: muse agents are restricted to public code, but example\/web is private/);
  assert.ok(!p.ops.some((o) => o.key === 'steer.C'));
});

test('(b) restricted-provider mismatch on a public repo is a note, adoption proceeds', async () => {
  const { world, agents } = githubWorld({ repoPrivate: false });
  const [p] = await runnerFor(world).runPlans([WEB], { adopt: { '*': { C: agents.candC.id } } });
  assert.equal(p.ops.find((o) => o.key === 'steer.C').kind, 'paseo.agent.adopt');
  assert.match(p.notes.join('\n'), /Adopted Steer C runs muse\/muse-spark-1\.3-contributor; profile "sonnet" names copilot\/claude-sonnet-4\.5 \(kept\)/);
});

test('(b) unknown publicity (local scope) is a conflict; other mismatches stay notes', async () => {
  const world = makeWorld();
  world.checkouts['/p/notes'] = { remotes: {} };
  const project = addProject(world, '/p/notes');
  const ws = {
    id: 'wks_notes0000000001', projectId: project.projectId, workspaceDirectory: '/p/notes',
    workspaceKind: 'local_checkout', title: 'Main', name: 'Main',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: 'notes', kind: 'dir', locator: '/p/notes' } } },
  };
  world.workspaces.push(ws);
  const muse = addAgent(world, { title: 'Steer A', provider: 'muse', model: 'muse-spark-1.3-contributor', workspaceId: ws.id });
  const [p] = await runnerFor(world).runPlans([{ local: '/p/notes' }], { adopt: { '*': { A: muse.id } } });
  assert.match(p.conflicts.find((c) => c.key === 'steer.A').reason, /restricted to public code, but notes is of unknown publicity/);

  const pub = githubWorld({ repoPrivate: true });
  const [q] = await runnerFor(pub.world).runPlans([WEB], { adopt: { '*': { B: pub.agents.candB.id } } });
  assert.equal(q.ops.find((o) => o.key === 'steer.B').kind, 'paseo.agent.adopt', 'codex mismatch on private repo stays a note');
  assert.match(q.notes.join('\n'), /Adopted Steer B runs codex\/gpt-6\.2-sol; profile "muse" names muse\/muse-spark-1\.3-contributor \(kept\)/);
});

test('(b) matching restricted adoption on a private repo is allowed', async () => {
  const { world, agents } = githubWorld({ repoPrivate: true });
  const [p] = await runnerFor(world).runPlans([WEB], { adopt: { '*': { B: agents.digit.id } } });
  assert.equal(p.ops.find((o) => o.key === 'steer.B').kind, 'paseo.agent.adopt');
  assert.ok(!p.conflicts.some((c) => c.key === 'steer.B'));
});

// ------------------------------------------------------------------ (c) context

test('(e) live steers outside prepare block creates, pointing at --slots', async () => {
  const configAC = {
    ...structuredClone(CONFIG),
    steers: { slots: { A: 'sol', C: 'sonnet', D: 'sol', E: 'muse' }, prepare: ['A', 'C'], initialActive: 'A' },
  };
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const project = addProject(world, '/p/demo');
  const ws = {
    id: 'wks_demo000000000001', projectId: project.projectId, workspaceDirectory: '/p/demo',
    workspaceKind: 'local_checkout', title: 'Main', name: 'Main',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: 'demo', kind: 'dir', locator: '/p/demo' } } },
  };
  world.workspaces.push(ws);
  const d = addAgent(world, { title: 'Steer D', provider: 'codex', model: 'gpt-6.2-sol', workspaceId: ws.id, labels: { [LABEL.repo]: 'demo', [LABEL.role]: 'steer', [LABEL.slot]: 'D', [LABEL.scope]: 'demo' } });
  const e = addAgent(world, { title: 'Steer E', provider: 'muse', model: 'muse-spark-1.3-contributor', workspaceId: ws.id, labels: { [LABEL.repo]: 'demo', [LABEL.role]: 'steer', [LABEL.slot]: 'E', [LABEL.scope]: 'demo' } });
  const [p] = await runnerFor(world, configAC).runPlans([{ local: '/p/demo' }]);
  assert.ok(!p.ops.some((o) => o.kind === 'paseo.agent.create'), 'no create ops');
  for (const slot of ['A', 'C']) {
    assert.match(p.conflicts.find((c) => c.key === `steer.${slot}`).reason,
      new RegExp(`Steer ${slot} has no live agent, but live steers D \\(${d.id}\\), E \\(${e.id}\\) run in slots outside prepare \\(A, C\\); refusing to create another steer — re-run with --slots A,C,D,E`));
  }
  const [covered] = await runnerFor(world, configAC).runPlans([{ local: '/p/demo' }], { slots: ['A', 'C', 'D', 'E'] });
  assert.ok(covered.ops.some((o) => o.key === 'steer.A' && o.kind === 'paseo.agent.create'), 'covering --slots unblocks');
  assert.ok(!covered.conflicts.some((c) => c.key === 'steer.A'));
});

test('(e) covered runners without creates are noted, not conflicted', async () => {
  const configAC = {
    ...structuredClone(CONFIG),
    steers: { slots: { A: 'sol', C: 'sonnet', D: 'sol' }, prepare: ['A', 'C'], initialActive: 'A' },
  };
  const world = makeWorld();
  world.checkouts['/p/demo'] = { remotes: {} };
  const project = addProject(world, '/p/demo');
  const ws = {
    id: 'wks_demo000000000002', projectId: project.projectId, workspaceDirectory: '/p/demo',
    workspaceKind: 'local_checkout', title: 'Main', name: 'Main',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1, scope: { id: 'demo', kind: 'dir', locator: '/p/demo' } } },
  };
  world.workspaces.push(ws);
  for (const [slot, provider, model] of [['A', 'codex', 'gpt-6.2-sol'], ['C', 'copilot', 'claude-sonnet-4.5'], ['D', 'codex', 'gpt-6.2-sol']]) {
    addAgent(world, { title: `Steer ${slot}`, provider, model, workspaceId: ws.id, labels: { [LABEL.repo]: 'demo', [LABEL.role]: 'steer', [LABEL.slot]: slot, [LABEL.scope]: 'demo' } });
  }
  const [p] = await runnerFor(world, configAC).runPlans([{ local: '/p/demo' }]);
  assert.equal(p.status, 'complete');
  assert.match(p.notes.join('\n'), /Live steers D \(agent-\d+\) run in slots outside prepare \(A, C\) and are left untouched; cover them with --slots A,C,D to include them/);
});

test('(c) adopting a steer at ctx >= warnContextTokens hints at fresh', async () => {
  const { world, agents } = githubWorld();
  const [p] = await runnerFor(world).runPlans([WEB], { adopt: { '*': { A: agents.candA.id } } });
  assert.equal(p.ops.find((o) => o.key === 'steer.A').kind, 'paseo.agent.adopt');
  assert.match(p.notes.join('\n'), /Adopted Steer A context 900000\/1000000 tokens reaches usage\.warnContextTokens=800000; consider fresh after the takeover/);
  const [low] = await runnerFor(world).runPlans([WEB], { adopt: { '*': { B: agents.candB.id } } });
  assert.ok(!low.notes.join('\n').includes('consider fresh'), 'no usage, no hint');
  const noWarn = { ...structuredClone(CONFIG), usage: undefined };
  const [unset] = await runnerFor(world, noWarn).runPlans([WEB], { adopt: { '*': { A: agents.candA.id } } });
  assert.ok(!unset.notes.join('\n').includes('consider fresh'), 'unset threshold, no hint');
});
