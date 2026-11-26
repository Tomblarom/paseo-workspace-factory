import { createHash, randomUUID } from "node:crypto";
import { dispatchAssignmentReport, finishSteerDelivery, pendingSteerDelivery, type SteerDeliveryDeps } from "./steer-delivery.js";
import { METADATA_KEY, createPaseoCli, parentOf, readPaseoAgents, readPaseoState } from "./core/paseo.mjs";
import { listScopes } from "./core/scope.mjs";
import { guardScope } from "./core/scope-guard.mjs";
import { continuedFromId, resolveFactoryLabels } from "./core/zerosub.mjs";
import { readCleanupAction, readSteerAction } from "./core/steer-action.mjs";
import { ACTION_FACTS, actionFact, mergeActionFacts } from "./core/action-facts.mjs";
import { pushPreviousSession } from "../shared/idle-cleanup.js";
import { createGit } from "./core/local.mjs";
import { withLock, withWorkspaceLock, workspaceLockName } from "./core/lock.mjs";
import {
  agentUsage,
  lastAssistantText,
  parseCheckpointBlock,
  readGitSnapshot,
} from "./core/steer.mjs";
import { buildSettingsBaseline, updateAgentEntry } from "./core/agent-state.mjs";
import { speedOfLiveOptions } from "../shared/steer-settings.js";
import { captureSweepPaseo, noteEffectFailure } from "./cold-sweep.js";
import {
  RESUME_PENDING_REASON,
  needsResumeForFailedTurn,
  scanCleanupEvidence,
} from "../shared/idle-cleanup.js";
import { firstUserText, workerIdentityFromMetadata } from "../shared/supervise.js";
import { decideAssignmentReport } from "../shared/assignment-report.js";
import { ASSIGNMENT_KEY } from "./core/assign.mjs";
import { extractTurnUsage, mergeTurnUsage } from "./quota.js";
import {
  retryOnLockBusy,
  runFailoverCheck,
} from "./supervise.js";
import { type ZerosubSource } from "./zerosub-runtime.js";
import {
  cleanupCommandKind,
  decideTurnUpdate,
  dropEntries,
  factoryIdentity,
  type CleanupEffect,
} from "../shared/auto-checkpoint.js";

const CHECKPOINT_KEY = `${METADATA_KEY}.checkpoint`;
const AGENTS_KEY = `${METADATA_KEY}.agents`;

interface TurnPayload {
  agent: { id: string };
  turnId: string | null;
  outcome: { kind: string; error?: unknown; reason?: string };
}

interface TurnHookContext {
  paseo: any;
  signal?: unknown;
}

interface TurnBeforePayload {
  agent: { id: string };
  turnId: string | null;
}

export interface TurnHookDeps extends ZerosubSource {
  delivery?: SteerDeliveryDeps;
  /** Builds the resume brief after a verified resume clear; absent means none. */
  getResumeBrief?: (paseo: any, workspaceId: string, agentId: string) => Promise<string>;
  /** Clock for open-turn tracking; defaults to the current time. */
  now?: () => string;
  getConfig?: () => Promise<any>;
  getSupervisionSettings?: () => Promise<any>;
  /** Lock for metadata writes; tests only (defaults to the real one, always with LockBusy retry). */
  lock?: (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>;
  setContinuationLabels?: (agentId: string, labels: Record<string, string>) => Promise<void>;
}

/**
 * P1 open-turn tracking: records turn start so a daemon restart that kills
 * the turn without turn.after can be detected at boot. Never throws.
 */
export async function handleTurnBefore(
  payload: TurnBeforePayload,
  context: TurnHookContext,
  deps: TurnHookDeps = {},
): Promise<void> {
  captureSweepPaseo(context?.paseo);
  try {
    await runTurnBefore(payload, context.paseo, deps);
  } catch (error) {
    console.error(
      `[factory] turn-before hook failed for agent ${payload?.agent?.id ?? "?"}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * C2 auto-checkpoint: records every factory turn and captures CHECKPOINT
 * blocks without model calls. Never throws out of the hook (log and continue).
 */
export async function handleTurnAfter(
  payload: TurnPayload,
  context: TurnHookContext,
  deps: TurnHookDeps = {},
): Promise<void> {
  captureSweepPaseo(context?.paseo);
  try {
    await runTurnHook(payload, context.paseo, deps);
  } catch (error) {
    console.error(
      `[factory] turn hook failed for agent ${payload?.agent?.id ?? "?"}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function runTurnBefore(payload: TurnBeforePayload, paseo: any, deps: TurnHookDeps): Promise<void> {
  const agentId = payload?.agent?.id;
  if (!agentId) return;
  const snap: any = await paseo.agents.ref(agentId).refresh().catch(() => null);
  const agent: any = snap?.agent ?? null;
  if (!agent || agent.archivedAt) return;
  let identity = factoryIdentity(agent.labels ?? null);
  if (!identity && continuedFromId(agent)) {
    identity = factoryIdentity(resolveFactoryLabels(agent, await readPaseoAgents(paseo)));
  }
  identity ??= workerIdentityFromMetadata(agent);
  if (!identity) return;
  const paseoState: any = await readPaseoState(paseo);
  const scope: any = listScopes(paseoState).find((s: any) => s.id === identity.scopeId) ?? null;
  if (!scope) return;
  const mainId: string = scope.workspaceId;
  const meta = scope.workspace?.metadata ?? {};
  const wsf = asRecord(meta[METADATA_KEY]);
  if (!wsf) return;
  if (identity.role === "worker" && asRecord(asRecord(meta[AGENTS_KEY])?.[agentId])?.replacedBy) return;
  const now = deps.now ? deps.now() : new Date().toISOString();
  const update = updateAgentEntry as unknown as (args: any) => Promise<any>;
  await update({ client: paseo, workspaceId: mainId, agentId,
    patch: { openTurnId: payload.turnId ?? null, turnStartedAt: now }, liveIds: null, lock: lockOf(deps) });
}

function failureText(outcome: TurnPayload["outcome"]): string | null {
  if (outcome.kind === "failed") {
    const error = (outcome.error ?? {}) as { message?: unknown; code?: unknown };
    const message = typeof error.message === "string" ? error.message : "turn failed";
    return typeof error.code === "string" && error.code ? `${error.code}: ${message}` : message;
  }
  if (outcome.kind === "canceled") {
    return typeof outcome.reason === "string" && outcome.reason ? outcome.reason : "turn canceled";
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function lockOf(deps: TurnHookDeps): (
  name: string,
  fn: (held: { verify: () => void }) => Promise<any>,
) => Promise<any> {
  const lock = deps.lock ?? (withLock as unknown as (
    name: string,
    fn: (held: { verify: () => void }) => Promise<any>,
  ) => Promise<any>);
  return async (name, fn) => retryOnLockBusy(() => lock(name, fn));
}

async function withWorkspaceLockRetry(
  mainId: string,
  fn: (held: { verify: () => void }) => Promise<any>,
  deps: TurnHookDeps,
): Promise<any> {
  const lock = lockOf(deps);
  const name = (workspaceLockName as unknown as (id: string) => string)(mainId);
  return lock(name, fn);
}

export async function adoptContinuation(paseo: any, agent: any, deps: TurnHookDeps = {}): Promise<any | null> {
  if (!continuedFromId(agent) || !agent.workspaceId || agent.archivedAt || parentOf(agent)) return null;
  return withWorkspaceLockRetry(agent.workspaceId, async (held) => {
    const current = (await paseo.agents.ref(agent.id).refresh())?.agent;
    if (!current || current.archivedAt || parentOf(current) || current.workspaceId !== agent.workspaceId) return null;
    if (factoryIdentity(current.labels)) return current;
    const agents: any[] = await readPaseoAgents(paseo);
    const labels = resolveFactoryLabels(current, agents) as Record<string, string> | null;
    if (!labels) return null;
    const added = Object.fromEntries(Object.entries(labels).filter(([key]) => key.startsWith("wsf.") && current.labels?.[key] === undefined));
    if (!factoryIdentity(labels) || !Object.keys(added).length) return null;
    held.verify();
    if (deps.setContinuationLabels) {
      await deps.setContinuationLabels(current.id, added);
    } else {
      const cli = createPaseoCli();
      cli(["agent", "update", current.id, "--label", Object.entries(added).map(([key, value]) => `${key}=${value}`).join(",")]);
    }
    const updated = (await paseo.agents.ref(current.id).refresh())?.agent;
    if (!updated || updated.archivedAt || parentOf(updated) || updated.workspaceId !== current.workspaceId ||
        Object.entries(added).some(([key, value]) => updated.labels?.[key] !== value)) {
      throw new Error(`Continuation ${current.id} labels not verifiable after adoption`);
    }
    return updated;
  }, deps);
}

/**
 * Queue a deterministic K7 action before dispatch; recovery needs no sender turn.
 */
export async function reportAssignment(args: {
  paseo: any;
  mainId: string;
  scopeId: string;
  agentId: string;
  identity: { role: string; slot: string | null };
  kind: string;
  block: any;
  lastAnswer: string | null;
  epoch: unknown;
  config: any;
  deps?: TurnHookDeps;
}): Promise<void> {
  const { paseo, mainId, agentId } = args;
  try {
    let decision: ReturnType<typeof decideAssignmentReport> | null = null;
    let queued = false;
    await withWorkspaceLockRetry(mainId, async (held: any) => {
      const snap: any = await paseo.workspaces.ref(mainId).refresh().catch(() => null);
      const meta = snap?.metadata ?? {};
      const wsf = asRecord(meta[METADATA_KEY]);
      const assignment = asRecord(meta[ASSIGNMENT_KEY]);
      decision = decideAssignmentReport({
        assignment,
        agentId,
        slot: args.identity.slot,
        role: args.identity.role,
        activeSteer: wsf?.activeSteer,
        epoch: wsf?.epoch,
        outcome: args.kind,
        scopeId: args.scopeId,
        block: args.block,
        lastAnswer: args.lastAnswer,
      });
      if (!decision.report || !assignment) return;
      if (args.config === false) return;
      await (guardScope as any)({ client: paseo, held, workspaceId: mainId, scopeId: args.scopeId, epoch: args.epoch, agentId, config: args.config });
      if (typeof assignment.at !== "string" || !assignment.at || !Number.isInteger(assignment.epoch)) {
        throw new Error("Assignment needs its original timestamp and epoch to queue a report");
      }
      const actionId = `wsf-assignment-${createHash("sha256").update(JSON.stringify([args.scopeId.toLowerCase(), assignment.epoch, assignment.at])).digest("hex")}`;
      if (assignment.reportActionId && assignment.reportActionId !== actionId) throw new Error("Assignment report action does not match its assignment");
      if (assignment.reportActionId) { queued = true; return; }
      held.verify();
      await paseo.workspaces.ref(mainId).setMetadata({
        [ASSIGNMENT_KEY]: { ...assignment, reportActionId: actionId, reportStatus: decision.status, reportText: decision.text },
      });
      queued = true;
    }, args.deps ?? {});
    if (queued) {
      const result = await dispatchAssignmentReport(paseo, mainId, { ...args.deps?.delivery, lock: lockOf(args.deps ?? {}) });
      if (result?.status === "blocked") console.error(`[factory] assignment report for ${agentId} blocked (${result.detail})`);
    }
  } catch (error) {
    console.error(
      `[factory] turn hook: assignment report for ${agentId} failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** Recover a completed continuation's report when its turn ended before reload. */
export async function reportContinuationAssignment(paseo: any, agent: any, scope: any, config: any, deps: TurnHookDeps = {}): Promise<void> {
  const identity = factoryIdentity(resolveFactoryLabels(agent, await readPaseoAgents(paseo)));
  if (!identity || identity.role !== "steer" || agent?.status === "running" || agent?.activeTurn) return;
  const meta = scope.workspace?.metadata ?? {};
  const assignment = meta[ASSIGNMENT_KEY];
  if (!assignment || assignment.reportedAt || identity.slot !== meta[METADATA_KEY]?.activeSteer) return;
  const entries = (await paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true }))?.entries ?? [];
  const lastAnswer = lastAssistantText({ entries });
  const block = lastAnswer ? parseCheckpointBlock(lastAnswer) : null;
  if (block?.status !== "done" && block?.status !== "blocked") return;
  await reportAssignment({ paseo, mainId: scope.workspaceId, scopeId: scope.id, agentId: agent.id, identity,
    kind: "completed", block, lastAnswer, epoch: scope.workspace?.metadata?.[METADATA_KEY]?.epoch, config, deps });
}

async function runTurnHook(payload: TurnPayload, paseo: any, deps: TurnHookDeps): Promise<void> {
  const agentId = payload?.agent?.id;
  if (!agentId) return;
  const kind = payload?.outcome?.kind;
  if (kind !== "completed" && kind !== "failed" && kind !== "canceled") {
    console.log(`[factory] turn hook: unknown outcome ${JSON.stringify(kind)} for ${agentId}; skip`);
    return;
  }
  const snap: any = await paseo.agents.ref(agentId).refresh().catch(() => null);
  let agent: any = snap?.agent ?? null;
  if (!agent) {
    console.log(`[factory] turn hook: agent ${agentId} gone; skip`);
    return;
  }
  const labels = factoryIdentity(agent.labels ?? null) ? agent.labels :
    continuedFromId(agent) ? resolveFactoryLabels(agent, await readPaseoAgents(paseo)) : null;
  const identity = factoryIdentity(labels) ?? workerIdentityFromMetadata(agent);
  if (!identity) return;
  if (!factoryIdentity(agent.labels ?? null) && continuedFromId(agent)) {
    try {
      agent = await adoptContinuation(paseo, agent, deps) ?? { ...agent, labels };
    } catch (error) {
      console.error(`[factory] continuation ${agentId} normalization failed (${error instanceof Error ? error.message : String(error)})`);
      agent = { ...agent, labels };
    }
  }
  const paseoState: any = await readPaseoState(paseo);
  const scope: any = listScopes(paseoState).find((s: any) => s.id === identity.scopeId) ?? null;
  if (!scope) {
    console.log(`[factory] turn hook: scope ${JSON.stringify(identity.scopeId)} of ${agentId} not live; skip`);
    return;
  }
  const mainId: string = scope.workspaceId;
  const meta = scope.workspace?.metadata ?? {};
  const wsf = asRecord(meta[METADATA_KEY]);
  if (!wsf) {
    console.log(`[factory] turn hook: workspace ${mainId} has no scope state; skip`);
    return;
  }
  const agents = asRecord(meta[AGENTS_KEY]) ?? {};
  const checkpoint = asRecord(meta[CHECKPOINT_KEY]);
  const previous = asRecord(agents[agentId]);
  const config = deps.getConfig ? await deps.getConfig().catch(() => false) : null;
  if (identity.role === "worker" && previous?.replacedBy) return;

  let entries: any[] = [];
  let exactTurn: any[] = [];
  try {
    const page: any = await paseo.agents.ref(agentId).timeline.refetch({
      direction: "tail",
      limit: 1,
      wholeTurns: true,
    });
    const all = Array.isArray(page?.entries) ? page.entries : [];
    entries = payload.turnId ? all.filter((e: any) => e.turnId === undefined || e.turnId === payload.turnId) : all;
    exactTurn = payload.turnId ? all.filter((e: any) => e.turnId === payload.turnId) : [];
  } catch {
    entries = [];
  }
  const lastAnswer = lastAssistantText({ entries });
  const block = kind === "completed" && lastAnswer ? parseCheckpointBlock(lastAnswer) : null;
  const usage: any = agentUsage(agent);
  const turnUsage = extractTurnUsage(payload, agent);
  const git = kind === "completed" ? null : readGitSnapshot(createGit(), scope.directory ?? null);
  const pending = asRecord(readCleanupAction(previous));
  const sessionBefore = pending?.sessionId;
  const sessionNow = agent?.persistence?.sessionId;
  const sessionChanged = typeof sessionBefore === "string" && sessionBefore && typeof sessionNow === "string" && sessionNow
    ? sessionBefore !== sessionNow : null;
  let turnUserText = firstUserText(entries);
  if (pending?.kind === "clear") {
    const messageId = pending.messageId;
    const prompt = exactTurn.find(({ item }) => item?.type === "user_message")?.item ??
      (messageId && entries.find(({ item }) => item?.type === "user_message" &&
        (item.clientMessageId === messageId || item.messageId === messageId))?.item);
    const commandMatches = cleanupCommandKind(prompt?.text) === "clear" &&
      (!messageId || prompt.clientMessageId === messageId || prompt.messageId === messageId);
    // Claude may replace the timeline, removing the command row. Require the
    // provider's exact transition notice as well as an independently changed
    // session, so arbitrary assistant text never supplies the effect evidence.
    const replacedTimeline = sessionChanged === true && !prompt && (!payload.turnId || pending.previousTurnId !== payload.turnId) &&
      entries.some(({ item }) => item?.text === `Claude switched to a new session: ${sessionBefore} -> ${sessionNow}`);
    turnUserText = commandMatches || replacedTimeline ? "/clear" : null;
  } else if (pending?.kind === "compact" && pending.messageId) {
    const prompt = exactTurn.find(({ item }) => item?.type === "user_message" &&
      (item.clientMessageId === pending.messageId || item.messageId === pending.messageId))?.item;
    turnUserText = cleanupCommandKind(prompt?.text) === "compact" ? prompt.text : null;
  }

  // Effect evidence for our own cleanup turns: the session-id comparison is
  // authoritative for /clear, the timeline scan for /compact.
  let effect: CleanupEffect | null = null;
  const isCleanupTurn = Boolean(pending && pending.kind === cleanupCommandKind(turnUserText));
  if (isCleanupTurn) {
    const scan = scanCleanupEvidence(pending?.kind === "compact" ? exactTurn : entries);
    effect = {
      sessionChanged,
      compactionSeen: scan.compactionSeen,
      markerSeen: scan.markerSeen,
      turnReadable: scan.turnReadable,
    };
  }

  const decision = decideTurnUpdate({
    agentId,
    slot: identity.slot,
    role: identity.role,
    activeSteer: wsf.activeSteer,
    archived: Boolean(agent.archivedAt),
    turnId: payload.turnId,
    outcome: kind,
    error: failureText(payload.outcome),
    block,
    lastAnswer,
    turnUserText,
    git,
    contextTokens: usage?.usedTokens ?? null,
    epoch: wsf.epoch,
    checkpoint,
    previous: previous ? { ...previous, ...Object.fromEntries(ACTION_FACTS.map((key: string) => [key, actionFact(previous, key)])), ...(pending ? { pendingAction: pending } : {}) } : previous,
    effect,
    now: new Date().toISOString(),
  });

  // E4 needsResume bookkeeping for ordinary turns (resume-cleanup turns are
  // handled after the write, once the brief is sent): a failed steer turn
  // flags, a completed turn clears. Cleanup turns of our own never flag.
  let needsResumePatch: Record<string, unknown> | null = null;
  if (!isCleanupTurn && kind === "completed" && previous?.needsResume) {
    needsResumePatch = { needsResume: null };
  } else if (!isCleanupTurn && kind === "failed") {
    const flagged = needsResumeForFailedTurn({
      role: identity.role,
      outcome: kind,
      error: failureText(payload.outcome),
      at: new Date().toISOString(),
    });
    if (flagged) needsResumePatch = { needsResume: flagged };
  }

  // Step-4 settings baseline: the live provider/model/thinking/speed tuple
  // plus the session id at turn end. Without a session id nothing comparable
  // is stored and the previous baseline (if any) is kept.
  const liveProvider = typeof agent.provider === "string" ? agent.provider : null;
  const liveModel = typeof agent.model === "string" ? agent.model : null;
  const liveThinking = typeof agent.effectiveThinkingOptionId === "string"
    ? agent.effectiveThinkingOptionId
    : (typeof agent.thinkingOptionId === "string" ? agent.thinkingOptionId : null);
  const liveSpeed = speedOfLiveOptions(liveProvider, liveModel, agent.options ?? null);
  const liveSessionId = typeof agent?.persistence?.sessionId === "string" ? agent.persistence.sessionId : null;
  const settingsBaseline = (buildSettingsBaseline as unknown as (args: any) => any)({
    provider: liveProvider,
    model: liveModel,
    thinking: liveThinking,
    speed: liveSpeed,
    sessionId: liveSessionId,
    turnId: payload.turnId ?? null,
    at: new Date().toISOString(),
  });

  let readyDelivery = false;
  let applied = false;
  // One core lock helper names and takes workspace locks (never duplicated here).
  await withWorkspaceLockRetry(mainId, async (held: any) => {
    const freshSnap: any = await paseo.workspaces.ref(mainId).refresh().catch(() => null);
    const freshMeta = freshSnap?.metadata ?? {};
    const freshWsf = asRecord(freshMeta[METADATA_KEY]);
    const freshAgents = asRecord(freshMeta[AGENTS_KEY]) ?? {};
    if (decision.dropSelf) {
      held.verify();
      await paseo.workspaces.ref(mainId).setMetadata({ [AGENTS_KEY]: dropEntries(freshAgents, [agentId]) });
      console.log(`[factory] turn hook: ${decision.log}`);
      return;
    }
    let checkpointWrite = decision.checkpoint ?? null;
    let patchInterrupted = decision.patchInterrupted ?? null;
    if (checkpointWrite || patchInterrupted) {
      try {
        if (config === false) throw new Error("scope configuration unavailable");
        await (guardScope as any)({ client: paseo, held, workspaceId: mainId, scopeId: identity.scopeId, epoch: wsf.epoch, agentId, config });
      } catch (error) {
        console.log(`[factory] turn hook: skip scope write for ${agentId}: ${String(error)}`);
        checkpointWrite = null;
        patchInterrupted = null;
      }
    }
    // Merge onto the fresh entry so concurrent fields (e.g. a cleanup intent
    // C5 set after our read) survive; resolving clears it explicitly.
    const prev: Record<string, any> = asRecord(freshAgents[agentId]) ?? {};
    const currentCleanup = readCleanupAction(prev);
    if (decision.resolvePending && (currentCleanup?.at !== pending?.at ||
      currentCleanup?.messageId !== pending?.messageId || currentCleanup?.kind !== pending?.kind)) return;
    const newerTurnOpen = prev.openTurnId && prev.openTurnId !== payload.turnId;
    const merged: Record<string, any> = {
      ...prev,
      ...(decision.entryUpdate ?? {}),
      ...(needsResumePatch ?? {}),
      ...(turnUsage ? { usage: mergeTurnUsage(prev.usage, turnUsage) } : {}),
      ...(settingsBaseline ? { settingsBaseline } : {}),
      ...(newerTurnOpen ? { openTurnId: prev.openTurnId, turnStartedAt: prev.turnStartedAt } : {}),
    };
    if (decision.resolvePending) {
      const action = readSteerAction(prev);
      if (action) merged.action = decision.cleanupUncertain
        ? { ...action, phase: "blocked", cleanup: { ...currentCleanup, uncertain: true } }
        : action.kind === "cleanup" ? { ...action, phase: "done", cleanup: null } : { ...action, cleanup: null };
    }
    if (decision.resolvePending && pending?.kind === "clear" && decision.entryUpdate?.actionVerified === true) {
      merged.cleared = { ...asRecord(merged.cleared), sessionId: sessionNow };
      merged.previousSessions = pushPreviousSession(Array.isArray(prev.previousSessions) ? prev.previousSessions : null, typeof sessionBefore === "string" ? sessionBefore : null);
    }
    if (decision.resolvePending && pending?.reason === RESUME_PENDING_REASON &&
        currentCleanup?.at === pending.at && currentCleanup?.reason === pending.reason) {
      // A pre-existing manual clear carries its brief note in the cleanup
      // record. Adopt it into the same delivery queue.
      const queued = pendingSteerDelivery(prev) ?? {
        wakeId: randomUUID(),
        renewal: "clear",
        queuedAt: pending.at,
        epoch: wsf.epoch,
        note: typeof pending.note === "string" ? pending.note : "",
      };
      if (queued.renewal === "clear") {
        readyDelivery = decision.entryUpdate?.actionVerified === true;
        if (!readyDelivery) {
          merged.cleared = actionFact(prev, "cleared") ?? null;
          merged.actionVerified = null;
        }
        merged.action = readyDelivery
          ? { ...queued, cleanup: null, phase: "ready" }
          : { ...queued, cleanup: decision.cleanupUncertain ? { ...currentCleanup, uncertain: true } : null, phase: "blocked", lastError: "Claude context clear could not be confirmed. Inspect the agent before recovery." };
      }
    }
    const normalized = mergeActionFacts(prev, merged);
    const patch: Record<string, unknown> = { [AGENTS_KEY]: { ...freshAgents, [agentId]: normalized } };
    const freshCheckpoint = asRecord(freshMeta[CHECKPOINT_KEY]);
    if (checkpointWrite) {
      patch[CHECKPOINT_KEY] = checkpointWrite;
    } else if (patchInterrupted) {
      if (freshCheckpoint && typeof freshCheckpoint.task === "string" && freshCheckpoint.task.trim() !== "") {
        patch[CHECKPOINT_KEY] = { ...freshCheckpoint, interrupted: patchInterrupted };
      } else {
        console.log(`[factory] turn hook: scope checkpoint lost its task; flag skipped for ${agentId}`);
      }
    }
    held.verify();
    await paseo.workspaces.ref(mainId).setMetadata(patch);
    applied = true;
    console.log(`[factory] turn hook: ${decision.log} (${agentId})`);
  }, deps);

  if (!applied) return;

  await reportAssignment({ paseo, mainId, scopeId: scope.id, agentId, identity, kind, block, lastAnswer,
    epoch: wsf.epoch, config, deps });

  if (needsResumePatch?.needsResume && (needsResumePatch.needsResume as any).reason === "limit") {
    try {
      const settings = (await deps.getSupervisionSettings?.()) ?? {
        enabled: true,
        answerMinutes: 0,
        batchMinutes: 10,
        watchdogMinutes: 15,
        staleMinutes: 60,
        maxAutoResumes: 2,
      };
      await runFailoverCheck(paseo, scope, {
        settings,
        force: true,
        getConfig: deps.getConfig,
        delivery: deps.delivery,
        failingPool: typeof agent.provider === "string" ? agent.provider : null,
      });
    } catch (error) {
      console.error(
        `[factory] turn hook: limit failover failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  if (decision.effectFailed) {
    noteEffectFailure(
      `a cleanup command to ${agentId} completed without effect (see wsf.agents.${agentId}.lastActionFailed)`,
    );
  }
  if (pending?.reason === RESUME_PENDING_REASON && decision.resolvePending) {
    if (readyDelivery) {
      await finishSteerDelivery(paseo, { workspaceId: mainId, agentId }, {
        ...deps.delivery, lock: lockOf(deps), buildBrief: deps.getResumeBrief ?? deps.delivery?.buildBrief,
      });
    }
    return;
  }
  // After a verified sweep clear the agent reloads its task via the resume
  // brief (instruction rule) or the optional Claude SessionStart hook; no
  // extra model turn is sent.
}
