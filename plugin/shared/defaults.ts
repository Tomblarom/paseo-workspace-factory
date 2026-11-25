// @ts-nocheck
// GENERATED from src/defaults.mjs by npm run plugin:sync. Do not edit.
// Factory-wide default facts shared with the plugin client.
//
// Pure module: zero imports, no node APIs, no Date.now() defaults in exported
// signatures except an explicit opt-in. It is the single source for the quota
// thresholds (documented: warn 75, exhausted 95), the quota sampling cadence
// and staleness rule, the drain-marker predicate, and the built-in
// catalog-exceptions table. src/*.mjs import it directly; the plugin client
// cannot reach src/, so `npm run plugin:sync` mirrors this file to
// plugin/shared/defaults.ts (generated, do not edit there).
//
// Anything here must stay serializable and browser-safe: no RegExp literals
// (patterns are strings, compiled at use), no process/env access.

/** Quota thresholds (percents). Documented in docs/configuration.md. */
export const QUOTA_DEFAULTS = { warnPct: 75, exhaustedPct: 95 };

/** Default quota sampling cadence in minutes (also the enforced floor). */
export const QUOTA_SAMPLE_MINUTES = 10;

/**
 * True when a quota/usage sample is too old to judge exhaustion.
 * Percentage data is stale after two sampling intervals; a missing or
 * unparsable read time is stale (never fresh by default).
 */
export function isQuotaSampleStale(sampledAtMs, nowMs, sampleMinutes = QUOTA_SAMPLE_MINUTES) {
  const minutes = Number.isFinite(sampleMinutes) && sampleMinutes > 0 ? sampleMinutes : QUOTA_SAMPLE_MINUTES;
  if (sampledAtMs === null || sampledAtMs === undefined || !Number.isFinite(sampledAtMs)) return true;
  if (!Number.isFinite(nowMs)) return true;
  return nowMs - sampledAtMs > 2 * minutes * 60_000;
}

/** Markers past timeoutAt + this grace are ignored (a crashed drain self-expires). */
export const DRAIN_GRACE_MS = 60_000;

/**
 * True while the marker claims a live drain (now <= timeoutAt + 1 min).
 * Malformed or expired markers are ignored (no quiet), so a crashed drain
 * self-expires. Accepts epoch millis (or an ISO string) as now.
 */
export function isDrainMarkerActive(marker, nowMs = Date.now()) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
  const timeoutMs = typeof marker.timeoutAt === 'string' ? Date.parse(marker.timeoutAt) : NaN;
  if (!Number.isFinite(timeoutMs)) return false;
  const now = typeof nowMs === 'string' ? Date.parse(nowMs) : nowMs;
  if (!Number.isFinite(now)) return false;
  return now <= timeoutMs + DRAIN_GRACE_MS;
}

/**
 * Settings the catalog advertises but a provider rejects when an agent is created.
 * Observed 2026-11-23: copilot/claude-sonnet-5.5 lists thinking options, yet
 * creation fails with "setReasoningEffort ... not supported".
 * Serializable shape (modelPattern is a string): both the CLI validator and
 * the plugin settings UI match against it.
 */
export const KNOWN_UNSUPPORTED = [
  { provider: 'copilot', modelPattern: '^claude-', field: 'thinking', reason: 'Copilot rejects a reasoning effort for Claude models; use thinking: null' },
];

/**
 * Reason the profile hits a built-in catalog exception, or null when it does
 * not. Only a set (truthy) field value can hit: a null thinking/mode is the
 * documented workaround, not a violation.
 */
export function knownUnsupportedReason(profile) {
  if (!profile || typeof profile !== 'object') return null;
  for (const rule of KNOWN_UNSUPPORTED) {
    if (rule.provider !== profile.provider || !profile[rule.field]) continue;
    let matches = false;
    try {
      matches = new RegExp(rule.modelPattern).test(profile.model ?? '');
    } catch {
      continue;
    }
    if (matches) return rule.reason;
  }
  return null;
}
