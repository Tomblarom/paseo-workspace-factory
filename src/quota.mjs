/** Quota pools and the deliberately lenient `paseo usage --json` adapter. */

export const QUOTA_DEFAULTS = { warnPct: 75, exhaustedPct: 90 };
export const PROFILE_UNHEALTHY_MINUTES = 10;

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

export function profilePool(profile) {
  return typeof profile?.pool === 'string' && profile.pool.trim()
    ? profile.pool.trim()
    : (typeof profile?.provider === 'string' ? profile.provider : '');
}

function entries(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return {};
  if (snapshot.pools && typeof snapshot.pools === 'object' && !Array.isArray(snapshot.pools)) return snapshot.pools;
  return snapshot;
}

export function quotaEntry(snapshot, pool) {
  const map = entries(snapshot);
  const value = map[pool];
  if (value && typeof value === 'object') return value;
  return null;
}

export function quotaPct(entry) {
  const pct = Number(entry?.sessionPct ?? entry?.usedPct);
  return Number.isFinite(pct) ? pct : null;
}

export function quotaExhausted(snapshot, pool, threshold = QUOTA_DEFAULTS.exhaustedPct, now = Date.now()) {
  const entry = quotaEntry(snapshot, pool);
  if (!entry) return false;
  const pct = quotaPct(entry);
  if (pct !== null && pct >= threshold) return true;
  const until = Date.parse(entry.limitUntil ?? entry.resetsAt ?? '');
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

export function formatQuotaLine(config, snapshot, { currentPool = null, warnPct = QUOTA_DEFAULTS.warnPct } = {}) {
  if (!snapshot) return null;
  const pool = currentPool || quotaPools(config, { includeAdvisors: false })[0];
  const entry = quotaEntry(snapshot, pool);
  const pct = quotaPct(entry);
  if (!pool || pct === null || pct < warnPct) return null;
  const next = preferredQuotaPool(config, pool, snapshot);
  return `Quota: ${pool} ${pct}% (5h) — prefer ${next ?? 'none'}`;
}

function findReport(record) {
  return record?.lastSuccessful?.report ?? record?.report ?? null;
}

/**
 * Converts the JSON emitted by `paseo usage --json` to { [pool]: quota }.
 * Provider/source names are intentionally treated as opaque; malformed records
 * are skipped rather than making usage sampling fatal.
 */
export function parseUsageJson(input) {
  let value = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input); } catch { return {}; }
  }
  const records = Array.isArray(value) ? value : Array.isArray(value?.sources) ? value.sources : [];
  const snapshot = {};
  for (const record of records) {
    const report = findReport(record);
    const windows = Array.isArray(report?.windows) ? report.windows : [];
    const session = windows.find((window) => {
      const text = `${window?.id ?? ''} ${window?.label ?? ''} ${window?.shortLabel ?? ''}`.toLowerCase();
      return text.includes('5h') || text.includes('5 h') || text.includes('session');
    }) ?? windows[0];
    const pct = quotaPct(session) ?? (Number.isFinite(Number(session?.remainingPct)) ? 100 - Number(session.remainingPct) : null);
    const pool = typeof record?.sourceId === 'string' && record.sourceId.trim()
      ? record.sourceId.trim()
      : (typeof record?.sourceLabel === 'string' ? record.sourceLabel.trim() : '');
    if (!pool || pct === null) continue;
    snapshot[pool] = { sessionPct: pct, ...(session?.resetsAt ? { limitUntil: session.resetsAt } : {}) };
  }
  return snapshot;
}

export const parseUsageSnapshot = parseUsageJson;
