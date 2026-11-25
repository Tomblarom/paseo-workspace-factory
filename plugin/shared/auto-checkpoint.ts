// Pure decision logic for the C2 auto-checkpoint hook (agent.turn.after).
// No imports, so plain node:test can use it. Timeline fetching, CHECKPOINT
// parsing, git snapshots, locks, and metadata writes live in
// server/turn-hook.ts, which applies the returned decision.

export const MAX_EXCERPT = 1500;
export const MAX_ERROR = 300;
export const MAX_NOTE = 1500;
/** Stored fresh-hint reason cap (same bound as errors). */
export const MAX_FRESH_REASON = 300;
/** Warm compactions before the C5 decision recommends fresh instead. */
export const MAX_WARM_COMPACTIONS = 2;
/** Post-compact base above this recommends fresh instead of compacting again. */
export const FRESH_BASE_TOKENS = 60_000;
/** Stored compaction counter cap (metadata stays bounded). */
export const COMPACTIONS_STORED_MAX = 99;

// Label keys mirror LABEL in core paseo.mjs (shared/ must not import server/).
const SCOPE_KEY = "wsf.scope";
const ROLE_KEY = "wsf.role";
const SLOT_KEY = "wsf.slot";
const LEGACY_SCOPE_KEY = "ari.wsf.scope";
// Steers created before wsf.scope carry only the repo label;
// for steers the repo label is the scope id, as in core discovery.
const REPO_KEY = "wsf.repo";
const LEGACY_REPO_KEY = "ari.wsf.repo";
const LEGACY_ROLE_KEY = "ari.wsf.role";
const LEGACY_SLOT_KEY = "ari.wsf.slot";

export interface FactoryIdentity {
  scopeId: string;
  role: string;
  slot: string | null;
}

/** Factory steer/worker from agent labels (legacy prefix accepted), else null. */
export function factoryIdentity(
  labels: Record<string, string> | null | undefined,
): FactoryIdentity | null {
  if (!labels) return null;
  const scopeId =
    labels[SCOPE_KEY] ?? labels[LEGACY_SCOPE_KEY] ?? labels[REPO_KEY] ?? labels[LEGACY_REPO_KEY] ?? "";
  const role = labels[ROLE_KEY] ?? labels[LEGACY_ROLE_KEY] ?? "";
  if (!scopeId || (role !== "steer" && role !== "worker")) return null;
  const slot = labels[SLOT_KEY] ?? labels[LEGACY_SLOT_KEY] ?? null;
  return { scopeId, role, slot: slot || null };
}

/** Which cleanup command a turn ran, from its first user message, else null. */
export function cleanupCommandKind(text: string | null | undefined): "clear" | "compact" | null {
  const first = (text ?? "").trim().split(/\s+/, 1)[0] ?? "";
  if (first === "/clear") return "clear";
  if (first === "/compact") return "compact";
  return null;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text;
}

export interface CheckpointBlock {
  task: string;
  tests: string[];
  blockers: string[];
  next: string | null;
}

export function serializeNote(block: CheckpointBlock): string {
  const lines = [`task: ${block.task}`];
  if (block.tests.length) lines.push(`tests: ${block.tests.join("; ")}`);
  if (block.blockers.length) lines.push(`blockers: ${block.blockers.join("; ")}`);
  if (block.next) lines.push(`next: ${block.next}`);
  return truncate(lines.join("\n"), MAX_NOTE);
}

export interface TurnGit {
  branch: string;
  sha: string;
  changes: number;
}

/**
 * Evidence for the C5 effect check, gathered by the caller from the agent
 * snapshot (session id) and the turn timeline. Null when the turn is not one
 * of our own cleanup turns (no verification applies).
 */
export interface CleanupEffect {
  /** Current session id differs from the pre-send one; null when unknown. */
  sessionChanged: boolean | null;
  /** A completed `compaction` timeline item was found in the turn. */
  compactionSeen: boolean;
  /** A `[Compacted]` marker text was found in the turn. */
  markerSeen: boolean;
  /** Turn timeline entries could be read at all. */
  turnReadable: boolean;
}

export interface TurnDecisionInput {
  agentId: string;
  slot: string | null;
  role: string;
  activeSteer: unknown;
  archived: boolean;
  turnId: string | null;
  outcome: "completed" | "failed" | "canceled";
  /** Normalized failure text (failed message or cancel reason), untruncated. */
  error: string | null;
  /** Parsed CHECKPOINT block (completed turns only), else null. */
  block: CheckpointBlock | null;
  lastAnswer: string | null;
  turnUserText: string | null;
  git: TurnGit | null;
  contextTokens: number | null;
  epoch: unknown;
  checkpoint: Record<string, unknown> | null;
  previous: Record<string, unknown> | null;
  /** Effect evidence for our own cleanup turns; null for ordinary turns. */
  effect: CleanupEffect | null;
  now: string;
}

export interface TurnDecision {
  /** Fields merged into wsf.agents[agentId]; null when the entry is dropped. */
  entryUpdate: Record<string, unknown> | null;
  /** Full wsf.checkpoint replacement, or undefined to leave it. */
  checkpoint?: Record<string, unknown>;
  /** Interrupted flag merged into the existing checkpoint, if it has a task. */
  patchInterrupted?: { agentId: string; at: string };
  /** Clear pendingAction (a cleanup turn resolved it). */
  resolvePending?: boolean;
  /** The command may have taken effect despite an incomplete observation. */
  cleanupUncertain?: boolean;
  /** A cleanup command demonstrably had no effect; the caller disables C5. */
  effectFailed?: boolean;
  /** Drop the wsf.agents entry (archived agent). */
  dropSelf?: boolean;
  log: string;
}

/**
 * One C2 table row per turn. The caller merges entryUpdate onto the freshly
 * read entry under the workspace lock (so concurrent fields such as a new
 * pendingAction survive), clears pendingAction when resolvePending is set,
 * applies checkpoint/patchInterrupted after the race check, disables the C5
 * automation when effectFailed is set, and drops dropSelf entries.
 */
export function decideTurnUpdate(input: TurnDecisionInput): TurnDecision {
  const at = input.now;
  if (input.archived) {
    return { entryUpdate: null, dropSelf: true, log: `drop entry of archived agent ${input.agentId}` };
  }
  const base = {
    lastTurnId: input.turnId,
    lastTurnEndedAt: at,
    outcome: input.outcome,
    contextTokens: input.contextTokens,
    // P1: every turn.after clears the open-turn tracking from turn.before.
    openTurnId: null,
    turnStartedAt: null,
  };
  const pending = (input.previous?.pendingAction ?? null) as {
    kind?: unknown;
    at?: unknown;
  } | null;
  const command = cleanupCommandKind(input.turnUserText);
  const checkpointAt =
    (input.checkpoint?.capturedAt as string | undefined) ??
    (input.checkpoint?.updatedAt as string | undefined) ??
    null;

  // Our own cleanup turn: resolve the pending action into cleared (completed)
  // or lastActionFailed (failed/canceled). Never an interrupted record — this
  // is our action, not agent work — and never a scope flag. It is also not a
  // real turn: only a completed ordinary turn clears lastActionFailed, so C5
  // cannot retry within the same idle period.
  if (pending?.kind === command && command !== null) {
    const kind = String(pending.kind ?? command);
    if (input.outcome !== "completed") {
      return {
        entryUpdate: {
          ...base,
          lastActionFailed: {
            at,
            error: input.error ? truncate(input.error, MAX_ERROR) : `${kind} turn ${input.outcome}`,
          },
        },
        resolvePending: true,
        cleanupUncertain: true,
        log: `cleanup turn ${input.outcome}; pending ${kind} → lastActionFailed`,
      };
    }
    const verdict = verifyCleanupEffect(kind, input.previous, input.effect);
    if (verdict !== "verified") {
      return {
        entryUpdate: {
          ...base,
          lastActionFailed: {
            at,
            error:
              kind === "compact"
                ? verdict === "failed" ? "compact had no confirmed effect (no completed compaction)" : "compact could not be confirmed (turn unavailable)"
                : verdict === "failed" ? "clear had no effect (session unchanged)" : "clear could not be confirmed (session unavailable)",
          },
        },
        resolvePending: true,
        cleanupUncertain: verdict === "unverifiable",
        effectFailed: verdict === "failed",
        log: `cleanup effect ${verdict}; pending ${kind} → lastActionFailed`,
      };
    }
    const compacted = kind === "compact";
    const prior =
      typeof input.previous?.compactions === "number" && Number.isFinite(input.previous.compactions)
        ? Math.max(0, input.previous.compactions)
        : 0;
    return {
      entryUpdate: {
        ...base,
        lastActionFailed: null,
        cleared: { at, mode: pending.kind ?? command, checkpointAt },
        ...(verdict === "verified" ? { actionVerified: true } : {}),
        // Hybrid compact/fresh rule: a compact spends one of the warm
        // compactions and arms the post-compact base reading; a clear wipes
        // the compaction debt. Either way a recorded fresh hint is stale.
        freshHint: null,
        ...(compacted
          ? {
              compactions: Math.min(prior + 1, COMPACTIONS_STORED_MAX),
              compactionPendingBase: true,
            }
          : { compactions: 0, lastCompactBaseTokens: null, compactionPendingBase: null }),
      },
      resolvePending: true,
      log:
        verdict === "verified"
          ? `resolved pending ${kind} → cleared (effect verified)`
          : `resolved pending ${kind} → cleared (effect unverifiable; checked again next time)`,
    };
  }

  // The first completed turn after our compact settles the post-compact base
  // reading (when usage is known); every real turn clears a recorded fresh
  // hint, because the package moved on.
  const settleBase =
    input.previous?.compactionPendingBase === true
      ? {
          compactionPendingBase: null,
          ...(typeof input.contextTokens === "number" && Number.isFinite(input.contextTokens)
            ? { lastCompactBaseTokens: input.contextTokens }
            : {}),
        }
      : {};

  if (input.outcome === "completed") {
    const isActive = input.role === "steer" && typeof input.slot === "string" && input.slot === input.activeSteer;
    if (input.block && isActive) {
      return {
        entryUpdate: { ...base, freshHint: null, ...settleBase, interrupted: null, lastActionFailed: null },
        checkpoint: {
          task: input.block.task,
          tests: input.block.tests,
          blockers: input.block.blockers,
          next: input.block.next,
          epoch: input.epoch,
          updatedAt: at,
          source: "agent",
          agentId: input.agentId,
          turnId: input.turnId,
          capturedAt: at,
          interrupted: null,
        },
        log: `scope checkpoint := block of Steer ${input.slot}`,
      };
    }
    if (input.block) {
      return {
        entryUpdate: {
          ...base,
          freshHint: null,
          ...settleBase,
          interrupted: null,
          lastActionFailed: null,
          note: serializeNote(input.block),
          noteAt: at,
        },
        log: `note := block of ${input.role} ${input.slot ?? input.agentId}`,
      };
    }
    // A completed turn without a CHECKPOINT block is a real turn (it lifts
    // the retry block) but never clears interrupted: recovery needs a block.
    return {
      entryUpdate: { ...base, freshHint: null, ...settleBase, lastActionFailed: null },
      log: "turn recorded; no block",
    };
  }

  // failed / canceled: the agent record always lands; the scope checkpoint
  // only gains the interrupted flag (task/next stay untouched).
  const hasTask =
    typeof input.checkpoint?.task === "string" && (input.checkpoint.task as string).trim() !== "";
  return {
    entryUpdate: { ...base, interrupted: interruptedOf(input, at) },
    ...(hasTask ? { patchInterrupted: { agentId: input.agentId, at } } : {}),
    log: hasTask
      ? `interrupted (${input.outcome}); scope checkpoint flagged`
      : `interrupted (${input.outcome}); no scope checkpoint to flag`,
  };
}

/**
 * Every clear needs independent evidence from the provider session. A
 * compaction needs a completed provider event from the correlated turn.
 */
export function verifyCleanupEffect(
  kind: string,
  previous: Record<string, unknown> | null,
  effect: CleanupEffect | null,
): "verified" | "unverifiable" | "failed" {
  if (kind === "compact") {
    if (!effect) return "unverifiable";
    if (effect.compactionSeen) return "verified";
    return "unverifiable";
  }
  if (effect?.sessionChanged === true) return "verified";
  return effect?.sessionChanged === false ? "failed" : "unverifiable";
}

function interruptedOf(
  input: TurnDecisionInput,
  at: string,
): Record<string, unknown> {
  return {
    at,
    outcome: input.outcome,
    error: input.error ? truncate(input.error, MAX_ERROR) : null,
    excerpt: input.lastAnswer ? tail(input.lastAnswer, MAX_EXCERPT) : null,
    git: input.git ? { branch: input.git.branch, sha: input.git.sha, changes: input.git.changes } : null,
  };
}

/** Epoch/active-steer race check under the lock; null means proceed. */
export function checkRace(
  expected: { activeSteer: unknown; epoch: unknown },
  fresh: { activeSteer: unknown; epoch: unknown } | null,
): string | null {
  if (!fresh) return "scope state is gone";
  if (fresh.epoch !== expected.epoch) {
    return `epoch moved ${String(expected.epoch)} → ${String(fresh.epoch)}`;
  }
  if (fresh.activeSteer !== expected.activeSteer) {
    return `active steer moved ${String(expected.activeSteer)} → ${String(fresh.activeSteer)}`;
  }
  return null;
}

/** Drops archived agents' entries from a wsf.agents record. */
export function dropEntries(
  agents: Record<string, unknown>,
  ids: string[],
): Record<string, unknown> {
  if (!ids.length) return agents;
  const next = { ...agents };
  for (const id of ids) delete next[id];
  return next;
}
