import { createHash, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { PaseoAgentTimelineHandle, PaseoAgentTimelineSubscription } from "@getpaseo/client";
import { AGENTS_KEY } from "./core/agent-state.mjs";
import { readSteerAction, readCleanupAction, readEffectReceipt, effectReceiptKey, unsettledAccountMove, admittedAccountMoveReplan, actionEntry, newSteerAction, reconcileSteerSend } from "./core/steer-action.mjs";
import { reconcileSteerAccountMove } from "./core/steer-account-move.mjs";
import { actionFact, mergeActionFacts } from "./core/action-facts.mjs";
import { LockBusy, retryOnLockBusy, withLock, workspaceLockName } from "./core/lock.mjs";
import { METADATA_KEY, readPaseoState } from "./core/paseo.mjs";
import { guardScope, scopeHolder } from "./core/scope-guard.mjs";
import { ASSIGNMENT_KEY } from "./core/assign.mjs";
import { resolveContinuations, resolveFactoryLabels } from "./core/zerosub.mjs";
import { defaultCreateRewindClient, rewindAndBrief } from "./core/rewind.mjs";
import { listScopes, sameScopeId } from "./core/scope.mjs";
import { reconcileFreshDelivery, requireFreshPrivacy, settleRewindReceipt } from "./core/steer.mjs";
import { WORKERS_KEY, formatWakeMessage, markWakeSent, updateWorkerEntry } from "./core/supervision.mjs";
import { runCleanup } from "./cold-sweep.js";
import { AgentBusyError, hasActiveAgentWork } from "./agent-context.js";
import { filterStaleWorkerEvents } from "./worker-wakes.js";
import { type ZerosubSource } from "./zerosub-runtime.js";
import { steerQuotaAdmission as quotaOnlyAdmission, activationQuotaAdmission, quotaAdmission, movedAccountAdmission, readAdmissionSnapshot, readPrivacyAdmission, type AdmissionDeps } from "./steer-admission.js";
import { routeMatchesIntent } from "./core/routing.mjs";
import { readRoutingSnapshot, routingProjection, steerRouteCandidate, planSteerRoutes, type RoutingIntent } from "./steer-routing.js";
export { decideSteerDelivery } from "./steer-routing.js";
import {
  cleanupIdentity, formatResumeMessage, isClaudeProvider, RESUME_PENDING_REASON,
  type CleanupSettings, type ResumeClearSettings,
} from "../shared/idle-cleanup.js";

import type { QuotaConfirmation } from "../shared/factory.js";

type Lock = (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>;
type Renewal = "clear" | "rewind" | "send";
type Phase = "renewing" | "ready" | "blocked" | "sent" | "uncertain" | "reserved";
type WakeEvent = { workerId: string; state: string; queuedAt?: string | null };
type AssignmentRef = { workspaceId: string; actionId: string; text?: string };
type AssignmentTarget = { workspaceId: string; agentId: string; epoch: number; scopeId: string; deliveryId?: string; unreserved?: boolean };

export interface SteerDeliveryDeps extends ZerosubSource, AdmissionDeps {
  isFactoryPaused?: () => Promise<boolean>;
  automatic?: boolean;
  confirmActivationQuota?: QuotaConfirmation;
  getCleanupSettings?: () => Promise<CleanupSettings | null>;
  getResumeSettings?: () => Promise<ResumeClearSettings | null>;
  keepChatHistory?: () => Promise<boolean>;
  buildBrief?: (paseo: any, workspaceId: string, agentId: string) => Promise<string>;
  runCleanupFn?: typeof runCleanup;
  rewindClient?: typeof defaultCreateRewindClient;
  lock?: Lock;
  now?: () => string;
  onTakeoverDelivered?: (paseo: any, batch: EventBatch, agentId: string) => Promise<void>;
  onQuotaBlocked?: (paseo: any, workspaceId: string, agentId: string, reason: string, pool: string) => Promise<void>;
  assignmentQuiet?: (paseo: any, sourceIds: string[], targetId: string) => Promise<string | null>;
  readAccountMoveObservation?: (client: any, agentId: string) => Promise<any>;
}

export interface DeliveryResult {
  status: "sent" | "pending" | "blocked";
  cleared: boolean;
  renewed?: boolean;
  deliveryId?: string;
  recordingError?: string;
  detail: string;
}

export interface EventBatch {
  workspaceId: string;
  epoch: number | null;
  events: WakeEvent[];
  /** A takeover request only starts the answer timer in the source scope. */
  takeover?: { scopeId: string; activeSlot: string | null; reason: string; observedAt?: string };
}

interface DeliveryInput {
  workspaceId: string;
  agentId: string;
  text?: string;
  renewalNote?: string;
  manual?: boolean;
  epoch?: number;
  batch?: EventBatch;
  state?: any;
  sendOptions?: { activeTurnBehavior: "steer" };
  actionId?: string;
  intent?: RoutingIntent;
}

export interface PendingSteerDelivery {
  wakeId: string;
  renewal: Renewal;
  phase: Phase;
  queuedAt: string;
  epoch: number | null;
  note: string;
  packet?: string;
  batch?: EventBatch;
  lastError?: string;
  kind?: string;
  sendOptions?: { activeTurnBehavior: "steer" };
  attemptedAt?: string;
  rewindAttempt?: unknown;
  lastDeliveryId?: string;
  observedAt?: string;
  authority?: { scopeId: string; agentId: string };
  needsResumeAt?: string | null;
  assignment?: { workspaceId: string; actionId: string };
  assignments?: AssignmentRef[];
  routing?: any;
  accountMove?: any;
  accountMoveReplan?: any;
}

const productionLock = withLock as unknown as Lock;
const runRewind = rewindAndBrief as unknown as (
  id: string, brief: string, options: {
    skipBrief: true; previousBriefId?: string; createClient: typeof defaultCreateRewindClient;
    beforeRewind: () => Promise<boolean>;
  },
) => Promise<{ status: string; messageId?: string; error?: string }>;
const markWorker = updateWorkerEntry as unknown as (args: {
  client: any; workspaceId: string; workerId: string; lock: Lock;
  patch: (worker: any, metadata: any) => Record<string, unknown> | null;
}) => Promise<any>;
const markSent = markWakeSent as unknown as (worker: any, options: { at: string; clearPending: boolean }) => any;
const formatWorkerWake = formatWakeMessage as unknown as (args: {
  events: WakeEvent[]; metadata: Record<string, unknown>;
}) => string | null;
const reconcileSend = reconcileSteerSend as unknown as (args: {
  client: any; workspaceId: string; agentId: string; actionId: string; lock: Lock;
  now?: () => string; validate?: (action: any, meta: any) => Promise<boolean>;
  beforeSend?: (action: any) => Promise<{ allowed: boolean; reason: string | null }>;
}) => Promise<any>;

function scopeState(meta: any) {
  return meta[METADATA_KEY];
}

/** A queued explicit request keeps its target tuple across renewal/restart. */
async function steerQuotaAdmission(agent: any, entry: any, deps: SteerDeliveryDeps, entries: Record<string, any> = {}) {
  const privacy = await readPrivacyAdmission(agent, deps);
  if (!privacy.allowed) return { ...privacy, privacyBlocked: true, pendingMove: false, pool: "", accountId: null, resetAt: null };
  const move = readSteerAction(entry)?.accountMove;
  const action = readSteerAction(entry);
  if (action?.phase !== "done" && move?.phase === "settled" &&
      (move.resolution === "ready" || admittedAccountMoveReplan(action))) {
    const observed = await readAdmissionSnapshot(deps);
    const admission = movedAccountAdmission(agent, entry, observed, entries);
    if (admission.status !== "ready" || admission.accountId !== move.observedAccountId ||
        (move.resolution === "ready" && admission.accountId !== move.accountId)) {
      return { allowed: false, pendingMove: true, reason: "moved account or fresh quota not confirmed", pool: "", accountId: null, resetAt: null };
    }
    const intent = readSteerAction(entry)?.routing?.intent;
    return !intent || routeMatchesIntent({ ...agent, agentId: agent.id }, intent) ? admission.admission :
      { ...admission.admission, allowed: false, reason: "explicit steer/model selection changed" };
  }
  const quota = await quotaOnlyAdmission(agent, entry, deps, entries);
  const admission = action?.kind === "activate" && action.phase !== "done"
    ? activationQuotaAdmission(quota, deps.confirmActivationQuota) : quota;
  const intent = readSteerAction(entry)?.routing?.intent;
  return !intent || routeMatchesIntent({ ...agent, agentId: agent.id }, intent) ? admission :
    { ...admission, allowed: false, reason: "explicit steer/model selection changed" };
}

function moveEligibility(agent: any, entry: any, observed: any, entries: Record<string, any>) {
  const admission = movedAccountAdmission(agent, entry, observed, entries);
  const intent = readSteerAction(entry)?.routing?.intent;
  const intentAllowed = !intent || routeMatchesIntent({ ...agent, agentId: agent.id }, intent);
  const accountId = observed.zerosub?.agentAccount?.[agent.id] ?? null;
  const ready = admission.status === "ready" && intentAllowed;
  // Only decision-relevant values belong here; repeated identical observations
  // must not create generations or metadata writes.
  const key = createHash("sha256").update(JSON.stringify([admission.status,
    admission.admission?.reason ?? null, accountId, intentAllowed])).digest("hex");
  return { ready, key, accountId };
}

function stoppedAfterQueued(entry: any, action: any): boolean {
  if (entry?.interrupted?.outcome !== "canceled") return false;
  const stopped = Date.parse(entry.interrupted.at ?? "");
  const queued = Date.parse(action?.queuedAt ?? "");
  return !Number.isFinite(stopped) || !Number.isFinite(queued) || stopped >= queued;
}

async function recoverAccountMove(paseo: any, input: DeliveryInput, pending: PendingSteerDelivery, deps: SteerDeliveryDeps, lock: Lock) {
  const result = await reconcileSteerAccountMove({
    client: paseo, workspaceId: input.workspaceId, agentId: input.agentId, actionId: pending.wakeId,
    lock, now: deps.now, ...(deps.readAccountMoveObservation ? { readObservation: deps.readAccountMoveObservation } : {}),
    validate: async ({ observation, accountId, entry, meta, resolution }: any) => {
      const observed = await readAdmissionSnapshot({ ...deps, paseo });
      if (observed.zerosub?.agentAccount?.[input.agentId] !== accountId ||
          observed.zerosub?.pending?.[input.agentId] ||
          observation.zerosub?.agentAccount?.[input.agentId] !== accountId) return false;
      const eligibility = moveEligibility(observation.agent, entry, observed, meta[AGENTS_KEY]);
      if (resolution === "replan") return { status: "replan", eligibilityKey: eligibility.key };
      if (eligibility.ready) return true;
      const admission = movedAccountAdmission(observation.agent, entry, observed, meta[AGENTS_KEY]);
      return admission.status === "replan" || admission.status === "ready"
        ? { status: "replan", eligibilityKey: eligibility.key } : false;
    },
  });
  return result;
}

function checkpointRevision(meta: any) {
  const checkpoint = meta[`${METADATA_KEY}.checkpoint`];
  return checkpoint?.updatedAt ?? checkpoint?.capturedAt ?? null;
}

export function pendingSteerDelivery(entry: any): PendingSteerDelivery | null {
  const action = readSteerAction(entry);
  return action && !["cleanup", "rewind", "fresh-delivery"].includes(action.kind) && action.phase !== "staged" && action.phase !== "done" ? action : null;
}

async function changeEntry(
  paseo: any, input: DeliveryInput, lock: Lock,
  change: (entry: any, meta: any, held: { verify: () => void }) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>,
) {
  const workspace = paseo.workspaces.ref(input.workspaceId);
  return lock(workspaceLockName(input.workspaceId), async (held) => {
    const meta = (await workspace.refresh())?.metadata ?? {};
    const entries = meta[AGENTS_KEY] ?? {};
    const entry = entries[input.agentId] ?? {};
    const patch = await change(entry, meta, held);
    if (!patch) return false;
    held.verify();
    const merged = mergeActionFacts(entry, patch);
    await workspace.setMetadata({ [AGENTS_KEY]: { ...entries, [input.agentId]: actionEntry(merged, "action" in patch ? merged.action : readSteerAction(merged)) } });
    return true;
  });
}

function replacePending(
  paseo: any, input: DeliveryInput, lock: Lock, pending: PendingSteerDelivery,
  patch: Record<string, unknown> | ((entry: any) => Record<string, unknown>),
) {
  return changeEntry(paseo, input, lock, (entry) => {
    if (readSteerAction(entry)?.wakeId !== pending.wakeId) return null;
    return typeof patch === "function" ? patch(entry) : patch;
  });
}

function afterDelivery(pending: PendingSteerDelivery, complete: boolean) {
  return complete ? { ...pending, phase: "done" } : pending.lastDeliveryId ? { wakeId: pending.lastDeliveryId, phase: "done" } : null;
}

function blocked(detail: string, cleared = false): DeliveryResult {
  return { status: "blocked", cleared, detail };
}

const STEER_BUSY = "The steer is busy. Delivery waits until the current turn ends.";
const CLEAR_UNCONFIRMED = "Claude context clear could not be confirmed. Retry recovery or use Fresh.";
const COMPACTION_WAIT_MS = 60_000;

const FACTORY_PAUSED = "Factory is paused. The delivery remains queued.";

async function automationPaused(deps: SteerDeliveryDeps): Promise<boolean> {
  return deps.automatic === true && await deps.isFactoryPaused?.() === true;
}

function deferred(detail: string = STEER_BUSY): DeliveryResult {
  return { status: "pending", cleared: false, detail };
}

function assignmentRefs(action: any): AssignmentRef[] {
  return Array.isArray(action?.assignments) ? action.assignments : action?.assignment ? [action.assignment] : [];
}

function includesAssignment(action: any, workspaceId: string, actionId: string): boolean {
  return assignmentRefs(action).some((ref) => ref.workspaceId === workspaceId && ref.actionId === actionId);
}

function sameTarget(a: AssignmentTarget | null | undefined, b: AssignmentTarget): boolean {
  return !!a && a.workspaceId === b.workspaceId && a.agentId === b.agentId && a.epoch === b.epoch && a.scopeId === b.scopeId;
}

function assignmentTarget(assignment: any, state: any): AssignmentTarget {
  const agents: any[] = state.agents ?? [];
  const liveFor = resolveContinuations(agents).liveFor as Record<string, string>;
  let recipient = liveFor[assignment.by] ?? assignment.by;
  const requester = state.workspaces?.find((ws: any) => ws.id === assignment.requesterWorkspaceId);
  const requesterState = requester?.metadata?.[METADATA_KEY];
  if (requester && !requester.archivedAt && requesterState && requesterState.scope?.id && requesterState.activeSteer) {
    recipient = scopeHolder({ agents, workspaceId: requester.id, scopeId: requesterState.scope.id,
      slot: requesterState.activeSteer }).id;
  }
  const agent = agents.find((entry) => entry.id === recipient);
  const workspace = state.workspaces?.find((entry: any) => entry.id === agent?.workspaceId);
  const scope = workspace?.metadata?.[METADATA_KEY];
  const labels = resolveFactoryLabels(agent, agents);
  if (!agent || agent.archivedAt || !workspace || workspace.archivedAt || !scope ||
      labels?.["wsf.role"] !== "steer" || !scope.scope?.id || !Number.isInteger(scope.epoch)) {
    throw new Error("Assignment recipient is not a live Factory steer; K7 cannot deliver to it.");
  }
  return { workspaceId: workspace.id, agentId: recipient, epoch: scope.epoch, scopeId: scope.scope.id };
}

function assignmentPacket(refs: AssignmentRef[]): string {
  if (refs.length === 1) return refs[0].text ?? "";
  return refs.map((ref) => `[Assignment source: ${ref.workspaceId}, action: ${ref.actionId}]\n${ref.text ?? ""}`).join("\n\n");
}

async function markAssignmentReported(paseo: any, ref: AssignmentRef, lock: Lock, at: string): Promise<void> {
  await lock(workspaceLockName(ref.workspaceId), async (held) => {
    const workspace = paseo.workspaces.ref(ref.workspaceId);
    const meta = (await workspace.refresh())?.metadata ?? {};
    const assignment = meta[ASSIGNMENT_KEY];
    if (assignment?.reportActionId !== ref.actionId || assignment.reportedAt) return;
    held.verify();
    await workspace.setMetadata({ [ASSIGNMENT_KEY]: { ...assignment, reportedAt: at } });
  });
}

async function bindAssignments(paseo: any, target: AssignmentTarget, action: any, lock: Lock): Promise<boolean> {
  for (const ref of assignmentRefs(action)) {
    const workspace = paseo.workspaces.ref(ref.workspaceId);
    const bound = await lock(workspaceLockName(ref.workspaceId), async (held) => {
      const meta = (await workspace.refresh())?.metadata ?? {};
      const assignment = meta[ASSIGNMENT_KEY];
      if (assignment?.reportActionId !== ref.actionId || assignment.reportedAt ||
          (ref.text !== undefined && assignment.reportText !== ref.text)) return false;
      const previous = assignment.reportTarget;
      if (previous && (!sameTarget(previous, target) || (previous.deliveryId && previous.deliveryId !== action.wakeId))) return false;
      held.verify();
      await workspace.setMetadata({ [ASSIGNMENT_KEY]: {
        ...assignment, reportTarget: { ...target, deliveryId: action.wakeId },
      } });
      return true;
    });
    if (!bound) return false;
  }
  return true;
}

async function assignmentBindingsValid(paseo: any, action: any, target: AssignmentTarget): Promise<boolean> {
  for (const ref of assignmentRefs(action)) {
    const assignment = (await paseo.workspaces.ref(ref.workspaceId).refresh())?.metadata?.[ASSIGNMENT_KEY];
    if (assignment?.reportActionId !== ref.actionId || assignment.reportedAt ||
        !sameTarget(assignment.reportTarget, target) || assignment.reportTarget?.deliveryId !== action.wakeId ||
        (ref.text !== undefined && assignment.reportText !== ref.text)) return false;
  }
  return true;
}

async function moveSourcesValid(paseo: any, action: any, input: DeliveryInput): Promise<boolean> {
  const authority = action.authority;
  if (!authority || !await assignmentBindingsValid(paseo, action, {
    workspaceId: input.workspaceId, agentId: input.agentId, epoch: action.epoch, scopeId: authority.scopeId,
  })) return false;
  const batch = action.batch;
  if (!batch) return true;
  const source = (await paseo.workspaces.ref(batch.workspaceId).refresh())?.metadata ?? {};
  if (batch.epoch !== null && scopeState(source)?.epoch !== batch.epoch) return false;
  if (batch.takeover) return true;
  return batch.events.every((event: WakeEvent) => {
    const wake = source[WORKERS_KEY]?.[event.workerId]?.pendingWake;
    return !!event.queuedAt && wake?.state === event.state && wake.queuedAt === event.queuedAt;
  }) && await staleBatchStillValid(paseo, batch);
}

async function assignmentIsQuiet(paseo: any, action: any, targetId: string, deps: SteerDeliveryDeps): Promise<boolean> {
  const refs = assignmentRefs(action);
  const sources = refs.map((ref) => ref.workspaceId);
  if (action?.batch?.takeover && action.batch.workspaceId) sources.push(action.batch.workspaceId);
  return sources.length > 0 && !!await deps.assignmentQuiet?.(paseo, sources, targetId);
}

/** One durable decision per changed eligibility; never repeats the native move. */
async function replanAccountMove(paseo: any, input: DeliveryInput, pending: PendingSteerDelivery, deps: SteerDeliveryDeps, lock: Lock) {
  return lock(workspaceLockName(input.workspaceId), async (held) => {
    const workspace = paseo.workspaces.ref(input.workspaceId);
    const meta = (await workspace.refresh())?.metadata ?? {};
    const entry = meta[AGENTS_KEY]?.[input.agentId];
    const action = readSteerAction(entry), move = action?.accountMove;
    if (action?.wakeId !== pending.wakeId || move?.phase !== "settled" || move.resolution !== "replan" ||
        !["reserved", "ready"].includes(action.phase) || action.attemptedAt || action.rewindAttempt || action.cleanup ||
        stoppedAfterQueued(entry, action)) return false;
    if (admittedAccountMoveReplan(action)) return true;
    try {
      await guardScope({ client: paseo, held, workspaceId: input.workspaceId, scopeId: action.authority?.scopeId,
        epoch: action.epoch, agentId: input.agentId });
    } catch { return false; }
    if (await assignmentIsQuiet(paseo, action, input.workspaceId, deps) || !await moveSourcesValid(paseo, action, input)) return false;
    const agent = (await paseo.agents.ref(input.agentId).refresh())?.agent;
    if (!agent || hasActiveAgentWork(agent, entry)) return false;
    const observed = await readAdmissionSnapshot({ ...deps, paseo });
    const eligibility = moveEligibility(agent, entry, observed, meta[AGENTS_KEY]);
    if (eligibility.accountId !== move.observedAccountId || observed.zerosub?.pending?.[input.agentId]) return false;
    const prior = action.accountMoveReplan;
    if (prior?.eligibilityKey === eligibility.key) return false;
    // Legacy records establish a baseline first; they never reopen on an
    // observation whose eligibility at settlement is unknown.
    const ready = !!prior?.eligibilityKey && eligibility.ready;
    try {
      await guardScope({ client: paseo, held, workspaceId: input.workspaceId, scopeId: action.authority.scopeId,
        epoch: action.epoch, agentId: input.agentId });
    } catch { return false; }
    held.verify();
    await workspace.setMetadata({ [AGENTS_KEY]: { ...meta[AGENTS_KEY], [input.agentId]: actionEntry(entry, {
      ...action, accountMoveReplan: { status: ready ? "ready" : "waiting", eligibilityKey: eligibility.key,
        ...(ready ? { attemptedAt: move.attemptedAt, accountId: move.observedAccountId } : {}) },
    }) } });
    return ready;
  });
}

async function releaseUnattemptedAssignment(paseo: any, previous: AssignmentTarget, sourceWorkspaceId: string, actionId: string, lock: Lock): Promise<boolean> {
  const workspace = paseo.workspaces.ref(previous.workspaceId);
  const action = await lock(workspaceLockName(previous.workspaceId), async () => {
    const meta = (await workspace.refresh())?.metadata ?? {};
    const current = readSteerAction(meta[AGENTS_KEY]?.[previous.agentId]);
    if (current?.wakeId !== (previous.deliveryId ?? actionId) || !includesAssignment(current, sourceWorkspaceId, actionId)) {
      return previous.unreserved === true ? null : false;
    }
    if (current.attemptedAt || current.rewindAttempt || current.cleanup || unsettledAccountMove(current) || !["reserved", "ready"].includes(current.phase)) return false;
    return current;
  });
  if (action === false) return false;
  if (!action) return true;
  for (const ref of assignmentRefs(action)) {
    await lock(workspaceLockName(ref.workspaceId), async (held) => {
      const source = paseo.workspaces.ref(ref.workspaceId);
      const meta = (await source.refresh())?.metadata ?? {};
      const assignment = meta[ASSIGNMENT_KEY];
      if (assignment?.reportActionId !== ref.actionId || assignment.reportedAt ||
          !sameTarget(assignment.reportTarget, previous) ||
          (assignment.reportTarget?.deliveryId && assignment.reportTarget.deliveryId !== action.wakeId)) return;
      held.verify();
      await source.setMetadata({ [ASSIGNMENT_KEY]: { ...assignment, reportTarget: null } });
    });
  }
  await changeEntry(paseo, previous, lock, (entry) => {
    const current = readSteerAction(entry);
    if (current?.wakeId !== action.wakeId || current.attemptedAt || current.rewindAttempt || current.cleanup || unsettledAccountMove(current) ||
        !["reserved", "ready"].includes(current.phase)) return null;
    return { action: afterDelivery(current, false) };
  });
  return true;
}

/** Reserve the existing K7 action even when the recipient is currently busy. */
export async function reserveAssignmentDelivery(
  paseo: any, input: { workspaceId: string; agentId: string; epoch: number; scopeId: string; actionId: string; text: string; sourceWorkspaceId: string },
  deps: SteerDeliveryDeps = {},
): Promise<DeliveryResult> {
  if (await deps.assignmentQuiet?.(paseo, [input.sourceWorkspaceId], input.workspaceId)) return deferred("Assignment report waits for boot or drain.");
  const [snapshot, workspace] = await Promise.all([
    paseo.agents.ref(input.agentId).refresh(), paseo.workspaces.ref(input.workspaceId).refresh(),
  ]);
  const agent = snapshot?.agent;
  const meta = workspace?.metadata ?? {};
  const pendingAction = readSteerAction(meta[AGENTS_KEY]?.[input.agentId]);
  if (pendingAction?.accountMove && stoppedAfterQueued(meta[AGENTS_KEY]?.[input.agentId], pendingAction)) {
    return blocked("Delivery is paused after a canceled turn.");
  }
  const admission = await steerQuotaAdmission(agent ?? { id: input.agentId }, meta[AGENTS_KEY]?.[input.agentId],
    { ...deps, paseo }, meta[AGENTS_KEY]);
  if (!admission.allowed) {
    if (!admission.pendingMove && !("privacyBlocked" in admission) && !await deps.assignmentQuiet?.(paseo, [input.sourceWorkspaceId], input.workspaceId)) {
      await deps.onQuotaBlocked?.(paseo, input.workspaceId, input.agentId, admission.reason ?? "quota exhausted", admission.pool);
    }
    return deferred(`Assignment report waits: ${admission.reason}.`);
  }
  const lock = deps.lock ?? productionLock;
  const state: any = await readPaseoState(paseo);
  const target: AssignmentTarget = { workspaceId: input.workspaceId, agentId: input.agentId, epoch: input.epoch, scopeId: input.scopeId };
  const candidates: AssignmentRef[] = [];
  for (const workspace of state.workspaces ?? []) {
    const report = workspace.metadata?.[ASSIGNMENT_KEY];
    if (!report?.reportActionId || report.reportedAt || typeof report.reportText !== "string") continue;
    try {
      if (!sameTarget(assignmentTarget(report, state), target)) continue;
    } catch {
      continue;
    }
    if (report.reportTarget && !sameTarget(report.reportTarget, target)) continue;
    if (await deps.assignmentQuiet?.(paseo, [workspace.id], input.workspaceId)) continue;
    candidates.push({ workspaceId: workspace.id, actionId: report.reportActionId, text: report.reportText });
  }
  candidates.sort((a, b) => Number(b.workspaceId === input.sourceWorkspaceId && b.actionId === input.actionId) -
    Number(a.workspaceId === input.sourceWorkspaceId && a.actionId === input.actionId) ||
    a.workspaceId.localeCompare(b.workspaceId) || a.actionId.localeCompare(b.actionId));
  let alreadySent = false;
  let selectedAction: any = null;
  let missingBoundAction = false;
  const reserved = await changeEntry(paseo, input, lock, async (entry, meta, held) => {
    const scope = scopeState(meta);
    if (!scope || scope.epoch !== input.epoch) return null;
    try {
      await guardScope({ client: paseo, held, workspaceId: input.workspaceId, scopeId: input.scopeId,
        epoch: input.epoch, agentId: input.agentId });
    } catch {
      return null;
    }
    const liveAgent = (await paseo.agents.ref(input.agentId).refresh())?.agent;
    if (readSteerAction(entry)?.accountMove && stoppedAfterQueued(entry, readSteerAction(entry))) return null;
    if (!liveAgent || !(await steerQuotaAdmission(liveAgent, entry, { ...deps, paseo }, meta[AGENTS_KEY])).allowed) return null;
    const prior = readSteerAction(entry);
    if (includesAssignment(prior, input.sourceWorkspaceId, input.actionId) && prior.phase !== "reserved") {
      selectedAction = prior;
      if (prior.phase === "done") alreadySent = true;
      return null;
    }
    if (prior && prior.phase !== "done" && (prior.phase !== "reserved" || !assignmentRefs(prior).length ||
        prior.epoch !== input.epoch || prior.attemptedAt)) return null;
    const source = state.workspaces?.find((workspace: any) => workspace.id === input.sourceWorkspaceId)?.metadata?.[ASSIGNMENT_KEY];
    if (source?.reportTarget?.deliveryId && prior?.wakeId !== source.reportTarget.deliveryId) {
      missingBoundAction = true;
      return null;
    }
    const wakeId = prior?.phase === "reserved" ? prior.wakeId : input.actionId;
    const refs: AssignmentRef[] = prior?.phase === "reserved" ? assignmentRefs(prior).flatMap((ref) => {
      const candidate = candidates.find((item) => item.workspaceId === ref.workspaceId && item.actionId === ref.actionId);
      if (!candidate || (ref.text !== undefined && ref.text !== candidate.text)) return [];
      const report = state.workspaces.find((workspace: any) => workspace.id === ref.workspaceId)?.metadata?.[ASSIGNMENT_KEY];
      if (report?.reportTarget?.deliveryId && report.reportTarget.deliveryId !== wakeId) return [];
      return [{ ...candidate }];
    }) : [];
    for (const candidate of candidates) {
      if (refs.some((ref) => ref.workspaceId === candidate.workspaceId && ref.actionId === candidate.actionId)) continue;
      const report = state.workspaces.find((workspace: any) => workspace.id === candidate.workspaceId)?.metadata?.[ASSIGNMENT_KEY];
      if (report?.reportTarget?.deliveryId && report.reportTarget.deliveryId !== wakeId) continue;
      const proposed = [...refs, candidate];
      if (refs.length && assignmentPacket(proposed).length > 6000) continue;
      refs.push(candidate);
    }
    if (!refs.some((ref) => ref.workspaceId === input.sourceWorkspaceId && ref.actionId === input.actionId)) return null;
    if (refs.some((ref) => typeof ref.text !== "string")) return null;
    if (await deps.assignmentQuiet?.(paseo, refs.map((ref) => ref.workspaceId), input.workspaceId)) return null;
    const action = {
      ...newSteerAction({ kind: "assignment", id: wakeId, epoch: input.epoch, text: assignmentPacket(refs),
        at: prior?.phase === "reserved" ? prior.queuedAt : deps.now?.() ?? new Date().toISOString(), phase: "reserved",
        ...(prior?.phase === "reserved" && prior?.batch ? { batch: prior.batch } : {}) }),
      authority: { scopeId: input.scopeId, agentId: input.agentId },
      assignment: { workspaceId: refs[0].workspaceId, actionId: refs[0].actionId },
      assignments: refs,
      ...(prior?.phase === "reserved" && prior?.accountMove ? { accountMove: prior.accountMove } : {}),
      ...(prior?.phase === "reserved" && prior?.accountMoveReplan ? { accountMoveReplan: prior.accountMoveReplan } : {}),
      ...(prior?.phase === "reserved" && prior?.routing ? { routing: prior.routing } : {}),
      ...(prior?.phase === "reserved" && prior?.needsResumeAt !== undefined ? { needsResumeAt: prior.needsResumeAt } : {}),
      ...(prior?.phase === "done" ? { lastDeliveryId: prior.wakeId } : prior?.lastDeliveryId ? { lastDeliveryId: prior.lastDeliveryId } : {}),
    };
    selectedAction = action;
    return { action };
  });
  if (alreadySent) {
    await markAssignmentReported(paseo, { workspaceId: input.sourceWorkspaceId, actionId: input.actionId },
      lock, selectedAction.observedAt ?? deps.now?.() ?? new Date().toISOString());
    return { status: "sent", cleared: false, detail: "Assignment report already delivered." };
  }
  if (missingBoundAction) return blocked("Assignment delivery record is missing; receipt reconciliation is required.");
  if (!reserved) {
    const meta = (await paseo.workspaces.ref(input.workspaceId).refresh())?.metadata ?? {};
    selectedAction = readSteerAction(meta[AGENTS_KEY]?.[input.agentId]);
    if (!includesAssignment(selectedAction, input.sourceWorkspaceId, input.actionId)) {
      return deferred("Another steer operation is already queued.");
    }
  }
  if (selectedAction.phase === "reserved" && !await bindAssignments(paseo, target, selectedAction, lock)) {
    return deferred("Assignment records changed while preparing delivery.");
  }
  return deliverSteer(paseo, { ...input, actionId: selectedAction.wakeId, text: selectedAction.packet,
    batch: selectedAction.batch, intent: selectedAction.routing?.intent, epoch: input.epoch }, deps);
}

/** Re-dispatch a durably queued assignment without depending on another sender turn. */
export async function dispatchAssignmentReport(
  paseo: any, sourceWorkspaceId: string, deps: SteerDeliveryDeps = {},
): Promise<DeliveryResult | null> {
  if (await automationPaused(deps)) return deferred(FACTORY_PAUSED);
  const lock = deps.lock ?? productionLock;
  let assignment: any = null;
  let target: AssignmentTarget | null = null;
  const source = (await paseo.workspaces.ref(sourceWorkspaceId).refresh())?.metadata ?? {};
  assignment = source[ASSIGNMENT_KEY];
  if (!assignment?.reportActionId || assignment.reportedAt || typeof assignment.reportText !== "string") return null;
  if (assignment.reportTarget) {
    const old = assignment.reportTarget;
    const oldMeta = (await paseo.workspaces.ref(old.workspaceId).refresh())?.metadata ?? {};
    const action = readSteerAction(oldMeta[AGENTS_KEY]?.[old.agentId]);
    const deliveryId = old.deliveryId ?? assignment.reportActionId;
    const matches = action?.wakeId === deliveryId && includesAssignment(action, sourceWorkspaceId, assignment.reportActionId);
    if (matches && unsettledAccountMove(action)) return finishSteerDelivery(paseo, old, deps);
    if (matches && action.phase === "sent") {
      return finishSteerDelivery(paseo, old, deps);
    }
    if (matches && action.phase === "done") {
      await markAssignmentReported(paseo, { workspaceId: sourceWorkspaceId, actionId: assignment.reportActionId },
        lock, action.observedAt ?? deps.now?.() ?? new Date().toISOString());
      return { status: "sent", cleared: false, detail: "Assignment report already delivered." };
    }
  }
  {
    const state: any = await readPaseoState(paseo);
    let chosen: AssignmentTarget;
    try {
      chosen = assignmentTarget(assignment, state);
    } catch (error) {
      return blocked(`Assignment requester scope unavailable (${error instanceof Error ? error.message : String(error)}).`);
    }
    const recipient = (await paseo.agents.ref(chosen.agentId).refresh())?.agent;
    if (!recipient) return blocked("Assignment requester is no longer available.");
    const privacy = await readPrivacyAdmission(recipient, { ...deps, paseo }, chosen.workspaceId);
    if (!privacy.allowed) return deferred(`Assignment report waits: ${privacy.reason}.`);
    let previous = assignment.reportTarget;
    if (previous && !sameTarget(previous, chosen)) {
      if (!await releaseUnattemptedAssignment(paseo, previous, sourceWorkspaceId, assignment.reportActionId, lock)) {
        return blocked("Assignment delivery needs receipt or renewal reconciliation before rebinding.");
      }
      assignment = (await paseo.workspaces.ref(sourceWorkspaceId).refresh())?.metadata?.[ASSIGNMENT_KEY];
      if (!assignment || assignment.reportedAt) return null;
      previous = assignment.reportTarget;
    }
    await lock(workspaceLockName(sourceWorkspaceId), async (held) => {
      const meta = (await paseo.workspaces.ref(sourceWorkspaceId).refresh())?.metadata ?? {};
      const current = meta[ASSIGNMENT_KEY];
      if (current?.reportActionId !== assignment.reportActionId || current.reportedAt) return;
      if (JSON.stringify(current.reportTarget ?? null) !== JSON.stringify(previous ?? null)) {
        target = current.reportTarget ?? null;
        return;
      }
      if (sameTarget(previous, chosen)) {
        target = previous;
        return;
      }
      held.verify();
      target = { ...chosen, unreserved: true };
      await paseo.workspaces.ref(sourceWorkspaceId).setMetadata({ [ASSIGNMENT_KEY]: { ...current, reportTarget: target } });
    });
  }
  const selected = target as AssignmentTarget | null;
  if (!selected) return null;
  return reserveAssignmentDelivery(paseo, { ...selected, actionId: assignment.reportActionId, text: assignment.reportText, sourceWorkspaceId }, deps);
}

function clearConfirmed(entry: any, snapshot: any, pending: PendingSteerDelivery): boolean {
  const cleared = actionFact(entry, "cleared");
  if (cleared?.mode !== "clear" || actionFact(entry, "actionVerified") !== true) return false;
  if (Date.parse(cleared.at) < Date.parse(pending.queuedAt)) return false;
  const current = snapshot?.persistence?.sessionId;
  if (typeof current !== "string" || !current) return false;
  if (cleared.sessionId) return current === cleared.sessionId;
  // Legacy entries can be corroborated with the session recorded before dispatch.
  const previous = Array.isArray(entry.previousSessions) ? entry.previousSessions.at(-1) : null;
  return typeof previous === "string" && previous.length > 0 && previous !== current;
}

async function staleBatchStillValid(paseo: any, batch: EventBatch | undefined): Promise<boolean> {
  if (!batch || batch.takeover || !batch.events.length) return true;
  const source = (await paseo.workspaces.ref(batch.workspaceId).refresh())?.metadata ?? {};
  return (await filterStaleWorkerEvents(paseo, source, batch.events)).length === batch.events.length;
}

const finishing = new Set<string>();

function releaseDeliveryCompaction(paseo: any, input: DeliveryInput, lock: Lock, wakeId: string) {
  return changeEntry(paseo, input, lock, (entry) => {
    const action = readSteerAction(entry);
    const cleanup = readCleanupAction(entry);
    if (action?.wakeId !== wakeId || action.renewal !== "send" || cleanup?.kind !== "compact" ||
        cleanup.reason !== RESUME_PENDING_REASON) return null;
    return { action: { ...action, cleanup: null } };
  });
}

/** Releases a queued brief once the target is idle and any preparation has settled. */
export async function finishSteerDelivery(
  paseo: any, input: DeliveryInput, deps: SteerDeliveryDeps = {},
  compactBeforeSend = false,
): Promise<DeliveryResult | null> {
  if (await automationPaused(deps)) return deferred(FACTORY_PAUSED);
  const key = `${input.workspaceId}/${input.agentId}`;
  if (finishing.has(key)) return { status: "pending", cleared: false, detail: "The steer brief is being delivered." };
  finishing.add(key);
  const lock = deps.lock ?? productionLock;
  try {
    const workspace = paseo.workspaces.ref(input.workspaceId);
    let meta = (await workspace.refresh())?.metadata ?? {};
    let entry = meta[AGENTS_KEY]?.[input.agentId];
    const receipt = readSteerAction(entry);
    const effect = readEffectReceipt(meta, receipt);
    if (input.actionId && receipt?.wakeId !== input.actionId) return null;
    if (input.actionId && receipt?.kind === "activate") {
      if (input.epoch !== undefined && scopeState(meta)?.epoch !== input.epoch) {
        return blocked("The scope moved before the steer could be reached.");
      }
      if (receipt.phase === "done") return { status: "sent", cleared: false, detail: "Activation continuation already delivered." };
    }
    if (effect?.kind === "rewind") {
      const settled = await settleRewindReceipt({ client: paseo, ...input, actionId: receipt.wakeId, lock });
      if (settled?.action?.wakeId !== receipt.wakeId) return null;
      if (receipt.kind === "rewind") {
        return { status: effect.briefMessageId ? "sent" : "pending", cleared: false, renewed: true,
          detail: settled.action.phase === "staged" ? "Context rewound and brief staged." : effect.sendError ?? "Context rewind recorded." };
      }
      meta = (await workspace.refresh())?.metadata ?? {};
      entry = meta[AGENTS_KEY]?.[input.agentId];
      if (readSteerAction(entry)?.wakeId !== receipt.wakeId) return null;
    }
    if (receipt?.kind === "fresh-delivery" && receipt.phase !== "done") {
      if (receipt.phase !== "sent" && effect?.kind !== "send" &&
          hasActiveAgentWork((await paseo.agents.ref(input.agentId).refresh())?.agent, entry)) return deferred();
      const result = await reconcileFreshDelivery({ client: paseo, ...input, actionId: receipt.wakeId, lock,
        checkPrivacy: async (agentId: string, epoch: number) => {
          if (await automationPaused(deps)) return { allowed: false, reason: FACTORY_PAUSED };
          await requireFreshPrivacy({
            client: paseo, workspaceId: input.workspaceId, scopeId: scopeState(meta)?.scope?.id, agentId, epoch,
            admitTarget: (agent: any) => readPrivacyAdmission(agent, { ...deps, paseo }, input.workspaceId),
          });
          if (await automationPaused(deps)) return { allowed: false, reason: FACTORY_PAUSED };
        },
      });
      return { status: result.status === "sent" ? "sent" : result.status === "blocked" || result.status === "missing" ? "blocked" : "pending",
        cleared: false, renewed: true, recordingError: result.recordingError,
        detail: result.status === "sent" ? result.recordingError ?? "Fresh brief delivered." : result.detail ?? "Fresh brief needs receipt reconciliation." };
    }
    let pending = pendingSteerDelivery(entry);
    if (!pending) return null;
    if (effect?.kind === "send" && pending.phase !== "sent") {
      const recovered = await reconcileSend({ client: paseo, ...input, actionId: pending.wakeId, lock });
      if (recovered.status !== "sent") return deferred("The delivery record changed during reconciliation.");
      pending = recovered.action as PendingSteerDelivery;
    }
    const cleared = pending.renewal === "clear";
    if (pending.phase !== "sent" && pending.accountMove && stoppedAfterQueued(entry, pending)) {
      return blocked("Delivery is paused after a canceled turn.", cleared);
    }
    const targetScope = scopeState(meta);
    if (pending.phase !== "sent" && (!targetScope ||
        (pending.epoch !== null && pending.epoch !== targetScope.epoch))) {
      if (unsettledAccountMove(pending)) return blocked("Scope authority changed; the account move remains recorded.", cleared);
      if (assignmentRefs(pending).length && !pending.attemptedAt && !pending.rewindAttempt && !readCleanupAction(entry) &&
          ["reserved", "ready"].includes(pending.phase)) {
        return deferred("Assignment delivery awaits rebinding after scope authority changed.");
      }
      if (pending.batch && !pending.attemptedAt && !pending.rewindAttempt && !readCleanupAction(entry) &&
          ["reserved", "ready"].includes(pending.phase)) {
        await replacePending(paseo, input, lock, pending, { action: afterDelivery(pending, false) });
        return null;
      }
      await replacePending(paseo, input, lock, pending, { action: { ...pending, phase: "blocked", lastError: "Scope authority changed while a delivery remains unresolved." } });
      return blocked("Scope authority changed while a delivery remains unresolved.", cleared);
    }
    if (unsettledAccountMove(pending)) {
      if (await assignmentIsQuiet(paseo, pending, input.workspaceId, deps)) return deferred("Assignment report waits for boot or drain.");
      if (await automationPaused(deps)) return deferred(FACTORY_PAUSED);
      const recovered = await recoverAccountMove(paseo, input, pending, deps, lock);
      if (recovered.status !== "ready") {
        return { status: recovered.status === "blocked" ? "blocked" : "pending", cleared,
          deliveryId: pending.wakeId, detail: recovered.detail };
      }
      const refreshed = (await paseo.workspaces.ref(input.workspaceId).refresh())?.metadata ?? {};
      entry = refreshed[AGENTS_KEY]?.[input.agentId];
      pending = pendingSteerDelivery(entry);
      if (!pending) return deferred("Delivery changed during account move recovery.");
    }
    if (pending.accountMove?.resolution === "replan" && !admittedAccountMoveReplan(pending)) {
      if (!await replanAccountMove(paseo, input, pending, deps, lock)) {
        return deferred("Delivery needs a new route after the account move.");
      }
      const refreshed = (await paseo.workspaces.ref(input.workspaceId).refresh())?.metadata ?? {};
      entry = refreshed[AGENTS_KEY]?.[input.agentId];
      pending = pendingSteerDelivery(entry);
      if (!pending) return deferred("Delivery changed during account move replanning.");
    }
    const agent = paseo.agents.ref(input.agentId);
    if (pending.phase === "reserved") {
      finishing.delete(key);
      const source = assignmentRefs(pending)[0];
      if (source) return dispatchAssignmentReport(paseo, source.workspaceId, deps);
      return deliverSteer(paseo, { ...input, actionId: pending.wakeId, text: pending.packet, renewalNote: pending.note,
        batch: pending.batch, sendOptions: pending.sendOptions, intent: pending.routing?.intent, epoch: pending.epoch ?? undefined }, deps);
    }
    if (pending.phase !== "sent") {
      if (await assignmentIsQuiet(paseo, pending, input.workspaceId, deps)) return deferred("Assignment report waits for boot or drain.");
      const snapshot = (await agent.refresh())?.agent;
      if (!snapshot || snapshot.archivedAt || snapshot.background === true) {
        return blocked("The delivery target is unavailable; its action remains recorded.", cleared);
      }
      const admission = await steerQuotaAdmission(snapshot, entry, { ...deps, paseo }, meta[AGENTS_KEY]);
      if (!admission.allowed) return deferred(`Delivery waits: ${admission.reason}.`);
      const cleanup = readCleanupAction(entry);
      if (pending.renewal === "send" && cleanup?.kind === "compact" && cleanup.reason === RESUME_PENDING_REASON &&
          Date.now() - Date.parse(cleanup.at) >= COMPACTION_WAIT_MS && !hasActiveAgentWork(snapshot, entry)) {
        const wakeId = pending.wakeId;
        await releaseDeliveryCompaction(paseo, input, lock, wakeId);
        entry = (await paseo.workspaces.ref(input.workspaceId).refresh())?.metadata?.[AGENTS_KEY]?.[input.agentId];
        pending = pendingSteerDelivery(entry);
        if (pending?.wakeId !== wakeId) return deferred("Steer state changed while recovering the brief.");
      }
      if (pending.phase === "renewing" || readCleanupAction(entry)) {
        return { status: "pending", cleared, detail: "Context renewal is in progress. The brief follows confirmation." };
      }
      if (pending.phase === "blocked" && pending.renewal === "rewind" && !pending.rewindAttempt && !pending.attemptedAt &&
          !input.manual && pending.routing?.intent?.mode !== "explicit" && await deps.keepChatHistory?.()) {
        // A failed preparation that never reached the provider can still deliver its brief.
        const retained = await changeEntry(paseo, input, lock, (current) => {
          const action = readSteerAction(current);
          if (action?.wakeId !== pending?.wakeId || action.phase !== "blocked" || action.renewal !== "rewind" || action.attemptedAt ||
              action.rewindAttempt || readCleanupAction(current)) return null;
          const { lastError: _error, ...ready } = action;
          return { action: { ...ready, phase: "ready", renewal: "send" } };
        });
        if (!retained) return deferred("Steer state changed while recovering the brief.");
        entry = (await paseo.workspaces.ref(input.workspaceId).refresh())?.metadata?.[AGENTS_KEY]?.[input.agentId];
        pending = pendingSteerDelivery(entry);
        if (!pending) return deferred("Steer state changed while recovering the brief.");
      }
      const batch = pending.batch;
      if (!pending.attemptedAt && batch?.events.some(({ state }) => state === "stale")) {
        const source = (await paseo.workspaces.ref(batch.workspaceId).refresh())?.metadata ?? {};
        const events = await filterStaleWorkerEvents(paseo, source, batch.events);
        if (events.length !== batch.events.length) {
          if (!events.length || batch.takeover) {
            await replacePending(paseo, input, lock, pending, { action: afterDelivery(pending, false) });
            return null;
          }
          const { packet: _packet, ...unpinned } = pending;
          const next = {
            ...unpinned, batch: { ...batch, events },
            note: formatWorkerWake({ events, metadata: source }) ?? "",
          };
          if (!await replacePending(paseo, input, lock, pending, { action: next })) {
            return deferred("Steer state changed while checking deferred worker events.");
          }
          pending = next;
        }
      }
      if (pending.phase === "blocked") return blocked(pending.lastError ?? "Context renewal needs attention.");
      if (hasActiveAgentWork(snapshot, entry)) return pending.phase === "uncertain" ? blocked("Delivery outcome is uncertain; waiting for receipt reconciliation.", cleared) : deferred();
      if (cleared && !clearConfirmed(entry, snapshot, pending)) {
        await replacePending(paseo, input, lock, pending, {
          action: { ...pending, phase: "blocked", lastError: CLEAR_UNCONFIRMED },
        });
        return blocked(CLEAR_UNCONFIRMED);
      }
      if (compactBeforeSend && pending.renewal === "send" && pending.phase === "ready" && !pending.attemptedAt) {
        const beforeSend = async () => {
          const current = (await paseo.workspaces.ref(input.workspaceId).refresh())?.metadata ?? {};
          const currentEntry = current[AGENTS_KEY]?.[input.agentId];
          const live = (await agent.refresh())?.agent;
          return !!live && !live.archivedAt && !hasActiveAgentWork(live, currentEntry) &&
            live.provider === snapshot.provider && readSteerAction(currentEntry)?.wakeId === pending?.wakeId &&
            scopeState(current)?.epoch === targetScope.epoch && !!await deps.keepChatHistory?.() &&
            !await assignmentIsQuiet(paseo, pending, input.workspaceId, deps) &&
            await staleBatchStillValid(paseo, pending?.batch) &&
            (await steerQuotaAdmission(live, currentEntry, { ...deps, paseo }, current[AGENTS_KEY])).allowed &&
            (await readPrivacyAdmission(live, { ...deps, paseo }, input.workspaceId)).allowed && !await automationPaused(deps);
        };
        const claude = isClaudeProvider(snapshot.provider);
        const commands = claude ? null : await agent.commands?.().catch(() => null);
        const nativeCompact = claude || commands?.commands?.some((command: any) => command.name === "compact" && command.kind === "command");
        if (nativeCompact) {
          // Codex and other providers can compact out of band, without a turn hook.
          const timeout = new AbortController();
          let complete: () => void = () => {};
          const observed = new Promise<void>((resolve) => { complete = resolve; });
          let dispatched = false;
          let subscription: PaseoAgentTimelineSubscription | null = null;
          try {
            if (!claude) {
              const timeline: PaseoAgentTimelineHandle = agent.timeline;
              subscription = timeline.subscribe(({ event }) => {
                if (dispatched && event.type === "timeline" && event.item.type === "compaction" &&
                    event.item.status === "completed" && event.item.trigger !== "auto") complete();
              });
              await subscription.ready;
            }
            await (deps.runCleanupFn ?? runCleanup)(paseo, input.agentId, "compact", RESUME_PENDING_REASON, {
              workspaceId: input.workspaceId, lock, deliveryId: pending.wakeId,
              ...(!claude ? { compactCommand: "/compact" } : {}),
              beforeSend: async () => {
                dispatched = await beforeSend();
                return dispatched;
              },
            });
            if (subscription) {
              await Promise.race([observed, wait(COMPACTION_WAIT_MS, undefined, { signal: timeout.signal, ref: false })]);
              await releaseDeliveryCompaction(paseo, input, lock, pending.wakeId);
            }
          } catch (error) {
            if (!(error instanceof AgentBusyError)) console.warn(`[factory] delivery compact: ${String(error)}`);
          } finally {
            timeout.abort();
            subscription?.();
          }
          const current = (await paseo.workspaces.ref(input.workspaceId).refresh())?.metadata ?? {};
          entry = current[AGENTS_KEY]?.[input.agentId];
          if (readCleanupAction(entry)) return deferred("The brief is queued behind native compaction.");
        }
      }
    }
    let sent = pending;
    try {
      if (pending.phase !== "sent") {
        const buildPacket = !sent.packet;
        if (buildPacket) {
          const brief = await deps.buildBrief?.(paseo, input.workspaceId, input.agentId);
          if (!brief) return { status: "pending", cleared, detail: "The renewed steer is waiting for its brief." };
          const full = pending.note ? `${brief}

${pending.note}` : brief;
          sent = { ...pending, packet: formatResumeMessage(full) };
        }
        const current = (await paseo.workspaces.ref(input.workspaceId).refresh())?.metadata ?? {};
        const currentEntry = current[AGENTS_KEY]?.[input.agentId];
        if (readSteerAction(currentEntry)?.wakeId !== pending.wakeId ||
            (pending.epoch !== null && pending.epoch !== scopeState(current)?.epoch)) {
          return { status: "pending", cleared, detail: "Steer state changed while preparing the brief." };
        }
        if (buildPacket && (currentEntry?.lastTurnId !== entry?.lastTurnId || checkpointRevision(current) !== checkpointRevision(meta))) {
          return deferred("The checkpoint changed while preparing the brief. Delivery will refresh it.");
        }
        if (pending.batch?.takeover && pending.batch.workspaceId !== input.workspaceId) {
          const source = (await paseo.workspaces.ref(pending.batch.workspaceId).refresh())?.metadata ?? {};
          if (scopeState(source)?.epoch !== pending.batch.epoch) {
            await replacePending(paseo, input, lock, pending, { action: afterDelivery(pending, false) });
            return null;
          }
        }
        if (!pending.attemptedAt && !await staleBatchStillValid(paseo, pending.batch)) return deferred("Worker events changed while preparing the brief.");
        if (hasActiveAgentWork((await agent.refresh())?.agent, currentEntry)) return deferred();
        if (buildPacket && !await changeEntry(paseo, input, lock, (current) => {
          const action = readSteerAction(current);
          if (action?.wakeId !== pending.wakeId || action.phase !== pending.phase ||
              action.attemptedAt || action.packet !== pending.packet) return null;
          return { action: sent };
        })) {
          return deferred("Steer state changed while preparing the brief.");
        }
        const latest = (await agent.refresh())?.agent;
        if (!latest || latest.archivedAt || hasActiveAgentWork(latest)) {
          if (buildPacket) await changeEntry(paseo, input, lock, (current) => {
            const action = readSteerAction(current);
            if (action?.wakeId !== pending.wakeId || action.phase !== pending.phase ||
                action.attemptedAt || action.packet !== sent.packet) return null;
            return { action: pending };
          });
          return deferred();
        }
        if (cleared && !clearConfirmed(currentEntry, latest, pending)) {
          await replacePending(paseo, input, lock, pending, {
            action: { ...pending, phase: "blocked", lastError: CLEAR_UNCONFIRMED },
          });
          return blocked(CLEAR_UNCONFIRMED);
        }
        const result = await reconcileSend({ client: paseo, workspaceId: input.workspaceId,
          agentId: input.agentId, actionId: pending.wakeId, lock, now: deps.now,
          beforeSend: async () => {
            const live = (await agent.refresh())?.agent;
            if (live?.id !== input.agentId || live.workspaceId !== input.workspaceId || live.archivedAt || live.background === true) {
              return { allowed: false, reason: "The delivery target is unavailable; its action remains recorded." };
            }
            const privacy = await readPrivacyAdmission(live, { ...deps, paseo }, input.workspaceId);
            return await automationPaused(deps) ? { allowed: false, reason: FACTORY_PAUSED } : privacy;
          },
          validate: async (_action: any, latestMeta: any) => {
            if (await automationPaused(deps)) return false;
            const currentAgent = (await agent.refresh())?.agent;
            if (!currentAgent || currentAgent.archivedAt || hasActiveAgentWork(currentAgent, latestMeta[AGENTS_KEY]?.[input.agentId])) return false;
            if (await assignmentIsQuiet(paseo, _action, input.workspaceId, deps)) return false;
            if (_action.accountMove && stoppedAfterQueued(latestMeta[AGENTS_KEY]?.[input.agentId], _action)) return false;
            if (!(await steerQuotaAdmission(currentAgent, latestMeta[AGENTS_KEY]?.[input.agentId],
              { ...deps, paseo }, latestMeta[AGENTS_KEY])).allowed) return false;
            return !_action.accountMove || await moveSourcesValid(paseo, _action, input);
          } });
        if (result.status !== "sent") {
          if (result.status === "blocked") await replacePending(paseo, input, lock, pending, (current) => {
            const action = readSteerAction(current);
            return action?.phase === "sent" || action?.phase === "done" ? {} :
              { action: { ...action, phase: "blocked", lastError: result.detail ?? "Delivery authority changed." } };
          });
          return { status: result.status === "pending" ? "pending" : "blocked", cleared,
            deliveryId: pending.wakeId, detail: result.status === "uncertain" ? `Delivery outcome is uncertain (${result.detail}).` : result.detail ?? "Delivery is pending." };
        }
        if (result.recordingError) return {
          status: "sent", cleared, deliveryId: pending.wakeId, detail: result.recordingError, recordingError: result.recordingError,
        };
        sent = result.action;
      }
      const batch = pending.batch;
      if (batch) {
        const at = sent.observedAt ?? deps.now?.() ?? new Date().toISOString();
        for (const event of batch.events) {
          await markWorker({
            client: paseo, workspaceId: batch.workspaceId, workerId: event.workerId, lock,
            patch: (worker, source) => {
              if (!worker || (batch.epoch !== null && batch.epoch !== scopeState(source)?.epoch)) return null;
              const queued = worker.pendingWake;
              const superseded = queued && (queued.state !== event.state ||
                (event.queuedAt !== undefined ? queued.queuedAt !== event.queuedAt : Date.parse(queued.queuedAt) > Date.parse(pending.queuedAt)));
              const latestWake = worker.lastWakeAt && worker.lastWakeAt > at ? worker.lastWakeAt : at;
              const marked = markSent(worker, { at: latestWake, clearPending: !batch.takeover && !superseded });
              if (marked.lastWakeAt === worker.lastWakeAt && marked.pendingWake === queued) return null;
              return { lastWakeAt: marked.lastWakeAt, pendingWake: marked.pendingWake };
            },
          });
        }
        if (batch.takeover) await deps.onTakeoverDelivered?.(paseo, { ...batch, takeover: { ...batch.takeover, observedAt: sent.observedAt } }, input.agentId);
      }
      for (const ref of assignmentRefs(pending)) {
        await markAssignmentReported(paseo, ref, lock, sent.observedAt ?? deps.now?.() ?? new Date().toISOString());
      }
      await retryOnLockBusy(() => replacePending(paseo, input, lock, pending, (current) => ({
        action: afterDelivery(sent, true),
        ...(pending.renewal === "rewind" ? { refreshed: { ...actionFact(current, "refreshed"), briefMessageId: pending.wakeId } } : {}),
        ...((pending.needsResumeAt === undefined ? entry?.needsResume?.at : pending.needsResumeAt) && current.needsResume?.at === (pending.needsResumeAt === undefined ? entry?.needsResume?.at : pending.needsResumeAt) ? { needsResume: null } : {}),
      })));
      return {
        status: "sent", cleared, renewed: pending.renewal !== "send",
        detail: cleared ? "Context cleared and resume brief sent." : pending.renewal === "send" ? "Message sent." : "Context rewound and resume brief sent.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof LockBusy && ["sent", "done"].includes(sent.phase)) {
        const detail = `Message sent. Factory completion record is still pending (${message}).`;
        return { status: "sent", cleared, deliveryId: pending.wakeId, detail, recordingError: detail };
      }
      return { status: "pending", cleared, detail: `Brief delivery is queued (${message}).` };
    }
  } catch (error) {
    if (!(error instanceof LockBusy)) throw error;
    return deferred(`Factory delivery bookkeeping waits for the workspace lock (${error.message}).`);
  } finally {
    finishing.delete(key);
  }
}

/** Single entry for Factory wake, takeover, switch and explicit resume sends. */
export async function deliverSteer(
  paseo: any, input: DeliveryInput, deps: SteerDeliveryDeps = {},
): Promise<DeliveryResult> {
  if (await automationPaused(deps)) return deferred(FACTORY_PAUSED);
  const lock = deps.lock ?? productionLock;
  const [state, fresh, snapshot] = await Promise.all([
    input.state ?? readPaseoState(paseo),
    paseo.workspaces.ref(input.workspaceId).refresh(),
    paseo.agents.ref(input.agentId).refresh(),
  ]);
  const meta = fresh?.metadata ?? {};
  const observed = snapshot?.agent;
  const agent = observed ? { ...observed, labels: resolveFactoryLabels(observed, state.agents) ?? observed.labels } : null;
  const identity = cleanupIdentity(agent?.labels);
  const scope = scopeState(meta);
  if (identity?.role !== "steer" || !scope || agent.archivedAt || agent.background === true) {
    return blocked("The target is no longer a live Factory steer.");
  }
  if (input.epoch !== undefined && input.epoch !== scope.epoch) return blocked("The scope moved before the steer could be reached.");
  const entry = meta[AGENTS_KEY]?.[input.agentId];
  const previous = readSteerAction(entry);
  if (input.actionId && previous?.wakeId === input.actionId && previous.phase === "done") {
    return { status: "sent", cleared: false, detail: "Message already delivered." };
  }
  if (previous && (previous.phase === "sent" || readEffectReceipt(meta, previous)) &&
      (previous.wakeId === input.actionId || input.manual)) {
    return (await finishSteerDelivery(paseo, input, deps)) ?? deferred();
  }
  const pendingMove = pendingSteerDelivery(entry);
  if (pendingMove?.accountMove && stoppedAfterQueued(entry, pendingMove)) return blocked("Delivery is paused after a canceled turn.");
  if (pendingMove?.accountMove && (unsettledAccountMove(pendingMove) ||
      (pendingMove.accountMove.resolution === "replan" && !admittedAccountMoveReplan(pendingMove)))) {
    return (await finishSteerDelivery(paseo, input, deps)) ?? deferred();
  }
  const observationState = { ...state,
    agents: [...state.agents.filter((a: any) => a.id !== input.agentId), agent],
    workspaces: state.workspaces.map((ws: any) => ws.id === input.workspaceId ? { ...ws, metadata: meta } : ws) };
  const routing = await readRoutingSnapshot({ ...deps, paseo }, observationState.workspaces, observationState.agents);
  const rawAdmission = quotaAdmission(agent, entry, routing, meta[AGENTS_KEY]);
  const routeAdmission = pendingMove?.kind === "activate"
    ? activationQuotaAdmission(rawAdmission, deps.confirmActivationQuota) : rawAdmission;
  const admission = pendingMove?.accountMove?.phase === "settled"
    ? await steerQuotaAdmission(agent, entry, { ...deps, paseo }, meta[AGENTS_KEY]) : routeAdmission;
  if (!admission.allowed) return deferred(`Delivery waits: ${admission.reason}.`);
  if (hasActiveAgentWork(agent, entry)) return deferred();
  if (input.batch?.takeover && await deps.assignmentQuiet?.(paseo, [input.batch.workspaceId], input.workspaceId)) return deferred("Takeover waits for boot or drain.");
  const existing = pendingSteerDelivery(entry);
  const activation = existing?.kind === "activate" && existing.wakeId === input.actionId;
  if (await assignmentIsQuiet(paseo, existing, input.workspaceId, deps)) return deferred("Assignment report waits for boot or drain.");
  if (existing && input.actionId && existing.wakeId === input.actionId && existing.phase !== "reserved") {
    return (await finishSteerDelivery(paseo, input, deps)) ?? deferred();
  }
  if (existing && existing.epoch === scope.epoch && existing.wakeId !== input.actionId) {
    if (existing.phase === "blocked") return blocked(existing.lastError ?? "Context renewal needs attention.");
    if (input.manual && existing.phase !== "renewing") {
      return (await finishSteerDelivery(paseo, input, deps)) ??
        { status: "pending", cleared: false, detail: "The steer brief is queued." };
    }
    return { status: "pending", cleared: existing.renewal === "clear", detail: "A steer brief is already queued." };
  }
  if (readCleanupAction(entry)) {
    return blocked("The steer is busy. Try again after the current operation.");
  }
  if (existing?.phase === "reserved" && assignmentRefs(existing).length &&
      !await bindAssignments(paseo, { workspaceId: input.workspaceId, agentId: input.agentId, epoch: scope.epoch, scopeId: identity.scopeId }, existing, lock)) {
    return deferred("Assignment records changed while preparing delivery.");
  }
  // Reuse the pill projection, with the freshly fetched agent and metadata.
  const projectionMeta = existing && existing.wakeId === input.actionId && existing.phase === "reserved"
    ? { ...meta, [AGENTS_KEY]: { ...meta[AGENTS_KEY], [input.agentId]: actionEntry(entry, null) } } : meta;
  const projectionState = {
    ...state,
    agents: [...state.agents.filter((a: any) => a.id !== input.agentId), agent],
    workspaces: state.workspaces.map((ws: any) => ws.id === input.workspaceId ? { ...ws, metadata: projectionMeta } : ws),
  };
  const targetScope = listScopes(projectionState).find((candidate: any) =>
    candidate.workspaceId === input.workspaceId && sameScopeId(candidate.id, identity.scopeId));
  if (!targetScope) return blocked("The target does not belong to this live Factory scope.");
  const projected = routingProjection(projectionState, routing)
    .find((row) => row.agentId === input.agentId && row.workspaceId === input.workspaceId);
  const at = deps.now?.() ?? new Date().toISOString();
  const needsResumeAt = existing?.wakeId === input.actionId && existing?.phase === "reserved" && existing.needsResumeAt !== undefined
    ? existing.needsResumeAt : entry?.needsResume?.at ?? null;
  const keepLiveContext = (activation && deps.confirmActivationQuota !== undefined) ||
    ((activation || input.manual) && await deps.isFactoryPaused?.());
  const route = planSteerRoutes(routing, [steerRouteCandidate({ agent, entry, entries: meta[AGENTS_KEY],
    row: projected, snapshot: keepLiveContext ? { ...routing, keepChatHistory: true } : routing,
    admission: routeAdmission,
    manual: input.manual && !keepLiveContext, retry: existing?.phase === "blocked" })], {
    intent: existing?.routing?.intent ?? input.intent ?? (input.manual ? { mode: "explicit", agentId: input.agentId } : { mode: "automatic" }),
    observation: { epoch: scope.epoch, holderId: input.agentId, accountId: admission.accountId },
  });
  if (!route.selected) {
    const reason = route.excluded.find((candidate: any) => candidate.requested)?.reason ?? route.reason;
    return route.intent.mode === "explicit"
      ? blocked(`The requested steer/model cannot receive this delivery: ${reason}.`)
      : deferred(`Delivery waits: ${reason}.`);
  }
  const mode: Renewal = route.selected.preparation;
  const routingDecision = { intent: route.intent, strategy: route.strategy, reason: route.reason,
    observation: route.observation, kind: route.selected.kind,
    preparation: mode, evidence: route.selected.evidence, confidence: route.selected.confidence };
  if (mode === "send") {
    const currentAgent = (await paseo.agents.ref(input.agentId).refresh())?.agent;
    if (!currentAgent) return blocked("The target is no longer a live Factory steer.");
    const currentAdmission = await steerQuotaAdmission(currentAgent, entry, { ...deps, paseo }, meta[AGENTS_KEY]);
    if (!currentAdmission.allowed) return deferred(`Delivery waits: ${currentAdmission.reason}.`);
    if (!routeMatchesIntent({ ...currentAgent, agentId: currentAgent.id }, route.intent)) {
      return blocked("The requested steer/model changed before preparing delivery.");
    }
    const brief = input.manual ? await deps.buildBrief?.(paseo, input.workspaceId, input.agentId) : null;
    const text = input.manual ? (brief && formatResumeMessage(brief)) :
      existing?.phase === "reserved" && existing.wakeId === input.actionId ? existing.packet ?? input.text : input.text;
    if (!activation && !text) return blocked("The steer delivery has no message.");
    if (!await staleBatchStillValid(paseo, input.batch)) return deferred("Worker events changed while preparing delivery.");
    let batch = input.batch;
    if (batch && !(existing?.phase === "reserved" && existing.accountMove)) {
      const source = (await paseo.workspaces.ref(batch.workspaceId).refresh())?.metadata ?? {};
      batch = { ...batch, events: batch.events.map((event) => ({ ...event, queuedAt: source[WORKERS_KEY]?.[event.workerId]?.pendingWake?.queuedAt ?? null })) };
    }
    const pending: any = newSteerAction({ id: input.actionId, epoch: scope.epoch,
      ...(activation ? { kind: "activate", note: existing.note } : { text }),
      at: existing?.phase === "reserved" ? existing.queuedAt : at, options: input.sendOptions, batch });
    pending.routing = routingDecision;
    pending.needsResumeAt = needsResumeAt;
    if (existing?.assignment) pending.assignment = existing.assignment;
    if (existing?.assignments) pending.assignments = existing.assignments;
    if (existing?.accountMove) pending.accountMove = existing.accountMove;
    if (existing?.accountMoveReplan) pending.accountMoveReplan = existing.accountMoveReplan;
    if (identity.slot === scope.activeSteer) pending.authority = { scopeId: identity.scopeId, agentId: input.agentId };
    const reserved = await changeEntry(paseo, input, lock, async (current, currentMeta, held) => {
      if (scopeState(currentMeta)?.epoch !== scope.epoch || readCleanupAction(current)) return null;
      if (pending.authority) {
        try {
          await guardScope({ client: paseo, held, workspaceId: input.workspaceId, scopeId: identity.scopeId,
            epoch: scope.epoch, agentId: input.agentId });
        } catch { return null; }
      }
      const live = (await paseo.agents.ref(input.agentId).refresh())?.agent;
      if (readSteerAction(current)?.accountMove && stoppedAfterQueued(current, readSteerAction(current))) return null;
      if (!live || hasActiveAgentWork(live, current) || !(await steerQuotaAdmission(live, current, { ...deps, paseo }, currentMeta[AGENTS_KEY])).allowed) return null;
      if (!routeMatchesIntent({ ...live, agentId: live.id }, route.intent)) return null;
      if (await assignmentIsQuiet(paseo, pending, input.workspaceId, deps) ||
          await assignmentIsQuiet(paseo, current.action, input.workspaceId, deps)) return null;
      const prior = readSteerAction(current);
      if (prior?.accountMove && !await moveSourcesValid(paseo, prior, input)) return null;
      const stagedBrief = input.batch && !input.batch.takeover && prior?.phase === "staged" ? prior : null;
      if (prior && prior.phase !== "done" && prior.wakeId !== input.actionId && !stagedBrief) return null;
      if (input.actionId && prior?.wakeId === input.actionId && prior.phase !== "reserved") return null;
      if (JSON.stringify(prior?.phase === "done" ? null : prior?.accountMove ?? null) !== JSON.stringify(existing?.accountMove ?? null)) return null;
      if (JSON.stringify(prior?.phase === "done" ? null : prior?.accountMoveReplan ?? null) !== JSON.stringify(existing?.accountMoveReplan ?? null)) return null;
      if (existing?.phase === "reserved" && (prior?.packet !== existing.packet ||
          JSON.stringify(assignmentRefs(prior)) !== JSON.stringify(assignmentRefs(existing)) ||
          !await assignmentBindingsValid(paseo, prior, { workspaceId: input.workspaceId, agentId: input.agentId, epoch: scope.epoch, scopeId: identity.scopeId }))) return null;
      return { ...(stagedBrief ? { stagedBrief } : {}), action: { ...pending, ...(prior?.phase === "done" ? { lastDeliveryId: prior.wakeId } : prior?.lastDeliveryId ? { lastDeliveryId: prior.lastDeliveryId } : {}) } };
    });
    if (!reserved) return deferred("A steer operation is already queued.");
    return (await finishSteerDelivery(paseo, input, deps,
      routing.keepChatHistory && !keepLiveContext && !input.manual && (projected?.warmth === "cold" || projected?.large === true))) ?? deferred();
  }
  const original = existing?.epoch === (scope.epoch ?? null) ? existing : null;
  const eventBatch = input.batch ?? original?.batch;
  const pending: PendingSteerDelivery = {
    wakeId: input.actionId ?? randomUUID(),
    ...(activation ? { kind: "activate" } : {}),
    routing: routingDecision,
    renewal: mode,
    phase: "renewing",
    queuedAt: existing?.phase === "reserved" ? existing.queuedAt : at,
    epoch: typeof scope.epoch === "number" ? scope.epoch : null,
    note: existing?.assignment ? (existing.phase === "reserved" ? existing.packet ?? "" : input.renewalNote ?? input.text ?? original?.note ?? "") :
      (input.renewalNote ?? input.text ?? original?.note ?? "").slice(0, 1500),
    ...(eventBatch ? { batch: eventBatch } : {}),
    needsResumeAt,
    ...(input.sendOptions ? { sendOptions: input.sendOptions } : {}),
    ...(identity.slot === scope.activeSteer ? { authority: { scopeId: identity.scopeId, agentId: input.agentId } } : {}),
    ...(readSteerAction(entry)?.phase === "done" ? { lastDeliveryId: readSteerAction(entry).wakeId } : {}),
    ...(existing?.assignment ? { assignment: existing.assignment } : {}),
    ...(existing?.assignments ? { assignments: existing.assignments } : {}),
    ...(existing?.accountMove ? { accountMove: existing.accountMove } : {}),
    ...(existing?.accountMoveReplan ? { accountMoveReplan: existing.accountMoveReplan } : {}),
  };
  const reserved = await changeEntry(paseo, input, lock, async (current, currentMeta, held) => {
    if (scopeState(currentMeta)?.epoch !== scope.epoch || readCleanupAction(current)) return null;
    if (pending.authority) {
      try {
        await guardScope({ client: paseo, held, workspaceId: input.workspaceId, scopeId: identity.scopeId,
          epoch: scope.epoch, agentId: input.agentId });
      } catch { return null; }
    }
    const live = (await paseo.agents.ref(input.agentId).refresh())?.agent;
    if (readSteerAction(current)?.accountMove && stoppedAfterQueued(current, readSteerAction(current))) return null;
    if (!live || hasActiveAgentWork(live, current) || !(await steerQuotaAdmission(live, current, { ...deps, paseo }, currentMeta[AGENTS_KEY])).allowed) return null;
    if (!routeMatchesIntent({ ...live, agentId: live.id }, route.intent)) return null;
    if (await assignmentIsQuiet(paseo, pending, input.workspaceId, deps) ||
        await assignmentIsQuiet(paseo, current.action, input.workspaceId, deps)) return null;
    const priorAction = readSteerAction(current);
    if (priorAction?.accountMove && !await moveSourcesValid(paseo, priorAction, input)) return null;
    const stagedBrief = input.batch && !input.batch.takeover && priorAction?.phase === "staged" ? priorAction : null;
    if (priorAction && priorAction.phase !== "done" && priorAction.wakeId !== input.actionId && !stagedBrief) return null;
    if (input.actionId && priorAction?.wakeId === input.actionId && priorAction.phase !== "reserved") return null;
    if (JSON.stringify(priorAction?.phase === "done" ? null : priorAction?.accountMove ?? null) !== JSON.stringify(existing?.accountMove ?? null)) return null;
    if (JSON.stringify(priorAction?.phase === "done" ? null : priorAction?.accountMoveReplan ?? null) !== JSON.stringify(existing?.accountMoveReplan ?? null)) return null;
    if (existing?.phase === "reserved" && (priorAction?.packet !== existing.packet ||
        JSON.stringify(assignmentRefs(priorAction)) !== JSON.stringify(assignmentRefs(existing)) ||
        !await assignmentBindingsValid(paseo, priorAction, { workspaceId: input.workspaceId, agentId: input.agentId, epoch: scope.epoch, scopeId: identity.scopeId }))) return null;
    return { ...(stagedBrief ? { stagedBrief } : {}), action: pending };
  });
  if (!reserved) return { status: "pending", cleared: false, detail: "A steer operation is already queued." };

  // Wakes may be sent directly by callers that have not queued the workers
  // yet. Persist those events in the register before starting renewal.
  const batch = pending.batch;
  try {
    if (batch && !batch.takeover && !pending.accountMove) {
      for (const event of batch.events) {
        await markWorker({
          client: paseo, workspaceId: batch.workspaceId, workerId: event.workerId, lock,
          patch: (worker, source) =>
            worker && !worker.pendingWake && (batch.epoch === null || batch.epoch === scopeState(source)?.epoch)
              ? { pendingWake: { state: event.state, queuedAt: at } } : null,
        });
      }
    }
    if (batch && !pending.accountMove) {
      const source = (await paseo.workspaces.ref(batch.workspaceId).refresh())?.metadata ?? {};
      pending.batch = { ...batch, events: batch.events.map((event) => ({ ...event, queuedAt: source[WORKERS_KEY]?.[event.workerId]?.pendingWake?.queuedAt ?? null })) };
      if (!await replacePending(paseo, input, lock, pending, { action: pending })) return deferred("Steer state changed while recording worker events.");
    }
    const stillIdle = async () => {
      if (!input.manual && await deps.keepChatHistory?.()) return false;
      if (!await staleBatchStillValid(paseo, batch)) return false;
      const current = (await paseo.workspaces.ref(input.workspaceId).refresh())?.metadata ?? {};
      const latest = (await paseo.agents.ref(input.agentId).refresh())?.agent;
      const agentEntry = current[AGENTS_KEY]?.[input.agentId];
      return latest && !latest.archivedAt && !hasActiveAgentWork(latest, agentEntry) &&
        !(readSteerAction(agentEntry)?.accountMove && stoppedAfterQueued(agentEntry, readSteerAction(agentEntry))) &&
        (!readSteerAction(agentEntry)?.accountMove || await moveSourcesValid(paseo, readSteerAction(agentEntry), input)) &&
        !await assignmentIsQuiet(paseo, readSteerAction(agentEntry), input.workspaceId, deps) &&
        (await steerQuotaAdmission(latest, agentEntry, { ...deps, paseo }, current[AGENTS_KEY])).allowed &&
        scopeState(current)?.epoch === scope.epoch && readSteerAction(agentEntry)?.wakeId === pending.wakeId &&
        !await automationPaused(deps);
    };
    if (!await stillIdle()) throw new AgentBusyError(STEER_BUSY);
    if (mode === "clear") {
      await (deps.runCleanupFn ?? runCleanup)(paseo, input.agentId, "clear", RESUME_PENDING_REASON, {
        workspaceId: input.workspaceId, lock, note: pending.note, beforeSend: stillIdle,
      });
      return { status: "pending", cleared: true, deliveryId: pending.wakeId, detail: "Clearing the context. The resume brief follows confirmation." };
    }
    // Persist the attempt under the same scope fence before the provider can
    // fork. A restart leaves renewal pending instead of repeating the RPC.
    await lock(workspaceLockName(input.workspaceId), async (held) => {
      if (pending.authority) await guardScope({ client: paseo, held, workspaceId: input.workspaceId, scopeId: pending.authority.scopeId, epoch: pending.epoch, agentId: pending.authority.agentId });
      const workspace = paseo.workspaces.ref(input.workspaceId);
      const meta = (await workspace.refresh())?.metadata ?? {};
      const entries = meta[AGENTS_KEY] ?? {};
      const current = readSteerAction(entries[input.agentId]);
      if (current?.wakeId !== pending.wakeId || current.rewindAttempt) throw new AgentBusyError(STEER_BUSY);
      held.verify();
      await workspace.setMetadata({ [AGENTS_KEY]: { ...entries, [input.agentId]: actionEntry(entries[input.agentId], { ...current, rewindAttempt: { at, phase: "uncertain" } }) } });
    });
    const outcome = await runRewind(input.agentId, "", {
      createClient: deps.rewindClient ?? defaultCreateRewindClient,
      previousBriefId: actionFact(entry, "refreshed")?.briefMessageId,
      skipBrief: true,
      beforeRewind: stillIdle,
    });
    if (outcome.status === "deferred") throw new AgentBusyError(STEER_BUSY);
    if (outcome.status !== "rewound") {
      const preDispatch = ["no-point", "no-op", "unsupported", "unavailable"].includes(outcome.status);
      if (preDispatch) {
        const why = outcome.status === "no-point" ? "no usable rewind point" :
          outcome.status === "unsupported" ? "the provider does not support rewind" :
          outcome.error ?? outcome.status;
        const detail = `Context rewind cannot run (${why}). Use Fresh to prepare a new tab or retry recovery.`;
        await replacePending(paseo, input, lock, pending, (current) => {
          const { rewindAttempt: _dropped, ...action } = readSteerAction(current) ?? {};
          return { action: { ...action, phase: "blocked", lastError: detail.slice(0, 300) } };
        });
        return blocked(detail);
      }
      const detail = `The rewind outcome for ${input.agentId} is uncertain (${outcome.error ?? outcome.status}). Inspect its tab before recovery.`;
      await replacePending(paseo, input, lock, pending, (current) => ({
        action: { ...readSteerAction(current), phase: "blocked", lastError: detail.slice(0, 300) },
      }));
      return blocked(detail);
    }
    try {
      const workspace = paseo.workspaces.ref(input.workspaceId);
      await workspace.setMetadata({ [effectReceiptKey(pending.wakeId)]: {
        kind: "rewind", messageId: outcome.messageId, at: deps.now?.() ?? new Date().toISOString(),
      } });
      await retryOnLockBusy(() => settleRewindReceipt({ client: paseo, ...input, actionId: pending.wakeId, lock }));
    } catch (error) {
      if (!(error instanceof LockBusy)) throw error;
      return deferred(`Context rewound. Factory confirmation is still pending (${error.message}).`);
    }
    const delivery = await finishSteerDelivery(paseo, input, deps);
    if (delivery && delivery.status !== "pending") return delivery;
    return {
      status: "pending", cleared: false, deliveryId: pending.wakeId,
      detail: delivery?.detail ?? "Context rewound. The resume brief is queued.",
    };
  } catch (error) {
    if (error instanceof AgentBusyError) {
      await replacePending(paseo, input, lock, pending, { action: original });
      return deferred();
    }
    const message = error instanceof Error ? error.message : String(error);
    const detail = mode === "clear" ? `The clear outcome for ${input.agentId} is uncertain (${message}). Inspect its tab before recovery.` : message;
    await replacePending(paseo, input, lock, pending, (current) => ({
      action: { ...readSteerAction(current), phase: "blocked", lastError: detail.slice(0, 300) },
    }));
    return blocked(detail);
  }
}
