// Drain for planned restarts (P3): waits until no factory agent is running,
// then the daemon can be restarted cleanly. Agents still running at the
// timeout are marked interrupted with reason "planned-restart" (git snapshot,
// last answer tail) and the open-turn tracking is cleared, so the post-restart
// boot check keeps the planned reason instead of overwriting it. Never
// restarts anything itself. While it waits, a `wsf.drain` marker in every
// scope's main workspace keeps supervision wakes quiet (M1).
import { isDeepStrictEqual } from 'node:util';
import { LABEL, METADATA_KEY, readPaseoState } from './paseo.mjs';
import { withLock, workspaceLockName } from './lock.mjs';
import { listScopes } from './scope.mjs';
import { AGENTS_KEY, buildRestartInterrupted, flagCheckpointInterrupted, updateAgentEntry } from './agent-state.mjs';
import { CHECKPOINT_KEY, lastAssistantText, readGitSnapshot } from './steer.mjs';

const BUSY = new Set(['running', 'initializing']);

export const DRAIN_DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const DRAIN_POLL_MS = 2000;
export const DRAIN_KEY = `${METADATA_KEY}.drain`;
/** Markers past timeoutAt + this grace are ignored (a crashed drain self-expires). */
export const DRAIN_GRACE_MS = 60_000;

/** Builds the `wsf.drain` marker drain stores while it waits ({ startedAt, timeoutAt, pid }). */
export function buildDrainMarker({ startedAt = null, timeoutAt = null, pid = null } = {}) {
  return { startedAt, timeoutAt, pid };
}

/**
 * True while the marker claims a live drain (now <= timeoutAt + 1 min).
 * Malformed or expired markers are ignored (no quiet), so a crashed drain
 * self-expires; the plugin mirrors this rule (shared/supervise.ts).
 */
export function isDrainMarkerActive(marker, nowMs = Date.now()) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
  const timeoutMs = typeof marker.timeoutAt === 'string' ? Date.parse(marker.timeoutAt) : NaN;
  if (!Number.isFinite(timeoutMs)) return false;
  const now = typeof nowMs === 'string' ? Date.parse(nowMs) : nowMs;
  if (!Number.isFinite(now)) return false;
  return now <= timeoutMs + DRAIN_GRACE_MS;
}

/**
 * Stores the drain marker in one workspace's metadata under the workspace
 * lock, verified by re-reading. Overwrites unconditionally: a drain waits for
 * the whole instance, so overlapping drains collapse into one quiet period.
 */
export async function setDrainMarker({ client, workspaceId, marker, lock = withLock }) {
  if (!workspaceId) throw new Error('setDrainMarker needs a workspaceId');
  const workspace = client.workspaces.ref(workspaceId);
  return lock(workspaceLockName(workspaceId), async (held) => {
    held.verify(); // the lock file must still be the locked inode right before the write
    await workspace.setMetadata({ [DRAIN_KEY]: marker });
    const written = (await workspace.refresh())?.metadata?.[DRAIN_KEY] ?? null;
    if (!isDeepStrictEqual(written, marker)) throw new Error(`Drain marker not verifiable after write in workspace ${workspaceId}`);
    return written;
  });
}

/**
 * Clears the drain marker under the workspace lock. When `marker` (the
 * writer's own) is given, a foreign marker is left alone, so an overlapping
 * drain keeps its quiet period. Returns true when a marker was cleared.
 */
export async function clearDrainMarker({ client, workspaceId, marker = null, lock = withLock }) {
  if (!workspaceId) throw new Error('clearDrainMarker needs a workspaceId');
  const workspace = client.workspaces.ref(workspaceId);
  return lock(workspaceLockName(workspaceId), async (held) => {
    const stored = (await workspace.refresh())?.metadata?.[DRAIN_KEY] ?? null;
    if (stored === null || stored === undefined) return false;
    if (marker && stored && typeof stored === 'object'
      && (stored.startedAt !== marker.startedAt || stored.pid !== marker.pid)) {
      return false;
    }
    held.verify(); // the lock file must still be the locked inode right before the write
    await workspace.setMetadata({ [DRAIN_KEY]: null });
    const cleared = (await workspace.refresh())?.metadata?.[DRAIN_KEY] ?? null;
    if (cleared !== null && cleared !== undefined) throw new Error(`Drain marker not verifiable after clear in workspace ${workspaceId}`);
    return true;
  });
}

/**
 * Parses a drain timeout ("10m", "30s", "1h", "500ms", bare seconds). Returns
 * milliseconds. Throws on invalid input.
 */
export function parseTimeout(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) throw new Error('drain needs --timeout <duration> like 10m (ms, s, m, h)');
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!match) throw new Error(`invalid --timeout ${JSON.stringify(raw)}: want <number>[ms|s|m|h], e.g. 10m`);
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid --timeout ${JSON.stringify(raw)}`);
  const unit = match[2] ?? 's';
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return Math.round(value * factor);
}

/** True for a live factory steer/worker that is still running a turn. */
export function isRunningAgent(agent) {
  if (!agent || agent.archivedAt) return false;
  const role = agent.labels?.[LABEL.role];
  const scopeId = agent.labels?.[LABEL.scope];
  if (typeof scopeId !== 'string' || !scopeId) return false;
  if (role !== 'steer' && role !== 'worker') return false;
  return BUSY.has(agent.status) || Boolean(agent.activeTurn);
}

/** Running factory agents in a Paseo state snapshot, sorted by id. */
export function factoryRunningAgents(paseoState) {
  const out = [];
  for (const agent of paseoState?.agents ?? []) {
    if (!isRunningAgent(agent)) continue;
    out.push({
      id: agent.id,
      scopeId: agent.labels[LABEL.scope],
      role: agent.labels[LABEL.role],
      slot: agent.labels?.[LABEL.slot] ?? null,
      title: agent.title ?? null,
      status: agent.status ?? null,
      workspaceId: agent.workspaceId ?? null,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function sleepMs(ms, sleep) {
  if (typeof sleep === 'function') return sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultReadExcerpt(client, agentId) {
  try {
    const text = lastAssistantText(await client.agents.ref(agentId).timeline.refetch({ direction: 'tail', limit: 20 }));
    return typeof text === 'string' && text ? text : null;
  } catch {
    return null;
  }
}

function defaultReadGit(git, directory) {
  if (typeof git !== 'function' || !directory) return null;
  try {
    return readGitSnapshot(git, directory);
  } catch {
    return null;
  }
}

/**
 * Marks one still-running agent as planned-restart: agent-level interrupted
 * record (git, excerpt) plus the scope flag when the checkpoint has a task.
 * Clears the open-turn tracking so the boot check after the restart keeps this
 * reason. Returns the mark ({agentId, scopeId}) or null when the scope is gone.
 */
export async function markPlannedRestart({ client, paseoState, agentId, at, git = null, readExcerpt = null, readGit = null, lock = undefined }) {
  const agent = (paseoState?.agents ?? []).find((a) => a.id === agentId) ?? null;
  const scopeId = agent?.labels?.[LABEL.scope] ?? null;
  if (typeof scopeId !== 'string' || !scopeId) return null;
  const scope = listScopes(paseoState).find((s) => s.id === scopeId) ?? null;
  if (!scope) return null;
  const mainId = scope.workspaceId;
  const excerpt = readExcerpt
    ? await readExcerpt(agentId).catch(() => null)
    : await defaultReadExcerpt(client, agentId);
  const snapshot = readGit
    ? await Promise.resolve(readGit(scope)).catch(() => null)
    : defaultReadGit(git, scope.directory ?? null);
  const entry = scope.workspace?.metadata?.[AGENTS_KEY]?.[agentId] ?? null;
  const interrupted = buildRestartInterrupted({
    at, reason: 'planned-restart', error: 'planned restart: drain timeout', excerpt, git: snapshot,
  });
  const patch = {
    lastTurnId: entry?.openTurnId ?? entry?.lastTurnId ?? null,
    lastTurnEndedAt: at,
    outcome: 'canceled',
    openTurnId: null,
    turnStartedAt: null,
    interrupted,
  };
  const lockArg = lock === undefined ? {} : { lock };
  await updateAgentEntry({ client, workspaceId: mainId, agentId, patch, ...lockArg });
  const checkpoint = scope.workspace?.metadata?.[CHECKPOINT_KEY] ?? null;
  if (checkpoint && typeof checkpoint.task === 'string' && checkpoint.task.trim() !== '') {
    await flagCheckpointInterrupted({ client, workspaceId: mainId, agentId, at, reason: 'planned-restart', ...lockArg }).catch(() => null);
  }
  return { agentId, scopeId };
}

/**
 * Waits until no factory agent is running or the timeout expires. On timeout
 * the remaining agents are marked planned-restart. Returns {clean, waitedMs,
 * timeoutMs, running, marked, initial}: clean means safe to restart (exit 0),
 * otherwise exit 2. All I/O is injectable for tests. While it waits, a
 * `wsf.drain` marker in every scope's main workspace keeps supervision wakes
 * quiet; the marker is cleared when drain ends, whatever the outcome (an
 * uncleared marker self-expires timeoutAt + 1 min).
 */
export async function drain({
  client, timeoutMs = DRAIN_DEFAULT_TIMEOUT_MS, pollMs = DRAIN_POLL_MS,
  now = () => Date.now(), sleep = null, readState = null, git = null,
  readExcerpt = null, readGit = null, lock = undefined, log = null, pid = process.pid,
} = {}) {
  const started = now();
  const stateOf = readState ?? (() => readPaseoState(client));
  let state = await stateOf();
  let running = factoryRunningAgents(state);
  const initial = running;
  if (!running.length) {
    return { clean: true, waitedMs: 0, timeoutMs, running: [], marked: [], initial: [] };
  }
  const marker = buildDrainMarker({
    startedAt: new Date(started).toISOString(),
    timeoutAt: new Date(started + timeoutMs).toISOString(),
    pid: pid ?? null,
  });
  const lockArg = lock === undefined ? {} : { lock };
  const workspaceIds = [...new Set(listScopes(state).map((s) => s.workspaceId).filter((id) => typeof id === 'string' && id))];
  for (const workspaceId of workspaceIds) {
    try {
      await setDrainMarker({ client, workspaceId, marker, ...lockArg });
    } catch (error) {
      if (typeof log === 'function') log(`drain: marker not written in ${workspaceId} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  try {
    const deadline = started + timeoutMs;
    while (now() < deadline) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleepMs(Math.min(pollMs, remaining), sleep);
      state = await stateOf();
      running = factoryRunningAgents(state);
      if (!running.length) {
        return { clean: true, waitedMs: now() - started, timeoutMs, running: [], marked: [], initial };
      }
      if (typeof log === 'function') log(`drain: ${running.length} factory agent(s) still running`);
    }
    const at = new Date(now()).toISOString();
    const marked = [];
    for (const agent of running) {
      try {
        const mark = await markPlannedRestart({
          client, paseoState: state, agentId: agent.id, at, git,
          ...(readExcerpt ? { readExcerpt: (id) => readExcerpt(id) } : {}),
          ...(readGit ? { readGit: (scope) => readGit(scope) } : {}),
          ...lockArg,
        });
        if (mark) marked.push(mark);
      } catch {
        continue;
      }
    }
    marked.sort((a, b) => a.agentId.localeCompare(b.agentId));
    return { clean: false, waitedMs: now() - started, timeoutMs, running, marked, initial };
  } finally {
    for (const workspaceId of workspaceIds) {
      try {
        await clearDrainMarker({ client, workspaceId, marker, ...lockArg });
      } catch {
        // A leftover marker self-expires (timeoutAt + 1 min), so a failed
        // clear must never mask the drain result.
      }
    }
  }
}
