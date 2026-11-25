// Receipt (evidence) lookup capability check. The real lookupCreationReceipt runs
// against a fixture `@getpaseo/client` resolved from a fixture CLI path, so no
// daemon and no network is needed. Each fixture lives in its own directory so
// the dynamic import never hits the module cache of another test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREATION_SNAPSHOT_PHASES, lookupCreationReceipt } from '../plugin/server/core/paseo.mjs';

const DAEMON = { version: '0.17.4', features: { creationLifecycle: true } };
const SNAPSHOT = { kind: 'workspace', idempotencyKey: 'key-1', revision: 3, phase: 'completed', workspaceId: 'wks_test', agentId: null, error: null };

function stubSource(behavior) {
  if (behavior.badExport) return 'export const DaemonClient = {};\n';
  const methods = [
    'async connect() { if (behavior.connectError) throw new Error(behavior.connectError); }',
    'getLastServerInfoMessage() { return behavior.serverInfo; }',
    'async close() {}',
  ];
  if (!behavior.missingMethod) {
    methods.push(`async sendCorrelatedSessionRequest(request) {
    globalThis.__wsfReceiptRequest = request;
    if (behavior.sendError) throw new Error(behavior.sendError);
    return behavior.response;
  }`);
  }
  return `const behavior = ${JSON.stringify(behavior)};
export class DaemonClient {
  ${methods.join('\n  ')}
}
`;
}

/** Fixture CLI + fixture SDK; register cleanup with `t.after(() => fix.cleanup())`. */
function fixture({ sdkVersion = '0.17.4', serverInfo = DAEMON, response = { snapshot: SNAPSHOT, error: null }, connectError = null, sendError = null, withDaemonClient = true, badExport = false, missingMethod = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wsf-evidence-'));
  const cliPath = join(dir, 'paseo');
  writeFileSync(cliPath, '#!/bin/sh\nexit 0\n');
  const clientDir = join(dir, 'node_modules', '@getpaseo', 'client');
  mkdirSync(join(clientDir, 'internal'), { recursive: true });
  // No "exports" map: legacy resolution serves both the package entry and the
  // internal subpath, like the real package's exports do.
  writeFileSync(join(clientDir, 'package.json'), JSON.stringify({ name: '@getpaseo/client', version: sdkVersion, type: 'module', main: 'index.js' }));
  writeFileSync(join(clientDir, 'index.js'), 'export const marker = true;\n');
  if (withDaemonClient) writeFileSync(join(clientDir, 'internal', 'daemon-client.js'), stubSource({ serverInfo, response, connectError, sendError, badExport, missingMethod }));
  return { cliPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('known snapshot phases cover the daemon lifecycle', () => {
  assert.deepEqual(CREATION_SNAPSHOT_PHASES, ['accepted', 'workspace_ready', 'agent_ready', 'prompt_started', 'completed', 'failed']);
});

test('returns the receipt snapshot and sends a one-shot subscribe', async (t) => {
  const fix = fixture();
  t.after(fix.cleanup);
  globalThis.__wsfReceiptRequest = null;
  const snapshot = await lookupCreationReceipt('workspace', 'key-1', { cliPath: fix.cliPath });
  assert.deepEqual(snapshot, SNAPSHOT);
  const request = globalThis.__wsfReceiptRequest;
  assert.equal(request.responseType, 'creation.subscribe.response');
  assert.equal(request.message.type, 'creation.subscribe.request');
  assert.equal(request.message.kind, 'workspace');
  assert.equal(request.message.idempotencyKey, 'key-1');
  assert.equal(request.message.subscribe, false);
});

test('returns null when the daemon has no receipt', async (t) => {
  const fix = fixture({ response: { snapshot: null, error: null } });
  t.after(fix.cleanup);
  assert.equal(await lookupCreationReceipt('agent', 'key-2', { cliPath: fix.cliPath }), null);
});

test('returns in-flight receipts unchanged', async (t) => {
  for (const phase of ['accepted', 'workspace_ready', 'agent_ready', 'prompt_started']) {
    const snapshot = { kind: 'agent', idempotencyKey: 'key-3', revision: 1, phase, workspaceId: null, agentId: null, error: null };
    const fix = fixture({ response: { snapshot, error: null } });
    t.after(fix.cleanup);
    assert.deepEqual(await lookupCreationReceipt('agent', 'key-3', { cliPath: fix.cliPath }), snapshot);
  }
});

test('returns failed receipts unchanged', async (t) => {
  const snapshot = { kind: 'workspace', idempotencyKey: 'key-4', revision: 2, phase: 'failed', workspaceId: 'wks_test', agentId: null, error: 'provision failed', failedStage: 'workspace' };
  const fix = fixture({ response: { snapshot, error: null } });
  t.after(fix.cleanup);
  assert.deepEqual(await lookupCreationReceipt('workspace', 'key-4', { cliPath: fix.cliPath }), snapshot);
});

test('returns outcome-unknown receipts unchanged', async (t) => {
  const snapshot = { kind: 'workspace', idempotencyKey: 'key-5', revision: 2, phase: 'failed', workspaceId: 'wks_test', agentId: null, error: 'workspace_request_outcome_unknown', failedStage: 'workspace', outcomeUnknown: true };
  const fix = fixture({ response: { snapshot, error: null } });
  t.after(fix.cleanup);
  assert.deepEqual(await lookupCreationReceipt('workspace', 'key-5', { cliPath: fix.cliPath }), snapshot);
});

test('accepts any daemon version advertising the capability', async (t) => {
  const fix = fixture({ serverInfo: { version: '9.9.9', features: { creationLifecycle: true } } });
  t.after(fix.cleanup);
  assert.deepEqual(await lookupCreationReceipt('workspace', 'key-1', { cliPath: fix.cliPath }), SNAPSHOT);
});

test('refuses a daemon without creationLifecycle', async (t) => {
  const fix = fixture({ serverInfo: { version: '0.17.4', features: {} } });
  t.after(fix.cleanup);
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: fix.cliPath }),
    /receipt lookup refused: daemon 0\.17\.4 does not advertise creationLifecycle; refusing to create without a receipt/,
  );
});

test('refuses a daemon without server info', async (t) => {
  const fix = fixture({ serverInfo: null });
  t.after(fix.cleanup);
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: fix.cliPath }),
    /receipt lookup refused: daemon unknown does not advertise creationLifecycle; refusing to create without a receipt/,
  );
});

test('fails closed when the internal DaemonClient cannot be loaded', async (t) => {
  const fix = fixture({ withDaemonClient: false });
  t.after(fix.cleanup);
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: fix.cliPath }),
    /receipt lookup failed: cannot load the internal DaemonClient [\s\S]*; refusing to create without a receipt/,
  );
  const broken = fixture({ badExport: true });
  t.after(broken.cleanup);
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: broken.cliPath }),
    /receipt lookup failed: the installed @getpaseo\/client exports no DaemonClient constructor; refusing to create without a receipt/,
  );
});

test('fails closed when the DaemonClient lacks the subscribe method', async (t) => {
  const fix = fixture({ missingMethod: true });
  t.after(fix.cleanup);
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: fix.cliPath }),
    /receipt lookup failed: the installed DaemonClient lacks sendCorrelatedSessionRequest\(\), which the receipt lookup needs; refusing to create without a receipt/,
  );
});

test('fails closed when the daemon cannot be reached', async (t) => {
  const fix = fixture({ connectError: 'ECONNREFUSED' });
  t.after(fix.cleanup);
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: fix.cliPath }),
    /receipt lookup failed: cannot reach the daemon .* \(ECONNREFUSED\); refusing to create without a receipt/,
  );
});

test('fails closed when the subscribe exchange fails or answers with an error', async (t) => {
  const broken = fixture({ sendError: 'timeout' });
  t.after(broken.cleanup);
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: broken.cliPath }),
    /receipt lookup failed: the creation\.subscribe exchange failed \(timeout\); refusing to create without a receipt/,
  );
  const denied = fixture({ response: { error: 'unknown kind' } });
  t.after(denied.cleanup);
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: denied.cliPath }),
    /receipt lookup failed: the daemon answered with an error \(unknown kind\); refusing to create without a receipt/,
  );
});

test('fails closed on an unrecognized receipt shape', async (t) => {
  const cases = [
    ['missing snapshot', {}],
    ['snapshot is not an object', { snapshot: 'completed', error: null }],
    ['kind/key mismatch', { snapshot: { ...SNAPSHOT, kind: 'agent' }, error: null }],
    ['unknown phase', { snapshot: { ...SNAPSHOT, phase: 'archived' }, error: null }],
    ['bad revision', { snapshot: { ...SNAPSHOT, revision: -1 }, error: null }],
  ];
  for (const [detail, response] of cases) {
    const fix = fixture({ response });
    t.after(fix.cleanup);
    await assert.rejects(
      lookupCreationReceipt('workspace', 'key-1', { cliPath: fix.cliPath }),
      (error) => {
        assert.match(error.message, /receipt lookup failed: the daemon answered with an unrecognized receipt shape \([^)]*\); refusing to create without a receipt/);
        assert.ok(error.message.includes(detail), `message names ${detail}: ${error.message}`);
        return true;
      },
    );
  }
});
