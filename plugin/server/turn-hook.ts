import { LEGACY_PREFIX, METADATA_KEY, readPaseoState } from "./factory/paseo.js";
import { listScopes } from "./factory/scope.js";
import { createGit } from "./factory/local.js";
import { withWorkspaceLock } from "./factory/lock.js";
import {
  agentUsage,
  lastAssistantText,
  parseCheckpointBlock,
  readGitSnapshot,
} from "./factory/steer.js";
import { captureSweepPaseo, noteEffectFailure } from "./cold-sweep.js";
import {
  SEED_AFTER_CLEAR,
  scanCleanupEvidence,
} from "../shared/idle-cleanup.js";
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

export interface TurnHookDeps {
  /** Reads the C5 settings for the seed-after-clear step; absent means no seed. */
  getCleanupSettings?: () => Promise<{ seedAfterClear: boolean } | null>;
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

function firstUserText(entries: unknown): string | null {
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const item = (entry as { item?: { type?: unknown; text?: unknown } } | null)?.item;
    if (item?.type === "user_message" && typeof item.text === "string") return item.text;
  }
  return null;
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

  // One core lock helper names and takes workspace locks (never duplicated here).
  const lockOptions: any = undefined;
  await withWorkspaceLock(mainId, async (held: any) => {
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
    const prev = asRecord(freshAgents[agentId]) ?? {};
    const merged = { ...prev, ...(decision.entryUpdate ?? {}) };
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
  }, lockOptions);

  if (decision.effectFailed) {
    noteEffectFailure(
      `a cleanup command to ${agentId} arrived as text without effect (see wsf.agents.${agentId}.lastActionFailed)`,
    );
    return;
  }
  // Optional one-line seed after a verified clear: it costs one small turn and
  // tells the resumed agent to load the resume brief first.
  const cleared = asRecord(decision.entryUpdate?.cleared);
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
