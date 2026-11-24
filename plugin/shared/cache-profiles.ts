// Prompt-cache reference per model group and the cleanup cost profiles.
// Pure module: no imports, so plain node:test can use it. idle-cleanup.ts
// derives its compact thresholds from here; docs/design/cold-context-resume.md
// carries the same table for humans (keep both in sync).

/** Simplified cache groups from the user spec (2026-11-24). */
export type CacheGroup = "claude" | "openai-new" | "openai-old" | "other";

/** Cost profile: when to compact before the cache cools. */
export type CleanupProfile = "efficiency" | "balanced" | "comfort";

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
    note: "Unknown providers (Muse, Copilot, …) are treated conservatively like openai-new.",
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
 * (never below the 5-minute sweep cadence); comfort compacts just before the
 * TTL (a side product, provided as-is). Values are pinned by tests.
 */
export function compactAtMinutes(profile: CleanupProfile, group: CacheGroup): number {
  const ttl = CACHE_GROUPS[group].ttlMinutes;
  if (profile === "efficiency") return Math.max(5, Math.floor(ttl / 2));
  if (profile === "comfort") return Math.max(5, ttl - 2);
  return ttl - Math.max(2, Math.min(10, Math.round(ttl / 6)));
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
