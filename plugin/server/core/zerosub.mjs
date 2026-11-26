// ZeroSub account integration (first slice): quota pools keyed by ZeroSub
// account instead of profile/provider, with fallback to the usage adapter.
// Shape only: the daemon plugin RPC `zerosub.zerosub.state` returns accounts
// (id, family, label, kind, plan, status, isDefault, limitedUntil, usage with
// windows of usedPercent/resetsAt, agentCount), agent routes and logins.
// Account `email`/`organization`/`home` fields are never stored or output;
// the normaliser drops them. All reads fail soft (null) so callers fall back.
import { LABEL, PARENT_LABEL, connectPluginRpc, paseoBinary, parentOf } from './paseo.mjs';
import { runtime } from './runtime.mjs';
import { QUOTA_DEFAULTS, bestFamilyAccount } from './quota.mjs';

/** Statuses that mark an account as limited without consulting any threshold. */
const LIMITED_STATUSES = new Set(['limited', 'exhausted', 'suspended', 'blocked']);

/** Move waiting states carried per agent route (anything else is dropped). */
const WAITING_STATES = new Set(['idle', 'turn', 'background', 'restart']);

function limitedByStatus(status) {
  return typeof status === 'string' && LIMITED_STATUSES.has(status.trim().toLowerCase());
}

function asId(value) {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Pure, tolerant normaliser for the raw `zerosub.state` payload. Missing
 * fields become empty defaults; malformed entries are skipped. Returns
 * { accounts, agentAccount, pending, waiting, version } where each account
 * carries { id, family, label, status, limitedUntil, windows, maxUsedPct,
 * exhausted }. `exhausted` is the status-based limit flag only (status or a
 * future limitedUntil); percent thresholds live in quota.mjs
 * (`accountExhausted`). `maxUsedPct` covers only windows whose reset has not
 * passed; an expired window's usedPct is stale and never counts. `waiting`
 * maps agent ids to their move waiting state
 * (`idle`, `turn`, `background`, `restart`); unknown values are dropped.
 * `version` is the raw payload version (null when missing, i.e. v1);
 * consumers fall back to the usage snapshot on explicit unknown versions.
 * Windows keep an optional model restriction (`models`) when present.
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
      const models = Array.isArray(window.models)
        ? window.models.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim())
        : (typeof window.model === 'string' && window.model.trim() ? [window.model.trim()] : null);
      windows.push({
        id: wid,
        usedPct: Number.isFinite(used) ? used : null,
        resetsAt: asId(window.resetsAt),
        ...(models && models.length ? { models } : {}),
      });
    }
    const pcts = windows
      .filter((window) => {
        if (!Number.isFinite(window.usedPct)) return false;
        const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
        return !Number.isFinite(reset) || reset > now;
      })
      .map((window) => window.usedPct);
    const limitedMs = limitedUntil ? Date.parse(limitedUntil) : NaN;
    accounts.push({
      id,
      family: typeof entry.family === 'string' ? entry.family.toLowerCase() : '',
      ...(entry.auth === 'subscription' || entry.auth === 'api' ? { auth: entry.auth } : {}),
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
  const waiting = {};
  const agents = Array.isArray(raw?.agents) ? raw.agents : [];
  for (const route of agents) {
    if (!route || typeof route !== 'object') continue;
    const agentId = asId(route.agentId);
    if (!agentId) continue;
    if (asId(route.accountId)) agentAccount[agentId] = route.accountId;
    if (asId(route.pendingAccountId)) pending[agentId] = route.pendingAccountId;
    const wait = typeof route.waiting === 'string' ? route.waiting.trim().toLowerCase() : '';
    if (wait && WAITING_STATES.has(wait)) waiting[agentId] = wait;
  }
  const version = typeof raw?.version === 'string' || typeof raw?.version === 'number' ? raw.version : null;
  return { accounts, agentAccount, pending, waiting, version };
}

/**
 * Label ZeroSub sets on a continuation tab (Codex account-switch tab); the
 * value is the source (origin) agent id and stays stable. ZeroSub never
 * copies factory labels onto the tab, so the factory itself moves role/slot
 * to the live continuation (kapybara-org/zerosub#119).
 */
export const CONTINUED_FROM_LABEL = 'zerosub.continued-from';

/**
 * Timeline row ZeroSub writes on the switched agent (server/service.ts
 * appendRow): { type: 'plugin', kind: 'zerosub-switch', version: 1, data }.
 * Contract (kapybara-org/zerosub#119, stable since 1.0.0): family, from, to,
 * toFamily, at, reason, outcome, resetsAt, continuedIn ({ agentId, title }),
 * continued. `detail` is never parsed; unknown reason/family values and
 * missing optional fields are tolerated.
 */
export const SWITCH_ROW_KIND = 'zerosub-switch';
export const SWITCH_ROW_TYPE = SWITCH_ROW_KIND;

/** Creation metadata that pins a fresh agent to a ZeroSub account (Paseo 0.16+). */
export const ACCOUNT_METADATA_KEY = 'zerosub.account';

/** Plugin RPC that pins an agent to a ZeroSub account. */
export const ACCOUNT_PIN_PLUGIN_ID = 'zerosub';
export const ACCOUNT_PIN_METHOD = 'zerosub.agents.account';

/** Source agent id of a continuation tab, or null without the label. */
export function continuedFromId(agent) {
  const value = agent?.labels?.[CONTINUED_FROM_LABEL];
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id ? id : null;
}

/** Labelled root of a parent-free continuation in the same workspace, or null. */
export function continuationOrigin(agent, agents) {
  if (!continuedFromId(agent) || agent.archivedAt || parentOf(agent) || !agent.workspaceId) return null;
  const byId = new Map((agents ?? []).map((entry) => [entry.id, entry]));
  const seen = new Set([agent.id]);
  let origin = agent;
  while (continuedFromId(origin)) {
    const id = continuedFromId(origin);
    if (seen.has(id)) return null;
    seen.add(id);
    origin = byId.get(id);
    if (!origin) return null;
  }
  const role = origin.labels?.[LABEL.role];
  return origin.workspaceId === agent.workspaceId && (role === 'steer' || role === 'worker') &&
    (origin.labels?.[LABEL.scope] || origin.labels?.[LABEL.repo]) ? origin : null;
}

/** Factory identity labels, inferred from a valid continuation before normalization. */
export function resolveFactoryLabels(agent, agents = []) {
  const labels = agent?.labels ?? {};
  const role = labels[LABEL.role];
  if ((role === 'steer' || role === 'worker') && (labels[LABEL.scope] || labels[LABEL.repo])) return labels;
  const origin = continuationOrigin(agent, agents);
  if (!origin) return null;
  const inherited = inheritContinuationLabels(agent, origin);
  const { [PARENT_LABEL]: _parent, ...withoutParent } = inherited;
  return withoutParent;
}

function text(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v ? v : null;
}

/** continuedIn is { agentId, title }; a bare string id is tolerated. */
function continuedAgentId(value) {
  if (typeof value === 'string') return text(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) return text(value.agentId);
  return null;
}

/** Normalizes a zerosub-switch row's `data`; missing fields become null, `detail` is ignored. */
export function parseSwitchData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return {
    family: text(data.family),
    from: text(data.from),
    to: text(data.to),
    toFamily: text(data.toFamily),
    toProvider: text(data.toProvider),
    at: text(data.at),
    reason: text(data.reason),
    outcome: text(data.outcome),
    resetsAt: text(data.resetsAt),
    continued: data.continued === true,
    continuedIn: continuedAgentId(data.continuedIn),
  };
}

function switchRowData(entry) {
  const item = entry?.item ?? entry;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (item.type !== 'plugin' || item.kind !== SWITCH_ROW_KIND) return null;
  if (item.pluginId !== undefined && item.pluginId !== 'zerosub') return null;
  return item.data ?? null;
}

/** All parsed zerosub-switch rows of a timeline payload, oldest first. */
export function switchRowsFromTimeline(timelinePayload) {
  const entries = timelinePayload?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => parseSwitchData(switchRowData(entry))).filter(Boolean);
}

/** The latest zerosub-switch row, or null. */
export function latestSwitchRow(timelinePayload) {
  const rows = switchRowsFromTimeline(timelinePayload);
  return rows.length ? rows[rows.length - 1] : null;
}

/**
 * Continuation pairs from one agent's timeline payload: the last
 * zerosub-switch row carrying a continuedIn agent id (at most one pair; also
 * set when outcome is 'stayed'). Self references and other rows are ignored.
 */
export function switchesFromTimeline(agentId, timelinePayload) {
  if (typeof agentId !== 'string' || !agentId) return [];
  let found = null;
  for (const row of switchRowsFromTimeline(timelinePayload)) {
    if (row.continuedIn && row.continuedIn !== agentId) found = { agentId, continuedIn: row.continuedIn };
  }
  return found ? [found] : [];
}

function pushEdge(map, origin, target) {
  if (!map.has(origin)) map.set(origin, []);
  map.get(origin).push(target);
}

/**
 * Resolves continuation tabs to their live agent. Two signals feed the same
 * origin -> continuation edges: the `zerosub.continued-from` label on live
 * (non-archived) tabs, and timeline-derived `switches` pairs
 * ({ agentId, continuedIn }, see switchesFromTimeline). Both sides of an edge
 * must be known agents; dangling, self-referencing and cyclic edges are
 * ignored. Label edges win per origin (the stable signal); chains resolve
 * transitively (origin and mid-chain tabs map to the final live tab);
 * several live continuations of one origin resolve deterministically
 * (sorted id order). Returns { liveFor, superseded, live }: the
 * origin -> live-end map, the sorted superseded origin ids, and the sorted
 * live-end ids. Pure; timeline reads stay with the caller.
 */
export function resolveContinuations(agents, switches = []) {
  const byId = new Map();
  for (const agent of agents ?? []) {
    if (agent && typeof agent.id === 'string' && agent.id && !byId.has(agent.id)) byId.set(agent.id, agent);
  }
  const labelChildren = new Map();
  for (const agent of byId.values()) {
    if (agent.archivedAt) continue; // an archived tab never supersedes its origin
    const origin = continuedFromId(agent);
    if (!origin || origin === agent.id || !byId.has(origin)) continue;
    pushEdge(labelChildren, origin, agent.id);
  }
  const switchChildren = new Map();
  for (const pair of switches ?? []) {
    const origin = typeof pair?.agentId === 'string' ? pair.agentId.trim() : '';
    const target = typeof pair?.continuedIn === 'string' ? pair.continuedIn.trim() : '';
    if (!origin || !target || origin === target) continue;
    if (!byId.has(origin) || !byId.has(target)) continue;
    if (byId.get(target).archivedAt) continue;
    pushEdge(switchChildren, origin, target);
  }
  const children = new Map(labelChildren);
  for (const [origin, targets] of switchChildren) {
    if (!children.has(origin)) children.set(origin, targets);
  }
  for (const targets of children.values()) targets.sort();
  const liveFor = {};
  for (const origin of children.keys()) {
    const seen = new Set([origin]);
    let current = origin;
    let cyclic = false;
    for (;;) {
      const all = children.get(current) ?? [];
      const next = all.filter((id) => !seen.has(id));
      if (!next.length) {
        cyclic = all.length > 0;
        break;
      }
      current = next[0];
      seen.add(current);
    }
    if (!cyclic && current !== origin) liveFor[origin] = current;
  }
  return {
    liveFor,
    superseded: Object.keys(liveFor).sort(),
    live: [...new Set(Object.values(liveFor))].sort(),
  };
}

/**
 * Factory labels a continuation tab inherits from its origin (missing keys
 * only; labels the live tab already carries always win). Covers the steer
 * identity (repo/scope/role/slot), the worker identity (scope/role/owner)
 * and the parent link, so attribution follows the live tab.
 */
export function inheritContinuationLabels(live, origin) {
  const labels = { ...(live?.labels ?? {}) };
  for (const key of [LABEL.repo, LABEL.scope, LABEL.role, LABEL.slot, LABEL.owner, PARENT_LABEL]) {
    if (labels[key] === undefined && origin?.labels?.[key] !== undefined) labels[key] = origin.labels[key];
  }
  return labels;
}

/**
 * Pure pin suggestion for a worker of `family`: the roomiest usable account
 * plus the creation metadata that pins the new agent to it
 * (`metadata: {"zerosub.account": id}`, Paseo 0.16+). Null without ZeroSub
 * state, without a family, or when every account is exhausted. No live call;
 * the caller passes `metadata` at creation (or pins via the RPC after).
 */
export function suggestAccountPin(zerosub, family, { exhaustedPct = QUOTA_DEFAULTS.exhaustedPct, now = Date.now(), model = null } = {}) {
  if (!zerosub || typeof family !== 'string' || !family) return null;
  const best = bestFamilyAccount(zerosub, family, { exhaustedPct, now, model });
  if (!best) return null;
  return {
    pluginId: ACCOUNT_PIN_PLUGIN_ID,
    method: ACCOUNT_PIN_METHOD,
    accountId: best.id,
    metadata: { [ACCOUNT_METADATA_KEY]: best.id },
  };
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

function defaultCreateClient(options) {
  return connectPluginRpc({ ...options, clientId: 'paseo-workspace-factory-zerosub' });
}
