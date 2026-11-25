// Thin CLI tests: kept commands delegate to plugin RPCs, removed/unknown
// commands point to /factory, and missing plugin/daemon fails with a one-line fix.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from '../src/cli.mjs';

function makeFakeRpc(responses = {}) {
  const calls = [];
  let closed = false;
  return {
    calls,
    isClosed: () => closed,
    connectRpc: async () => ({
      async invokePluginRpc(pluginId, method, input) {
        calls.push({ pluginId, method, input });
        const reply = responses[method];
        if (reply instanceof Error) throw reply;
        if (typeof reply === 'function') return reply(input);
        return reply ?? {};
      },
      async close() {
        closed = true;
      },
    }),
  };
}

async function invoke(argv, { responses = {}, env = {}, cwd = '/work/demo' } = {}) {
  const fake = makeFakeRpc(responses);
  const stdout = [];
  const stderr = [];
  let exitCode = 0;
  await runCli(argv, {
    connectRpc: fake.connectRpc,
    env,
    cwd,
    out: (msg) => stdout.push(String(msg)),
    err: (msg) => stderr.push(String(msg)),
    setExitCode: (code) => { exitCode = code; },
  });
  return { calls: fake.calls, closed: fake.isClosed(), stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode };
}

test('help prints kept commands without connecting to the plugin', async () => {
  let connected = false;
  const out = [];
  await runCli(['help'], {
    connectRpc: async () => { connected = true; throw new Error('should not connect'); },
    out: (msg) => out.push(msg),
  });
  assert.equal(connected, false);
  assert.match(out[0], /status \[scope\]/);
  assert.match(out[0], /worker pick \[scope\]/);
  assert.match(out[0], /\/factory in the Paseo composer/);
});

test('status calls factory.status and preserves text and json output formats', async () => {
  const statusPayload = {
    repo: 'o/r', domain: null, domainChildren: [], workspace: { id: 'wks_1', title: 'Main', directory: '/p/r' },
    worktree: null, state: { activeSteer: 'A', epoch: 2 }, checkpoint: null, steers: [], workers: [],
    openWorkers: [], candidates: [], usageWarnings: [], warnings: [],
    scope: { id: 'o/r', kind: 'github' }, deprecatedAlias: true, text: 'o/r · workspace wks_1 · active Steer A (epoch 2)',
  };
  const plain = await invoke(['status', 'local/r'], { responses: { 'factory.status': statusPayload } });
  assert.equal(plain.closed, true);
  assert.deepEqual(plain.calls, [{ pluginId: 'workspace-factory', method: 'factory.status', input: { repo: 'local/r' } }]);
  assert.equal(plain.stdout, statusPayload.text);
  assert.match(plain.stderr, /legacy alias for scope "o\/r"/);

  const json = await invoke(['status', '--json'], {
    responses: { 'factory.status': statusPayload },
    env: { PASEO_WORKSPACE_ID: 'wks_1', PASEO_AGENT_ID: 'steer-a' },
  });
  assert.deepEqual(json.calls[0].input, { workspaceId: 'wks_1', agentId: 'steer-a' });
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.repo, 'o/r');
  assert.equal('text' in parsed, false);
  assert.equal('deprecatedAlias' in parsed, false);
});

test('resume read-only and --apply call factory.resume and factory.resume.apply', async () => {
  const briefRes = await invoke(['resume', '--json'], {
    responses: { 'factory.resume': { scope: 'o/r', kind: 'github', epoch: 3, agentId: 's1', brief: 'Brief text', openWorkers: [], interrupted: null } },
    env: { PASEO_AGENT_ID: 's1' },
  });
  assert.deepEqual(briefRes.calls[0], { pluginId: 'workspace-factory', method: 'factory.resume', input: { agentId: 's1' } });
  assert.equal(JSON.parse(briefRes.stdout).brief, 'Brief text');

  const applied = await invoke(['resume', 'o/r', '--agent', 'w-1', '--apply'], {
    responses: {
      'factory.status': { workspace: { id: 'wks_1' }, workers: [{ id: 'w-1' }] },
      'factory.resume.apply': { status: 'blocked', detail: 'Needs attention' },
    },
  });
  assert.deepEqual(applied.calls.map((c) => c.method), ['factory.status', 'factory.resume.apply']);
  assert.deepEqual(applied.calls[1].input, { workspaceId: 'wks_1', agentId: 'w-1' });
  assert.equal(applied.stdout, 'Needs attention');
  assert.equal(applied.exitCode, 1);
});

test('checkpoint previews then writes via factory.checkpoint.preview and factory.checkpoint', async () => {
  const res = await invoke(['checkpoint', 'o/r', '--from-agent', 'steer-a', '--next', 'Run tests'], {
    responses: {
      'factory.checkpoint.preview': { fingerprint: 'fp-cp-1' },
      'factory.checkpoint': { checkpoint: { task: 'Ship', next: 'Run tests', epoch: 4 } },
    },
    env: { PASEO_AGENT_ID: 'steer-a' },
  });
  assert.deepEqual(res.calls.map((c) => c.method), ['factory.checkpoint.preview', 'factory.checkpoint']);
  assert.deepEqual(res.calls[1].input, {
    repo: 'o/r', fromAgent: 'steer-a', tests: [], blockers: [], next: 'Run tests', fingerprint: 'fp-cp-1', callerId: 'steer-a',
  });
  assert.equal(JSON.parse(res.stdout).task, 'Ship');
});

test('worker pick, list, start call the matching RPCs with env and cwd', async () => {
  const pick = await invoke(['worker', 'pick', '--failed', 'codex-high', '--reason', '429'], {
    responses: { 'factory.worker.pick': { profile: 'claude-sonnet', text: 'Worker pick: "claude-sonnet"' } },
    env: { PASEO_AGENT_ID: 'steer-a', PASEO_WORKSPACE_ID: 'wks_1' },
    cwd: '/p/demo',
  });
  assert.deepEqual(pick.calls[0], {
    pluginId: 'workspace-factory',
    method: 'factory.worker.pick',
    input: { workspaceId: 'wks_1', agentId: 'steer-a', cwd: '/p/demo', failed: 'codex-high', reason: '429' },
  });
  assert.equal(pick.stdout, 'Worker pick: "claude-sonnet"');

  const list = await invoke(['worker', 'list', 'o/r', '--json'], {
    responses: { 'factory.worker.list': { defaultProfile: 'sol', priority: ['sol'], chosen: 'sol', repoPublic: true, entries: [], text: 'ignored' } },
  });
  assert.equal(list.calls[0].method, 'factory.worker.list');
  assert.equal('text' in JSON.parse(list.stdout), false);

  const start = await invoke(['worker', 'start', 'o/r', '--task', 'Check tests', '--title', 'Tests', '--apply'], {
    responses: { 'factory.worker.start': { scope: 'o/r', agentId: 'w-9', provider: 'codex', text: 'Started worker w-9 (codex) in o/r' } },
    env: { PASEO_AGENT_ID: 'steer-a' },
  });
  assert.equal(start.calls[0].method, 'factory.worker.start');
  assert.equal(start.calls[0].input.callerId, 'steer-a');
  assert.equal(start.calls[0].input.apply, true);
  assert.equal(start.stdout, 'Started worker w-9 (codex) in o/r');
});

test('workers and workers --prune --apply call factory.workers', async () => {
  const list = await invoke(['workers', 'o/r'], {
    responses: { 'factory.workers': { scope: 'o/r', epoch: 2, workers: [], text: 'Workers of o/r · epoch 2 · 0 open / 0 total\n(no supervised workers)' } },
  });
  assert.equal(list.calls[0].method, 'factory.workers');
  assert.match(list.stdout, /Workers of o\/r/);

  const pruned = await invoke(['workers', 'o/r', '--prune', '--apply', '--json'], {
    responses: { 'factory.workers': { scope: 'o/r', epoch: 2, removed: [{ id: 'w-1' }], applied: true, text: 'pruned' } },
  });
  assert.deepEqual(pruned.calls[0].input, { repo: 'o/r', prune: true, apply: true });
  assert.deepEqual(JSON.parse(pruned.stdout), { scope: 'o/r', epoch: 2, removed: [{ id: 'w-1' }], applied: true });
});

test('switch dry-run, --apply, --no-send and self-takeover call factory.switch.preview and factory.switch', async () => {
  const dry = await invoke(['switch', 'o/r', '--to', 'B'], {
    responses: {
      'factory.switch.preview': { from: 'A', to: 'B', epoch: 5, packetChars: 42, checkpoint: true, packet: 'HANDOFF', fingerprint: 'fp-sw' },
    },
  });
  assert.deepEqual(dry.calls.map((c) => c.method), ['factory.switch.preview']);
  assert.match(dry.stdout, /^Dry-run: Steer A → B \(epoch 5\).*\n---\nHANDOFF$/);

  const applied = await invoke(['switch', 'o/r', '--to', 'B', '--apply', '--no-send', '--wait', '--language', 'de'], {
    responses: {
      'factory.switch.preview': { from: 'A', to: 'B', epoch: 5, packet: 'HANDOFF', fingerprint: 'fp-sw' },
      'factory.switch': { applied: true, from: 'A', to: 'B', epoch: 5, packetChars: 42, checkpoint: true, delivered: false, packet: 'HANDOFF', reply: 'OK' },
    },
    env: { PASEO_AGENT_ID: 'steer-b' },
  });
  assert.deepEqual(applied.calls[1].input, {
    repo: 'o/r', to: 'B', callerId: 'steer-b', language: 'de', fingerprint: 'fp-sw', deliver: 'none', notifyPrevious: false, wait: true,
  });
  assert.match(applied.stdout, /^Switched: Steer A → B \(epoch 5\)/);
  assert.match(applied.stdout, /--- reply of Steer B\nOK$/);
});

test('assign dry-run and --apply call factory.assign.preview and factory.assign', async () => {
  const dry = await invoke(['assign', 'o/r', '--task', 'Ship it'], {
    responses: {
      'factory.assign.preview': { scope: 'o/r', epoch: 2, slot: 'A', steerId: 's-a', previous: 'Old', packet: 'PKT', packetChars: 3, fingerprint: 'fp-a' },
    },
  });
  assert.match(dry.stdout, /Dry-run: o\/r epoch 2 · Steer A s-a/);
  assert.match(dry.stdout, /Replaces task: Old/);
  assert.match(dry.stdout, /Apply: paseo-factory assign "o\/r" --task "Ship it" --apply/);

  const applied = await invoke(['assign', 'o/r', '--task', 'Ship it', '--apply', '--no-send', '--expect-epoch', '2'], {
    responses: {
      'factory.assign.preview': { scope: 'o/r', epoch: 2, slot: 'A', steerId: 's-a', packet: 'PKT', fingerprint: 'fp-a' },
      'factory.assign': { scope: 'o/r', epoch: 2, slot: 'A', steerId: 's-a', applied: true, delivered: false, packet: 'PKT' },
    },
    env: { PASEO_AGENT_ID: 'hub-a' },
  });
  assert.deepEqual(applied.calls[1].input, {
    repo: 'o/r', task: 'Ship it', tests: [], blockers: [], callerId: 'hub-a', expectEpoch: 2, fingerprint: 'fp-a', send: false,
  });
  assert.match(applied.stdout, /^Assigned: o\/r epoch 2/);
});

test('removed and unknown commands point to /factory without connecting', async () => {
  let connected = false;
  const connectRpc = async () => { connected = true; throw new Error('should not connect'); };
  for (const cmd of ['plan', 'apply', 'fresh', 'steer', 'model', 'models', 'scopes', 'cleanup', 'drain']) {
    await assert.rejects(runCli([cmd], { connectRpc }), new RegExp(`/factory ${cmd}`));
  }
  await assert.rejects(runCli(['worker', 'set', '1', 'sol'], { connectRpc }), /\/factory worker set/);
  await assert.rejects(runCli(['worker', 'rm', '1'], { connectRpc }), /\/factory worker rm/);
  await assert.rejects(runCli(['bogus'], { connectRpc }), /\/factory/);
  assert.equal(connected, false);
});

test('clear one-line errors when the plugin or daemon is not running', async () => {
  await assert.rejects(
    runCli(['status', 'o/r'], { connectRpc: async () => { throw new Error('ECONNREFUSED'); } }),
    (err) => !err.message.includes('\n') && /not reachable/i.test(err.message) && /paseo plugin ls workspace-factory/.test(err.message),
  );
  await assert.rejects(
    invoke(['status', 'o/r'], { responses: { 'factory.status': new Error('Plugin is not available: workspace-factory') } }),
    (err) => !err.message.includes('\n') && /not running/i.test(err.message) && /paseo plugin ls workspace-factory/.test(err.message),
  );
  await assert.rejects(
    invoke(['worker', 'list'], { responses: { 'factory.worker.list': new Error('Plugin workspace-factory does not contribute RPC factory.worker.list') } }),
    (err) => !err.message.includes('\n') && /paseo plugin reload workspace-factory/.test(err.message),
  );
  await assert.rejects(
    invoke(['status', 'o/r'], { responses: { 'factory.status': { repo: 'o/r' } } }),
    (err) => !err.message.includes('\n') && /older than this CLI \(missing factory\.status text\)/.test(err.message) && /paseo plugin reload workspace-factory/.test(err.message),
  );
});
