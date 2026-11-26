#!/usr/bin/env node
// Live crash test of the real apply runner for a steer create. NOT part of the normal
// suite; refuses to run without explicit approval:
//   WSF_LIVE_CRASH=approved node test/integration-crash.mjs
//
// Real: stored authorization (storeAuthorization), progress file (fileProgress),
// global apply lock (withApplyLock), applyPlans(), real executors, daemon receipts
// (lookupCreationReceipt), the Paseo daemon. Test-specific: a minimal scratch plan
// (adopt the natively created scratch workspace, then one steer create) and a
// minimal observation of the scratch path instead of the GitHub/checkout
// discovery (which needs a real fork).
//
// 1. setup    new scratch dir, scratch workspace created natively, scratch plan
//             (adopt + steer.A) stored as authorization, manifest written first.
// 2. crash    child process A runs applyPlans(); right after the daemon returned the
//             steer, before the result is stored, A kills itself with SIGKILL.
// 3. resume   child process B (a new factory process) runs applyPlans() on the same
//             authorization and progress: receipt-based recovery, no second steer.
// 4. verify   read-only: exactly one steer in the workspace, receipt names it,
//             progress records it with via=receipt.
// Creates exactly one workspace (natively) and one agent (no GitHub, no daemon
// restart). Everything is kept; the manifest is compatible with the fail-closed
// `--cleanup` of integration_workspace_factory_live.mjs.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connect, readPaseoState, lookupCreationReceipt, METADATA_KEY, LABEL } from '../plugin/server/core/paseo.mjs';
import { applyPlans, createAuthorization, createExecutors, fileProgress, storeAuthorization, withApplyLock } from '../plugin/server/core/apply.mjs';
import { configureRuntime } from '../plugin/server/core/runtime.mjs';
const SELF = fileURLToPath(import.meta.url);

// Live-only minimal config (see integration-live.mjs): no plugin host here.
const LIVE_CONFIG = {
  version: 1,
  github: { owner: 'live-test', cloneProtocol: 'https', upstreamRemote: 'upstream' },
  checkoutRoot: '/tmp/wsf-live-test',
  workspaceTitle: 'Main',
  profiles: {
    live: { provider: 'codex', model: 'gpt-6.2-sol', thinking: null, mode: null },
  },
  steers: { slots: { A: 'live' }, prepare: ['A'], initialActive: 'A' },
  workers: { priority: ['live'], defaultProfile: 'live' },
};

if (process.env.WSF_LIVE_CRASH !== 'approved') {
  console.error('Refusing: the live crash test needs WSF_LIVE_CRASH=approved (explicit user approval).');
  process.exit(2);
}
const { integrationDir: MANIFEST_DIR, scratchDir: SCRATCH_BASE } = configureRuntime({});

/** Minimal observation of the scratch workspace, shaped like a planner result. */
function observerFor(manifest, adoptOp, steerOp) {
  return async (client) => {
    const state = await readPaseoState(client);
    const mains = state.workspaces.filter((w) => w.workspaceDirectory === manifest.scratch && w.metadata?.[METADATA_KEY]?.main === true);
    const main = mains[0] ?? state.workspaces.find((w) => w.id === manifest.workspace) ?? null;
    const steers = state.agents.filter((a) => !a.archivedAt && a.workspaceId === main?.id && a.labels?.[LABEL.slot] === 'A');
    const ops = [];
    if (!main?.metadata?.[METADATA_KEY]) ops.push(adoptOp);
    else if (!steers.length) ops.push(steerOp);
    return [{
      repo: manifest.repo, input: 'scratch', notes: [],
      status: mains.length > 1 ? 'conflict' : ops.length ? 'pending' : 'complete',
      ops,
      conflicts: mains.length > 1 ? [{ key: 'workspace.main', reason: `several workspaces at ${manifest.scratch}` }] : [],
      observed: {
        mainWorkspace: main ? { id: main.id, directory: main.workspaceDirectory, title: main.title ?? main.name, metadata: main.metadata ?? {}, createdAt: main.createdAt ?? null } : null,
        steers: Object.fromEntries(steers.map((a) => ['A', a.id])),
      },
    }];
  };
}

async function child(role, manifestFile) {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const config = LIVE_CONFIG;
  const authorization = JSON.parse(readFileSync(manifest.authorizationFile, 'utf8'));
  const adoptOp = authorization.plans[0].ops.find((o) => o.key === 'workspace.main.adopt');
  const steerOp = authorization.plans[0].ops.find((o) => o.key === 'steer.A');
  const client = await connect({ clientId: `paseo-workspace-factory-crash-${role}` });
  const observe = observerFor(manifest, adoptOp, steerOp);
  const real = createExecutors({ client, paseoCli: null });
  const execute = role === 'crash'
    ? async (op, cfg) => {
      const out = await real(op, cfg);
      if (op.key === 'steer.A') process.kill(process.pid, 'SIGKILL'); // after the daemon answered, before progress.save
      return out;
    }
    : real;
  const result = await withApplyLock((held) => applyPlans({
    authorization, config, confirm: authorization.hash, lookupReceipt: lookupCreationReceipt,
    progress: fileProgress(manifest.progressFile), guard: () => held.verify(),
    runPlans: () => observe(client), execute,
    journal: (event) => writeFileSync(manifest.journalFile, `${JSON.stringify(event)}\n`, { flag: 'a', mode: 0o600 }),
  }));
  await client.close().catch(() => {});
  console.log(JSON.stringify(result));
}

async function main() {
  const run = `crash-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const dir = join(MANIFEST_DIR, run);
  const manifest = {
    file: join(MANIFEST_DIR, `${run}.json`), run, repo: `scratch/${run}`,
    phases: { setup: 'pending', crash: 'pending', resume: 'pending', verify: 'pending', functional: 'pending', cleanup: 'not run (separate step)' },
    scratch: null, workspace: null, agent: null, keys: {},
    authorizationFile: null, progressFile: join(dir, 'progress.json'), journalFile: join(dir, 'journal.jsonl'),
    observations: {}, error: null,
  };
  const save = () => writeFileSync(manifest.file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let phase = 'setup';
  try {
    mkdirSync(SCRATCH_BASE, { recursive: true, mode: 0o700 });
    manifest.scratch = mkdtempSync(join(SCRATCH_BASE, 'run-'));
    if (readdirSync(manifest.scratch).length) throw new Error('scratch is not empty');
    execFileSync('git', ['init', '-q', manifest.scratch]);
    writeFileSync(join(manifest.scratch, 'README.md'), 'workspace factory crash test scratch\n');
    const setupClient = await connect({ clientId: 'paseo-workspace-factory-crash-setup' });
    const handle = await setupClient.workspaces.create({ source: { kind: 'directory', path: manifest.scratch }, title: `WSF crash ${run}` });
    manifest.workspace = handle.id;
    await setupClient.close().catch(() => {});
    manifest.keys.steer = `wsf-crash:${run}:steer-A`;
    const adoptOp = {
      key: 'workspace.main.adopt', kind: 'paseo.workspace.metadata', summary: 'Adopt scratch workspace',
      params: { workspaceId: manifest.workspace, metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 }, 'wsf.scratch': true } },
    };
    const steerOp = {
      key: 'steer.A', kind: 'paseo.agent.create', summary: 'Create scratch Steer A',
      params: {
        workspaceId: manifest.workspace, title: 'Steer A', config: { provider: 'codex/gpt-6.2-sol' },
        labels: { [LABEL.scope]: manifest.repo, [LABEL.repo]: manifest.repo, [LABEL.role]: 'steer', [LABEL.slot]: 'A' },
        idempotencyKey: manifest.keys.steer,
      },
    };
    const config = LIVE_CONFIG;
    const plans = [{ repo: manifest.repo, input: 'scratch', status: 'pending', ops: [adoptOp, steerOp], conflicts: [], notes: [] }];
    const stored = storeAuthorization(join(dir, 'plans'), createAuthorization(plans, config, { entries: ['scratch'] }), config);
    manifest.authorizationFile = stored.file;
    manifest.phases.setup = 'passed';
    save();

    const spawnChild = (role) => new Promise((resolve) => {
      const proc = spawn(process.execPath, [SELF, '--child', role, manifest.file], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      let out = '';
      let err = '';
      proc.stdout.on('data', (d) => (out += d));
      proc.stderr.on('data', (d) => (err += d));
      proc.on('exit', (code, signal) => resolve({ code, signal, out: out.trim(), err: err.trim() }));
    });

    phase = 'crash';
    const a = await spawnChild('crash');
    manifest.observations.crash = { signal: a.signal, code: a.code, stderr: a.err.slice(0, 500) };
    save();
    assert.equal(a.signal, 'SIGKILL', 'process A must die by SIGKILL');
    const afterCrash = JSON.parse(readFileSync(manifest.progressFile, 'utf8'));
    assert.ok(afterCrash.attempted?.includes(`${manifest.repo}#steer.A`), 'attempt recorded');
    assert.equal(afterCrash.results?.[manifest.repo]?.['steer.A'], undefined, 'result not recorded');
    manifest.phases.crash = 'passed';
    save();

    phase = 'resume';
    const b = await spawnChild('resume');
    manifest.observations.resume = { code: b.code, signal: b.signal, stderr: b.err.slice(0, 500) };
    save();
    assert.equal(b.code, 0, `process B failed: ${b.err}`);
    const report = JSON.parse(b.out.split('\n').at(-1));
    manifest.observations.resume.report = report.report;
    assert.equal(report.report[0].status, 'complete', report.report[0].error ?? '');
    manifest.phases.resume = 'passed';
    save();

    phase = 'verify';
    const client = await connect({ clientId: 'paseo-workspace-factory-crash-verify' });
    const state = await readPaseoState(client);
    await client.close().catch(() => {});
    const steers = state.agents.filter((a) => !a.archivedAt && a.workspaceId === manifest.workspace && a.labels?.[LABEL.slot] === 'A');
    const receipt = await lookupCreationReceipt('agent', manifest.keys.steer);
    const progress = JSON.parse(readFileSync(manifest.progressFile, 'utf8'));
    const recorded = progress.results[manifest.repo]['steer.A'];
    const journal = readFileSync(manifest.journalFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    manifest.observations.verify = { steers: steers.map((a) => a.id), receipt: receipt && { phase: receipt.phase, agentId: receipt.agentId }, recorded, events: journal.map((e) => e.event) };
    assert.equal(steers.length, 1, 'exactly one steer in the scratch workspace');
    assert.equal(receipt?.phase, 'completed');
    assert.equal(receipt.agentId, steers[0].id);
    assert.equal(recorded.agentId, steers[0].id);
    assert.equal(recorded.via, 'receipt');
    assert.ok(journal.some((e) => e.event === 'recovered' && e.key === 'steer.A'));
    manifest.agent = steers[0].id;
    manifest.phases.verify = 'passed';
    manifest.phases.functional = 'passed';
  } catch (error) {
    manifest.phases[phase] = 'failed';
    manifest.phases.functional = 'failed';
    manifest.error = `${phase}: ${error.message}`;
    process.exitCode = 1;
  } finally {
    save();
    console.log(JSON.stringify({ ...manifest, kept: 'all created resources are kept for inspection' }, null, 2));
    console.log(`Manifest: ${manifest.file}`);
  }
}

const args = process.argv.slice(2);
if (args[0] === '--child') await child(args[1], args[2]);
else await main();
