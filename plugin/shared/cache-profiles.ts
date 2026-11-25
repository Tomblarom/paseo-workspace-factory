// Prompt-cache timing and cleanup profiles shared by display and delivery.

/** Simplified cache groups from the user spec (2026-11-24). */
export type CacheGroup = "claude" | "openai-new" | "openai-old" | "other";

/** Cost profile: when to compact before the cache cools. */
export type CleanupProfile = "efficiency" | "balanced" | "comfort";

const SHORT_CACHE_TTL_MINUTES = 5;
export const CACHE_CHECK_INTERVAL_MS = 60_000;

export interface CacheGroupInfo {
  group: CacheGroup;
  /** Prompt-cache lifetime in minutes; the compact window ends here. */
  ttlMinutes: number;
  /** Relative price of cached input (documentation only, not computed with). */
  cachedInput: string;
  note: string;
}

export const CACHE_GROUPS: Record<CacheGroup, CacheGroupInfo> = {
  claude: {
    group: "claude",
    ttlMinutes: 60,
    cachedInput: "~0.1×",
    note: "Native /clear and /compact; 5 min on some billing paths (see doc).",
  },
  "openai-new": {
    group: "openai-new",
    ttlMinutes: 30,
    cachedInput: "0.05× (Sol)",
    note: "Docs say 30 min or more; measured <30min ~96%, 30–180min ~82%, >3h ≤30%; auto-compact around 360–420k; /clear is not native.",
  },
  "openai-old": {
    group: "openai-old",
    ttlMinutes: 10,
    cachedInput: "model-dependent",
    note: "Upper bound of the 5–10 min in_memory window; the ~30 min 24h variant behaves like openai-new.",
  },
  other: {
    group: "other",
    ttlMinutes: 30,
    cachedInput: "unknown",
    note: "Conservative reference only. Unsupported routes have unknown warmth.",
  },
};

const OPENAI_PROVIDERS = ["codex", "openai"];

function norm(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Major/minor of a GPT model id ("gpt-6.2-sol" → [6, 2]), else null. */
export function parseGptVersion(model: unknown): [number, number] | null {
  const match = /gpt-(\d+)(?:\.(\d+))?/.exec(norm(model));
  if (!match) return null;
  return [Number(match[1]), match[2] === undefined ? 0 : Number(match[2])];
}

/**
 * Cache group for an agent. Provider "claude" always wins; a claude model on
 * another provider (e.g. Copilot serving Claude) follows the model family,
 * because the cache behaviour is assumed to follow the model. Codex/OpenAI
 * models split at GPT-5.6; unparseable Codex models count as current
 * (openai-new). Everything else is "other" (same TTL as openai-new).
 */
export function groupForProviderModel(provider: unknown, model: unknown): CacheGroup {
  const id = norm(model);
  if (norm(provider) === "claude" || /(^|[/_-])claude(-|$)/.test(id)) return "claude";
  const gpt = parseGptVersion(id);
  if (gpt || OPENAI_PROVIDERS.includes(norm(provider))) {
    if (gpt && (gpt[0] < 5 || (gpt[0] === 5 && gpt[1] <= 5))) return "openai-old";
    return "openai-new";
  }
  return "other";
}

/** Groups whose provider has no native /clear: compact only, never clear. */
export function isCompactOnlyGroup(group: CacheGroup): boolean {
  return group === "openai-new" || group === "openai-old";
}

export function isCleanupProfile(value: unknown): value is CleanupProfile {
  return value === "efficiency" || value === "balanced" || value === "comfort";
}

/**
 * Minutes of idleness after which the profile compacts this group — while the
 * cache is still warm. Balanced compacts shortly before the TTL expires
 * (claude 60 → 50, the previous default); efficiency compacts at half the TTL
 * (never below the sweep cadence); comfort compacts just before the
 * TTL (a side product, provided as-is). Values are pinned by tests.
 */
export function compactAtMinutes(profile: CleanupProfile, { ttlMinutes }: Pick<CacheTtl, "ttlMinutes">): number {
  const cadence = CACHE_CHECK_INTERVAL_MS / 60_000;
  if (profile === "efficiency") return Math.max(cadence, Math.floor(ttlMinutes / 2));
  if (profile === "comfort") return ttlMinutes - Math.max(cadence, 2);
  return ttlMinutes - Math.max(2, coolingMinutesForTtl(ttlMinutes));
}

/**
 * Small-context floor for efficiency: compact even at small contexts.
 * Balanced and comfort keep the configured minContextTokens.
 */
export const EFFICIENCY_MIN_CONTEXT_TOKENS = 10_000;

export function effectiveMinContextTokens(
  profile: CleanupProfile,
  configuredMin: number,
): number {
  return profile === "efficiency"
    ? Math.min(configuredMin, EFFICIENCY_MIN_CONTEXT_TOKENS)
    : configuredMin;
}

/** Known context windows also need at least 30% occupancy before cleanup. */
export function contextSizeThreshold(floor: number, windowTokens: unknown): number {
  const window = typeof windowTokens === "number" && Number.isFinite(windowTokens) ? windowTokens : 0;
  return Math.max(floor, window * 0.3);
}

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
 * Estimated prompt-cache TTL for the provider model and account route.
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
    return {
      ttlMinutes: args.claudeBilling === "subscription" ? CACHE_GROUPS.claude.ttlMinutes : SHORT_CACHE_TTL_MINUTES,
      group,
      billingUnconfirmed: args.claudeBilling !== "subscription" && args.claudeBilling !== "api-5m",
    };
  }
  const retentionGroup = group === "openai-old" && args.openaiExtendedRetention === true ? "openai-new" : group;
  return { ttlMinutes: CACHE_GROUPS[retentionGroup].ttlMinutes, group, billingUnconfirmed: false };
}

type CacheRoutes = {
  accounts: { id?: unknown; family?: unknown; auth?: unknown }[];
  agentAccount: Record<string, string>;
  pending?: Record<string, string>;
} | null;

export function cacheTtlForAgent(agent: { id: string; provider?: unknown; model?: unknown }, routes: CacheRoutes): CacheTtl {
  const route = routes?.agentAccount[agent.id];
  const pending = routes?.pending?.[agent.id];
  const account = route && (!pending || pending === route)
    ? routes?.accounts.find(({ id }) => id === route) : null;
  // Only native Claude with a confirmed Claude account exposes its billing
  // route. A Claude model served by another provider has a short estimate.
  const auth = norm(agent.provider) === "claude" && account?.family === "claude" ? account.auth : null;
  const claudeBilling = auth === "subscription" ? "subscription" : auth === "api" ? "api-5m" : "unknown";
  return resolveCacheTtl({ provider: agent.provider, model: agent.model, claudeBilling });
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
  const stampMs = (stamp: unknown) => typeof stamp === "string" ? Date.parse(stamp) : NaN;
  const start = stampMs(args.cacheStartAt);
  if (Number.isFinite(start)) return start > args.nowMs ? null : args.nowMs - start;
  const end = stampMs(args.lastTurnEndedAt);
  if (!Number.isFinite(end) || end > args.nowMs) return null;
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
