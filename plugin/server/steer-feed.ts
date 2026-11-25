import { readSteerAction } from "./core/steer-action.mjs";
// Host-wide steer-state feed (docs/design/steer-menu.md, step 1): one small
// projection per known steer tab for the persistent composer pill (the pill
// itself subscribes in step 2). Read-only: local metadata reads plus the
// reused quota sampling, no timeline fetches, no provider calls, no
// per-agent polling for the face.
import { AGENTS_KEY, currentFreshHint } from "./core/agent-state.mjs";
import { isAdvisorSlot } from "./core/config.mjs";
import { liveSlotHolders, resolveSteerHolders } from "./core/discovery.mjs";
import { METADATA_KEY, readPaseoState } from "./core/paseo.mjs";
import { QUOTA_DEFAULTS } from "./core/quota.mjs";
import { listScopes } from "./core/scope.mjs";
import { resolveContinuations } from "./core/zerosub.mjs";
import { getQuotaSampledAt, getQuotaSnapshot } from "./quota.js";
import { resolveZerosub, type ZerosubState } from "./zerosub-runtime.js";
import {
  CLEANUP_DEFAULTS,
  cleanupIdentity,
  isNeedsResumeReason,
  type CleanupSettings,
} from "../shared/idle-cleanup.js";
import { agentContextInputs } from "./agent-context.js";
import { CACHE_CHECK_INTERVAL_MS } from "../shared/cache-profiles.js";
import { projectSteer, type SteerMembership } from "../shared/steer-state.js";
import {
  efficiencySettingsLock,
  normalizeModel,
  normalizeProvider,
  normalizeThinking,
} from "../shared/steer-settings.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Advisor flag for the row; unknown config means not advisor. */
function isAdvisorSlotOf(config: unknown, slot: string): boolean {
  if (!config || typeof config !== "object") return false;
  try {
    return (isAdvisorSlot as unknown as (c: unknown, s: string) => boolean)(config, slot);
  } catch {
    return false;
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface SettingsTupleRow {
  provider: string | null;
  model: string | null;
  thinking: string | null;
  speed: string | null;
  sessionId?: string | null;
}

export interface SteerFeedRow {
  scopeId: string;
  workspaceId: string;
  agentId: string;
  slot: string | null;
  title: string | null;
  provider: string | null;
  model: string | null;
  liveStatus: string | null;
  advisor: boolean;
  active: boolean;
  permissionNeeded: boolean;
  /** A brief is staged for this tab (initialize it from the steer menu). */
  stagedBrief: boolean;
  successor: string | null;
  state: string;
  warmth: string;
  tokens: number | null;
  large: boolean;
  limited: boolean;
  resetAt: string | null;
  resetUnknown: boolean;
  awaitingUpdate: boolean;
  quotaRows: {
    id: string;
    scope: "account" | "model" | "pool";
    usedPct: number | null;
    resetsAt: string | null;
    stale: boolean;
  }[];
  headerFacts: string[];
  primaryAction: string;
  detail: string;
  nextBoundaryAt: string | null;
  /** Live effective thinking option id (step 4), null for the provider default. */
  thinking: string | null;
  /** Live normalized speed id (step 4), null when the route reports none. */
  speed: string | null;
  /** Live provider session id (step 4), null when unknown. */
  sessionId: string | null;
  /** Turn-end settings baseline from wsf.agents (step 4), null when none. */
  baseline: SettingsTupleRow | null;
  /** Last Factory-confirmed settings tuple (step 4), null when none. */
  confirmed: SettingsTupleRow | null;
  /** Maximum efficiency locks settings changes on this steer (step 4). */
  settingsLocked: boolean;
  /** Short reason when locked, null otherwise. */
  settingsLockReason: string | null;
}

export interface SteerFeedDeps {
  /** Null falls back to CLEANUP_DEFAULTS (read-only feed, no send gate). */
  settings: CleanupSettings | null;
  config?: unknown;
  zerosub?: ZerosubState;
  quotaSnapshot?: Record<string, any> | null;
  poolSampledAtMs?: number | null;
  quotaSampleMinutes?: number;
  nowMs?: number;
  /** Queued-wake lookup; supervision wiring lands with the pill (step 2+). */
  queuedWakeFor?: (agentId: string) => boolean;
}

interface ScopeReads {
  mainId: string;
  activeSteer: string | null;
  retired: boolean;
  previousSteer: string | null;
  entries: Record<string, unknown>;
}

function scopeReads(scope: any): ScopeReads | null {
  const mainId = scope?.workspaceId;
  const meta = scope?.workspace?.metadata ?? {};
  const wsf = asRecord(meta[METADATA_KEY]);
  if (typeof mainId !== "string" || !wsf) return null;
  return {
    mainId,
    activeSteer: typeof wsf.activeSteer === "string" ? wsf.activeSteer : null,
    retired: wsf.retired === true,
    previousSteer: typeof wsf.previousSteer === "string" ? wsf.previousSteer : null,
    entries: asRecord(meta[AGENTS_KEY]) ?? {},
  };
}

/**
 * Pure assembly of one feed event from an already-read daemon state (see
 * readPaseoState). Counts every known steer tab: live holders (ZeroSub
 * continuations inherit the origin's labels, missing keys only) plus
 * superseded origins, which keep a Retired row while their tab exists.
 * Continuation and same-slot supersession reuse the discovery rules;
 * switches stay empty because the face never fetches timelines.
 */
export function collectSteerStates(paseoState: any, deps: SteerFeedDeps): SteerFeedRow[] {
  const nowMs = typeof deps.nowMs === "number" ? deps.nowMs : Date.now();
  const settings = deps.settings ?? CLEANUP_DEFAULTS;
  const agents: any[] = Array.isArray(paseoState?.agents) ? paseoState.agents : [];
  const scopes = listScopes(paseoState);
  const byId = new Map<string, any>();
  for (const scope of scopes) byId.set(scope.id, scope);
  const resolution = resolveContinuations(agents, []) as unknown as {
    liveFor: Record<string, string>;
  };
  const liveFor: Record<string, string> = resolution?.liveFor ?? {};
  const quota = (deps.config as Record<string, any> | null)?.quota ?? {};
  const warnPct = finiteNumber(quota.warnPct) ?? QUOTA_DEFAULTS.warnPct;
  const exhaustedPct = finiteNumber(quota.exhaustedPct) ?? QUOTA_DEFAULTS.exhaustedPct;
  const queuedWakeFor = deps.queuedWakeFor ?? (() => false);

  // Candidate tabs per scope: resolved holders plus superseded origins as retired rows.
  const rawByScope = new Map<string, any[]>();
  for (const agent of agents) {
    if (!agent || typeof agent.id !== "string" || !agent.id) continue;
    const identity = cleanupIdentity(agent.labels ?? null);
    if (!identity || identity.role !== "steer" || !byId.has(identity.scopeId)) continue;
    if (!rawByScope.has(identity.scopeId)) rawByScope.set(identity.scopeId, []);
    rawByScope.get(identity.scopeId)?.push(agent);
  }
  const candidates = new Map<string, any>();
  const byScope = new Map<string, any[]>();
  for (const [scopeId, list] of rawByScope) {
    const group: any[] = [];
    byScope.set(scopeId, group);
    for (const agent of resolveSteerHolders(list, agents, [])) {
      if (!agent || typeof agent.id !== "string" || !agent.id || candidates.has(agent.id)) continue;
      candidates.set(agent.id, agent);
      group.push(agent);
    }
    for (const agent of list) {
      if (liveFor[agent.id] && !candidates.has(agent.id)) {
        const origin = { ...agent, superseded: true };
        candidates.set(agent.id, origin);
        group.push(origin);
      }
    }
  }

  const rows: SteerFeedRow[] = [];
  for (const agent of candidates.values()) {
    const identity = cleanupIdentity(agent.labels ?? null);
    if (!identity) continue;
    const reads = scopeReads(byId.get(identity.scopeId));
    if (!reads) continue;
    const slot = typeof identity.slot === "string" && identity.slot ? identity.slot : null;
    const contenders = liveSlotHolders(byScope.get(identity.scopeId) ?? [], slot);
    const ambiguous = contenders.length > 1;
    const uniqueHolder =
      contenders.length === 1 && typeof contenders[0].id === "string" ? contenders[0].id : null;
    const superseded =
      agent.superseded === true && uniqueHolder !== null && uniqueHolder !== agent.id;
    const membership: SteerMembership = ambiguous ? "ambiguous" : "resolved";
    const entry = asRecord(reads.entries[agent.id]);
    const status = typeof agent.status === "string" ? agent.status : null;
    const permissionNeeded =
      Array.isArray(agent.pendingPermissions) && agent.pendingPermissions.length > 0;
    const openTurn = entry?.openTurnId !== null && entry?.openTurnId !== undefined;
    const confirmedRaw = asRecord(entry?.settingsConfirmed);
    const confirmed = confirmedRaw &&
        (typeof confirmedRaw.provider === "string" || typeof confirmedRaw.model === "string")
      ? {
        provider: normalizeProvider(confirmedRaw.provider),
        model: normalizeModel(confirmedRaw.model),
        thinking: normalizeThinking(confirmedRaw.thinking),
        speed: typeof confirmedRaw.speed === "string" && confirmedRaw.speed.trim()
          ? confirmedRaw.speed.trim().toLowerCase()
          : null,
      }
      : null;
    const context = agentContextInputs(agent, entry, settings, deps.zerosub ?? null, nowMs, paseoState.providers);
    const { provider, model, lastTurnEndedAt, cleanedAfter, liveThinking, liveSpeed, liveSessionId, baseline } = context;
    const needsResume = isNeedsResumeReason(asRecord(entry?.needsResume)?.reason)
      ? ((asRecord(entry?.needsResume)?.reason as "daemon-restart" | "limit" | "failed" | "cold"))
      : null;
    const projection = projectSteer({
      membership,
      scopeRetired: reads.retired,
      replacedHolder:
        reads.previousSteer !== null &&
        !/^[A-Z]$/.test(reads.previousSteer) &&
        reads.previousSteer === agent.id,
      superseded,
      liveStatus: status,
      openTurn,
      permissionNeeded,
      ...context,
      freshHint: status === "idle" ? currentFreshHint(entry) : null,
      queuedWake: queuedWakeFor(agent.id),
      historyFree: lastTurnEndedAt === null && !openTurn && status === "idle",
      resetAwaitingBrief: cleanedAfter && !context.pendingOperation && !openTurn && status === "idle",
      needsResume,
      needsResumeAt: typeof asRecord(entry?.needsResume)?.at === "string"
        ? (asRecord(entry?.needsResume)?.at as string)
        : null,
      interruptedUnrecovered: entry?.interrupted !== null && entry?.interrupted !== undefined,
      zerosub: deps.zerosub ?? null,
      pool: provider,
      quotaSnapshot: deps.quotaSnapshot ?? null,
      poolSampledAtMs: deps.poolSampledAtMs ?? null,
      quotaSampleMinutes: deps.quotaSampleMinutes,
      warnPct,
      exhaustedPct,
    });
    const settingsLock = efficiencySettingsLock({
      profile: settings.profile,
      warmth: projection.warmth,
      state: projection.state,
      liveStatus: status,
      openTurn,
    });
    rows.push({
      scopeId: identity.scopeId,
      workspaceId: reads.mainId,
      agentId: agent.id,
      slot,
      title: typeof agent.title === "string" ? agent.title : null,
      provider,
      model,
      liveStatus: status,
      advisor: slot !== null && isAdvisorSlotOf(deps.config, slot),
      active: slot !== null && slot === reads.activeSteer,
      permissionNeeded,
      stagedBrief:
        readSteerAction(entry)?.phase === "staged",
      successor: liveFor[agent.id] ?? (superseded ? uniqueHolder : null),
      state: projection.state,
      warmth: projection.warmth,
      tokens: projection.tokens,
      large: projection.large,
      limited: projection.quota.limited,
      resetAt: projection.quota.resetAt,
      resetUnknown: projection.quota.resetUnknown,
      awaitingUpdate: projection.quota.awaitingUpdate,
      quotaRows: projection.quota.rows,
      headerFacts: projection.headerFacts,
      primaryAction: projection.primaryAction,
      detail: projection.detail,
      nextBoundaryAt: projection.nextBoundaryAt,
      thinking: liveThinking,
      speed: liveSpeed,
      sessionId: liveSessionId,
      baseline,
      confirmed,
      settingsLocked: settingsLock.locked,
      settingsLockReason: settingsLock.reason,
    });
  }
  rows.sort((a, b) =>
    a.scopeId.localeCompare(b.scopeId) ||
    (a.slot ?? "~").localeCompare(b.slot ?? "~") ||
    a.agentId.localeCompare(b.agentId)
  );
  return rows;
}

export interface SteerServeDeps {
  readSettings: () => Promise<CleanupSettings | null>;
  getConfig?: () => Promise<unknown>;
  readSupervision?: () => Promise<{ quotaSampleMinutes?: unknown } | null>;
  getZerosub?: () => Promise<ZerosubState>;
  intervalMs?: number;
}

// K10: one shared timer broadcasts to all subscribers; every push re-reads settings.
const steerPushes = new Set<(event: any) => Promise<void>>();
let steerTimer: ReturnType<typeof setInterval> | null = null;
let steerPaseo: any = null;
let steerDeps: SteerServeDeps | null = null;

async function pushSteerFeed(): Promise<void> {
  const paseo = steerPaseo, deps = steerDeps;
  if (!paseo || !deps || steerPushes.size === 0) return;
  try {
    const settings = await deps.readSettings();
    const config = deps.getConfig ? await deps.getConfig().catch(() => null) : null;
    const supervision = deps.readSupervision ? await deps.readSupervision().catch(() => null) : null;
    const quotaSampleMinutes = finiteNumber(supervision?.quotaSampleMinutes) ?? undefined;
    const zerosub = deps.getZerosub ? await resolveZerosub({ getZerosub: deps.getZerosub }) : null;
    const rows = collectSteerStates(await readPaseoState(paseo), {
      settings,
      config,
      zerosub,
      quotaSnapshot: getQuotaSnapshot(),
      poolSampledAtMs: getQuotaSampledAt(),
      quotaSampleMinutes,
    });
    const event = { steers: rows, updatedAt: new Date().toISOString() };
    await Promise.allSettled([...steerPushes].map((push) => push(event)));
  } catch {
    // A failed push surfaces through the subscription lifecycle; retry next tick.
  }
}

/** Immediate shared push for lifecycle events; no-op without subscribers. */
export function notifySteerFeed(): void { if (steerPushes.size > 0) void pushSteerFeed(); }

/**
 * Serves the factory.steers subscription: pushes the host-wide projection on
 * subscribe, on lifecycle events, and every minute after (one shared timer).
 * Returns void — settling a promise would close the subscription. Countdown
 * ticks stay local to the pill (step 2), which re-renders at nextBoundaryAt.
 */
export function serveSteerSubscription(
  _input: unknown,
  context: { paseo: any; push: (event: any) => Promise<void>; signal: AbortSignal },
  deps: SteerServeDeps,
): void {
  steerPaseo = context.paseo;
  steerDeps = deps;
  const push = context.push;
  steerPushes.add(push);
  void pushSteerFeed();
  if (!steerTimer) {
    steerTimer = setInterval(() => void pushSteerFeed(), deps.intervalMs ?? CACHE_CHECK_INTERVAL_MS);
    if (typeof (steerTimer as unknown as { unref?: unknown }).unref === "function") {
      (steerTimer as unknown as { unref: () => void }).unref();
    }
  }
  context.signal.addEventListener(
    "abort",
    () => {
      steerPushes.delete(push);
      if (steerPushes.size === 0 && steerTimer) { clearInterval(steerTimer); steerTimer = null; }
    },
    { once: true },
  );
}
