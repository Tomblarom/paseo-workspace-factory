// @ts-nocheck
// GENERATED from src/agent-state.mjs by npm run plugin:sync. Do not edit.
// Per-agent state for cold resume (C3) plus open-turn tracking (P1): the
// `wsf.agents` map in the scope's main workspace metadata plus the scope
// checkpoint's interrupted flag. All writes go through the workspace lock;
// agent labels stay string-only, so turn/note/interrupt records live here,
// keyed by agent id.
//
// Data model per entry:
//   lastTurnId, lastTurnEndedAt, outcome,
//   openTurnId, turnStartedAt,      // set on agent.turn.before, cleared (null) on turn.after
//   contextTokens, note, noteAt,
//   interrupted: { at, outcome, error, excerpt, git, reason } | null,
//   cleared, pendingAction, lastActionFailed, previousSessions, actionVerified
// interrupted.reason is "daemon-restart" | "planned-restart" for restart
// markings (P1/P3); failed/canceled turns (C2) carry no reason.
import { isDeepStrictEqual } from 'node:util';
import { METADATA_KEY } from './paseo.js';
import { withLock, workspaceLockName } from './lock.js';

export const AGENTS_KEY = `${METADATA_KEY}.agents`;
export const CHECKPOINT_AGENTS_KEY = `${METADATA_KEY}.checkpoint`;

/** Stored bounds from the data model: entries are clipped, never rejected. */
export const NOTE_MAX = 1500;
export const EXCERPT_MAX = 1500;
export const ERROR_MAX = 300;

export function clipText(value, max) {
  if (typeof value !== 'string') return value;
  return value.length > max ? value.slice(0, max) : value;
}

function clipEntry(entry) {
  const clipped = { ...entry };
  if (typeof clipped.note === 'string') clipped.note = clipText(clipped.note, NOTE_MAX);
  if (clipped.interrupted && typeof clipped.interrupted === 'object') {
    clipped.interrupted = { ...clipped.interrupted };
    if (typeof clipped.interrupted.excerpt === 'string') clipped.interrupted.excerpt = clipText(clipped.interrupted.excerpt, EXCERPT_MAX);
    if (typeof clipped.interrupted.error === 'string') clipped.interrupted.error = clipText(clipped.interrupted.error, ERROR_MAX);
  }
  return clipped;
}

/**
 * Locked read-modify-write of one `wsf.agents` entry (shallow merge of patch
 * into the stored entry, bounded per the data model). Entries whose agent id
 * is not in `liveIds` are dropped when `liveIds` is given. Verified by
 * re-reading afterwards. Returns the merged entry.
 */
export async function updateAgentEntry({ client, workspaceId, agentId, patch, liveIds = null, lock = withLock }) {
  const workspace = client.workspaces.ref(workspaceId);
  return lock(workspaceLockName(workspaceId), async (held) => {
    const metadata = (await workspace.refresh())?.metadata ?? {};
    const state = { ...(metadata[AGENTS_KEY] ?? {}) };
    if (liveIds !== null && liveIds !== undefined) {
      const live = new Set(liveIds);
      for (const id of Object.keys(state)) {
        if (!live.has(id)) delete state[id];
      }
    }
    state[agentId] = clipEntry({ ...(state[agentId] ?? {}), ...patch });
    held.verify(); // the lock file must still be the locked inode right before the write
    await workspace.setMetadata({ [AGENTS_KEY]: state });
    const written = (await workspace.refresh())?.metadata?.[AGENTS_KEY]?.[agentId] ?? null;
    if (!isDeepStrictEqual(written, state[agentId])) throw new Error(`Agent entry ${agentId} not verifiable after write in workspace ${workspaceId}`);
    return written;
  });
}

/**
 * Flags the scope checkpoint as interrupted ({agentId, at} plus an optional
 * reason), keeping task and next untouched. Returns null without a checkpoint
 * (nothing to flag); the agent-level interrupted record still exists in that
 * case. The reason is omitted when not given, so C2 flags stay unchanged.
 */
export async function flagCheckpointInterrupted({ client, workspaceId, agentId, at = null, reason = null, lock = withLock, now = () => new Date() }) {
  const workspace = client.workspaces.ref(workspaceId);
  return lock(workspaceLockName(workspaceId), async (held) => {
    const metadata = (await workspace.refresh())?.metadata ?? {};
    const checkpoint = metadata[CHECKPOINT_AGENTS_KEY] ?? null;
    if (!checkpoint || typeof checkpoint !== 'object') return null;
    const flagged = { ...checkpoint, interrupted: { agentId, at: at ?? now().toISOString(), ...(reason ? { reason } : {}) } };
    held.verify();
    await workspace.setMetadata({ [CHECKPOINT_AGENTS_KEY]: flagged });
    const written = (await workspace.refresh())?.metadata?.[CHECKPOINT_AGENTS_KEY];
    if (written?.interrupted?.agentId !== agentId) throw new Error(`Interrupted flag not verifiable after write in workspace ${workspaceId}`);
    return written;
  });
}

/**
 * True when the entry tracks an open turn that started before the daemon
 * started: the turn died with the restart and never reached turn.after.
 * Fails closed on missing or unparsable timestamps (no mark).
 */
export function isOpenTurnBeforeRestart(entry, daemonStartedAt) {
  if (!entry || typeof entry !== 'object') return false;
  const started = entry.turnStartedAt;
  if (typeof started !== 'string' || !started) return false;
  if (typeof daemonStartedAt !== 'string' || !daemonStartedAt) return false;
  const turnMs = Date.parse(started);
  const daemonMs = Date.parse(daemonStartedAt);
  if (!Number.isFinite(turnMs) || !Number.isFinite(daemonMs)) return false;
  return turnMs < daemonMs;
}

/**
 * Builds one restart interrupted record (P1 daemon-restart, P3
 * planned-restart) in the C2 shape plus the reason. Bounds are clipped, never
 * rejected. Outcome defaults to canceled: the turn never completed.
 */
export function buildRestartInterrupted({ at, reason, error = null, excerpt = null, git = null, outcome = 'canceled' }) {
  return {
    at,
    outcome,
    error: typeof error === 'string' && error ? clipText(error, ERROR_MAX) : null,
    excerpt: typeof excerpt === 'string' && excerpt ? clipText(excerpt.length > EXCERPT_MAX ? excerpt.slice(-EXCERPT_MAX) : excerpt, EXCERPT_MAX) : null,
    git: git ?? null,
    reason,
  };
}
