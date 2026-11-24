// Manual `/factory resume` (R-A): checkpoint the steer, clear its context in
// place (same tab, same id), and send the resume brief into the fresh
// timeline. The clear reuses runCleanup from the C5 sweep; the turn hook sends
// the brief after a verified clear, or the RPC sends it immediately for
// providers without clear support. Only erasable TypeScript: node --test
// imports this file with type stripping (see plugin/test/ts-resolve-hooks.mjs).
import { AGENTS_KEY, updateAgentEntry } from "./factory/agent-state.js";
import { withLock, workspaceLockName } from "./factory/lock.js";
import { LEGACY_PREFIX, METADATA_KEY, readPaseoState } from "./factory/paseo.js";
import { listScopes } from "./factory/scope.js";
import { lastAssistantText, parseCheckpointBlock } from "./factory/steer.js";
import { runCleanup } from "./cold-sweep.js";
import {
  RESUME_PENDING_REASON,
  cleanupIdentity,
  formatResumeMessage,
  mayResumeClear,
  type ResumeClearSettings,
} from "../shared/idle-cleanup.js";
import { resumeFingerprint } from "../shared/preview.js";

const CHECKPOINT_KEY = `${METADATA_KEY}.checkpoint`;
const LEGACY_CHECKPOINT_KEY = `${LEGACY_PREFIX}.checkpoint`;

// The synced core is unchecked (@ts-nocheck): its inferred parameter types are
// too narrow for real calls, so resume talks to it as any (as the sweep does).
const updateEntry = updateAgentEntry as unknown as (args: any) => Promise<any>;
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

export interface ResumeApplyDeps {
  /** Reads the resume settings document; null falls back to the defaults. */
  getResumeSettings?: () => Promise<ResumeClearSettings | null>;
  /** Builds the resume brief; required on the immediate-brief path. */
  buildBrief?: (paseo: any, workspaceId: string, agentId: string) => Promise<string>;
  /** Cleanup sender; production uses runCleanup, tests inject a fake. */
  runCleanupFn?: typeof runCleanup;
  /** Lock for the checkpoint and entry writes; tests only. */
  lock?: (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>;
  /** F4 wake note, appended to the brief (clear path: via pendingAction). */
  note?: string;
  now?: () => string;
  log?: (message: string) => void;
}

export interface ResumeApplyResult {
  agentId: string;
  cleared: boolean;
  detail: string;
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
  block: { task: string; tests: string[]; blockers: string[]; next: string | null },
  lock: (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>,
): Promise<void> {
  await lock(workspaceLockName(mainId), async (held: { verify: () => void }) => {
    const freshMeta =
      (await paseo.workspaces.ref(mainId).refresh().catch(() => null))?.metadata ?? {};
    const freshWsf = asRecord(freshMeta[METADATA_KEY]) ?? asRecord(freshMeta[LEGACY_PREFIX]);
    if (!freshWsf) throw new Error("scope state is gone");
    if (freshWsf.epoch !== epoch) {
      throw new Error("the scope moved on (epoch changed); run /factory resume again");
    }
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
  });
}

/**
 * Applies a manual resume to one steer (E2): guard, refuse running, save the
 * CHECKPOINT from the last answer when it is newer, then clear (providers in
 * resumeClear.providers; the turn hook sends the brief after the verified
 * clear) or send the brief immediately. One open pendingAction per agent makes
 * double clicks idempotent; the C5 daily cap does not apply here.
 */
export async function applyResume(
  paseo: any,
  input: ResumeApplyInput,
  deps: ResumeApplyDeps = {},
): Promise<ResumeApplyResult> {
  const log = deps.log ?? console.log;
  const lock = deps.lock ?? (withLock as unknown as ResumeApplyDeps["lock"] as NonNullable<ResumeApplyDeps["lock"]>);
  const agentId = input.agentId.trim();
  const state: any = await readPaseoState(paseo);
  const agent: any = (state.agents ?? []).find((a: any) => a?.id === agentId) ?? null;
  if (!agent) throw new Error(`Unknown agent ${JSON.stringify(agentId)}`);
  const identity = cleanupIdentity(agent.labels ?? null);
  if (!identity || identity.role !== "steer") {
    throw new Error(
      `/factory resume is only for steers; ${agentId} is not a steer. Open a steer tab (Steer A, B, …) and run it there.`,
    );
  }
  if (agent.status === "running" || agent.status === "initializing") {
    throw new Error(
      `Steer ${agentId} is running; try again after the turn ends (or stop it first, then resume).`,
    );
  }
  const scope: any = listScopes(state).find((s: any) => s.id === identity.scopeId) ?? null;
  if (!scope) throw new Error(`Agent ${agentId} has no live factory scope`);
  const mainId: string = scope.workspaceId;
  const meta = scope.workspace?.metadata ?? {};
  const wsf = asRecord(meta[METADATA_KEY]) ?? asRecord(meta[LEGACY_PREFIX]);
  if (!wsf) throw new Error(`Workspace ${mainId} has no scope state`);
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
  if (entry?.pendingAction) {
    const kind = asRecord(entry.pendingAction)?.kind;
    return {
      agentId,
      cleared: kind === "clear",
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
  if (block && shouldSaveResumeCheckpoint({ block, checkpoint, lastTurnEndedAt: entry?.lastTurnEndedAt })) {
    await saveResumeCheckpoint(paseo, mainId, agentId, wsf.epoch, block, lock);
    checkpointSaved = true;
  }
  const settings = deps.getResumeSettings ? await deps.getResumeSettings() : null;
  const provider = typeof agent.provider === "string" ? agent.provider : "";
  if (mayResumeClear(provider, settings)) {
    const run = deps.runCleanupFn ?? runCleanup;
    try {
      await run(paseo, agentId, "clear", RESUME_PENDING_REASON, {
        ...(typeof deps.note === "string" && deps.note ? { note: deps.note } : {}),
        ...(deps.lock ? { lock: deps.lock } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Resume could not clear ${agentId} (${message}). Open its tab, then try again.`,
      );
    }
    log(`[factory] resume: sent /clear to ${agentId}`);
    return {
      agentId,
      cleared: true,
      detail: checkpointSaved
        ? "Checkpoint saved; clearing the context, then the resume brief arrives in the timeline."
        : "Clearing the context; the resume brief arrives in the timeline after.",
    };
  }
  if (!deps.buildBrief) {
    throw new Error("Resume brief builder is not wired (server misconfiguration)");
  }
  const brief = await deps.buildBrief(paseo, mainId, agentId);
  const full =
    typeof deps.note === "string" && deps.note ? `${brief}\n\n${deps.note}` : brief;
  try {
    await paseo.agents.ref(agentId).send(formatResumeMessage(full));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Resume could not reach ${agentId} (${message}). Open its tab, then try again.`,
    );
  }
  await updateEntry({
    client: paseo,
    workspaceId: mainId,
    agentId,
    patch: { needsResume: null },
    liveIds: null,
    lock,
  });
  const providers = settings?.providers ?? ["claude"];
  return {
    agentId,
    cleared: false,
    detail:
      `Resume brief sent without clearing (provider ${provider || "?"} is not in ` +
      `resumeClear.providers: ${providers.join(", ")}).`,
  };
}
