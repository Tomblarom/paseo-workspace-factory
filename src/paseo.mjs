// Paseo access: the public @getpaseo/client SDK for reads and creation, the
// official CLI (JSON output) for operations the public SDK does not expose.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { daemonHost, runtime } from './runtime.mjs';
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

/** The public SDK has no plugin RPC surface. Use the internal client from the installed CLI. */
export async function connectPluginRpc({ url = runtime().paseo.url, cliPath = paseoBinary(), clientId = 'paseo-workspace-factory-rpc' } = {}) {
  const require = createRequire(realpathSync(cliPath));
  const { DaemonClient } = await import(pathToFileURL(require.resolve('@getpaseo/client/internal/daemon-client')).href);
  const daemon = new DaemonClient({ url, password: daemonPassword(), clientId, logger: SILENT, reconnect: { enabled: false } });
  await daemon.connect();
  return daemon;
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

/** Fresh agent membership without loading unrelated projects or provider state. */
export async function readPaseoAgents(client) {
  const agents = await collectPages((cursor) => client.agents.list({ includeBackground: true, filter: { includeArchived: true, includeBackground: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } }));
  return agents.map((entry) => withNormalizedPrefix(entry.agent ?? entry, 'labels'));
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
 * "parent <id>" for an agent with a parent, else null. Single wording source
 * for the parent display in plan hints, `scopes --candidates` and the panel.
 */
export function describeParent(agent) {
  const parent = parentOf(agent);
  return parent === null ? null : `parent ${parent}`;
}

/**
 * Context-window usage from an agent snapshot (`lastUsage`), or null when Paseo
 * reports none. Only context numbers are used; nothing is estimated. The account
 * quotas of `paseo usage` are deliberately not shown per agent: they belong to a
 * provider account, not to an agent.
 */
export function agentUsage(agent) {
  const snapshot = agent?.lastUsage ?? agent?.LastUsage ?? null;
  const used = snapshot?.contextWindowUsedTokens ?? snapshot?.ContextWindowUsedTokens;
  const max = snapshot?.contextWindowMaxTokens ?? snapshot?.ContextWindowMaxTokens;
  if (!Number.isFinite(used) || !Number.isFinite(max)) return null;
  return { usedTokens: used, maxTokens: max };
}

/** Restart reasons written by the boot check (P1) and drain (P3). */
export const RESTART_REASONS = ['daemon-restart', 'planned-restart'];

/** True for an interrupted reason that means "killed by a restart". */
export function isRestartReason(reason) {
  return typeof reason === 'string' && RESTART_REASONS.includes(reason);
}

/** Single wording source for the restart-interruption line in status/scopes/resume. */
export function restartMessage(agentId) {
  return `Agent ${agentId} durch Neustart unterbrochen`;
}

/**
 * Daemon start time from `paseo daemon status --json` (field `startedAt`,
 * verified on Paseo 0.16.2). Returns null when unreadable (fail closed: no
 * heuristic marks). Takes the CLI wrapper so tests can inject a fake.
 */
export function daemonStartedAt(paseoCli) {
  try {
    const status = paseoCli(['daemon', 'status']);
    const startedAt = status?.startedAt;
    return typeof startedAt === 'string' && startedAt ? startedAt : null;
  } catch {
    return null;
  }
}

/**
 * Known `creation.subscribe` snapshot phases (CreationSnapshotSchema in
 * `@getpaseo/protocol`). The receipt lookup validates the phase against this
 * list and fails closed on anything else, so a protocol change can never be
 * mistaken for "no receipt" or for a completed creation. Extend only after
 * the live crash test in docs/configuration.md passes against the new shape.
 */
export const CREATION_SNAPSHOT_PHASES = ['accepted', 'workspace_ready', 'agent_ready', 'prompt_started', 'completed', 'failed'];

/**
 * Validates one `creation.subscribe.response` payload. Returns the receipt
 * snapshot, or null when the daemon explicitly reports no receipt
 * (`snapshot: null`). Anything else — a missing snapshot key, a non-object
 * snapshot, a kind/key mismatch, an unknown phase or a bad revision — throws,
 * so a protocol change can never read as "no receipt". Callers interpret the
 * returned snapshot (completed vs. in-flight vs. failed vs. outcomeUnknown).
 */
function checkedReceiptSnapshot(response, kind, idempotencyKey) {
  const fail = (detail) => {
    throw new Error(`receipt lookup failed: the daemon answered with an unrecognized receipt shape (${detail}); refusing to create without a receipt`);
  };
  if (!response || typeof response !== 'object' || !('snapshot' in response)) fail('missing snapshot');
  const snapshot = response.snapshot;
  if (snapshot === null || snapshot === undefined) return null;
  if (!snapshot || typeof snapshot !== 'object') fail('snapshot is not an object');
  if (snapshot.kind !== kind || snapshot.idempotencyKey !== idempotencyKey) fail('kind/key mismatch');
  if (!CREATION_SNAPSHOT_PHASES.includes(snapshot.phase)) fail(`unknown phase ${JSON.stringify(snapshot.phase)}`);
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) fail('bad revision');
  return snapshot;
}

/**
 * Read-only lookup of a daemon creation receipt by idempotency key. Paseo
 * exposes this only through the internal `creation.subscribe.request` (used by
 * the SDK itself to reattach to running creations), so it is isolated here
 * and fails closed through a capability check instead of a version pin: the
 * internal DaemonClient module and the methods the exchange needs must exist,
 * the daemon must advertise the `creationLifecycle` feature, and the response
 * shape is validated. Any unverifiable case throws — it never reports "no
 * receipt" on failure, so callers never re-create without a receipt. Returns
 * the receipt snapshot or null when the daemon has no receipt. Side effect
 * owned by the daemon: a receipt left in-flight by a dead daemon run is
 * marked outcomeUnknown when looked up. Verified against the installed
 * `@getpaseo/client` 0.17.4 internals (internal DaemonClient, the
 * `creation.subscribe` request/response schemas and the daemon creation
 * service); see "Version binding" in docs/configuration.md.
 */
export async function lookupCreationReceipt(kind, idempotencyKey, { url = runtime().paseo.url, cliPath = paseoBinary() } = {}) {
  let DaemonClient;
  try {
    const require = createRequire(realpathSync(cliPath));
    ({ DaemonClient } = await import(pathToFileURL(require.resolve('@getpaseo/client/internal/daemon-client')).href));
  } catch (error) {
    throw new Error(`receipt lookup failed: cannot load the internal DaemonClient (${error.message}); refusing to create without a receipt`);
  }
  if (typeof DaemonClient !== 'function') {
    throw new Error('receipt lookup failed: the installed @getpaseo/client exports no DaemonClient constructor; refusing to create without a receipt');
  }
  const daemon = new DaemonClient({ url, password: daemonPassword(), clientId: 'paseo-workspace-factory-receipt', logger: SILENT, reconnect: { enabled: false } });
  for (const method of ['connect', 'sendCorrelatedSessionRequest', 'getLastServerInfoMessage', 'close']) {
    if (typeof daemon[method] !== 'function') {
      throw new Error(`receipt lookup failed: the installed DaemonClient lacks ${method}(), which the receipt lookup needs; refusing to create without a receipt`);
    }
  }
  try {
    try {
      await daemon.connect();
    } catch (error) {
      throw new Error(`receipt lookup failed: cannot reach the daemon at ${url} (${error.message}); refusing to create without a receipt`);
    }
    const info = daemon.getLastServerInfoMessage();
    if (info?.features?.creationLifecycle !== true) {
      const version = info?.version ?? info?.daemonVersion ?? 'unknown';
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
    return checkedReceiptSnapshot(response, kind, idempotencyKey);
  } finally {
    await daemon.close().catch(() => {});
  }
}
