// @ts-nocheck
// GENERATED from src/supervision.mjs by npm run plugin:sync. Do not edit.
// Worker supervision core (S-A): the wsf.workers register plus pure rules for
// state transitions, wake planning, failover and escalation. Pure functions
// have no IO so the plugin (S-B) reuses them through plugin-sync; register
// writes go through the workspace lock like checkpoints (see agent-state.mjs).
import { isDeepStrictEqual } from 'node:util';
import { LABEL, METADATA_KEY } from './paseo.js';
import { withLock, workspaceLockName } from './lock.js';

export const WORKERS_KEY = `${METADATA_KEY}.workers`;
export const WORKER_STATES = ['running', 'done', 'partial', 'blocked', 'interrupted', 'stale'];
export const WORKER_EVENTS = ['created', 'adopted', 'checkpoint-done', 'checkpoint-none', 'checkpoint-partial', 'checkpoint-blocked', 'advisor-request', 'turn-no-checkpoint', 'turn-failed', 'turn-canceled', 'restart-daemon', 'restart-planned', 'stale', 'reassigned', 'archived'];
export const TASK_MAX = 300;
export const WORKERS_MAX = 100;
export const SUPERVISION_DEFAULTS = { batchMinutes: 0, wakeDebounceSeconds: 20, watchdogMinutes: 15, staleMinutes: 60, answerMinutes: 10, maxAutoResumes: 2 };

/** State transition table from docs/supervision-design.md; `archived` removes the entry (null). `stale` is handled in nextWorkerState (running only). */
const TRANSITIONS = {
  created: 'running',
  adopted: 'running',
  'checkpoint-done': 'done',
  'checkpoint-none': 'done',
  'checkpoint-partial': 'partial',
  'checkpoint-blocked': 'blocked',
  'advisor-request': 'blocked',
  'turn-no-checkpoint': 'interrupted',
  'turn-failed': 'interrupted',
  'turn-canceled': 'interrupted',
  'restart-daemon': 'interrupted',
  'restart-planned': 'interrupted',
  reassigned: 'running',
  archived: null,
};

export function nextWorkerState(state, event) {
  if (event === 'stale') return state === 'running' ? 'stale' : state;
  if (!(event in TRANSITIONS)) throw new Error(`Unknown worker event ${JSON.stringify(event)} (expected one of ${WORKER_EVENTS.join(', ')})`);
  return TRANSITIONS[event];
}

/** `- status:` value an event stores; null keeps the previous status (only CHECKPOINT and ADVISOR-REQUEST events set it). */
export function statusForEvent(event) {
  if (event === 'checkpoint-done' || event === 'checkpoint-none') return 'done';
  if (event === 'checkpoint-partial') return 'partial';
  if (event === 'checkpoint-blocked' || event === 'advisor-request') return 'blocked';
  return null;
}

/**
 * Maps a turn end to a register event. Failed/canceled turns are `interrupted`
 * even with a CHECKPOINT; an ADVISOR-REQUEST wins over the block; a CHECKPOINT
 * without a status line counts as done. `status` is the parsed `- status:` value or null.
 */
export function turnEndEvent({ outcome = 'completed', hasCheckpoint = false, status = null, advisorRequest = false } = {}) {
  if (outcome === 'failed') return 'turn-failed';
  if (outcome === 'canceled') return 'turn-canceled';
  if (advisorRequest) return 'advisor-request';
  if (!hasCheckpoint) return 'turn-no-checkpoint';
  if (status === 'partial') return 'checkpoint-partial';
  if (status === 'blocked') return 'checkpoint-blocked';
  return status === null || status === undefined ? 'checkpoint-none' : 'checkpoint-done';
}

/** Restart mark reason to register event; null for anything else (never throws). */
export function eventForRestartReason(reason) {
  if (reason === 'daemon-restart') return 'restart-daemon';
  if (reason === 'planned-restart') return 'restart-planned';
  return null;
}

/** Task excerpt: single line, clipped to TASK_MAX, never rejected. */
export function clipTask(task) {
  const text = String(task ?? '').trim().replace(/\s+/g, ' ');
  return text.length > TASK_MAX ? text.slice(0, TASK_MAX) : text;
}

/** Lenient entry bounds (clip, never reject): valid state, known status, non-negative resumes. */
export function clipWorkerEntry(entry) {
  const clipped = { ...entry };
  clipped.task = clipTask(clipped.task);
  if (!WORKER_STATES.includes(clipped.state)) clipped.state = 'running';
  if (!['done', 'partial', 'blocked'].includes(clipped.status)) clipped.status = null;
  if (!Number.isInteger(clipped.resumes) || clipped.resumes < 0) clipped.resumes = 0;
  return clipped;
}

export function createWorkerEntry({ task = '', startedBy = null, startedAt = null, epoch = null, state = 'running', status = null, now = () => new Date().toISOString() } = {}) {
  return clipWorkerEntry({
    task: clipTask(task),
    startedBy: startedBy ?? null,
    startedAt: startedAt ?? now(),
    epoch: epoch ?? null,
    state,
    status: status ?? null,
    resumes: 0,
    lastWakeAt: null,
    pendingWake: null,
  });
}

/** Register map from workspace metadata (a copy); {} when missing or malformed. */
export function readWorkers(metadata) {
  const map = metadata?.[WORKERS_KEY];
  return map && typeof map === 'object' && !Array.isArray(map) ? { ...map } : {};
}

/** True for every state except `done`: the entries supervision still shows. */
export function isOpenWorkerState(state) {
  return state !== 'done';
}

/** Register entries with their id, sorted by id for deterministic output. */
export function workersReport(register) {
  return Object.entries(register ?? {})
    .filter(([, entry]) => entry && typeof entry === 'object')
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Open entries (all but `done`) with task and state for status/resume/handoff. */
export function openWorkers(register) {
  return workersReport(register).filter((entry) => isOpenWorkerState(entry.state));
}

/**
 * Bounded register: oldest `done` entries go first, then the oldest entries
 * overall. Deterministic (startedAt, then id); returns a new map.
 */
export function pruneWorkers(register, max = WORKERS_MAX) {
  const ids = Object.keys(register ?? {});
  if (ids.length <= max) return { ...(register ?? {}) };
  const byAge = ids
    .map((id) => ({ id, at: register[id]?.startedAt ?? '' }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
  const drop = new Set();
  for (const { id } of byAge) {
    if (ids.length - drop.size <= max) break;
    if (register[id]?.state === 'done') drop.add(id);
  }
  for (const { id } of byAge) {
    if (ids.length - drop.size <= max) break;
    drop.add(id);
  }
  const next = { ...register };
  for (const id of drop) delete next[id];
  return next;
}

/**
 * Pure read-modify step for one register entry: applies the event (state,
 * status, resumes reset on `reassigned`, task/epoch refresh on
 * created/adopted/reassigned), clips bounds and prunes. Unknown entries start
 * from the event (created/adopted carry task/startedBy/epoch in details).
 */
export function applyWorkerEvent(register, workerId, event, details = {}) {
  const next = { ...(register ?? {}) };
  if (event === 'archived') {
    delete next[workerId];
    return next;
  }
  const current = next[workerId] ?? null;
  const state = nextWorkerState(current?.state ?? 'running', event);
  if (!current) {
    next[workerId] = clipWorkerEntry(createWorkerEntry({
      task: details.task ?? '',
      startedBy: details.startedBy ?? null,
      startedAt: details.startedAt ?? details.now ?? new Date().toISOString(),
      epoch: details.epoch ?? null,
      state,
      status: statusForEvent(event),
    }));
    return pruneWorkers(next);
  }
  const entry = { ...current, state };
  const status = statusForEvent(event);
  if (status !== null) entry.status = status;
  if ((event === 'created' || event === 'adopted') && details.task) entry.task = clipTask(details.task);
  if (event === 'reassigned') {
    entry.resumes = 0;
    if (details.task !== undefined) entry.task = clipTask(details.task);
    if (details.epoch !== undefined) entry.epoch = details.epoch;
    if (details.startedBy !== undefined) entry.startedBy = details.startedBy;
  }
  next[workerId] = clipWorkerEntry(entry);
  return pruneWorkers(next);
}

/** One automatic continuation in the current assignment (escalation counter input). */
export function recordResume(entry) {
  return { ...entry, resumes: (Number.isInteger(entry?.resumes) ? entry.resumes : 0) + 1 };
}

/** Queues a wake event during the short debounce window. */
export function queuePendingWake(entry, { state, queuedAt }) {
  return { ...entry, pendingWake: { state, queuedAt } };
}

/** Pending batched wakes, sorted by worker id. */
export function collectPendingWakes(register) {
  return workersReport(register)
    .filter((entry) => entry.pendingWake && typeof entry.pendingWake === 'object')
    .map((entry) => ({ workerId: entry.id, state: entry.pendingWake.state ?? entry.state, queuedAt: entry.pendingWake.queuedAt ?? null }));
}

/** Marks a wake as sent (sets lastWakeAt, clears the pending event by default). */
export function markWakeSent(entry, { at, clearPending = true } = {}) {
  return { ...entry, lastWakeAt: at, pendingWake: clearPending ? null : entry.pendingWake };
}

/**
 * Watchdog rule: a `running` entry whose worker was last active beyond
 * staleMinutes goes `stale`. Fails closed (no mark without both timestamps).
 */
export function shouldMarkStale({ entry, nowMs, lastActiveMs, staleMinutes = SUPERVISION_DEFAULTS.staleMinutes } = {}) {
  if (entry?.state !== 'running') return false;
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastActiveMs)) return false;
  return nowMs - lastActiveMs > staleMinutes * 60_000;
}

/** Idle cleanup (C5) skips agents whose register state is running, blocked or interrupted. Accepts a state or an entry. */
export function isCleanupProtected(stateOrEntry) {
  const state = typeof stateOrEntry === 'string' ? stateOrEntry : stateOrEntry?.state;
  return state === 'running' || state === 'blocked' || state === 'interrupted';
}

/**
 * Ignore rule: an agent is ignored only when archived or without a scope
 * assignment. `closed` is never ignored (a restart closes live agents too).
 */
export function isIgnoredAgent(agent) {
  if (!agent || typeof agent !== 'object') return true;
  if (agent.archivedAt) return true;
  const scope = agent.labels?.[LABEL.scope];
  return !(typeof scope === 'string' && scope.trim());
}

/** Never woken or escalated: ignored agents plus `background` agents. */
export function canWakeAgent(agent) {
  if (isIgnoredAgent(agent)) return false;
  return agent.background !== true;
}

/** Every worker outcome needs attention; only simultaneous outcomes debounce. */
export function isImmediateWakeState(state) {
  return state === 'done' || state === 'partial' || state === 'blocked' || state === 'interrupted' || state === 'stale';
}

/** True when the debounce window has passed (or no wake was ever sent). */
export function isBatchDue({ nowMs, lastWakeAt, batchMinutes = SUPERVISION_DEFAULTS.batchMinutes, wakeDebounceSeconds = SUPERVISION_DEFAULTS.wakeDebounceSeconds } = {}) {
  if (!lastWakeAt) return true;
  const last = Date.parse(lastWakeAt);
  if (!Number.isFinite(last)) return true;
  const now = typeof nowMs === 'string' ? Date.parse(nowMs) : nowMs;
  if (!Number.isFinite(now)) return true;
  const windowMs = wakeDebounceSeconds > 0 ? wakeDebounceSeconds * 1_000 : batchMinutes * 60_000;
  return now - last >= windowMs;
}

/** Quiet periods: no wakes while `drain` runs or before the boot check finished. */
export function isQuietPeriod({ draining = false, bootCheckDone = true } = {}) {
  return draining === true || bootCheckDone !== true;
}

/**
 * One wake decision: `immediate` (window due), `defer` (inside the debounce
 * window) or `skip` (ineligible/quiet). Pure; the
 * caller resolves the target at send time and delivers the text.
 */
export function planWake({ agent, newState, nowMs = Date.now(), lastWakeAt = null, batchMinutes = SUPERVISION_DEFAULTS.batchMinutes, wakeDebounceSeconds = SUPERVISION_DEFAULTS.wakeDebounceSeconds, draining = false, bootCheckDone = true } = {}) {
  if (!canWakeAgent(agent)) return { action: 'skip', reason: 'ineligible' };
  if (isQuietPeriod({ draining, bootCheckDone })) return { action: 'skip', reason: draining === true ? 'drain' : 'boot' };
  if (!isImmediateWakeState(newState)) return { action: 'skip', reason: 'not-actionable' };
  if (isBatchDue({ nowMs, lastWakeAt, batchMinutes, wakeDebounceSeconds })) return { action: 'immediate', reason: newState };
  return { action: 'defer', reason: 'debounce-window' };
}

/**
 * Wake target at send time: the single live holder of the scope's active slot.
 * Null when the slot is empty or ambiguous (no wake; failover decides next).
 * Closed or interrupted holders stay eligible (a wake reopens them).
 */
export function resolveWakeTarget(scopeState, steers) {
  const slot = scopeState?.activeSteer;
  if (typeof slot !== 'string' || !slot) return null;
  const holders = (steers ?? []).filter((s) => s && s.slot === slot && !s.archivedAt && !s.retired);
  return holders.length === 1 ? (holders[0].id ?? null) : null;
}

/** Wake text from the design; null without events (nothing to say). */
export function formatWakeMessage({ scopeId, epoch, events, factoryCmd = 'paseo-factory' } = {}) {
  if (!events?.length) return null;
  const parts = events.map((e) => `worker ${e.workerId} ${e.state}`).join('; ');
  return `[factory] Scope ${scopeId}, epoch ${epoch}: ${parts}.\nRun \`${factoryCmd} resume\` (or \`workers\`) and continue. Ignore if your epoch is newer.`;
}

/** A steer ignores a wake whose epoch is older than the current one. */
export function isStaleWake(wakeEpoch, currentEpoch) {
  return Number.isInteger(wakeEpoch) && Number.isInteger(currentEpoch) && wakeEpoch < currentEpoch;
}

/**
 * Failover candidate chain after an unanswered wake: the next live steers of
 * the scope in slot order (circular after the failed active slot, skipping
 * retired/archived/interrupted/advisor ones), then the domain steer, then the
 * hub steer. Domain/hub entries are { steerId, scopeId } or null when absent;
 * an advisor on domain or hub level is skipped like any advisor id.
 */
export function failoverChain({ steers = [], activeSlot = null, retiredIds = [], interruptedIds = [], advisorIds = [], domainSteer = null, hubSteer = null, failingPool = null } = {}) {
  const retired = new Set(retiredIds ?? []);
  const interrupted = new Set(interruptedIds ?? []);
  const advisors = new Set(advisorIds ?? []);
  const live = (steers ?? [])
    .filter((s) => s && s.slot !== activeSlot && !s.archivedAt && !s.retired && !s.advisor && !retired.has(s.id) && !interrupted.has(s.id) && !s.interrupted && !advisors.has(s.id))
    .sort((a, b) => String(a.slot).localeCompare(String(b.slot)));
  const ordered = typeof activeSlot === 'string' && activeSlot
    ? [...live.filter((s) => String(s.slot) > activeSlot), ...live.filter((s) => String(s.slot) <= activeSlot)]
    : live;
  if (failingPool) {
    const differentPool = ordered.filter((candidate) => (candidate.pool ?? candidate.provider) !== failingPool);
    const samePool = ordered.filter((candidate) => (candidate.pool ?? candidate.provider) === failingPool);
    if (differentPool.length) ordered.splice(0, ordered.length, ...differentPool, ...samePool);
    ordered.sort((a, b) => Number((a.pool ?? a.provider) === failingPool) - Number((b.pool ?? b.provider) === failingPool)
      || String(a.slot).localeCompare(String(b.slot)));
  }
  const chain = ordered.map((s) => ({ kind: 'steer', slot: s.slot, steerId: s.id }));
  if (domainSteer?.steerId && !advisors.has(domainSteer.steerId)) chain.push({ kind: 'domain', steerId: domainSteer.steerId, scopeId: domainSteer.scopeId ?? null });
  if (hubSteer?.steerId && !advisors.has(hubSteer.steerId)) chain.push({ kind: 'hub', steerId: hubSteer.steerId, scopeId: hubSteer.scopeId ?? null });
  return chain;
}

/**
 * Escalation counter: the steer continues the worker while resumes stay below
 * maxAutoResumes, then consults an advisor, then escalates with `domain:` and
 * `hub:` blockers; the user (`user:`) is the last resort.
 */
export function escalationStep({ resumes = 0, maxAutoResumes = SUPERVISION_DEFAULTS.maxAutoResumes, advisorDone = false, domainDone = false, hubDone = false } = {}) {
  if (resumes < maxAutoResumes) return 'resume';
  if (!advisorDone) return 'advisor';
  if (!domainDone) return 'domain';
  if (!hubDone) return 'hub';
  return 'user';
}

export function describeEscalation(step) {
  if (step === 'resume') return 'continue the worker with the resume brief';
  if (step === 'advisor') return 'consult an advisor (paseo-advisor skill), then continue or reassign';
  if (step === 'domain') return 'escalate with a domain: blocker to the domain steer';
  if (step === 'hub') return 'escalate with a hub: blocker to the hub steer';
  return 'ask the user with a user: blocker (last resort)';
}

/**
 * Locked read-modify-write of one register entry (event or shallow patch),
 * bounded and verified by re-reading. Returns the entry, or null when the
 * event removed it (`archived`) or a patch removed it (`{ remove: true }`).
 */
export async function updateWorkerEntry({ client, workspaceId, workerId, patch = null, event = null, eventDetails = {}, lock = withLock }) {
  if (!workerId) throw new Error('updateWorkerEntry needs a workerId');
  if (event === null && patch === null) throw new Error('updateWorkerEntry needs an event or a patch');
  const workspace = client.workspaces.ref(workspaceId);
  return lock(workspaceLockName(workspaceId), async (held) => {
    const metadata = (await workspace.refresh())?.metadata ?? {};
    let state = { ...(metadata[WORKERS_KEY] ?? {}) };
    if (event !== null) {
      state = applyWorkerEvent(state, workerId, event, eventDetails);
    } else if (patch.remove === true) {
      delete state[workerId];
    } else {
      const { remove: _remove, ...rest } = patch;
      const base = state[workerId] ?? createWorkerEntry({});
      state[workerId] = clipWorkerEntry({ ...base, ...rest });
      state = pruneWorkers(state);
    }
    held.verify(); // the lock file must still be the locked inode right before the write
    await workspace.setMetadata({ [WORKERS_KEY]: state });
    const written = (await workspace.refresh())?.metadata?.[WORKERS_KEY] ?? null;
    if (!isDeepStrictEqual(written, state)) throw new Error(`Worker register not verifiable after write in workspace ${workspaceId}`);
    return written[workerId] ?? null;
  });
}

/** Registers a worker as `running` (created by a scope steer or adopted). */
export async function registerWorker({ client, workspaceId, workerId, task = '', startedBy = null, epoch = null, lock = withLock, now = () => new Date().toISOString() }) {
  return updateWorkerEntry({ client, workspaceId, workerId, event: 'created', eventDetails: { task, startedBy, epoch, startedAt: now() }, lock });
}

/** Removes the entry of an archived worker. */
export async function removeWorker({ client, workspaceId, workerId, lock = withLock }) {
  return updateWorkerEntry({ client, workspaceId, workerId, event: 'archived', lock });
}

/** Human-readable register for `workers [scope]`: header plus one line per entry, deterministic. */
export function formatWorkersText(scopeId, epoch, entries) {
  const list = entries ?? [];
  const open = list.filter((e) => isOpenWorkerState(e.state)).length;
  const head = `Workers of ${scopeId} · epoch ${epoch ?? '-'} · ${open} open / ${list.length} total`;
  if (!list.length) return `${head}\n(no supervised workers)`;
  return [head, ...list.map((e) => {
    const parts = [`- ${e.id} ${e.state} "${clipTask(e.task) || '(no task)'}"`, `started by ${e.startedBy ?? '?'} epoch ${e.epoch ?? '?'}`, `resumes ${e.resumes ?? 0}`];
    if (e.status) parts.push(`status ${e.status}`);
    if (e.lastWakeAt) parts.push(`last wake ${e.lastWakeAt}`);
    if (e.pendingWake) parts.push('pending wake');
    return parts.join(' · ');
  })].join('\n');
}
