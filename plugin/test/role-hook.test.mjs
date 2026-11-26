// The agent.open.before hook appends the role rules with the per-host CLI and
// logs one evidence line per append (no prompt text); anything else passes
// through untouched and silent.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

register('./ts-resolve-hooks.mjs', import.meta.url);

const contribute = (await import('../index.server.ts')).default;
const { factoryConfigSettings } = await import('../shared/settings.ts');
const { settingsFromConfig } = await import('../shared/settings-validate.ts');
const {
  ADVISOR_ROLE_PROMPT,
  ROLE_RULES_ID,
  STEER_ROLE_PROMPT,
  WORKER_ENV_LIMITS,
  withFactoryCli,
} = await import('../server/core/role-prompts.mjs');
const { shortHolderId } = await import('../server/core/steer-create.mjs');

const CONFIG = {
  version: 1,
  github: { owner: 'TestOwner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/tmp/wsf-test',
  workspaceTitle: 'Main',
  profiles: {
    sol: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
    opus: { provider: 'claude', model: 'claude-opus-5-5', thinking: null, mode: null, advisor: true },
  },
  steers: { slots: { A: 'sol', E: 'opus' }, prepare: ['A', 'E'], initialActive: 'A' },
  workers: { priority: ['sol'], defaultProfile: 'sol' },
};

function setup(t) {
  const pluginDir = mkdtempSync(join(tmpdir(), 'factory-role-hook-'));
  t.after(() => rmSync(pluginDir, { recursive: true, force: true }));
  const hooks = new Map();
  const hostValues = {
    ...settingsFromConfig(CONFIG, factoryConfigSettings.schema.parse({})),
    githubOwner: 'TestOwner',
    checkoutRoot: '/tmp/wsf-test',
  };
  const server = {
    registerSettings: (contract) => ({
      read: async () => ({
        status: 'ready',
        revision: 'r1',
        values: contract.id === 'factory-config' ? hostValues : {},
      }),
    }),
    handle: () => {},
    addHook: (name, fn) => {
      hooks.set(name, fn);
      return () => { hooks.delete(name); };
    },
  };
  const paseo = { config: { get: async () => ({ config: { plugins: { 'workspace-factory': { path: pluginDir } } } }) } };
  const lines = [];
  const realLog = console.log;
  console.log = (line) => { lines.push(String(line)); };
  t.after(() => { console.log = realLog; });
  const stop = contribute(server);
  t.after(() => stop());
  const open = hooks.get('agent.open.before');
  assert.ok(open, 'server entry registers agent.open.before');
  return { open, paseo, pluginDir, lines };
}

function openRequest(overrides = {}) {
  return {
    agentId: 'abcdef01-uuid',
    workspaceId: null,
    provider: 'codex',
    cwd: '/tmp',
    reason: 'resume',
    purpose: 'interactive',
    title: null,
    background: false,
    labels: { 'wsf.role': 'steer' },
    metadata: {},
    appendSystemPrompt: [],
    tools: [],
    env: {},
    mcpServers: {},
    ...overrides,
  };
}

test('interactive steer open appends the rendered steer text and logs one line', async (t) => {
  const { open, paseo, pluginDir, lines } = setup(t);
  const result = await open({ request: openRequest() }, { paseo });
  assert.deepEqual(result.appendSystemPrompt, [withFactoryCli(STEER_ROLE_PROMPT, { pluginDir })]);
  assert.deepEqual(result.env, {});
  assert.ok(result.appendSystemPrompt[0].includes(`node ${pluginDir}/cli.mjs resume`));
  assert.ok(result.appendSystemPrompt[0].includes(`Factory role rules: ${ROLE_RULES_ID}`));
  assert.deepEqual(lines, [
    `[factory] role prompt ${ROLE_RULES_ID} appended: agent ${shortHolderId('abcdef01-uuid')}, reason resume, role steer`,
  ]);
});

test('advisor slot gets the advisor text and role in the log line', async (t) => {
  const { open, paseo, lines } = setup(t);
  const result = await open({ request: openRequest({ labels: { 'wsf.role': 'steer', 'wsf.slot': 'E' } }) }, { paseo });
  assert.deepEqual(result.appendSystemPrompt, [ADVISOR_ROLE_PROMPT]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /role advisor$/);
  assert.ok(lines[0].startsWith('[factory] role prompt '));
});

test('interactive worker open merges env limits without overwriting and logs one line', async (t) => {
  const { open, paseo, lines } = setup(t);
  const result = await open({ request: openRequest({ labels: { 'wsf.role': 'worker' }, env: { BASH_MAX_OUTPUT_LENGTH: '999' } }) }, { paseo });
  assert.deepEqual(result.env, { BASH_MAX_OUTPUT_LENGTH: '999', COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES: '10240' });
  assert.deepEqual(result.appendSystemPrompt, []);
  assert.deepEqual(lines, [
    `[factory] worker env limits set: agent ${shortHolderId('abcdef01-uuid')}, reason resume, env 1`,
  ]);
});

test('worker open with all limits set logs env 0 and leaves the request alone', async (t) => {
  const { open, paseo, lines } = setup(t);
  const result = await open({ request: openRequest({ labels: { 'wsf.role': 'worker' }, env: { ...WORKER_ENV_LIMITS } }) }, { paseo });
  assert.equal(result, undefined);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /env 0$/);
});

test('history opens and non-factory agents pass through silent', async (t) => {
  const { open, paseo, lines } = setup(t);
  assert.equal(await open({ request: openRequest({ purpose: 'history' }) }, { paseo }), undefined);
  assert.equal(await open({ request: openRequest({ labels: {} }) }, { paseo }), undefined);
  assert.deepEqual(lines, []);
});

test('continuations get the origin role before their labels are persisted', async (t) => {
  const { open, paseo } = setup(t);
  const origin = { id: 'origin', workspaceId: 'ws', labels: { 'wsf.role': 'steer', 'wsf.scope': 'example/repo', 'wsf.slot': 'A' } };
  const continued = { id: 'child', workspaceId: 'ws', labels: { 'zerosub.continued-from': 'origin' } };
  paseo.agents = { list: async () => ({ entries: [origin, continued], pageInfo: { hasMore: false } }) };
  const request = openRequest({ agentId: 'child', workspaceId: 'ws', labels: continued.labels });
  const result = await open({ request }, { paseo });
  assert.ok(result.appendSystemPrompt[0].includes('Factory role rules'));
  assert.deepEqual(continued.labels, { 'zerosub.continued-from': 'origin' });
  continued.workspaceId = 'different';
  assert.equal(await open({ request }, { paseo }), undefined);
  continued.workspaceId = 'ws';
  continued.labels['wsf.role'] = 'steer';
  const partial = openRequest({ agentId: 'child', workspaceId: 'ws', labels: continued.labels });
  assert.ok((await open({ request: partial }, { paseo })).appendSystemPrompt[0].includes('Factory role rules'));
  delete continued.labels['wsf.role'];
  origin.labels['wsf.role'] = 'worker';
  const worker = await open({ request }, { paseo });
  assert.equal(worker.env.COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES, '10240');
});
