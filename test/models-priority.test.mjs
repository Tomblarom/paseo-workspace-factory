// Prioritized model lists (WL-A): worker priority with read migration,
// resolveProfile fallback, worker insert-and-slide, steer replace-by-slot.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  configWarnings, isAdvisorProfile, isAdvisorSlot, isSensitiveProfile, isSensitiveSlot,
  providerIsSensitive, slotOrder, validateConfig, workerPriority,
} from '../src/config.mjs';
import {
  formatWorkerModel, paseoRunFlags, planSteerRemove, planSteerSet, planWorkerRemove,
  planWorkerSet, resolveProfile, resolveSteerTarget, steerFallbackList,
} from '../src/models.mjs';

const CONFIG = {
  version: 1,
  github: { owner: 'TestOwner', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/tmp/wsf-test',
  workspaceTitle: 'Main',
  profiles: {
    sol: { provider: 'codex', model: 'gpt-6.2-sol', thinking: 'high', mode: 'full-access' },
    muse: { provider: 'muse', model: 'muse-spark-1.3-contributor', thinking: null, mode: 'allowAll' },
    agy: { provider: 'antigravity', model: 'gemini-3.8-flash-high', thinking: null, mode: 'yolo' },
  },
  steers: { slots: { A: 'sol', B: 'muse', C: 'agy' }, prepare: ['A', 'B', 'C'], initialActive: 'A' },
  workers: { priority: ['muse', 'agy', 'sol'], defaultProfile: 'muse' },
};

const PROVIDERS = [
  { provider: 'codex', enabled: true, status: 'ready', models: [{ id: 'gpt-6.2-sol', thinkingOptions: [{ id: 'high' }, { id: 'low' }] }], modes: [{ id: 'auto' }, { id: 'full-access' }] },
  { provider: 'muse', enabled: true, status: 'ready', models: [{ id: 'muse-spark-1.3-contributor', thinkingOptions: [{ id: 'max' }] }], modes: [{ id: 'onRequest' }, { id: 'allowAll' }] },
  { provider: 'antigravity', enabled: true, status: 'ready', models: [{ id: 'gemini-3.8-flash-high', thinkingOptions: [] }], modes: [{ id: 'default' }, { id: 'yolo' }] },
  { provider: 'opencode', enabled: false, status: 'unavailable', models: [], modes: [] },
];

test('workerPriority reads a missing priority as [defaultProfile]', () => {
  assert.deepEqual(workerPriority(CONFIG), ['muse', 'agy', 'sol']);
  const legacy = structuredClone(CONFIG);
  delete legacy.workers.priority;
  assert.deepEqual(workerPriority(legacy), ['muse']);
  assert.deepEqual(workerPriority({ workers: {} }), []);
  assert.deepEqual(workerPriority({}), []);
});

test('workers.priority entries are validated', () => {
  const unknown = structuredClone(CONFIG);
  unknown.workers.priority = ['muse', 'missing'];
  assert.ok(validateConfig(unknown).some((e) => /workers\.priority references unknown profile "missing"/.test(e)));
  const dup = structuredClone(CONFIG);
  dup.workers.priority = ['muse', 'muse'];
  assert.ok(validateConfig(dup).some((e) => /workers\.priority lists "muse" twice/.test(e)));
  const empty = structuredClone(CONFIG);
  empty.workers.priority = [];
  assert.ok(validateConfig(empty).some((e) => /workers\.priority must be a non-empty array/.test(e)));
  assert.deepEqual(validateConfig(CONFIG), []);
});

test('resolveProfile picks the first startable profile and reports skips', () => {
  const { profile, skipped } = resolveProfile(CONFIG, PROVIDERS, ['muse', 'agy'], { role: 'worker', repoPublic: true });
  assert.equal(profile.name, 'muse');
  assert.deepEqual(skipped, []);
  const limited = PROVIDERS.map((e) => (e.provider === 'muse' ? { ...e, modes: [{ id: 'onRequest' }] } : e));
  const fell = resolveProfile(CONFIG, limited, ['muse', 'agy'], { role: 'worker', repoPublic: true });
  assert.equal(fell.profile.name, 'agy');
  assert.equal(fell.skipped.length, 1);
  assert.match(fell.skipped[0].reason, /mode "allowAll" is not available/);
});

test('resolveProfile skips by reason: provider down, model missing, thinking invalid', () => {
  const down = PROVIDERS.map((e) => (e.provider === 'codex' ? { ...e, status: 'error' } : e));
  const byProvider = resolveProfile(CONFIG, down, ['sol'], { role: 'worker', repoPublic: true });
  assert.equal(byProvider.profile, null);
  assert.match(byProvider.skipped[0].reason, /provider "codex" is error/);
  const gone = PROVIDERS.map((e) => (e.provider === 'codex' ? { ...e, models: [] } : e));
  const byModel = resolveProfile(CONFIG, gone, ['sol'], { role: 'worker', repoPublic: true });
  assert.match(byModel.skipped[0].reason, /model "gpt-6\.2-sol" is not offered/);
  const nothink = PROVIDERS.map((e) => (e.provider === 'codex'
    ? { ...e, models: [{ id: 'gpt-6.2-sol', thinkingOptions: [] }] } : e));
  const byThinking = resolveProfile(CONFIG, nothink, ['sol'], { role: 'worker', repoPublic: true });
  assert.match(byThinking.skipped[0].reason, /thinking "high" is not available/);
});

test('resolveProfile for workers always skips advisor profiles', () => {
  const config = structuredClone(CONFIG);
  config.profiles.muse.advisor = true;
  const { profile, skipped } = resolveProfile(config, PROVIDERS, ['muse', 'agy'], { role: 'worker', repoPublic: true });
  assert.equal(profile.name, 'agy');
  assert.match(skipped[0].reason, /tagged as advisor/);
  assert.ok(configWarnings(config).some((w) => /workers\.priority lists advisor profile "muse"/.test(w)));
});

test('resolveProfile for workers skips sensitive profiles unless the repo is public', () => {
  const open = resolveProfile(CONFIG, PROVIDERS, ['muse', 'agy'], { role: 'worker', repoPublic: true });
  assert.equal(open.profile.name, 'muse', 'muse is sensitive by migration but allowed on public repos');
  for (const repoPublic of [false, null, undefined]) {
    const { profile, skipped } = resolveProfile(CONFIG, PROVIDERS, ['muse', 'agy'], { role: 'worker', repoPublic });
    assert.equal(profile.name, 'agy', `sensitive muse is skipped when repoPublic is ${String(repoPublic)}`);
    assert.match(skipped[0].reason, /sensitive profile "muse": private repo/);
  }
  const explicit = structuredClone(CONFIG);
  explicit.profiles.muse.sensitive = false;
  const { profile } = resolveProfile(explicit, PROVIDERS, ['muse', 'agy'], { role: 'worker', repoPublic: false });
  assert.equal(profile.name, 'muse', 'explicit sensitive:false wins over the muse default');
});

test('steerFallbackList is own slot first, then following, then previous', () => {
  assert.deepEqual(steerFallbackList(CONFIG, 'A'), ['sol', 'muse', 'agy']);
  assert.deepEqual(steerFallbackList(CONFIG, 'B'), ['muse', 'agy', 'sol']);
  assert.deepEqual(steerFallbackList(CONFIG, 'C'), ['agy', 'sol', 'muse']);
  assert.deepEqual(steerFallbackList(CONFIG, 'Z'), []);
  assert.deepEqual(slotOrder(CONFIG), ['A', 'B', 'C']);
});

test('resolveProfile for steers filters by advisor tag and avoids live duplicates', () => {
  const config = structuredClone(CONFIG);
  config.profiles.muse.advisor = true;
  const plain = resolveProfile(config, PROVIDERS, steerFallbackList(config, 'A'), { role: 'steer', advisorSlot: false });
  assert.equal(plain.profile.name, 'sol');
  const limited = PROVIDERS.map((e) => (e.provider === 'codex' ? { ...e, models: [] } : e));
  const skippedAdvisor = resolveProfile(config, limited, steerFallbackList(config, 'A'), { role: 'steer', advisorSlot: false });
  assert.equal(skippedAdvisor.profile.name, 'agy', 'non-advisor slot skips the advisor profile muse');
  const advisorSlot = resolveProfile(config, PROVIDERS, steerFallbackList(config, 'B'), { role: 'steer', advisorSlot: true });
  assert.equal(advisorSlot.profile.name, 'muse', 'advisor slot takes its advisor profile');
  const used = resolveProfile(CONFIG, PROVIDERS, steerFallbackList(CONFIG, 'B'), { role: 'steer', advisorSlot: false, usedProfiles: ['agy'] });
  assert.equal(used.profile.name, 'muse', 'the slot profile itself is exempt from duplicate avoidance');
  const usedFallback = resolveProfile(CONFIG, limited, steerFallbackList(CONFIG, 'A'), { role: 'steer', advisorSlot: false, usedProfiles: ['muse'] });
  assert.equal(usedFallback.profile.name, 'agy', 'fallback entries used by a live steer are skipped');
  assert.ok(usedFallback.skipped.some((s) => /already used by a live steer/.test(s.reason)));
});

test('resolveProfile reports unknown profiles and empty lists without a pick', () => {
  const { profile, skipped } = resolveProfile(CONFIG, PROVIDERS, ['missing'], { role: 'worker', repoPublic: true });
  assert.equal(profile, null);
  assert.match(skipped[0].reason, /unknown profile/);
  const empty = resolveProfile(CONFIG, PROVIDERS, [], { role: 'worker', repoPublic: true });
  assert.equal(empty.profile, null);
  assert.deepEqual(empty.skipped, []);
});

test('paseoRunFlags and formatWorkerModel render the worker pick', () => {
  const { profile } = resolveProfile(CONFIG, PROVIDERS, ['sol'], { role: 'worker', repoPublic: true });
  assert.equal(paseoRunFlags(profile), '--provider codex --model gpt-6.2-sol --thinking high --mode full-access');
  assert.equal(
    formatWorkerModel(CONFIG, profile),
    'Worker model: codex/gpt-6.2-sol (mode full-access) - start workers with `paseo-factory worker pick`',
  );
  const { profile: sens } = resolveProfile(CONFIG, PROVIDERS, ['muse'], { role: 'worker', repoPublic: true });
  assert.match(formatWorkerModel(CONFIG, sens), /\[sensitive: give only sanitized technical tasks\]$/);
});

test('planWorkerSet inserts with slide and moves duplicates', () => {
  const planned = planWorkerSet(CONFIG, PROVIDERS, { n: 1, spec: 'codex/gpt-6.2-sol', thinking: 'low', mode: 'auto', profile: 'sol-low' });
  assert.deepEqual(planned.before, ['muse', 'agy', 'sol']);
  assert.deepEqual(planned.after, ['sol-low', 'muse', 'agy', 'sol']);
  assert.equal(planned.config.workers.defaultProfile, 'sol-low');
  assert.match(planned.summary, /\[muse, agy, sol\] → \[sol-low, muse, agy, sol\]/);
  const moved = planWorkerSet(CONFIG, PROVIDERS, { n: 1, spec: 'sol' });
  assert.deepEqual(moved.after, ['sol', 'muse', 'agy'], 're-inserting moves the entry, every model appears once');
  assert.ok(moved.notes.some((n) => /Moved "sol" to position 1/.test(n)));
  const appended = planWorkerSet(CONFIG, PROVIDERS, { n: 9, spec: 'agy' });
  assert.deepEqual(appended.after, ['muse', 'sol', 'agy']);
  assert.equal(appended.position, 3);
  assert.ok(appended.notes.some((n) => /past the end; appended/.test(n)));
});

test('planWorkerSet rejects advisor profiles, profile-flag mixes and bad positions', () => {
  const config = structuredClone(CONFIG);
  config.profiles.muse.advisor = true;
  assert.throws(() => planWorkerSet(config, PROVIDERS, { n: 1, spec: 'muse' }), /tagged as advisor and cannot be used for workers/);
  assert.throws(() => planWorkerSet(CONFIG, PROVIDERS, { n: 1, spec: 'sol', thinking: 'low' }), /takes no --thinking/);
  assert.throws(() => planWorkerSet(CONFIG, PROVIDERS, { n: 1, spec: 'missing' }), /Unknown profile/);
  assert.throws(() => planWorkerSet(CONFIG, PROVIDERS, { n: 0, spec: 'sol' }), /position ≥ 1/);
  const broken = structuredClone(CONFIG);
  broken.profiles.sol.model = 'nope';
  const stored = planWorkerSet(broken, PROVIDERS, { n: 2, spec: 'sol' });
  assert.match(stored.warnings.join('\n'), /not startable/);
  assert.deepEqual(stored.after, ['muse', 'sol', 'agy']);
});

test('planWorkerRemove closes the gap and keeps one entry', () => {
  const planned = planWorkerRemove(CONFIG, 2);
  assert.equal(planned.removed, 'agy');
  assert.deepEqual(planned.after, ['muse', 'sol']);
  assert.equal(planned.config.workers.defaultProfile, 'muse');
  assert.match(planned.summary, /\[muse, agy, sol\] → \[muse, sol\]/);
  assert.throws(() => planWorkerRemove(CONFIG, 4), /position 1\.\.3/);
  const single = structuredClone(CONFIG);
  single.workers = { priority: ['muse'], defaultProfile: 'muse' };
  assert.throws(() => planWorkerRemove(single, 1), /Cannot remove the last worker profile/);
});

test('resolveSteerTarget maps numbers to slots and refuses gaps', () => {
  assert.equal(resolveSteerTarget(CONFIG, '2'), 'B');
  assert.equal(resolveSteerTarget(CONFIG, 'b'), 'B');
  assert.equal(resolveSteerTarget(CONFIG, 'B'), 'B');
  assert.throws(() => resolveSteerTarget(CONFIG, '4'), /out of range \(1\.\.3\)/);
  assert.throws(() => resolveSteerTarget(CONFIG, 'D'), /not defined/);
  assert.equal(resolveSteerTarget(CONFIG, 'D', { allowNewLetter: true }), 'D', 'next free letter extends');
  assert.throws(() => resolveSteerTarget(CONFIG, 'E', { allowNewLetter: true }), /would leave a gap.*use the next free letter D/);
});

test('planSteerSet replaces (2 is B), never shifts; free letters within reach create', () => {
  const byNumber = planSteerSet(CONFIG, PROVIDERS, { target: '2', spec: 'agy' });
  const byLetter = planSteerSet(CONFIG, PROVIDERS, { target: 'B', spec: 'agy' });
  assert.deepEqual(byNumber.config.steers.slots, byLetter.config.steers.slots);
  assert.deepEqual(byNumber.config.steers.slots, { A: 'sol', B: 'agy', C: 'agy' });
  assert.match(byNumber.summary, /\[A:sol, B:muse, C:agy\] → \[A:sol, B:agy, C:agy\]/);
  assert.match(byNumber.hint, /Existing steers are unchanged/);
  const created = planSteerSet(CONFIG, PROVIDERS, { target: 'D', spec: 'sol' });
  assert.equal(created.config.steers.slots.D, 'sol');
  assert.ok(created.notes.some((n) => /not in steers\.prepare/.test(n)));
  assert.throws(() => planSteerSet(CONFIG, PROVIDERS, { target: 'E', spec: 'sol' }), /would leave a gap/);
  assert.throws(() => planSteerSet(CONFIG, PROVIDERS, { target: '9', spec: 'sol' }), /out of range/);
  assert.throws(() => planSteerSet(CONFIG, PROVIDERS, { target: 'B', spec: 'missing' }), /Unknown profile/);
});

test('planSteerRemove drops the slot by letter or position', () => {
  const byLetter = planSteerRemove(CONFIG, 'C');
  assert.deepEqual(Object.keys(byLetter.config.steers.slots), ['A', 'B']);
  assert.ok(byLetter.config.profiles.agy, 'profile is kept');
  const byNumber = planSteerRemove(CONFIG, '2');
  assert.deepEqual(byNumber.config.steers.slots, { A: 'sol', C: 'agy' });
  const single = structuredClone(CONFIG);
  single.steers = { slots: { A: 'sol' }, prepare: ['A'], initialActive: 'A' };
  assert.throws(() => planSteerRemove(single, 'A'), /at least one slot must remain/);
});

test('advisor/sensitive slot helpers resolve live from the config', () => {
  assert.equal(isAdvisorProfile(CONFIG, 'sol'), false);
  assert.equal(isAdvisorSlot(CONFIG, 'A'), false);
  const tagged = structuredClone(CONFIG);
  tagged.profiles.sol.advisor = true;
  assert.equal(isAdvisorSlot(tagged, 'A'), true);
  assert.equal(isSensitiveProfile(CONFIG, 'muse'), true, 'muse migrates to sensitive');
  assert.equal(isSensitiveProfile(CONFIG, 'agy'), false, 'antigravity stays open');
  assert.equal(isSensitiveSlot(CONFIG, 'B'), true);
  assert.equal(providerIsSensitive(CONFIG, 'muse'), true);
  assert.equal(providerIsSensitive(CONFIG, 'codex'), false);
  assert.equal(providerIsSensitive(CONFIG, 'unknown-provider'), false);
  assert.equal(providerIsSensitive({ profiles: {} }, 'muse'), true, 'migration default without profiles');
});
