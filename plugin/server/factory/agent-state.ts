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
//   action: one live operation per target (steer-action.mjs) with facts
//     (cleared, actionVerified, lastActionFailed, refreshed, freshHint) and
//     an optional cleanup intent; legacy top-level fields migrate on write.
//   previousSessions: bounded history of pre-clear sessions (kept: UI + import)
//   settingsBaseline: { provider, model, thinking, speed, sessionId, turnId, at } | null
//   settingsConfirmed: { provider, model, thinking, speed, fingerprint, at } | null
// interrupted.reason is "daemon-restart" | "planned-restart" for restart
// markings (P1/P3); failed/canceled turns (C2) carry no reason.
import { isDeepStrictEqual } from 'node:util';
import { METADATA_KEY } from './paseo.js';
import { withLock, workspaceLockName } from './lock.js';
import { actionFact, mergeActionFacts } from './action-facts.js';

export const AGENTS_KEY = `${METADATA_KEY}.agents`;
export const CHECKPOINT_AGENTS_KEY = `${METADATA_KEY}.checkpoint`;

/** Stored bounds from the data model: entries are clipped, never rejected. */
export const NOTE_MAX = 1500;
export const EXCERPT_MAX = 1500;
export const ERROR_MAX = 300;
const FRESH_HINT_REASON_MAX = 300;
/** Settings baseline ids (provider/model/thinking/speed/session) are clipped, never rejected. */
export const SETTINGS_ID_MAX = 200;

export function clipText(value, max) {
  if (typeof value !== 'string') return value;
  return value.length > max ? value.slice(0, max) : value;
}

/** The hint belongs to the current idle period and carries a bounded reason. */
export function currentFreshHint(entry) {
  const hint = actionFact(entry, 'freshHint');
  const reason = typeof hint?.reason === 'string' ? hint.reason.replace(/\s+/g, ' ').trim() : '';
  const hintedAt = typeof hint?.at === 'string' ? Date.parse(hint.at) : NaN;
  const lastEnd = typeof entry?.lastTurnEndedAt === 'string' ? Date.parse(entry.lastTurnEndedAt) : NaN;
  if (!reason || !Number.isFinite(hintedAt) || (Number.isFinite(lastEnd) && hintedAt < lastEnd)) return null;
  return clipText(reason, FRESH_HINT_REASON_MAX);
}

function clipEntry(entry) {
  const clipped = { ...entry };
  if (typeof clipped.note === 'string') clipped.note = clipText(clipped.note, NOTE_MAX);
  if (clipped.interrupted && typeof clipped.interrupted === 'object') {
    clipped.interrupted = { ...clipped.interrupted };
    if (typeof clipped.interrupted.excerpt === 'string') clipped.interrupted.excerpt = clipText(clipped.interrupted.excerpt, EXCERPT_MAX);
    if (typeof clipped.interrupted.error === 'string') clipped.interrupted.error = clipText(clipped.interrupted.error, ERROR_MAX);
  }
  for (const key of ['settingsBaseline', 'settingsConfirmed']) {
    const baseline = clipped[key];
    if (baseline && typeof baseline === 'object') {
      const next = { ...baseline };
      for (const field of ['provider', 'model', 'thinking', 'speed', 'sessionId', 'fingerprint']) {
        if (typeof next[field] === 'string') next[field] = clipText(next[field], SETTINGS_ID_MAX);
      }
      clipped[key] = next;
    }
  }
  return clipped;
}

/**
 * Builds one settings baseline for `wsf.agents` (step 4): the live
 * provider/model/thinking/speed tuple plus the session id at turn end.
 * Values are normalized to trimmed strings or null and clipped; `at` defaults
 * to now, `turnId` may be null. Returns null without a session id (nothing
 * comparable to store).
 */
export function buildSettingsBaseline({ provider = null, model = null, thinking = null, speed = null, sessionId = null, turnId = null, at = null, now = () => new Date() } = {}) {
  const clean = (value) => (typeof value === 'string' && value.trim() ? clipText(value.trim(), SETTINGS_ID_MAX) : null);
  const session = clean(sessionId);
  if (!session) return null;
  const stamp = typeof at === 'string' && at ? at : (typeof now === 'function' ? now() : now)?.toISOString?.() ?? new Date().toISOString();
  return {
    provider: clean(provider)?.toLowerCase() ?? null,
    model: clean(model),
    thinking: clean(thinking),
    speed: clean(speed)?.toLowerCase() ?? null,
    sessionId: session,
    turnId: clean(turnId),
    at: stamp,
  };
}

/**
 * True when the stored baseline is comparable to the live session: both
 * carry the same non-empty session id. A session change (reopen, clear,
 * rewind) or a missing baseline is Unknown, never a warning.
 */
export function isComparableBaseline(baseline, liveSessionId) {
  const stored = baseline?.sessionId;
  if (typeof stored !== 'string' || !stored) return false;
  if (typeof liveSessionId !== 'string' || !liveSessionId) return false;
  return stored === liveSessionId;
}

/**
 * Locked read-modify-write of one `wsf.agents` entry (shallow merge of patch
 * into the stored entry, bounded per the data model). Entries whose agent id
 * is not in `liveIds` are dropped when `liveIds` is given. Verified by
 * re-reading afterwards. Returns the merged entry.
 */
export async function updateAgentEntry({ client, workspaceId, agentId, patch, liveIds = null, lock = withLock, guard = null }) {
  const workspace = client.workspaces.ref(workspaceId);
  return lock(workspaceLockName(workspaceId), async (held) => {
    const metadata = (await workspace.refresh())?.metadata ?? {};
    if (guard) await guard({ held, metadata });
    const state = { ...(metadata[AGENTS_KEY] ?? {}) };
    const entryPatch = typeof patch === 'function' ? patch(state[agentId] ?? null) : patch;
    if (entryPatch === null) return state[agentId] ?? null;
    if (liveIds !== null && liveIds !== undefined) {
      const live = new Set(liveIds);
      for (const id of Object.keys(state)) {
        if (!live.has(id)) delete state[id];
      }
    }
    state[agentId] = clipEntry(mergeActionFacts(state[agentId], entryPatch));
    for (const key of Object.keys(state[agentId])) if (state[agentId][key] === undefined) delete state[agentId][key];
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
