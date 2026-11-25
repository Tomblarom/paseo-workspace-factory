import { LEGACY_PREFIX, METADATA_KEY, readPaseoState } from "./factory/paseo.js";
import { listScopes } from "./factory/scope.js";
import { createGit } from "./factory/local.js";
import { withLock, withWorkspaceLock, workspaceLockName } from "./factory/lock.js";
import {
  agentUsage,
  lastAssistantText,
  parseCheckpointBlock,
  readGitSnapshot,
} from "./factory/steer.js";
import { buildSettingsBaseline, updateAgentEntry } from "./factory/agent-state.js";
import { speedOfLiveOptions } from "../shared/steer-settings.js";
import { captureSweepPaseo, noteEffectFailure } from "./cold-sweep.js";
import {
  RESUME_PENDING_REASON,
  SEED_AFTER_CLEAR,
  formatResumeMessage,
  needsResumeForFailedTurn,
  scanCleanupEvidence,
} from "../shared/idle-cleanup.js";
import { firstUserText } from "../shared/supervise.js";
import { decideAssignmentReport } from "../shared/assignment-report.js";
import { ASSIGNMENT_KEY } from "./factory/assign.js";
import { extractTurnUsage, mergeTurnUsage } from "./quota.js";
import {
  proactiveHintDecision,
  restorePendingWakeBrief,
  retryOnLockBusy,
  runFailoverCheck,
  takePendingWakeBrief,
  type PendingWakeBrief,
} from "./supervise.js";
import { markWakeSent, readWorkers, updateWorkerEntry } from "./factory/supervision.js";
import {
  findZerosubSwitch,
  resolveZerosub,
  zerosubForkWarning,
  type ZerosubSource,
} from "./zerosub-runtime.js";
import {
  checkRace,
  cleanupCommandKind,
  decideTurnUpdate,
  dropEntries,
  factoryIdentity,
  type CleanupEffect,
} from "../shared/auto-checkpoint.js";

const CHECKPOINT_KEY = `${METADATA_KEY}.checkpoint`;
const AGENTS_KEY = `${METADATA_KEY}.agents`;
const LEGACY_CHECKPOINT_KEY = `${LEGACY_PREFIX}.checkpoint`;

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
  /** Reads the C5 settings for the seed-after-clear step; absent means no seed. */
  getCleanupSettings?: () => Promise<{ seedAfterClear: boolean } | null>;
  /** Builds the resume brief after a verified resume clear; absent means none. */
  getResumeBrief?: (paseo: any, workspaceId: string, agentId: string) => Promise<string>;
  /** Clock for open-turn tracking; defaults to the current time. */
  now?: () => string;
  getConfig?: () => Promise<any>;
  getSupervisionSettings?: () => Promise<any>;
  /** Lock for metadata writes; tests only (defaults to the real one, always with LockBusy retry). */
  lock?: (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>;
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
  const identity = factoryIdentity(agent.labels ?? null);
  if (!identity) return;
  const paseoState: any = await readPaseoState(paseo);
  const scope: any = listScopes(paseoState).find((s: any) => s.id === identity.scopeId) ?? null;
  if (!scope) return;
  const mainId: string = scope.workspaceId;
  const meta = scope.workspace?.metadata ?? {};
  const wsf = asRecord(meta[METADATA_KEY]);
  if (!wsf) return;
  const now = deps.now ? deps.now() : new Date().toISOString();
  const update = updateAgentEntry as unknown as (args: any) => Promise<any>;
  await update({
    client: paseo,
    workspaceId: mainId,
    agentId,
    patch: { openTurnId: payload.turnId ?? null, turnStartedAt: now },
    liveIds: null,
    lock: lockOf(deps),
  });
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

/**
 * Proactive ZeroSub switch hint for one completed steer turn: at or above the
 * account window's warnPct (with room elsewhere) the steer gets the handoff
 * text, debounced to once per account window (re-hint after its reset, an
 * account change, or 24h). Returns the text plus the agent-entry patch, or
 * null. Never throws (fail-soft: no hint without ZeroSub, config, or room).
 */
async function proactiveHintForTurn(args: {
  paseoState: any;
  scope: any;
  wsf: Record<string, unknown> | null;
  agents: Record<string, unknown>;
  agentId: string;
  entries: unknown[];
  previous: Record<string, unknown> | null;
  deps: TurnHookDeps;
  nowMs: number;
}): Promise<{ text: string; patch: Record<string, unknown> } | null> {
  try {
    const zerosub = await resolveZerosub(args.deps);
    if (!zerosub || !Array.isArray((zerosub as { accounts?: unknown }).accounts)) return null;
    const config = args.deps.getConfig ? await args.deps.getConfig().catch(() => null) : null;
    const supervision = args.deps.getSupervisionSettings
      ? await args.deps.getSupervisionSettings().catch(() => null)
      : null;
    const hint = proactiveHintDecision({
      paseoState: args.paseoState,
      scope: args.scope,
      wsf: args.wsf as Record<string, any> | null,
      agentState: args.agents,
      config,
      agentId: args.agentId,
      zerosub,
      nowMs: args.nowMs,
      warnPct: config?.quota?.warnPct ?? supervision?.quota?.warnPct ?? 75,
      exhaustedPct: config?.quota?.exhaustedPct ?? supervision?.quota?.exhaustedPct ?? 95,
    });
    if (hint.decision !== "hint" || !hint.text) return null;
    const last = asRecord(args.previous?.proactiveHint);
    const lastAccount = typeof last?.accountId === "string" ? last.accountId : null;
    const lastAt = typeof last?.at === "string" ? Date.parse(last.at) : NaN;
    const lastReset = typeof last?.resetsAt === "string" ? Date.parse(last.resetsAt) : NaN;
    const windowReset = Number.isFinite(lastReset) && args.nowMs >= lastReset;
    if (lastAccount === hint.accountId && Number.isFinite(lastAt) && args.nowMs - lastAt < 24 * 3_600_000 && !windowReset) {
      return null;
    }
    let text = hint.text;
    const forkNote = zerosubForkWarning(findZerosubSwitch(args.entries));
    if (forkNote) text = `${text}\n${forkNote}`;
    return {
      text,
      patch: {
        proactiveHint: {
          accountId: hint.accountId ?? null,
          at: new Date(args.nowMs).toISOString(),
          resetsAt: hint.resetsAt ?? null,
        },
      },
    };
  } catch (error) {
    console.error(
      `[factory] turn hook: proactive hint check failed (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

/**
 * Sends the done/blocked CHECKPOINT of an assigned active steer to the agent
 * that asked (wsf.assignment.by), once: reportedAt is stamped under the
 * workspace lock before sending, so two turn hooks never both report.
 * Never throws.
 */
async function reportAssignment(args: {
  paseo: any;
  mainId: string;
  scopeId: string;
  agentId: string;
  identity: { role: string; slot: string | null };
  kind: string;
  block: any;
  lastAnswer: string | null;
  deps?: TurnHookDeps;
}): Promise<void> {
  const { paseo, mainId, agentId } = args;
  try {
    let decision: ReturnType<typeof decideAssignmentReport> | null = null;
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
      held.verify();
      await paseo.workspaces.ref(mainId).setMetadata({
        [ASSIGNMENT_KEY]: { ...assignment, reportedAt: new Date().toISOString(), reportStatus: decision.status },
      });
    }, args.deps ?? {});
    const sent = decision as ReturnType<typeof decideAssignmentReport> | null;
    if (!sent?.report || !sent.to || !sent.text) return;
    await paseo.agents.ref(sent.to).send(sent.text);
    console.log(`[factory] turn hook: reported ${sent.status} of ${agentId} to ${sent.to}`);
  } catch (error) {
    console.error(
      `[factory] turn hook: assignment report for ${agentId} failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
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
  const agent: any = snap?.agent ?? null;
  if (!agent) {
    console.log(`[factory] turn hook: agent ${agentId} gone; skip`);
    return;
  }
  // Labels decide factory membership (hook payload carries none); usage feeds contextTokens.
  const identity = factoryIdentity(agent.labels ?? null);
  if (!identity) return;
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

  let entries: unknown[] = [];
  try {
    const page: any = await paseo.agents.ref(agentId).timeline.refetch({
      direction: "tail",
      limit: 1,
      wholeTurns: true,
    });
    const all = Array.isArray(page?.entries) ? page.entries : [];
    entries = payload.turnId ? all.filter((e: any) => e.turnId === undefined || e.turnId === payload.turnId) : all;
  } catch {
    entries = [];
  }
  const lastAnswer = lastAssistantText({ entries });
  const block = kind === "completed" && lastAnswer ? parseCheckpointBlock(lastAnswer) : null;
  const usage: any = agentUsage(agent);
  const turnUsage = extractTurnUsage(payload, agent);
  const git = kind === "completed" ? null : readGitSnapshot(createGit(), scope.directory ?? null);
  const turnUserText = firstUserText(entries);

  // Effect evidence for our own cleanup turns: the session-id comparison is
  // authoritative for /clear, the timeline scan for /compact.
  let effect: CleanupEffect | null = null;
  const pending = asRecord(previous?.pendingAction);
  if (pending && cleanupCommandKind(turnUserText)) {
    const sessionBefore = pending.sessionId;
    const sessionNow = agent?.persistence?.sessionId;
    const scan = scanCleanupEvidence(entries);
    effect = {
      sessionChanged:
        typeof sessionBefore === "string" && typeof sessionNow === "string"
          ? sessionBefore !== sessionNow
          : null,
      compactionSeen: scan.compactionSeen,
      markerSeen: scan.markerSeen,
      sessionNoteSeen: scan.sessionNoteSeen,
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
    previous,
    effect,
    now: new Date().toISOString(),
  });

  // E4 needsResume bookkeeping for ordinary turns (resume-cleanup turns are
  // handled after the write, once the brief is sent): a failed steer turn
  // flags, a completed turn clears. Cleanup turns of our own never flag.
  const isCleanupTurn = Boolean(pending && cleanupCommandKind(turnUserText));
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

  // Proactive ZeroSub switch hint for completed steer turns (computed before
  // the write so its debounce stamp merges into the same agent entry; the
  // text goes out after the write below).
  const nowMs = Date.now();
  const proactiveHint =
    identity.role === "steer" && kind === "completed" && !decision.dropSelf
      ? await proactiveHintForTurn({ paseoState, scope, wsf, agents, agentId, entries, previous, deps, nowMs })
      : null;

  // One core lock helper names and takes workspace locks (never duplicated here).
  await withWorkspaceLockRetry(mainId, async (held: any) => {
    // refresh() is raw: legacy fallback for pre-migration records.
    const freshSnap: any = await paseo.workspaces.ref(mainId).refresh().catch(() => null);
    const freshMeta = freshSnap?.metadata ?? {};
    const freshWsf = asRecord(freshMeta[METADATA_KEY]) ?? asRecord(freshMeta[LEGACY_PREFIX]);
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
      const race = checkRace(
        { activeSteer: wsf.activeSteer, epoch: wsf.epoch },
        freshWsf ? { activeSteer: freshWsf.activeSteer, epoch: freshWsf.epoch } : null,
      );
      if (race) {
        console.log(`[factory] turn hook: skip scope write for ${agentId}: ${race}`);
        checkpointWrite = null;
        patchInterrupted = null;
      }
    }
    // Merge onto the fresh entry so concurrent fields (e.g. a pendingAction
    // C5 set after our read) survive; resolving clears it explicitly.
    const prev: Record<string, any> = asRecord(freshAgents[agentId]) ?? {};
    const merged: Record<string, any> = {
      ...prev,
      ...(decision.entryUpdate ?? {}),
      ...(needsResumePatch ?? {}),
      ...(proactiveHint?.patch ?? {}),
      ...(turnUsage ? { usage: mergeTurnUsage(prev.usage, turnUsage) } : {}),
      ...(settingsBaseline ? { settingsBaseline } : {}),
    };
    if (decision.resolvePending) merged.pendingAction = null;
    const patch: Record<string, unknown> = { [AGENTS_KEY]: { ...freshAgents, [agentId]: merged } };
    const freshCheckpoint =
      asRecord(freshMeta[CHECKPOINT_KEY]) ?? asRecord(freshMeta[LEGACY_CHECKPOINT_KEY]);
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
    console.log(`[factory] turn hook: ${decision.log}`);
  }, deps);

  await reportAssignment({ paseo, mainId, scopeId: scope.id, agentId, identity, kind, block, lastAnswer, deps });

  if (proactiveHint) {
    try {
      await paseo.agents.ref(agentId).send(proactiveHint.text);
      console.log(`[factory] turn hook: proactive switch hint to ${agentId}`);
    } catch (error) {
      console.error(
        `[factory] turn hook: proactive hint to ${agentId} failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

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
        failingPool: typeof agent.provider === "string" ? agent.provider : null,
      });
    } catch (error) {
      console.error(
        `[factory] turn hook: limit failover failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  // A resume clear replaces the seed with the full brief: after a verified
  // (or unverifiable but completed) clear the brief goes into the fresh
  // timeline; after effectFailed it arrives with the not-cleared notice. The
  // flag clears only once the brief is sent, so a failed send keeps the pill.
  const pendingReason = asRecord(previous?.pendingAction)?.reason;
  const cleared = asRecord(decision.entryUpdate?.cleared);
  const resumeDone =
    pendingReason === RESUME_PENDING_REASON &&
    kind === "completed" &&
    !decision.dropSelf &&
    (cleared !== null || decision.effectFailed === true);
  if (decision.effectFailed) {
    noteEffectFailure(
      `a cleanup command to ${agentId} arrived as text without effect (see wsf.agents.${agentId}.lastActionFailed)`,
    );
    if (!resumeDone) return;
  }
  if (resumeDone) {
    if (!deps.getResumeBrief) {
      console.error(`[factory] turn hook: resume brief for ${agentId} not sent (no brief builder wired)`);
      return;
    }
    const lock = lockOf(deps);
    const update = updateAgentEntry as unknown as (args: any) => Promise<any>;
    const updateWorker = updateWorkerEntry as unknown as (args: any) => Promise<any>;
    let taken: PendingWakeBrief | null = null;
    try {
      taken = await takePendingWakeBrief(paseo, mainId, agentId, lock);
    } catch (error) {
      console.error(
        `[factory] turn hook: wake brief take for ${agentId} failed (${error instanceof Error ? error.message : String(error)}); needsResume kept`,
      );
      return;
    }
    const hadPending = !!(previous as Record<string, unknown> | null)?.pendingWakeBrief;
    if (!taken && hadPending) {
      console.log(`[factory] turn hook: wake brief for ${agentId} already taken elsewhere; skip`);
      return;
    }
    const nowIso = new Date().toISOString();
    if (taken?.briefSent === true) {
      try {
        await update({ client: paseo, workspaceId: mainId, agentId, patch: { needsResume: null }, liveIds: null, lock });
        const freshMeta = ((await paseo.workspaces.ref(mainId).refresh().catch(() => null))?.metadata ?? {}) as Record<string, unknown>;
        const freshWsf = asRecord(freshMeta[METADATA_KEY]) ?? asRecord(freshMeta[LEGACY_PREFIX]);
        const moved =
          typeof freshWsf?.epoch === "number" && typeof taken.epoch === "number" && freshWsf.epoch !== taken.epoch;
        if (!moved) {
          const register = (readWorkers as unknown as (m: unknown) => Record<string, any>)(freshMeta);
          for (const event of taken.events) {
            const current = register[event.workerId];
            if (!current || typeof current !== "object") continue;
            const marked = (markWakeSent as unknown as (e: any, o: any) => any)(current, { at: nowIso });
            await updateWorker({
              client: paseo,
              workspaceId: mainId,
              workerId: event.workerId,
              patch: { lastWakeAt: marked.lastWakeAt, pendingWake: marked.pendingWake },
              lock,
            });
          }
        }
        console.log(`[factory] turn hook: wake brief ${taken.wakeId} marking retried for ${agentId}`);
      } catch (error) {
        const back = { ...taken, lastAttemptAt: nowIso, lastError: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
        try {
          await restorePendingWakeBrief(paseo, mainId, agentId, back as never, lock);
        } catch {}
        console.error(
          `[factory] turn hook: wake brief ${taken.wakeId} marking failed (${error instanceof Error ? error.message : String(error)}); retry next tick`,
        );
      }
      return;
    }
    const pendingNote = taken?.note ?? null;
    const actionNote = asRecord(previous?.pendingAction)?.note;
    const note = typeof pendingNote === "string" && pendingNote ? pendingNote : typeof actionNote === "string" ? actionNote : null;
    try {
      const brief = await deps.getResumeBrief(paseo, mainId, agentId);
      const full = note ? `${brief}\n\n${note}` : brief;
      await paseo.agents.ref(agentId).send(
        formatResumeMessage(full, { cleared: decision.effectFailed !== true }),
      );
    } catch (error) {
      if (taken) {
        const back = {
          ...taken,
          attempts: taken.attempts + 1,
          lastAttemptAt: nowIso,
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        };
        try {
          await restorePendingWakeBrief(paseo, mainId, agentId, back as never, lock);
        } catch {}
      }
      console.error(
        `[factory] turn hook: resume brief to ${agentId} failed (${error instanceof Error ? error.message : String(error)}); needsResume kept`,
      );
      return;
    }
    try {
      await update({ client: paseo, workspaceId: mainId, agentId, patch: { needsResume: null }, liveIds: null, lock });
      if (taken) {
        const freshMeta = ((await paseo.workspaces.ref(mainId).refresh().catch(() => null))?.metadata ?? {}) as Record<string, unknown>;
        const freshWsf = asRecord(freshMeta[METADATA_KEY]) ?? asRecord(freshMeta[LEGACY_PREFIX]);
        const moved =
          typeof freshWsf?.epoch === "number" && typeof taken.epoch === "number" && freshWsf.epoch !== taken.epoch;
        if (moved) {
          console.log(`[factory] turn hook: wake brief ${taken.wakeId} sent to ${agentId} but the epoch moved; workers stay queued`);
        } else {
          const register = (readWorkers as unknown as (m: unknown) => Record<string, any>)(freshMeta);
          for (const event of taken.events) {
            const current = register[event.workerId];
            if (!current || typeof current !== "object") continue;
            const marked = (markWakeSent as unknown as (e: any, o: any) => any)(current, { at: nowIso });
            await updateWorker({
              client: paseo,
              workspaceId: mainId,
              workerId: event.workerId,
              patch: { lastWakeAt: marked.lastWakeAt, pendingWake: marked.pendingWake },
              lock,
            });
          }
          console.log(`[factory] turn hook: sent resume brief to ${agentId} (wake ${taken.wakeId} delivered)`);
        }
      } else {
        console.log(`[factory] turn hook: sent resume brief to ${agentId}`);
      }
    } catch (error) {
      if (taken) {
        const back = {
          ...taken,
          briefSent: true as const,
          lastAttemptAt: nowIso,
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        };
        try {
          await restorePendingWakeBrief(paseo, mainId, agentId, back as never, lock);
        } catch {}
      }
      console.error(
        `[factory] turn hook: resume brief to ${agentId} sent but the marking failed (${error instanceof Error ? error.message : String(error)}); retry marking next tick`,
      );
    }
    return;
  }
  // Optional one-line seed after a verified clear: it costs one small turn and
  // tells the resumed agent to load the resume brief first.
  if (cleared?.mode === "clear" && deps.getCleanupSettings) {
    try {
      const settings = await deps.getCleanupSettings();
      if (settings?.seedAfterClear) {
        await paseo.agents.ref(agentId).send(SEED_AFTER_CLEAR);
        console.log(`[factory] turn hook: seeded ${agentId} after clear`);
      }
    } catch (error) {
      console.error(
        `[factory] turn hook: seed after clear to ${agentId} failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
}
