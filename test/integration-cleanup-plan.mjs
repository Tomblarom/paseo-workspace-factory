#!/usr/bin/env node
// Live cleanup-plan test: plans and applies a scratch-only archive through
// the real hash-confirmed apply loop. NOT part of the normal suite; refuses
// to run without explicit approval:
//   WSF_LIVE_CLEANUP_PLAN=approved node test/integration-cleanup-plan.mjs
//
// Fail-closed by construction: the plan is limited to the scratch workspace
// created in this run (`only`), the op list is asserted to be exactly that
// single archive before anything runs, and the scratch directory is kept.
// Never point this at a real workspace: it archives what it plans.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect, createPaseoCli, readPaseoState, METADATA_KEY } from '../src/paseo.mjs';
import { createGh } from '../src/github.mjs';
import { createGit } from '../src/local.mjs';
import { applyPlans, createAuthorization, createExecutors, memoryProgress } from '../src/apply.mjs';
import { validateProfilesAgainstCatalog, loadConfig } from '../src/config.mjs';
import { configureRuntime } from '../src/runtime.mjs';
import { planCleanupOps, createCleanupRunPlans, SCRATCH_LABEL } from '../src/cleanup.mjs';

if (process.env.WSF_LIVE_CLEANUP_PLAN !== 'approved') {
  console.error('Refusing: the live cleanup-plan test needs WSF_LIVE_CLEANUP_PLAN=approved (explicit user approval).');
  process.exit(2);
}
const { integrationDir: MANIFEST_DIR, scratchDir: SCRATCH_BASE } = configureRuntime(await loadConfig());

async function main() {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const manifest = {
    file: join(MANIFEST_DIR, `cleanup-plan-${id}.json`), run: id,
    phases: { setup: 'pending', functional: 'pending' },
    scratch: null, workspace: null, agent: null, hash: null, error: null,
  };
  const saveManifest = () => writeFileSync(manifest.file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  mkdirSync(MANIFEST_DIR, { recursive: true, mode: 0o700 });
  saveManifest(manifest);
  const git = createGit();
  const client = await connect({ clientId: 'paseo-workspace-factory-cleanup-plan' });
  try {
    try {
      mkdirSync(SCRATCH_BASE, { recursive: true, mode: 0o700 });
      const dir = mkdtempSync(join(SCRATCH_BASE, 'run-'));
      if (readdirSync(dir).length) throw new Error(`scratch ${dir} is not empty`);
      manifest.scratch = dir;
      saveManifest(manifest);
      execFileSync('git', ['init', '-q', dir]);
      writeFileSync(join(dir, 'README.md'), 'workspace factory cleanup-plan test scratch\n');
      manifest.phases.setup = 'passed';
    } catch (error) {
      manifest.phases.setup = 'failed';
      manifest.error = `setup: ${error.message}`;
      return 1;
    } finally {
      saveManifest(manifest);
    }

    try {
      const config = await loadConfig();
      const profileName = config.workers.defaultProfile;
      const profile = config.profiles[profileName];
      assert.deepEqual(validateProfilesAgainstCatalog(config, (await client.providers.snapshot()).entries, [profileName]), {}, 'profile must be startable');

      const wsKey = `wsf-cleanup-plan:${id}:workspace`;
      const ws = await client.workspaces.create({
        source: { kind: 'directory', path: manifest.scratch }, title: `WSF cleanup-plan ${id}`,
        metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } }, idempotencyKey: wsKey,
      });
      manifest.workspace = ws.id;
      saveManifest(manifest);
      const agentHandle = await client.workspaces.ref(ws.id).agents.create({
        config: { provider: `${profile.provider}/${profile.model}`, ...(profile.mode ? { modeId: profile.mode } : {}) },
        title: 'WSF cleanup-plan agent', labels: { [SCRATCH_LABEL]: 'true' }, idempotencyKey: `wsf-cleanup-plan:${id}:agent`,
      });
      manifest.agent = agentHandle.id;
      saveManifest(manifest);

      const planned = planCleanupOps(await readPaseoState(client), { allowDestructive: true, only: [manifest.workspace], git });
      assert.equal(planned.ops.length, 1, `expected exactly the scratch archive, got ${JSON.stringify(planned.ops.map((o) => o.key))}`);
      assert.equal(planned.ops[0].kind, 'workspace.archive');
      assert.equal(planned.ops[0].params.workspaceId, manifest.workspace);
      const plans = [{ repo: 'cleanup', input: 'cleanup', status: 'pending', ops: planned.ops, conflicts: [], notes: [], observed: {} }];
      const authorization = { ...createAuthorization(plans, config, { entries: [{ cleanup: { allowDestructive: true, only: [manifest.workspace] } }] }), kind: 'cleanup' };
      manifest.hash = authorization.hash;
      saveManifest(manifest);

      const outcome = await applyPlans({
        authorization, config, confirm: authorization.hash, progress: memoryProgress(),
        runPlans: createCleanupRunPlans(authorization, { client, git }),
        execute: createExecutors({ client, gh: createGh(), git, paseoCli: createPaseoCli() }),
      });
      assert.equal(outcome.report[0].status, 'complete', JSON.stringify(outcome.report));

      const after = await readPaseoState(client);
      assert.ok(!after.workspaces.some((w) => w.id === manifest.workspace), 'scratch workspace archived');
      assert.ok(after.agents.find((a) => a.id === manifest.agent)?.archivedAt, 'scratch agent archived');
      const replan = planCleanupOps(after, { allowDestructive: true, git });
      assert.ok(!replan.ops.some((op) => op.params.workspaceId === manifest.workspace), 'replan is clean for the archived workspace');
      manifest.phases.functional = 'passed';
      return 0;
    } catch (error) {
      manifest.phases.functional = 'failed';
      manifest.error = `functional: ${error.message}`;
      return 1;
    } finally {
      saveManifest(manifest);
    }
  } finally {
    await client.close().catch(() => {});
    console.log(JSON.stringify({ ...manifest, kept: 'scratch directory and manifest are kept for inspection' }, null, 2));
    console.log(`Manifest: ${manifest.file}`);
  }
}

process.exit(await main());
