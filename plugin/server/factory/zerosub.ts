// @ts-nocheck
// GENERATED from src/zerosub.mjs by npm run plugin:sync. Do not edit.
// ZeroSub account integration (first slice): quota pools keyed by ZeroSub
// account instead of profile/provider, with fallback to the usage adapter.
// Shape only: the daemon plugin RPC `zerosub.zerosub.state` returns accounts
// (id, family, label, kind, plan, status, isDefault, limitedUntil, usage with
// windows of usedPercent/resetsAt, agentCount), agent routes and logins.
// Account `email`/`organization`/`home` fields are never stored or output;
// the normaliser drops them. All reads fail soft (null) so callers fall back.
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { daemonPassword, paseoBinary } from './paseo.js';
import { runtime } from './runtime.js';

/** Statuses that mark an account as limited without consulting any threshold. */
const LIMITED_STATUSES = new Set(['limited', 'exhausted', 'suspended', 'blocked']);

function limitedByStatus(status) {
  return typeof status === 'string' && LIMITED_STATUSES.has(status.trim().toLowerCase());
}

function asId(value) {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Pure, tolerant normaliser for the raw `zerosub.state` payload. Missing
 * fields become empty defaults; malformed entries are skipped. Returns
 * { accounts, agentAccount, pending } where each account carries
 * { id, family, label, status, limitedUntil, windows, maxUsedPct, exhausted }.
 * `exhausted` is the status-based limit flag only (status or a future
 * limitedUntil); percent thresholds live in quota.mjs (`accountExhausted`).
 */
export function normalizeZerosubState(raw, { now = Date.now() } = {}) {
  const accounts = [];
  const list = Array.isArray(raw?.accounts) ? raw.accounts : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = asId(entry.id);
    if (!id) continue;
    const limitedUntil = asId(entry.limitedUntil);
    const status = typeof entry.status === 'string' ? entry.status : '';
    const windows = [];
    const rawWindows = Array.isArray(entry.usage?.windows) ? entry.usage.windows : [];
    for (const window of rawWindows) {
      if (!window || typeof window !== 'object') continue;
      const wid = asId(window.id) ?? asId(window.label);
      if (!wid) continue;
      const used = Number(window.usedPercent);
      windows.push({
        id: wid,
        usedPct: Number.isFinite(used) ? used : null,
        resetsAt: asId(window.resetsAt),
      });
    }
    const pcts = windows.map((window) => window.usedPct).filter((pct) => Number.isFinite(pct));
    const limitedMs = limitedUntil ? Date.parse(limitedUntil) : NaN;
    accounts.push({
      id,
      family: typeof entry.family === 'string' ? entry.family.toLowerCase() : '',
      label: typeof entry.label === 'string' ? entry.label : '',
      status,
      limitedUntil,
      windows,
      maxUsedPct: pcts.length ? Math.max(...pcts) : null,
      exhausted: limitedByStatus(status) || (Number.isFinite(limitedMs) && limitedMs > now),
    });
  }
  const agentAccount = {};
  const pending = {};
  const agents = Array.isArray(raw?.agents) ? raw.agents : [];
  for (const route of agents) {
    if (!route || typeof route !== 'object') continue;
    const agentId = asId(route.agentId);
    if (!agentId) continue;
    if (asId(route.accountId)) agentAccount[agentId] = route.accountId;
    if (asId(route.pendingAccountId)) pending[agentId] = route.pendingAccountId;
  }
  return { accounts, agentAccount, pending };
}

/**
 * Default client factory: the internal DaemonClient that ships with the
 * installed CLI (the high-level client has no plugin RPC). Mirrors the load
 * path of lookupCreationReceipt in paseo.mjs; any failure throws and the
 * caller below turns it into a null (fallback) result.
 */
async function defaultCreateClient({ url, cliPath }) {
  const require = createRequire(realpathSync(cliPath));
  const { DaemonClient } = await import(pathToFileURL(require.resolve('@getpaseo/client/internal/daemon-client')).href);
  const daemon = new DaemonClient({
    url,
    password: daemonPassword(),
    clientId: 'paseo-workspace-factory-zerosub',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reconnect: { enabled: false },
  });
  await daemon.connect();
  return daemon;
}

/**
 * Best-effort read of the normalized ZeroSub state. Returns null on any
 * failure (no daemon, no ZeroSub plugin, RPC error, unparsable payload) so
 * callers transparently fall back to the usage adapter. `createClient` is
 * injectable for tests ({ url, cliPath } -> { invokePluginRpc, close? });
 * production callers never pass it. Never call this from unit tests without
 * an injected factory.
 */
export async function readZerosubState({ url = null, cliPath = null, createClient = defaultCreateClient } = {}) {
  let client = null;
  try {
    const target = url ?? runtime().paseo.url;
    const bin = cliPath ?? paseoBinary();
    client = await createClient({ url: target, cliPath: bin });
    const raw = await client.invokePluginRpc('zerosub', 'zerosub.state', {});
    return normalizeZerosubState(raw);
  } catch {
    return null;
  } finally {
    await client?.close?.().catch(() => {});
  }
}
