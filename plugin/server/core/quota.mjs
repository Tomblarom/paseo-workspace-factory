/** Quota pools and the deliberately lenient `paseo usage --json` adapter. */
import { isDeepStrictEqual } from 'node:util';
import { withLock, workspaceLockName } from './lock.mjs';
import { METADATA_KEY } from './paseo.mjs';
import { QUOTA_DEFAULTS } from '../../shared/defaults.mjs';

export { QUOTA_DEFAULTS };
export const PROFILE_UNHEALTHY_MINUTES = 10;

/** Own top-level workspace metadata key for profile failure marks (native patches are top-level). */
export const PROFILE_HEALTH_KEY = `${METADATA_KEY}.profileHealth`;

/** Classify a provider failure for short-lived profile failover. */
export function classifyProfileFailure(text) {
  const value = String(text ?? '').toLowerCase();
  if (/\b503\b/.test(value) || value.includes('model_capacity_exhausted') || value.includes('capacity exhausted')) return 'capacity';
  if (value.includes('quota')) return 'quota';
  if (/\b429\b/.test(value) || value.includes('rate limit') || value.includes('usage limit') || value.includes('too many requests')) return 'limit';
  if (/\b401\b/.test(value) || /\b403\b/.test(value) || value.includes('unauthorized') || value.includes('authentication') || value.includes('auth error')) return 'auth';
  return 'other';
}

/** Return a serializable health record for a failed profile. */
export function recordProfileFailure(profile, text, { now = Date.now(), unhealthyMinutes = PROFILE_UNHEALTHY_MINUTES } = {}) {
  const name = typeof profile === 'string' ? profile : profile?.name;
  if (!name) throw new Error('recordProfileFailure needs a profile name');
  const kind = classifyProfileFailure(text);
  const failedAt = new Date(now).toISOString();
  return {
    profile: name,
    class: kind,
    reason: `recently failed: ${kind}`,
    failedAt,
    unhealthyUntil: new Date(now + Math.max(0, Number(unhealthyMinutes)) * 60_000).toISOString(),
  };
}

export function profileIsUnhealthy(profileHealth, name, now = Date.now()) {
  const record = profileHealth?.[name];
  return Boolean(record && Number.isFinite(Date.parse(record.unhealthyUntil)) && Date.parse(record.unhealthyUntil) > now);
}

/**
 * Profile failure marks from workspace metadata: the top-level
 * `wsf.profileHealth` map, or null when absent. A copy; mutating it changes
 * nothing stored.
 */
export function readProfileHealth(metadata) {
  const current = metadata?.[PROFILE_HEALTH_KEY];
  if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
  return { ...current };
}

/**
 * Locked read-modify-write of one profile failure mark: builds the record
 * with recordProfileFailure, merges it into the top-level `wsf.profileHealth`
 * map from a fresh read under the workspace lock, and verifies by re-reading.
 * Like the other locked writers (agent entries, worker register) it patches
 * only its own top-level key, so it can never roll back a concurrent
 * switch/epoch in the `wsf` scope state. Returns the stored record.
 */
export async function storeProfileFailure({ client, workspaceId, profile, text, lock = withLock, now = Date.now(), unhealthyMinutes = PROFILE_UNHEALTHY_MINUTES }) {
  const record = recordProfileFailure(profile, text, { now, unhealthyMinutes });
  const workspace = client.workspaces.ref(workspaceId);
  return lock(workspaceLockName(workspaceId), async (held) => {
    const metadata = (await workspace.refresh())?.metadata ?? {};
    const state = { ...(readProfileHealth(metadata) ?? {}), [record.profile]: record };
    held.verify(); // the lock file must still be the locked inode right before the write
    await workspace.setMetadata({ [PROFILE_HEALTH_KEY]: state });
    const written = (await workspace.refresh())?.metadata?.[PROFILE_HEALTH_KEY] ?? null;
    if (!isDeepStrictEqual(written, state)) throw new Error(`Profile health not verifiable after write in workspace ${workspaceId}`);
    return written[record.profile];
  });
}

export function profilePool(profile) {
  return typeof profile?.pool === 'string' && profile.pool.trim()
    ? profile.pool.trim()
    : (typeof profile?.provider === 'string' ? profile.provider : '');
}

/** A live provider/model tuple takes precedence over creation preferences. */
export function liveAgentPool(agent, config) {
  const provider = profileFamily(agent);
  if (!provider) return '';
  const pools = new Set(Object.values(config?.profiles ?? {})
    .filter((profile) => profileFamily(profile) === provider && profile.model === agent.model)
    .map(profilePool));
  return pools.size === 1 ? [...pools][0] : provider;
}

/** ZeroSub family of a profile (its lower-cased provider, e.g. 'claude'). */
export function profileFamily(profile) {
  return typeof profile?.provider === 'string' ? profile.provider.toLowerCase() : '';
}

/** Normalized ZeroSub accounts of one family (case-insensitive); [] without state. */
export function familyAccounts(zerosub, family) {
  const want = String(family ?? '').toLowerCase();
  if (!want) return [];
  return (zerosub?.accounts ?? []).filter((account) => account && String(account.family ?? '').toLowerCase() === want);
}

/** Model family tokens that a provider may use to scope a quota window. */
const MODEL_FAMILY_TOKENS = ['gemini', 'claude', 'gpt', 'opus', 'sonnet', 'haiku', 'codex', 'llama', 'mistral', 'grok', 'qwen', 'deepseek'];

/**
 * True when a quota window applies to `model`. A window whose id or label
 * names model families (e.g. "agy-claude-and-gpt-models-weekly") applies only
 * to models of those families; a window naming none, or an unknown model,
 * applies to everything.
 */
export function windowAppliesToModel(window, model) {
  const wanted = String(model ?? '').toLowerCase();
  if (!wanted) return true;
  if (Array.isArray(window?.models) && window.models.length) {
    return window.models.some((name) => String(name).toLowerCase() === wanted);
  }
  const text = `${window?.id ?? ''} ${window?.label ?? ''} ${window?.shortLabel ?? ''}`.toLowerCase();
  const named = MODEL_FAMILY_TOKENS.filter((token) => text.includes(token));
  return !named.length || named.some((token) => wanted.includes(token));
}

/**
 * Max usedPct over the windows whose reset has not passed, or null when no
 * window carries a usable percent. A window whose resetsAt is in the past is
 * expired and its usedPct is stale, so it never counts; windows without a
 * reset stamp count (nothing proves them stale). Accounts without windows
 * fall back to the scalar maxUsedPct. An ordinary future resetsAt never marks
 * exhaustion by itself; only an explicit limit or the threshold does. With
 * `model`, only windows that apply to that model count (windowAppliesToModel).
 */
export function freshMaxUsedPct(account, now = Date.now(), model = null) {
  const windows = Array.isArray(account?.windows) ? account.windows.filter((window) => windowAppliesToModel(window, model)) : null;
  if (!windows || !account.windows.length) {
    return Number.isFinite(account?.maxUsedPct) ? account.maxUsedPct : null;
  }
  const pcts = [];
  for (const window of windows) {
    if (!Number.isFinite(window?.usedPct)) continue;
    const reset = Date.parse(window?.resetsAt ?? '');
    if (Number.isFinite(reset) && reset <= now) continue;
    pcts.push(window.usedPct);
  }
  return pcts.length ? Math.max(...pcts) : null;
}

/**
 * Account exhaustion with real percents: the status-based limit flag, a
 * future limitedUntil, or the fresh (non-expired) max usedPct at the
 * exhausted threshold.
 */
export function accountExhausted(account, { exhaustedPct = QUOTA_DEFAULTS.exhaustedPct, now = Date.now(), model = null } = {}) {
  if (!account || typeof account !== 'object') return false;
  if (account.exhausted === true) return true;
  const until = Date.parse(account.limitedUntil ?? '');
  if (Number.isFinite(until) && until > now) return true;
  const pct = freshMaxUsedPct(account, now, model);
  return pct !== null && pct >= exhaustedPct;
}

/** True when the family has accounts and every one of them is exhausted. */
export function familyExhausted(zerosub, family, opts = {}) {
  const accounts = familyAccounts(zerosub, family);
  return accounts.length > 0 && accounts.every((account) => accountExhausted(account, opts));
}

/** True when ZeroSub state has accounts and every one of them is exhausted. */
export function allAccountsExhausted(zerosub, opts = {}) {
  const accounts = zerosub?.accounts ?? [];
  return accounts.length > 0 && accounts.every((account) => accountExhausted(account, opts));
}

/** The normalized ZeroSub account an agent currently routes to, or null. */
export function accountForAgent(zerosub, agentId) {
  const accountId = typeof agentId === 'string' ? zerosub?.agentAccount?.[agentId] ?? null : null;
  if (!accountId) return null;
  return (zerosub?.accounts ?? []).find((account) => account?.id === accountId) ?? null;
}

/**
 * Non-exhausted account with the most room (lowest fresh maxUsedPct, unknown
 * last, ties by id), or null when the family has no usable account.
 */
export function bestFamilyAccount(zerosub, family, opts = {}) {
  const open = familyAccounts(zerosub, family).filter((account) => !accountExhausted(account, opts));
  if (!open.length) return null;
  const now = opts?.now ?? Date.now();
  const room = (account) => {
    const pct = freshMaxUsedPct(account, now, opts?.model ?? null);
    return pct !== null ? pct : Infinity;
  };
  return open.slice().sort((a, b) => room(a) - room(b) || String(a.id).localeCompare(String(b.id)))[0];
}

/** Earliest future resetsAt/limitedUntil across the given accounts, or null. */
export function earliestResetOf(accounts, { now = Date.now(), model = null } = {}) {
  let best = null;
  let bestMs = Infinity;
  for (const account of accounts ?? []) {
    const windows = (account?.windows ?? []).filter((window) => windowAppliesToModel(window, model));
    const stamps = [account?.limitedUntil, ...windows.map((window) => window?.resetsAt)];
    for (const stamp of stamps) {
      const ms = Date.parse(stamp ?? '');
      if (Number.isFinite(ms) && ms > now && ms < bestMs) {
        bestMs = ms;
        best = stamp;
      }
    }
  }
  return best;
}

/** Earliest future resetsAt/limitedUntil across ALL ZeroSub accounts, or null. */
export function earliestReset(zerosub, opts = {}) {
  return earliestResetOf(zerosub?.accounts ?? [], opts);
}

/** Earliest future resetsAt/limitedUntil across the family accounts, or null. */
export function earliestFamilyReset(zerosub, family, opts = {}) {
  return earliestResetOf(familyAccounts(zerosub, family), opts);
}

function entries(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return {};
  if (snapshot.pools && typeof snapshot.pools === 'object' && !Array.isArray(snapshot.pools)) return snapshot.pools;
  return snapshot;
}

export function quotaEntry(snapshot, pool) {
  const map = entries(snapshot);
  const value = Object.hasOwn(map, pool) ? map[pool] : null;
  if (value && typeof value === 'object') return value;
  return null;
}

export function quotaPct(entry) {
  const pct = Number(entry?.sessionPct ?? entry?.usedPct ?? NaN);
  return Number.isFinite(pct) ? pct : null;
}

export function quotaExhausted(snapshot, pool, threshold = QUOTA_DEFAULTS.exhaustedPct, now = Date.now()) {
  const entry = quotaEntry(snapshot, pool);
  if (!entry) return false;
  const pct = quotaPct(entry);
  if ((pct !== null && pct >= threshold) || (Number.isFinite(entry.weeklyPct) && entry.weeklyPct >= threshold)) return true;
  if (entry.exhausted === true) return true;
  const until = Date.parse(entry.limitUntil ?? entry.limitedUntil ?? '');
  return Number.isFinite(until) && until > now;
}

export function quotaPools(config, { includeAdvisors = true } = {}) {
  const pools = [];
  for (const [slot, name] of Object.entries(config?.steers?.slots ?? {})) {
    const profile = config?.profiles?.[name];
    if (!profile || (!includeAdvisors && profile.advisor === true)) continue;
    const pool = profilePool(profile);
    if (pool && !pools.includes(pool)) pools.push(pool);
  }
  return pools;
}

export function preferredQuotaPool(config, currentPool, snapshot = null) {
  const pools = quotaPools(config, { includeAdvisors: false }).filter((pool) => pool !== currentPool);
  if (!pools.length) return null;
  const available = pools.find((pool) => !quotaExhausted(snapshot, pool));
  return available ?? pools[0];
}

export function formatQuotaLine(config, snapshot, { agent = null, currentPool = null, warnPct = QUOTA_DEFAULTS.warnPct, zerosub = null, now = Date.now() } = {}) {
  if (!snapshot && !zerosub) return null;
  const pool = agent ? liveAgentPool(agent, config) : currentPool || quotaPools(config, { includeAdvisors: false })[0];
  if (!pool) return null;
  // During a move, ZeroSub reports the still-running account as pending.
  const accountId = agent?.id && (zerosub?.pending?.[agent.id] ?? zerosub?.agentAccount?.[agent.id]);
  if (accountId) {
    const family = profileFamily(agent);
    const account = familyAccounts(zerosub, family).find((entry) => entry.id === accountId);
    const model = agent.model ?? null;
    const pct = freshMaxUsedPct(account, now, model);
    if (pct === null || pct < warnPct) return null;
    const best = bestFamilyAccount(zerosub, family, { now, model, exhaustedPct: config?.quota?.exhaustedPct });
    const bestPct = freshMaxUsedPct(best, now, model);
    const preference = bestPct !== null && bestPct < pct ? ` — prefer ${best.id}` : '';
    return `Quota: ${pool} (${accountId}) ${pct}% used${preference}`;
  }
  if (!snapshot) return null;
  const entry = quotaEntry(snapshot, pool);
  const pct = quotaPct(entry);
  if (pct === null || pct < warnPct) return null;
  const next = preferredQuotaPool(config, pool, snapshot);
  return `Quota: ${pool} ${pct}% (5h) — prefer ${next ?? 'none'}`;
}

function findReport(record) {
  return record?.lastSuccessful?.report ?? record?.report ?? null;
}

function usageRecords(input) {
  let value = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input); } catch { return []; }
  }
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.sources)) return value.sources;
  return [];
}

function windowText(window) {
  return `${window?.id ?? ''} ${window?.label ?? ''} ${window?.shortLabel ?? ''}`;
}

function windowPctOf(window) {
  return quotaPct(window) ?? (window?.remainingPct != null && Number.isFinite(Number(window.remainingPct)) ? 100 - Number(window.remainingPct) : null);
}

/** Session and weekly windows of one usage report; missing stays undefined. */
function selectUsageWindows(report) {
  const windows = Array.isArray(report?.windows) ? report.windows : [];
  const fiveHours = /5[_\s-]*h|five[_\s-]*hour/i;
  const weekly = windows.find((window) => /week|7[_\s-]*d|seven[_\s-]*day/i.test(windowText(window)));
  const session = windows.find((window) => window !== weekly && (fiveHours.test(windowText(window)) || /session/i.test(windowText(window)))) ?? windows[0];
  const sessionWindow = session === weekly && session ? 'weekly' :
    fiveHours.test(windowText(session)) ? '5-hour' :
    /session/i.test(windowText(session)) ? 'session' : null;
  return { session, sessionWindow, weekly };
}

/** Pool key of one usage record (sourceId, else sourceLabel); '' when unknown. */
function usagePoolOf(record) {
  return typeof record?.sourceId === 'string' && record.sourceId.trim()
    ? record.sourceId.trim()
    : (typeof record?.sourceLabel === 'string' ? record.sourceLabel.trim() : '');
}

/**
 * Converts the JSON emitted by `paseo usage --json` to { [pool]: quota }.
 * Each source can emit one report per account. Omit a pool when multiple
 * reports share its key, including reports without usable metrics, because
 * the pool key alone cannot identify the relevant account.
 */
export function parseUsageJson(input) {
  const pools = new Map();
  for (const record of usageRecords(input)) {
    const pool = usagePoolOf(record);
    const report = findReport(record);
    if (!pool || !report || typeof report !== 'object') continue;
    if (pools.has(pool)) {
      pools.set(pool, null);
      continue;
    }
    const { session, sessionWindow, weekly } = selectUsageWindows(report);
    const pct = windowPctOf(session);
    const weeklyPct = windowPctOf(weekly);
    const cached = record.lastSuccessful?.report != null;
    const sampledAt = cached ? record.lastSuccessful.fetchedAt : record.fetchedAt;
    pools.set(pool, pct === null ? null : {
      sessionPct: pct,
      ...(sessionWindow ? { sessionWindow } : {}),
      ...(typeof sampledAt === 'string' ? { sampledAt } : cached ? { sampledAt: null } : {}),
      ...(session?.resetsAt ? { resetsAt: session.resetsAt } : {}),
      ...(weeklyPct !== null ? { weeklyPct } : {}),
      ...(weeklyPct !== null && weekly?.resetsAt ? { weeklyResetAt: weekly.resetsAt } : {}),
    });
  }
  return Object.fromEntries([...pools].filter(([, entry]) => entry !== null));
}

export const parseUsageSnapshot = parseUsageJson;
