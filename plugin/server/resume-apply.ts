// Manual /factory resume validates the preview and captures a checkpoint before delivery.
import { AGENTS_KEY } from "./factory/agent-state.js";
import { readCleanupAction } from "./factory/steer-action.js";
import { actionFact } from "./factory/action-facts.js";
import { withLock, workspaceLockName } from "./factory/lock.js";
import { LEGACY_PREFIX, METADATA_KEY, readPaseoState } from "./factory/paseo.js";
import { listScopes, sameScopeId } from "./factory/scope.js";
import { guardScope, scopeHolder } from "./factory/scope-guard.js";
import { lastAssistantText, parseCheckpointBlock } from "./factory/steer.js";
import { WORKERS_KEY } from "./factory/supervision.js";
import { CLEANUP_DEFAULTS, cleanupIdentity, formatResumeMessage, type ResumeClearSettings } from "../shared/idle-cleanup.js";
import { decideSteerDelivery, deliverSteer, type DeliveryResult, type SteerDeliveryDeps } from "./steer-delivery.js";
import { resumeFingerprint } from "../shared/preview.js";
import { agentContextInputs } from "./agent-context.js";
import { projectAgentContext } from "../shared/steer-state.js";
import { resolveZerosub } from "./zerosub-runtime.js";
import { workerIdentityFromMetadata } from "../shared/supervise.js";

const CHECKPOINT_KEY = `${METADATA_KEY}.checkpoint`;
const LEGACY_CHECKPOINT_KEY = `${LEGACY_PREFIX}.checkpoint`;

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

async function applyWorkerResume(paseo: any, mainId: string, agentId: string, scopeId: string, deps: ResumeApplyDeps, lock: NonNullable<ResumeApplyDeps["lock"]>): Promise<ResumeApplyResult> {
  return lock(`worker-resume-${agentId}`, async () => {
    const ref = paseo.agents.ref(agentId);
    const [workspace, snapshot, cleanup, routes] = await Promise.all([
      paseo.workspaces.ref(mainId).refresh(), ref.refresh(), deps.getCleanupSettings?.(), resolveZerosub(deps),
    ]);
    const agent = snapshot?.agent;
    const meta = workspace?.metadata ?? {};
    const scope = asRecord(meta[METADATA_KEY]) ?? asRecord(meta[LEGACY_PREFIX]);
    if (!scope || scope.retired === true) throw new Error("The worker scope is no longer active.");
    const identity = cleanupIdentity(agent?.labels) ?? workerIdentityFromMetadata(agent);
    const entry = asRecord(meta[AGENTS_KEY]?.[agentId]);
    const worker = meta[WORKERS_KEY]?.[agentId];
    if (typeof entry?.replacedBy === "string") {
      return { agentId: entry.replacedBy, status: "blocked", cleared: false, detail: `Continue in replacement worker ${entry.replacedBy}.` };
    }
    if (identity?.role !== "worker" || !sameScopeId(identity.scopeId, scopeId) || agent.archivedAt || agent.background === true || (!entry?.interrupted && worker?.state !== "interrupted")) {
      throw new Error("/factory resume is available for steers and interrupted workers.");
    }
    if (readCleanupAction(entry) || agent.activeTurn || agent.pendingPermissions?.length || agent.status === "initializing" || agent.status === "running") {
      return { agentId, status: "blocked", cleared: false, detail: "The worker is busy. Try again after the current operation." };
    }
    const context = agentContextInputs(agent, entry, cleanup ?? CLEANUP_DEFAULTS, routes, deps.now ? Date.parse(deps.now()) : Date.now());
    const { warmth, large } = projectAgentContext(context);
    const replacementMessageId = !context.lastTurnEndedAt && typeof entry?.workerResumeMessageId === "string" ? entry.workerResumeMessageId : null;
    const alreadyRenewed = context.cleanedAfter || replacementMessageId !== null;
    if (alreadyRenewed && asRecord(actionFact(entry, "refreshed"))?.briefMessageId) {
      return { agentId, status: "sent", cleared: false, renewed: true, detail: "The renewed worker already received its brief." };
    }
    const mode = decideSteerDelivery({ warmth: warmth.warmth, large, recovery: true, settings: null, keepChatHistory: true });
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
    const at = asRecord(entry?.interrupted)?.at ?? worker?.pendingWake?.queuedAt ?? context.lastTurnEndedAt;
    const messageId = replacementMessageId ?? (typeof at === "string" ? `wsf-worker-resume-${agentId}-${at}` : null);
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
      `/factory resume is available for steers and interrupted workers; ${agentId} is outside that scope.`,
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
  const wsf = asRecord(meta[METADATA_KEY]) ?? asRecord(meta[LEGACY_PREFIX]);
  if (!wsf) throw new Error(`Workspace ${mainId} has no scope state`);
  const config = deps.getConfig ? await deps.getConfig() : null;
  const entries = asRecord(meta[AGENTS_KEY]) ?? {};
  const entry = asRecord(entries[agentId]);
  const checkpoint =
    asRecord(meta[CHECKPOINT_KEY]) ?? asRecord(meta[LEGACY_CHECKPOINT_KEY]);
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
  const activeHolder = (scopeHolder as any)({ agents: state.agents, workspaceId: mainId, scopeId: identity.scopeId, slot: wsf.activeSteer, ownerId: wsf.activeAgentId, previousSteer: wsf.previousSteer, strictLegacy: true });
  await lock(workspaceLockName(mainId), async (held: { verify: () => void }) => {
    await (guardScope as any)({ client: paseo, held, workspaceId: mainId, scopeId: identity.scopeId, epoch: wsf.epoch, agentId: activeHolder.id, config });
  });
  if (identity.role === "worker") return applyWorkerResume(paseo, mainId, agentId, identity.scopeId, deps, lock);
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
