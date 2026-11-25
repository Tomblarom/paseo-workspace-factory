// Steer-state projection for the Factory composer pill (docs/design/steer-menu.md,
// step 1). Pure module: it imports only the sibling cache reference (plus one
// erased type), so plain node:test can use it. The server feed
// (server/steer-feed.ts) assembles the input from live state; the pill and
// menu actions (steps 2-5) are not built here.
//
// Reuse map: cache groups and the profile floor come from cache-profiles.ts;
// the needsResume reason union mirrors idle-cleanup.ts (validated by the feed
// with isNeedsResumeReason); freshHint arrives already validated for the
// current idle period (the feed uses currentFreshHint); quota thresholds
// mirror QUOTA_DEFAULTS in src/quota.mjs (the feed passes the effective
// config values). All UI text is English.
import {
  effectiveMinContextTokens,
  groupForProviderModel,
  isCleanupProfile,
  type CacheGroup,
  type CleanupProfile,
} from "./cache-profiles.js";
import type { NeedsResumeReason } from "./idle-cleanup.js";

/** Face states in priority order (highest first); Unknown is the fallback. */
export const STEER_STATES = [
  "retired",
  "running",
  "limited",
  "waiting",
  "needs-resume",
  "ready",
  "cold",
  "large",
  "cooling",
  "warm",
  "unknown",
] as const;

export type SteerFaceState = (typeof STEER_STATES)[number];

/** Collapsed-face labels (the pill adds the slot prefix, e.g. "A · Warm"). */
export const STEER_STATE_LABELS: Record<SteerFaceState, string> = {
  retired: "Retired",
  running: "Running",
  limited: "Limited",
  waiting: "Waiting",
  "needs-resume": "Needs resume",
  ready: "Ready",
  cold: "Cold",
  large: "Large",
  cooling: "Cooling",
  warm: "Warm",
  unknown: "Unknown",
};

/** Primary-action keys, one per state-table row (menu wiring is step 3). */
export type SteerPrimaryAction =
  | "open-holder"
  | "view-turn"
  | "handoff-or-reset"
  | "view-operation"
  | "preview-recovery"
  | "focus-or-deliver"
  | "preview-refresh"
  | "focus-reuse"
  | "continue"
  | "focus"
  | "reload-or-open";

/** Quota defaults; mirrors QUOTA_DEFAULTS in src/quota.mjs. */
export const STEER_QUOTA_WARN_PCT = 75;
export const STEER_QUOTA_EXHAUSTED_PCT = 90;

/** Default quota sampling cadence in minutes (supervision settings floor). */
export const STEER_QUOTA_SAMPLE_MINUTES = 10;

/** Fallback context floor; mirrors CLEANUP_DEFAULTS in idle-cleanup.ts. */
export const STEER_MIN_CONTEXT_TOKENS = 60_000;

function stampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

// ---------------------------------------------------------------------------
// Cache TTL and warmth
// ---------------------------------------------------------------------------

/**
 * Confirmed Claude billing route. "subscription" is the Factory subscription
 * baseline (or a confirmed 1h path); "api-5m" is a known 5-minute path
 * (including default Anthropic API caching); "unknown" keeps the conservative
 * 5-minute estimate and flags the header.
 */
export type ClaudeBilling = "subscription" | "api-5m" | "unknown";

export interface CacheTtl {
  ttlMinutes: number;
  group: CacheGroup;
  /** True only for Claude on an unconfirmed route (show "Billing path unconfirmed"). */
  billingUnconfirmed: boolean;
}

/**
 * Estimated prompt-cache TTL for the pill, per the design's route table.
 * The group follows groupForProviderModel, including unversioned model ids
 * from an identified Codex/OpenAI provider.
 */
export function resolveCacheTtl(args: {
  provider: unknown;
  model: unknown;
  claudeBilling?: ClaudeBilling;
  openaiExtendedRetention?: boolean;
}): CacheTtl {
  const group = groupForProviderModel(args.provider, args.model);
  if (group === "claude") {
    if (args.claudeBilling === "subscription") return { ttlMinutes: 60, group, billingUnconfirmed: false };
    if (args.claudeBilling === "api-5m") return { ttlMinutes: 5, group, billingUnconfirmed: false };
    return { ttlMinutes: 5, group, billingUnconfirmed: true };
  }
  if (group === "openai-new") return { ttlMinutes: 30, group, billingUnconfirmed: false };
  if (group === "openai-old") {
    return {
      ttlMinutes: args.openaiExtendedRetention === true ? 30 : 10,
      group,
      billingUnconfirmed: false,
    };
  }
  return { ttlMinutes: 30, group, billingUnconfirmed: false };
}

/** Cooling-window width in minutes: max(1, min(10, round(TTL / 6))). */
export function coolingMinutesForTtl(ttlMinutes: number): number {
  return Math.max(1, Math.min(10, Math.round(ttlMinutes / 6)));
}

/**
 * Cache age in ms. A confirmed cache request start (Claude measures its TTL
 * from request start) wins over the turn end; missing or future stamps are
 * unknown (null). The caller passes a start only once request evidence is
 * available; until then the turn end overestimates warmth.
 */
export function cacheAgeMs(args: {
  nowMs: number;
  lastTurnEndedAt: unknown;
  cacheStartAt?: unknown;
}): number | null {
  const start = args.cacheStartAt === undefined || args.cacheStartAt === null ? null : stampMs(args.cacheStartAt);
  if (start !== null) return start > args.nowMs ? null : args.nowMs - start;
  const end = stampMs(args.lastTurnEndedAt);
  if (end === null || end > args.nowMs) return null;
  return args.nowMs - end;
}

export type CacheWarmth = "warm" | "cooling" | "cold" | "unknown";

export interface WarmthResult {
  warmth: CacheWarmth;
  /** "ttl" states are estimates (header); "prefix-break" cold is a known break. */
  source: "ttl" | "prefix-break" | "none";
  /** Epoch ms of the next TTL boundary (cooling start / TTL end), else null. */
  boundaryAtMs: number | null;
}

/**
 * Warmth from a valid age and matching baseline: warm is [0, TTL - cooling),
 * cooling is [TTL - cooling, TTL), cold starts at TTL. A known prefix break
 * with retained history is cold for the new configuration. Missing or future
 * ages, a missing baseline, or an unsupported route yield unknown.
 */
export function resolveWarmth(args: {
  nowMs: number;
  ageMs: number | null;
  ttlMinutes: number;
  baselineValid: boolean;
  supported?: boolean;
  prefixBreakRetained?: boolean;
}): WarmthResult {
  if (args.prefixBreakRetained === true) return { warmth: "cold", source: "prefix-break", boundaryAtMs: null };
  const age = args.ageMs;
  if (
    args.supported === false ||
    args.baselineValid !== true ||
    age === null ||
    !Number.isFinite(age) ||
    age < 0 ||
    !Number.isFinite(args.ttlMinutes) ||
    args.ttlMinutes <= 0
  ) {
    return { warmth: "unknown", source: "none", boundaryAtMs: null };
  }
  const ttlMs = args.ttlMinutes * 60_000;
  const coolingMs = coolingMinutesForTtl(args.ttlMinutes) * 60_000;
  if (age < ttlMs - coolingMs) {
    return { warmth: "warm", source: "ttl", boundaryAtMs: args.nowMs + (ttlMs - coolingMs - age) };
  }
  if (age < ttlMs) {
    return { warmth: "cooling", source: "ttl", boundaryAtMs: args.nowMs + (ttlMs - age) };
  }
  return { warmth: "cold", source: "ttl", boundaryAtMs: null };
}

// ---------------------------------------------------------------------------
// Context size
// ---------------------------------------------------------------------------

/**
 * Context size in tokens: the live agent's finite, nonnegative
 * usage.usedTokens, then the last stored contextTokens for the same
 * session/generation. Missing stays unknown (null).
 */
export function resolveContextTokens(args: {
  liveUsedTokens: unknown;
  storedTokens: unknown;
  storedSameSession?: boolean;
}): number | null {
  const live = finiteNumber(args.liveUsedTokens);
  if (live !== null && live >= 0) return live;
  const stored = finiteNumber(args.storedTokens);
  if (args.storedSameSession === true && stored !== null && stored >= 0) return stored;
  return null;
}

/** Large means tokens >= effectiveMinContextTokens(profile, min). */
export function isLargeContext(
  tokens: number | null,
  profile: unknown,
  configuredMin: number,
): boolean {
  if (tokens === null || tokens === undefined) return false;
  const clean: CleanupProfile = isCleanupProfile(profile) ? profile : "balanced";
  const floor =
    Number.isFinite(configuredMin) && configuredMin > 0 ? configuredMin : STEER_MIN_CONTEXT_TOKENS;
  return tokens >= effectiveMinContextTokens(clean, floor);
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

export type ZerosubWaiting = "idle" | "turn" | "background" | "restart";

const ZEROSUB_WAITING: ReadonlySet<string> = new Set(["idle", "turn", "background", "restart"]);

/** Statuses that mark an account unavailable with that reason (never Limited). */
const UNAVAILABLE_ACCOUNT_STATUSES: ReadonlySet<string> = new Set(["signedout", "disabled"]);

/** Explicit ZeroSub state versions the projection understands (missing = v1). */
const SUPPORTED_ZEROSUB_VERSIONS: ReadonlySet<string> = new Set(["1", "v1"]);

export interface SteerZerosubWindow {
  id: string;
  usedPct: number | null;
  resetsAt: string | null;
  /** Model restriction when present; absent means a whole-account window. */
  models?: string[];
}

export interface SteerZerosubAccount {
  id: string;
  status?: string;
  limitedUntil?: string | null;
  windows?: SteerZerosubWindow[];
  maxUsedPct?: number | null;
  exhausted?: boolean;
}

export interface SteerZerosubState {
  version?: unknown;
  accounts?: SteerZerosubAccount[];
  agentAccount?: Record<string, string>;
  pending?: Record<string, string>;
  waiting?: Record<string, string>;
}

export interface SteerPoolEntry {
  sessionPct?: unknown;
  usedPct?: unknown;
  weeklyPct?: unknown;
  resetsAt?: unknown;
  limitUntil?: unknown;
}

/** True for a supported (or missing = v1) ZeroSub state version. */
export function zerosubSupported(zerosub: SteerZerosubState | null | undefined): boolean {
  if (!zerosub || typeof zerosub !== "object") return false;
  const version = (zerosub as { version?: unknown }).version;
  if (version === null || version === undefined) return true;
  if (typeof version === "number") return version === 1;
  return typeof version === "string" && SUPPORTED_ZEROSUB_VERSIONS.has(version.trim().toLowerCase());
}

function waitingOf(zerosub: SteerZerosubState, agentId: string): ZerosubWaiting | null {
  const raw = zerosub.waiting?.[agentId];
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return ZEROSUB_WAITING.has(value) ? (value as ZerosubWaiting) : null;
}

/** Best-effort model-window match until the upstream shape is pinned. */
function windowGovernsModel(window: SteerZerosubWindow, model: string | null): boolean {
  const models = Array.isArray(window.models)
    ? window.models.filter((name): name is string => typeof name === "string" && name.trim() !== "")
    : [];
  if (!models.length) return true;
  const live = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (!live) return false;
  return models.some((name) => {
    const want = name.trim().toLowerCase();
    return want !== "" && (live === want || live.includes(want));
  });
}

function unavailableAccountReason(status: unknown): string | null {
  if (typeof status !== "string") return null;
  const flat = status.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!UNAVAILABLE_ACCOUNT_STATUSES.has(flat)) return null;
  return flat === "disabled" ? "Account disabled" : "Account signed out";
}

function entryPct(entry: SteerPoolEntry | null | undefined): number | null {
  const pct = finiteNumber(entry?.sessionPct ?? entry?.usedPct);
  return pct;
}

export interface QuotaBlocker {
  label: string;
  resetsAt: string | null;
}

export interface QuotaRow {
  id: string;
  scope: "account" | "model" | "pool";
  usedPct: number | null;
  resetsAt: string | null;
  stale: boolean;
}

export interface QuotaInput {
  nowMs: number;
  agentId: string;
  /** Live model id for model-window matching. */
  model?: string | null;
  zerosub?: SteerZerosubState | null;
  /** Read time of the ZeroSub state; a live read defaults to nowMs (fresh). */
  zerosubSampledAtMs?: number | null;
  /** Effective live provider/model pool for the usage-snapshot fallback. */
  pool?: string | null;
  quotaSnapshot?: Record<string, SteerPoolEntry> | null;
  poolSampledAtMs?: number | null;
  quotaSampleMinutes?: number;
  warnPct?: number;
  exhaustedPct?: number;
  needsResumeReason?: NeedsResumeReason | null;
  needsResumeAt?: string | null;
  /** Explicitly recovered limit flag (recovery still needs handling). */
  limitRecovered?: boolean;
}

export interface QuotaResult {
  source: "account" | "pool" | "none";
  /** Live route: pendingAccountId wins (it is the current session). */
  accountId: string | null;
  /** Move destination while a move is pending, else null. */
  destinationAccountId: string | null;
  waiting: ZerosubWaiting | null;
  pendingMove: boolean;
  limited: boolean;
  limitedReasons: string[];
  blockers: QuotaBlocker[];
  /** Single timer: the latest known blocking reset, else null. */
  resetAt: string | null;
  /** True when limited and any blocker has no known reset time. */
  resetUnknown: boolean;
  /** Percentage data exists but none of it is fresh ("Awaiting quota update"). */
  awaitingUpdate: boolean;
  unavailableReason: string | null;
  /** A past reset or newer usable evidence retired the limit inference. */
  limitRetired: boolean;
  rows: QuotaRow[];
}

/**
 * Per-steer quota decision. Prefers a supported ZeroSub state version and the
 * matching live route (pendingAccountId = current session, accountId = its
 * destination), else falls back to the effective live provider/model pool in
 * the cached usage sample. Percentage data is stale after two source
 * sampling intervals, or as soon as a reported window resets without a fresh
 * reading for that window. Whole-account windows apply to every steer;
 * model-only windows only when they govern the selected model. A normal
 * resetsAt on a usable account never creates a hold by itself.
 */
export function resolveQuota(input: QuotaInput): QuotaResult {
  const nowMs = input.nowMs;
  const minutes =
    Number.isFinite(input.quotaSampleMinutes) && (input.quotaSampleMinutes as number) > 0
      ? (input.quotaSampleMinutes as number)
      : STEER_QUOTA_SAMPLE_MINUTES;
  const staleAfterMs = 2 * minutes * 60_000;
  const exhaustedPct =
    Number.isFinite(input.exhaustedPct) ? (input.exhaustedPct as number) : STEER_QUOTA_EXHAUSTED_PCT;
  const empty: QuotaResult = {
    source: "none",
    accountId: null,
    destinationAccountId: null,
    waiting: null,
    pendingMove: false,
    limited: false,
    limitedReasons: [],
    blockers: [],
    resetAt: null,
    resetUnknown: false,
    awaitingUpdate: false,
    unavailableReason: null,
    limitRetired: false,
    rows: [],
  };
  const isStale = (sampledAtMs: number | null | undefined): boolean => {
    if (sampledAtMs === null || sampledAtMs === undefined || !Number.isFinite(sampledAtMs)) return true;
    return nowMs - (sampledAtMs as number) > staleAfterMs;
  };
  /** A reported window whose reset passed without a fresh reading is expired. */
  const windowExpired = (resetsAt: unknown, sampledAtMs: number | null | undefined): boolean => {
    const reset = stampMs(resetsAt);
    if (reset === null || reset > nowMs) return false;
    return sampledAtMs === null || sampledAtMs === undefined || !Number.isFinite(sampledAtMs)
      ? true
      : (sampledAtMs as number) < reset;
  };
  const finish = (result: QuotaResult): QuotaResult => {
    if (result.limited) {
      let latest: number | null = null;
      let missing = false;
      for (const blocker of result.blockers) {
        const ms = stampMs(blocker.resetsAt);
        if (ms === null) {
          missing = true;
        } else if (latest === null || ms > latest) {
          latest = ms;
        }
      }
      result.resetUnknown = missing;
      result.resetAt = latest === null ? null : new Date(latest).toISOString();
    }
    return result;
  };
  /** A past reset (after the failure) or newer usable evidence retires it. */
  const retiredByEvidence = (resets: readonly unknown[], worstFreshPct: number | null): boolean => {
    if (input.needsResumeReason !== "limit") return false;
    if (worstFreshPct !== null && worstFreshPct < exhaustedPct) return true;
    const failedAt = stampMs(input.needsResumeAt);
    if (failedAt === null) return false;
    return resets.some((reset) => {
      const ms = stampMs(reset);
      return ms !== null && ms > failedAt && ms <= nowMs;
    });
  };

  const zerosub = input.zerosub ?? null;
  if (zerosubSupported(zerosub)) {
    const state = zerosub as SteerZerosubState;
    const pendingId =
      typeof input.agentId === "string" && input.agentId
        ? (state.pending?.[input.agentId] ?? null)
        : null;
    const routeId =
      typeof input.agentId === "string" && input.agentId
        ? (state.agentAccount?.[input.agentId] ?? null)
        : null;
    const liveId = typeof pendingId === "string" && pendingId ? pendingId : routeId;
    const waiting = waitingOf(state, input.agentId);
    if (typeof liveId === "string" && liveId) {
      const account = (state.accounts ?? []).find((entry) => entry?.id === liveId) ?? null;
      if (account) {
        const sampledAt = input.zerosubSampledAtMs === undefined ? nowMs : input.zerosubSampledAtMs;
        const stale = isStale(sampledAt);
        const unavailable = unavailableAccountReason(account.status);
        const base: QuotaResult = {
          ...empty,
          source: "account",
          accountId: liveId,
          destinationAccountId: pendingId && routeId && pendingId !== routeId ? routeId : null,
          waiting,
          pendingMove: typeof pendingId === "string" && !!pendingId,
        };
        if (unavailable) return finish({ ...base, unavailableReason: unavailable });
        const model = typeof input.model === "string" ? input.model : null;
        const windows = Array.isArray(account.windows) ? account.windows : [];
        const applicable = windows.filter(
          (window): window is SteerZerosubWindow =>
            !!window && typeof window === "object" && typeof window.id === "string" && !!window.id,
        );
        const rows: QuotaRow[] = [];
        let worst: number | null = null;
        let hasPct = Number.isFinite(account.maxUsedPct);
        const resets: unknown[] = [];
        for (const window of applicable) {
          if (!windowGovernsModel(window, model)) continue;
          const expired = windowExpired(window.resetsAt, sampledAt);
          const usable = !stale && !expired && Number.isFinite(window.usedPct);
          if (Number.isFinite(window.usedPct)) hasPct = true;
          if (window.resetsAt) resets.push(window.resetsAt);
          const restricted =
            Array.isArray(window.models) && window.models.some((name) => typeof name === "string" && name.trim() !== "");
          rows.push({
            id: window.id,
            scope: restricted ? "model" : "account",
            usedPct: usable ? (window.usedPct as number) : null,
            resetsAt: typeof window.resetsAt === "string" ? window.resetsAt : null,
            stale: !usable,
          });
          if (usable && (worst === null || (window.usedPct as number) > worst)) {
            worst = window.usedPct as number;
          }
        }
        // Legacy aggregate only when no window carries its own percent.
        if (worst === null && !rows.length && Number.isFinite(account.maxUsedPct) && !stale) {
          worst = account.maxUsedPct as number;
        }
        const limitedUntilMs = stampMs(account.limitedUntil);
        const holdFuture = limitedUntilMs !== null && limitedUntilMs > nowMs;
        const statusLimited = account.exhausted === true && !holdFuture;
        const limitRetired = retiredByEvidence(resets, worst);
        const flagUnrecovered =
          input.needsResumeReason === "limit" && input.limitRecovered !== true && !limitRetired;
        const thresholdHit = worst !== null && worst >= exhaustedPct;
        const limited = (!stale && statusLimited) || holdFuture || flagUnrecovered || thresholdHit;
        const limitedReasons: string[] = [];
        const blockers: QuotaBlocker[] = [];
        if (!stale && statusLimited) {
          limitedReasons.push(`Explicit limit status (${account.status})`);
          blockers.push({ label: "Limit status", resetsAt: null });
        }
        if (holdFuture) {
          limitedReasons.push(`Limited until ${account.limitedUntil}`);
          blockers.push({ label: "Limited until", resetsAt: account.limitedUntil as string });
        }
        if (flagUnrecovered) {
          limitedReasons.push("Provider limit flagged");
          blockers.push({ label: "Provider limit flagged", resetsAt: null });
        }
        if (thresholdHit) {
          limitedReasons.push("Factory quota threshold");
          for (const row of rows) {
            if (!row.stale && row.usedPct !== null && row.usedPct >= exhaustedPct) {
              blockers.push({ label: row.id, resetsAt: row.resetsAt });
            }
          }
          if (!blockers.some((blocker) => blocker.label !== "Limit status" && blocker.label !== "Provider limit flagged" && blocker.label !== "Limited until")) {
            blockers.push({ label: "Quota threshold", resetsAt: null });
          }
        }
        return finish({
          ...base,
          limited,
          limitedReasons,
          blockers,
          awaitingUpdate: hasPct && worst === null && !holdFuture,
          limitRetired,
          rows,
        });
      }
    }
    // Supported ZeroSub state without a matching account route still carries
    // the pending/waiting signals for the Waiting face.
    if ((state.pending?.[input.agentId] ?? state.agentAccount?.[input.agentId]) !== undefined) {
      empty.accountId = typeof liveId === "string" ? liveId : null;
      empty.destinationAccountId =
        pendingId && routeId && pendingId !== routeId ? (routeId as string) : null;
      empty.waiting = waiting;
      empty.pendingMove = typeof pendingId === "string" && !!pendingId;
    }
  }

  // Pool fallback: the effective live provider/model pool in the cached
  // usage sample. An explicit future limitUntil holds; threshold percents
  // need a fresh sample; an ordinary resetsAt never holds by itself.
  const pool = typeof input.pool === "string" && input.pool ? input.pool : null;
  const entry = pool ? (input.quotaSnapshot?.[pool] ?? null) : null;
  if (pool && entry && typeof entry === "object") {
    const stale = isStale(input.poolSampledAtMs);
    const session = entryPct(entry);
    const weekly = finiteNumber(entry.weeklyPct);
    const resetsAt = typeof entry.resetsAt === "string" ? entry.resetsAt : null;
    const limitUntil = typeof entry.limitUntil === "string" ? entry.limitUntil : null;
    const sessionUsable = !stale && !windowExpired(resetsAt, input.poolSampledAtMs) && session !== null;
    const weeklyUsable = !stale && weekly !== null;
    const worst = Math.max(sessionUsable ? (session as number) : -1, weeklyUsable ? (weekly as number) : -1);
    const worstFresh = worst >= 0 ? worst : null;
    const holdMs = stampMs(limitUntil);
    const holdFuture = holdMs !== null && holdMs > nowMs;
    const limitRetired = retiredByEvidence(resetsAt ? [resetsAt] : [], worstFresh);
    const flagUnrecovered =
      input.needsResumeReason === "limit" && input.limitRecovered !== true && !limitRetired;
    const thresholdHit = worstFresh !== null && worstFresh >= exhaustedPct;
    const limited = holdFuture || flagUnrecovered || thresholdHit;
    const limitedReasons: string[] = [];
    const blockers: QuotaBlocker[] = [];
    if (holdFuture) {
      limitedReasons.push(`Limited until ${limitUntil}`);
      blockers.push({ label: "Limited until", resetsAt: limitUntil });
    }
    if (flagUnrecovered) {
      limitedReasons.push("Provider limit flagged");
      blockers.push({ label: "Provider limit flagged", resetsAt: null });
    }
    if (thresholdHit) {
      limitedReasons.push("Factory quota threshold");
      if (sessionUsable && (session as number) >= exhaustedPct) {
        blockers.push({ label: "session", resetsAt: resetsAt });
      }
      if (weeklyUsable && (weekly as number) >= exhaustedPct) {
        blockers.push({ label: "weekly", resetsAt: null });
      }
    }
    return finish({
      ...empty,
      source: "pool",
      limited,
      limitedReasons,
      blockers,
      awaitingUpdate: (session !== null || weekly !== null) && worstFresh === null && !holdFuture,
      limitRetired,
      rows: [
        {
          id: "session",
          scope: "pool",
          usedPct: sessionUsable ? (session as number) : null,
          resetsAt,
          stale: !sessionUsable,
        },
        ...(weekly !== null
          ? [{ id: "weekly", scope: "pool" as const, usedPct: weeklyUsable ? (weekly as number) : null, resetsAt: null, stale: !weeklyUsable }]
          : []),
      ],
    });
  }

  // No quota data: only an unrecovered limit flag can still limit.
  if (input.needsResumeReason === "limit" && input.limitRecovered !== true) {
    return finish({
      ...empty,
      limited: true,
      limitedReasons: ["Provider limit flagged"],
      blockers: [{ label: "Provider limit flagged", resetsAt: null }],
    });
  }
  return finish(empty);
}

// ---------------------------------------------------------------------------
// Face priority
// ---------------------------------------------------------------------------

export type SteerMembership = "resolved" | "ambiguous" | "unknown";

export interface SteerProjectionInput {
  nowMs: number;
  agentId: string;
  /** False renders Unknown (transient disconnect keeps the last verified push). */
  connected?: boolean;
  membership?: SteerMembership;
  scopeRetired?: boolean;
  /** The tab is the scope's recorded replaced holder. */
  replacedHolder?: boolean;
  /** Discovery marks this tab superseded by the unique current holder. */
  superseded?: boolean;
  liveStatus?: string | null;
  /** Current-generation open turn: not ended, not marked interrupted. */
  openTurn?: boolean;
  permissionNeeded?: boolean;
  provider?: string | null;
  model?: string | null;
  lastTurnEndedAt?: string | null;
  /** Newest confirmed cache request start (Claude); wins over the turn end. */
  cacheStartAt?: string | null;
  /** Usable, matching session/config baseline for the cache age. */
  baselineValid?: boolean;
  /** Known prefix break (model/config change) with retained history. */
  prefixBreakRetained?: boolean;
  claudeBilling?: ClaudeBilling;
  openaiExtendedRetention?: boolean;
  /** "Other" providers stay Unknown unless their route/baseline is supported. */
  otherRouteSupported?: boolean;
  liveUsedTokens?: unknown;
  storedTokens?: unknown;
  storedSameSession?: boolean;
  cleanupProfile?: unknown;
  minContextTokens?: number;
  /** Stored recommendation valid for the current idle period, else null. */
  freshHint?: string | null;
  /** Unresolved Factory operation on this holder. */
  resumeFallback?: string | null;
  pendingOperation?: boolean;
  /** Queued wake addressed to this holder. */
  queuedWake?: boolean;
  /** Proven history-free current session. */
  historyFree?: boolean;
  /** Verified context reset, first brief still to stage, no active operation. */
  resetAwaitingBrief?: boolean;
  needsResume?: NeedsResumeReason | null;
  needsResumeAt?: string | null;
  limitRecovered?: boolean;
  /** Current-generation interrupted record without verified recovery. */
  interruptedUnrecovered?: boolean;
  zerosub?: SteerZerosubState | null;
  zerosubSampledAtMs?: number | null;
  pool?: string | null;
  quotaSnapshot?: Record<string, SteerPoolEntry> | null;
  poolSampledAtMs?: number | null;
  quotaSampleMinutes?: number;
  warnPct?: number;
  exhaustedPct?: number;
}

export interface SteerProjection {
  state: SteerFaceState;
  label: string;
  warmth: CacheWarmth;
  warmthSource: "ttl" | "prefix-break" | "none";
  ttlMinutes: number;
  cacheGroup: CacheGroup;
  billingUnconfirmed: boolean;
  ageMs: number | null;
  tokens: number | null;
  large: boolean;
  freshHint: string | null;
  quota: QuotaResult;
  /** Lower-priority facts for the expanded header. */
  headerFacts: string[];
  primaryAction: SteerPrimaryAction;
  /** Running turn with a pending interaction: label it "Review request". */
  reviewRequest: boolean;
  /** Waiting on a ZeroSub move that needs a session restart. */
  restartAction: boolean;
  /** Needs-resume with a large, cold or uncertain context: compact brief. */
  compactBrief: boolean;
  /** Cold: preview a refresh (else focus the composer with a reuse estimate). */
  refreshPreview: boolean;
  /** Next local state boundary (cache boundary or known reset), else null. */
  nextBoundaryAt: string | null;
  /** One-line English reason for the state. */
  detail: string;
}

/** Short countdown: "45m", "1h 12m", "2d 3h". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * One steer tab's face state. For a connected host with resolved membership
 * the first matching state-table row wins; otherwise the face is Unknown.
 * Lower-priority facts (large context, pending reset, warmth expiry,
 * estimates) stay in headerFacts.
 */
export function projectSteer(input: SteerProjectionInput): SteerProjection {
  const nowMs = input.nowMs;
  const ttl = resolveCacheTtl({
    provider: input.provider ?? null,
    model: input.model ?? null,
    claudeBilling: input.claudeBilling ?? "unknown",
    openaiExtendedRetention: input.openaiExtendedRetention === true,
  });
  const group = ttl.group;
  const supported = group === "other" ? input.otherRouteSupported === true : true;
  const ageMs = cacheAgeMs({
    nowMs,
    lastTurnEndedAt: input.lastTurnEndedAt ?? null,
    cacheStartAt: input.cacheStartAt ?? null,
  });
  const warmth = resolveWarmth({
    nowMs,
    ageMs,
    ttlMinutes: ttl.ttlMinutes,
    baselineValid: input.baselineValid === true,
    supported,
    prefixBreakRetained: input.prefixBreakRetained === true,
  });
  const tokens = resolveContextTokens({
    liveUsedTokens: input.liveUsedTokens,
    storedTokens: input.storedTokens,
    storedSameSession: input.storedSameSession === true,
  });
  const large = isLargeContext(
    tokens,
    input.cleanupProfile,
    Number.isFinite(input.minContextTokens) ? (input.minContextTokens as number) : STEER_MIN_CONTEXT_TOKENS,
  );
  const quota = resolveQuota({
    nowMs,
    agentId: input.agentId,
    model: typeof input.model === "string" ? input.model : null,
    zerosub: input.zerosub ?? null,
    zerosubSampledAtMs: input.zerosubSampledAtMs,
    pool: input.pool ?? null,
    quotaSnapshot: input.quotaSnapshot ?? null,
    poolSampledAtMs: input.poolSampledAtMs ?? null,
    quotaSampleMinutes: input.quotaSampleMinutes,
    warnPct: input.warnPct,
    exhaustedPct: input.exhaustedPct,
    needsResumeReason: input.needsResume ?? null,
    needsResumeAt: input.needsResumeAt ?? null,
    limitRecovered: input.limitRecovered === true,
  });
  const status =
    typeof input.liveStatus === "string" ? input.liveStatus.trim().toLowerCase() : "";
  const needsResume = input.needsResume ?? null;
  const limitEffectiveRecovered = input.limitRecovered === true || quota.limitRetired;
  const freshHint = typeof input.freshHint === "string" && input.freshHint ? input.freshHint : null;

  const base = {
    warmth: warmth.warmth,
    warmthSource: warmth.source,
    ttlMinutes: ttl.ttlMinutes,
    cacheGroup: group,
    billingUnconfirmed: ttl.billingUnconfirmed,
    ageMs,
    tokens,
    large,
    freshHint,
    quota,
  };
  const finish = (
    state: SteerFaceState,
    detail: string,
    primaryAction: SteerPrimaryAction,
  ): SteerProjection => {
    const headerFacts: string[] = [];
    if (ttl.billingUnconfirmed) headerFacts.push("Billing path unconfirmed");
    if (warmth.source === "ttl") headerFacts.push("Estimated");
    if (large && state !== "large") headerFacts.push("Large context");
    if (
      state === "large" &&
      (warmth.warmth === "warm" || warmth.warmth === "cooling") &&
      warmth.boundaryAtMs !== null
    ) {
      const left = formatCountdown(warmth.boundaryAtMs - nowMs);
      headerFacts.push(warmth.warmth === "warm" ? `Warm · cooling in ${left}` : `Cooling · cold in ${left}`);
    }
    if (quota.limited && state !== "limited") {
      headerFacts.push(quota.resetUnknown || !quota.resetAt ? "Waiting for reset · reset unknown" : "Waiting for reset");
    }
    if (freshHint) headerFacts.push("Refresh recommended");
    let nextBoundaryAt: string | null = null;
    const candidates: number[] = [];
    if (warmth.boundaryAtMs !== null) candidates.push(warmth.boundaryAtMs);
    for (const blocker of quota.blockers) {
      const ms = stampMs(blocker.resetsAt);
      if (ms !== null && ms > nowMs) candidates.push(ms);
    }
    if (candidates.length) nextBoundaryAt = new Date(Math.min(...candidates)).toISOString();
    return {
      ...base,
      state,
      label: STEER_STATE_LABELS[state],
      headerFacts,
      primaryAction,
      reviewRequest: state === "running" && input.permissionNeeded === true,
      restartAction: state === "waiting" && quota.waiting === "restart",
      compactBrief:
        state === "needs-resume" &&
        (large || warmth.warmth === "cold" || warmth.warmth === "unknown" || tokens === null),
      refreshPreview:
        state === "cold" && (large || tokens === null || freshHint !== null),
      nextBoundaryAt,
      detail,
    };
  };

  if (input.connected === false || (input.membership ?? "resolved") !== "resolved") {
    if (input.connected === false) return finish("unknown", "Host disconnected", "reload-or-open");
    if (input.membership === "ambiguous") return finish("unknown", "Membership ambiguous", "reload-or-open");
    return finish("unknown", "Membership unknown", "reload-or-open");
  }
  if (input.scopeRetired === true || input.replacedHolder === true || input.superseded === true) {
    const detail = input.scopeRetired === true
      ? "Scope retired"
      : input.replacedHolder === true
        ? "Replaced by a newer holder"
        : "Superseded by the current holder";
    return finish("retired", detail, "open-holder");
  }
  if (status === "running" || input.openTurn === true) {
    return finish(
      "running",
      input.permissionNeeded === true ? "Turn running · review requested" : "Turn running",
      "view-turn",
    );
  }
  if (quota.limited) {
    return finish("limited", quota.limitedReasons.join("; ") || "Quota limited", "handoff-or-reset");
  }
  if (input.resumeFallback) return finish("needs-resume", input.resumeFallback, "preview-recovery");
  if (
    status === "initializing" ||
    input.pendingOperation === true ||
    input.queuedWake === true ||
    quota.pendingMove
  ) {
    let detail = "Agent initializing";
    if (quota.pendingMove) {
      const dest = quota.destinationAccountId ? ` to ${quota.destinationAccountId}` : "";
      detail = quota.waiting === "restart"
        ? `Account move${dest} needs a session restart`
        : `Account move${dest} in progress`;
    } else if (input.pendingOperation === true) {
      detail = "Factory operation in progress";
    } else if (input.queuedWake === true) {
      detail = "Wake queued";
    }
    return finish("waiting", detail, "view-operation");
  }
  if (
    needsResume === "daemon-restart" ||
    needsResume === "failed" ||
    (needsResume === "limit" && limitEffectiveRecovered) ||
    input.interruptedUnrecovered === true
  ) {
    let detail = "Turn interrupted · recovery pending";
    if (needsResume === "daemon-restart") detail = "Paseo restarted · recovery pending";
    else if (needsResume === "failed") detail = "Last reply failed · recovery pending";
    else if (needsResume === "limit") detail = "Usage limit hit · recovery pending";
    return finish("needs-resume", detail, "preview-recovery");
  }
  if (input.historyFree === true || input.resetAwaitingBrief === true) {
    return finish(
      "ready",
      input.historyFree === true ? "Empty session · ready" : "Context reset · brief to stage",
      "focus-or-deliver",
    );
  }
  if (warmth.warmth === "cold" || needsResume === "cold") {
    let detail = `Idle past the ${ttl.ttlMinutes}m cache window`;
    if (input.prefixBreakRetained === true) detail = "Settings changed · cached context no longer reusable";
    else if (needsResume === "cold" && warmth.warmth !== "cold") detail = "Idle chat · refresh recommended";
    const refresh = large || tokens === null || freshHint !== null;
    return finish("cold", detail, refresh ? "preview-refresh" : "focus-reuse");
  }
  if (large) {
    return finish(
      "large",
      tokens !== null ? `Large context (${tokens} tokens)` : "Large context",
      "preview-refresh",
    );
  }
  if (warmth.warmth === "cooling" && warmth.boundaryAtMs !== null) {
    return finish("cooling", `Cache cooling · cold in ${formatCountdown(warmth.boundaryAtMs - nowMs)}`, "continue");
  }
  if (warmth.warmth === "warm" && warmth.boundaryAtMs !== null) {
    return finish("warm", `Cache warm · cooling in ${formatCountdown(warmth.boundaryAtMs - nowMs)}`, "focus");
  }
  if (warmth.warmth === "cooling" || warmth.warmth === "warm") {
    return finish(warmth.warmth, warmth.warmth === "cooling" ? "Cache cooling" : "Cache warm", warmth.warmth === "cooling" ? "continue" : "focus");
  }
  return finish("unknown", "Not enough data", "reload-or-open");
}
