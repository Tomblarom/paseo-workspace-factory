// Manual /factory resume validates the preview and captures a checkpoint before delivery.
import { AGENTS_KEY } from "./core/agent-state.mjs";
import { readCleanupAction, readSteerAction } from "./core/steer-action.mjs";
import { actionFact } from "./core/action-facts.mjs";
import { withLock, workspaceLockName } from "./core/lock.mjs";
import { METADATA_KEY, readPaseoState } from "./core/paseo.mjs";
import { listScopes, sameScopeId } from "./core/scope.mjs";
import { guardScope, scopeHolder } from "./core/scope-guard.mjs";
import { lastAssistantText, parseCheckpointBlock, reconcileFreshDelivery, requireFreshPrivacy, SwitchRefused } from "./core/steer.mjs";
import { WORKERS_KEY } from "./core/supervision.mjs";
import { CLEANUP_DEFAULTS, cleanupIdentity, formatResumeMessage, type ResumeClearSettings } from "../shared/idle-cleanup.js";
import { decideSteerDelivery, deliverSteer, finishSteerDelivery, type DeliveryResult, type SteerDeliveryDeps } from "./steer-delivery.js";
import { resumeFingerprint } from "../shared/preview.js";
import { readPrivacyAdmission } from "./steer-admission.js";
import { agentContextInputs, hasActiveAgentWork } from "./agent-context.js";
import { projectAgentContext } from "../shared/steer-state.js";
import { resolveZerosub } from "./zerosub-runtime.js";
import { workerIdentityFromMetadata } from "../shared/supervise.js";

const CHECKPOINT_KEY = `${METADATA_KEY}.checkpoint`;

const asLastAnswer = lastAssistantText as unknown as (payload: unknown) => string | null;
const asParseBlock = parseCheckpointBlock as unknown as (text: string | null) => {
  task: string;
  tests: string[];
  blockers: string[];
  next: string | null;
} | null;

export interface ResumeApplyInput {
  workspaceId: string;
  agentId: string;
  fingerprint?: string;
}

export interface ResumeApplyDeps extends SteerDeliveryDeps {
  getConfig?: () => Promise<unknown>;
  note?: string;
  beforeDelivery?: () => Promise<void>;
  refreshWorker?: (workspaceId: string, agentId: string) => Promise<{
    to: string; delivered: boolean; deliveryError?: string | null; refreshMode: string;
  }>;
}

function checkFreshPrivacy(paseo: any, workspaceId: string, scopeId: string, deps: ResumeApplyDeps) {
  return (agentId: string, epoch: unknown) => requireFreshPrivacy({ client: paseo, workspaceId, scopeId, epoch, agentId,
    admitTarget: (agent: any) => readPrivacyAdmission(agent, { ...deps, paseo }, workspaceId),
  });
}

async function resumeFreshDelivery(paseo: any, workspaceId: string, scopeId: string, agentId: string, entry: unknown, deps: ResumeApplyDeps, lock: NonNullable<ResumeApplyDeps["lock"]>): Promise<ResumeApplyResult | null> {
  const action = readSteerAction(entry);
  if (action?.kind !== "fresh-delivery" || action.phase === "done") return null;
  const result = await reconcileFreshDelivery({ client: paseo, workspaceId, agentId, actionId: action.wakeId,
    lock, checkPrivacy: checkFreshPrivacy(paseo, workspaceId, scopeId, deps),
  });
  return {
    agentId, cleared: false, renewed: true,
    status: result.status === "sent" ? "sent" : result.status === "blocked" || result.status === "missing" ? "blocked" : "pending",
    detail: result.status === "sent" ? result.recordingError ?? "Fresh brief delivered." : result.detail ?? "Fresh brief needs receipt reconciliation.",
  };
}

async function applyWorkerResume(paseo: any, mainId: string, agentId: string, scopeId: string, deps: ResumeApplyDeps, lock: NonNullable<ResumeApplyDeps["lock"]>): Promise<ResumeApplyResult> {
  return lock(`worker-resume-${agentId}`, async () => {
    const ref = paseo.agents.ref(agentId);
    const [workspace, snapshot, cleanup, routes] = await Promise.all([
      paseo.workspaces.ref(mainId).refresh(), ref.refresh(), deps.getCleanupSettings?.(), resolveZerosub(deps),
    ]);
    const agent = snapshot?.agent;
    const meta = workspace?.metadata ?? {};
    const scope = asRecord(meta[METADATA_KEY]);
    if (!scope || scope.retired === true) throw new Error("The worker scope is no longer active.");
    const identity = cleanupIdentity(agent?.labels) ?? workerIdentityFromMetadata(agent);
    const entry = asRecord(meta[AGENTS_KEY]?.[agentId]);
    const worker = meta[WORKERS_KEY]?.[agentId];
    if (typeof entry?.replacedBy === "string") {
      return { agentId: entry.replacedBy, status: "blocked", cleared: false, detail: `Continue in replacement worker ${entry.replacedBy}.` };
    }
    const partial = worker?.state === "partial";
    if (identity?.role !== "worker" || !sameScopeId(identity.scopeId, scopeId) || agent.archivedAt || agent.background === true || (!entry?.interrupted && worker?.state !== "interrupted" && !partial)) {
      throw new Error("/factory resume is available for steers and workers with interrupted or partial work.");
    }
    if (readCleanupAction(entry) || hasActiveAgentWork(agent, entry)) {
      return { agentId, status: "blocked", cleared: false, detail: "The worker is busy. Try again after the current operation." };
    }
    const pendingFresh = await resumeFreshDelivery(paseo, mainId, scopeId, agentId, entry, deps, lock);
    if (pendingFresh) return pendingFresh;
    const context = agentContextInputs(agent, entry, cleanup ?? CLEANUP_DEFAULTS, routes, deps.now ? Date.parse(deps.now()) : Date.now());
    const { warmth, large } = projectAgentContext(context);
    const replacementMessageId = !context.lastTurnEndedAt && typeof entry?.workerResumeMessageId === "string" ? entry.workerResumeMessageId : null;
    const alreadyRenewed = context.cleanedAfter || replacementMessageId !== null;
    const receipt = readSteerAction(entry);
    if (replacementMessageId && receipt?.kind === "fresh-delivery" && receipt.phase === "done" && receipt.wakeId === replacementMessageId) {
      return { agentId, status: "sent", cleared: false, renewed: true, detail: "The renewed worker already received its brief." };
    }
    if (!partial && alreadyRenewed && asRecord(actionFact(entry, "refreshed"))?.briefMessageId) {
      return { agentId, status: "sent", cleared: false, renewed: true, detail: "The renewed worker already received its brief." };
    }
    const mode = decideSteerDelivery({ warmth: warmth.warmth, large, recovery: true, settings: null, keepChatHistory: false });
    if (!alreadyRenewed && mode !== "send") {
      if (!deps.refreshWorker) throw new Error("Worker context renewal is unavailable. Use fresh --worker for this worker.");
      const refreshed = await deps.refreshWorker(mainId, agentId);
      return {
        agentId: refreshed.to,
        status: refreshed.delivered ? "sent" : "blocked",
        cleared: false,
        renewed: true,
        detail: refreshed.delivered
          ? refreshed.refreshMode === "rewind" ? "Worker context rewound and resume brief sent." : `Resume brief sent to replacement worker ${refreshed.to}.`
          : `Resume brief needs delivery in worker ${refreshed.to}${refreshed.deliveryError ? ` (${refreshed.deliveryError})` : ""}. Run /factory resume in that tab to retry.`,
      };
    }
    const brief = await deps.buildBrief?.(paseo, mainId, agentId);
    if (!brief) throw new Error("No worker resume brief is available.");
    const at = partial ? entry?.lastTurnId ?? context.lastTurnEndedAt ?? entry?.noteAt ?? worker?.pendingWake?.queuedAt
      : asRecord(entry?.interrupted)?.at ?? worker?.pendingWake?.queuedAt ?? context.lastTurnEndedAt;
    if (partial) {
      const [latest, live] = await Promise.all([paseo.workspaces.ref(mainId).refresh(), ref.refresh()]);
      const metadata = latest?.metadata;
      const latestWorker = metadata?.[WORKERS_KEY]?.[agentId];
      const latestEntry = metadata?.[AGENTS_KEY]?.[agentId];
      const liveIdentity = cleanupIdentity(live?.agent?.labels) ?? workerIdentityFromMetadata(live?.agent);
      if (!at || metadata?.[METADATA_KEY]?.epoch !== scope.epoch || metadata?.[METADATA_KEY]?.retired ||
          latestWorker?.state !== "partial" || latestWorker.task !== worker.task ||
          latestWorker.startedBy !== worker.startedBy || latestWorker.epoch !== worker.epoch ||
          latestEntry?.lastTurnId !== entry?.lastTurnId || latestEntry?.lastTurnEndedAt !== entry?.lastTurnEndedAt ||
          latestEntry?.noteAt !== entry?.noteAt || latestEntry?.replacedBy || readCleanupAction(latestEntry) ||
          liveIdentity?.role !== "worker" || !sameScopeId(liveIdentity.scopeId, scopeId) ||
          live.agent.archivedAt || live.agent.background || hasActiveAgentWork(live.agent, latestEntry)) {
        return { agentId, status: "blocked", cleared: false, detail: "The partial worker checkpoint is unavailable or changed during resume." };
      }
    }
    const messageId = replacementMessageId ?? (typeof at === "string" ? `wsf-worker-resume-${agentId}-${at}` : null);
    try {
      await checkFreshPrivacy(paseo, mainId, scopeId, deps)(agentId, scope.epoch);
    } catch (error) {
      if (error instanceof SwitchRefused) return { agentId, status: "blocked", cleared: false, detail: error.message };
      throw error;
    }
    if (messageId) await ref.send(formatResumeMessage(brief), { messageId });
    else await ref.send(formatResumeMessage(brief));
    return { agentId, status: "sent", cleared: false, detail: "Worker resume brief sent." };
  });
}

export interface ResumeApplyResult extends DeliveryResult {
  agentId: string;
}

/** Reads the resume settings document; null fails open to the defaults. */
export async function readResumeSettings(handle: {
  read: () => Promise<{ status: string; values?: unknown }>;
}): Promise<ResumeClearSettings | null> {
  try {
    const state = await handle.read();
    if (state.status !== "ready") return null;
    return state.values as ResumeClearSettings;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function checkpointStamp(checkpoint: Record<string, unknown> | null): string | null {
  const stamped = checkpoint?.capturedAt ?? checkpoint?.updatedAt;
  return typeof stamped === "string" && stamped ? stamped : null;
}

/**
 * True when the CHECKPOINT block from the last answer should replace the scope
 * checkpoint: it is valid, and the scope checkpoint is missing, unstamped, of
 * unknown recency, or older than the last turn end.
 */
export function shouldSaveResumeCheckpoint(args: {
  block: { task: string } | null;
  checkpoint: Record<string, unknown> | null;
  lastTurnEndedAt: unknown;
}): boolean {
  if (!args.block || typeof args.block.task !== "string" || args.block.task.trim() === "") {
    return false;
  }
  const task = args.checkpoint?.task;
  if (typeof task !== "string" || task.trim() === "") return true;
  const stamped = checkpointStamp(args.checkpoint);
  if (!stamped) return true;
  const stampMs = Date.parse(stamped);
  if (!Number.isFinite(stampMs)) return true;
  const lastEnd =
    typeof args.lastTurnEndedAt === "string" ? Date.parse(args.lastTurnEndedAt) : NaN;
  if (!Number.isFinite(lastEnd)) return true;
  return lastEnd >= stampMs;
}

async function saveResumeCheckpoint(
  paseo: any,
  mainId: string,
  agentId: string,
  epoch: unknown,
  slot: string | null,
  scopeId: string,
  config: unknown,
  block: { task: string; tests: string[]; blockers: string[]; next: string | null },
  lock: (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>,
): Promise<boolean> {
  return lock(workspaceLockName(mainId), async (held: { verify: () => void }) => {
    const { state: freshWsf } = await (guardScope as any)({ client: paseo, held, workspaceId: mainId, scopeId, epoch, agentId, config });
    if (freshWsf.activeSteer !== slot) return false;
    const at = new Date().toISOString();
    held.verify();
    await paseo.workspaces.ref(mainId).setMetadata({
      [CHECKPOINT_KEY]: {
        task: block.task.trim(),
        tests: block.tests,
        blockers: block.blockers,
        next: block.next,
        epoch: freshWsf.epoch ?? null,
        updatedAt: at,
        source: "resume",
        agentId,
        turnId: null,
        capturedAt: at,
        interrupted: null,
      },
    });
    return true;
  });
}

export async function applyResume(
  paseo: any,
  input: ResumeApplyInput,
  deps: ResumeApplyDeps = {},
): Promise<ResumeApplyResult> {
  const lock = deps.lock ?? (withLock as unknown as ResumeApplyDeps["lock"] as NonNullable<ResumeApplyDeps["lock"]>);
  const agentId = input.agentId.trim();
  const state: any = await readPaseoState(paseo);
  const agent: any = (state.agents ?? []).find((a: any) => a?.id === agentId) ?? null;
  if (!agent) throw new Error(`Unknown agent ${JSON.stringify(agentId)}`);
  const identity = cleanupIdentity(agent.labels ?? null) ?? workerIdentityFromMetadata(agent);
  if (!identity) {
    throw new Error(
      `/factory resume is available for steers and workers with interrupted or partial work; ${agentId} is outside that scope.`,
    );
  }
  if (agent.status === "running" || agent.status === "initializing") {
    throw new Error(
      `${identity.role === "steer" ? "Steer" : "Worker"} ${agentId} is running; try again after the turn ends (or stop it first, then resume).`,
    );
  }
  const scope: any = listScopes(state).find((s: any) => sameScopeId(s.id, identity.scopeId)) ?? null;
  if (!scope) throw new Error(`Agent ${agentId} has no live factory scope`);
  const mainId: string = scope.workspaceId;
  if (input.workspaceId !== mainId) throw new Error("The requested workspace does not match the agent's factory scope.");
  const meta = scope.workspace?.metadata ?? {};
  const wsf = asRecord(meta[METADATA_KEY]);
  if (!wsf) throw new Error(`Workspace ${mainId} has no scope state`);
  const config = deps.getConfig ? await deps.getConfig() : null;
  const entries = asRecord(meta[AGENTS_KEY]) ?? {};
  const entry = asRecord(entries[agentId]);
  const checkpoint =
    asRecord(meta[CHECKPOINT_KEY]);
  if (typeof input.fingerprint === "string" && input.fingerprint) {
    const sessionId =
      typeof agent?.persistence?.sessionId === "string" ? agent.persistence.sessionId : null;
    const current = resumeFingerprint({
      agentId,
      status: typeof agent.status === "string" ? agent.status : null,
      sessionId,
      checkpointAt: checkpointStamp(checkpoint),
    });
    if (current !== input.fingerprint) {
      throw new Error(
        "Something changed since the resume preview (steer state or checkpoint). Run /factory resume again and confirm the new preview.",
      );
    }
  }
  const activeHolder = (scopeHolder as any)({ agents: state.agents, workspaceId: mainId, scopeId: identity.scopeId, slot: wsf.activeSteer });
  await lock(workspaceLockName(mainId), async (held: { verify: () => void }) => {
    await (guardScope as any)({ client: paseo, held, workspaceId: mainId, scopeId: identity.scopeId, epoch: wsf.epoch, agentId: activeHolder.id, config });
  });
  if (identity.role === "worker") return applyWorkerResume(paseo, mainId, agentId, identity.scopeId, deps, lock);
  const pendingFresh = await resumeFreshDelivery(paseo, mainId, identity.scopeId, agentId, entry, deps, lock);
  if (pendingFresh) return pendingFresh;
  if (readSteerAction(entry)?.phase === "sent") {
    const settled = await finishSteerDelivery(paseo, { workspaceId: mainId, agentId }, deps);
    if (settled) return { agentId, ...settled };
  }
  const liveAgent = (await paseo.agents.ref(agentId).refresh())?.agent;
  if (!liveAgent || liveAgent.archivedAt) return { agentId, status: "blocked", cleared: false, detail: "The steer is unavailable." };
  const privacy = await readPrivacyAdmission(liveAgent, { ...deps, paseo }, mainId);
  if (!privacy.allowed) return { agentId, status: "blocked", cleared: false, detail: `Resume refused: ${privacy.reason}.` };
  const cleanup = readCleanupAction(entry);
  if (cleanup) {
    const record = asRecord(cleanup);
    if (record?.uncertain === true) {
      return {
        agentId,
        status: "blocked",
        cleared: false,
        detail: `The ${record.kind ?? "cleanup"} outcome for this steer is uncertain (${record.error ?? "unknown error"}). Inspect its tab before recovery.`,
      };
    }
    return {
      agentId,
      status: "pending",
      cleared: record?.kind === "clear",
      detail: "Resume is already running for this steer; the brief arrives in the timeline after the clear.",
    };
  }
  let block: { task: string; tests: string[]; blockers: string[]; next: string | null } | null =
    null;
  try {
    const page: any = await paseo.agents.ref(agentId).timeline.refetch({
      direction: "tail",
      limit: 20,
    });
    block = asParseBlock(asLastAnswer(page));
  } catch {
    block = null;
  }
  let checkpointSaved = false;
  if (block && identity.slot === wsf.activeSteer && shouldSaveResumeCheckpoint({ block, checkpoint, lastTurnEndedAt: entry?.lastTurnEndedAt })) {
    if (activeHolder.id === agentId) checkpointSaved = await saveResumeCheckpoint(paseo, mainId, agentId, wsf.epoch, identity.slot, identity.scopeId, config, block, lock);
  }
  await deps.beforeDelivery?.();
  const applied = await deliverSteer(paseo, {
    workspaceId: mainId,
    agentId,
    text: deps.note,
    manual: true,
    state,
  }, deps);
  return {
    ...applied,
    agentId,
    detail: checkpointSaved ? `Checkpoint saved. ${applied.detail}` : applied.detail,
  };
}
