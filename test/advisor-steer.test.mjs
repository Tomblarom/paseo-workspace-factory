// Advisor steers and the sensitive profile flag (WL-A): config rules,
// profile tags, switch refusal, fresh fallback, brief header, failover skip.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configWarnings, isSensitiveProfile, validateConfig } from '../plugin/server/core/config.mjs';
import { planAdvisorTag, planSensitiveTag } from '../plugin/server/core/models.mjs';
import {
  buildResumeBrief, freshSteer, steerStatus, switchSteer, SwitchRefused,
} from '../plugin/server/core/steer.mjs';
import { failoverChain } from '../plugin/server/core/supervision.mjs';
import { formatStatus } from '../plugin/server/core/scopes-view.mjs';
import { LABEL, METADATA_KEY } from '../plugin/server/core/paseo.mjs';

const CONFIG = {
  version: 1,
  github: { owner: 'TestOwner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/tmp/wsf-test',
  workspaceTitle: 'Main',
  profiles: {
    sol: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
    muse: { provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null, mode: 'allowAll' },
    agy: { provider: 'antigravity', model: 'gemini-3.8-flash-high', thinking: null, mode: 'yolo' },
    opus: { provider: 'claude', model: 'claude-opus-5-5', thinking: null, mode: null, advisor: true },
  },
  steers: { slots: { A: 'sol', B: 'muse', E: 'opus' }, prepare: ['A', 'B', 'E'], initialActive: 'A' },
  workers: { priority: ['muse', 'agy', 'sol'], defaultProfile: 'muse' },
};

const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }] }], modes: [{ id: 'full-access' }] },
  { provider: 'muse', enabled: true, status: 'ready', models: [{ id: 'muse-spark-1.3-contributor', thinkingOptions: [] }], modes: [{ id: 'allowAll' }] },
  { provider: 'antigravity', enabled: true, status: 'ready', models: [{ id: 'gemini-3.8-flash-high', thinkingOptions: [] }], modes: [{ id: 'yolo' }] },
  { provider: 'claude', enabled: true, status: 'ready', models: [{ id: 'claude-opus-5-5', thinkingOptions: [] }], modes: [] },
];

test('validateConfig refuses advisor-only and advisor-led slot sets', () => {
  assert.deepEqual(validateConfig(CONFIG), []);
  const led = structuredClone(CONFIG);
  led.steers.initialActive = 'E';
  assert.ok(validateConfig(led).some((e) => /initialActive must not be advisor slot "E"/.test(e)));
  const all = structuredClone(CONFIG);
  for (const name of Object.values(all.steers.slots)) all.profiles[name].advisor = true;
  assert.ok(validateConfig(all).some((e) => /at least one non-advisor slot/.test(e)));
  const badFlag = structuredClone(CONFIG);
  badFlag.profiles.sol.advisor = 'yes';
  badFlag.profiles.muse.sensitive = 'yes';
  const errors = validateConfig(badFlag).join('\n');
  assert.match(errors, /profiles\.sol\.advisor must be a boolean/);
  assert.match(errors, /profiles\.muse\.sensitive must be a boolean/);
});

test('configWarnings flags sensitive advisors and advisor worker entries', () => {
  const sens = structuredClone(CONFIG);
  sens.profiles.opus.sensitive = true;
  assert.ok(configWarnings(sens).some((w) => /profile "opus" is both advisor and sensitive/.test(w)));
  const listed = structuredClone(CONFIG);
  listed.workers.priority = ['opus', 'muse'];
  assert.ok(configWarnings(listed).some((w) => /workers\.priority lists advisor profile "opus"/.test(w)));
});

test('removed config keys are ignored silently (old installs)', () => {
  const old = structuredClone(CONFIG);
  old.advisors = { profiles: { design: 'opus', routine: 'missing' } };
  old.runtime = { stateDir: '/tmp/wsf-state', scratchDir: '/tmp/wsf-scratch' };
  old.quotaSampleMinutes = 10;
  assert.deepEqual(validateConfig(old), []);
  assert.deepEqual(configWarnings(old).filter((w) => w.includes('advisors.profiles')), []);
});

test('sensitive flag: explicit wins, otherwise muse migrates to true', () => {
  assert.equal(isSensitiveProfile(CONFIG, 'muse'), true);
  assert.equal(isSensitiveProfile(CONFIG, 'agy'), false);
  assert.equal(isSensitiveProfile(CONFIG, 'missing'), false);
  const off = structuredClone(CONFIG);
  off.profiles.muse.sensitive = false;
  assert.equal(isSensitiveProfile(off, 'muse'), false);
  const on = structuredClone(CONFIG);
  on.profiles.agy.sensitive = true;
  assert.equal(isSensitiveProfile(on, 'agy'), true);
});

test('planAdvisorTag and planSensitiveTag flip flags by profile or provider/model', () => {
  const tagged = planAdvisorTag(CONFIG, PROVIDERS, { spec: 'muse', on: true });
  assert.equal(tagged.config.profiles.muse.advisor, true);
  assert.match(tagged.summary, /profile "muse" advisor: off → on/);
  const untagged = planAdvisorTag(tagged.config, PROVIDERS, { spec: 'muse/muse-spark-1.3-contributor', on: false });
  assert.equal(untagged.config.profiles.muse.advisor, false);
  const sens = planSensitiveTag(CONFIG, PROVIDERS, { spec: 'agy', on: true });
  assert.equal(sens.config.profiles.agy.sensitive, true);
  assert.match(sens.summary, /profile "agy" sensitive: off → on/);
  const created = planSensitiveTag(CONFIG, PROVIDERS, { spec: '  opencode/Codestral-2  ', on: true });
  assert.equal(created.created, true, 'unknown provider/model creates a minimal profile');
  assert.equal(created.profileName, 'opencode-Codestral-2');
  assert.equal(created.config.profiles['opencode-Codestral-2'].sensitive, true);
  assert.match(created.warnings.join('\n'), /not startable/);
});

test('profile tags reject ambiguity and protect the last coordinator', () => {
  const config = structuredClone(CONFIG);
  config.profiles.sol2 = { ...config.profiles.sol };
  assert.throws(() => planAdvisorTag(config, PROVIDERS, { spec: 'codex/gpt-6.2-sol', on: true }), /matches several profiles/);
  assert.throws(() => planSensitiveTag(CONFIG, PROVIDERS, { spec: 'missing', on: true }), /Unknown profile/);
  const solo = structuredClone(CONFIG);
  solo.steers = { slots: { A: 'sol' }, prepare: ['A'], initialActive: 'A' };
  assert.throws(() => planAdvisorTag(solo, PROVIDERS, { spec: 'sol', on: true }), /at least one non-advisor slot/);
});

function steerDiscovery(config, { activeSteer = 'A' } = {}) {
  const agent = (slot, id) => ({
    id, title: `Steer ${slot}`, provider: config.profiles[config.steers.slots[slot]].provider,
    model: config.profiles[config.steers.slots[slot]].model, status: 'idle',
    workspaceId: 'wks_1', labels: { [LABEL.slot]: slot },
  });
  return {
    forkName: 'example/repo',
    providers: PROVIDERS,
    mainWorkspace: { id: 'wks_1', title: 'Main', workspaceDirectory: '/tmp/wsf-test', metadata: { [METADATA_KEY]: { main: true, activeSteer, epoch: 1 } } },
    steers: { labelled: [agent('A', 'agent-a'), agent('B', 'agent-b'), agent('E', 'agent-e')] },
    workers: [],
  };
}

const stubClient = {
  agents: { ref: () => ({ timeline: { refetch: async () => { throw new Error('no timeline'); } } }) },
  workspaces: { ref: () => ({}) },
};

test('switch --to an advisor slot is refused', async () => {
  const discovery = steerDiscovery(CONFIG);
  await assert.rejects(
    switchSteer({ client: stubClient, discovery, toSlot: 'E', config: CONFIG, language: 'en' }),
    (error) => error instanceof SwitchRefused
      && /Steer E is an advisor and cannot coordinate/.test(error.message),
  );
  const open = structuredClone(CONFIG);
  open.profiles.muse.sensitive = false;
  const ok = await switchSteer({ client: stubClient, discovery, toSlot: 'B', config: open, language: 'en' });
  assert.equal(ok.to, 'B');
  assert.match(ok.packet, /Steer handoff/);
});

test('fresh keeps the advisor status and falls back with a warning', async () => {
  const discovery = steerDiscovery(CONFIG, { activeSteer: 'E' });
  const kept = await freshSteer({ client: stubClient, discovery, config: CONFIG, language: 'en' });
  assert.equal(kept.profile, 'opus');
  assert.ok(kept.warnings.some((w) => /Steer E is an advisor.*advisors never coordinate/.test(w)));
  const limited = { ...discovery, providers: PROVIDERS.filter((e) => e.provider !== 'claude') };
  await assert.rejects(
    freshSteer({ client: stubClient, discovery: limited, config: CONFIG, language: 'en' }),
    /Live route .* is not startable.*no fallback available/,
  );
  const config = structuredClone(CONFIG);
  config.profiles.opusBad = { provider: 'nosuch', model: 'x', advisor: true };
  config.profiles.opusGood = { provider: 'antigravity', model: 'gemini-3.8-flash-high', thinking: null, mode: null, advisor: true };
  config.steers = { slots: { A: 'sol', E: 'opusBad', F: 'opusGood' }, prepare: ['A', 'E', 'F'], initialActive: 'A' };
  const mkAgent = (slot, id, provider, model) => ({
    id, title: `Steer ${slot}`, provider, model, status: 'idle', workspaceId: 'wks_1', labels: { [LABEL.slot]: slot },
  });
  const twoAdvisors = {
    forkName: 'example/repo', providers: PROVIDERS,
    mainWorkspace: { id: 'wks_1', title: 'Main', workspaceDirectory: '/tmp/wsf-test', metadata: { [METADATA_KEY]: { main: true, activeSteer: 'E', epoch: 1 } } },
    steers: { labelled: [mkAgent('A', 'agent-a', 'codex', 'gpt-6.2-sol'), mkAgent('E', 'agent-e', 'nosuch', 'x')] },
    workers: [],
  };
  const fell = await freshSteer({ client: stubClient, discovery: twoAdvisors, config, language: 'en' });
  assert.equal(fell.profile, 'opusGood', 'advisor slot falls back to the next advisor profile');
  assert.equal(fell.fallbackFrom, 'opusBad');
  assert.ok(fell.warnings.some((w) => /Using fallback "opusGood"/.test(w)));
});

test('resume brief addresses advisor steers and carries the worker model', () => {
  const discovery = steerDiscovery(CONFIG);
  const status = steerStatus(discovery, { config: CONFIG });
  const line = 'Worker model: codex/gpt-6.2-sol (mode full-access) - start workers with `paseo-factory worker pick`';
  const advisor = buildResumeBrief(status, { agentId: 'agent-e', config: CONFIG, workerModel: line });
  assert.match(advisor, /^Resume brief for example\/repo \(unknown\) · epoch 1 · active steer A \(agent-a\)\.\nYou are an advisor steer: answer only, never coordinate or take over\.\nWorker model: codex/);
  const active = buildResumeBrief(status, { agentId: 'agent-a', config: CONFIG, workerModel: line });
  assert.match(active, /You are the active steer of this scope\./);
  assert.ok(active.includes(line));
});

test('failoverChain skips advisors on steer, domain and hub level', () => {
  const steers = [
    { id: 'a', slot: 'A' }, { id: 'b', slot: 'B' }, { id: 'c', slot: 'C' },
  ];
  const plain = failoverChain({ steers, activeSlot: 'A' });
  assert.deepEqual(plain.map((c) => c.steerId), ['b', 'c']);
  const skipped = failoverChain({ steers, activeSlot: 'A', advisorIds: ['b'] });
  assert.deepEqual(skipped.map((c) => c.steerId), ['c']);
  const levels = failoverChain({
    steers, activeSlot: 'A', advisorIds: ['b', 'dom', 'hub'],
    domainSteer: { steerId: 'dom', scopeId: 'd' }, hubSteer: { steerId: 'hub', scopeId: 'h' },
  });
  assert.deepEqual(levels.map((c) => c.steerId), ['c'], 'advisor domain/hub steers are skipped too');
  const kept = failoverChain({
    steers, activeSlot: 'A', advisorIds: ['b'],
    domainSteer: { steerId: 'dom', scopeId: 'd' }, hubSteer: { steerId: 'hub', scopeId: 'h' },
  });
  assert.deepEqual(kept.map((c) => [c.kind, c.steerId]), [['steer', 'c'], ['domain', 'dom'], ['hub', 'hub']]);
});

test('status tags advisor/sensitive steers; model drift is silent (K13)', () => {
  const discovery = steerDiscovery(CONFIG);
  const status = steerStatus(discovery, { config: CONFIG });
  const bySlot = Object.fromEntries(status.steers.map((s) => [s.slot, s]));
  assert.equal(bySlot.E.advisor, true);
  assert.equal(bySlot.B.sensitive, true, 'slot B runs the muse profile');
  assert.deepEqual(status.warnings, []);
  const text = formatStatus(status);
  assert.match(text, /Steer E \[advisor\]  agent-e  claude\/claude-opus-5-5/);
  assert.match(text, /Steer B \[sensitive\]  agent-b  muse\/muse-spark-1\.3-contributor/);
  discovery.steers.labelled[0].model = 'other-model';
  discovery.steers.labelled[0].provider = 'muse';
  const drifted = steerStatus(discovery, { config: CONFIG });
  assert.equal(drifted.steers.find((s) => s.id === discovery.steers.labelled[0].id).sensitive, true);
  assert.deepEqual(drifted.warnings, [], 'K13: the live model is authoritative, no drift warning');
  const advised = steerStatus(steerDiscovery(CONFIG, { activeSteer: 'E' }), { config: CONFIG });
  assert.ok(advised.warnings.some((w) => /Active Steer E is an advisor.*advisors never coordinate/.test(w)));
});
