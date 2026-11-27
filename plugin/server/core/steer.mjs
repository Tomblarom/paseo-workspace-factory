// Active-steer state, task checkpoints, steer switching and same-slot refresh.
// Factory-owned state lives in three workspace metadata keys of the main workspace:
//   wsf                { main, activeSteer, epoch, previousSteer?, switchedAt? }
//   wsf.checkpoint     { task, tests[], blockers[], next?, epoch, updatedAt,
//                        source, agentId?, turnId?, capturedAt, interrupted? }
//   wsf.agents         { <agentId>: per-agent turn/note/interrupt records } (see agent-state.mjs)
// previousSteer is the preceding slot letter, including same-slot replacement.
// Paseo has no compare-and-set for metadata, so writes from factory processes are
// serialized by a per-workspace flock on this host; agents, the UI and other hosts
// are not blocked. Between held.verify() and the daemon write remains a short
// window in which a replaced lock file is not noticed.
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { LABEL, METADATA_KEY, parentOf, readPaseoAgents, agentUsage, isRestartReason, restartMessage } from './paseo.mjs';
import { LockBusy, retryOnLockBusy, withLock, workspaceLockName } from './lock.mjs';
import { discoveryScopeAliases, guardScope, scopeHolder, ScopeGuardError } from './scope-guard.mjs';
import { runtime } from './runtime.mjs';
import { isAdvisorSlot, isAdvisorSteer, providerIsSensitive, steerPrivacyAdmission } from './config.mjs';
import { resolveProfile, steerFallbackList, usedProfilesByLiveSteers } from './models.mjs';
import { buildSteerCreate, checkedCreationReceipt, confirmCreationReceipt, idempotencyKey, lookupCreation, profileAgentConfig, requestDigest, shortHolderId, verifyCreatedAgent } from './steer-create.mjs';
import { createExecutors } from './apply.mjs';
import { resolveScope, scopeToEntry, sameScopeId, domainOfScope } from './scope.mjs';
import { STEER_TITLE, activeMarker, discoveredRepoPublic, liveSlotHolders, markSteerTitle, stripActiveMarker } from './discovery.mjs';
import { AGENTS_KEY, currentFreshHint, updateAgentEntry } from './agent-state.mjs';
import { parseCheckpointBlock } from '../../shared/checkpoint-block.mjs';
import { CHECKPOINT_NEXT_TEXT, WORKERS_KEY, checkpointNextStep, clipTask, collectPendingWakes, openWorkers as openRegisterWorkers, readWorkers } from './supervision.mjs';
import { QUOTA_DEFAULTS, formatQuotaLine } from './quota.mjs';
import { readRewindPoint, rewindAndBrief } from './rewind.mjs';
import { findingsPassage } from './findings.mjs';
import { readSteerAction, readStagedSteerBrief, readCleanupAction, readEffectReceipt, effectReceiptKey, actionEntry, newSteerAction, reconcileSteerSend, unsettledAccountMove } from './steer-action.mjs';
import { actionFact } from './action-facts.mjs';
import { freshCreationRoute, freshLiveRoute } from './fresh-route.mjs';
import { routeMatchesIntent } from './routing.mjs';
import { ACCOUNT_METADATA_KEY } from './zerosub.mjs';
import { finishWorkerHandover, planWorkerHandover } from './workers.mjs';
import { createGit, readCheckpointGit } from './local.mjs';

export const CHECKPOINT_KEY = `${METADATA_KEY}.checkpoint`;
// Worker efficiency rule, same wording as the Worker instructions block in docs/steer-instructions.md.
export const WORKER_EFFICIENCY_LINE = '- Run tests/builds with a quiet reporter, show only failures; write long logs to a file and give the path.';
export class SwitchRefused extends Error {}
async function guardSteerScope(args) {
  try { return await guardScope(args); }
  catch (error) {
    if (error instanceof ScopeGuardError) throw new SwitchRefused(`Steer state changed: ${error.message}`);
    throw error;
  }
}
export { agentUsage };

const BUSY = new Set(['running', 'initializing']);

/**
 * Restart interruptions (P2) from the scope flag and the agent-level records:
 * every entry whose interrupted reason is daemon-restart or planned-restart.
 * Sorted by agent id for deterministic output. Heuristic guesses are added by
 * the caller (steerStatus, scopeRows, buildResumeBrief) with heuristic: true.
 */
export function restartInterruptions({ checkpoint = null, agentState = null } = {}) {
  const out = [];
  const seen = new Set();
  const agents = agentState && typeof agentState === 'object' ? agentState : {};
  for (const [agentId, entry] of Object.entries(agents)) {
    const reason = entry?.interrupted?.reason;
    if (isRestartReason(reason) && !seen.has(agentId)) {
      seen.add(agentId);
      out.push({ agentId, reason, at: entry.interrupted.at ?? null, heuristic: false });
    }
  }
  const flag = checkpoint?.interrupted;
  if (flag && typeof flag === 'object' && isRestartReason(flag.reason) && typeof flag.agentId === 'string' && flag.agentId && !seen.has(flag.agentId)) {
    seen.add(flag.agentId);
    out.push({ agentId: flag.agentId, reason: flag.reason, at: flag.at ?? null, heuristic: false });
  }
  out.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return out;
}

/**
 * Heuristic restart guess without the plugin (P2): the daemon started after
 * the last CHECKPOINT, the agent is idle, and its last turn carried no
 * CHECKPOINT block. Fails closed on missing or unparsable input: unknown
 * last-turn state (null/undefined) never marks.
 */
export function isHeuristicRestart({ daemonStartedAt, checkpointAt, agentStatus, lastTurnHadCheckpoint }) {
  if (agentStatus !== 'idle') return false;
  if (lastTurnHadCheckpoint !== false) return false;
  if (typeof daemonStartedAt !== 'string' || !daemonStartedAt) return false;
  if (typeof checkpointAt !== 'string' || !checkpointAt) return false;
  const daemonMs = Date.parse(daemonStartedAt);
  const cpMs = Date.parse(checkpointAt);
  if (!Number.isFinite(daemonMs) || !Number.isFinite(cpMs)) return false;
  return daemonMs > cpMs;
}

/**
 * Resolves a status/checkpoint/switch/fresh/workers target through the live
 * scopes. Unknown addresses pass through unchanged for legacy discovery;
 * ambiguous ones throw ScopeConflict. Resolved github scopes map back to
 * their owner/repo locator, so github behavior is unchanged.
 */
export function resolveTargetEntry(address, paseoState) {
  const scope = resolveScope(address, paseoState);
  if (!scope) return { entry: address, scope: null, deprecatedAlias: false };
  return { entry: scopeToEntry(scope), scope, deprecatedAlias: scope.deprecatedAlias === true };
}

export function steerStatus(discovery, { warnContextTokens, daemonStartedAt = null, lastTurnCheckpoints = null, config = null } = {}) {
  const main = discovery.mainWorkspace;
  const liveIds = new Set([...discovery.steers.labelled, ...discovery.workers].filter((agent) => !agent.archivedAt).map((agent) => agent.id));
  const rawState = main?.metadata?.[METADATA_KEY];
  const state = rawState ? {
    main: rawState.main, activeSteer: rawState.activeSteer,
    ...(liveIds.has(rawState.activeAgentId) ? { activeAgentId: rawState.activeAgentId } : {}),
    epoch: rawState.epoch, scope: rawState.scope, switchedAt: rawState.switchedAt,
    ...(/^[A-Z]$/.test(rawState.previousSteer ?? '') ? { previousSteer: rawState.previousSteer } : {}),
  } : null;
  const rawCheckpoint = main?.metadata?.[CHECKPOINT_KEY];
  const agentState = main?.metadata?.[AGENTS_KEY] ?? null;
  const checkpoint = rawCheckpoint ? {
    ...rawCheckpoint,
    ...(rawCheckpoint.agentId && !liveIds.has(rawCheckpoint.agentId) ? { agentId: null } : {}),
    ...(rawCheckpoint.interrupted?.agentId && !liveIds.has(rawCheckpoint.interrupted.agentId) ? { interrupted: null } : {}),
  } : null;
  const marked = restartInterruptions({ checkpoint, agentState }).filter(({ agentId }) => liveIds.has(agentId));
  const markedIds = new Set(marked.map((m) => m.agentId));
  const checkpointAt = checkpoint?.capturedAt ?? checkpoint?.updatedAt ?? null;
  const heuristicIds = new Set();
  if (daemonStartedAt && lastTurnCheckpoints && typeof lastTurnCheckpoints === 'object' && checkpointAt) {
    for (const a of [...(discovery.steers.labelled ?? []), ...(discovery.workers ?? [])]) {
      if (!a || a.archivedAt || markedIds.has(a.id)) continue;
      if (a.continuedFrom && markedIds.has(a.continuedFrom)) continue;
      if (isHeuristicRestart({ daemonStartedAt, checkpointAt, agentStatus: a.status, lastTurnHadCheckpoint: lastTurnCheckpoints[a.id] })) {
        heuristicIds.add(a.id);
      }
    }
  }
  const heuristic = [...heuristicIds].sort().map((agentId) => ({ agentId, reason: 'daemon-restart', at: null, heuristic: true }));
  const restartInterrupted = [...marked, ...heuristic].sort((a, b) => a.agentId.localeCompare(b.agentId));
  const withInterruption = (id) => {
    const record = agentState?.[id]?.interrupted ?? null;
    if (record && typeof record === 'object') return { interrupted: record, reason: record.reason ?? null };
    if (heuristicIds.has(id)) return { interrupted: { reason: 'daemon-restart', heuristic: true, at: null }, reason: 'daemon-restart' };
    return {};
  };
  const steers = discovery.steers.labelled
    .filter((a) => !a.archivedAt)
    .map((a) => ({ slot: a.labels[LABEL.slot], id: a.id, title: a.title, provider: a.provider, model: a.model, status: a.status, parent: parentOf(a), workspaceId: a.workspaceId, usage: agentUsage(a), superseded: a.superseded === true, ...(a.continuedFrom ? { continuedFrom: a.continuedFrom } : {}), ...(config || a.labels[LABEL.steerRole] !== undefined || a.metadata?.[LABEL.steerRole] !== undefined ? { advisor: isAdvisorSteer(config, a.labels, a.metadata), sensitive: providerIsSensitive(config, a.provider) } : {}), ...withInterruption(a.id) }))
    .sort((a, b) => a.slot.localeCompare(b.slot));
  const steerById = new Map(steers.map((s) => [s.id, s]));
  // Unlabelled steer candidates by id (lettered and digit-titled): a worker
  // whose parent is such a candidate names it instead of "Steer ?".
  const candidateById = new Map();
  for (const a of [...(discovery.steers.legacy ?? []), ...(discovery.steers.digitCandidates ?? [])]) {
    if (a.archivedAt) continue;
    candidateById.set(a.id, {
      id: a.id, title: a.title ?? null,
      slot: (a.title ?? '').trim().match(STEER_TITLE)?.[1] ?? null,
    });
  }
  const workerRegister = Object.fromEntries(Object.entries(readWorkers(main?.metadata ?? null)).filter(([id]) => liveIds.has(id)));
  const workers = discovery.workers.filter((agent) => !agent.archivedAt).map((w) => {
    const parent = parentOf(w);
    return {
      id: w.id, title: w.title, provider: w.provider, model: w.model, status: w.status, cwd: w.cwd,
      parentSlot: (parent && steerById.get(parent)?.slot) ?? null, parent, usage: agentUsage(w),
      parentCandidate: parent && !steerById.has(parent) ? (candidateById.get(parent) ?? null) : null,
      workspaceId: w.workspaceId ?? null, owner: w.labels?.[LABEL.owner] ?? null,
      hasAssignment: Boolean(clipTask(workerRegister[w.id]?.task)),
      ...(w.continuedFrom ? { continuedFrom: w.continuedFrom } : {}),
      ...(w.parentContinuedFrom ? { parentContinuedFrom: w.parentContinuedFrom } : {}),
      ...withInterruption(w.id),
    };
  });
  const candidates = [...(discovery.steers.legacy ?? []), ...(discovery.steers.digitCandidates ?? [])].filter((agent) => !agent.archivedAt).map((a) => ({
    id: a.id, title: a.title ?? null, slot: (a.title ?? '').trim().match(STEER_TITLE)?.[1] ?? null,
    provider: a.provider, model: a.model, status: a.status, parent: parentOf(a), usage: agentUsage(a),
  }));
  const usageWarnings = [];
  if (Number.isInteger(warnContextTokens) && warnContextTokens > 0) {
    for (const s of steers) {
      if (s.usage && s.usage.usedTokens > warnContextTokens) usageWarnings.push({ kind: 'steer', slot: s.slot, id: s.id, usedTokens: s.usage.usedTokens, maxTokens: s.usage.maxTokens });
    }
    for (const w of workers) {
      if (w.usage && w.usage.usedTokens > warnContextTokens) usageWarnings.push({ kind: 'worker', slot: null, id: w.id, usedTokens: w.usage.usedTokens, maxTokens: w.usage.maxTokens });
    }
  }
  // Domain role: the stored pointer wins (a planned --domain is not status).
  const domain = domainOfScope(state?.scope) ?? domainOfScope(discovery.scope) ?? null;
  const domainChildren = (discovery.liveScopes ?? []).filter((s) => sameScopeId(s.domain, discovery.forkName)).map((s) => s.id);
  const warnings = [];
  if (config) {
    // K13: no expected-model drift warnings (the live model is authoritative).
    if (steers.some((s) => s.slot === state?.activeSteer && s.advisor)) {
      warnings.push(`Active Steer ${state.activeSteer} is an advisor; advisors never coordinate`);
    }
  }
  return {
    repo: discovery.forkName,
    domain,
    domainChildren,
    workspace: main ? { id: main.id, title: main.title ?? main.name, directory: main.workspaceDirectory } : null,
    // Adopted worktree workspaces carry the same steer state; the flag only
    // tells status consumers where the main workspace lives.
    worktree: discovery.worktree ? { workspaceId: discovery.worktree.workspaceId ?? main?.id ?? null, directory: discovery.worktree.directory ?? main?.workspaceDirectory ?? null } : null,
    state,
    checkpoint,
    steers,
    workers,
    openWorkers: openRegisterWorkers(workerRegister),
    pendingWorkerWakeCount: collectPendingWakes(workerRegister).length,
    candidates,
    usageWarnings,
    ...(config ? { warnings } : {}),
    ...(restartInterrupted.length ? { restartInterrupted } : {}),
  };
}

/** Branch, HEAD and dirty state straight from git; null when unreadable. */
export function readGitSnapshot(git, path, checkpointGit = null) {
  try {
    const branch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const sha = git(path, ['rev-parse', 'HEAD']).trim();
    const lines = git(path, ['status', '--porcelain']).split('\n').filter(Boolean);
    return { branch, sha, changes: lines.length, paths: changedPaths(lines),
      ...(checkpointGit ? { checkpointObservation: readCheckpointGit(git, path, sha) } : {}) };
  } catch {
    return null;
  }
}

function changedPaths(lines) {
  return lines.slice(0, 10).map((line) => line.length > 3 ? line.slice(3) : line);
}

/** Richer git read for the resume brief: ahead/behind plus up to 10 changed paths; null when unreadable. */
export function readGitBrief(git, path, checkpointGit = null) {
  try {
    const branch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const sha = git(path, ['rev-parse', 'HEAD']).trim();
    const lines = git(path, ['status', '--porcelain']).split('\n').filter(Boolean);
    let ahead = null;
    let behind = null;
    try {
      ahead = Number(git(path, ['rev-list', '--count', '@{upstream}..HEAD']).trim());
      behind = Number(git(path, ['rev-list', '--count', 'HEAD..@{upstream}']).trim());
      if (!Number.isFinite(ahead)) ahead = null;
      if (!Number.isFinite(behind)) behind = null;
    } catch {
      ahead = null;
      behind = null;
    }
    return { branch, sha, ahead, behind, changed: lines.length, paths: changedPaths(lines),
      ...(checkpointGit ? { checkpointObservation: readCheckpointGit(git, path, sha) } : {}) };
  } catch {
    return null;
  }
}

function clip(text, max) {
  const value = (text ?? '').trim().replace(/\s+\n/g, '\n');
  return value.length > max ? `${value.slice(0, max)} […]` : value;
}

/** Checkpoint revision for preview binding: the capture stamp, else the update stamp, else null. */
function checkpointStamp(checkpoint) {
  const stamped = checkpoint?.capturedAt ?? checkpoint?.updatedAt;
  return typeof stamped === 'string' && stamped ? stamped : null;
}

const TEXT = {
  de: {
    head: (repo, e) => `Steer-Übergabe für ${repo}: Epoch ${e} → ${e + 1}.`,
    active: (to, from) => `Aktiv ist jetzt Steer ${to.slot} (${to.id}). Steer ${from.slot} (${from.id}) koordiniert nicht mehr.`,
    git: (g) => `Git: ${g.branch} @ ${g.sha.slice(0, 12)} · ${g.changes ? `${g.changes} geänderte/untracked Pfade` : 'sauber'}`,
    noGit: 'Git: Zustand nicht lesbar – vor Arbeitsbeginn selbst prüfen.',
    checkpointGitChanged: '! Git hat sich seit dem Checkpoint geändert. Die Testergebnisse erneut prüfen.',
    checkpointGitUnknown: '! Git-Arbeitsbaum nicht vergleichbar. Den Checkpoint gegen die aktuellen Dateien prüfen.',
    noCheckpoint: 'Aufgaben-Checkpoint: KEINER DOKUMENTIERT. Aktuellen Auftrag nicht aus dem Verlauf ableiten, sondern beim Nutzer bestätigen.',
    checkpoint: (cp, stale) => `Aufgaben-Checkpoint (Epoch ${cp.epoch ?? '?'}, ${cp.updatedAt ?? 'ohne Zeit'}${stale ? ', NICHT aus der aktuellen Epoch – auf Aktualität prüfen' : ''}):`,
    task: 'Auftrag', tests: 'Tests', blockers: 'Offene Blocker', next: 'Nächster Schritt', none: 'keine dokumentiert',
    nextText: CHECKPOINT_NEXT_TEXT.de,
    noAssignment: 'Auftrag fehlt – mit dem Owner klären.',
    workers: 'Worker (per Agent-ID weiterverwenden, nicht neu anlegen):', noWorkers: 'Worker: keine.', parent: 'Parent Steer',
    hint: (slot) => `Unverifizierter Hinweis – letzte Antwort von Steer ${slot}, gekürzt, keine Auftragsquelle:`,
    notice: (to, e) => `Hinweis: Steer ${to.slot} (${to.id}) ist ab Epoch ${e} aktiv. Du koordinierst nicht mehr; nur auf ausdrückliche Anfrage antworten.`,
    refreshHead: (repo, slot, epoch, active) => `Steer-Auffrischung für ${repo}: Steer ${slot} bekommt einen neuen Agenten in Epoch ${epoch} (keine Übernahme; aktiv bleibt Steer ${active}).`,
    rewindHead: (repo, slot, id, epoch, active) => `Steer-Auffrischung für ${repo}: Steer ${slot} behält Agent ${id} im selben Tab (Kontext per Rewind geleert, Epoch ${epoch}, keine Übernahme; aktiv bleibt Steer ${active}).`,
    workerHead: (repo, title, from, to, owner) => `Worker-Auffrischung für ${repo}: „${title}“ ${from} → ${to} (Owner Steer ${owner}, Epoch unverändert).`,
    workerRewindHead: (repo, title, id, owner) => `Worker-Auffrischung für ${repo}: „${title}“ ${id} behält seinen Tab (Kontext per Rewind geleert, Owner Steer ${owner}, Epoch unverändert).`,
    refreshRole: (slot) => `Du bist Steer ${slot} dieses Scopes (nicht aktiv: nur antworten, nicht koordinieren).`,
    refreshRoleActive: (slot) => `Du bist Steer ${slot} dieses Scopes und aktiv: koordiniere ab dem Checkpoint unten.`,
    workerRole: (title, owner) => `Du bist Worker „${title}“; dein Owner ist Steer ${owner} — mache mit dem Checkpoint unten weiter.`,
    refreshNote: (id, at) => `Notiz von ${id}${at ? ` (${at})` : ''}:`,
    noNote: 'Agentennotiz: keine dokumentiert; der Checkpoint unten ist die einzige Quelle.',
    workerHint: () => 'Unverifizierter Hinweis – letzte Antwort des vorherigen Workers, gekürzt, keine Auftragsquelle:',
  },
  en: {
    head: (repo, e) => `Steer handoff for ${repo}: epoch ${e} → ${e + 1}.`,
    active: (to, from) => `Steer ${to.slot} (${to.id}) is now active. Steer ${from.slot} (${from.id}) no longer coordinates.`,
    git: (g) => `Git: ${g.branch} @ ${g.sha.slice(0, 12)} · ${g.changes ? `${g.changes} changed/untracked paths` : 'clean'}`,
    noGit: 'Git: state unreadable – check it yourself before starting.',
    checkpointGitChanged: '! Git changed since the checkpoint was recorded. Recheck its test evidence.',
    checkpointGitUnknown: '! Git worktree comparison unavailable. Verify the checkpoint against the current files.',
    noCheckpoint: 'Task checkpoint: NONE RECORDED. Do not infer the current task from history; confirm it with the user.',
    checkpoint: (cp, stale) => `Task checkpoint (epoch ${cp.epoch ?? '?'}, ${cp.updatedAt ?? 'no time'}${stale ? ', NOT from the current epoch – check whether it is still valid' : ''}):`,
    task: 'Task', tests: 'Tests', blockers: 'Open blockers', next: 'Next step', none: 'none recorded',
    nextText: CHECKPOINT_NEXT_TEXT.en,
    noAssignment: 'Missing assignment. Confirm it with the owner.',
    workers: 'Workers (reuse by agent id, do not recreate):', noWorkers: 'Workers: none.', parent: 'parent Steer',
    hint: (slot) => `Unverified hint – last answer of Steer ${slot}, shortened, not a task source:`,
    notice: (to, e) => `Note: Steer ${to.slot} (${to.id}) is active as of epoch ${e}. You no longer coordinate; reply only when asked explicitly.`,
    refreshHead: (repo, slot, epoch, active) => `Steer refresh for ${repo}: Steer ${slot} gets a new agent at epoch ${epoch} (no takeover; active stays Steer ${active}).`,
    rewindHead: (repo, slot, id, epoch, active) => `Steer refresh for ${repo}: Steer ${slot} keeps agent ${id} in the same tab (rewound context, epoch ${epoch}, no takeover; active stays Steer ${active}).`,
    workerHead: (repo, title, from, to, owner) => `Worker refresh for ${repo}: "${title}" ${from} → ${to} (owner Steer ${owner}, epoch unchanged).`,
    workerRewindHead: (repo, title, id, owner) => `Worker refresh for ${repo}: "${title}" ${id} keeps its tab (rewound context, owner Steer ${owner}, epoch unchanged).`,
    refreshRole: (slot) => `You are Steer ${slot} of this scope (not active: answer only, do not coordinate).`,
    refreshRoleActive: (slot) => `You are Steer ${slot} of this scope and active: coordinate from the checkpoint below.`,
    workerRole: (title, owner) => `You are worker "${title}"; your owner is Steer ${owner} — continue from the checkpoint below.`,
    refreshNote: (id, at) => `Note of ${id}${at ? ` (${at})` : ''}:`,
    noNote: 'Agent note: none recorded; the checkpoint below is the only source.',
    workerHint: () => 'Unverified hint – last answer of the previous worker, shortened, not a task source:',
  },
};

/**
 * Renders checkpoint fields as the fenced CHECKPOINT block: the one form every
 * factory-generated text carries and every steer/worker answer must end with.
 * Field names stay fixed English so parseCheckpointBlock reads them back in any
 * handoff language; empty values become "none".
 */
/**
 * Compact steer rules for packets that reach steers outside this repository
 * (their AGENTS.md does not carry the factory rules): the exact CHECKPOINT
 * format, and who receives the report when the factory knows a requester.
 */
export function checkpointRules({ reportTo = null } = {}) {
  return [
    'Factory rules for this scope: end every answer that changes the task state with exactly this fenced block (keys in English, values in any language; status is done, partial or blocked):',
    '```text',
    'CHECKPOINT',
    'task: <one line>',
    'tests: <commands and results, or none>',
    'blockers: <items, or none>',
    'next: <next step, or none>',
    'status: done | partial | blocked',
    '```',
    'Do not replace it with a heading such as "## CHECKPOINT" or prose; the factory parses this block.',
    'Tell every worker you start to end its answer with the same block (status included), and archive a worker once you have accepted its result.',
    ...(reportTo ? [`When the status is done or blocked, the factory sends this block to the requester ${reportTo} automatically; do not message it yourself.`] : []),
  ].join('\n');
}

export function formatCheckpointBlock({ task, tests = [], blockers = [], next = null, status }) {
  const oneLine = (value) => String(value ?? '').replace(/\s*\n\s*/g, ' ').trim();
  const list = (values) => (values?.length ? values.map(oneLine).filter(Boolean).join('; ') : 'none');
  return ['```text', 'CHECKPOINT', `task: ${oneLine(task)}`, `tests: ${list(tests)}`, `blockers: ${list(blockers)}`, `next: ${next ? oneLine(next) : 'none'}`, ...(status ? [`status: ${status}`] : []), '```'].join('\n');
}

function boundBrief(lines, { budget = BRIEF_BUDGET, worker = false, truncated = false } = {}) {
  const marker = `\n${worker ? 'See the worker register and last saved CHECKPOINT.' : 'See the stored scope CHECKPOINT and worker register.'}\n[…brief truncated to ${budget} characters]`;
  const text = lines.join('\n');
  if (!truncated && text.length <= budget) return text;
  const kept = [];
  let used = marker.length;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join('\n') + marker;
}

function packetCheckpoint(lines, cp, epoch, t) {
  if (!cp?.task) {
    lines.push(t.noCheckpoint);
    return false;
  }
  const fields = { task: cp.task, tests: cp.tests?.join('; ') ?? '', blockers: cp.blockers?.join('; ') ?? '', next: cp.next ?? '' };
  const bounded = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, clip(value, key === 'task' ? 500 : 300)]));
  lines.push(t.checkpoint(cp, cp.epoch != null && cp.epoch !== epoch));
  lines.push(`- ${t.task}: ${bounded.task}`, `- ${t.tests}: ${bounded.tests || t.none}`, `- ${t.blockers}: ${bounded.blockers || t.none}`, `- ${t.next}: ${t.nextText[checkpointNextStep(cp)] ?? bounded.next}`);
  if (cp.source === 'failover' && cp.failover) lines.push(clip(`- Failover: takeover from ${cp.failover.previousSteer ?? '?'} (${cp.failover.reason ?? 'no reason recorded'})`, 240));
  lines.push(formatCheckpointBlock({ ...bounded, tests: bounded.tests ? [bounded.tests] : [], blockers: bounded.blockers ? [bounded.blockers] : [], status: cp.status }));
  return Object.keys(fields).some((key) => fields[key].trim().length > (key === 'task' ? 500 : 300));
}

function workerCheckpoint(status, id, { note, lastMessage, interrupted } = {}) {
  const entry = status.openWorkers?.find((worker) => worker.id === id);
  return {
    task: clipTask(entry?.task) || null,
    hasAssignment: status.workers?.find((worker) => worker.id === id)?.hasAssignment === true,
    block: parseCheckpointBlock(lastMessage) ?? parseCheckpointBlock(interrupted?.excerpt) ?? parseCheckpointBlock(note),
    interrupted: interrupted ?? (entry?.state === 'interrupted' ? {} : null),
  };
}

function appendWorkerCheckpoint(lines, worker, t, epoch) {
  if (worker.task) lines.push(`${t.task}: ${worker.task}`);
  else if (!worker.hasAssignment) lines.push(t.noAssignment);
  if (worker.interrupted) lines.push(`! Worker interrupted${worker.interrupted.at ? ` at ${worker.interrupted.at}` : ''}.`);
  if (worker.block) return packetCheckpoint(lines, worker.block, epoch, t);
  lines.push('Worker CHECKPOINT: none recorded.');
  return false;
}

function appendPacketPaths(lines, git) {
  if (!git?.paths?.length) return;
  lines.push('Changed paths:');
  for (const path of git.paths.slice(0, 10)) lines.push(`- ${clip(path, 120)}`);
}

function appendCheckpointGitNotice(lines, checkpoint, git, text) {
  if (!checkpoint?.git?.head) return;
  const saved = checkpoint.git;
  const current = git?.checkpointObservation;
  if ((git?.sha && saved.head !== git.sha) || (saved.worktree && current?.worktree && saved.worktree !== current.worktree)) {
    lines.push(text.checkpointGitChanged);
  } else if (!saved.worktree || !current?.worktree) {
    lines.push(text.checkpointGitUnknown);
  }
}

/**
 * Deterministic handoff text from Paseo/git state. No model call is made to build
 * it; the receiving steer still reads it as normal input on its next turn.
 */
export function buildHandoff(status, { from, to, epoch, git, lastMessage, maxLastChars = 800, language = 'en', workerModel = null, promptOptions, budget }) {
  const t = TEXT[language] ?? TEXT.en;
  const lines = [clip(t.head(status.repo, epoch), 350), t.active(to, from), clip(`Workspace ${status.workspace.id} · ${status.workspace.directory}`, 450), clip(git ? t.git(git) : t.noGit, 220)];
  const truncated = packetCheckpoint(lines, status.checkpoint, epoch, t);
  appendCheckpointGitNotice(lines, status.checkpoint, git, t);
  appendPacketPaths(lines, git);
  const supervised = new Map((status.openWorkers ?? []).map((e) => [e.id, e]));
  const supervisedSuffix = (id) => {
    const e = supervised.get(id);
    return e ? ` · supervised ${e.state}: ${clip(e.task ?? '', 120) || '(no task)'}` : '';
  };
  if (status.workers.length || supervised.size) {
    lines.push(t.workers);
    const sorted = [...status.workers].sort((a, b) => Number(supervised.has(b.id)) - Number(supervised.has(a.id)));
    for (const e of [...supervised.values()].filter((entry) => !status.workers.some((w) => w.id === entry.id))) lines.push(`- ${e.id} (agent not live) · supervised ${e.state}: ${clip(e.task ?? '', 120) || '(no task)'}`);
    for (const w of sorted) lines.push(`- ${w.id} „${clip(w.title, 100)}“ ${w.provider}/${w.model} · ${w.status}${w.parentSlot ? ` · ${t.parent} ${w.parentSlot}` : ''}${!w.parentSlot && w.parentCandidate ? ` · ${t.parent} candidate "${w.parentCandidate.title}" ${w.parentCandidate.id}` : ''}${w.owner && !w.parentSlot ? ` · owner ${w.owner}` : ''}${w.workspaceId && status.workspace && w.workspaceId !== status.workspace.id ? ` · workspace ${w.workspaceId}` : ''}${supervisedSuffix(w.id)}`);
  } else {
    lines.push(t.noWorkers);
  }
  if (workerModel) lines.push(workerModel);
  const findings = findingsPassage(promptOptions);
  if (findings) lines.push(findings);
  if (lastMessage) lines.push(t.hint(from.slot), clip(lastMessage, maxLastChars));
  return boundBrief(lines, { budget, truncated });
}

export function previousSteerNotice(to, epoch, language = 'en') {
  return (TEXT[language] ?? TEXT.en).notice(to, epoch);
}

/**
 * Refresh packet for a non-active steer or a worker: same agent role in a
 * new agent, no takeover and no epoch change. The brief comes from the
 * agent's own `wsf.agents` note and the task checkpoint. Workers use their
 * assignment and checkpoint only.
 * Deterministic like buildHandoff; no model call is made to build it.
 * With `rewound: true` the packet heads the same tab after a Paseo rewind
 * (from.id is kept, same agent and no archival).
 */
export function buildRefreshPacket(status, { kind, slot = null, owner = null, title = null, from, to, epoch, git, note = null, noteAt = null, interrupted = null, lastMessage = null, maxLastChars = 800, language = 'en', workerModel = null, rewound = false, promptOptions }) {
  const t = TEXT[language] ?? TEXT.en;
  const active = status.state?.activeSteer ?? '?';
  const lines = [
    kind === 'worker'
      ? (rewound
        ? t.workerRewindHead(status.repo, title ?? from.title ?? 'Worker', from.id, owner ?? '?')
        : t.workerHead(status.repo, title ?? from.title ?? 'Worker', from.id, to.id, owner ?? '?'))
      : (rewound
        ? t.rewindHead(status.repo, slot, from.id, epoch, active)
        : t.refreshHead(status.repo, slot, epoch, active)),
    kind === 'worker'
      ? t.workerRole(title ?? from.title ?? 'Worker', owner ?? '?')
      : (slot && slot === active ? t.refreshRoleActive(slot) : t.refreshRole(slot)),
    `Workspace ${status.workspace.id} · ${status.workspace.directory}`,
    git ? t.git(git) : t.noGit,
  ].map((line) => clip(line, 450));
  if (kind === 'worker') lines.push(WORKER_EFFICIENCY_LINE);
  const worker = kind === 'worker' ? workerCheckpoint(status, from.id, { note, lastMessage, interrupted }) : null;
  const truncated = worker ? appendWorkerCheckpoint(lines, worker, t, epoch) : packetCheckpoint(lines, status.checkpoint, epoch, t);
  if (!worker) appendCheckpointGitNotice(lines, status.checkpoint, git, t);
  appendPacketPaths(lines, git);
  if (!worker && status.openWorkers?.length) {
    lines.push(t.workers);
    for (const entry of status.openWorkers) lines.push(`- ${entry.id} · supervised ${entry.state}: ${clip(entry.task ?? '', 120)}`);
  }
  if (workerModel && !worker) lines.push(workerModel);
  const findings = findingsPassage(promptOptions);
  if (findings) lines.push(findings);
  if (!worker?.block && typeof note === 'string' && note.trim()) {
    lines.push(t.refreshNote(from.id, noteAt));
    lines.push(clip(note, 1500));
  } else if (!worker) {
    lines.push(t.noNote);
  }
  if (lastMessage && !worker?.block) lines.push(worker ? t.workerHint() : t.hint(slot), clip(lastMessage, maxLastChars));
  return boundBrief(lines, { worker: Boolean(worker), truncated });
}

const freshLookupFail = (message) => new SwitchRefused(`Fresh ${message}`);
const freshRecoveryFail = (message) => new SwitchRefused(`Fresh recovery stopped: ${message}`);
const freshVerifyFail = (freshId) => (message) => new SwitchRefused(`Fresh agent ${freshId} failed placement verification (${message})`);

export async function requireFreshPrivacy({ client, workspaceId, scopeId, epoch, agentId, admitTarget }) {
  const [snapshot, workspace] = await Promise.all([
    client.agents.ref(agentId).refresh(), client.workspaces.ref(workspaceId).refresh(),
  ]);
  const agent = snapshot?.agent;
  if (agent?.id !== agentId || agent.archivedAt || agent.background === true) throw new SwitchRefused('Fresh refused: the target agent is unavailable.');
  const scope = workspace?.metadata?.[METADATA_KEY];
  if (!scope || (scopeId && !sameScopeId(scope.scope?.id, scopeId)) || (epoch != null && scope.epoch !== epoch)) {
    throw new SwitchRefused('Fresh refused: the scope changed.');
  }
  const admission = await admitTarget(agent, workspaceId);
  if (!admission.allowed) throw new SwitchRefused(`Fresh refused: ${admission.reason}.`);
}

export async function reconcileFreshDelivery({ client, workspaceId, agentId, actionId, lock, checkPrivacy }) {
  // Settle a known receipt without sending. For a replay, check both before
  // saving the attempt and after that write, immediately before dispatch.
  const beforeSend = (action) => checkPrivacy(agentId, action.epoch);
  let result;
  try {
    result = await reconcileSteerSend({ client, workspaceId, agentId, actionId, lock, beforeSend,
      validate: async (action) => (await beforeSend(action))?.allowed !== false });
  } catch (error) {
    if (error instanceof SwitchRefused) return { status: 'blocked', detail: error.message };
    throw error;
  }
  if (result.status === 'sent' && !result.recordingError) {
    try {
      await retryOnLockBusy(() => updateAgentEntry({ client, workspaceId, agentId, lock, patch: (entry) =>
        entry?.action?.wakeId === actionId && entry.action.phase === 'sent' ? { action: { ...entry.action, phase: 'done' } } : null }));
    } catch (error) {
      if (!(error instanceof LockBusy)) throw error;
      return { ...result, recordingError: `Message sent. Factory completion record is still pending (${error.message}).` };
    }
  }
  return result;
}

// A Fresh creation and its first prompt are separate durable operations. Pin
// the exact prompt and native receipt key before the first send, and retain it
// on recovery even if the newly built packet has changed meanwhile.
async function reserveFreshPacket({ client, workspaceId, agentId, packet, epoch, lock, authority = null, messageId = null }) {
  const reserved = await updateAgentEntry({ client, workspaceId, agentId, lock, patch: (entry) => {
    const existing = readSteerAction(entry);
    if (existing?.kind === 'fresh-delivery') return null;
    if (existing && existing.phase !== 'done') return null;
    const action = newSteerAction({ kind: 'fresh-delivery', id: messageId ?? crypto.randomUUID(), epoch, text: packet });
    if (authority) action.authority = authority;
    return { action };
  } });
  const action = readSteerAction(reserved);
  if (action?.kind !== 'fresh-delivery') throw new SwitchRefused('Another agent action needs reconciliation.');
  return action.wakeId;
}

/**
 * Idempotency guard for a same-tab rewind refresh: a pending cleanup action
 * or an already-recorded rewind after the last turn ends makes a second
 * fresh a no-op (double-click safe). Returns the reason string, or null to
 * proceed. Unparsable timestamps fail open (proceed).
 */
export function freshRewindIdempotent(entry) {
  if (readCleanupAction(entry)) return 'a cleanup action is already pending';
  if (entry?.action?.kind === 'rewind' && ['rewinding', 'uncertain'].includes(entry.action.phase)) return 'rewind outcome is uncertain; inspect the agent before recovery';
  const doneAction = entry?.action?.kind === 'rewind' && entry.action.phase === 'done' ? entry.action : null;
  if (doneAction && typeof doneAction.queuedAt === 'string') {
    const doneMs = Date.parse(doneAction.queuedAt);
    const lastEnd = typeof entry?.lastTurnEndedAt === 'string' ? Date.parse(entry.lastTurnEndedAt) : NaN;
    if (Number.isFinite(doneMs) && Number.isFinite(lastEnd) && doneMs >= lastEnd) return 'already rewound after the last turn';
  }
  const cleared = actionFact(entry, 'cleared');
  if (cleared?.mode === 'rewind' && typeof cleared.at === 'string') {
    const clearedMs = Date.parse(cleared.at);
    if (!Number.isFinite(clearedMs)) return null;
    const lastEnd = typeof entry?.lastTurnEndedAt === 'string' ? Date.parse(entry.lastTurnEndedAt) : NaN;
    // No recorded turn since the rewind (unknown last end counts as none):
    // rewinding again would be pointless, so the second fresh is a no-op.
    if (!Number.isFinite(lastEnd)) return 'already rewound; no new turn recorded since';
    if (clearedMs >= lastEnd) return 'already rewound after the last turn';
  }
  return null;
}

/**
 * `wsf.agents` patch recorded after a successful same-tab rewind: `cleared`
 * with mode `rewind` (so the C5 "already cleaned" rule and the turn hook see
 * it as a cleaning) plus an explicit `refreshed` marker with the rewind
 * message id and the brief's message id (when the brief landed as
 * user_message). Compaction debt and the fresh hint are wiped like after a
 * clear; a previous action failure is lifted.
 */
export function buildRewindRecord({ checkpoint = null, messageId = null, briefMessageId = null, now = () => new Date() } = {}) {
  const at = (typeof now === 'function' ? now() : now)?.toISOString?.() ?? new Date().toISOString();
  const checkpointAt = checkpoint?.capturedAt ?? checkpoint?.updatedAt ?? null;
  return {
    cleared: { at, mode: 'rewind', checkpointAt },
    refreshed: { at, mode: 'rewind', ...(messageId ? { messageId } : {}), ...(briefMessageId ? { briefMessageId } : {}) },
    freshHint: null,
    compactions: 0,
    lastCompactBaseTokens: null,
    compactionPendingBase: null,
    lastActionFailed: null,
  };
}

export async function settleRewindReceipt({ client, workspaceId, agentId, actionId, lock }) {
  return updateAgentEntry({ client, workspaceId, agentId, lock, clearMetadataKey: effectReceiptKey(actionId), patch: (entry, metadata) => {
    const action = readSteerAction(entry);
    if (action?.wakeId !== actionId) return null;
    const receipt = readEffectReceipt(metadata, action);
    if (receipt?.kind !== 'rewind') return null;
    const manual = action.kind === 'rewind' && ['rewinding', 'uncertain'].includes(action.phase);
    if (!manual && (action.renewal !== 'rewind' || !action.rewindAttempt || !['renewing', 'blocked'].includes(action.phase))) return null;
    const { previousAction: _previous, rewindAttempt: _attempt, lastError: _error, ...current } = action;
    const { at, messageId, briefMessageId, sendError, checkpointAt, note, stage } = receipt;
    const scope = metadata[METADATA_KEY];
    const epoch = scope?.epoch ?? null;
    const staged = stage && scope && epoch === current.epoch;
    const next = staged ? {
      ...newSteerAction({ kind: 'stage', id: actionId, epoch, at, text: current.packet, phase: 'staged' }),
      at, stageKind: 'fresh',
    } : manual ? {
      ...current, phase: 'done', messageId, briefMessageId, ...(sendError ? { sendError } : {}),
    } : { ...current, phase: 'ready' };
    return {
      action: next,
      ...buildRewindRecord({ checkpoint: { capturedAt: checkpointAt }, messageId, briefMessageId, now: () => new Date(at) }),
      ...(note ? { note, noteAt: checkpointAt ?? null } : {}),
      ...(staged ? { stagedBrief: null } : {}),
    };
  } });
}

/** Hard budget for the resume brief: ≤6000 chars (~1.5k tokens), enforced. */
export const BRIEF_BUDGET = 6000;
const BRIEF_WORKERS_SHOWN = 8;

function ageAgo(when, now) {
  const ms = now - Date.parse(when);
  if (!Number.isFinite(ms) || ms < 0) return 'unknown age';
  if (ms < 90_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/**
 * Resume brief for a cold agent: scope header, checkpoint with source/age and
 * stale/interrupted warnings, restart lines, git, worker notes, open hub
 * items. Deterministic (no wall-clock time inside, only the age), English
 * only except the fixed German restart line. `agentState` is the `wsf.agents`
 * map for excerpts and worker notes; `git` a readGitBrief result.
 * `daemonStartedAt` plus `lastTurnCheckpoints` (agent id -> bool, false means
 * the last turn had no CHECKPOINT) enable the heuristic restart guess; without
 * them only plugin-marked interruptions are shown.
 */
export function buildResumeBrief(status, { agentId = null, agentState = null, workerLastAnswer = null, git = null, scope = null, now = () => Date.now(), daemonStartedAt = null, lastTurnCheckpoints = null, config = null, workerModel = null, quotaSnapshot = null, quotaWarnPct = config?.quota?.warnPct ?? QUOTA_DEFAULTS.warnPct, zerosub = null, promptOptions, budget = BRIEF_BUDGET, assignments = [] } = {}) {
  const id = scope?.id ?? status.repo;
  const kind = scope?.kind ?? 'unknown';
  const epoch = status.state?.epoch ?? '?';
  const domain = scope?.domain ?? status.domain ?? null;
  const holders = liveSlotHolders(status.steers, status.state?.activeSteer)
    .filter((steer) => !steer.parent && (!steer.workspaceId || steer.workspaceId === status.workspace?.id));
  const active = holders.length === 1 ? holders[0] : null;
  const lines = [clip(`Resume brief for ${id} (${kind}) · epoch ${epoch} · active steer ${status.state?.activeSteer ?? '?'}${active ? ` (${active.id})` : ''}${domain ? ` · domain ${domain}` : ''}.`, 450)];
  const callerSteer = agentId ? status.steers.find((s) => s.id === agentId) ?? null : null;
  const callerWorker = !callerSteer && agentId ? (status.workers ?? []).find((w) => w.id === agentId) ?? null : null;
  if (callerSteer && (callerSteer.advisor ?? isAdvisorSlot(config, callerSteer.slot))) lines.push('You are an advisor steer: answer only, never coordinate or take over.');
  else if (callerSteer && callerSteer.id === active?.id) lines.push('You are the active steer of this scope.');
  else if (callerSteer) lines.push('You are not active: answer only, do not coordinate.');
  else if (callerWorker) lines.push(`You are worker "${clip(callerWorker.title, 100)}"; your owner is Steer ${callerWorker.owner ?? callerWorker.parentSlot ?? '?'} — continue from the checkpoint below.`);
  else lines.push('Caller unknown; treat this brief as read-only context.');
  if (callerWorker) {
    lines.push(WORKER_EFFICIENCY_LINE);
    const worker = workerCheckpoint(status, agentId, { ...agentState?.[agentId], lastMessage: workerLastAnswer });
    const truncated = appendWorkerCheckpoint(lines, worker, TEXT.en, epoch);
    appendPacketPaths(lines, git);
    const findings = findingsPassage(promptOptions);
    if (findings) lines.push(findings);
    return boundBrief(lines, { worker: true, truncated, budget });
  }
  if (workerModel) lines.push(workerModel);
  const findings = findingsPassage(promptOptions);
  if (findings) lines.push(findings);
  const quotaLine = active && formatQuotaLine(config, quotaSnapshot, { agent: active, warnPct: quotaWarnPct, zerosub, now: now() });
  if (quotaLine) lines.push(quotaLine);

  const cp = status.checkpoint;
  const agents = agentState && typeof agentState === 'object' ? agentState : {};
  const freshHint = currentFreshHint((callerSteer || callerWorker) ? agents[agentId] : null);
  if (freshHint) lines.push(`Context recommendation: ${freshHint}`);
  if (!cp?.task) {
    lines.push(assignments.length
      ? 'Task checkpoint: NONE RECORDED. Inspect the outgoing assignment records below; confirm the task with the user if still unclear.'
      : 'Task checkpoint: NONE RECORDED. Do not infer the current task from history; confirm it with the user.');
  } else {
    const stamped = cp.capturedAt ?? cp.updatedAt ?? null;
    lines.push(`Task checkpoint (${cp.source ?? 'manual'}${stamped ? `, ${ageAgo(stamped, now())}` : ''}):`);
    lines.push(`- Task: ${clip(cp.task, 500)}`);
    lines.push(`- Tests: ${cp.tests?.length ? clip(cp.tests.join('; '), 300) : 'none recorded'}`);
    lines.push(`- Open blockers: ${cp.blockers?.length ? clip(cp.blockers.join('; '), 300) : 'none recorded'}`);
    lines.push(`- Next step: ${TEXT.en.nextText[checkpointNextStep(cp)] ?? clip(cp.next, Math.max(300, Math.min(2000, budget - 1500)))}`);
    appendCheckpointGitNotice(lines, cp, git, TEXT.en);
    if (cp.source === 'failover' && cp.failover) lines.push(`Failover from ${cp.failover.previousSteer ?? '?'}: ${cp.failover.reason ?? 'no reason recorded'}`);
    if (cp.epoch !== null && cp.epoch !== undefined && status.state?.epoch !== null && status.state?.epoch !== undefined && cp.epoch !== status.state.epoch) {
      lines.push(`! Checkpoint is stale: from epoch ${cp.epoch}, scope is at epoch ${status.state.epoch} — verify before continuing.`);
    }
    if (cp.interrupted && typeof cp.interrupted === 'object') {
      lines.push(`! Interrupted: ${cp.interrupted.agentId ?? 'unknown agent'} at ${cp.interrupted.at ?? 'unknown time'} — last answer tail:`);
      const excerpt = agents[cp.interrupted.agentId]?.interrupted?.excerpt;
      lines.push(typeof excerpt === 'string' && excerpt ? clip(excerpt, 800) : '(no excerpt recorded)');
    }
  }
  if (assignments.length) {
    lines.push('Outgoing assignments (verify source records; delivery is not proof of processing):');
    for (const assignment of assignments.slice(0, 5)) {
      const state = assignment.reportedAt ? 'report delivered; processing unverified' :
        assignment.actionId ? 'report pending' : 'assignment in progress';
      lines.push(`- ${clip(assignment.scopeId, 120)} (${clip(assignment.workspaceId, 80)}): ${state}${assignment.reportStatus ? ` (${clip(assignment.reportStatus, 40)})` : ''}; task: ${clip(assignment.task ?? 'see source', 160)}`);
      if (assignment.reportedAt && assignment.reportText) lines.push(`  Report hint (do not blindly replay): ${clip(assignment.reportText.replace(/\s+/g, ' '), 350)}`);
    }
    if (assignments.length > 5) lines.push(`- … +${assignments.length - 5} more; inspect source assignments.`);
  }
  const marked = restartInterruptions({ checkpoint: cp, agentState: agents });
  const markedIds = new Set(marked.map((m) => m.agentId));
  const heuristic = [];
  const checkpointAt = cp?.capturedAt ?? cp?.updatedAt ?? null;
  if (daemonStartedAt && lastTurnCheckpoints && typeof lastTurnCheckpoints === 'object' && checkpointAt) {
    for (const a of [...(status.steers ?? []), ...(status.workers ?? [])]) {
      if (!a || markedIds.has(a.id)) continue;
      if (isHeuristicRestart({ daemonStartedAt, checkpointAt, agentStatus: a.status, lastTurnHadCheckpoint: lastTurnCheckpoints[a.id] })) {
        heuristic.push({ agentId: a.id, reason: 'daemon-restart', at: null, heuristic: true });
      }
    }
  }
  for (const r of [...marked, ...heuristic].sort((a, b) => a.agentId.localeCompare(b.agentId))) {
    lines.push(`! ${restartMessage(r.agentId)} (${r.reason}${r.heuristic ? ', vermutet' : ''})`);
  }
  if (git) {
    const sync = git.ahead === null && git.behind === null ? 'no upstream' : `ahead ${git.ahead ?? '?'}/behind ${git.behind ?? '?'}`;
    lines.push(`Git: ${git.branch} @ ${String(git.sha ?? '').slice(0, 12)} · ${sync} · ${git.changed ? `${git.changed} changed files:` : 'clean'}`);
    for (const p of (git.paths ?? []).slice(0, 10)) lines.push(`- ${clip(String(p ?? ''), 120)}`);
  } else {
    lines.push('Git: state unreadable – check it yourself before starting.');
  }
  const workers = status.workers ?? [];
  const supervised = new Map((status.openWorkers ?? []).map((e) => [e.id, e]));
  const registerOnly = [...supervised.values()].filter((e) => !workers.some((w) => w.id === e.id));
  if (!workers.length && !registerOnly.length) {
    lines.push('Workers: none.');
  } else {
    lines.push('Workers (reuse by agent id):');
    for (const w of workers.slice(0, BRIEF_WORKERS_SHOWN)) {
      const note = agents[w.id]?.note;
      const firstLine = typeof note === 'string' && note.trim() ? clip(note.trim().split('\n')[0], 120) : null;
      const e = supervised.get(w.id);
      const task = clipTask(e?.task);
      const missing = !task && w.hasAssignment !== true;
      const details = [firstLine, missing ? 'missing assignment' : firstLine ? null : 'no note',
        e ? `supervised: ${[e.state, clip(task, 120)].filter(Boolean).join(' ')}` : null];
      lines.push([`- ${w.id} "${w.title}" ${w.status}`, ...details.filter(Boolean)].join(' · '));
    }
    if (workers.length > BRIEF_WORKERS_SHOWN) lines.push(`- … +${workers.length - BRIEF_WORKERS_SHOWN} more workers`);
    for (const e of registerOnly) lines.push(`- ${e.id} (agent not live) · supervised: ${e.state} ${clip(clipTask(e.task) || 'missing assignment', 120)}`);
  }
  const escalations = (cp?.blockers ?? []).filter((b) => typeof b === 'string' && b.startsWith('hub:'));
  if (escalations.length) {
    lines.push('Open hub items:');
    for (const item of escalations.slice(0, 10)) lines.push(`- ${clip(item, 200)}`);
    if (escalations.length > 10) lines.push(`- … +${escalations.length - 10} more hub items`);
  } else {
    lines.push('Open hub items: none.');
  }
  // Domain routing (only when the scope has a domain or escalated to one, so
  // briefs without a domain stay byte-identical): `domain:` blockers go to the
  // domain steer, `hub:` ones further to the hub.
  const domainItems = (cp?.blockers ?? []).filter((b) => typeof b === 'string' && b.startsWith('domain:'));
  if (domain || domainItems.length) {
    if (domainItems.length) {
      lines.push(`Open domain items (escalated to the domain steer${domain ? ` ${domain}` : ''}):`);
      for (const item of domainItems.slice(0, 10)) lines.push(`- ${clip(item, 200)}`);
      if (domainItems.length > 10) lines.push(`- … +${domainItems.length - 10} more domain items`);
    } else {
      lines.push('Open domain items: none.');
    }
  }
  const text = lines.join('\n');
  if (text.length <= budget) return text;
  return boundBrief(lines, { budget });
}

/**
 * Handoffs with interruptions or outgoing assignments use one resume brief;
 * otherwise retain the ordinary handoff.
 */
function handoffWithBrief(status, args, { discovery, git, language, config = null, workerModel = null, quotaSnapshot = null, quotaWarnPct = QUOTA_DEFAULTS.warnPct, zerosub = null, promptOptions }) {
  const at = status.checkpoint?.interrupted?.at ?? null;
  if (at === null && !status.checkpoint?.interrupted && !discovery?.assignmentRecords?.length) return buildHandoff(status, { ...args, workerModel, promptOptions });
  const receivingStatus = {
    ...status,
    state: { ...status.state, activeSteer: args.to.slot, epoch: args.epoch + 1 },
    steers: [args.to, ...status.steers.filter((steer) => steer.slot !== args.to.slot)],
  };
  const brief = buildResumeBrief(receivingStatus, {
    agentId: args.to.id,
    agentState: discovery?.mainWorkspace?.metadata?.[AGENTS_KEY] ?? null,
    git: git ? readGitBrief(git, status.workspace.directory, status.checkpoint?.git ?? null) : null,
    scope: discovery?.scope ?? null,
    config,
    workerModel,
    quotaSnapshot,
    quotaWarnPct,
    zerosub,
    assignments: discovery?.assignmentRecords ?? [],
    budget: 5000,
    promptOptions,
  });
  const line = language === 'de'
    ? `Der vorherige Steer wurde um ${at ?? 'unbekannter Zeit'} unterbrochen; Git-Stand vor dem Weitermachen prüfen.`
    : `Previous steer was interrupted at ${at ?? 'unknown time'}; verify git state before continuing.`;
  return boundBrief([
    clip((TEXT[language] ?? TEXT.en).head(status.repo, args.epoch), 350),
    (TEXT[language] ?? TEXT.en).active(args.to, args.from),
    ...(status.checkpoint?.interrupted ? [clip(line, 200)] : []),
    brief,
    ...(args.lastMessage ? [(TEXT[language] ?? TEXT.en).hint(args.from.slot), clip(args.lastMessage, args.maxLastChars ?? 800)] : []),
  ]);
}

export { parseCheckpointBlock };

export function lastAssistantText(timelinePayload) {
  const entries = timelinePayload?.entries ?? [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const item = entries[i]?.item;
    if (item?.type === 'assistant_message' && item.text) return item.text;
  }
  return null;
}

/**
 * Moves the active-steer tab marker ("▷ Steer E"): marks one agent, unmarks
 * another. Best-effort and cosmetic only — never throws. Returns null on
 * success (or when there is nothing to do: no paseoCli, disabled marker, or
 * titles already correct), else the error message for `result.renameError`.
 */
export function applyActiveMarker({ paseoCli, marker, mark, unmark }) {
  if (!paseoCli || !marker) return null;
  const jobs = [];
  if (mark?.id) {
    const current = (mark.title ?? '').trim();
    const want = markSteerTitle(mark.title ?? `Steer ${mark.slot}`, marker);
    if (current !== want) jobs.push([mark.id, want]);
  }
  if (unmark?.id && unmark.id !== mark?.id) {
    const current = (unmark.title ?? '').trim();
    const want = stripActiveMarker(unmark.title ?? `Steer ${unmark.slot}`, marker);
    if (current !== want) jobs.push([unmark.id, want]);
  }
  try {
    for (const [id, title] of jobs) paseoCli(['agent', 'update', id, '--name', title]);
    return null;
  } catch (error) {
    return error.message;
  }
}

async function waitForSwitchDelivery(workspace, agentId, deliveryId, epoch, deadline) {
  while (Date.now() < deadline) {
    const meta = (await workspace.refresh())?.metadata ?? {};
    if (meta[METADATA_KEY]?.epoch !== epoch) return 'The scope moved before the handoff brief arrived.';
    const entry = meta[AGENTS_KEY]?.[agentId];
    const pending = readSteerAction(entry);
    if ((pending?.wakeId === deliveryId && (pending.phase === 'sent' || pending.phase === 'done')) || pending?.lastDeliveryId === deliveryId) return null;
    if (pending?.wakeId !== deliveryId) return 'The queued handoff brief could no longer be found.';
    if (pending.phase === 'blocked') return pending.lastError ?? 'Handoff context renewal needs attention.';
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  return 'Timed out waiting for the queued handoff brief.';
}

/**
 * Dry-run returns the handoff and the target state. Apply, under the workspace lock:
 * re-read, check the expected epoch and active steer, write, read back, release;
 * the handoff is delivered after the lock is released.
 */
export async function switchSteer({ client, discovery, toSlot, apply = false, send = true, wait = false, waitTimeoutMs = 600_000, notifyPrevious = false, language = runtime().handoffLanguage, git, lock = withLock, now = () => new Date(), config = null, workerModel = null, quotaSnapshot = null, quotaWarnPct = config?.quota?.warnPct ?? QUOTA_DEFAULTS.warnPct, zerosub = null, callerId = null, paseoCli = null, promptOptions, deliverSteer = null, stage = false, admitTarget = null, activation = null, checkSelfTakeover = null }) {
  const status = steerStatus(discovery, { config });
  if (!status.workspace || !status.state) throw new SwitchRefused('No factory main workspace with steer state; run the factory first');
  const expected = status.state;
  // Several live tabs titled for one slot are ambiguous and refuse below.
  const liveHolders = (slot) => liveSlotHolders(status.steers, slot);
  const from = liveHolders(expected.activeSteer)[0] ?? null;
  const to = liveHolders(toSlot)[0] ?? null;
  if (activation && expected.epoch !== activation.epoch) throw new SwitchRefused('Scope authority changed. Reopen Activate Steer in this tab.');
  if (!to) throw new SwitchRefused(`Steer ${toSlot} does not exist for ${status.repo}`);
  if (activation && to.id !== activation.agentId) throw new SwitchRefused('This tab no longer holds the selected steer slot.');
  if (toSlot === expected.activeSteer) throw new SwitchRefused(`Steer ${toSlot} is already active`);
  if (to.advisor) {
    throw new SwitchRefused(`Steer ${toSlot} is an advisor and cannot coordinate`);
  }
  if (liveHolders(toSlot).length > 1) throw new SwitchRefused(`Steer ${toSlot} has several live agents (${liveHolders(toSlot).map((s) => s.id).join(', ')}); resolve the duplicate titles in Paseo, then rerun`);
  if (from && liveHolders(from.slot).length > 1) throw new SwitchRefused(`Active Steer ${from.slot} has several live agents (${liveHolders(from.slot).map((s) => s.id).join(', ')}); resolve the duplicate titles in Paseo, then rerun`);
  const privacy = steerPrivacyAdmission(config, to, discoveredRepoPublic(discovery));
  if (!privacy.allowed) throw new SwitchRefused(`Steer ${toSlot} cannot receive a handoff: ${privacy.reason}.`);
  if (to.parent) throw new SwitchRefused(`Steer ${toSlot} has parent ${to.parent}; refusing to make it coordinator`);
  if (to.workspaceId !== status.workspace.id) throw new SwitchRefused(`Steer ${toSlot} is not in the main workspace`);
  const selfTakeover = Boolean(callerId) && callerId === to.id; // the target requests its own takeover: it is the running caller
  if (!selfTakeover && BUSY.has(to.status)) throw new SwitchRefused(`Steer ${toSlot} is ${to.status}`);
  if (from && BUSY.has(from.status)) throw new SwitchRefused(`Active Steer ${from.slot} is ${from.status}; stop it or wait for its turn to end first`);

  let lastMessage = null;
  if (from && !activation) {
    try {
      lastMessage = lastAssistantText(await client.agents.ref(from.id).timeline.refetch({ direction: 'tail', limit: 20 }));
    } catch {
      lastMessage = null;
    }
  }
  const fromInfo = from ?? { slot: expected.activeSteer, id: 'unknown' };
  const gitSnapshot = git && !activation ? readGitSnapshot(git, status.workspace.directory, status.checkpoint?.git ?? null) : null;
  const packet = activation ? '' : handoffWithBrief(status, { from: fromInfo, to, epoch: expected.epoch, git: gitSnapshot, lastMessage, language }, { discovery, git, language, config, workerModel, quotaSnapshot, quotaWarnPct, zerosub, promptOptions });
  const result = {
    repo: status.repo, workspaceId: status.workspace.id, from: fromInfo.slot, to: toSlot,
    fromId: from?.id ?? null, toId: to.id, epoch: expected.epoch + 1, packet,
    packetChars: packet.length, checkpoint: Boolean(status.checkpoint?.task), checkpointAt: checkpointStamp(status.checkpoint),
    applied: false, delivered: false, deliveryError: null, deliveryPending: false, deliveryBlocked: false, reply: null, previousNotified: false, selfTakeover, renameError: null,
    ...(activation ? { deliveryDetail: null } : {}),
  };
  if (!apply) return result;

  const workspace = client.workspaces.ref(status.workspace.id);
  let switchAction = null;
  await lock(workspaceLockName(status.workspace.id), async (held) => {
    const { metadata, state: fresh, holder, agents } = await guardSteerScope({
      client, held, workspaceId: status.workspace.id, scopeId: expected.scope?.id ?? status.repo,
      epoch: expected.epoch, slot: expected.activeSteer, agentId: from?.id, expectVacant: Boolean(activation && !from),
      aliases: discoveryScopeAliases(discovery), config,
    });
    if (fresh.workerHandover) throw new SwitchRefused('A previous worker handover is still being reconciled');
    if (holder && (BUSY.has(holder.status) || holder.activeTurn)) throw new SwitchRefused(`Active Steer ${from.slot} is running; stop it or wait for its turn to end first`);
    const entries = metadata[AGENTS_KEY] ?? {};
    const outgoingEntry = holder ? entries[holder.id] : null;
    const outgoing = readSteerAction(outgoingEntry);
    if ((activation || outgoing?.kind === 'activate') && outgoing?.phase !== 'done' &&
        (outgoing?.attemptedAt || outgoing?.rewindAttempt || ['renewing', 'uncertain', 'sent'].includes(outgoing?.phase) ||
          readCleanupAction(outgoingEntry) || unsettledAccountMove(outgoing))) {
      throw new SwitchRefused('The active steer has an operation awaiting reconciliation. Try again after it settles.');
    }
    const liveTarget = scopeHolder({ agents, workspaceId: status.workspace.id, scopeId: expected.scope?.id ?? status.repo, slot: toSlot, aliases: discoveryScopeAliases(discovery) });
    if (isAdvisorSteer(config, liveTarget.labels, liveTarget.metadata)) throw new SwitchRefused(`Steer ${toSlot} is an advisor and cannot coordinate`);
    if (liveTarget.id !== to.id || (!selfTakeover && (BUSY.has(liveTarget.status) || liveTarget.activeTurn))) throw new SwitchRefused(`Steer ${toSlot} changed or is running; rerun the switch`);
    const admission = admitTarget ? await admitTarget(liveTarget) : steerPrivacyAdmission(config, liveTarget, discoveredRepoPublic(discovery));
    if (!admission.allowed) throw new SwitchRefused(`Steer ${toSlot} cannot receive a handoff: ${admission.reason}.`);
    if (activation) await activation.check({ target: liveTarget, holder, entries });
    if (callerId && !selfTakeover) {
      if (callerId !== from?.id) throw new SwitchRefused('Only the active steer or the takeover target may request this switch');
    }
    const next = { ...fresh, activeSteer: toSlot, activeAgentId: to.id, epoch: fresh.epoch + 1, previousSteer: fresh.activeSteer, switchedAt: now().toISOString() };
    let targetEntry = entries[to.id];
    if (!selfTakeover && (send || stage)) {
      const prior = readSteerAction(targetEntry);
      // P5 can retain a composer stage beside the current delivery. Preserve a
      // claim even after an epoch change or when recovery reopened the stage.
      const stages = [prior?.phase === 'staged' ? prior : null, targetEntry?.stagedBrief];
      if ((prior && !['done', 'staged'].includes(prior.phase)) ||
          stages.some((brief) => brief && (brief.phase !== 'staged' || brief.attemptedAt || brief.rewindAttempt ||
            brief.batch || brief.cleanup || brief.accountMove || brief.composerClaim || brief.manualComposerOnly))) {
        throw new SwitchRefused('Target has a pending steer delivery; finish it before switching');
      }
      switchAction = newSteerAction({ kind: activation ? 'activate' : stage ? 'stage' : 'switch', epoch: next.epoch, at: next.switchedAt,
        text: activation ? undefined : packet, note: `Handoff from Steer ${fromInfo.slot} to Steer ${toSlot} in round ${next.epoch}.`, phase: stage ? 'staged' : 'reserved' });
      if (activation) switchAction.routing = { intent: { mode: 'explicit', agentId: to.id,
        provider: liveTarget.provider, model: liveTarget.model ?? undefined } };
      switchAction.needsResumeAt = targetEntry?.needsResume?.at ?? null;
      if (!stage) switchAction.authority = { scopeId: expected.scope?.id ?? status.repo, agentId: to.id };
      if (prior?.phase === 'done') switchAction.lastDeliveryId = prior.wakeId;
      else if (prior?.lastDeliveryId) switchAction.lastDeliveryId = prior.lastDeliveryId;
      if (stage) switchAction.stageKind = 'switch';
      if (targetEntry?.stagedBrief) targetEntry = { ...targetEntry, stagedBrief: null };
    }
    if (selfTakeover) await checkSelfTakeover?.();
    const scopeId = fresh.scope?.id ?? status.repo;
    const workers = planWorkerHandover({ agents, scopeId, workspaceId: status.workspace.id,
      fromId: holder?.id ?? fresh.activeAgentId, fromSlot: fresh.activeSteer, aliases: discoveryScopeAliases(discovery) });
    if (workers.length) next.workerHandover = { toId: to.id, epoch: next.epoch, scopeId, workers };
    held.verify(); // commit authority and delivery intent together
    await workspace.setMetadata({ [METADATA_KEY]: next, ...(switchAction ? { [AGENTS_KEY]: { ...entries, [to.id]: actionEntry(targetEntry, switchAction) } } : {}) });
    const writtenMeta = (await workspace.refresh())?.metadata;
    const written = writtenMeta?.[METADATA_KEY];
    if (written?.epoch !== next.epoch || written?.activeSteer !== toSlot) throw new Error('Steer switch not verifiable after write');
    if (activation && (written.activeAgentId !== to.id || readSteerAction(writtenMeta?.[AGENTS_KEY]?.[to.id])?.wakeId !== switchAction?.wakeId)) {
      throw new Error('Steer activation receipt not verifiable after write');
    }
    if (workers.length) {
      try {
        await finishWorkerHandover({ client, workspaceId: status.workspace.id, state: written, held, paseoCli });
      } catch {
        result.workerHandoverPending = true;
      }
    }
  });
  result.applied = true;
  result.renameError = applyActiveMarker({
    paseoCli, marker: activeMarker(config),
    mark: { id: to.id, title: to.title ?? null, slot: toSlot },
    unmark: from ? { id: from.id, title: from.title ?? null, slot: from.slot } : null,
  });
  if (result.workerHandoverPending) {
    const detail = 'Worker transfer is pending. Factory will retry before sending the handover brief.';
    return { ...result, deliveryPending: Boolean(send && !selfTakeover), deliveryError: detail,
      ...(activation ? { deliveryDetail: detail } : {}), ...(stage && switchAction ? { stageId: switchAction.wakeId } : {}) };
  }
  let deliveryId = null;
  if (send && !selfTakeover) { // never message oneself; the brief is only returned
    try {
      if (deliverSteer) {
        const outcome = await deliverSteer({
          workspaceId: status.workspace.id, agentId: to.id, epoch: result.epoch, text: packet, actionId: switchAction.wakeId,
          renewalNote: `Handoff from Steer ${fromInfo.slot} to Steer ${toSlot} in round ${result.epoch}.`,
        });
        result.delivered = outcome.status === 'sent';
        deliveryId = outcome.deliveryId ?? null;
        result.deliveryPending = outcome.status === 'pending';
        result.deliveryBlocked = outcome.status === 'blocked';
        if (activation) result.deliveryDetail = outcome.recordingError ?? (result.delivered ? null : outcome.detail);
        if (result.deliveryBlocked) result.deliveryError = outcome.detail;
      } else {
        await updateAgentEntry({ client, workspaceId: status.workspace.id, agentId: to.id, lock,
          patch: (entry) => entry?.action?.wakeId === switchAction.wakeId ? { action: { ...entry.action, phase: 'ready' } } : null });
        const outcome = await reconcileSteerSend({ client, workspaceId: status.workspace.id, agentId: to.id, actionId: switchAction.wakeId, lock,
          validate: async () => {
            const agent = (await client.agents.ref(to.id).refresh())?.agent;
            if (!agent || agent.archivedAt) return false;
            const admission = admitTarget ? await admitTarget(agent) : steerPrivacyAdmission(config, agent, discoveredRepoPublic(discovery));
            return admission.allowed;
          } });
        result.delivered = outcome.status === 'sent';
        result.deliveryPending = !result.delivered;
        if (!result.delivered) result.deliveryError = outcome.detail ?? 'Handoff delivery is pending.';
      }
    } catch (error) {
      result.deliveryError = error.message;
    }
  }
  if (notifyPrevious && from) {
    try {
      const text = previousSteerNotice(to, result.epoch, language);
      if (deliverSteer) {
        const outcome = await deliverSteer({ workspaceId: status.workspace.id, agentId: from.id, epoch: result.epoch, text });
        result.previousNotified = outcome.status === 'sent';
        if (outcome.status !== 'sent') result.previousNoticeDetail = outcome.detail;
      } else {
        const previous = (await client.agents.ref(from.id).refresh())?.agent;
        const admission = previous && (admitTarget ? await admitTarget(previous) : steerPrivacyAdmission(config, previous, discoveredRepoPublic(discovery)));
        if (admission?.allowed) {
          await client.agents.ref(from.id).send(text);
          result.previousNotified = true;
        }
      }
    } catch {
      result.previousNotified = false;
    }
  }
  if (wait && !selfTakeover) {
    const deadline = Date.now() + waitTimeoutMs;
    if (result.deliveryPending && deliveryId) {
      result.deliveryError = await waitForSwitchDelivery(workspace, to.id, deliveryId, result.epoch, deadline);
      result.delivered = result.deliveryError === null;
      result.deliveryPending = !result.delivered && result.deliveryError.startsWith('Timed out');
    }
    if (result.delivered) {
      const handle = client.agents.ref(to.id);
      await handle.waitForFinish(Math.max(1, deadline - Date.now()));
      result.reply = lastAssistantText(await handle.timeline.refetch({ direction: 'tail', limit: 20 }));
    }
  }
  return stage && switchAction ? { ...result, stageId: switchAction.wakeId } : result;
}

function rewindRequired(slot, workerId = null) {
  const target = workerId ? `--worker ${workerId}` : `--slot ${slot}`;
  return new SwitchRefused(`An in-place rewind is unavailable for this session. Use /factory fresh ${target} --keep-chat-history to preview and confirm a replacement.`);
}

/**
 * Reads the rewind point for a fresh preview without side effects. Returns
 * the previous resume brief or first user_message id, or null when the daemon is
 * unreachable, or the agent has no user message (send-only history).
 */
async function previewRewindPoint(fromId, rewindClient, previousBriefId) {
  if (typeof rewindClient !== 'function' || !fromId) return null;
  try {
    return await readRewindPoint(fromId, { createClient: rewindClient, previousBriefId, requireSupport: true });
  } catch {
    return null;
  }
}

function rewindFallbackWarning(fromId, outcomeStatus) {
  if (outcomeStatus === 'no-point') return `No rewind point for ${fromId} (send-only history has no user message); falling back to a new agent`;
  if (outcomeStatus === 'unsupported') return `Rewind is not supported for ${fromId}; falling back to a new agent`;
  return `Rewind check unavailable for ${fromId}; falling back to a new agent`;
}

/**
 * Runs the same-tab rewind and records it in `wsf.agents`. Intent is stored
 * before the first effect; a crash leaves phase `rewinding`, which blocks a
 * repeat like `uncertain`. `failed` throws with the packet kept (uncertain
 * outcome, no new agent); anything but `rewound` means the caller falls back
 * to the new-agent path. A landed rewind is recorded even when the brief send
 * failed (the rewind stands; resend the packet manually). With `send: false`
 * the rewind lands without sending a brief. Stage-only RPCs save the packet
 * in the same write that settles the rewind.
 */
async function runTabRewind({ client, workspaceId, agentId, packet, checkpoint, lock, now, rewindClient, previousBriefId, checkPrivacy, send = true, stageRewind = false, note = null, authority = null, confirmRewind = null }) {
  const workspace = client.workspaces.ref(workspaceId);
  const actionId = crypto.randomUUID();
  const action = await lock(workspaceLockName(workspaceId), async (held) => {
    if (authority) await guardSteerScope({ client, held, workspaceId, agentId, ...authority });
    if (authority?.callerId) {
      if (authority.callerId !== agentId) throw new SwitchRefused('Only the active steer may request active Fresh');
    }
    const metadata = (await workspace.refresh())?.metadata ?? {};
    const agents = metadata[AGENTS_KEY] ?? {};
    const entry = agents[agentId] ?? {};
    const previous = readSteerAction(entry);
    if (readCleanupAction(entry) || (previous && !['done', 'staged'].includes(previous.phase))) {
      throw new SwitchRefused('An existing agent action needs reconciliation before rewind');
    }
    const epoch = metadata[METADATA_KEY]?.epoch ?? null;
    const staged = readStagedSteerBrief(entry);
    if (stageRewind && staged?.epoch === epoch && staged.composerClaim) throw new SwitchRefused('A brief transfer to the composer is already pending');
    const reserved = { kind: 'rewind', wakeId: actionId, phase: 'rewinding', queuedAt: now().toISOString(), epoch, packet, previousBriefId: previousBriefId ?? null, previousAction: previous };
    held.verify();
    await workspace.setMetadata({ [AGENTS_KEY]: { ...agents, [agentId]: actionEntry(entry, reserved) } });
    return reserved;
  });
  let privacyError;
  const outcome = await rewindAndBrief(agentId, packet, {
    createClient: rewindClient, previousBriefId, skipBrief: !send, messageId: actionId,
    beforeRewind: async (point) => {
      try {
        await checkPrivacy(agentId);
        await confirmRewind?.(point);
        return true;
      } catch (error) {
        privacyError = error;
        return false;
      }
    },
    beforeBrief: () => checkPrivacy(agentId),
  });
  if (outcome.status === 'rewound') {
    const receipt = { kind: 'rewind', at: now().toISOString(), messageId: outcome.messageId,
      briefMessageId: outcome.briefMessageId ?? null, ...(outcome.sendError ? { sendError: outcome.sendError } : {}),
      checkpointAt: checkpoint?.capturedAt ?? checkpoint?.updatedAt ?? null, note, stage: stageRewind };
    try {
      await workspace.setMetadata({ [effectReceiptKey(actionId)]: receipt });
      const entry = await retryOnLockBusy(() => settleRewindReceipt({ client, workspaceId, agentId, actionId, lock }));
      if (entry?.action?.wakeId !== actionId) throw new SwitchRefused('Rewind action changed while running; outcome needs attention');
      return { outcome, ...(entry.action.phase === 'staged' ? { stageId: actionId } : {}) };
    } catch (error) {
      return { outcome, recordingError: `Rewind applied. Factory could not confirm its record (${error.message}).` };
    }
  }
  await retryOnLockBusy(() => updateAgentEntry({ client, workspaceId, agentId, lock, patch: (entry) => {
    if (entry?.action?.wakeId !== actionId) throw new SwitchRefused('Rewind action changed while running; outcome needs attention');
    const preDispatch = ['no-point', 'no-op', 'unsupported', 'unavailable', 'deferred'].includes(outcome.status);
    if (preDispatch) return { action: action.previousAction ?? null };
    const { previousAction: _dropped, ...attempt } = action;
    return { action: { ...attempt, phase: 'uncertain', lastError: outcome.error ?? 'Rewind outcome could not be confirmed' } };
  } }));
  if (privacyError) throw privacyError;
  if (outcome.status === 'failed') {
    const error = new SwitchRefused(`Rewind of ${agentId} has an uncertain outcome (${outcome.error ?? 'unknown error'}); inspect the agent before recovery`);
    error.packet = packet;
    error.refreshMode = 'rewind';
    throw error;
  }
  return { outcome };
}

async function rewindIdentity({ client, status, expected, from, slot, checkpointAt, intent, point, recheck = false, worker = false }) {
  const agent = (await client.agents.ref(from.id).refresh?.())?.agent;
  if (recheck) {
    if (freshSourceChanged(from, agent)) throw new SwitchRefused('Fresh source changed before rewind; reopen the preview');
    const metadata = (await client.workspaces.ref(status.workspace.id).refresh())?.metadata;
    checkpointAt = worker ? metadata?.[AGENTS_KEY]?.[from.id]?.noteAt ?? null : checkpointStamp(metadata?.[CHECKPOINT_KEY]);
  }
  const live = freshLiveRoute(agent ?? from);
  return {
    repo: status.repo, workspaceId: status.workspace.id, slot, from: from.id, epoch: expected.epoch,
    provider: live.provider, model: live.model, checkpointAt, refreshMode: 'rewind',
    rewindSupported: agent?.capabilities?.supportsRewindConversation !== false,
    routeBinding: { live, intent, sessionId: agent?.persistence?.sessionId ?? null, point },
  };
}

/**
 * Same-tab rewind for the ACTIVE steer: no takeover, no epoch change, the
 * agent keeps its tab, id and labels. Returns the fresh result (preview,
 * applied, or idempotent double-click), or `{ fallback }` when the caller
 * must continue with the new-agent path. With `requireRefreshMode: 'rewind'`
 * a failed rewind throws instead of falling back (the packet travels on the
 * error for the caller to keep); the preview path still reports fallback.
 */
async function tryActiveRewind({ client, discovery, status, expected, slot, from, config = null, apply, send = true, stageRewind = false, language, git, lock, now, workerModel, rewindClient, checkPrivacy, requireRefreshMode = null, promptOptions, callerId = null, confirmPreview, intent }) {
  const agentState = discovery.mainWorkspace?.metadata?.[AGENTS_KEY] ?? null;
  const entry = agentState?.[from.id] ?? null;
  const previousBriefId = actionFact(entry, 'refreshed')?.briefMessageId;
  const gitSnapshot = git ? readGitSnapshot(git, status.workspace.directory, status.checkpoint?.git ?? null) : null;
  const checkpoint = Boolean(status.checkpoint?.task);
  const identity = (point, recheck = false) => rewindIdentity({ client, status, expected, from, slot: slot,
    checkpointAt: checkpointStamp(status.checkpoint), intent, point, recheck });
  const current = await identity(null);
  if (!current.rewindSupported) return { fallback: 'unsupported' };
  if (!routeMatchesIntent(current.routeBinding.live, intent)) return { fallback: 'route changed' };
  const confirmRewind = async (point) => {
    const current = await identity(point, true);
    if (!current.rewindSupported) throw new SwitchRefused('This provider no longer supports conversation rewind for this session.');
    if (!routeMatchesIntent(current.routeBinding.live, intent)) throw new SwitchRefused('Requested rewind route changed');
    confirmPreview?.(current);
  };
  if (!apply) {
    const point = await previewRewindPoint(from.id, rewindClient, previousBriefId);
    if (!point) return { fallback: 'unavailable' };
    const route = await identity(point);
    if (!route.rewindSupported) return { fallback: 'unsupported' };
    if (!routeMatchesIntent(route.routeBinding.live, intent)) return { fallback: 'route changed' };
    await checkPrivacy(from.id);
    const packet = buildRefreshPacket(status, {
      kind: 'steer', slot, from, to: { id: from.id }, epoch: expected.epoch, git: gitSnapshot,
      note: entry?.note ?? null, noteAt: entry?.noteAt ?? null,
      lastMessage: await hintOf(client, from.id), language, workerModel, rewound: true, promptOptions,
    });
    return {
      repo: status.repo, workspaceId: status.workspace.id, slot, kind: 'steer', from: from.id, to: from.id, epoch: expected.epoch, epochBumped: false, profile: null,
      provider: from.provider, model: from.model, idempotencyKey: null, packet, packetChars: packet.length,
      checkpoint, checkpointAt: checkpointStamp(status.checkpoint),
      applied: false, delivered: false, deliveryError: null, previousNotified: false, reused: false, renameError: null,
      warnings: [], fallbackFrom: null, profileSuggestion: null, refreshMode: 'rewind', rewindPoint: point, ...route,
    };
  }
  const idem = freshRewindIdempotent(entry);
  if (idem) {
    return {
      repo: status.repo, slot, kind: 'steer', from: from.id, to: from.id, epoch: expected.epoch, epochBumped: false, profile: null,
      provider: from.provider, model: from.model, idempotencyKey: null, packet: '', packetChars: 0,
      checkpoint, applied: false, idempotent: true, idempotentReason: idem, delivered: false, deliveryError: null,
      previousNotified: false, reused: false, renameError: null, warnings: [], fallbackFrom: null, profileSuggestion: null,
      refreshMode: 'rewind',
    };
  }
  const packet = buildRefreshPacket(status, {
    kind: 'steer', slot, from, to: { id: from.id }, epoch: expected.epoch, git: gitSnapshot,
    note: entry?.note ?? null, noteAt: entry?.noteAt ?? null,
    lastMessage: await hintOf(client, from.id), language, workerModel, rewound: true, promptOptions,
  });
  const { outcome, recordingError, stageId } = await runTabRewind({ client, workspaceId: status.workspace.id, agentId: from.id, packet, checkpoint: status.checkpoint, lock, now, rewindClient, previousBriefId, send, stageRewind, checkPrivacy, confirmRewind,
    authority: { scopeId: expected.scope?.id ?? status.repo, epoch: expected.epoch, aliases: discoveryScopeAliases(discovery), callerId, config } });
  if (outcome.status !== 'rewound') {
    if (requireRefreshMode === 'rewind') {
      const error = new SwitchRefused(`Bound rewind route failed (${outcome.status}${outcome.error ? `: ${outcome.error}` : ''}). ${rewindRequired(slot).message} The brief is kept.`);
      error.packet = packet;
      error.refreshMode = 'rewind';
      throw error;
    }
    return { fallback: outcome.status };
  }
  return {
    repo: status.repo, slot, kind: 'steer', from: from.id, to: from.id, epoch: expected.epoch, epochBumped: false, profile: null,
    provider: from.provider, model: from.model, idempotencyKey: null, packet, packetChars: packet.length,
    checkpoint, applied: true, delivered: send && !outcome.sendError, deliveryError: outcome.sendError ?? null,
    previousNotified: false, reused: false, renameError: null,
    warnings: [], fallbackFrom: null, profileSuggestion: null, refreshMode: 'rewind',
    rewindPoint: outcome.messageId ?? null, briefMessageId: outcome.briefMessageId ?? null,
    ...(recordingError ? { recordingError } : {}), ...(stageId ? { stageId } : {}),
  };
}

// Before Fresh requests were reserved, the key digest came from slot profiles
// (or a worker's unique matching preset). A visible replacement supplies
// additional evidence if the preset has since been removed or changed.
async function legacyFreshReceipt({ sources, single, kind, slot, status, config, policy, roleOf, context, intent, lookupReceipt, metadata, stamp, possibleLegacyWorkers, readSource }) {
  const activeHolderId = metadata[METADATA_KEY]?.activeAgentId;
  const profiles = Object.values(config?.profiles ?? {});
  const seen = new Set();
  const ordered = [...sources].sort((a, b) => Number(b.id === activeHolderId) - Number(a.id === activeHolderId));
  for (const from of single ? [single] : ordered) {
    const role = roleOf(from);
    const args = context(from, config, role);
    const worker = kind === 'worker';
    const matching = profiles.filter((p) => p.provider === from.provider && p.model === from.model);
    const workerRoute = { provider: from.provider, model: from.model,
      mode: matching.length === 1 ? matching[0].mode : null,
      thinking: matching.length === 1 ? matching[0].thinking : null };
    const legacy = worker ? workerRoute : resolveProfile(config, policy.providers, steerFallbackList(config, slot), {
      ...policy, role: 'steer', advisorSlot: role === 'advisor',
      usedProfiles: usedProfilesByLiveSteers(config, status.steers.filter((s) => s.slot !== slot)),
    }).profile;
    const routes = legacy ? [{ route: legacy, title: args.title }] : [];
    for (const other of [...sources.filter((source) => source.id !== from.id), ...possibleLegacyWorkers]) {
      const live = freshLiveRoute(await readSource(other) ?? other);
      const { options: _unused, ...observable } = live;
      for (const route of [observable, { ...observable, thinking: null }, { ...observable, mode: null },
        { ...observable, thinking: null, mode: null }, ...profiles.filter((p) => p.provider === live.provider && p.model === live.model)]) {
        routes.push({ route, title: other.title });
      }
    }
    for (const { route, title } of routes) {
      if (!route.provider || !route.model) continue;
      const { op, placement } = replacementRequest({ ...args, route, title, legacy: true });
      const key = op.params.idempotencyKey;
      if (seen.has(key)) continue;
      const receipt = await lookupCreation(lookupReceipt, 'agent', key, freshLookupFail);
      if (!receipt) {
        seen.add(key);
        continue;
      }
      const id = checkedCreationReceipt(receipt, key, freshRecoveryFail);
      if (id === from.id && !single) continue;
      if (!single && (sources.length !== 2 || !sources.some((source) => source.id === id))) {
        throw freshRecoveryFail('the receipt does not identify the replacement in this slot');
      }
      if (!routeMatchesIntent(placement, intent)) throw freshRecoveryFail('the existing creation receipt is outside the explicitly requested route');
      if (!worker && id !== from.id) {
        const created = receipt.agent ?? await readSource({ id });
        const originalRole = created?.metadata?.[LABEL.steerRole];
        if (originalRole === 'advisor' || originalRole === 'coordinator') op.params.steerRole = originalRole;
      }
      return { from, receipt, record: {
        kind, slot, epoch: args.epoch, intent, op, placement, profile: route.name ?? null, selection: 'legacy', evidence: [],
        checkpointAt: stamp(metadata, from), binding: { live: freshLiveRoute(from), request: op.params, account: null, intent },
      } };
    }
  }
  return null;
}

function freshSourceRecord(metadata, sources, kind, expected, slot, active = false) {
  const records = sources.flatMap((source) => {
    const record = metadata?.[AGENTS_KEY]?.[source.id]?.freshCreation;
    if (record?.kind !== kind || record.slot !== slot) return [];
    const committed = active && record.replacementId && record.replacementId === expected.activeAgentId &&
      record.epoch === expected.epoch - 1 && sources.some((agent) => agent.id === record.replacementId);
    return record.epoch === expected.epoch || committed ? [{ source, record, committed }] : [];
  });
  if (records.length > 1) throw freshRecoveryFail('multiple replacement attempts for this slot');
  return records[0] ?? null;
}

function replacementRequest({ source, route, role, slot, owner, scopeId, repo, workspaceId, epoch, active, title, legacy = false }) {
  const worker = role === 'worker';
  const steerRole = worker ? null : role;
  const parent = worker ? source.parent : null;
  const part = `fresh-e${epoch}${active ? '' : `-${shortHolderId(source.id)}`}`;
  const labels = { [LABEL.scope]: scopeId, [LABEL.role]: 'worker', [LABEL.owner]: owner };
  if (worker) {
    const request = { workspaceId, title, labels, config: profileAgentConfig(route), ...(parent ? { parent } : {}) };
    const key = idempotencyKey(repo, 'worker', owner, part, requestDigest(request));
    return {
      op: { key: `worker.${source.id}.fresh`, kind: 'paseo.agent.createWorker',
        params: { ...request, parent, clearInheritedParent: true, idempotencyKey: key, ...(!legacy ? { recordedCreationMetadata: true } : {}) } },
      placement: { workspaceId, labels, parent, provider: route.provider, model: route.model },
    };
  }
  const creation = buildSteerCreate({
    keyScope: repo, repo, scopeId, slot, workspaceId, profile: route, title, keyParts: ['steer', slot, part],
    metadata: legacy ? null : { [LABEL.steerRole]: steerRole },
  });
  return {
    op: { key: `steer.${slot}.fresh`, kind: 'paseo.agent.create',
      params: { ...creation.request, clearInheritedParent: true, steerRole, idempotencyKey: creation.idempotencyKey,
        ...(!legacy ? { recordedCreationMetadata: true } : {}) } },
    placement: creation.expected,
  };
}

function freshSourceChanged(before, current) {
  return current?.id !== before.id || current.archivedAt || current.background === true || BUSY.has(current.status) || current.activeTurn || current.pendingPermissions?.length ||
    (current.workspaceId && current.workspaceId !== before.workspaceId) || parentOf(current) !== before.parent;
}

async function replacementFresh({ client, discovery, config, status, expected, kind, slot = null, active = false,
  single, sources, owner = null, apply, lookupReceipt, execute, lock, now, callerId = null, policy, intent,
  confirmPreview, readPolicy, archivePrevious }) {
  const workspaceId = status.workspace.id;
  const workspace = client.workspaces.ref(workspaceId);
  const scopeId = discovery.scope?.id ?? status.repo;
  const ambiguous = () => new SwitchRefused(`Steer ${slot} has several live agents (${sources.map((s) => s.id).join(', ')}); retry an interrupted Fresh or resolve the duplicate titles in Paseo`);
  const metadataAtPreview = discovery.mainWorkspace?.metadata;
  const context = (source, config, role) => ({
    source, scopeId, repo: status.repo, workspaceId: kind === 'worker' ? source.workspaceId ?? workspaceId : workspaceId,
    slot, owner, active, role, epoch: expected.epoch,
    title: kind === 'worker' ? source.title ?? 'Worker' : active ? markSteerTitle(`Steer ${slot}`, activeMarker(config)) : `Steer ${slot}`,
  });
  const roleOf = (source) => kind === 'worker' ? 'worker' : source.advisor ? 'advisor' : 'coordinator';
  const stamp = (metadata, source) => kind === 'worker'
    ? metadata?.[AGENTS_KEY]?.[source.id]?.noteAt ?? null : checkpointStamp(metadata?.[CHECKPOINT_KEY]);
  const resolve = (source, agent, observed, metadata) => {
    const role = roleOf(source);
    const picked = freshCreationRoute({ ...observed, from: agent, role, slot, steers: status.steers, metadata, now: now().getTime(), intent });
    if (picked.error) throw new SwitchRefused(picked.error);
    const { route, live, profile, source: selection, account, evidence } = picked;
    const liveAccount = observed.zerosub?.agentAccount?.[agent.id] ?? agent.metadata?.[ACCOUNT_METADATA_KEY] ?? null;
    const managedAccount = Boolean(liveAccount || account || agent.metadata?.['zerosub.agent']);
    const { op, placement } = replacementRequest({ ...context(source, observed.config, role), route });
    return {
      kind, slot, epoch: expected.epoch, intent, op, placement, profile, selection, evidence,
      checkpointAt: stamp(metadata, source),
      binding: { live, request: op.params, liveAccount, account, managedAccount, intent },
    };
  };
  const resultOf = (source, record) => ({
    repo: status.repo, workspaceId, slot: slot ?? owner, kind, from: source.id,
    ...(kind === 'worker' ? { workerId: source.id, owner } : {}),
    to: null, epoch: record.epoch + (active ? 1 : 0), epochBumped: active,
    profile: record.profile, provider: record.placement.provider, model: record.placement.model,
    idempotencyKey: record.op.params.idempotencyKey, routeBinding: record.binding ? { ...record.binding, archivePrevious: true } : null,
    routeEvidence: record.evidence, checkpointAt: record.checkpointAt,
    refreshMode: 'new-agent',
    warnings: roleOf(source) === 'advisor' ? [`Steer ${slot} is an advisor; advisors never coordinate`] : [],
    fallbackFrom: null,
    profileSuggestion: null,
    applied: apply, delivered: false, deliveryError: null, previousNotified: false, reused: false, renameError: null,
  });
  const readSource = async (source) => (await client.agents.ref(source.id).refresh?.())?.agent;
  const possibleLegacyWorkers = kind === 'worker' ? status.workers.filter((agent) => single && agent.id !== single.id &&
    agent.title === single.title && agent.workspaceId === single.workspaceId &&
    agent.parent === single.parent && agent.owner === owner) : [];
  const legacyReceipt = (metadata) => legacyFreshReceipt({ sources, single, kind, slot, status, config, policy,
    roleOf, context, intent, lookupReceipt, metadata, stamp, possibleLegacyWorkers, readSource });
  const validateIntent = (record) => {
    if (!isDeepStrictEqual(record.intent, intent)) throw freshRecoveryFail('another route was originally requested; reconcile that Fresh attempt first');
  };
  if (!apply) {
    const pending = freshSourceRecord(metadataAtPreview, sources, kind, expected, slot, active) ??
      ((!single || possibleLegacyWorkers.length) && lookupReceipt ? await legacyReceipt(metadataAtPreview) : null);
    const from = pending?.source ?? pending?.from ?? single;
    if (!from) throw ambiguous();
    if (pending) validateIntent(pending.record);
    const record = pending?.record ?? resolve(from, await readSource(from) ?? from, policy, metadataAtPreview);
    const result = resultOf(from, record);
    if (pending?.committed) Object.assign(result, { to: expected.activeAgentId, epochBumped: false });
    return { from, result };
  }

  if (!archivePrevious) throw new SwitchRefused('Confirm a Fresh preview that archives the previous agent.');
  const run = execute ?? createExecutors({ client, lookupReceipt });
  return lock(workspaceLockName(workspaceId), async (held) => {
    const metadata = (await workspace.refresh())?.metadata ?? {};
    const current = metadata[METADATA_KEY];
    if (current?.workerHandover) throw new SwitchRefused('A worker handover is still being reconciled');
    if (!current || current.activeSteer !== expected.activeSteer || current.epoch !== expected.epoch ||
        (expected.scope && !sameScopeId(current.scope?.id, expected.scope.id)) ||
        (current.scope && !sameScopeId(current.scope.id, scopeId))) {
      throw new SwitchRefused('Steer state changed since discovery; repeat Fresh');
    }
    const pending = freshSourceRecord(metadata, sources, kind, expected, slot, active);
    let from = pending?.source ?? single;
    let record = pending?.record;
    let receipt = null;
    if (record) {
      validateIntent(record);
      receipt = await lookupCreation(lookupReceipt, 'agent', record.op.params.idempotencyKey, freshLookupFail);
    } else {
      // Old installations had no reservation. Look up their original
      // request shape before allowing a new one (including the old key).
      const legacy = await legacyReceipt(metadata);
      if (legacy) ({ from, record, receipt } = legacy);
    }
    if (!from) throw ambiguous();
    const receiptId = receipt ? checkedCreationReceipt(receipt, record.op.params.idempotencyKey, freshRecoveryFail) : null;
    if (receiptId === from.id) throw freshRecoveryFail('the receipt names the source itself');
    if (pending?.committed) {
      if (!receiptId || receiptId !== current.activeAgentId || record.replacementId !== receiptId) {
        throw freshRecoveryFail('the committed authority does not match the original receipt');
      }
      await guardSteerScope({ client, held, workspaceId, scopeId: expected.scope?.id ?? status.repo,
        epoch: expected.epoch, agentId: receiptId, excludeIds: [from.id], aliases: discoveryScopeAliases(discovery), config });
      if (callerId && callerId !== receiptId && callerId !== from.id) throw new SwitchRefused('Only the active steer may request active Fresh');
      const result = resultOf(from, record);
      confirmPreview?.(result);
      return { from, result: { ...result, to: receiptId, reused: true, epochBumped: false } };
    }
    if (active && record?.op.params.steerRole === 'advisor') throw freshRecoveryFail('an advisor cannot become active');
    if (typeof client.agents.ref(from.id).archive !== 'function') throw new SwitchRefused('Paseo cannot archive the previous agent.');
    const agent = await readSource(from);
    if (freshSourceChanged(from, agent)) throw new SwitchRefused('Fresh source changed since discovery; repeat Fresh');
    if (kind === 'worker' && ((agent.labels?.[LABEL.owner] !== undefined && agent.labels[LABEL.owner] !== owner) ||
        (record && (record.placement.labels[LABEL.owner] !== owner || record.placement.parent !== from.parent)))) {
      throw new SwitchRefused('Fresh worker ownership changed since discovery');
    }
    let observed = !receipt ? await (readPolicy?.() ?? policy) : policy;
    let holder;
    const aliases = discoveryScopeAliases(discovery);
    if (kind === 'steer') {
      if (active) {
        ({ holder } = await guardSteerScope({ client, held, workspaceId, scopeId: expected.scope?.id ?? status.repo,
          epoch: expected.epoch, agentId: from.id, excludeIds: receiptId ? [receiptId] : [], aliases, config: observed.config }));
        if (current.activeAgentId && current.activeAgentId !== from.id) throw new SwitchRefused('Active steer changed since discovery; repeat Fresh');
        if (callerId && callerId !== from.id) throw new SwitchRefused('Only the active steer may request active Fresh');
      } else {
        const agents = await readPaseoAgents(client);
        holder = scopeHolder({ agents, workspaceId, scopeId: expected.scope?.id ?? status.repo, slot,
          excludeIds: receiptId ? [receiptId] : [], aliases });
        if (holder.id !== from.id) throw new SwitchRefused('Fresh standby changed since discovery');
      }
      const role = isAdvisorSteer(observed.config, holder.labels, holder.metadata) ? 'advisor' : 'coordinator';
      if (active && role === 'advisor') throw new SwitchRefused('An advisor steer cannot hold scope authority');
      if (!receipt && role !== roleOf(from)) throw new SwitchRefused('Fresh source role changed since discovery');
    } else {
      const workerScope = agent.labels?.[LABEL.scope] ?? agent.labels?.[LABEL.repo];
      if (workerScope && ![scopeId, status.repo, ...aliases].some((id) => sameScopeId(id, workerScope))) {
        throw new SwitchRefused('Fresh worker scope changed since discovery');
      }
    }
    if (!receipt) {
      const live = await readSource(from);
      if (freshSourceChanged(from, live)) throw new SwitchRefused('Fresh source changed since discovery; repeat Fresh');
      const currentRoute = resolve(from, live, observed, metadata);
      if (record && !isDeepStrictEqual(record.binding, currentRoute.binding)) {
        throw freshRecoveryFail('the reserved route changed before creation; inspect the original attempt');
      }
      record ??= currentRoute;
    }
    const result = resultOf(from, record);
    const live = freshLiveRoute(agent);
    if (!confirmPreview && (record.binding?.managedAccount || record.binding?.account ||
        agent.metadata?.[ACCOUNT_METADATA_KEY] || agent.metadata?.['zerosub.agent'] ||
        result.provider !== live.provider || result.model !== live.model)) {
      throw new SwitchRefused('Preview and confirm the replacement route and account selection before creating a new agent.');
    }
    confirmPreview?.(result);
    if (!receipt && !pending) {
      const key = record.op.params.idempotencyKey;
      receipt = await lookupCreation(lookupReceipt, 'agent', key, freshLookupFail);
      if (receipt) {
        checkedCreationReceipt(receipt, key, freshRecoveryFail);
        throw freshRecoveryFail('a receipt appeared during apply; reopen Fresh to reconcile it');
      }
      observed = await (readPolicy?.() ?? policy);
      const beforeWrite = await readSource(from);
      if (freshSourceChanged(from, beforeWrite)) throw new SwitchRefused('Fresh source changed since discovery; repeat Fresh');
      if (holder && (isAdvisorSteer(observed.config, { ...holder.labels, ...beforeWrite.labels }, beforeWrite.metadata ?? holder.metadata)
          ? 'advisor' : 'coordinator') !== roleOf(from)) {
        throw new SwitchRefused('Fresh source role changed since discovery');
      }
      const verified = resolve(from, beforeWrite, observed, metadata);
      confirmPreview?.(resultOf(from, verified));
      if (!isDeepStrictEqual(verified.binding, record.binding)) throw new SwitchRefused('Fresh route changed since discovery; reopen the preview');
      const entries = metadata[AGENTS_KEY] ?? {};
      held.verify();
      await workspace.setMetadata({ [AGENTS_KEY]: { ...entries, [from.id]: { ...entries[from.id], freshCreation: record } } });
      const written = (await workspace.refresh())?.metadata?.[AGENTS_KEY]?.[from.id]?.freshCreation;
      if (!isDeepStrictEqual(written, record)) throw freshRecoveryFail('the original request could not be recorded');
      const latest = await readSource(from);
      if (freshSourceChanged(from, latest) || !isDeepStrictEqual(freshLiveRoute(latest), record.binding.live)) {
        throw freshRecoveryFail('the source changed while recording the request; reopen Fresh');
      }
    }
    held.verify();
    const created = receiptId ? (await confirmCreationReceipt(run, record.op, observed.config, receiptId, freshRecoveryFail)).id
      : (await run(record.op, observed.config))?.agentId;
    if (!created) throw new Error('Fresh agent creation returned no agent id');
    await verifyCreatedAgent(client, created, record.placement, freshVerifyFail(created));
    if (active) {
      held.verify();
      const latest = (await workspace.refresh())?.metadata?.[AGENTS_KEY] ?? {};
      await workspace.setMetadata({
        [METADATA_KEY]: { ...current, activeSteer: slot, activeAgentId: created,
          epoch: current.epoch + 1, previousSteer: slot, switchedAt: now().toISOString() },
        [AGENTS_KEY]: { ...latest, [from.id]: { ...latest[from.id], freshCreation: { ...record, replacementId: created } } },
      });
      const written = (await workspace.refresh())?.metadata;
      const writtenScope = written?.[METADATA_KEY];
      if (writtenScope?.epoch !== expected.epoch + 1 || writtenScope.activeAgentId !== created || writtenScope.activeSteer !== slot ||
          written?.[AGENTS_KEY]?.[from.id]?.freshCreation?.replacementId !== created) {
        throw new Error('Fresh steer not verifiable after write');
      }
    }
    return { from, result: { ...result, to: created, reused: !!receiptId } };
  });
}

async function archiveFreshSource(client, agentId) {
  const handle = client.agents.ref(agentId);
  const before = (await handle.refresh())?.agent;
  if (!before || before.archivedAt) return;
  if (BUSY.has(before.status) || before.activeTurn || before.pendingPermissions?.length) {
    throw new SwitchRefused('The previous agent is running. Wait for it to finish, then retry the confirmed Fresh.');
  }
  try {
    const archived = await handle.archive();
    if (archived?.archivedAt) return;
  } catch {
    // The archive may have landed before the reply was lost.
  }
  const after = (await handle.refresh())?.agent;
  if (after && !after.archivedAt) {
    throw new SwitchRefused('The replacement was created, but archiving the previous agent could not be confirmed. Retry Fresh.');
  }
}

async function finishFreshReplacement({ client, workspaceId, sourceId, result, send, stageReplacement, lock, checkPrivacy, authority, messageId }) {
  const agentId = result.to;
  const { packet, epoch } = result;
  const actionId = send ? await reserveFreshPacket({ client, workspaceId, agentId, packet, epoch, lock, authority, messageId }) : null;
  if (!send && stageReplacement) {
    const { stageId } = await stageReplacement({ workspaceId, agentId, packet, epoch });
    result.stageId = stageId;
  }
  await archiveFreshSource(client, sourceId);
  if (actionId) {
    try {
      const delivery = await reconcileFreshDelivery({ client, workspaceId, agentId, actionId, lock, checkPrivacy });
      result.delivered = delivery.status === 'sent';
      if (delivery.recordingError) result.recordingError = delivery.recordingError;
      if (!result.delivered) result.deliveryError = delivery.detail ?? `Fresh delivery ${delivery.status}`;
    } catch (error) {
      result.deliveryError = error.message;
    }
  }
  return result;
}

/**
 * Refreshes the active steer, a standby slot, or a worker. Same-tab rewind
 * is preferred when available and consistent with the requested route.
 * Replacement starts an empty agent using the live route or an explicitly
 * selected route. Before creation, persist the precise request and receipt
 * key under the workspace lock. Only active replacement advances the epoch.
 * `send: false` leaves the brief for the caller to stage or deliver.
 */
export async function freshSteer({ client, discovery, config, apply = false, send = true, stageRewind = false, stageReplacement = null, archivePrevious = false, slot: slotArg = null, workerId = null, language = runtime().handoffLanguage, git, lock = withLock, lookupReceipt, execute, now = () => new Date(), workerModel = null, quotaSnapshot = null, quotaWarnPct = config?.quota?.warnPct ?? QUOTA_DEFAULTS.warnPct, quotaExhaustedPct = config?.quota?.exhaustedPct ?? QUOTA_DEFAULTS.exhaustedPct, zerosub = null, rewindClient = null, requireRefreshMode = null, promptOptions, callerId = null, admitTarget = null, provider = null, model = null, confirmPreview = null, readPolicy = null, repoPublic = discoveredRepoPublic(discovery) }) {
  const status = steerStatus(discovery, { config });
  if (!status.workspace || !status.state) throw new SwitchRefused('No factory main workspace with steer state; run the factory first');
  const expected = status.state;
  const checkPrivacy = (agentId, epoch = expected.epoch) => requireFreshPrivacy({ client, workspaceId: status.workspace.id,
    scopeId: expected.scope?.id, epoch, agentId,
    admitTarget: admitTarget ?? ((agent) => steerPrivacyAdmission(config, agent, repoPublic)),
  });
  const wantSlot = slotArg !== null && slotArg !== undefined && String(slotArg).trim() !== '';
  const wantWorker = workerId !== null && workerId !== undefined && String(workerId).trim() !== '';
  if (wantSlot && wantWorker) throw new SwitchRefused('fresh takes either --slot or --worker, not both');
  if (Boolean(provider) !== Boolean(model)) throw new SwitchRefused('Explicit Fresh needs both provider and model');
  const intent = provider ? { mode: 'explicit', provider, model } : { mode: 'automatic' };
  const policy = { config, providers: discovery.providers, repoPublic,
    quotaSnapshot, quotaExhaustedPct, zerosub };
  const replacement = (options) => replacementFresh({ client, discovery, config, status, expected, apply,
    lookupReceipt, execute, lock, now, callerId, policy, intent, confirmPreview, readPolicy, archivePrevious, ...options });
  const hasPending = (sources, kind, slot = null) =>
    !!freshSourceRecord(discovery.mainWorkspace?.metadata, sources, kind, expected, slot, slot === expected.activeSteer);
  const tryRewind = (source, sources, kind, slot = null) => typeof rewindClient === 'function' && source &&
    requireRefreshMode !== 'new-agent' && !hasPending(sources, kind, slot);
  const rewindArgs = { client, discovery, status, expected, config, apply, send, stageRewind, language, git, lock, now,
    workerModel, rewindClient, checkPrivacy, requireRefreshMode, promptOptions, confirmPreview, intent };
  const target = wantSlot ? String(slotArg).trim().toUpperCase() : expected.activeSteer;
  if (!wantWorker && !/^[A-Z]$/.test(target ?? '')) throw new SwitchRefused(`Not a steer slot: ${JSON.stringify(slotArg)}`);
  const shared = { client, discovery, status, expected, apply, send, stageReplacement, language, git, workerModel,
    lock, now, checkPrivacy, requireRefreshMode, promptOptions, replacement, tryRewind, rewindArgs };
  if (wantWorker) return freshWorkerAgent({ ...shared, workerId: String(workerId).trim() });
  if (target !== expected.activeSteer) return freshNonActiveSteer({ ...shared, slot: target });
  const slot = expected.activeSteer;
  const holders = status.steers.filter((s) => s.slot === slot);
  if (!holders.length) throw new SwitchRefused(`No live Steer ${slot} to refresh for ${status.repo}; plan and apply one first`);
  const live = liveSlotHolders(holders, slot);
  const single = live.length === 1 ? live[0] : null;
  if (single && BUSY.has(single.status)) throw new SwitchRefused(`Active Steer ${slot} is ${single.status}; stop it or wait for its turn to end first`);
  // Same-tab rewind first (when a DaemonClient factory is injected): the
  // agent keeps its tab, id and labels; a new parent-free agent is only the
  // fallback when no rewind point exists or the provider lacks rewind.
  let rewindFallback = null;
  if (tryRewind(single, holders, 'steer', slot)) {
    const rewound = await tryActiveRewind({ ...rewindArgs, slot, from: single, callerId });
    if (rewound && !rewound.fallback) return rewound;
    if (rewound?.fallback) rewindFallback = rewound.fallback;
  }
  if (requireRefreshMode === 'rewind') throw rewindRequired(slot);
  const { from, result } = await replacement({ kind: 'steer', active: true, slot, single, sources: holders });
  const gitSnapshot = git ? readGitSnapshot(git, status.workspace.directory, status.checkpoint?.git ?? null) : null;
  result.checkpoint = Boolean(status.checkpoint?.task);
  if (rewindFallback) {
    result.rewindFallback = rewindFallback;
    result.warnings.push(rewindFallbackWarning(from.id, rewindFallback));
  }
  if (!apply) {
    result.packet = handoffWithBrief(status, { from, to: { slot, id: result.to ?? 'new agent, created on apply' }, epoch: result.epoch - 1, git: gitSnapshot, lastMessage: await hintOf(client, from.id), language }, { discovery, git, language, workerModel, quotaSnapshot, quotaWarnPct, zerosub, promptOptions });
    result.packetChars = result.packet.length;
    return result;
  }
  const freshId = result.to;
  result.packet = handoffWithBrief(status, { from, to: { slot, id: freshId }, epoch: result.epoch - 1, git: gitSnapshot, lastMessage: await hintOf(client, from.id), language }, { discovery, git, language, workerModel, quotaSnapshot, quotaWarnPct, zerosub, promptOptions });
  result.packetChars = result.packet.length;
  return finishFreshReplacement({
    client, workspaceId: status.workspace.id, sourceId: from.id, result, send, stageReplacement, lock, checkPrivacy,
    authority: { scopeId: expected.scope?.id ?? status.repo, agentId: freshId },
  });
}

/**
 * Same-tab rewind for a NON-active steer or a worker: the agent keeps its
 * tab, id and labels, no epoch change. Returns the fresh result (preview,
 * applied, or idempotent double-click), or `{ fallback }` when the caller
 * must continue with the new-agent path. `packetArgs` carries the
 * kind-specific buildRefreshPacket fields (slot or owner/title).
 */
async function tryTabRewind({ client, discovery, status, expected, from, kind, packetArgs, apply, send = true, stageRewind = false, language, git, lock, now, workerModel, rewindClient, checkPrivacy, requireRefreshMode = null, resultBase, promptOptions, confirmPreview, intent }) {
  const agentState = discovery.mainWorkspace?.metadata?.[AGENTS_KEY] ?? null;
  const entry = agentState?.[from.id] ?? null;
  const previousBriefId = actionFact(entry, 'refreshed')?.briefMessageId;
  const gitSnapshot = git ? readGitSnapshot(git, status.workspace.directory, kind === 'worker' ? null : status.checkpoint?.git ?? null) : null;
  const taskCheckpoint = kind === 'worker' ? workerCheckpoint(status, from.id, entry ?? {}) : null;
  const checkpoint = Boolean(taskCheckpoint ? taskCheckpoint.task || taskCheckpoint.block : status.checkpoint?.task);
  const identity = (point, recheck = false) => rewindIdentity({ client, status, expected, from, slot: resultBase.slot,
    checkpointAt: kind === 'worker' ? entry?.noteAt ?? null : checkpointStamp(status.checkpoint), intent, point, recheck, worker: kind === 'worker' });
  const current = await identity(null);
  if (!current.rewindSupported) return { fallback: 'unsupported' };
  if (!routeMatchesIntent(current.routeBinding.live, intent)) return { fallback: 'route changed' };
  const confirmRewind = async (point) => {
    const current = await identity(point, true);
    if (!current.rewindSupported) throw new SwitchRefused('This provider no longer supports conversation rewind for this session.');
    if (!routeMatchesIntent(current.routeBinding.live, intent)) throw new SwitchRefused('Requested rewind route changed');
    confirmPreview?.(current);
  };
  const packetOf = async () => buildRefreshPacket(status, {
    kind, from, to: { id: from.id }, epoch: expected.epoch, git: gitSnapshot,
    note: entry?.note ?? null, noteAt: entry?.noteAt ?? null, interrupted: entry?.interrupted ?? null,
    lastMessage: await hintOf(client, from.id), language, workerModel, rewound: true, promptOptions,
    ...packetArgs,
  });
  if (!apply) {
    const point = await previewRewindPoint(from.id, rewindClient, previousBriefId);
    if (!point) return { fallback: 'unavailable' };
    const route = await identity(point);
    if (!route.rewindSupported) return { fallback: 'unsupported' };
    if (!routeMatchesIntent(route.routeBinding.live, intent)) return { fallback: 'route changed' };
    await checkPrivacy(from.id);
    const packet = await packetOf();
    return {
      ...resultBase, workspaceId: status.workspace.id, from: from.id, to: from.id, epoch: expected.epoch, epochBumped: false, profile: null,
      provider: from.provider, model: from.model, idempotencyKey: null, packet, packetChars: packet.length,
      checkpoint, checkpointAt: checkpointStamp(status.checkpoint),
      applied: false, delivered: false, deliveryError: null, previousNotified: false, reused: false, renameError: null,
      warnings: [], fallbackFrom: null, profileSuggestion: null, refreshMode: 'rewind', rewindPoint: point, ...route,
    };
  }
  const idem = freshRewindIdempotent(entry);
  if (idem) {
    return {
      ...resultBase, from: from.id, to: from.id, epoch: expected.epoch, epochBumped: false, profile: null,
      provider: from.provider, model: from.model, idempotencyKey: null, packet: '', packetChars: 0,
      checkpoint, applied: false, idempotent: true, idempotentReason: idem, delivered: false, deliveryError: null,
      previousNotified: false, reused: false, renameError: null, warnings: [], fallbackFrom: null, profileSuggestion: null,
      refreshMode: 'rewind',
    };
  }
  const packet = await packetOf();
  const savedCheckpoint = kind === 'worker' ? { capturedAt: entry?.noteAt } : status.checkpoint;
  const block = kind === 'worker' ? parseCheckpointBlock(packet) : null;
  const { outcome, recordingError, stageId } = await runTabRewind({ client, workspaceId: status.workspace.id, agentId: from.id, packet, checkpoint: savedCheckpoint, lock, now, rewindClient, previousBriefId, send, stageRewind: stageRewind && kind === 'steer', checkPrivacy, confirmRewind, note: block ? formatCheckpointBlock(block) : null });
  if (outcome.status !== 'rewound') {
    if (requireRefreshMode === 'rewind') {
      const error = new SwitchRefused(`Bound rewind route failed (${outcome.status}${outcome.error ? `: ${outcome.error}` : ''}). ${rewindRequired(resultBase.slot, kind === 'worker' ? from.id : null).message} The brief is kept.`);
      error.packet = packet;
      error.refreshMode = 'rewind';
      throw error;
    }
    return { fallback: outcome.status };
  }
  return {
    ...resultBase, from: from.id, to: from.id, epoch: expected.epoch, epochBumped: false, profile: null,
    provider: from.provider, model: from.model, idempotencyKey: null, packet, packetChars: packet.length,
    checkpoint, applied: true, delivered: send && !outcome.sendError, deliveryError: outcome.sendError ?? null,
    previousNotified: false, reused: false, renameError: null,
    warnings: [], fallbackFrom: null, profileSuggestion: null, refreshMode: 'rewind',
    rewindPoint: outcome.messageId ?? null, briefMessageId: outcome.briefMessageId ?? null,
    ...(recordingError ? { recordingError } : {}), ...(stageId ? { stageId } : {}),
  };
}

/** A standby replacement keeps the slot and role without taking authority. */
async function freshNonActiveSteer({ client, discovery, status, expected, slot, apply, send, stageReplacement, language,
  git, workerModel, lock, checkPrivacy, requireRefreshMode, promptOptions, replacement, tryRewind, rewindArgs }) {
  const holders = status.steers.filter((s) => s.slot === slot);
  if (!holders.length) throw new SwitchRefused(`No live Steer ${slot} to refresh for ${status.repo}; plan and apply one first`);
  const live = liveSlotHolders(holders, slot);
  const single = holders.length === 1 ? holders[0] : (live.length === 1 ? live[0] : null);
  if (single && BUSY.has(single.status)) throw new SwitchRefused(`Steer ${slot} is ${single.status}; stop it or wait for its turn to end first`);
  let rewindFallback = null;
  if (tryRewind(single, holders, 'steer', slot)) {
    const rewound = await tryTabRewind({ ...rewindArgs, from: single, kind: 'steer', packetArgs: { slot },
      resultBase: { repo: status.repo, slot, kind: 'steer' } });
    if (rewound && !rewound.fallback) return rewound;
    if (rewound?.fallback) rewindFallback = rewound.fallback;
  }
  if (requireRefreshMode === 'rewind') throw rewindRequired(slot);
  const { from, result } = await replacement({ kind: 'steer', slot, single, sources: holders });
  const gitSnapshot = git ? readGitSnapshot(git, status.workspace.directory, status.checkpoint?.git ?? null) : null;
  const agentState = discovery.mainWorkspace?.metadata?.[AGENTS_KEY] ?? null;
  result.checkpoint = Boolean(status.checkpoint?.task);
  if (rewindFallback) {
    result.rewindFallback = rewindFallback;
    result.warnings.push(rewindFallbackWarning(from.id, rewindFallback));
  }
  if (!apply) {
    result.packet = buildRefreshPacket(status, {
      kind: 'steer', slot, from, to: { id: 'new agent, created on apply' }, epoch: expected.epoch, git: gitSnapshot,
      note: agentState?.[from.id]?.note ?? null, noteAt: agentState?.[from.id]?.noteAt ?? null,
      lastMessage: await hintOf(client, from.id), language, workerModel, promptOptions,
    });
    result.packetChars = result.packet.length;
    return result;
  }
  const freshId = result.to;
  result.packet = buildRefreshPacket(status, {
    kind: 'steer', slot, from, to: { id: freshId }, epoch: expected.epoch, git: gitSnapshot,
    note: agentState?.[from.id]?.note ?? null, noteAt: agentState?.[from.id]?.noteAt ?? null,
    lastMessage: await hintOf(client, from.id), language, workerModel, promptOptions,
  });
  result.packetChars = result.packet.length;
  return finishFreshReplacement({
    client, workspaceId: status.workspace.id, sourceId: from.id, result, send, stageReplacement, lock, checkPrivacy,
  });
}

/** Worker replacement retains the owner, workspace and original parent. */
async function freshWorkerAgent({ client, discovery, status, expected, workerId, apply, send, stageReplacement, language,
  git, workerModel, lock, now, checkPrivacy, requireRefreshMode, promptOptions, replacement, tryRewind, rewindArgs }) {
  const matches = (status.workers ?? []).filter((w) => w.id === workerId || w.id.startsWith(workerId));
  if (!matches.length) throw new SwitchRefused(`${workerId} is not a live worker of ${status.repo}`);
  if (matches.length > 1) throw new SwitchRefused(`Worker ${JSON.stringify(workerId)} is ambiguous (${matches.map((w) => w.id).join(', ')}); pass the full agent id`);
  const from = matches[0];
  if (BUSY.has(from.status)) throw new SwitchRefused(`Worker ${from.id} is ${from.status}; stop it or wait for its turn to end first`);
  const registered = readWorkers(discovery.mainWorkspace?.metadata ?? {})[from.id];
  const owner = from.owner ?? from.parentSlot ?? registered?.startedBy ?? expected.activeSteer;
  const title = from.title ?? 'Worker';
  let rewindFallback = null;
  if (tryRewind(from, [from], 'worker')) {
    const rewound = await tryTabRewind({ ...rewindArgs, from, kind: 'worker', packetArgs: { owner, title },
      resultBase: { repo: status.repo, slot: owner, kind: 'worker', workerId: from.id, owner } });
    if (rewound && !rewound.fallback) return rewound;
    if (rewound?.fallback) rewindFallback = rewound.fallback;
  }
  if (requireRefreshMode === 'rewind') throw rewindRequired(null, from.id);
  const { result } = await replacement({ kind: 'worker', single: from, sources: [from], owner });
  const gitSnapshot = git ? readGitSnapshot(git, status.workspace.directory) : null;
  const agentState = discovery.mainWorkspace?.metadata?.[AGENTS_KEY] ?? null;
  const entry = agentState?.[from.id] ?? null;
  const lastMessage = await hintOf(client, from.id);
  const worker = workerCheckpoint(status, from.id, { ...entry, lastMessage });
  result.checkpoint = Boolean(worker.task || worker.block);
  if (rewindFallback) {
    result.rewindFallback = rewindFallback;
    result.warnings.push(rewindFallbackWarning(from.id, rewindFallback));
  }
  if (!apply) {
    result.packet = buildRefreshPacket(status, {
      kind: 'worker', owner, title, from, to: { id: 'new agent, created on apply' }, epoch: expected.epoch, git: gitSnapshot,
      note: entry?.note ?? null, noteAt: entry?.noteAt ?? null, interrupted: entry?.interrupted ?? null,
      lastMessage, language, workerModel, promptOptions,
    });
    result.packetChars = result.packet.length;
    return result;
  }
  const freshId = result.to;
  result.packet = buildRefreshPacket(status, {
    kind: 'worker', owner, title, from, to: { id: freshId }, epoch: expected.epoch, git: gitSnapshot,
    note: entry?.note ?? null, noteAt: entry?.noteAt ?? null, interrupted: entry?.interrupted ?? null,
    lastMessage, language, workerModel, promptOptions,
  });
  result.packetChars = result.packet.length;
  const resumeMessageId = worker.interrupted ? `wsf-worker-refresh-${freshId}` : null;
  if (worker.interrupted || readWorkers(discovery.mainWorkspace?.metadata ?? {})[from.id]) {
    const workspace = client.workspaces.ref(status.workspace.id);
    await lock(workspaceLockName(status.workspace.id), async (held) => {
      const metadata = (await workspace.refresh())?.metadata ?? {};
      if (metadata[METADATA_KEY]?.epoch !== expected.epoch) throw new SwitchRefused('The scope moved before the worker could be refreshed');
      const workers = readWorkers(metadata);
      const entries = metadata[AGENTS_KEY] ?? {};
      if (workers[from.id]) {
        workers[freshId] = { ...workers[freshId], ...workers[from.id] };
        delete workers[from.id];
      }
      const block = parseCheckpointBlock(result.packet);
      held.verify();
      await workspace.setMetadata({
        [WORKERS_KEY]: workers,
        [AGENTS_KEY]: {
          ...entries,
          [freshId]: {
            ...(worker.interrupted ? { workerResumeMessageId: resumeMessageId, interrupted: entry?.interrupted ?? { at: now().toISOString() } } : {}),
            ...(block ? { note: formatCheckpointBlock(block), noteAt: entry?.noteAt ?? null } : {}),
            ...entries[freshId],
          },
        },
      });
    });
  }
  return finishFreshReplacement({
    client, workspaceId: status.workspace.id, sourceId: from.id, result, send, stageReplacement, lock, checkPrivacy, messageId: resumeMessageId,
  });
}

export async function hintOf(client, agentId) {
  try {
    return lastAssistantText(await client.agents.ref(agentId).timeline.refetch({ direction: 'tail', limit: 20 }));
  } catch {
    return null;
  }
}

export function workerResumeAnswer(client, status, agentId) {
  return (status.workers ?? []).some((worker) => worker.id === agentId) ? hintOf(client, agentId) : null;
}

/** Records a short task checkpoint for the current epoch (same lock as switches). A fresh checkpoint clears the interrupted flag — except source `auto`, which never clears it. Source `failover` logs a takeover with the previous steer and reason. */
export async function writeCheckpoint({ client, discovery, task, tests = [], blockers = [], next = null, source = 'manual', agentId = null, turnId = null, callerId = null, config = null, previousSteer = null, failoverReason = null, lock = withLock, now = () => new Date(), git = createGit() }) {
  const status = steerStatus(discovery, { config });
  if (!status.workspace || !status.state) throw new SwitchRefused('No factory main workspace with steer state');
  if (typeof task !== 'string' || !task.trim()) throw new SwitchRefused('A checkpoint needs a task');
  const workspace = client.workspaces.ref(status.workspace.id);
  const holders = liveSlotHolders(status.steers, status.state.activeSteer);
  const expectedHolder = holders.length === 1 ? holders[0] : null;
  if (agentId && expectedHolder?.id !== agentId) throw new SwitchRefused('A checkpoint from an agent must come from the unique active steer');
  return lock(workspaceLockName(status.workspace.id), async (held) => {
    const { metadata, state: fresh } = await guardScope({ client, held, workspaceId: status.workspace.id, scopeId: status.state.scope?.id ?? status.repo, epoch: status.state.epoch, agentId: expectedHolder?.id, aliases: discoveryScopeAliases(discovery), config });
    if (callerId) {
      if (callerId !== expectedHolder.id) throw new SwitchRefused('Only the active steer can write this checkpoint');
    }
    const stamp = now().toISOString();
    const checkpoint = { task: task.trim(), tests, blockers, next: next?.trim() || null, epoch: fresh?.epoch ?? null, updatedAt: stamp, source, agentId, turnId, capturedAt: stamp, interrupted: source === 'auto' ? (metadata[CHECKPOINT_KEY]?.interrupted ?? null) : null, ...(source === 'failover' ? { failover: { previousSteer, reason: failoverReason } } : {}) };
    const observation = readCheckpointGit(git, status.workspace.directory);
    if (observation) checkpoint.git = observation;
    held.verify();
    await workspace.setMetadata({ [CHECKPOINT_KEY]: checkpoint });
    return checkpoint;
  });
}
