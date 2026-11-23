// Paseo access: the public @getpaseo/client SDK for reads and creation, the
// official CLI (JSON output) for operations the public SDK does not expose.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { daemonHost, runtime } from './runtime.mjs';
import { pathToFileURL } from 'node:url';

export const LABEL = {
  repo: 'ari.wsf.repo',
  role: 'ari.wsf.role',
  slot: 'ari.wsf.slot',
};
export const PARENT_LABEL = 'paseo.parent-agent-id';
export const METADATA_KEY = 'ari.wsf';

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
  return { projects, workspaces, agents: agentEntries.map((entry) => entry.agent ?? entry), providers };
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
 * Read-only lookup of a daemon creation receipt by idempotency key. Paseo 0.16.2
 * exposes this only through the internal `creation.subscribe.request` (used by the
 * SDK itself to reattach to running creations), so it is isolated here, pinned to the
 * tested daemon version and fails closed. Returns the receipt snapshot or null when
 * the daemon has no receipt. Side effect owned by the daemon: a receipt left
 * in-flight by a dead daemon run is marked outcomeUnknown when looked up.
 */
export async function lookupCreationReceipt(kind, idempotencyKey, { url = runtime().paseo.url, cliPath = paseoBinary(), expectedVersion = '0.16.2' } = {}) {
  const require = createRequire(realpathSync(cliPath));
  const { DaemonClient } = await import(pathToFileURL(require.resolve('@getpaseo/client/internal/daemon-client')).href);
  const daemon = new DaemonClient({ url, password: daemonPassword(), clientId: 'paseo-workspace-factory-receipt', logger: SILENT, reconnect: { enabled: false } });
  await daemon.connect();
  try {
    const info = daemon.getLastServerInfoMessage();
    const version = info?.version ?? info?.daemonVersion;
    if (version !== expectedVersion || info?.features?.creationLifecycle !== true) {
      throw new Error(`receipt lookup is only verified for daemon ${expectedVersion} with creationLifecycle (found ${version})`);
    }
    const requestId = `wsf-receipt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const response = await daemon.sendCorrelatedSessionRequest({
      requestId,
      message: { type: 'creation.subscribe.request', requestId, kind, idempotencyKey, subscribe: false },
      responseType: 'creation.subscribe.response',
      timeout: 15_000,
    });
    if (response?.error) throw new Error(`receipt lookup failed: ${response.error}`);
    return response?.snapshot ?? null;
  } finally {
    await daemon.close().catch(() => {});
  }
}
