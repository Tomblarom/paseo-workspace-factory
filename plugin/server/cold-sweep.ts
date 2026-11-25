import { AGENTS_KEY, currentFreshHint, updateAgentEntry } from "./factory/agent-state.js";
import { isAdvisorSlot } from "./factory/config.js";
import { LEGACY_PREFIX, METADATA_KEY, readPaseoState } from "./factory/paseo.js";
import { QUOTA_DEFAULTS, accountExhausted, freshMaxUsedPct, quotaEntry, quotaExhausted, quotaPct } from "./factory/quota.js";
import { listScopes } from "./factory/scope.js";
import { WORKERS_KEY } from "./factory/supervision.js";
import { buildRewindRecord } from "./factory/steer.js";
import { rewindSameTab } from "./factory/rewind.js";
import { getQuotaSampledAt, getQuotaSnapshot } from "./quota.js";
import {
  CLEAR_COMMAND,
  COMPACT_COMMAND,
  SWEEP_PENDING_REASON,
  cleanupIdentity,
  cleanupInputOf,
  decideCleanupAction,
  isCold,
  isNeedsResumeReason,
  isSupervisionProtectedState,
  pushPreviousSession,
  sendCleanupCommand,
  shouldRewindFresh,
  type CleanupSettings,
  type NeedsResumeReason,
} from "../shared/idle-cleanup.js";
import { MAX_FRESH_REASON } from "../shared/auto-checkpoint.js";
import { resolveZerosub, type ZerosubState } from "./zerosub-runtime.js";
import { agentContextInputs } from "./agent-context.js";
import { CACHE_CHECK_INTERVAL_MS } from "../shared/cache-profiles.js";
import { projectAgentContext, type CacheWarmth } from "../shared/steer-state.js";
import { workerIdentityFromMetadata } from "../shared/supervise.js";

const CHECKPOINT_KEY = `${METADATA_KEY}.checkpoint`;
const LEGACY_CHECKPOINT_KEY = `${LEGACY_PREFIX}.checkpoint`;

// The synced core is unchecked (@ts-nocheck): its inferred parameter types are
// too narrow for real calls, so the sweep talks to it as any (as handlers do).
const updateEntry = updateAgentEntry as unknown as (args: any) => Promise<any>;
const buildRewind = buildRewindRecord as unknown as (args: any) => Record<string, unknown>;
const rewindTab = rewindSameTab as unknown as (agentId: string) => Promise<any>;

/**
 * C5 effect kill-switch. A cleanup command that demonstrably arrived as text
 * means the automation cannot work in this environment, so the sweep stops
 * sending until the user changes the mode setting (which re-probes once) or
 * the daemon restarts. The server cannot write settings; this flag plus
 * per-agent lastActionFailed is the whole "mode off" mechanism.
 */
let effectBlock: { at: string; reason: string } | null = null;
let lastMode: string | null = null;
let daily: { day: string; count: number } = { day: "", count: 0 };

/**
 * The daemon handle for the timer. The server entry receives no PaseoApi of
 * its own, so hook, RPC, and subscription contexts lend theirs; the timer
 * ticks idle until the first one arrives (first turn, RPC, or C6 subscribe).
 * Limitation: a headless daemon with zero interaction never captures a
 * handle, so its first sweep waits for the first contact.
 */
let sweepPaseo: any = null;

export function captureSweepPaseo(paseo: any): void {
  if (paseo) sweepPaseo = paseo;
}

/** Reads the C5 settings document; null fails the sweep closed. */
export async function readCleanupSettings(handle: {
  read: () => Promise<{ status: string; values?: unknown }>;
}): Promise<CleanupSettings | null> {
  try {
    const state = await handle.read();
    if (state.status !== "ready") return null;
    return state.values as CleanupSettings;
  } catch {
    return null;
  }
}

export function noteEffectFailure(reason: string): void {
  if (effectBlock) return;
  effectBlock = { at: new Date().toISOString(), reason };
  console.error(
    `[factory] idle cleanup disabled: ${reason}. Change the cleanup mode setting to probe again.`,
  );
}

export function isEffectBlocked(): boolean {
  return effectBlock !== null;
}

export function effectBlockReason(): string | null {
  return effectBlock?.reason ?? null;
}

function actionsToday(nowMs: number): number {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  if (daily.day !== day) daily = { day, count: 0 };
  return daily.count;
}

function countAction(nowMs: number): void {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  if (daily.day !== day) daily = { day, count: 0 };
  daily.count += 1;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Advisor flag for the attention row; unknown config means not advisor. */
function isAdvisorSlotOf(config: unknown, slot: string): boolean {
  if (!config || typeof config !== "object") return false;
  try {
    return (isAdvisorSlot as unknown as (c: unknown, s: string) => boolean)(config, slot);
  } catch {
    return false;
  }
}

interface ScopeLookup {
  scopes: any[];
  byId: Map<string, any>;
}

function scopeForAgent(agent: any, lookup: ScopeLookup): any | null {
  const identity = cleanupIdentity(agent?.labels ?? null);
  if (!identity) return null;
  return lookup.byId.get(identity.scopeId) ?? null;
}

function scopeReads(scope: any): {
  mainId: string;
  activeSteer: unknown;
  checkpoint: Record<string, unknown> | null;
  entries: Record<string, unknown>;
  workers: Record<string, unknown>;
} | null {
  const mainId = scope?.workspaceId;
  const meta = scope?.workspace?.metadata ?? {};
  const wsf = asRecord(meta[METADATA_KEY]) ?? asRecord(meta[LEGACY_PREFIX]);
  if (typeof mainId !== "string" || !wsf) return null;
  return {
    mainId,
    activeSteer: wsf.activeSteer,
    checkpoint:
      asRecord(meta[CHECKPOINT_KEY]) ?? asRecord(meta[LEGACY_CHECKPOINT_KEY]),
    entries: asRecord(meta[AGENTS_KEY]) ?? {},
    workers: asRecord((meta as Record<string, unknown>)[WORKERS_KEY as string]) ?? {},
  };
}

/** The agent's supervision register state, if any (C5 skips protected ones). */
function workerStateOf(workers: Record<string, unknown>, agentId: string): string | null {
  const state = asRecord(workers[agentId])?.state;
  return typeof state === "string" ? state : null;
}

/**
 * Scope workers with unfinished state (running/blocked/interrupted). A steer
 * with none is at a package boundary (fresh hint); any open worker means the
 * package is still in flight (compact while warm).
 */
function openWorkerCount(workers: Record<string, unknown>): number {
  let count = 0;
  for (const value of Object.values(workers)) {
    if (isSupervisionProtectedState(asRecord(value)?.state)) count += 1;
  }
  return count;
}

export interface SweepResult {
  agentId: string;
  action: string;
  sent: boolean;
  reason: string;
}

export interface SweepDeps {
  paseo: any;
  settings: CleanupSettings;
  nowMs?: number;
  log?: (message: string) => void;
  /** Quota snapshot override; tests only (defaults to the sampled one). */
  quotaSnapshot?: Record<string, any> | null;
  /** Explicit ZeroSub state (tests); undefined resolves through getZerosub. */
  zerosub?: ZerosubState;
  /** Fail-soft ZeroSub supplier for the per-account compact check. */
  getZerosub?: () => Promise<ZerosubState>;
  /** Exhaustion threshold for the compact check; the quota default applies. */
  exhaustedPct?: number;
  /** Lock for the entry write; tests only (defaults to the real one). */
  lock?: (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>;
  /** Same-tab rewind runner; tests only (defaults to the synced rewind core). */
  rewindFn?: (agentId: string) => Promise<{ status: string; messageId?: string; error?: string }>;
}

export interface CleanupQuotaCheck {
  /** Agent to resolve through the ZeroSub routes; without it the pool fallback applies. */
  agentId?: string | null;
  /** Normalized ZeroSub state; null/undefined keeps the provider-pool check. */
  zerosub?: ZerosubState;
  /** Exhaustion threshold; the quota default applies without it. */
  exhaustedPct?: number;
  nowMs?: number;
}

/**
 * True only with a quota reading that shows headroom. Checks the ZeroSub
 * account the agent actually runs on (the pending move account wins as the
 * live session, else the agent route) and falls back to the provider pool
 * only when no route is known. Missing entries and unsupported telemetry
 * are unknown.
 */
export function quotaAvailableForCleanup(
  provider: string,
  snapshot: Record<string, any> | null | undefined,
  opts: CleanupQuotaCheck = {},
): boolean | null {
  const nowMs = Number.isFinite(opts.nowMs) ? (opts.nowMs as number) : Date.now();
  const exhaustedPct = Number.isFinite(opts.exhaustedPct)
    ? (opts.exhaustedPct as number)
    : QUOTA_DEFAULTS.exhaustedPct;
  const agentId = typeof opts.agentId === "string" && opts.agentId ? opts.agentId : null;
  const zerosub = opts.zerosub ?? null;
  if (agentId && zerosub) {
    const liveId = zerosub.pending?.[agentId] ?? zerosub.agentAccount?.[agentId] ?? null;
    const account =
      typeof liveId === "string" && liveId
        ? ((zerosub.accounts ?? []).find((entry: any) => entry?.id === liveId) ?? null)
        : null;
    if (account) {
      if (accountExhausted(account, { exhaustedPct, now: nowMs })) return false;
      return freshMaxUsedPct(account, nowMs) !== null ? true : null;
    }
  }
  const entry = quotaEntry(snapshot, provider);
  if (!entry) return null;
  if (quotaExhausted(snapshot, provider, exhaustedPct, nowMs)) return false;
  return quotaPct(entry) !== null || entry.unlimited === true ? true : null;
}

/**
 * One C5 sweep over all live agents. Evaluates every agent against the pure
 * decision, re-checks candidates against fresh snapshots right before
 * sending, sends through the plugin SDK only, and records pendingAction
 * (plus the previous session id for clear) under the workspace lock.
 * `fresh-recommended` decisions are recorded as hints without sending,
 * except when `rewindFresh` executes them as a same-tab rewind for providers
 * without native /clear (Codex; Claude keeps /clear).
 */
export async function sweepOnce({
  paseo,
  settings,
  nowMs = Date.now(),
  log = console.log,
  quotaSnapshot,
  zerosub: zerosubOverride,
  getZerosub,
  exhaustedPct,
  lock,
  rewindFn,
}: SweepDeps): Promise<SweepResult[]> {
  // A mode change re-probes after an effect failure.
  if (lastMode !== null && lastMode !== settings.mode) effectBlock = null;
  lastMode = settings.mode;
  if (settings.mode === "off" || effectBlock) return [];
  const results: SweepResult[] = [];
  let state: any;
  try {
    state = await readPaseoState(paseo);
  } catch (error) {
    log(
      `[factory] idle cleanup: cannot read daemon state (${error instanceof Error ? error.message : String(error)}); skip`,
    );
    return [];
  }
  const lookup: ScopeLookup = {
    scopes: listScopes(state),
    byId: new Map(),
  };
  for (const scope of lookup.scopes) lookup.byId.set(scope.id, scope);
  const liveIds = (state.agents ?? []).map((agent: any) => agent.id);
  const sampledAt = getQuotaSampledAt();
  const sampleIsFresh = sampledAt !== null && nowMs - sampledAt >= 0 && nowMs - sampledAt <= 30 * 60_000;
  const quota = quotaSnapshot !== undefined ? quotaSnapshot : sampleIsFresh ? getQuotaSnapshot() : null;
  const zerosub = zerosubOverride !== undefined ? zerosubOverride : await resolveZerosub({ getZerosub });
  const quotaCtx = { zerosub, exhaustedPct };
  for (const agent of state.agents ?? []) {
    try {
      const result = await sweepAgent(paseo, agent, state, lookup, liveIds, settings, nowMs, log, quota, quotaCtx, lock, rewindFn);
      if (result) results.push(result);
    } catch (error) {
      log(
        `[factory] idle cleanup: ${agent?.id ?? "?"} failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return results;
}

/** Records the fresh hint (once per idle period); shared by the hint-only path and the rewind fallback. */
async function recordFreshHint(
  paseo: any,
  mainId: string,
  agentId: string,
  reason: string,
  liveIds: string[],
  lock?: (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>,
): Promise<void> {
  await updateEntry({
    client: paseo,
    workspaceId: mainId,
    agentId,
    patch: {
      freshHint: { at: new Date().toISOString(), reason: reason.slice(0, MAX_FRESH_REASON) },
    },
    liveIds,
    ...(lock ? { lock } : {}),
  });
}

async function sweepAgent(
  paseo: any,
  agent: any,
  state: any,
  lookup: ScopeLookup,
  liveIds: string[],
  settings: CleanupSettings,
  nowMs: number,
  log: (message: string) => void,
  quota: Record<string, any> | null,
  quotaCtx: { zerosub?: ZerosubState; exhaustedPct?: number } = {},
  lock?: (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>,
  rewindFn?: (agentId: string) => Promise<{ status: string; messageId?: string; error?: string }>,
): Promise<SweepResult | null> {
  const scope = scopeForAgent(agent, lookup);
  const reads = scope ? scopeReads(scope) : null;
  if (!scope || !reads) return null;
  const entry = asRecord(reads.entries[agent.id]);
  const first = decideCleanupAction(
    cleanupInputOf({
      agent,
      entry,
      ...agentContextInputs(agent, entry, settings, quotaCtx.zerosub ?? null, nowMs),
      checkpoint: reads.checkpoint,
      activeSteer: reads.activeSteer,
      settings,
      actionsToday: actionsToday(nowMs),
      effectBlocked: isEffectBlocked(),
      nowMs,
      workerState: workerStateOf(reads.workers, agent.id),
      quotaAvailable: quotaAvailableForCleanup(agent?.provider, quota, {
        agentId: typeof agent?.id === "string" ? agent.id : null,
        zerosub: quotaCtx.zerosub ?? null,
        exhaustedPct: quotaCtx.exhaustedPct,
        nowMs,
      }),
      openWorkers: openWorkerCount(reads.workers),
    }),
  );
  if (!first.action) {
    if (first.reason === "provider quota is unknown") log(`[factory] idle cleanup: skipped compact for ${agent.id} (${first.reason})`);
    return null;
  }
  const modelOf = (snapshot: any): string | null =>
    typeof snapshot?.model === "string" ? snapshot.model : null;
  const wantRewind = shouldRewindFresh({
    action: first.action,
    provider: agent?.provider,
    model: modelOf(agent),
    settings,
  });
  if (first.action === "fresh-recommended" && !wantRewind) {
    // Hint only: record it (once per idle period, via the decision's
    // cooldown) without sending, capping, or re-checking — the write is
    // idempotent and the next real turn clears it.
    try {
      await recordFreshHint(paseo, reads.mainId, agent.id, first.reason, liveIds, lock);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[factory] idle cleanup: fresh hint for ${agent.id} not recorded (${message})`);
      return { agentId: agent.id, action: first.action, sent: false, reason: message };
    }
    log(`[factory] idle cleanup: fresh recommended for ${agent.id} (${first.reason})`);
    return { agentId: agent.id, action: first.action, sent: false, reason: first.reason };
  }
  if (!first.command && !wantRewind) return null;
  // Re-check against a fresh snapshot and fresh metadata right before sending.
  const freshSnap: any = await paseo.agents.ref(agent.id).refresh().catch(() => null);
  const freshAgent: any = freshSnap?.agent ?? null;
  if (!freshAgent) return null;
  const freshMeta = (await paseo.workspaces.ref(reads.mainId).refresh().catch(() => null))?.metadata ?? {};
  const freshWsf = asRecord(freshMeta[METADATA_KEY]) ?? asRecord(freshMeta[LEGACY_PREFIX]);
  if (!freshWsf) return null;
  const freshEntries = asRecord(freshMeta[AGENTS_KEY]) ?? {};
  const freshEntry = asRecord(freshEntries[agent.id]);
  const freshWorkers = asRecord((freshMeta as Record<string, unknown>)[WORKERS_KEY as string]) ?? {};
  const recheckAt = Date.now();
  const recheck = decideCleanupAction(
    cleanupInputOf({
      agent: freshAgent,
      entry: freshEntry,
      ...agentContextInputs(freshAgent, freshEntry, settings, quotaCtx.zerosub ?? null, recheckAt),
      checkpoint: asRecord(freshMeta[CHECKPOINT_KEY]) ?? asRecord(freshMeta[LEGACY_CHECKPOINT_KEY]),
      activeSteer: freshWsf.activeSteer,
      settings,
      actionsToday: actionsToday(recheckAt),
      effectBlocked: isEffectBlocked(),
      nowMs: recheckAt,
      workerState: workerStateOf(freshWorkers, agent.id),
      quotaAvailable: quotaAvailableForCleanup(freshAgent?.provider, quota, {
        agentId: typeof agent?.id === "string" ? agent.id : null,
        zerosub: quotaCtx.zerosub ?? null,
        exhaustedPct: quotaCtx.exhaustedPct,
        nowMs: recheckAt,
      }),
      openWorkers: openWorkerCount(freshWorkers),
    }),
  );
  if (wantRewind) {
    // Same-tab rewind for a fresh-recommended compact-only agent (Codex, no
    // native /clear): re-checked like a send, recorded as cleared/refreshed
    // with mode rewind (no brief is sent; the agent resumes from its
    // checkpoint). A pending action or a moved-on decision stops the rewind,
    // exactly like a send.
    if (recheck.action !== "fresh-recommended") return null;
    if (
      !shouldRewindFresh({
        action: recheck.action,
        provider: freshAgent?.provider,
        model: modelOf(freshAgent),
        settings,
      })
    ) {
      return null;
    }
    const run = rewindFn ?? rewindTab;
    let outcome: { status: string; messageId?: string; error?: string };
    try {
      outcome = await run(agent.id);
    } catch (error) {
      outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    if (outcome?.status === "rewound") {
      const checkpoint =
        asRecord(freshMeta[CHECKPOINT_KEY]) ?? asRecord(freshMeta[LEGACY_CHECKPOINT_KEY]);
      try {
        await updateEntry({
          client: paseo,
          workspaceId: reads.mainId,
          agentId: agent.id,
          patch: buildRewind({ checkpoint, messageId: outcome.messageId ?? null, briefMessageId: null }),
          liveIds,
          ...(lock ? { lock } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[factory] idle cleanup: rewind of ${agent.id} not recorded (${message})`);
        return { agentId: agent.id, action: "rewind", sent: false, reason: message };
      }
      countAction(nowMs);
      const reason = `rewound ${agent.id} to ${outcome.messageId ?? "first user message"} (fresh-recommended executed as rewind)`;
      log(`[factory] idle cleanup: ${reason}`);
      return { agentId: agent.id, action: "rewind", sent: true, reason };
    }
    if (outcome?.status === "failed") {
      const at = new Date().toISOString();
      const error = String(outcome.error ?? "rewind failed").slice(0, 300);
      await updateEntry({
        client: paseo,
        workspaceId: reads.mainId,
        agentId: agent.id,
        patch: { lastActionFailed: { at, error } },
        liveIds,
        ...(lock ? { lock } : {}),
      }).catch(() => null);
      log(`[factory] idle cleanup: rewind of ${agent.id} failed (${error}); retry needs a new real turn`);
      return { agentId: agent.id, action: "fresh-recommended", sent: false, reason: `rewind failed: ${error}` };
    }
    // No rewind point, unsupported provider, or unreachable daemon: hint-only
    // fallback, exactly like a disabled setting.
    try {
      await recordFreshHint(paseo, reads.mainId, agent.id, recheck.reason, liveIds, lock);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[factory] idle cleanup: fresh hint for ${agent.id} not recorded (${message})`);
      return { agentId: agent.id, action: "fresh-recommended", sent: false, reason: message };
    }
    log(`[factory] idle cleanup: fresh recommended for ${agent.id} (${recheck.reason})`);
    return { agentId: agent.id, action: "fresh-recommended", sent: false, reason: recheck.reason };
  }
  if (!recheck.action || !recheck.command) return null;
  const kind = recheck.action === "clear" ? "clear" : "compact";
  const sessionId =
    typeof freshAgent?.persistence?.sessionId === "string"
      ? (freshAgent.persistence.sessionId as string)
      : null;
  try {
    await runCleanup(paseo, agent.id, kind, SWEEP_PENDING_REASON, {
      workspaceId: reads.mainId,
      liveIds,
      sessionId,
      previousSessions: freshEntry?.previousSessions,
      ...(lock ? { lock } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[factory] idle cleanup: send to ${agent.id} failed (${message}); retry needs a new real turn`);
    return { agentId: agent.id, action: recheck.action, sent: false, reason: message };
  }
  countAction(nowMs);
  log(`[factory] idle cleanup: sent ${recheck.action} to ${agent.id}`);
  return { agentId: agent.id, action: recheck.action, sent: true, reason: recheck.reason };
}

export type CleanupKind = "clear" | "compact";

export interface RunCleanupOptions {
  /** Main workspace id; resolved from the agent labels when absent. */
  workspaceId?: string;
  liveIds?: string[] | null;
  /** Pre-clear session id; read from the agent snapshot when absent. */
  sessionId?: string | null;
  /** Known previous sessions; read from fresh metadata when absent. */
  previousSessions?: unknown;
  /** F4 wake note, carried on pendingAction until the turn hook sends the brief. */
  note?: string;
  /** Lock for the entry write; tests only (defaults to the real one). */
  lock?: (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>;
}

export interface RunCleanupResult {
  workspaceId: string;
  sessionId: string | null;
  kind: CleanupKind;
  reason: string;
}

/**
 * Sends one cleanup command and records pendingAction (plus the previous
 * session id for clear). Shared by the C5 sweep (reason "idle") and manual
 * `/factory resume` (reason "resume", which makes the turn hook send the full
 * brief instead of the seed). On send failure the entry gains lastActionFailed
 * and the original error is rethrown. Daily-cap counting stays with the sweep:
 * manual resume is not capped.
 */
export async function runCleanup(
  paseo: any,
  agentId: string,
  kind: CleanupKind,
  reason: string,
  opts: RunCleanupOptions = {},
): Promise<RunCleanupResult> {
  let workspaceId = opts.workspaceId ?? null;
  let liveIds: string[] | null = opts.liveIds ?? null;
  let previous: unknown = opts.previousSessions;
  if (!workspaceId) {
    const state: any = await readPaseoState(paseo);
    const agent: any = (state.agents ?? []).find((a: any) => a?.id === agentId) ?? null;
    if (!agent) throw new Error(`Unknown agent ${JSON.stringify(agentId)}`);
    const identity = cleanupIdentity(agent.labels ?? null);
    if (!identity) throw new Error(`Agent ${agentId} is not a factory steer or worker`);
    const scope: any =
      listScopes(state).find((s: any) => s.id === identity.scopeId) ?? null;
    if (!scope) throw new Error(`Agent ${agentId} has no live factory scope`);
    workspaceId = scope.workspaceId;
    liveIds = (state.agents ?? []).map((a: any) => a.id);
    previous ??= asRecord(asRecord(scope.workspace?.metadata?.[AGENTS_KEY])?.[agentId])
      ?.previousSessions;
  }
  if (!workspaceId) throw new Error(`Agent ${agentId} has no live factory scope`);
  let sessionId: string | null;
  if (opts.sessionId !== undefined) {
    sessionId = opts.sessionId;
  } else {
    const snap: any = await paseo.agents.ref(agentId).refresh().catch(() => null);
    const current = snap?.agent?.persistence?.sessionId;
    sessionId = typeof current === "string" ? current : null;
  }
  if (previous === undefined) {
    const freshMeta =
      (await paseo.workspaces.ref(workspaceId).refresh().catch(() => null))?.metadata ?? {};
    previous = asRecord(asRecord(freshMeta[AGENTS_KEY])?.[agentId])?.previousSessions;
  }
  const at = new Date().toISOString();
  const pendingAction: Record<string, unknown> = { kind, at, sessionId, reason };
  if (typeof opts.note === "string" && opts.note) pendingAction.note = opts.note.slice(0, 1500);
  const patch: Record<string, unknown> = { pendingAction, actionVerified: null };
  if (kind === "clear") {
    patch.previousSessions = pushPreviousSession(
      Array.isArray(previous) ? (previous as string[]) : null,
      sessionId,
    );
  }
  await updateEntry({
    client: paseo,
    workspaceId,
    agentId,
    patch,
    liveIds,
    ...(opts.lock ? { lock: opts.lock } : {}),
  });
  try {
    await sendCleanupCommand(paseo, agentId, kind === "clear" ? CLEAR_COMMAND : COMPACT_COMMAND);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateEntry({
      client: paseo,
      workspaceId,
      agentId,
      patch: { pendingAction: null, lastActionFailed: { at, error: message.slice(0, 300) } },
      liveIds,
      ...(opts.lock ? { lock: opts.lock } : {}),
    }).catch(() => null);
    throw error;
  }
  return { workspaceId, sessionId, kind, reason };
}

export interface TimerDeps {
  readSettings: () => Promise<CleanupSettings | null>;
  intervalMs?: number;
  log?: (message: string) => void;
  /** Fail-soft ZeroSub supplier for the per-account compact check. */
  getZerosub?: () => Promise<ZerosubState>;
  /** Quota settings supplier for the exhaustion threshold (defaults apply). */
  getQuotaSettings?: () => Promise<any>;
}

/** Fail-soft exhaustion threshold from the quota settings, else the default. */
async function sweepThreshold(getQuotaSettings?: () => Promise<any>): Promise<number | undefined> {
  if (!getQuotaSettings) return undefined;
  try {
    const pct = Number((await getQuotaSettings())?.quota?.exhaustedPct);
    return Number.isFinite(pct) ? pct : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs sweepOnce on an interval; the remover stops it (server cleanup).
 * Ticks idle until a hook, RPC, or subscription context lends a daemon handle.
 */
export function startCleanupTimer({
  readSettings,
  intervalMs = CACHE_CHECK_INTERVAL_MS,
  log = console.log,
  getZerosub,
  getQuotaSettings,
}: TimerDeps): () => void {
  let stopped = false;
  let sweeping = false;
  const timer = setInterval(() => {
    if (stopped || sweeping || !sweepPaseo) return;
    sweeping = true;
    const paseo: any = sweepPaseo;
    void (async () => {
      try {
        const settings = await readSettings();
        if (!settings) return;
        const exhaustedPct = await sweepThreshold(getQuotaSettings);
        await sweepOnce({
          paseo,
          settings,
          log,
          ...(getZerosub ? { getZerosub } : {}),
          ...(exhaustedPct !== undefined ? { exhaustedPct } : {}),
        });
      } catch (error) {
        log(
          `[factory] idle cleanup tick failed (${error instanceof Error ? error.message : String(error)})`,
        );
      } finally {
        sweeping = false;
      }
    })();
  }, intervalMs);
  if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export interface ColdAgent {
  workspaceId: string;
  agentId: string;
  title: string | null;
  contextTokens: number;
  idleMinutes: number;
  warmth: CacheWarmth;
  large: boolean;
  hasHistory: boolean;
  canFresh: boolean;
  /** Why the row needs attention; plain cold rows carry "cold". */
  reason: NeedsResumeReason;
  /** Valid stored fresh recommendation; null when none (needsResume still wins the reason). */
  freshHint: string | null;
  /** Own slot letter (steers), so the client can name a takeover. */
  slot: string | null;
  /** The scope's active steer slot, so a non-active reminder can name it. */
  activeSteer: string | null;
  /** Advisor steers never take over, so they keep the active reminder text. */
  advisor: boolean;
}

export interface ColdFeedDeps {
  readSettings: () => Promise<CleanupSettings | null>;
  intervalMs?: number;
  /** Effective config for the advisor flag; absent means no advisor known. */
  getConfig?: () => Promise<unknown>;
  getZerosub?: () => Promise<ZerosubState>;
}

/**
 * Serves the factory.attention subscription (factory.cold stays as an alias):
 * pushes the attention list on subscribe and every minute after. Returns
 * void — settling a promise would close the subscription. Also lends the
 * daemon handle to the sweep timer.
 */
export function serveColdSubscription(
  _input: unknown,
  context: { paseo: any; push: (event: any) => Promise<void>; signal: AbortSignal },
  deps: ColdFeedDeps,
): void {
  captureSweepPaseo(context.paseo);
  let stopped = false;
  const push = async (): Promise<void> => {
    if (stopped) return;
    try {
      const settings = await deps.readSettings();
      if (!settings) return;
      const config = deps.getConfig ? await deps.getConfig().catch(() => null) : null;
      const zerosub = await resolveZerosub(deps);
      const cold = await collectColdAgents(context.paseo, settings, Date.now(), config, zerosub);
      await context.push({
        attention: cold,
        cold,
        autoDisabled: isEffectBlocked(),
        autoDisabledReason: effectBlockReason() ?? undefined,
      });
    } catch {
      // A failed push surfaces through the subscription lifecycle; retry next tick.
    }
  };
  void push();
  const timer = setInterval(() => void push(), deps.intervalMs ?? CACHE_CHECK_INTERVAL_MS);
  if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  context.signal.addEventListener(
    "abort",
    () => {
      stopped = true;
      clearInterval(timer);
    },
    { once: true },
  );
}

/**
 * Factory agents that are cold right now (C6): idle past the threshold with
 * a context worth cleaning, and no C5 action already pending for them. An
 * idle agent with a valid stored fresh recommendation is listed as well,
 * even below the cold threshold; needsResume keeps its reason precedence.
 */
export async function collectColdAgents(
  paseo: any,
  settings: CleanupSettings,
  nowMs: number = Date.now(),
  config: unknown = null,
  zerosub: ZerosubState = null,
): Promise<ColdAgent[]> {
  const state: any = await readPaseoState(paseo);
  const lookup: ScopeLookup = { scopes: listScopes(state), byId: new Map() };
  for (const scope of lookup.scopes) lookup.byId.set(scope.id, scope);
  const cold: ColdAgent[] = [];
  for (const agent of state.agents ?? []) {
    const identity = cleanupIdentity(agent?.labels ?? null) ?? workerIdentityFromMetadata(agent);
    if (!identity) continue;
    const scope = lookup.byId.get(identity.scopeId) ?? null;
    const reads = scope ? scopeReads(scope) : null;
    if (!scope || !reads) continue;
    const entry = asRecord(reads.entries[agent.id]);
    if (agent.archivedAt || entry?.replacedBy) continue;
    const needsResume = asRecord(entry?.needsResume);
    const needsReason = isNeedsResumeReason(needsResume?.reason)
      ? (needsResume.reason as NeedsResumeReason)
      : null;
    // A resume in flight still shows its pill (the RPC is idempotent); plain
    // cold rows with a pending C5 action stay hidden as before.
    if (!needsReason && entry?.pendingAction) continue;
    const projected = projectAgentContext(agentContextInputs(agent, entry, settings, zerosub, nowMs));
    const coldNow = isCold(projected.warmth.warmth, projected.large);
    // A valid stored recommendation surfaces its idle agent even when the
    // generic cold threshold is not met. Non-idle agents keep the old shape:
    // cold/needsResume rows without the hint.
    const fresh = agent?.status === "idle" ? currentFreshHint(entry) : null;
    if (!coldNow && !needsReason && !fresh) continue;
    const previous = entry?.previousSessions;
    const slot = identity.role === "steer" && typeof identity.slot === "string" ? identity.slot : null;
    const activeSteer = typeof reads.activeSteer === "string" ? reads.activeSteer : null;
    cold.push({
      workspaceId: reads.mainId,
      agentId: agent.id,
      title: typeof agent.title === "string" ? agent.title : null,
      contextTokens: projected.tokens ?? 0,
      idleMinutes: Math.floor((projected.ageMs ?? 0) / 60_000),
      warmth: projected.warmth.warmth,
      large: projected.large,
      hasHistory: Array.isArray(previous) && previous.length > 0,
      canFresh: slot !== null && slot === activeSteer,
      reason: needsReason ?? "cold",
      freshHint: fresh,
      slot,
      activeSteer,
      advisor: slot !== null && isAdvisorSlotOf(config, slot),
    });
  }
  return cold;
}
