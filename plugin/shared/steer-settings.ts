// Catalog-backed routing and normalization for steer settings.
export interface SettingsTuple {
  provider: string | null;
  model: string | null;
  thinking: string | null;
  speed: string | null;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function cleanLower(value: unknown): string | null {
  const cleaned = cleanString(value);
  return cleaned === null ? null : cleaned.toLowerCase();
}

/** Provider id, lowercased ("Claude" and "claude" are the same route). */
export function normalizeProvider(value: unknown): string | null {
  return cleanLower(value);
}

/** Model id, case-sensitive (provider ids are exact). */
export function normalizeModel(value: unknown): string | null {
  return cleanString(value);
}

/**
 * Thinking option id. Null/empty and an explicit "default" all mean the
 * provider default (explicit default is equivalent to omission).
 */
export function normalizeThinking(value: unknown): string | null {
  const cleaned = cleanString(value);
  if (cleaned === null) return null;
  return cleaned.toLowerCase() === "default" ? null : cleaned;
}

function isClaudeProvider(provider: string | null, model: string | null): boolean {
  if (provider === "claude") return true;
  if (typeof model === "string" && /(^|[/_-])claude(-|$)/i.test(model)) return true;
  return false;
}

function isCodexProvider(provider: string | null): boolean {
  return provider === "codex" || provider === "openai";
}

/**
 * Normalized speed id for the tuple. Claude reports `fast_mode` (boolean):
 * "fast" or "standard". Codex/OpenAI reports `service_tier` (string):
 * the lowercased tier id ("default" stays "default"). Other providers keep
 * their lowercased speed string. Null means unknown / provider default.
 */
export function normalizeSpeed(
  provider: unknown,
  model: unknown,
  speed: unknown,
): string | null {
  const normProvider = normalizeProvider(provider);
  const normModel = normalizeModel(model);
  if (typeof speed === "boolean") {
    return speed ? "fast" : "standard";
  }
  const cleaned = cleanLower(speed);
  if (cleaned === null) return null;
  if (isClaudeProvider(normProvider, normModel)) {
    if (cleaned === "fast" || cleaned === "true" || cleaned === "1") return "fast";
    if (cleaned === "standard" || cleaned === "false" || cleaned === "0") return "standard";
    return cleaned;
  }
  return cleaned;
}

/**
 * Speed id from live provider options (Claude `fast_mode`, Codex
 * `service_tier`); null when the route reports none.
 */
export function speedOfLiveOptions(
  provider: unknown,
  model: unknown,
  options: unknown,
): string | null {
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  const record = options as Record<string, unknown>;
  if (typeof record.fast_mode === "boolean") {
    return normalizeSpeed(provider, model, record.fast_mode);
  }
  if (typeof record.service_tier === "string" && record.service_tier.trim() !== "") {
    return normalizeSpeed(provider, model, record.service_tier);
  }
  return null;
}

/** Display word for a normalized speed id; null when unknown. */
export function speedLabel(speed: string | null, provider?: string | null): string | null {
  if (speed === null) return null;
  if (speed === "fast") return "Fast";
  if (speed === "standard") return "Standard";
  if (provider && isCodexProvider(normalizeProvider(provider))) return `Tier ${speed}`;
  return speed;
}

/** Normalized tuple from live agent/composer values. */
export function tupleFromLive(args: {
  provider: unknown;
  model: unknown;
  thinking?: unknown;
  effectiveThinking?: unknown;
  options?: unknown;
  speed?: unknown;
}): SettingsTuple {
  const provider = normalizeProvider(args.provider);
  const model = normalizeModel(args.model);
  const thinkingRaw = args.effectiveThinking ?? args.thinking ?? null;
  const thinking = normalizeThinking(thinkingRaw);
  const speed = args.speed !== undefined
    ? normalizeSpeed(provider, model, args.speed)
    : speedOfLiveOptions(provider, model, args.options ?? null);
  return { provider, model, thinking, speed };
}

/** True when both tuples name the same effective settings (normalized). */
export function tuplesEqual(a: SettingsTuple | null, b: SettingsTuple | null): boolean {
  if (!a || !b) return false;
  const normA = tupleFromLive({ provider: a.provider, model: a.model, thinking: a.thinking, speed: a.speed });
  const normB = tupleFromLive({ provider: b.provider, model: b.model, thinking: b.thinking, speed: b.speed });
  return (
    normA.provider === normB.provider &&
    normA.model === normB.model &&
    normA.thinking === normB.thinking &&
    normA.speed === normB.speed
  );
}

/** True when the requested tuple changes nothing (a no-op spends no turn). */
export function isNoopChange(current: SettingsTuple, requested: SettingsTuple): boolean {
  return tuplesEqual(current, requested);
}

// ---------------------------------------------------------------------------
// Live catalog
// ---------------------------------------------------------------------------

export interface CatalogModel {
  id?: unknown;
  isSelectable?: unknown;
  thinkingOptions?: readonly { id?: unknown }[] | null;
}

export interface CatalogEntry {
  provider?: unknown;
  enabled?: unknown;
  status?: unknown;
  models?: readonly CatalogModel[] | null;
}

/**
 * Selectable model ids of one provider, in catalog order. An empty list
 * means the provider is unknown, disabled, or offers nothing.
 */
export function listSupportedModels(
  catalog: readonly CatalogEntry[] | null | undefined,
  provider: unknown,
): string[] {
  const want = normalizeProvider(provider);
  if (!want || !Array.isArray(catalog)) return [];
  const entry = (catalog as readonly CatalogEntry[]).find((item: CatalogEntry) => normalizeProvider(item?.provider) === want) ?? null;
  if (!entry || entry.enabled !== true || entry.status !== "ready") return [];
  const models = Array.isArray(entry.models) ? entry.models : [];
  const out: string[] = [];
  for (const model of models) {
    const id = cleanString(model?.id);
    if (id === null || model?.isSelectable === false) continue;
    out.push(id);
  }
  return out;
}

/**
 * Thinking option ids for one provider/model, in catalog order. Null (the
 * provider default) is always allowed and is not listed. An empty list with
 * a known model means "default only".
 */
export function thinkingOptionsFor(
  catalog: readonly CatalogEntry[] | null | undefined,
  provider: unknown,
  model: unknown,
): string[] {
  const wantProvider = normalizeProvider(provider);
  const wantModel = normalizeModel(model);
  if (!wantProvider || !wantModel || !Array.isArray(catalog)) return [];
  const entry = (catalog as readonly CatalogEntry[]).find((item: CatalogEntry) => normalizeProvider(item?.provider) === wantProvider) ?? null;
  if (!entry || entry.enabled !== true || entry.status !== "ready") return [];
  const models = Array.isArray(entry.models) ? entry.models : [];
  const found = models.find((item) => cleanString(item?.id) === wantModel) ?? null;
  if (!found) return [];
  const options = Array.isArray(found.thinkingOptions) ? found.thinkingOptions : [];
  const out: string[] = [];
  for (const option of options) {
    const id = cleanString(option?.id);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}

export interface CombinationCheck {
  ok: boolean;
  /** English reason when the combination is not supported. */
  reason: string | null;
}

/**
 * True when the provider/model/thinking triple is offered by the live
 * catalog. Speed is validated separately (provider controls, not the model
 * catalog). Null thinking (provider default) is always allowed.
 */
export function checkSupportedCombination(
  catalog: readonly CatalogEntry[] | null | undefined,
  provider: unknown,
  model: unknown,
  thinking: unknown,
): CombinationCheck {
  const normProvider = normalizeProvider(provider);
  const normModel = normalizeModel(model);
  const normThinking = normalizeThinking(thinking);
  if (!normProvider) return { ok: false, reason: "Choose a provider." };
  if (!normModel) return { ok: false, reason: "Choose a model." };
  if (!Array.isArray(catalog)) return { ok: false, reason: "The provider catalog is unavailable." };
  const entry = (catalog as readonly CatalogEntry[]).find((item: CatalogEntry) => normalizeProvider(item?.provider) === normProvider) ?? null;
  if (!entry) return { ok: false, reason: `Provider "${normProvider}" is not configured in Paseo.` };
  if (entry.enabled !== true || entry.status !== "ready") {
    const state = entry.enabled !== true ? "disabled" : String(entry.status ?? "unknown");
    return { ok: false, reason: `Provider "${normProvider}" is ${state}.` };
  }
  const models = Array.isArray(entry.models) ? (entry.models as readonly CatalogModel[]) : [];
  const found = models.find((item: CatalogModel) => cleanString(item?.id) === normModel) ?? null;
  if (!found || found.isSelectable === false) {
    return { ok: false, reason: `Model "${normModel}" is not offered by ${normProvider}.` };
  }
  if (normThinking !== null) {
    const options = thinkingOptionsFor(catalog, normProvider, normModel);
    if (!options.includes(normThinking)) {
      const have = options.length ? options.join(", ") : "none";
      return {
        ok: false,
        reason: `Thinking "${normThinking}" is not available for ${normModel} (available: ${have}).`,
      };
    }
  }
  return { ok: true, reason: null };
}

/**
 * True when the speed id is plausible for the provider. Claude accepts
 * fast/standard (its `fast_mode` toggle); other providers accept any
 * non-empty tier id or null (provider default), because tier catalogs vary.
 */
export function checkSupportedSpeed(
  provider: unknown,
  model: unknown,
  speed: unknown,
): CombinationCheck {
  const norm = normalizeSpeed(provider, model, speed);
  if (norm === null) return { ok: true, reason: null };
  const normProvider = normalizeProvider(provider);
  const normModel = normalizeModel(model);
  if (isClaudeProvider(normProvider, normModel) && norm !== "fast" && norm !== "standard") {
    return { ok: false, reason: `Speed "${norm}" is not a Claude speed (use Fast or Standard).` };
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Efficiency lock
// ---------------------------------------------------------------------------

export interface EfficiencyLockInput {
  /** Cleanup cost profile ("efficiency" locks warm steers). */
  profile: unknown;
  /** Cache warmth of the steer ("warm" | "cooling" | "cold" | "unknown"). */
  warmth: unknown;
  /** Pill face state (e.g. "running", "large", "warm"). */
  state?: unknown;
  /** Live agent status ("running", "initializing", "idle", …). */
  liveStatus?: unknown;
  /** Current-generation open turn that has not ended. */
  openTurn?: unknown;
}

export interface EfficiencyLock {
  locked: boolean;
  /** Short English reason when locked, null otherwise. */
  reason: string | null;
}

/**
 * Maximum efficiency (`efficiency`) locks model/thinking/speed changes on a
 * warm or cooling steer, including a Large face with warm or cooling
 * underneath, and during a running turn independent of the face. Other
 * profiles never lock. A locked change goes through Refresh.
 */
export function efficiencySettingsLock(input: EfficiencyLockInput): EfficiencyLock {
  if (input.profile !== "efficiency") return { locked: false, reason: null };
  const live = typeof input.liveStatus === "string" ? input.liveStatus.trim().toLowerCase() : "";
  const state = typeof input.state === "string" ? input.state.trim().toLowerCase() : "";
  if (input.openTurn === true || live === "running" || live === "initializing" || state === "running") {
    return { locked: true, reason: "A turn is running. Change settings after it ends." };
  }
  const warmth = typeof input.warmth === "string" ? input.warmth.trim().toLowerCase() : "";
  if (warmth === "warm" || warmth === "cooling") {
    return { locked: true, reason: "Maximum efficiency protects this warm context. Use Refresh." };
  }
  return { locked: false, reason: null };
}

// ---------------------------------------------------------------------------
// Settings route
// ---------------------------------------------------------------------------

export type SettingsRouteKind = "apply-here" | "refresh";

export interface SettingsRoute {
  route: SettingsRouteKind;
  /** Short English reason for the route. */
  reason: string;
  /** True when the change risks the cached prefix (any effective change). */
  cacheRisk: boolean;
}

export interface SettingsRouteInput {
  current: SettingsTuple;
  requested: SettingsTuple;
  warmth: unknown;
  large: unknown;
  /** Context size in tokens; null means unknown. */
  tokens: unknown;
  /** True when the efficiency lock above applies. */
  efficiencyLocked?: unknown;
}

/**
 * "Apply here" when the change is cache-safe (a no-op) or the context is
 * small, cold and known; otherwise "Refresh" (rewind, then apply and verify
 * the settings, then deliver or stage the brief). A large context of any
 * age, an unknown size, a warm or cooling cache, or the efficiency lock all
 * take Refresh. There is no in-place override for a risky change.
 */
export function chooseSettingsRoute(input: SettingsRouteInput): SettingsRoute {
  if (isNoopChange(input.current, input.requested)) {
    return { route: "apply-here", reason: "No change.", cacheRisk: false };
  }
  if (input.efficiencyLocked === true) {
    return {
      route: "refresh",
      reason: "Maximum efficiency protects this context. Refresh, then change settings.",
      cacheRisk: true,
    };
  }
  const warmth = typeof input.warmth === "string" ? input.warmth.trim().toLowerCase() : "";
  if (warmth === "warm" || warmth === "cooling") {
    return {
      route: "refresh",
      reason: "This context is still warm. Refresh keeps the cache usable.",
      cacheRisk: true,
    };
  }
  if (input.large === true) {
    return {
      route: "refresh",
      reason: "This is a large context. Refresh avoids replaying it.",
      cacheRisk: true,
    };
  }
  const tokens = typeof input.tokens === "number" && Number.isFinite(input.tokens) ? input.tokens : null;
  if (tokens === null) {
    return {
      route: "refresh",
      reason: "The context size is unknown. Refresh is the safe route.",
      cacheRisk: true,
    };
  }
  return {
    route: "apply-here",
    reason: "Small cold context. Safe to apply here.",
    cacheRisk: true,
  };
}

/**
 * Provider-options patch for a speed change. Claude toggles `fast_mode`;
 * Codex sets `service_tier` (null resets to the provider default). Other
 * keys are never touched: access mode, provider options, account policy and
 * role stay as they are.
 */
export function speedPatchFor(
  provider: unknown,
  model: unknown,
  speed: string | null,
): Record<string, boolean | string | null> | null {
  const normProvider = normalizeProvider(provider);
  const normModel = normalizeModel(model);
  const normSpeed = normalizeSpeed(provider, model, speed);
  if (isClaudeProvider(normProvider, normModel)) {
    if (normSpeed === null) return null;
    if (normSpeed === "fast") return { fast_mode: true };
    if (normSpeed === "standard") return { fast_mode: false };
    return null;
  }
  if (isCodexProvider(normProvider)) {
    if (normSpeed === null) return { service_tier: null };
    return { service_tier: normSpeed };
  }
  return null;
}
