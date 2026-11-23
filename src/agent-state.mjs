// Per-agent state for cold resume (C3): the `wsf.agents` map in the scope's
// main workspace metadata plus the scope checkpoint's interrupted flag.
// All writes go through the workspace lock; agent labels stay string-only,
// so turn/note/interrupt records live here, keyed by agent id.
import { isDeepStrictEqual } from 'node:util';
import { METADATA_KEY } from './paseo.mjs';
import { withLock, workspaceLockName } from './lock.mjs';

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
 * Flags the scope checkpoint as interrupted ({agentId, at}), keeping task and
 * next untouched. Returns null without a checkpoint (nothing to flag); the
 * agent-level interrupted record still exists in that case.
 */
export async function flagCheckpointInterrupted({ client, workspaceId, agentId, at = null, lock = withLock, now = () => new Date() }) {
  const workspace = client.workspaces.ref(workspaceId);
  return lock(workspaceLockName(workspaceId), async (held) => {
    const metadata = (await workspace.refresh())?.metadata ?? {};
    const checkpoint = metadata[CHECKPOINT_AGENTS_KEY] ?? null;
    if (!checkpoint || typeof checkpoint !== 'object') return null;
    const flagged = { ...checkpoint, interrupted: { agentId, at: at ?? now().toISOString() } };
    held.verify();
    await workspace.setMetadata({ [CHECKPOINT_AGENTS_KEY]: flagged });
    const written = (await workspace.refresh())?.metadata?.[CHECKPOINT_AGENTS_KEY];
    if (written?.interrupted?.agentId !== agentId) throw new Error(`Interrupted flag not verifiable after write in workspace ${workspaceId}`);
    return written;
  });
}
