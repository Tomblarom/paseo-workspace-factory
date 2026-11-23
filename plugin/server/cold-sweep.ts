import { AGENTS_KEY, updateAgentEntry } from "./factory/agent-state.js";
import { LEGACY_PREFIX, METADATA_KEY, readPaseoState } from "./factory/paseo.js";
import { listScopes } from "./factory/scope.js";
import {
  cleanupIdentity,
  cleanupInputOf,
  decideCleanupAction,
  isCold,
  pushPreviousSession,
  sendCleanupCommand,
  type CleanupSettings,
} from "../shared/idle-cleanup.js";

const CHECKPOINT_KEY = `${METADATA_KEY}.checkpoint`;
const LEGACY_CHECKPOINT_KEY = `${LEGACY_PREFIX}.checkpoint`;

// The synced core is unchecked (@ts-nocheck): its inferred parameter types are
// too narrow for real calls, so the sweep talks to it as any (as handlers do).
const updateEntry = updateAgentEntry as unknown as (args: any) => Promise<any>;

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
  };
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
}

/**
 * One C5 sweep over all live agents. Evaluates every agent against the pure
 * decision, re-checks candidates against fresh snapshots right before
 * sending, sends through the plugin SDK only, and records pendingAction
 * (plus the previous session id for clear) under the workspace lock.
 */
export async function sweepOnce({
  paseo,
  settings,
  nowMs = Date.now(),
  log = console.log,
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
  for (const agent of state.agents ?? []) {
    try {
      const result = await sweepAgent(paseo, agent, state, lookup, liveIds, settings, nowMs, log);
      if (result) results.push(result);
    } catch (error) {
      log(
        `[factory] idle cleanup: ${agent?.id ?? "?"} failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return results;
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
): Promise<SweepResult | null> {
  const scope = scopeForAgent(agent, lookup);
  const reads = scope ? scopeReads(scope) : null;
  if (!scope || !reads) return null;
  const entry = asRecord(reads.entries[agent.id]);
  const first = decideCleanupAction(
    cleanupInputOf({
      agent,
      entry,
      checkpoint: reads.checkpoint,
      activeSteer: reads.activeSteer,
      settings,
      actionsToday: actionsToday(nowMs),
      effectBlocked: isEffectBlocked(),
      nowMs,
    }),
  );
  if (!first.action || !first.command) return null;
  // Re-check against a fresh snapshot and fresh metadata right before sending.
  const freshSnap: any = await paseo.agents.ref(agent.id).refresh().catch(() => null);
  const freshAgent: any = freshSnap?.agent ?? null;
  if (!freshAgent) return null;
  const freshMeta = (await paseo.workspaces.ref(reads.mainId).refresh().catch(() => null))?.metadata ?? {};
  const freshWsf = asRecord(freshMeta[METADATA_KEY]) ?? asRecord(freshMeta[LEGACY_PREFIX]);
  if (!freshWsf) return null;
  const freshEntries = asRecord(freshMeta[AGENTS_KEY]) ?? {};
  const freshEntry = asRecord(freshEntries[agent.id]);
  const recheck = decideCleanupAction(
    cleanupInputOf({
      agent: freshAgent,
      entry: freshEntry,
      checkpoint: asRecord(freshMeta[CHECKPOINT_KEY]) ?? asRecord(freshMeta[LEGACY_CHECKPOINT_KEY]),
      activeSteer: freshWsf.activeSteer,
      settings,
      actionsToday: actionsToday(Date.now()),
      effectBlocked: isEffectBlocked(),
      nowMs: Date.now(),
    }),
  );
  if (!recheck.action || !recheck.command) return null;
  const kind = recheck.action === "clear" ? "clear" : "compact";
  const sessionId =
    typeof freshAgent?.persistence?.sessionId === "string"
      ? (freshAgent.persistence.sessionId as string)
      : null;
  const at = new Date().toISOString();
  try {
    await sendCleanupCommand(paseo, agent.id, recheck.command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateEntry({
      client: paseo,
      workspaceId: reads.mainId,
      agentId: agent.id,
      patch: { lastActionFailed: { at, error: message.slice(0, 300) } },
      liveIds,
    }).catch(() => null);
    log(`[factory] idle cleanup: send to ${agent.id} failed (${message}); retry needs a new real turn`);
    return { agentId: agent.id, action: recheck.action, sent: false, reason: message };
  }
  countAction(nowMs);
  const patch: Record<string, unknown> = {
    pendingAction: { kind, at, sessionId },
  };
  if (kind === "clear") {
    const previous = freshEntry?.previousSessions;
    patch.previousSessions = pushPreviousSession(
      Array.isArray(previous) ? (previous as string[]) : null,
      sessionId,
    );
  }
  await updateEntry({
    client: paseo,
    workspaceId: reads.mainId,
    agentId: agent.id,
    patch,
    liveIds,
  });
  log(`[factory] idle cleanup: sent ${recheck.action} to ${agent.id}`);
  return { agentId: agent.id, action: recheck.action, sent: true, reason: recheck.reason };
}

export interface TimerDeps {
  readSettings: () => Promise<CleanupSettings | null>;
  intervalMs?: number;
  log?: (message: string) => void;
}

/**
 * Runs sweepOnce on an interval; the remover stops it (server cleanup).
 * Ticks idle until a hook, RPC, or subscription context lends a daemon handle.
 */
export function startCleanupTimer({
  readSettings,
  intervalMs = 5 * 60_000,
  log = console.log,
}: TimerDeps): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || !sweepPaseo) return;
    const paseo: any = sweepPaseo;
    void (async () => {
      try {
        const settings = await readSettings();
        if (!settings) return;
        await sweepOnce({ paseo, settings, log });
      } catch (error) {
        log(
          `[factory] idle cleanup tick failed (${error instanceof Error ? error.message : String(error)})`,
        );
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
  hasHistory: boolean;
  canFresh: boolean;
}

export interface ColdFeedDeps {
  readSettings: () => Promise<CleanupSettings | null>;
  intervalMs?: number;
}

/**
 * Serves the factory.cold subscription (C6): pushes the cold list on
 * subscribe and every minute after. Returns void — settling a promise would
 * close the subscription. Also lends the daemon handle to the sweep timer.
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
      const cold = await collectColdAgents(context.paseo, settings);
      await context.push({
        cold,
        autoDisabled: isEffectBlocked(),
        autoDisabledReason: effectBlockReason() ?? undefined,
      });
    } catch {
      // A failed push surfaces through the subscription lifecycle; retry next tick.
    }
  };
  void push();
  const timer = setInterval(() => void push(), deps.intervalMs ?? 60_000);
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
 * a context worth cleaning, and no C5 action already pending for them.
 */
export async function collectColdAgents(
  paseo: any,
  settings: CleanupSettings,
  nowMs: number = Date.now(),
): Promise<ColdAgent[]> {
  const state: any = await readPaseoState(paseo);
  const lookup: ScopeLookup = { scopes: listScopes(state), byId: new Map() };
  for (const scope of lookup.scopes) lookup.byId.set(scope.id, scope);
  const cold: ColdAgent[] = [];
  for (const agent of state.agents ?? []) {
    const identity = cleanupIdentity(agent?.labels ?? null);
    if (!identity) continue;
    const scope = lookup.byId.get(identity.scopeId) ?? null;
    const reads = scope ? scopeReads(scope) : null;
    if (!scope || !reads) continue;
    const entry = asRecord(reads.entries[agent.id]);
    if (entry?.pendingAction) continue;
    const used = agent?.lastUsage?.contextWindowUsedTokens;
    const contextTokens =
      typeof used === "number" && Number.isFinite(used)
        ? used
        : typeof entry?.contextTokens === "number"
          ? (entry.contextTokens as number)
          : null;
    const lastTurnEndedAt =
      typeof entry?.lastTurnEndedAt === "string" ? (entry.lastTurnEndedAt as string) : null;
    if (
      !isCold({
        lastTurnEndedAt,
        contextTokens,
        idleMinutes: settings.idleMinutes,
        minContextTokens: settings.minContextTokens,
        nowMs,
      }) ||
      contextTokens === null ||
      lastTurnEndedAt === null
    ) {
      continue;
    }
    const previous = entry?.previousSessions;
    cold.push({
      workspaceId: reads.mainId,
      agentId: agent.id,
      title: typeof agent.title === "string" ? agent.title : null,
      contextTokens,
      idleMinutes: Math.floor((nowMs - Date.parse(lastTurnEndedAt)) / 60_000),
      hasHistory: Array.isArray(previous) && previous.length > 0,
      canFresh:
        identity.role === "steer" &&
        typeof identity.slot === "string" &&
        identity.slot === reads.activeSteer,
    });
  }
  return cold;
}
