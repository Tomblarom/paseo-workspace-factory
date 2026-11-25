// Worker supervision (S-B) plugin side: registration on agent.create.after,
// register transitions on agent.turn.after, immediate and debounced wakes to the
// steer that is active at send time, a watchdog timer (stale marking,
// unanswered-wake failover), and the post-boot combined wake. Workers belong
// to the scope, so every decision re-reads the scope state; the plugin never
// archives (the wake text tells the steer to archive accepted workers) and
// never wakes background agents. Design: docs/design/supervision-design.md.
//
// All register rules come from the synced core (./factory/supervision.js,
// single source src/supervision.mjs, mirrored by `node scripts/plugin-sync.mjs`)
// and are never duplicated here; plugin-only text and scans live in
// ../shared/supervise.ts. Only erasable TypeScript: node --test imports this
// file with type stripping (see plugin/test/ts-resolve-hooks.mjs).
import { deliverSteer, finishSteerDelivery, pendingSteerDelivery, type EventBatch, type SteerDeliveryDeps } from "./steer-delivery.js";
import * as paseoCore from "./factory/paseo.js";
import { setTimeout as delay } from "node:timers/promises";
import * as scopeCore from "./factory/scope.js";
import * as lockCore from "./factory/lock.js";
import * as supervisionCore from "./factory/supervision.js";
import * as agentStateCore from "./factory/agent-state.js";
import * as steerCore from "./factory/steer.js";
import * as quotaCore from "./factory/quota.js";

// The synced core is unchecked (@ts-nocheck): its inferred parameter types are
// too narrow for real calls, so supervision talks to it as any (as the sweep
// and handlers do).
const P = paseoCore as unknown as Record<string, any>;
const SC = scopeCore as unknown as Record<string, any>;
const L = lockCore as unknown as Record<string, any>;
const S = supervisionCore as unknown as Record<string, any>;
const AS = agentStateCore as unknown as Record<string, any>;
const ST = steerCore as unknown as Record<string, any>;
const Q = quotaCore as unknown as Record<string, any>;
const { LEGACY_PREFIX, METADATA_KEY, readPaseoState } = P;
const { listScopes, sameScopeId } = SC;
const { LockBusy, withLock, workspaceLockName } = L;
const {
  canWakeAgent,
  clipTask,
  collectPendingWakes,
  eventForRestartReason,
  exhaustedWakeDecision,
  failoverChain,
  formatWakeMessage,
  isBatchDue,
  markWakeSent,
  openWorkers,
  planWake,
  queuePendingWake,
  readWorkers,
  registerWorker,
  removeWorker,
  resolveWakeTarget,
  shouldMarkStale,
  turnEndEvent,
  updateWorkerEntry,
  workersReport,
  zerosubMoveDecision,
  zerosubPendingTarget,
} = S;
const { AGENTS_KEY } = AS;
const { lastAssistantText, parseCheckpointBlock, proactiveSwitchDecision } = ST;
const { accountForAgent, formatQuotaLine, profilePool, quotaExhausted } = Q;
import { factoryIdentity } from "../shared/auto-checkpoint.js";
import { getQuotaSnapshot } from "./quota.js";
import {
  findZerosubSwitch,
  futureWakeAtMs,
  resolveZerosub,
  zerosubForkWarning,
  zerosubSwitchFollowup,
  type ZerosubSource,
  type ZerosubSwitchRow,
} from "./zerosub-runtime.js";
import {
  DRAIN_METADATA_KEY,
  WORKER_METADATA_KEY,
  buildWorkerMetadata,
  escalationHintLine,
  firstUserText,
  formatScopeTakeover,
  formatSteerTakeover,
  hasAdvisorRequest,
  isDrainMarkerActive,
  isWorkerMetadata,
  workerIdentityFromMetadata,
  maxStampMs,
  scopeLastWakeAt,
  selectDoneIds,
  steerWakeResponse,
  withArchiveHint,
  type SupervisionSettings,
} from "../shared/supervise.js";

const CHECKPOINT_KEY = `${METADATA_KEY}.checkpoint`;
const LEGACY_CHECKPOINT_KEY = `${LEGACY_PREFIX}.checkpoint`;
const OWNER_KEY = "wsf.owner";
const LEGACY_OWNER_KEY = "ari.wsf.owner";
const BUSY_STATUSES = ["running", "initializing"];
const FACTORY_CMD = "paseo-factory";

export interface SettingsSource {
  settings?: SupervisionSettings | null;
  getSettings?: () => Promise<SupervisionSettings | null>;
  getConfig?: () => Promise<any>;
}

export interface SuperviseDeps extends SettingsSource, ZerosubSource {
  nowIso?: string;
  nowMs?: number;
  factoryCmd?: string;
  draining?: boolean;
  bootCheckDone?: boolean;
  lock?: (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>;
  log?: (message: string) => void;
  delivery?: SteerDeliveryDeps;
  /**
   * Rebuilds the resume brief for a pending wake-brief retry (flush/boot).
   * Same builder the turn hook uses; absent means retries stay pending.
   */
  buildBrief?: (paseo: any, workspaceId: string, agentId: string) => Promise<string>;
  force?: boolean;
  failingPool?: string | null;
  failoverReason?: string;
}

export interface WakeEvent {
  workerId: string;
  state: string;
}

// ---------------------------------------------------------------------------
// Module state: the daemon handle (lent by hooks, like the cold sweep), the
// quiet-period flags, failover progress, and the last watchdog scan. All
// in-memory: after a restart everything recomputes from the register and the
// agent activity, and the boot check re-arms the combined wake.
// ---------------------------------------------------------------------------

let supervisionPaseo: any = null;
let bootCheckDone = false;
let draining = false;
let lastWatchdogScanMs = 0;
const failoverAsked = new Map<string, { activeSlot: string | null; asked: string[]; updatedAt: string }>();
/** First sighting (epoch ms) of each agent's current ZeroSub pending move. */
const zerosubPendingSince = new Map<string, number>();

export function captureSupervisionPaseo(paseo: any): void {
  if (paseo) supervisionPaseo = paseo;
}

export function isBootCheckDone(): boolean {
  return bootCheckDone;
}

export function markBootCheckDone(): void {
  bootCheckDone = true;
}

export function isDraining(): boolean {
  return draining;
}

/**
 * Arms the drain quiet period explicitly (tests, manual quiet). Production
 * quiet also engages via the wsf.drain marker the CLI/plugin drain writes in
 * every scope's main workspace; every quiet check ORs the flag with the
 * scope's marker (stale markers past timeoutAt + 1 min are ignored).
 */
export function setDraining(value: boolean): void {
  draining = value;
}

/** Failover progress for tests (a copy). */
export function failoverStateForTests(): Record<string, { activeSlot: string | null; asked: string[] }> {
  const out: Record<string, { activeSlot: string | null; asked: string[] }> = {};
  for (const [scopeId, state] of failoverAsked) {
    out[scopeId] = { activeSlot: state.activeSlot, asked: [...state.asked] };
  }
  return out;
}

/** Clears flags, failover progress, the scan stamp, and the handle; tests only. */
export function resetSupervisionForTests(): void {
  supervisionPaseo = null;
  bootCheckDone = false;
  draining = false;
  lastWatchdogScanMs = 0;
  failoverAsked.clear();
  zerosubPendingSince.clear();
}

/** Reads the supervision settings document; null fails the tick closed. */
export async function readSupervisionSettings(handle: {
  read: () => Promise<{ status: string; values?: unknown }>;
}): Promise<SupervisionSettings | null> {
  try {
    const state = await handle.read();
    if (state.status !== "ready") return null;
    return state.values as SupervisionSettings;
  } catch {
    return null;
  }
}

async function resolveSettings(deps: SettingsSource): Promise<SupervisionSettings | null> {
  if (deps.settings !== undefined) return deps.settings;
  if (typeof deps.getSettings === "function") return deps.getSettings();
  return null;
}

/**
 * Retries a lock-guarded operation on LockBusy for 2 s (50 ms backoff).
 * Shared by supervision and the turn-after follow-up so a busy workspace
 * lock ("Workspace lock … is held by another process") never drops a wake
 * or a resume brief.
 */
export async function retryOnLockBusy<T>(
  fn: () => Promise<T>,
  opts?: { timeoutMs?: number; delayMs?: number },
): Promise<T> {
  const retryUntil = Date.now() + (opts?.timeoutMs ?? 2_000);
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof LockBusy) || Date.now() >= retryUntil) throw error;
      await delay(opts?.delayMs ?? 50);
    }
  }
}

function lockOf(deps: SuperviseDeps): (
  name: string,
  fn: (held: { verify: () => void }) => Promise<any>,
) => Promise<any> {
  const lock = deps.lock ?? (withLock as unknown as (
    name: string,
    fn: (held: { verify: () => void }) => Promise<any>,
  ) => Promise<any>);
  return async (name, fn) => retryOnLockBusy(() => lock(name, fn));
}

function logOf(deps: SuperviseDeps): (message: string) => void {
  return deps.log ?? console.log;
}

function stampsOf(deps: SuperviseDeps): { nowIso: string; nowMs: number } {
  const nowMs = typeof deps.nowMs === "number" ? deps.nowMs : Date.now();
  const nowIso = deps.nowIso ?? new Date(nowMs).toISOString();
  return { nowIso, nowMs: deps.nowMs ?? Date.parse(nowIso) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function wsfOf(meta: Record<string, unknown>): Record<string, any> | null {
  return (asRecord(meta[METADATA_KEY]) ?? asRecord(meta[LEGACY_PREFIX])) as Record<string, any> | null;
}

function findScope(scopes: any[], scopeId: string): any | null {
  return (scopes ?? []).find((s: any) => s && sameScopeId(s.id, scopeId)) ?? null;
}

/** Retired agent id after a fresh (a previousSteer that is not a slot letter). */
function retiredAgentId(wsf: Record<string, any> | null): string | null {
  const previous = wsf?.previousSteer;
  return typeof previous === "string" && previous && !/^[A-Z]$/.test(previous) ? previous : null;
}

function isBusyStatus(status: unknown): boolean {
  return typeof status === "string" && BUSY_STATUSES.includes(status);
}

async function refreshWorkspaceMeta(paseo: any, workspaceId: string): Promise<Record<string, unknown>> {
  const snap: any = await paseo.workspaces.ref(workspaceId).refresh().catch(() => null);
  return (snap?.metadata ?? {}) as Record<string, unknown>;
}

async function refreshAgent(paseo: any, agentId: string): Promise<any | null> {
  const snap: any = await paseo.agents.ref(agentId).refresh().catch(() => null);
  return snap?.agent ?? null;
}

async function readTurnTail(paseo: any, agentId: string, turnId: string | null): Promise<unknown[]> {
  try {
    const page: any = await paseo.agents.ref(agentId).timeline.refetch({
      direction: "tail",
      limit: 1,
      wholeTurns: true,
    });
    const all = Array.isArray(page?.entries) ? page.entries : [];
    return turnId ? all.filter((e: any) => e.turnId === undefined || e.turnId === turnId) : all;
  } catch {
    return [];
  }
}

/** Sends through the plugin SDK with no source agent. */
function deliveryDeps(deps: SuperviseDeps): SteerDeliveryDeps {
  return {
    ...deps.delivery,
    lock: lockOf(deps),
    now: () => stampsOf(deps).nowIso,
    buildBrief: deps.delivery?.buildBrief ?? deps.buildBrief,
    onTakeoverDelivered: (paseo, batch, agentId) => recordTakeoverDelivery(paseo, batch, agentId, deps).then(() => {}),
  };
}

/**
 * Live steer rows of a scope for resolveWakeTarget/failoverChain: slot, id,
 * archived/retired/interrupted markers, status, background. Closed holders
 * stay eligible (a wake reopens them); retired and archived ones do not.
 */
function steerRows(
  paseoState: any,
  scopeId: string,
  wsf: Record<string, any> | null,
  agentState: Record<string, unknown>,
  config: any = null,
): { slot: string | null; id: string; archivedAt: unknown; retired: boolean; status: unknown; background: unknown; interrupted: unknown; pool?: string | null; advisor?: boolean }[] {
  const retired = retiredAgentId(wsf);
  const rows: { slot: string | null; id: string; archivedAt: unknown; retired: boolean; status: unknown; background: unknown; interrupted: unknown; pool?: string | null; advisor?: boolean }[] = [];
  for (const agent of paseoState?.agents ?? []) {
    const identity = factoryIdentity(agent?.labels ?? null);
    if (!identity || identity.role !== "steer" || !sameScopeId(identity.scopeId, scopeId)) continue;
    rows.push({
      slot: identity.slot,
      id: agent.id,
      archivedAt: agent.archivedAt ?? null,
      retired: retired !== null && agent.id === retired,
      status: agent.status ?? null,
      background: agent.background ?? null,
      interrupted: (asRecord(agentState[agent.id])?.interrupted ?? null) as unknown,
      pool: identity.slot ? profilePool(config?.profiles?.[config?.steers?.slots?.[identity.slot]]) : null,
      advisor: identity.slot ? config?.profiles?.[config?.steers?.slots?.[identity.slot]]?.advisor === true : false,
    });
  }
  return rows;
}

/** Labelled workers of a scope (role worker, scope id match). */
function workerAgents(paseoState: any, scopeId: string): any[] {
  return (paseoState?.agents ?? []).filter((agent: any) => {
    const identity = factoryIdentity(agent?.labels ?? null);
    return !!identity && identity.role === "worker" && sameScopeId(identity.scopeId, scopeId);
  });
}

/**
 * Domain and hub failover links: the domain scope pointer, else none, and the
 * hub scope's active holder. Entries carry { steerId, scopeId } or null when
 * the scope or its holder is missing.
 */
function domainHubSteers(
  paseoState: any,
  scopes: any[],
  scope: any,
  wsf: Record<string, any> | null,
): { domainSteer: { steerId: string; scopeId: string } | null; hubSteer: { steerId: string; scopeId: string } | null } {
  const holderOf = (target: any): string | null => {
    if (!target) return null;
    const targetWsf = wsfOf(target.workspace?.metadata ?? {});
    if (!targetWsf) return null;
    const entries = asRecord(target.workspace?.metadata?.[AGENTS_KEY]) ?? {};
    return resolveWakeTarget(targetWsf, steerRows(paseoState, target.id, targetWsf, entries));
  };
  const stored = asRecord(wsf?.scope);
  const domainId =
    (typeof scope?.domain === "string" && scope.domain) ||
    (typeof stored?.domain === "string" && (stored.domain as string)) ||
    null;
  const domainScope = domainId ? (scopes ?? []).find((s: any) => s && sameScopeId(s.id, domainId)) ?? null : null;
  const domainHolder = holderOf(domainScope);
  const hubScope = (scopes ?? []).find((s: any) => s && s.kind === "hub") ?? null;
  const hubHolder = holderOf(hubScope);
  return {
    domainSteer: domainScope && domainHolder ? { steerId: domainHolder, scopeId: domainScope.id } : null,
    hubSteer: hubScope && hubHolder ? { steerId: hubHolder, scopeId: hubScope.id } : null,
  };
}

/**
 * Registers a labelled worker that has no register entry yet (adopted with
 * plan --adopt-worker, or created before the plugin ran). Never overwrites an
 * existing entry; the caller checks first.
 */
export async function backfillWorker(
  paseo: any,
  scope: any,
  agent: any,
  wsf: Record<string, any> | null,
  agentEntry: Record<string, unknown> | null,
  deps: SuperviseDeps,
): Promise<any> {
  const note = agentEntry?.note;
  const labels = agent?.labels ?? {};
  return registerWorker({
    client: paseo,
    workspaceId: scope.workspaceId,
    workerId: agent.id,
    task: clipTask(typeof note === "string" ? note : ""),
    startedBy: labels[OWNER_KEY] ?? labels[LEGACY_OWNER_KEY] ?? null,
    epoch: wsf?.epoch ?? null,
    lock: lockOf(deps),
    now: () => stampsOf(deps).nowIso,
  });
}

// ---------------------------------------------------------------------------
// agent.create.after: register agents started by a labelled scope steer.
// ---------------------------------------------------------------------------

export interface CreateAfterResult {
  ok: boolean;
  action: "registered" | "skip" | "disabled";
  reason?: string;
  scopeId?: string;
  epoch?: number | null;
  startedBy?: string | null;
  metaWritten?: boolean;
}

/**
 * Registers an agent started by a labelled steer of a scope (parent is a
 * steer with wsf.scope) in wsf.workers as running, and writes the immutable
 * plugin metadata (scope id, starting steer, epoch, task excerpt). Skips
 * background agents. The metadata is written once and never updated.
 */
export async function runCreateAfter(
  paseo: any,
  hookAgent: { id?: unknown; parentAgentId?: unknown; background?: unknown } | null,
  deps: SuperviseDeps,
): Promise<CreateAfterResult> {
  const settings = await resolveSettings(deps);
  if (!settings || !settings.enabled) return { ok: true, action: "disabled" };
  const log = logOf(deps);
  const workerId = typeof hookAgent?.id === "string" ? hookAgent.id : null;
  if (!workerId) return { ok: true, action: "skip", reason: "no-id" };
  if (hookAgent?.background === true) return { ok: true, action: "skip", reason: "background" };
  const parentId = typeof hookAgent?.parentAgentId === "string" ? hookAgent.parentAgentId : null;
  if (!parentId) return { ok: true, action: "skip", reason: "no-parent" };
  const state: any = await readPaseoState(paseo);
  const parent = (state.agents ?? []).find((a: any) => a && a.id === parentId) ?? null;
  if (!parent) return { ok: true, action: "skip", reason: "no-parent-snapshot" };
  const parentIdentity = factoryIdentity(parent.labels ?? null);
  if (!parentIdentity || parentIdentity.role !== "steer") {
    return { ok: true, action: "skip", reason: "parent-not-steer" };
  }
  const scope = findScope(listScopes(state), parentIdentity.scopeId);
  if (!scope) return { ok: true, action: "skip", reason: "no-scope" };
  const wsf = wsfOf(scope.workspace?.metadata ?? {});
  if (!wsf) return { ok: true, action: "skip", reason: "no-wsf" };
  const epoch = typeof wsf.epoch === "number" && Number.isInteger(wsf.epoch) ? wsf.epoch : null;
  const startedBy = parentIdentity.slot ?? parentId;
  const live = await refreshAgent(paseo, workerId);
  let excerpt = "";
  try {
    excerpt = firstUserText(await readTurnTail(paseo, workerId, null)) ?? "";
  } catch {
    excerpt = "";
  }
  if (!excerpt && live && typeof live.title === "string") excerpt = live.title;
  const task = clipTask(excerpt);
  await registerWorker({
    client: paseo,
    workspaceId: scope.workspaceId,
    workerId,
    task,
    startedBy,
    epoch,
    lock: lockOf(deps),
    now: () => stampsOf(deps).nowIso,
  });
  let metaWritten = false;
  try {
    const meta = asRecord(live?.metadata) ?? {};
    if (!isWorkerMetadata(meta[WORKER_METADATA_KEY])) {
      await paseo.agents.ref(workerId).setMetadata({
        [WORKER_METADATA_KEY]: buildWorkerMetadata({ scopeId: scope.id, startedBy, epoch, task }),
      });
      metaWritten = true;
    }
  } catch (error) {
    log(
      `[factory] supervise: worker metadata for ${workerId} not written (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  log(`[factory] supervise: registered worker ${workerId} of ${scope.id} (started by ${startedBy})`);
  return { ok: true, action: "registered", scopeId: scope.id, epoch, startedBy, metaWritten };
}

/** Never throws out of the hook (log and continue). */
export async function handleCreateAfter(
  payload: { agent: { id: string; parentAgentId: string | null; background: boolean } },
  context: { paseo: any },
  deps: SuperviseDeps = {},
): Promise<CreateAfterResult> {
  captureSupervisionPaseo(context?.paseo);
  try {
    return await runCreateAfter(context.paseo, payload?.agent ?? null, deps);
  } catch (error) {
    console.error(
      `[factory] supervise: create.after failed for agent ${payload?.agent?.id ?? "?"} (${error instanceof Error ? error.message : String(error)})`,
    );
    return { ok: false, action: "skip", reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// Wakes: always to the steer that is active at send time.
// ---------------------------------------------------------------------------

export interface SendWakeResult {
  sent: boolean;
  reason?: string;
  target?: string | null;
  events?: number;
  /** True when the wake was delivered as an F4 automatic resume. */
  resumed?: boolean;
  /** Earliest resetsAt to retry at when the wake waits for quota (`wait-reset`). */
  wakeAt?: string | null;
}

/**
 * Sends one wake to the scope's active steer at send time (re-read from fresh
 * scope state, never the worker's parent), with the design text plus the
 * "archive accepted workers" hint when workers are done and the advisor hint
 * when open workers passed maxAutoResumes. Marks every included entry sent
 * (lastWakeAt, pending cleared). Never wakes background agents.
 */
export async function sendScopeWake(
  paseo: any,
  args: {
    scope: any;
    events: WakeEvent[];
    state?: any;
    factoryCmd?: string;
    /** Extra ZeroSub note (e.g. a fork warning) appended after the quota line. */
    zerosubNote?: string | null;
  },
  deps: SuperviseDeps,
): Promise<SendWakeResult> {
  const log = logOf(deps);
  const events = args.events ?? [];
  if (!events.length) return { sent: false, reason: "no-events" };
  const scope = args.scope;
  const mainId: string = scope.workspaceId;
  const freshMeta = await refreshWorkspaceMeta(paseo, mainId);
  const freshWsf = wsfOf(freshMeta);
  if (!freshWsf) return { sent: false, reason: "no-wsf" };
  const register = readWorkers(freshMeta);
  const paseoState = args.state ?? ((await readPaseoState(paseo)) as any);
  const agentState = asRecord(freshMeta[AGENTS_KEY]) ?? {};
  const settings = await resolveSettings(deps);
  const config = deps.getConfig ? await deps.getConfig().catch(() => null) : null;
  const rows = steerRows(paseoState, scope.id, freshWsf, agentState, config);
  const target = resolveWakeTarget(freshWsf, rows);
  if (!target) {
    log(`[factory] supervise: no live holder of ${scope.id} active steer; wake queued`);
    return { sent: false, reason: "no-target", target: null };
  }
  const targetAgent = await refreshAgent(paseo, target);
  if (!canWakeAgent(targetAgent, scope.id)) {
    return { sent: false, reason: "target-ineligible", target };
  }
  if (isBusyStatus(targetAgent.status) || targetAgent.activeTurn) {
    return { sent: false, reason: "target-busy", target };
  }
  const active = typeof freshWsf.activeSteer === "string" ? freshWsf.activeSteer : null;
  const activeRow = rows.find((row: any) => row.id === target) ?? null;
  const activeProfile = active && config?.profiles?.[config?.steers?.slots?.[active]];
  const activePool = activeProfile ? profilePool(activeProfile) : null;
  const exhaustedPct = config?.quota?.exhaustedPct ?? settings?.quota?.exhaustedPct ?? 95;
  const exhausted = activePool && quotaExhausted(
    getQuotaSnapshot(),
    activePool,
    exhaustedPct,
  );
  const zerosub = await resolveZerosub(deps);
  if ((activeRow?.advisor === true || exhausted) && active) {
    const takeover = await runFailoverCheck(paseo, scope, {
      ...deps,
      zerosub,
      state: paseoState,
      force: true,
      failingPool: activePool,
      failoverReason: activeRow?.advisor === true ? "active steer is advisor-flagged" : `quota exhausted for pool ${activePool}`,
    });
    if (takeover.action === "failover") {
      return { sent: true, target: takeover.to?.steerId ?? null, events: events.length };
    }
    return {
      sent: false,
      reason: takeover.reason ?? "no-failover-candidate",
      target,
      ...(takeover.wakeAt ? { wakeAt: takeover.wakeAt } : {}),
    };
  }
  // All accounts (or the target's family) exhausted: hold the news until the
  // earliest reset instead of waking a steer that cannot run a turn. The
  // events stay queued; the next flush after the reset delivers them.
  const waitWakeAt = waitResetWakeAt({ zerosub, targetId: target, nowMs: stampsOf(deps).nowMs, exhaustedPct });
  if (waitWakeAt) {
    log(`[factory] supervise: wake for ${scope.id} waits for quota reset at ${waitWakeAt}`);
    return { sent: false, reason: "wait-reset", target, wakeAt: waitWakeAt };
  }
  const maxAutoResumes = settings?.maxAutoResumes ?? 2;
  const overContinued = openWorkers(register)
    .filter((entry: any) => Number.isInteger(entry?.resumes) && (entry.resumes as number) >= maxAutoResumes)
    .map((entry: any) => ({ id: entry.id as string, resumes: entry.resumes as number }));
  let text = withArchiveHint(
    formatWakeMessage({
      scopeId: scope.id,
      epoch: freshWsf.epoch ?? null,
      events,
      factoryCmd: args.factoryCmd ?? deps.factoryCmd ?? FACTORY_CMD,
    }) ?? "",
    selectDoneIds(register),
  );
  const quotaLine = formatQuotaLine(config, getQuotaSnapshot(), {
    currentPool: activeProfile ? profilePool(activeProfile) : null,
    warnPct: config?.quota?.warnPct ?? settings?.quota?.warnPct ?? 75,
    zerosub,
    now: stampsOf(deps).nowMs,
  });
  if (quotaLine) text = `${text}\n${quotaLine}`;
  if (args.zerosubNote) text = `${text}\n${args.zerosubNote}`;
  const escalation = escalationHintLine(overContinued);
  if (escalation) text = `${text}\n${escalation}`;
  if (!text) return { sent: false, reason: "no-text", target };
  const markSent = async (): Promise<void> => {
    const at = stampsOf(deps).nowIso;
    for (const event of events) {
      const current = register[event.workerId];
      if (!current || typeof current !== "object") continue;
      const marked = markWakeSent(current, { at });
      await updateWorkerEntry({
        client: paseo,
        workspaceId: mainId,
        workerId: event.workerId,
        patch: { lastWakeAt: marked.lastWakeAt, pendingWake: marked.pendingWake },
        lock: lockOf(deps),
      });
    }
  };
  const delivery = await deliverSteer(paseo, {
    workspaceId: mainId,
    agentId: target,
    epoch: freshWsf.epoch,
    text,
    state: paseoState,
    sendOptions: { activeTurnBehavior: "steer" },
    batch: { workspaceId: mainId, epoch: freshWsf.epoch ?? null, events },
  }, deliveryDeps(deps));
  if (delivery.status !== "sent") {
    return { sent: false, reason: delivery.status === "blocked" ? "resume-refused" : "brief-pending", target };
  }
  // Renewed deliveries mark their own batch after the brief is accepted.
  if (delivery.renewed) return { sent: true, target, events: events.length, resumed: true };
  await markSent();
  log(`[factory] supervise: woke ${target} for ${scope.id} (${events.length} worker(s))`);
  return { sent: true, target, events: events.length };
}

/** Queued pending wakes plus the current event (current wins per worker). */
function mergeWakeEvents(register: Record<string, any>, workerId: string, state: string): WakeEvent[] {
  const merged = new Map<string, string>();
  for (const pending of collectPendingWakes(register)) {
    merged.set(pending.workerId, pending.state);
  }
  merged.set(workerId, state);
  return [...merged.entries()]
    .map(([id, st]) => ({ workerId: id, state: st }))
    .sort((a, b) => a.workerId.localeCompare(b.workerId));
}

/**
 * First-sighting stamp of an agent's ZeroSub pending move: the first call with
 * a pending target records nowMs, later calls return the stored stamp, and a
 * cleared move forgets it. Unknown moves count as just seen, so a stuck route
 * trips the `zerosubPendingMinutes` timeout instead of wedging wakes forever.
 */
function trackZerosubPending(agentId: string | null, pendingTarget: string | null, nowMs: number): number | null {
  if (!agentId || !pendingTarget) {
    if (agentId) zerosubPendingSince.delete(agentId);
    return null;
  }
  const known = zerosubPendingSince.get(agentId);
  if (known === undefined) zerosubPendingSince.set(agentId, nowMs);
  return zerosubPendingSince.get(agentId) ?? nowMs;
}

/**
 * Earliest future resetsAt to wait for when nothing can run now: the
 * `exhausted`+`stayed` switch row's resetsAt, the all-accounts-exhausted
 * reset, or the wake target's family reset — whichever is earliest. Null
 * means some account has room (proceed) or no reset is known (legacy).
 */
function waitResetWakeAt(args: {
  zerosub: any;
  targetId: string | null;
  switchWakeAt?: string | null;
  nowMs: number;
  exhaustedPct: number;
}): string | null {
  const candidates: string[] = [];
  if (args.switchWakeAt && futureWakeAtMs(args.switchWakeAt, args.nowMs) !== null) {
    candidates.push(args.switchWakeAt);
  }
  if (args.zerosub) {
    const all = exhaustedWakeDecision({ zerosub: args.zerosub, now: args.nowMs, exhaustedPct: args.exhaustedPct });
    if (all.decision === "wait-reset" && all.wakeAt) candidates.push(all.wakeAt);
    const family = args.targetId ? (accountForAgent(args.zerosub, args.targetId)?.family ?? null) : null;
    if (family) {
      const scoped = exhaustedWakeDecision({ zerosub: args.zerosub, family, now: args.nowMs, exhaustedPct: args.exhaustedPct });
      if (scoped.decision === "wait-reset" && scoped.wakeAt) candidates.push(scoped.wakeAt);
    }
  }
  let best: string | null = null;
  let bestMs = Infinity;
  for (const stamp of candidates) {
    const ms = Date.parse(stamp);
    if (Number.isFinite(ms) && ms > args.nowMs && ms < bestMs) {
      best = stamp;
      bestMs = ms;
    }
  }
  return best;
}

async function queueWake(
  paseo: any,
  mainId: string,
  workerId: string,
  entry: any,
  state: string,
  deps: SuperviseDeps,
): Promise<void> {
  const queued = queuePendingWake(entry, { state, queuedAt: stampsOf(deps).nowIso });
  await updateWorkerEntry({
    client: paseo,
    workspaceId: mainId,
    workerId,
    patch: { pendingWake: queued.pendingWake },
    lock: lockOf(deps),
  });
}

// ---------------------------------------------------------------------------
// agent.turn.after: transitions plus immediate/debounced/queued wakes.
// ---------------------------------------------------------------------------

export interface TurnAfterResult {
  ok: boolean;
  action: "sent" | "deferred" | "queued" | "skipped" | "removed" | "disabled";
  reason?: string;
  event?: string | null;
  state?: string | null;
  target?: string | null;
}

/**
 * Transitions a supervised worker by its turn end (CHECKPOINT status,
 * ADVISOR-REQUEST, missing CHECKPOINT, failed/canceled) and wakes the active
 * steer: immediately for every actionable outcome, debouncing simultaneous
 * events, or queued during quiet periods (drain, before the boot check).
 * Archived workers lose their entry; steers, unassigned and background agents
 * are ignored, closed agents stay supervised.
 */
export async function runWorkerTurnAfter(
  paseo: any,
  payload: {
    agent?: { id?: unknown; background?: unknown } | null;
    turnId?: unknown;
    outcome?: { kind?: unknown } | null;
  } | null,
  deps: SuperviseDeps,
): Promise<TurnAfterResult> {
  const settings = await resolveSettings(deps);
  if (!settings || !settings.enabled) return { ok: true, action: "disabled" };
  const log = logOf(deps);
  const agentId = typeof payload?.agent?.id === "string" ? payload.agent.id : null;
  if (!agentId) return { ok: true, action: "skipped", reason: "no-id" };
  const kind = payload?.outcome && typeof payload.outcome.kind === "string" ? payload.outcome.kind : null;
  if (kind !== "completed" && kind !== "failed" && kind !== "canceled") {
    return { ok: true, action: "skipped", reason: "unknown-outcome" };
  }
  if (payload?.agent?.background === true) return { ok: true, action: "skipped", reason: "background" };
  const agent = await refreshAgent(paseo, agentId);
  if (!agent) return { ok: true, action: "skipped", reason: "gone" };
  // Workers started by a steer usually carry no wsf labels (only the native
  // parent label); runCreateAfter registers them and writes the worker
  // metadata with the scope id, so that metadata identifies them here too.
  const identity = factoryIdentity(agent.labels ?? null) ?? workerIdentityFromMetadata(agent);
  const state: any = await readPaseoState(paseo);
  const scope = identity ? findScope(listScopes(state), identity.scopeId) : null;
  if (agent.archivedAt) {
    if (scope) {
      await removeWorker({ client: paseo, workspaceId: scope.workspaceId, workerId: agentId, lock: lockOf(deps) });
    }
    return { ok: true, action: "removed", reason: "archived" };
  }
  if (!identity || identity.role !== "worker") return { ok: true, action: "skipped", reason: "not-worker" };
  if (!scope) return { ok: true, action: "skipped", reason: "no-scope" };
  const mainId: string = scope.workspaceId;
  let meta = await refreshWorkspaceMeta(paseo, mainId);
  const wsf = wsfOf(meta);
  if (!wsf) return { ok: true, action: "skipped", reason: "no-wsf" };
  let register = readWorkers(meta);
  const workerAgentState = asRecord(asRecord(meta[AGENTS_KEY])?.[agentId]);
  if (workerAgentState?.replacedBy) return { ok: true, action: "skipped", reason: "worker-replaced" };
  if (!register[agentId]) {
    await backfillWorker(paseo, scope, agent, wsf, workerAgentState, deps);
    meta = await refreshWorkspaceMeta(paseo, mainId);
    register = readWorkers(meta);
    log(`[factory] supervise: backfilled worker ${agentId} of ${scope.id}`);
  }
  const turnId = typeof payload?.turnId === "string" ? payload.turnId : null;
  const entries = await readTurnTail(paseo, agentId, turnId);
  const lastAnswer = lastAssistantText({ entries });
  const block = kind === "completed" && lastAnswer ? parseCheckpointBlock(lastAnswer) : null;
  const status = block && typeof (block as { status?: unknown }).status === "string"
    ? (block as { status: string }).status
    : null;
  const event = turnEndEvent({
    outcome: kind,
    hasCheckpoint: block !== null,
    status,
    advisorRequest: hasAdvisorRequest(lastAnswer),
  });
  const entry = await updateWorkerEntry({
    client: paseo,
    workspaceId: mainId,
    workerId: agentId,
    event,
    lock: lockOf(deps),
  });
  const newState = entry?.state ?? null;
  meta = await refreshWorkspaceMeta(paseo, mainId);
  register = readWorkers(meta);
  const { nowMs } = stampsOf(deps);
  const draining = (deps.draining ?? isDraining()) || isDrainMarkerActive(meta[DRAIN_METADATA_KEY], nowMs);
  // ZeroSub already continued this turn (its follow-up carries on, possibly
  // in continuedIn): no factory follow-up of our own (the transition above is
  // still recorded). A pending in-place move instead defers the wake via
  // planWake; the next turn end reports.
  const zerosub = await resolveZerosub(deps);
  const switchRow = findZerosubSwitch(entries);
  if (zerosubSwitchFollowup(switchRow).decision === "suppress") {
    log(`[factory] supervise: no follow-up for ${agentId} (ZeroSub continued it)`);
    return { ok: true, action: "skipped", reason: "zerosub-continued", event, state: newState };
  }
  const zerosubNote = zerosubForkWarning(switchRow);
  const plan = planWake({
    agent,
    scopeId: scope.id,
    newState,
    nowMs,
    lastWakeAt: scopeLastWakeAt(register),
    batchMinutes: settings.batchMinutes,
    wakeDebounceSeconds: settings.wakeDebounceSeconds,
    draining,
    bootCheckDone: deps.bootCheckDone ?? isBootCheckDone(),
    zerosub,
    zerosubPendingSince: trackZerosubPending(agentId, zerosub ? zerosubPendingTarget(zerosub, agentId) : null, nowMs),
  });
  if (plan.action === "skip") {
    // Quiet but eligible: queue so the post-quiet combined wake includes it.
    if ((plan.reason === "drain" || plan.reason === "boot") && entry && newState) {
      await queueWake(paseo, mainId, agentId, entry, newState, deps);
      return { ok: true, action: "queued", reason: plan.reason, event, state: newState };
    }
    return { ok: true, action: "skipped", reason: plan.reason, event, state: newState };
  }
  if (plan.action === "defer") {
    if (entry && newState) await queueWake(paseo, mainId, agentId, entry, newState, deps);
    return { ok: true, action: "deferred", reason: plan.reason, event, state: newState };
  }
  if (entry && newState) {
    // Keep the result available to the timer even if delivery throws.
    await queueWake(paseo, mainId, agentId, entry, newState, deps);
  }
  let sent: SendWakeResult;
  try {
    sent = await sendScopeWake(
      paseo,
      { scope, events: newState ? mergeWakeEvents(register, agentId, newState) : [], state, zerosubNote },
      { ...deps, zerosub },
    );
  } catch (error) {
    log(`[factory] supervise: wake for ${scope.id} failed (${error instanceof Error ? error.message : String(error)}); wake queued`);
    return { ok: true, action: "queued", reason: "send-failed", event, state: newState };
  }
  if (!sent.sent) return { ok: true, action: "queued", reason: sent.reason ?? "no-target", event, state: newState };
  return { ok: true, action: "sent", event, state: newState, target: sent.target ?? null };
}

/** Never throws out of the hook (log and continue). */
export async function handleWorkerTurnAfter(
  payload: { agent: { id: string }; turnId: string | null; outcome: { kind: string } },
  context: { paseo: any },
  deps: SuperviseDeps = {},
): Promise<TurnAfterResult> {
  captureSupervisionPaseo(context?.paseo);
  try {
    return await runWorkerTurnAfter(context.paseo, payload as never, deps);
  } catch (error) {
    console.error(
      `[factory] supervise: turn.after failed for agent ${(payload as { agent?: { id?: unknown } })?.agent?.id ?? "?"} (${error instanceof Error ? error.message : String(error)})`,
    );
    return { ok: false, action: "skipped", reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// Pending deliveries are retried one brief per scope per tick.
export interface RetryWakeBriefResult {
  attempted: boolean;
  delivered: boolean;
  reason?: string;
  target?: string | null;
  events?: number;
}

export async function retryPendingWakeBrief(
  paseo: any,
  scope: any,
  deps: SuperviseDeps & { state?: any; allowBatches?: boolean },
): Promise<RetryWakeBriefResult> {
  const mainId: string = scope.workspaceId;
  const meta = await refreshWorkspaceMeta(paseo, mainId);
  if (!wsfOf(meta)) return { attempted: false, delivered: false, reason: "no-wsf" };
  const entries = asRecord(meta[AGENTS_KEY]) ?? {};
  const candidates = Object.entries(entries)
    .flatMap(([agentId, entry]) => {
      const pending = pendingSteerDelivery(entry, mainId);
      return pending && (deps.allowBatches !== false || !pending.batch) ? [{ agentId, pending }] : [];
    })
    .sort((a, b) => a.pending.queuedAt.localeCompare(b.pending.queuedAt));
  let waiting: RetryWakeBriefResult | null = null;
  for (const { agentId, pending } of candidates) {
    const result = await finishSteerDelivery(paseo, { workspaceId: mainId, agentId }, deliveryDeps(deps));
    if (!result) continue;
    const batch = pending.batch;
    const events = batch?.workspaceId === mainId && !batch.takeover ? batch.events.length : 0;
    if (result.status === "sent") return { attempted: true, delivered: true, target: agentId, events };
    if (events) waiting = {
      attempted: false, delivered: false, reason: result.status === "blocked" ? "resume-refused" : "brief-pending",
      target: agentId, events,
    };
  }
  return waiting ?? { attempted: false, delivered: false, reason: "none" };
}

// ---------------------------------------------------------------------------
// Batch flush: due pending wakes go out as one combined wake per scope.
// ---------------------------------------------------------------------------

export interface FlushResult {
  flushed: boolean;
  reason?: string;
  target?: string | null;
  events?: number;
}

export async function flushScope(
  paseo: any,
  scope: any,
  deps: SuperviseDeps & { state?: any },
): Promise<FlushResult> {
  const settings = await resolveSettings(deps);
  if (!settings?.enabled && !deps.delivery) return { flushed: false, reason: "disabled" };
  const { nowMs } = stampsOf(deps);
  const flushedMeta = await refreshWorkspaceMeta(paseo, scope.workspaceId);
  if ((deps.draining ?? isDraining()) || isDrainMarkerActive(flushedMeta[DRAIN_METADATA_KEY], nowMs)) {
    return { flushed: false, reason: "drain" };
  }
  if (!(deps.bootCheckDone ?? isBootCheckDone())) return { flushed: false, reason: "boot" };
  const retry = await retryPendingWakeBrief(paseo, scope, { ...deps, allowBatches: settings?.enabled === true });
  if (retry.delivered) {
    return { flushed: true, target: retry.target ?? null, events: retry.events };
  }
  if (retry.reason !== "none" && retry.reason !== "no-wsf" && retry.reason !== "target-gone" && retry.reason !== "epoch-moved") {
    return { flushed: false, reason: retry.reason ?? "brief-pending", target: retry.target ?? null, events: retry.events };
  }
  if (!settings?.enabled) return { flushed: false, reason: "disabled" };
  const register = readWorkers(await refreshWorkspaceMeta(paseo, scope.workspaceId));
  const pending = collectPendingWakes(register);
  if (!pending.length) return { flushed: false, reason: "none" };
  if (!isBatchDue({
    nowMs,
    lastWakeAt: scopeLastWakeAt(register),
    batchMinutes: settings.batchMinutes,
    wakeDebounceSeconds: settings.wakeDebounceSeconds,
  })) {
    return { flushed: false, reason: "window" };
  }
  const sent = await sendScopeWake(
    paseo,
    { scope, events: pending.map((p: any) => ({ workerId: p.workerId, state: p.state })), state: deps.state },
    deps,
  );
  return { flushed: sent.sent, reason: sent.sent ? undefined : (sent.reason ?? "send-failed"), target: sent.target ?? null, events: sent.events };
}

export async function flushAllScopes(paseo: any, deps: SuperviseDeps & { state?: any }): Promise<FlushResult[]> {
  const settings = await resolveSettings(deps);
  if (!settings?.enabled && !deps.delivery) return [];
  const paseoState = deps.state ?? ((await readPaseoState(paseo)) as any);
  const out: FlushResult[] = [];
  for (const scope of listScopes(paseoState)) {
    if (!settings?.enabled) {
      const entries = Object.values(scope.workspace?.metadata?.[AGENTS_KEY] ?? {});
      if (!entries.some((entry) => {
        const pending = pendingSteerDelivery(entry, scope.workspaceId);
        return pending && !pending.batch;
      })) continue;
    }
    try {
      out.push(await flushScope(paseo, scope, { ...deps, settings, state: paseoState }));
    } catch (error) {
      logOf(deps)(`[factory] supervise: flush of ${scope?.id ?? "?"} failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Boot finished: restart marks interrupt workers, then one combined wake.
// ---------------------------------------------------------------------------

export interface BootFinishedResult {
  ok: boolean;
  action: "wakes" | "disabled";
  marked: string[];
  wakes: { scopeId: string; sent: boolean; reason?: string }[];
}

/**
 * Ends the boot quiet period: every boot-check mark on a supervised worker
 * moves its register entry to interrupted (restart-daemon event), then one
 * combined wake per scope lists every interrupted worker. Queues instead of
 * sending while draining.
 */
export async function runBootFinished(
  paseo: any,
  marks: { agentId?: unknown; scopeId?: unknown }[] | null,
  deps: SuperviseDeps & { state?: any },
): Promise<BootFinishedResult> {
  markBootCheckDone();
  const settings = await resolveSettings(deps);
  if (!settings || !settings.enabled) return { ok: true, action: "disabled", marked: [], wakes: [] };
  const log = logOf(deps);
  const paseoState = deps.state ?? ((await readPaseoState(paseo)) as any);
  const scopes = listScopes(paseoState);
  const marked: string[] = [];
  for (const mark of marks ?? []) {
    try {
      const agentId = typeof mark?.agentId === "string" ? mark.agentId : null;
      if (!agentId) continue;
      const agent = (paseoState.agents ?? []).find((a: any) => a && a.id === agentId) ?? null;
      if (!agent || agent.archivedAt) continue;
      const identity = factoryIdentity(agent.labels ?? null);
      const hinted = typeof mark?.scopeId === "string" ? (mark.scopeId as string) : null;
      const scope = identity
        ? findScope(scopes, identity.scopeId)
        : hinted
          ? findScope(scopes, hinted)
          : null;
      if (!scope) continue;
      const meta = await refreshWorkspaceMeta(paseo, scope.workspaceId);
      const register = readWorkers(meta);
      if (asRecord(asRecord(meta[AGENTS_KEY])?.[agentId])?.replacedBy) continue;
      const supervised = identity?.role === "worker" || !!register[agentId];
      if (!supervised) continue;
      const wsf = wsfOf(meta);
      if (!register[agentId] && identity?.role === "worker") {
        const agentState = asRecord(meta[AGENTS_KEY]) ?? {};
        await backfillWorker(paseo, scope, agent, wsf, asRecord(agentState[agentId]), deps);
      }
      const event = eventForRestartReason("daemon-restart");
      if (!event) continue;
      await updateWorkerEntry({
        client: paseo,
        workspaceId: scope.workspaceId,
        workerId: agentId,
        event,
        lock: lockOf(deps),
      });
      marked.push(agentId);
    } catch (error) {
      log(`[factory] supervise: boot mark failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const drainingFlag = deps.draining ?? isDraining();
  const { nowMs } = stampsOf(deps);
  const wakes: { scopeId: string; sent: boolean; reason?: string }[] = [];
  for (const scope of scopes) {
    try {
      if (!drainingFlag) {
        const retry = await retryPendingWakeBrief(paseo, scope, deps);
        if (retry.delivered) {
          wakes.push({ scopeId: scope.id, sent: true });
          const afterMeta = await refreshWorkspaceMeta(paseo, scope.workspaceId);
          const afterRegister = readWorkers(afterMeta);
          for (const agentId of marked) {
            const current = afterRegister[agentId];
            if (current && (current as any).state === "interrupted") {
              await queueWake(paseo, scope.workspaceId, agentId, current, "interrupted", deps);
            }
          }
          continue;
        }
        if (retry.reason !== "none" && retry.reason !== "no-wsf" && retry.reason !== "target-gone" && retry.reason !== "epoch-moved") {
          wakes.push({ scopeId: scope.id, sent: false, reason: retry.reason ?? "brief-pending" });
          continue;
        }
      }
      const bootMeta = await refreshWorkspaceMeta(paseo, scope.workspaceId);
      const register = readWorkers(bootMeta);
      const events = workersReport(register)
        .filter((entry: any) => entry && entry.state === "interrupted")
        .map((entry: any) => ({ workerId: entry.id, state: entry.state as string }));
      if (!events.length) continue;
      if (drainingFlag || isDrainMarkerActive(bootMeta[DRAIN_METADATA_KEY], nowMs)) {
        for (const event of events) {
          const current = register[event.workerId];
          if (current) await queueWake(paseo, scope.workspaceId, event.workerId, current, event.state, deps);
        }
        wakes.push({ scopeId: scope.id, sent: false, reason: "drain" });
        continue;
      }
      const sent = await sendScopeWake(paseo, { scope, events, state: paseoState }, deps);
      if (!sent.sent && sent.reason === "wait-reset") {
        for (const event of events) {
          const current = register[event.workerId];
          if (current) await queueWake(paseo, scope.workspaceId, event.workerId, current, event.state, deps);
        }
        wakes.push({ scopeId: scope.id, sent: false, reason: "wait-reset" });
        continue;
      }
      wakes.push({ scopeId: scope.id, sent: sent.sent, reason: sent.sent ? undefined : (sent.reason ?? "send-failed") });
    } catch (error) {
      log(`[factory] supervise: post-boot wake for ${scope?.id ?? "?"} failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  log(`[factory] supervise: boot finished, ${marked.length} worker(s) interrupted, ${wakes.filter((w) => w.sent).length} wake(s) sent`);
  return { ok: true, action: "wakes", marked, wakes };
}

/** Never throws (log and continue). */
export async function handleBootFinished(
  paseo: any,
  marks: { agentId?: unknown; scopeId?: unknown }[] | null,
  deps: SuperviseDeps = {},
): Promise<BootFinishedResult> {
  captureSupervisionPaseo(paseo);
  try {
    return await runBootFinished(paseo, marks, deps);
  } catch (error) {
    console.error(`[factory] supervise: boot.finished failed (${error instanceof Error ? error.message : String(error)})`);
    return { ok: false, action: "wakes", marked: [], wakes: [] };
  }
}

// ---------------------------------------------------------------------------
// Failover: an unanswered wake walks the candidate chain.
// ---------------------------------------------------------------------------

export interface FailoverResult {
  action: "failover" | "wait" | "answered" | "busy" | "clear" | "abort" | "none";
  reason?: string;
  to?: { kind: string; slot?: string | null; steerId: string; scopeId?: string | null } | null;
  logged?: boolean;
  /** Earliest resetsAt to retry at when the check waits for quota (`wait-reset`). */
  wakeAt?: string | null;
}

/**
 * Annotates the scope checkpoint with the failover (source "failover",
 * previous steer, reason) so resume and handoff show the takeover. Unlike the
 * CLI writeCheckpoint this keeps task, capturedAt and the interrupted flag:
 * it annotates, it does not start a new checkpoint. Epoch-checked under the
 * workspace lock; skipped without a task checkpoint.
 */
export async function logFailoverCheckpoint(
  paseo: any,
  args: { mainId: string; expectedEpoch: unknown; previousSteer: string | null; reason: string },
  deps: SuperviseDeps,
): Promise<boolean> {
  const log = logOf(deps);
  const workspace = paseo.workspaces.ref(args.mainId);
  return lockOf(deps)(workspaceLockName(args.mainId), async (held: { verify: () => void }) => {
    const meta = ((await workspace.refresh())?.metadata ?? {}) as Record<string, unknown>;
    const wsf = wsfOf(meta);
    if (!wsf || wsf.epoch !== args.expectedEpoch) {
      log("[factory] supervise: failover log skipped (scope moved on)");
      return false;
    }
    const checkpoint = asRecord(meta[CHECKPOINT_KEY]) ?? asRecord(meta[LEGACY_CHECKPOINT_KEY]);
    if (!checkpoint || typeof checkpoint.task !== "string" || !checkpoint.task.trim()) {
      log("[factory] supervise: failover log skipped (no task checkpoint)");
      return false;
    }
    held.verify();
    await workspace.setMetadata({
      [CHECKPOINT_KEY]: {
        ...checkpoint,
        source: "failover",
        failover: { previousSteer: args.previousSteer, reason: args.reason },
        updatedAt: stampsOf(deps).nowIso,
        epoch: wsf.epoch,
      },
    });
    return true;
  }) as Promise<boolean>;
}

export async function recordTakeoverDelivery(
  paseo: any, batch: EventBatch, agentId: string, deps: SuperviseDeps = {},
): Promise<boolean> {
  const request = batch.takeover;
  if (!request) return false;
  const logged = await logFailoverCheckpoint(paseo, {
    mainId: batch.workspaceId, expectedEpoch: batch.epoch,
    previousSteer: request.activeSlot, reason: request.reason,
  }, deps);
  const previous = failoverAsked.get(request.scopeId);
  const asked = previous?.activeSlot === request.activeSlot ? previous.asked : [];
  failoverAsked.set(request.scopeId, {
    activeSlot: request.activeSlot,
    asked: [...new Set([...asked, agentId])],
    updatedAt: stampsOf(deps).nowIso,
  });
  logOf(deps)(`[factory] supervise: failover for ${request.scopeId} → ${agentId} (${request.reason})`);
  return logged;
}

/**
 * One failover step for a scope: when the last wake is older than
 * answerMinutes and the active steer neither completed a turn since (answered)
 * nor still runs one (busy), the next chain candidate (next slot, then domain,
 * then hub) gets a takeover request, logged as checkpoint source failover.
 * Each candidate gets a full answer window; an empty chain cycles. Quiet
 * periods skip (the caller checks); an epoch move aborts.
 */
export async function runFailoverCheck(
  paseo: any,
  scope: any,
  deps: SuperviseDeps & { state?: any; scopes?: any[] },
): Promise<FailoverResult> {
  const settings = await resolveSettings(deps);
  if (!settings || !settings.enabled) return { action: "clear", reason: "disabled" };
  const log = logOf(deps);
  const { nowIso, nowMs } = stampsOf(deps);
  const mainId: string = scope.workspaceId;
  const meta = await refreshWorkspaceMeta(paseo, mainId);
  const wsf = wsfOf(meta);
  if (!wsf) return { action: "clear", reason: "no-wsf" };
  const register = readWorkers(meta);
  const open = openWorkers(register);
  if (!open.length && !deps.force) {
    failoverAsked.delete(scope.id);
    return { action: "clear", reason: "no-open" };
  }
  const lastWake = scopeLastWakeAt(register);
  if (!lastWake && !deps.force) {
    failoverAsked.delete(scope.id);
    return { action: "clear", reason: "no-wake" };
  }
  const activeSlot = typeof wsf.activeSteer === "string" ? wsf.activeSteer : null;
  const paseoState = deps.state ?? ((await readPaseoState(paseo)) as any);
  const agentState = asRecord(meta[AGENTS_KEY]) ?? {};
  const config = deps.getConfig ? await deps.getConfig().catch(() => null) : null;
  const rows = steerRows(paseoState, scope.id, wsf, agentState, config);
  const holder = resolveWakeTarget(wsf, rows);
  const zerosub = await resolveZerosub(deps);
  let holderRow: ZerosubSwitchRow | null = null;
  let holderSwitchWakeAt: string | null = null;
  let reason: string;
  if (!holder) {
    reason = "no live holder of the active slot";
  } else {
    const holderAgent = (paseoState.agents ?? []).find((a: any) => a && a.id === holder) ?? null;
    const response = steerWakeResponse({
      entry: asRecord(agentState[holder]),
      status: holderAgent?.status ?? null,
      lastWakeAt: lastWake,
    });
    if (!deps.force && (response === "answered" || response === "busy")) {
      failoverAsked.delete(scope.id);
      return { action: response };
    }
    // No double reaction with ZeroSub's own failover (applies to forced
    // checks too: a limit failover stands down exactly when ZeroSub acted).
    // A continued holder (follow-up sent, or carries on in continuedIn) needs
    // no factory follow-up; a pending in-place move waits for ZeroSub;
    // `exhausted`+`stayed` without continuedIn proceeds below (no account is
    // free, so ZeroSub will not act) and only delays an empty chain to reset.
    holderRow = findZerosubSwitch(await readTurnTail(paseo, holder, null));
    const followup = zerosubSwitchFollowup(holderRow);
    if (followup.decision === "suppress") {
      failoverAsked.delete(scope.id);
      return { action: "clear", reason: followup.reason };
    }
    holderSwitchWakeAt = followup.wakeAt;
    const move = zerosub
      ? zerosubMoveDecision({
          zerosub,
          agentId: holder,
          pendingSince: trackZerosubPending(holder, zerosubPendingTarget(zerosub, holder), nowMs),
          nowMs,
        })
      : null;
    if (move?.decision === "wait-zerosub") return { action: "wait", reason: "wait-zerosub" };
    if (!deps.force && lastWake && nowMs - Date.parse(lastWake) < settings.answerMinutes * 60_000) return { action: "wait" };
    reason = deps.failoverReason ?? `no answer within ${settings.answerMinutes}m`;
  }
  // The scope may have moved since the read; never fail over a stale view.
  const reMeta = await refreshWorkspaceMeta(paseo, mainId);
  const reWsf = wsfOf(reMeta);
  if (!reWsf || reWsf.activeSteer !== activeSlot || reWsf.epoch !== wsf.epoch) {
    failoverAsked.delete(scope.id);
    return { action: "abort", reason: "moved" };
  }
  const scopes = deps.scopes ?? listScopes(paseoState);
  const retired = retiredAgentId(wsf);
  const exhaustedPct = config?.quota?.exhaustedPct ?? settings?.quota?.exhaustedPct ?? 95;
  const chain = failoverChain({
    steers: rows,
    activeSlot,
    retiredIds: retired ? [retired] : [],
    interruptedIds: rows.filter((r) => r.interrupted).map((r) => r.id),
    advisorIds: rows.filter((r) => r.advisor).map((r) => r.id),
    ...domainHubSteers(paseoState, scopes, scope, wsf),
    failingPool: deps.failingPool ?? (activeSlot ? profilePool(config?.profiles?.[config?.steers?.slots?.[activeSlot]]) : null),
    zerosub,
    failingAccountId: holder && zerosub ? (zerosub.agentAccount?.[holder] ?? null) : null,
    exhaustedPct,
    now: nowMs,
  });
  const waitReset = (): FailoverResult | null => {
    const wakeAt = waitResetWakeAt({ zerosub, targetId: holder, switchWakeAt: holderSwitchWakeAt, nowMs, exhaustedPct });
    return wakeAt ? { action: "wait", reason: "wait-reset", wakeAt } : null;
  };
  const stored = failoverAsked.get(scope.id);
  if (stored?.activeSlot === activeSlot && nowMs - Date.parse(stored.updatedAt) < settings.answerMinutes * 60_000) {
    return { action: "wait", reason: "takeover-answer-window" };
  }
  let asked = stored && stored.activeSlot === activeSlot ? [...stored.asked] : [];
  let next = chain.find((c: any) => c && !asked.includes(c.steerId)) ?? null;
  if (!next) {
    if (!chain.length) return waitReset() ?? { action: "none", reason: "no-candidates" };
    asked = [];
    next = chain[0];
  }
  const byId = new Map<string, any>((paseoState.agents ?? []).map((a: any) => [a?.id, a]));
  while (next) {
    const candidate = byId.get(next.steerId) ?? null;
    if (candidate && !candidate.archivedAt && candidate.background !== true && canWakeAgent(candidate)) break;
    asked.push(next.steerId);
    next = chain.find((c: any) => c && !asked.includes(c.steerId)) ?? null;
  }
  if (!next) return waitReset() ?? { action: "none", reason: "candidates-ineligible" };
  const factoryCmd = deps.factoryCmd ?? FACTORY_CMD;
  const summary: { id: string; state: string }[] = open.map((entry: any) => ({ id: entry.id, state: entry.state }));
  let text = next.kind === "steer"
    ? formatSteerTakeover({
        scopeId: scope.id,
        epoch: wsf.epoch,
        activeSlot: activeSlot ?? "?",
        candidateSlot: next.slot,
        reason,
        openWorkers: summary,
        factoryCmd,
      })
    : formatScopeTakeover({
        scopeId: scope.id,
        epoch: wsf.epoch,
        kind: next.kind,
        reason,
        openWorkers: summary,
        factoryCmd,
      });
  const forkNote = zerosubForkWarning(holderRow);
  if (forkNote) text = `${text}\n${forkNote}`;
  const targetScope = next.kind === "steer"
    ? scope
    : findScope(scopes, factoryIdentity(byId.get(next.steerId)?.labels)?.scopeId ?? "");
  if (!targetScope) return { action: "none", reason: "no-target-scope" };
  const batch: EventBatch = {
    workspaceId: mainId, epoch: wsf.epoch ?? null,
    events: summary.map(({ id, state }) => ({ workerId: id, state })),
    takeover: { scopeId: scope.id, activeSlot, reason },
  };
  const outcome = await deliverSteer(paseo, {
    workspaceId: targetScope.workspaceId,
    agentId: next.steerId,
    ...(next.kind === "steer" ? { epoch: wsf.epoch } : {}),
    state: paseoState,
    text,
    sendOptions: { activeTurnBehavior: "steer" },
    batch,
  }, deliveryDeps(deps));
  if (outcome.status !== "sent") {
    return { action: "wait", reason: outcome.status === "blocked" ? "resume-refused" : "brief-pending" };
  }
  if (outcome.renewed) return { action: "failover", to: next };
  for (const entry of open) {
    await updateWorkerEntry({
      client: paseo,
      workspaceId: mainId,
      workerId: entry.id,
      patch: { lastWakeAt: nowIso },
      lock: lockOf(deps),
    });
  }
  // Respect a completed rotation when all candidates have been asked.
  failoverAsked.set(scope.id, { activeSlot, asked, updatedAt: nowIso });
  const logged = await recordTakeoverDelivery(paseo, batch, next.steerId, deps);
  return { action: "failover", to: next, logged };
}

// ---------------------------------------------------------------------------
// Proactive switch hint at steer turn end.
// ---------------------------------------------------------------------------

export interface ProactiveHint {
  decision: "hint" | "skip";
  reason: string;
  to?: { kind: string; slot?: string | null; steerId: string; scopeId?: string | null } | null;
  accountId?: string | null;
  usedPct?: number | null;
  warnPct?: number | null;
  resetsAt?: string | null;
  text?: string | null;
}

function formatProactiveHint(args: {
  scopeId: string;
  to: { kind: string; slot?: string | null; steerId: string };
  accountId: string;
  usedPct: number;
  warnPct: number;
  factoryCmd: string;
}): string {
  const head = `[factory] Account ${args.accountId} is at ${args.usedPct}% of its window (warn ${args.warnPct}%).`;
  if (args.to.kind === "steer" && args.to.slot) {
    return (
      `${head} Hand over now while it is cheap: ` +
      `\`${args.factoryCmd} switch ${args.scopeId} --to ${args.to.slot} --apply\` — ` +
      `a planned CHECKPOINT handoff beats an abort mid-turn.`
    );
  }
  return (
    `${head} No steer slot with room; hand over to the ${args.to.kind} steer ` +
    `before the window closes — a planned CHECKPOINT handoff beats an abort mid-turn.`
  );
}

/**
 * Pure proactive-switch evaluation for a steer turn end: when the steer's
 * ZeroSub account window sits at or above `warnPct` and the failover chain
 * offers a candidate with room, the caller sends `text` so the steer hands
 * over now instead of aborting mid-turn later. `skip` covers no ZeroSub
 * state, usage below warn, a pending ZeroSub move, and no room anywhere.
 */
export function proactiveHintDecision(args: {
  paseoState: any;
  scope: any;
  wsf: Record<string, any> | null;
  agentState: Record<string, unknown>;
  config?: any;
  agentId: string;
  zerosub?: any;
  nowMs?: number;
  warnPct?: number;
  exhaustedPct?: number;
  factoryCmd?: string;
}): ProactiveHint {
  const nowMs = typeof args.nowMs === "number" ? args.nowMs : Date.now();
  const rows = steerRows(args.paseoState, args.scope?.id, args.wsf, args.agentState, args.config ?? null);
  const activeSlot = typeof args.wsf?.activeSteer === "string" ? args.wsf.activeSteer : null;
  const retired = retiredAgentId(args.wsf);
  const decision = proactiveSwitchDecision({
    zerosub: args.zerosub ?? null,
    agentId: args.agentId,
    steers: rows,
    activeSlot,
    ...(args.warnPct !== undefined ? { warnPct: args.warnPct } : {}),
    ...(args.exhaustedPct !== undefined ? { exhaustedPct: args.exhaustedPct } : {}),
    now: nowMs,
    retiredIds: retired ? [retired] : [],
    interruptedIds: rows.filter((r) => r.interrupted).map((r) => r.id),
    advisorIds: rows.filter((r) => r.advisor).map((r) => r.id),
    ...domainHubSteers(args.paseoState, listScopes(args.paseoState), args.scope, args.wsf),
  });
  if (decision.decision !== "switch" || !decision.to) return { decision: "skip", reason: decision.reason ?? "stay" };
  const account = accountForAgent(args.zerosub ?? null, args.agentId);
  const resetsAt = (account?.windows ?? [])
    .map((window: any) => (typeof window?.resetsAt === "string" ? window.resetsAt : null))
    .filter((stamp: string | null): stamp is string => !!stamp)
    .sort()[0] ?? null;
  return {
    decision: "hint",
    reason: decision.reason ?? "account-window-warn",
    to: decision.to,
    accountId: decision.accountId ?? account?.id ?? null,
    usedPct: decision.usedPct ?? null,
    warnPct: decision.warnPct ?? args.warnPct ?? null,
    resetsAt,
    text: formatProactiveHint({
      scopeId: args.scope?.id ?? "?",
      to: decision.to,
      accountId: decision.accountId ?? account?.id ?? "?",
      usedPct: decision.usedPct ?? 0,
      warnPct: decision.warnPct ?? args.warnPct ?? 75,
      factoryCmd: args.factoryCmd ?? FACTORY_CMD,
    }),
  };
}

// ---------------------------------------------------------------------------
// Watchdog scan and timer.
// ---------------------------------------------------------------------------

export interface WatchdogResult {
  ran: boolean;
  backfilled: string[];
  removed: string[];
  reconciled: { id: string; event: string }[];
  stale: string[];
  failovers: { scopeId: string; to: unknown }[];
}

/**
 * One watchdog pass over all scopes: backfill adopted workers without an
 * entry, drop entries of archived workers, reconcile restart marks that never
 * got a turn.after (CLI drain marks planned-restart, then the daemon
 * restarts), mark idle running workers stale (queued for the batched wake),
 * and run the failover check per scope. Restart reconciliation only touches
 * idle workers whose interrupt record is still the latest word, so a recovery
 * turn never flaps back to interrupted.
 */
export async function watchdogScan(paseo: any, deps: SuperviseDeps & { state?: any }): Promise<WatchdogResult> {
  const settings = await resolveSettings(deps);
  if (!settings || !settings.enabled) {
    return { ran: false, backfilled: [], removed: [], reconciled: [], stale: [], failovers: [] };
  }
  const log = logOf(deps);
  const { nowIso, nowMs } = stampsOf(deps);
  const lock = lockOf(deps);
  const paseoState = deps.state ?? ((await readPaseoState(paseo)) as any);
  const scopes = listScopes(paseoState);
  const result: WatchdogResult = { ran: true, backfilled: [], removed: [], reconciled: [], stale: [], failovers: [] };
  const drainingFlag = deps.draining ?? isDraining();
  const bootDone = deps.bootCheckDone ?? isBootCheckDone();
  for (const scope of scopes) {
    try {
      const mainId: string = scope.workspaceId;
      let meta = await refreshWorkspaceMeta(paseo, mainId);
      const wsf = wsfOf(meta);
      if (!wsf) continue;
      let register = readWorkers(meta);
      let agentState = asRecord(meta[AGENTS_KEY]) ?? {};
      for (const worker of workerAgents(paseoState, scope.id)) {
        if (!worker || worker.archivedAt || worker.background === true) continue;
        if (register[worker.id] || asRecord(agentState[worker.id])?.replacedBy) continue;
        await backfillWorker(paseo, scope, worker, wsf, asRecord(agentState[worker.id]), deps);
        result.backfilled.push(worker.id);
      }
      meta = await refreshWorkspaceMeta(paseo, mainId);
      register = readWorkers(meta);
      agentState = asRecord(meta[AGENTS_KEY]) ?? {};
      for (const id of Object.keys(register)) {
        const agent = (paseoState.agents ?? []).find((a: any) => a && a.id === id) ?? null;
        if (agent && agent.archivedAt) {
          await removeWorker({ client: paseo, workspaceId: mainId, workerId: id, lock });
          result.removed.push(id);
          delete register[id];
        }
      }
      for (const [id, entry] of Object.entries(register)) {
        if (!entry || typeof entry !== "object") continue;
        const typed = entry as {
          state?: unknown;
          startedAt?: unknown;
          lastWakeAt?: unknown;
        };
        const agent = (paseoState.agents ?? []).find((a: any) => a && a.id === id) ?? null;
        const agentEntry = asRecord(agentState[id]);
        const busy =
          (agent && (isBusyStatus(agent.status) || agent.activeTurn !== null && agent.activeTurn !== undefined)) ||
          (agentEntry?.openTurnId !== null && agentEntry?.openTurnId !== undefined);
        if ((typed.state === "running" || typed.state === "stale") && !busy) {
          const interrupted = asRecord(agentEntry?.interrupted);
          const reason = typeof interrupted?.reason === "string" ? (interrupted.reason as string) : null;
          const event = eventForRestartReason(reason ?? "");
          const at = typeof interrupted?.at === "string" ? (interrupted.at as string) : null;
          const lastEnd = typeof agentEntry?.lastTurnEndedAt === "string" ? (agentEntry.lastTurnEndedAt as string) : null;
          if (event && at && (!lastEnd || at >= lastEnd)) {
            await updateWorkerEntry({ client: paseo, workspaceId: mainId, workerId: id, event, lock });
            result.reconciled.push({ id, event });
            register[id] = { ...typed, state: "interrupted" };
            continue;
          }
        }
        if (typed.state === "running" && !busy) {
          const lastActive = maxStampMs(
            agentEntry?.lastTurnEndedAt,
            agent?.lastUserMessageAt,
            agent?.updatedAt,
            typed.startedAt,
          );
          if (
            shouldMarkStale({
              entry: typed,
              nowMs,
              lastActiveMs: lastActive ?? NaN,
              staleMinutes: settings.staleMinutes,
            })
          ) {
            const updated = await updateWorkerEntry({ client: paseo, workspaceId: mainId, workerId: id, event: "stale", lock });
            const queued = queuePendingWake(updated ?? typed, { state: "stale", queuedAt: nowIso });
            await updateWorkerEntry({
              client: paseo,
              workspaceId: mainId,
              workerId: id,
              patch: { pendingWake: queued.pendingWake },
              lock,
            });
            result.stale.push(id);
            register[id] = { ...typed, state: "stale" };
          }
        }
      }
      const quiet = drainingFlag || !bootDone || isDrainMarkerActive(meta[DRAIN_METADATA_KEY], nowMs);
      if (!quiet) {
        const check = await runFailoverCheck(
          paseo,
          scope,
          { ...deps, settings, state: paseoState, scopes, nowIso, nowMs },
        );
        if (check.action === "failover") result.failovers.push({ scopeId: scope.id, to: check.to ?? null });
      }
    } catch (error) {
      log(`[factory] supervise: watchdog pass for ${scope?.id ?? "?"} failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return result;
}

export interface SupervisionTimerDeps {
  getSettings: () => Promise<SupervisionSettings | null>;
  getConfig?: () => Promise<any>;
  getZerosub?: SuperviseDeps["getZerosub"];
  intervalMs?: number;
  lock?: SuperviseDeps["lock"];
  log?: (message: string) => void;
  delivery?: SteerDeliveryDeps;
  buildBrief?: SuperviseDeps["buildBrief"];
}

/**
 * Runs flushAllScopes every tick and watchdogScan every watchdogMinutes; the
 * remover stops it (server cleanup). Ticks idle until a hook, RPC, or
 * subscription context lends a daemon handle.
 */
export function startSupervisionTimer({
  getSettings,
  intervalMs = 10_000,
  lock,
  log = console.log,
  delivery,
  getConfig,
  getZerosub,
  buildBrief,
}: SupervisionTimerDeps): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || !supervisionPaseo) return;
    const paseo: any = supervisionPaseo;
    void (async () => {
      try {
        const settings = await getSettings();
        if (!settings?.enabled && !delivery) return;
        const nowMs = Date.now();
        const deps: SuperviseDeps = {
          settings,
          nowMs,
          nowIso: new Date(nowMs).toISOString(),
          lock,
          log,
          delivery,
          ...(getConfig ? { getConfig } : {}),
          ...(getZerosub ? { getZerosub } : {}),
          ...(buildBrief ? { buildBrief } : {}),
        };
        await flushAllScopes(paseo, deps);
        if (settings?.enabled && nowMs - lastWatchdogScanMs >= settings.watchdogMinutes * 60_000) {
          lastWatchdogScanMs = nowMs;
          await watchdogScan(paseo, deps);
        }
      } catch (error) {
        log(`[factory] supervise tick failed (${error instanceof Error ? error.message : String(error)})`);
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




