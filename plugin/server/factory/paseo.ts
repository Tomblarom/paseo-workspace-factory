// @ts-nocheck
// GENERATED from src/paseo.mjs by npm run plugin:sync. Do not edit.
// Paseo access: the public @getpaseo/client SDK for reads and creation, the
// official CLI (JSON output) for operations the public SDK does not expose.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { daemonHost, runtime } from './runtime.js';
import { pathToFileURL } from 'node:url';

export const LABEL = {
  repo: 'wsf.repo',
  role: 'wsf.role',
  slot: 'wsf.slot',
  scope: 'wsf.scope',
  owner: 'wsf.owner',
};
export const PARENT_LABEL = 'paseo.parent-agent-id';
export const METADATA_KEY = 'wsf';

/**
 * Host-specific prefix the pilot used for factory labels and metadata keys.
 * Still read (see below); a planned `labels.migrate` op rewrites it.
 */
export const LEGACY_PREFIX = 'ari.wsf';

/** Maps one legacy key to its new counterpart (`ari.wsf.x` -> `wsf.x`); null for non-legacy keys. */
export function newKeyForLegacyKey(oldKey) {
  if (oldKey === LEGACY_PREFIX) return METADATA_KEY;
  if (typeof oldKey === 'string' && oldKey.startsWith(`${LEGACY_PREFIX}.`)) return `${METADATA_KEY}${oldKey.slice(LEGACY_PREFIX.length)}`;
  return null;
}

/** Legacy keys that still need migration: old keys without a persisted new counterpart. */
export function pendingLegacyKeys(dict) {
  if (!dict || typeof dict !== 'object') return [];
  return Object.keys(dict).filter((key) => {
    const mapped = newKeyForLegacyKey(key);
    return mapped !== null && dict[mapped] === undefined;
  });
}

/**
 * Adds the new counterparts of legacy keys to a labels/metadata dict so all
 * readers work unchanged. Mixed records keep both: the new prefix wins on read.
 * Records with legacy keys are marked `legacyPrefix: true`; records that still
 * need migration also carry `legacyPending: [old keys...]` (a plain
 * counterpart check cannot tell persisted new keys from these inferred ones).
 */
function withNormalizedPrefix(record, field) {
  const dict = record?.[field];
  if (!dict || typeof dict !== 'object') return record;
  const pending = pendingLegacyKeys(dict);
  const legacy = pending.length > 0 || Object.keys(dict).some((key) => newKeyForLegacyKey(key) !== null);
  if (!legacy) return record;
  const normalized = { ...dict };
  for (const key of pending) normalized[newKeyForLegacyKey(key)] = dict[key];
  return { ...record, [field]: normalized, legacyPrefix: true, ...(pending.length ? { legacyPending: pending } : {}) };
}

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

/** Absolute path of the configured `paseo` binary (PATH lookup for bare names). */
export function paseoBinary(bin = runtime().paseo.bin) {
  if (bin.includes('/')) return bin;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, bin);
    if (dir && existsSync(candidate)) return candidate;
  }
  throw new Error(`Paseo CLI "${bin}" not found on PATH; set runtime.paseo.bin or PASEO_FACTORY_PASEO_BIN`);
}

/** Daemon password: PASEO_PASSWORD, else runtime.paseo.passwordFile, else none. */
export function daemonPassword() {
  if (process.env.PASEO_PASSWORD) return process.env.PASEO_PASSWORD;
  const file = runtime().paseo.passwordFile;
  return file ? readFileSync(file, 'utf8').trim() : undefined;
}

/** Loads the SDK that ships with the installed CLI, so both always match the daemon release. */
export async function loadSdk(cliPath = paseoBinary()) {
  const require = createRequire(realpathSync(cliPath));
  return import(pathToFileURL(require.resolve('@getpaseo/client')).href);
}

export async function connect({ url = runtime().paseo.url, clientId = 'paseo-workspace-factory' } = {}) {
  const { createPaseoClient } = await loadSdk();
  const client = createPaseoClient({ url, password: daemonPassword(), clientId, logger: SILENT, reconnect: { enabled: false } });
  await client.connect();
  return client;
}

async function collectPages(fetchPage) {
  const entries = [];
  let cursor;
  for (let guard = 0; guard < 1000; guard += 1) {
    const page = await fetchPage(cursor);
    entries.push(...(page.entries ?? []));
    if (!page.pageInfo?.hasMore || !page.pageInfo.nextCursor) return entries;
    cursor = page.pageInfo.nextCursor;
  }
  throw new Error('Pagination did not terminate');
}

/** Complete, read-only picture of the daemon state the planner needs. */
export async function readPaseoState(client) {
  const page = (cursor) => ({ limit: 200, ...(cursor ? { cursor } : {}) });
  const [projects, workspaces, agentEntries, providers] = await Promise.all([
    client.projects.list().then((result) => result.projects ?? []),
    collectPages((cursor) => client.workspaces.list({ includeBackground: true, filter: { includeBackground: true }, page: page(cursor) })),
    collectPages((cursor) => client.agents.list({ includeBackground: true, filter: { includeArchived: true, includeBackground: true }, page: page(cursor) })),
    client.providers.snapshot().then((result) => result.entries ?? []),
  ]);
  return {
    projects,
    workspaces: workspaces.map((workspace) => withNormalizedPrefix(workspace, 'metadata')),
    agents: agentEntries.map((entry) => withNormalizedPrefix(entry.agent ?? entry, 'labels')),
    providers,
  };
}

/** Runs the official CLI with JSON output. PASEO_AGENT_ID is removed so no parent can be inherited. */
export function createPaseoCli(exec = execFileSync, binary = paseoBinary()) {
  return function paseoCli(args) {
    const env = { ...process.env };
    delete env.PASEO_AGENT_ID;
    const password = daemonPassword();
    if (password) env.PASEO_PASSWORD = password;
    let output;
    try {
      output = exec(binary, ['--host', daemonHost(), ...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, timeout: 6 * 60_000 });
    } catch (error) {
      throw new Error(`paseo ${args[0]} failed: ${String(error?.stderr ?? error.message).trim()}`);
    }
    return output.trim() ? JSON.parse(output) : null;
  };
}

export function parentOf(agent) {
  const value = agent?.labels?.[PARENT_LABEL];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Paseo releases the receipt lookup was tested against. The lookup speaks the
 * internal `creation.subscribe` protocol message (which the SDK itself uses to
 * reattach to running creations); its shape is not part of the public SDK
 * contract, so any other daemon or `@getpaseo/client` version fails closed
 * instead of risking a create without a receipt. See "Version binding" in
 * docs/configuration.md. Extend only after the live crash test passes there.
 */
export const RECEIPT_LOOKUP_TESTED_VERSIONS = ['0.16.2'];

/**
 * Version of the `@getpaseo/client` shipping with the installed CLI. The
 * package does not export its package.json, so it is read from the filesystem
 * next to the resolved client entry. Returns null when it cannot be verified.
 */
export function installedClientVersion(cliPath = paseoBinary()) {
  const require = createRequire(realpathSync(cliPath));
  let dir = dirname(require.resolve('@getpaseo/client'));
  for (let guard = 0; guard < 6; guard += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
      if (pkg?.name === '@getpaseo/client') return pkg.version ?? null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Read-only lookup of a daemon creation receipt by idempotency key. Paseo
 * exposes this only through the internal `creation.subscribe.request` (used by
 * the SDK itself to reattach to running creations), so it is isolated here,
 * pinned to the tested versions and fails closed: an untested SDK or daemon
 * version, a missing `creationLifecycle` feature, or a failed import, connect
 * or exchange throws — it never reports "no receipt" on failure, so callers
 * never re-create without a receipt. Returns the receipt snapshot or null when
 * the daemon has no receipt. Side effect owned by the daemon: a receipt left
 * in-flight by a dead daemon run is marked outcomeUnknown when looked up.
 */
export async function lookupCreationReceipt(kind, idempotencyKey, { url = runtime().paseo.url, cliPath = paseoBinary(), expectedVersion = RECEIPT_LOOKUP_TESTED_VERSIONS[0] } = {}) {
  const tested = [expectedVersion];
  let clientVersion;
  try {
    clientVersion = installedClientVersion(cliPath);
  } catch (error) {
    throw new Error(`receipt lookup failed: cannot verify the installed @getpaseo/client version (${error.message}); refusing to create without a receipt`);
  }
  if (!tested.includes(clientVersion)) {
    throw new Error(`receipt lookup refused: installed @getpaseo/client ${clientVersion ?? 'unknown'} is outside the tested versions (${tested.join(', ')}); refusing to create without a receipt`);
  }
  const require = createRequire(realpathSync(cliPath));
  let DaemonClient;
  try {
    ({ DaemonClient } = await import(pathToFileURL(require.resolve('@getpaseo/client/internal/daemon-client')).href));
  } catch (error) {
    throw new Error(`receipt lookup failed: cannot load the internal DaemonClient from @getpaseo/client ${clientVersion} (${error.message}); refusing to create without a receipt`);
  }
  const daemon = new DaemonClient({ url, password: daemonPassword(), clientId: 'paseo-workspace-factory-receipt', logger: SILENT, reconnect: { enabled: false } });
  try {
    try {
      await daemon.connect();
    } catch (error) {
      throw new Error(`receipt lookup failed: cannot reach the daemon at ${url} (${error.message}); refusing to create without a receipt`);
    }
    const info = daemon.getLastServerInfoMessage();
    const version = info?.version ?? info?.daemonVersion;
    if (!tested.includes(version)) {
      throw new Error(`receipt lookup refused: daemon ${version ?? 'unknown'} is outside the tested versions (${tested.join(', ')}); refusing to create without a receipt`);
    }
    if (info?.features?.creationLifecycle !== true) {
      throw new Error(`receipt lookup refused: daemon ${version} does not advertise creationLifecycle; refusing to create without a receipt`);
    }
    const requestId = `wsf-receipt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let response;
    try {
      response = await daemon.sendCorrelatedSessionRequest({
        requestId,
        message: { type: 'creation.subscribe.request', requestId, kind, idempotencyKey, subscribe: false },
        responseType: 'creation.subscribe.response',
        timeout: 15_000,
      });
    } catch (error) {
      throw new Error(`receipt lookup failed: the creation.subscribe exchange failed (${error.message}); refusing to create without a receipt`);
    }
    if (response?.error) throw new Error(`receipt lookup failed: the daemon answered with an error (${response.error}); refusing to create without a receipt`);
    return response?.snapshot ?? null;
  } finally {
    await daemon.close().catch(() => {});
  }
}
