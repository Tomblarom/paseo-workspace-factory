#!/usr/bin/env node
// Live integration test against the real Paseo daemon. NOT part of the normal suite.
//
//   Run (writes):  WSF_LIVE_WRITE=approved node test/integration-live.mjs
//   Cleanup later: WSF_LIVE_CLEANUP=approved node test/integration-live.mjs --cleanup <manifest.json>
//
// Run phases are reported separately: setup, functional, cleanup. Created resources
// (scratch path, workspace id, agent id, idempotency keys) are recorded in a manifest
// immediately after each creation. Resources are KEPT after the run, whether it
// passed or failed; there is no archiving in finally. Cleanup is a separate,
// separately approved invocation; it is fail-closed (test/integration-cleanup.mjs):
// nothing is archived unless every object is positively verified. Files are never deleted.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect, parentOf, readPaseoState, METADATA_KEY } from '../src/paseo.mjs';
import { verifyCleanup, performCleanup } from './integration-cleanup.mjs';
import { configureRuntime } from '../src/runtime.mjs';
import { loadConfig, validateProfilesAgainstCatalog } from '../src/config.mjs';

let MANIFEST_DIR;
let SCRATCH_BASE;
async function init() {
  ({ integrationDir: MANIFEST_DIR, scratchDir: SCRATCH_BASE } = configureRuntime(await loadConfig()));
}

function saveManifest(manifest) {
  mkdirSync(MANIFEST_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(manifest.file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

async function run() {
  if (process.env.WSF_LIVE_WRITE !== 'approved') {
    console.error('Refusing: the live write test needs WSF_LIVE_WRITE=approved (explicit user approval).');
    return 2;
  }
  await init();
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const manifest = {
    file: join(MANIFEST_DIR, `${id}.json`), run: id, phases: { setup: 'pending', functional: 'pending', cleanup: 'not run (separate step)' },
    scratch: null, workspace: null, agent: null, keys: {}, error: null,
  };
  saveManifest(manifest);
  const client = await connect({ clientId: 'paseo-workspace-factory-integration' });
  try {
    // Setup: a brand-new dedicated scratch repository, never an existing workspace or repo.
    try {
      mkdirSync(SCRATCH_BASE, { recursive: true, mode: 0o700 });
      const dir = mkdtempSync(join(SCRATCH_BASE, 'run-'));
      if (readdirSync(dir).length) throw new Error(`scratch ${dir} is not empty`);
      manifest.scratch = dir;
      saveManifest(manifest);
      execFileSync('git', ['init', '-q', dir]);
      writeFileSync(join(dir, 'README.md'), 'workspace factory integration test scratch\n');
      manifest.phases.setup = 'passed';
    } catch (error) {
      manifest.phases.setup = 'failed';
      manifest.error = `setup: ${error.message}`;
      return 1;
    } finally {
      saveManifest(manifest);
    }

    // Functional assertions. Every created id is recorded before the next step.
    try {
      const config = await loadConfig();
      const profileName = config.workers.defaultProfile;
      const profile = config.profiles[profileName];
      assert.deepEqual(validateProfilesAgainstCatalog(config, (await client.providers.snapshot()).entries, [profileName]), {}, 'profile must be startable');

      manifest.keys.workspace = `wsf-it:${id}:workspace`;
      saveManifest(manifest);
      const wsRequest = { source: { kind: 'directory', path: manifest.scratch }, title: `WSF integration ${id}`, metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 1 } }, idempotencyKey: manifest.keys.workspace };
      const ws1 = await client.workspaces.create(wsRequest);
      manifest.workspace = ws1.id;
      saveManifest(manifest);
      const ws2 = await client.workspaces.create(wsRequest);
      assert.equal(ws2.id, ws1.id, 'same workspace key returns the same workspace');
      assert.equal((await ws1.refresh()).workspaceDirectory, manifest.scratch, 'workspace points to the scratch path');

      manifest.keys.agent = `wsf-it:${id}:agent`;
      saveManifest(manifest);
      const agentRequest = {
        config: { provider: `${profile.provider}/${profile.model}`, ...(profile.mode ? { modeId: profile.mode } : {}) },
        title: 'WSF integration agent', labels: { 'wsf.role': 'integration-test', 'wsf.scratch': 'true' }, idempotencyKey: manifest.keys.agent,
      };
      const a1 = await client.workspaces.ref(ws1.id).agents.create(agentRequest);
      manifest.agent = a1.id;
      saveManifest(manifest);
      const a2 = await client.workspaces.ref(ws1.id).agents.create(agentRequest);
      assert.equal(a2.id, a1.id, 'same agent key returns the same agent');
      await assert.rejects(client.workspaces.ref(ws1.id).agents.create({ ...agentRequest, title: 'changed' }), /key_conflict/, 'changed request under the same key is rejected');
      const snapshot = (await a1.refresh()).agent;
      assert.equal(parentOf(snapshot), null, 'created without parent');
      assert.equal(snapshot.workspaceId, ws1.id);

      await client.workspaces.ref(ws1.id).setMetadata({ [METADATA_KEY]: { main: true, activeSteer: 'B', epoch: 2 } });
      const meta = (await client.workspaces.ref(ws1.id).refresh()).metadata[METADATA_KEY];
      assert.deepEqual([meta.activeSteer, meta.epoch], ['B', 2], 'metadata read-back');
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
    console.log(JSON.stringify({ ...manifest, kept: 'all created resources are kept for inspection' }, null, 2));
    console.log(`Manifest: ${manifest.file}`);
  }
}

async function cleanup(file) {
  if (process.env.WSF_LIVE_CLEANUP !== 'approved') {
    console.error('Refusing: cleanup needs WSF_LIVE_CLEANUP=approved.');
    return 2;
  }
  await init();
  if (!file || !existsSync(file) || !file.startsWith(`${MANIFEST_DIR}/`)) {
    console.error(`Refusing: pass a manifest from ${MANIFEST_DIR}`);
    return 2;
  }
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.phases.functional !== 'passed' && process.env.WSF_LIVE_CLEANUP_FAILED !== 'approved') {
    console.error('Refusing: functional phase did not pass; inspect first, then set WSF_LIVE_CLEANUP_FAILED=approved as well.');
    return 2;
  }
  const client = await connect({ clientId: 'paseo-workspace-factory-integration-cleanup' });
  let outcome;
  try {
    const agents = await readPaseoState(client).then((s) => s.agents, () => null);
    const verification = await verifyCleanup({ manifest, client, agents, scratchBase: SCRATCH_BASE });
    outcome = await performCleanup({ verification, client });
  } finally {
    await client.close().catch(() => {});
  }
  manifest.phases.cleanup = outcome.status;
  manifest.cleanup = outcome;
  saveManifest(manifest);
  console.log(JSON.stringify({ cleanup: outcome, scratchKept: manifest.scratch }, null, 2));
  return outcome.status === 'complete' ? 0 : outcome.status === 'refused' ? 2 : 3;
}

const args = process.argv.slice(2);
process.exitCode = args[0] === '--cleanup' ? await cleanup(args[1]) : await run();
