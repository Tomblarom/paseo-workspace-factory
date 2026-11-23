// Receipt (evidence) lookup version binding. The real lookupCreationReceipt runs
// against a fixture `@getpaseo/client` resolved from a fixture CLI path, so no
// daemon and no network is needed. Each fixture lives in its own directory so
// the dynamic import never hits the module cache of another test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedClientVersion, lookupCreationReceipt, RECEIPT_LOOKUP_TESTED_VERSIONS } from '../src/paseo.mjs';

const DAEMON = { version: '0.16.2', features: { creationLifecycle: true } };
const SNAPSHOT = { phase: 'completed', workspaceId: 'wks_test', idempotencyKey: 'key-1' };

function stubSource(behavior) {
  return `const behavior = ${JSON.stringify(behavior)};
export class DaemonClient {
  async connect() { if (behavior.connectError) throw new Error(behavior.connectError); }
  getLastServerInfoMessage() { return behavior.serverInfo; }
  async sendCorrelatedSessionRequest(request) {
    globalThis.__wsfReceiptRequest = request;
    if (behavior.sendError) throw new Error(behavior.sendError);
    return behavior.response;
  }
  async close() {}
}
`;
}

/** Fixture CLI + fixture SDK; register cleanup with `t.after(() => fix.cleanup())`. */
function fixture({ sdkVersion = '0.16.2', serverInfo = DAEMON, response = { snapshot: SNAPSHOT }, connectError = null, sendError = null, withDaemonClient = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wsf-evidence-'));
  const cliPath = join(dir, 'paseo');
  writeFileSync(cliPath, '#!/bin/sh\nexit 0\n');
  const clientDir = join(dir, 'node_modules', '@getpaseo', 'client');
  mkdirSync(join(clientDir, 'internal'), { recursive: true });
  // No "exports" map: legacy resolution serves both the package entry and the
  // internal subpath, like the real package's exports do.
  writeFileSync(join(clientDir, 'package.json'), JSON.stringify({ name: '@getpaseo/client', version: sdkVersion, type: 'module', main: 'index.js' }));
  writeFileSync(join(clientDir, 'index.js'), 'export const marker = true;\n');
  if (withDaemonClient) writeFileSync(join(clientDir, 'internal', 'daemon-client.js'), stubSource({ serverInfo, response, connectError, sendError }));
  return { cliPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('version binding names the tested Paseo release', () => {
  assert.ok(Array.isArray(RECEIPT_LOOKUP_TESTED_VERSIONS));
  assert.ok(RECEIPT_LOOKUP_TESTED_VERSIONS.includes('0.16.2'));
});

test('installedClientVersion reads the SDK shipping with the CLI', (t) => {
  const fix = fixture({ sdkVersion: '0.16.2' });
  t.after(fix.cleanup);
  assert.equal(installedClientVersion(fix.cliPath), '0.16.2');
});

test('returns the receipt snapshot on tested versions', async (t) => {
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
  const fix = fixture({ response: {} });
  t.after(fix.cleanup);
  assert.equal(await lookupCreationReceipt('agent', 'key-2', { cliPath: fix.cliPath }), null);
});

test('refuses a daemon outside the tested versions', async (t) => {
  const fix = fixture({ serverInfo: { version: '0.17.0', features: { creationLifecycle: true } } });
  t.after(fix.cleanup);
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: fix.cliPath }),
    /receipt lookup refused: daemon 0\.17\.0 is outside the tested versions \(0\.16\.2\); refusing to create without a receipt/,
  );
});

test('refuses a daemon without server info', async (t) => {
  const fix = fixture({ serverInfo: null });
  t.after(fix.cleanup);
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: fix.cliPath }),
    /receipt lookup refused: daemon unknown is outside the tested versions/,
  );
});

test('refuses a daemon without creationLifecycle', async (t) => {
  const fix = fixture({ serverInfo: { version: '0.16.2', features: {} } });
  t.after(fix.cleanup);
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: fix.cliPath }),
    /receipt lookup refused: daemon 0\.16\.2 does not advertise creationLifecycle; refusing to create without a receipt/,
  );
});

test('refuses an installed SDK outside the tested versions before connecting', async (t) => {
  const fix = fixture({ sdkVersion: '0.15.0', connectError: 'must not be reached' });
  t.after(fix.cleanup);
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: fix.cliPath }),
    /receipt lookup refused: installed @getpaseo\/client 0\.15\.0 is outside the tested versions \(0\.16\.2\); refusing to create without a receipt/,
  );
});

test('fails closed when the SDK version cannot be verified', async (t) => {
  const fix = fixture({ sdkVersion: 'not-a-version' });
  t.after(fix.cleanup);
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: fix.cliPath }),
    /receipt lookup refused: installed @getpaseo\/client not-a-version is outside the tested versions/,
  );
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: join(fix.cliPath, 'missing-cli') }),
    /receipt lookup failed: cannot verify the installed @getpaseo\/client version/,
  );
});

test('fails closed when the internal DaemonClient cannot be loaded', async (t) => {
  const fix = fixture({ withDaemonClient: false });
  t.after(fix.cleanup);
  await assert.rejects(
    lookupCreationReceipt('workspace', 'key-1', { cliPath: fix.cliPath }),
    /receipt lookup failed: cannot load the internal DaemonClient from @getpaseo\/client 0\.16\.2 [\s\S]*; refusing to create without a receipt/,
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
