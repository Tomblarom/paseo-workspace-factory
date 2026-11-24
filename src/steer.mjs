// Active-steer state, task checkpoints, steer switching and same-slot refresh.
// Factory-owned state lives in three workspace metadata keys of the main workspace:
//   wsf                { main, activeSteer, epoch, previousSteer?, switchedAt? }
//   wsf.checkpoint     { task, tests[], blockers[], next?, epoch, updatedAt,
//                        source, agentId?, turnId?, capturedAt, interrupted? }
//   wsf.agents         { <agentId>: per-agent turn/note/interrupt records } (see agent-state.mjs)
// previousSteer is the replaced slot letter after a switch, or the retired agent
// id after a fresh (same slot, so the letter would not identify it).
// Paseo has no compare-and-set for metadata, so writes from factory processes are
// serialized by a per-workspace flock on this host; agents, the UI and other hosts
// are not blocked. Between held.verify() and the daemon write remains a short
// window in which a replaced lock file is not noticed.
import { LABEL, METADATA_KEY, parentOf, agentUsage, isRestartReason, restartMessage } from './paseo.mjs';
import { withLock, workspaceLockName } from './lock.mjs';
import { runtime } from './runtime.mjs';
import { isAdvisorSlot, isSensitiveSlot } from './config.mjs';
import { resolveProfile, steerFallbackList, usedProfilesByLiveSteers } from './models.mjs';
import { idempotencyKey, requestDigest } from './planner.mjs';
import { createExecutors } from './apply.mjs';
import { resolveScope, scopeToEntry, sameScopeId, domainOfScope } from './scope.mjs';
import { STEER_TITLE, activeMarker, markSteerTitle, stripActiveMarker } from './discovery.mjs';
import { AGENTS_KEY } from './agent-state.mjs';
import { openWorkers as openRegisterWorkers, readWorkers } from './supervision.mjs';
import { formatQuotaLine, profilePool } from './quota.mjs';

export const CHECKPOINT_KEY = `${METADATA_KEY}.checkpoint`;
export class SwitchRefused extends Error {}
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
  const state = main?.metadata?.[METADATA_KEY] ?? null;
  const checkpoint = main?.metadata?.[CHECKPOINT_KEY] ?? null;
  const agentState = main?.metadata?.[AGENTS_KEY] ?? null;
  const retiredId = typeof state?.previousSteer === 'string' && !/^[A-Z]$/.test(state.previousSteer) ? state.previousSteer : null;
  const marked = restartInterruptions({ checkpoint, agentState });
  const markedIds = new Set(marked.map((m) => m.agentId));
  const checkpointAt = checkpoint?.capturedAt ?? checkpoint?.updatedAt ?? null;
  const heuristicIds = new Set();
  if (daemonStartedAt && lastTurnCheckpoints && typeof lastTurnCheckpoints === 'object' && checkpointAt) {
    for (const a of [...(discovery.steers.labelled ?? []), ...(discovery.workers ?? [])]) {
      if (!a || a.archivedAt || markedIds.has(a.id)) continue;
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
    .map((a) => ({ slot: a.labels[LABEL.slot], id: a.id, title: a.title, provider: a.provider, model: a.model, status: a.status, parent: parentOf(a), workspaceId: a.workspaceId, usage: agentUsage(a), retired: retiredId !== null && a.id === retiredId, ...(config ? { advisor: isAdvisorSlot(config, a.labels[LABEL.slot]), sensitive: isSensitiveSlot(config, a.labels[LABEL.slot]) } : {}), ...withInterruption(a.id) }))
    .sort((a, b) => a.slot.localeCompare(b.slot));
  const steerById = new Map(steers.map((s) => [s.id, s]));
  // Unlabelled steer candidates by id (lettered and digit-titled): a worker
  // whose parent is such a candidate names it instead of "Steer ?".
  const candidateById = new Map();
  for (const a of [...(discovery.steers.legacy ?? []), ...(discovery.steers.digitCandidates ?? [])]) {
    candidateById.set(a.id, {
      id: a.id, title: a.title ?? null,
      slot: (a.title ?? '').trim().match(STEER_TITLE)?.[1] ?? null,
    });
  }
  const workers = discovery.workers.map((w) => {
    const parent = parentOf(w);
    return {
      id: w.id, title: w.title, provider: w.provider, model: w.model, status: w.status, cwd: w.cwd,
      parentSlot: (parent && steerById.get(parent)?.slot) ?? null, parent, usage: agentUsage(w),
      parentCandidate: parent && !steerById.has(parent) ? (candidateById.get(parent) ?? null) : null,
      workspaceId: w.workspaceId ?? null, owner: w.labels?.[LABEL.owner] ?? null,
      ...withInterruption(w.id),
    };
  });
  const candidates = [...(discovery.steers.legacy ?? []), ...(discovery.steers.digitCandidates ?? [])].map((a) => ({
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
    for (const s of steers) {
      const profileName = config.steers?.slots?.[s.slot];
      const expected = profileName ? config.profiles?.[profileName] : null;
      if (expected && (s.provider !== expected.provider || s.model !== expected.model)) {
        warnings.push(`Steer ${s.slot} runs ${s.provider}/${s.model} but slot profile "${profileName}" names ${expected.provider}/${expected.model}`);
      }
    }
    if (state?.activeSteer && isAdvisorSlot(config, state.activeSteer)) {
      warnings.push(`Active Steer ${state.activeSteer} is an advisor (profile "${config.steers.slots[state.activeSteer]}"); advisors never coordinate`);
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
    openWorkers: openRegisterWorkers(readWorkers(main?.metadata ?? null)),
    candidates,
    usageWarnings,
    ...(config ? { warnings } : {}),
    ...(restartInterrupted.length ? { restartInterrupted } : {}),
  };
}

/** Branch, HEAD and dirty state straight from git; null when unreadable. */
export function readGitSnapshot(git, path) {
  try {
    const branch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const sha = git(path, ['rev-parse', 'HEAD']).trim();
    const changes = git(path, ['status', '--porcelain']).split('\n').filter(Boolean).length;
    return { branch, sha, changes };
  } catch {
    return null;
  }
}

/** Richer git read for the resume brief: ahead/behind plus up to 10 changed paths; null when unreadable. */
export function readGitBrief(git, path) {
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
    return { branch, sha, ahead, behind, changed: lines.length, paths: lines.slice(0, 10).map((l) => (l.length > 3 ? l.slice(3) : l)) };
  } catch {
    return null;
  }
}

function clip(text, max) {
  const value = (text ?? '').trim().replace(/\s+\n/g, '\n');
  return value.length > max ? `${value.slice(0, max)} […]` : value;
}

const TEXT = {
  de: {
    head: (repo, e) => `Steer-Übergabe für ${repo}: Epoch ${e} → ${e + 1}.`,
    active: (to, from) => `Aktiv ist jetzt Steer ${to.slot} (${to.id}). Steer ${from.slot} (${from.id}) koordiniert nicht mehr.`,
    git: (g) => `Git: ${g.branch} @ ${g.sha.slice(0, 12)} · ${g.changes ? `${g.changes} geänderte/untracked Pfade` : 'sauber'}`,
    noGit: 'Git: Zustand nicht lesbar – vor Arbeitsbeginn selbst prüfen.',
    noCheckpoint: 'Aufgaben-Checkpoint: KEINER DOKUMENTIERT. Aktuellen Auftrag nicht aus dem Verlauf ableiten, sondern beim Nutzer bestätigen.',
    checkpoint: (cp, stale) => `Aufgaben-Checkpoint (Epoch ${cp.epoch ?? '?'}, ${cp.updatedAt ?? 'ohne Zeit'}${stale ? ', NICHT aus der aktuellen Epoch – auf Aktualität prüfen' : ''}):`,
    task: 'Auftrag', tests: 'Tests', blockers: 'Offene Blocker', next: 'Nächster Schritt', none: 'keine dokumentiert',
    noNext: 'nicht dokumentiert – vor neuer Arbeit beim Nutzer bestätigen',
    workers: 'Worker (per Agent-ID weiterverwenden, nicht neu anlegen):', noWorkers: 'Worker: keine.', parent: 'Parent Steer',
    hint: (slot) => `Unverifizierter Hinweis – letzte Antwort von Steer ${slot}, gekürzt, keine Auftragsquelle:`,
    notice: (to, e) => `Hinweis: Steer ${to.slot} (${to.id}) ist ab Epoch ${e} aktiv. Du koordinierst nicht mehr; nur auf ausdrückliche Anfrage antworten.`,
  },
  en: {
    head: (repo, e) => `Steer handoff for ${repo}: epoch ${e} → ${e + 1}.`,
    active: (to, from) => `Steer ${to.slot} (${to.id}) is now active. Steer ${from.slot} (${from.id}) no longer coordinates.`,
    git: (g) => `Git: ${g.branch} @ ${g.sha.slice(0, 12)} · ${g.changes ? `${g.changes} changed/untracked paths` : 'clean'}`,
    noGit: 'Git: state unreadable – check it yourself before starting.',
    noCheckpoint: 'Task checkpoint: NONE RECORDED. Do not infer the current task from history; confirm it with the user.',
    checkpoint: (cp, stale) => `Task checkpoint (epoch ${cp.epoch ?? '?'}, ${cp.updatedAt ?? 'no time'}${stale ? ', NOT from the current epoch – check whether it is still valid' : ''}):`,
    task: 'Task', tests: 'Tests', blockers: 'Open blockers', next: 'Next step', none: 'none recorded',
    noNext: 'not recorded – confirm with the user before starting new work',
    workers: 'Workers (reuse by agent id, do not recreate):', noWorkers: 'Workers: none.', parent: 'parent Steer',
    hint: (slot) => `Unverified hint – last answer of Steer ${slot}, shortened, not a task source:`,
    notice: (to, e) => `Note: Steer ${to.slot} (${to.id}) is active as of epoch ${e}. You no longer coordinate; reply only when asked explicitly.`,
  },
};

/**
 * Renders checkpoint fields as the fenced CHECKPOINT block: the one form every
 * factory-generated text carries and every steer/worker answer must end with.
 * Field names stay fixed English so parseCheckpointBlock reads them back in any
 * handoff language; empty values become "none".
 */
export function formatCheckpointBlock({ task, tests = [], blockers = [], next = null }) {
  const oneLine = (value) => String(value ?? '').replace(/\s*\n\s*/g, ' ').trim();
  const list = (values) => (values?.length ? values.map(oneLine).filter(Boolean).join('; ') : 'none');
  return ['```text', 'CHECKPOINT', `- task: ${oneLine(task)}`, `- tests: ${list(tests)}`, `- blockers: ${list(blockers)}`, `- next: ${next ? oneLine(next) : 'none'}`, '```'].join('\n');
}

/**
 * Deterministic handoff text from Paseo/git state. No model call is made to build
 * it; the receiving steer still reads it as normal input on its next turn.
 */
export function buildHandoff(status, { from, to, epoch, git, lastMessage, maxLastChars = 800, language = 'en', workerModel = null }) {
  const t = TEXT[language] ?? TEXT.en;
  const lines = [t.head(status.repo, epoch), t.active(to, from), `Workspace ${status.workspace.id} · ${status.workspace.directory}`, git ? t.git(git) : t.noGit];
  if (workerModel) lines.push(workerModel);
  const cp = status.checkpoint;
  if (!cp?.task) {
    lines.push(t.noCheckpoint);
  } else {
    lines.push(t.checkpoint(cp, cp.epoch !== epoch));
    lines.push(`- ${t.task}: ${cp.task}`);
    lines.push(`- ${t.tests}: ${cp.tests?.length ? cp.tests.join('; ') : t.none}`);
    lines.push(`- ${t.blockers}: ${cp.blockers?.length ? cp.blockers.join('; ') : t.none}`);
    lines.push(`- ${t.next}: ${cp.next ? cp.next : t.noNext}`);
    if (cp.source === 'failover' && cp.failover) lines.push(`- Failover: takeover from ${cp.failover.previousSteer ?? '?'} (${cp.failover.reason ?? 'no reason recorded'})`);
    lines.push(formatCheckpointBlock(cp));
  }
  const supervised = new Map((status.openWorkers ?? []).map((e) => [e.id, e]));
  const supervisedSuffix = (id) => {
    const e = supervised.get(id);
    return e ? ` · supervised ${e.state}: ${clip(e.task ?? '', 120) || '(no task)'}` : '';
  };
  if (status.workers.length || supervised.size) {
    lines.push(t.workers);
    for (const w of status.workers) lines.push(`- ${w.id} „${w.title}“ ${w.provider}/${w.model} · ${w.status}${w.parentSlot ? ` · ${t.parent} ${w.parentSlot}` : ''}${!w.parentSlot && w.parentCandidate ? ` · ${t.parent} candidate "${w.parentCandidate.title}" ${w.parentCandidate.id}` : ''}${w.owner && !w.parentSlot ? ` · owner ${w.owner}` : ''}${w.workspaceId && status.workspace && w.workspaceId !== status.workspace.id ? ` · workspace ${w.workspaceId}` : ''}${supervisedSuffix(w.id)}`);
    for (const e of [...supervised.values()].filter((entry) => !status.workers.some((w) => w.id === entry.id))) lines.push(`- ${e.id} (agent not live) · supervised ${e.state}: ${clip(e.task ?? '', 120) || '(no task)'}`);
  } else {
    lines.push(t.noWorkers);
  }
  if (lastMessage) lines.push(t.hint(from.slot), clip(lastMessage, maxLastChars));
  return lines.join('\n');
}

export function previousSteerNotice(to, epoch, language = 'en') {
  return (TEXT[language] ?? TEXT.en).notice(to, epoch);
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
export function buildResumeBrief(status, { agentId = null, agentState = null, git = null, scope = null, now = () => Date.now(), daemonStartedAt = null, lastTurnCheckpoints = null, config = null, workerModel = null, quotaSnapshot = null, quotaWarnPct = config?.quota?.warnPct ?? 75, zerosub = null } = {}) {
  const id = scope?.id ?? status.repo;
  const kind = scope?.kind ?? 'unknown';
  const epoch = status.state?.epoch ?? '?';
  const domain = scope?.domain ?? status.domain ?? null;
  const active = status.steers.find((s) => s.slot === status.state?.activeSteer) ?? null;
  const lines = [`Resume brief for ${id} (${kind}) · epoch ${epoch} · active steer ${status.state?.activeSteer ?? '?'}${active ? ` (${active.id})` : ''}${domain ? ` · domain ${domain}` : ''}.`];
  const callerSteer = agentId ? status.steers.find((s) => s.id === agentId) ?? null : null;
  const callerWorker = !callerSteer && agentId ? (status.workers ?? []).find((w) => w.id === agentId) ?? null : null;
  if (config && callerSteer && isAdvisorSlot(config, callerSteer.slot)) lines.push('You are an advisor steer: answer only, never coordinate or take over.');
  else if (callerSteer && callerSteer.id === active?.id) lines.push('You are the active steer of this scope.');
  else if (callerSteer) lines.push('You are not active: answer only, do not coordinate.');
  else if (callerWorker) lines.push(`You are worker "${callerWorker.title}"; your owner is Steer ${callerWorker.owner ?? callerWorker.parentSlot ?? '?'} — continue from the checkpoint below.`);
  else lines.push('Caller unknown; treat this brief as read-only context.');
  if (workerModel) lines.push(workerModel);
  const quotaPool = active ? profilePool(config?.profiles?.[config?.steers?.slots?.[active.slot]]) : null;
  const quotaLine = formatQuotaLine(config, quotaSnapshot, { currentPool: quotaPool, warnPct: quotaWarnPct, zerosub });
  if (quotaLine) lines.push(quotaLine);

  const cp = status.checkpoint;
  const agents = agentState && typeof agentState === 'object' ? agentState : {};
  if (!cp?.task) {
    lines.push('Task checkpoint: NONE RECORDED. Do not infer the current task from history; confirm it with the user.');
  } else {
    const stamped = cp.capturedAt ?? cp.updatedAt ?? null;
    lines.push(`Task checkpoint (${cp.source ?? 'manual'}${stamped ? `, ${ageAgo(stamped, now())}` : ''}):`);
    lines.push(`- Task: ${clip(cp.task, 500)}`);
    lines.push(`- Tests: ${cp.tests?.length ? clip(cp.tests.join('; '), 300) : 'none recorded'}`);
    lines.push(`- Open blockers: ${cp.blockers?.length ? clip(cp.blockers.join('; '), 300) : 'none recorded'}`);
    lines.push(`- Next step: ${cp.next ? clip(cp.next, 300) : 'not recorded'}`);
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
      const firstLine = typeof note === 'string' && note.trim() ? clip(note.trim().split('\n')[0], 120) : 'no note';
      const e = supervised.get(w.id);
      lines.push(`- ${w.id} "${w.title}" ${w.status} · ${firstLine}${e ? ` · supervised: ${e.state} ${clip(e.task ?? '', 120)}` : ''}`);
    }
    if (workers.length > BRIEF_WORKERS_SHOWN) lines.push(`- … +${workers.length - BRIEF_WORKERS_SHOWN} more workers`);
    for (const e of registerOnly) lines.push(`- ${e.id} (agent not live) · supervised: ${e.state} ${clip(e.task ?? '', 120)}`);
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
  if (text.length <= BRIEF_BUDGET) return text;
  const marker = `\n[…brief truncated to ${BRIEF_BUDGET} characters]`;
  return text.slice(0, BRIEF_BUDGET - marker.length) + marker;
}

/**
 * Handoff text plus, for an interrupted checkpoint, the resume brief for the
 * receiving agent and the verify-git line. Without interruption this is
 * exactly buildHandoff.
 */
function handoffWithBrief(status, args, { discovery, git, language, workerModel = null, quotaSnapshot = null, quotaWarnPct = 75, zerosub = null }) {
  const packet = buildHandoff(status, { ...args, workerModel });
  const at = status.checkpoint?.interrupted?.at ?? null;
  if (at === null && !status.checkpoint?.interrupted) return packet;
  const brief = buildResumeBrief(status, {
    agentId: args.to?.id ?? null,
    agentState: discovery?.mainWorkspace?.metadata?.[AGENTS_KEY] ?? null,
    git: git ? readGitBrief(git, status.workspace.directory) : null,
    scope: discovery?.scope ?? null,
    workerModel,
    quotaSnapshot,
    quotaWarnPct,
    zerosub,
  });
  const line = language === 'de'
    ? `Der vorherige Steer wurde um ${at ?? 'unbekannter Zeit'} unterbrochen; Git-Stand vor dem Weitermachen prüfen.`
    : `Previous steer was interrupted at ${at ?? 'unknown time'}; verify git state before continuing.`;
  return `${packet}\n---\n${line}\n--- resume brief ---\n${brief}`;
}

const NONE = /^(keine?|none|n\/a|-)\.?$/i;

/**
 * Parses the last `CHECKPOINT` block of an agent answer, fenced or bare:
 *   ```text
 *   CHECKPOINT
 *   - task: …   - tests: …   - blockers: …   - next: …   (- workers: …)   (- status: …)
 *   ```
 * Dashes, the fence, the `workers` line (informational, ignored) and the
 * optional `status` line (`done`|`partial`|`blocked`, case-insensitive) are
 * optional; values "none"/"keine" become empty lists. Returns null without a
 * block or task. Blocks without a status line parse to the previous shape
 * (no `status` key), so old readers keep working.
 */
export function parseCheckpointBlock(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\s*`*\s*CHECKPOINT\s*:?\s*`*\s*$/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const fields = {};
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s*[-*]?\s*(task|tests|blockers|next|status)\s*:\s*(.*)$/i);
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
    else if (line.trim() === '' || /^\s*```/.test(line)) continue;
    else if (/^\s*[-*]?\s*workers\s*:/i.test(line)) continue;
    else if (Object.keys(fields).length) break;
  }
  if (!fields.task) return null;
  const list = (value) => (!value || NONE.test(value) ? [] : [value]);
  const status = typeof fields.status === 'string' && /^(done|partial|blocked)$/i.test(fields.status.trim()) ? fields.status.trim().toLowerCase() : null;
  return {
    task: fields.task, tests: list(fields.tests), blockers: list(fields.blockers), next: fields.next && !NONE.test(fields.next) ? fields.next : null,
    ...(status ? { status } : {}),
  };
}

export function lastAssistantText(timelinePayload) {
  const entries = timelinePayload?.entries ?? [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const item = entries[i]?.item;
    if (item?.type === 'assistant_message' && item.text) return item.text;
  }
  return null;
}

/**
 * Moves the active-steer tab marker ("● Steer E"): marks one agent, unmarks
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

/** Retired scopes never coordinate here again; revival needs an explicit un-retire. */
function refuseIfRetired(status) {
  if (status.state?.retired === true) {
    throw new SwitchRefused(`Scope ${status.repo} is retired${status.state.movedTo ? ` (moved to ${status.state.movedTo})` : ''}; coordinate in the successor scope instead`);
  }
}

/**
 * Dry-run returns the handoff and the target state. Apply, under the workspace lock:
 * re-read, check the expected epoch and active steer, write, read back, release;
 * the handoff is delivered after the lock is released.
 */
export async function switchSteer({ client, discovery, toSlot, apply = false, send = true, wait = false, waitTimeoutMs = 600_000, notifyPrevious = false, language = runtime().handoffLanguage, git, lock = withLock, now = () => new Date(), config = null, workerModel = null, quotaSnapshot = null, quotaWarnPct = config?.quota?.warnPct ?? 75, zerosub = null, callerId = process.env.PASEO_AGENT_ID, paseoCli = null }) {
  const status = steerStatus(discovery);
  if (!status.workspace || !status.state) throw new SwitchRefused('No factory main workspace with steer state; run the factory first');
  const expected = status.state;
  refuseIfRetired(status);
  const from = status.steers.find((s) => s.slot === expected.activeSteer);
  const to = status.steers.find((s) => s.slot === toSlot);
  if (!to) throw new SwitchRefused(`Steer ${toSlot} does not exist for ${status.repo}`);
  if (toSlot === expected.activeSteer) throw new SwitchRefused(`Steer ${toSlot} is already active`);
  if (config && isAdvisorSlot(config, toSlot)) {
    throw new SwitchRefused(`Steer ${toSlot} is an advisor (profile ${config.steers.slots[toSlot]}); remove the advisor tag to make it a coordinator`);
  }
  const ambiguous = (slot) => status.steers.filter((s) => s.slot === slot);
  if (ambiguous(toSlot).length > 1) throw new SwitchRefused(`Steer ${toSlot} has several live agents (${ambiguous(toSlot).map((s) => s.id).join(', ')}); archive the retired one in Paseo, then rerun`);
  if (from && ambiguous(from.slot).length > 1) throw new SwitchRefused(`Active Steer ${from.slot} has several live agents (${ambiguous(from.slot).map((s) => s.id).join(', ')}); archive the retired one in Paseo, then rerun`);
  if (to.parent) throw new SwitchRefused(`Steer ${toSlot} has parent ${to.parent}; refusing to make it coordinator`);
  if (to.workspaceId !== status.workspace.id) throw new SwitchRefused(`Steer ${toSlot} is not in the main workspace`);
  const selfTakeover = Boolean(callerId) && callerId === to.id; // the target requests its own takeover: it is the running caller
  if (!selfTakeover && BUSY.has(to.status)) throw new SwitchRefused(`Steer ${toSlot} is ${to.status}`);
  if (from && BUSY.has(from.status)) throw new SwitchRefused(`Active Steer ${from.slot} is ${from.status}; stop it or wait for its turn to end first`);

  let lastMessage = null;
  if (from) {
    try {
      lastMessage = lastAssistantText(await client.agents.ref(from.id).timeline.refetch({ direction: 'tail', limit: 20 }));
    } catch {
      lastMessage = null;
    }
  }
  const fromInfo = from ?? { slot: expected.activeSteer, id: 'unknown' };
  const gitSnapshot = git ? readGitSnapshot(git, status.workspace.directory) : null;
  const packet = handoffWithBrief(status, { from: fromInfo, to, epoch: expected.epoch, git: gitSnapshot, lastMessage, language }, { discovery, git, language, workerModel, quotaSnapshot, quotaWarnPct, zerosub });
  const result = {
    repo: status.repo, from: fromInfo.slot, to: toSlot, epoch: expected.epoch + 1, packet,
    packetChars: packet.length, checkpoint: Boolean(status.checkpoint?.task), applied: false, delivered: false, deliveryError: null, reply: null, previousNotified: false, selfTakeover, renameError: null,
  };
  if (!apply) return result;

  const workspace = client.workspaces.ref(status.workspace.id);
  await lock(workspaceLockName(status.workspace.id), async (held) => {
    const fresh = (await workspace.refresh())?.metadata?.[METADATA_KEY];
    if (!fresh || fresh.epoch !== expected.epoch || fresh.activeSteer !== expected.activeSteer) {
      throw new SwitchRefused(`Steer state changed (expected ${expected.activeSteer}@${expected.epoch}, found ${fresh?.activeSteer}@${fresh?.epoch}); rerun the switch`);
    }
    const next = { ...fresh, activeSteer: toSlot, epoch: fresh.epoch + 1, previousSteer: fresh.activeSteer, switchedAt: now().toISOString() };
    held.verify(); // the lock file must still be the locked inode right before the write
    await workspace.setMetadata({ [METADATA_KEY]: next });
    const written = (await workspace.refresh())?.metadata?.[METADATA_KEY];
    if (written?.epoch !== next.epoch || written?.activeSteer !== toSlot) throw new Error('Steer switch not verifiable after write');
  });
  result.applied = true;
  result.renameError = applyActiveMarker({
    paseoCli, marker: activeMarker(config),
    mark: { id: to.id, title: to.title ?? null, slot: toSlot },
    unmark: from ? { id: from.id, title: from.title ?? null, slot: from.slot } : null,
  });
  if (send && !selfTakeover) { // never message oneself; the brief is only returned
    try {
      await client.agents.ref(to.id).send(packet);
      result.delivered = true;
    } catch (error) {
      result.deliveryError = error.message; // switch stands; resend the packet manually
    }
  }
  if (notifyPrevious && from) {
    try {
      await client.agents.ref(from.id).send(previousSteerNotice(to, expected.epoch + 1, language)); // costs one turn of the previous steer
      result.previousNotified = true;
    } catch {
      result.previousNotified = false;
    }
  }
  if (wait && result.delivered && !selfTakeover) {
    const handle = client.agents.ref(to.id);
    await handle.waitForFinish(waitTimeoutMs);
    result.reply = lastAssistantText(await handle.timeline.refetch({ direction: 'tail', limit: 20 }));
  }
  return result;
}

/**
 * Hands the active steer to a NEW agent of the same slot and profile (empty
 * context). Preview without apply; apply, under the workspace lock: verify the
 * expected epoch and active steer, create the agent under a stable idempotency
 * key, write the new epoch, read back, release; both deliveries happen after the
 * lock. An interrupted apply (agent created, state not written) is recovered
 * through its receipt on the next apply, never recreated. The old steer is left
 * unchanged except for a short notice (one turn); it keeps its slot label, so
 * until it is archived in Paseo the slot has two live agents and switch/plan
 * refuse it as ambiguous. The packet preview names a placeholder id; the applied
 * packet carries the real one.
 */
export async function freshSteer({ client, discovery, config, apply = false, language = runtime().handoffLanguage, git, lock = withLock, lookupReceipt, execute, now = () => new Date(), workerModel = null, quotaSnapshot = null, quotaWarnPct = config?.quota?.warnPct ?? 75, quotaExhaustedPct = config?.quota?.exhaustedPct ?? 90, zerosub = null, paseoCli = null }) {
  const status = steerStatus(discovery);
  if (!status.workspace || !status.state) throw new SwitchRefused('No factory main workspace with steer state; run the factory first');
  const expected = status.state;
  refuseIfRetired(status);
  const slot = expected.activeSteer;
  const holders = status.steers.filter((s) => s.slot === slot);
  if (!holders.length) throw new SwitchRefused(`No live Steer ${slot} to refresh for ${status.repo}; plan and apply one first`);
  const single = holders.length === 1 ? holders[0] : null;
  if (single && BUSY.has(single.status)) throw new SwitchRefused(`Active Steer ${slot} is ${single.status}; stop it or wait for its turn to end first`);
  const profileName = config?.steers?.slots?.[slot];
  if (!profileName || !config.profiles?.[profileName]) throw new SwitchRefused(`Steer slot ${slot} references unknown profile "${profileName}"`);
  const advisorSlot = isAdvisorSlot(config, slot);
  const used = usedProfilesByLiveSteers(config, status.steers.filter((s) => s.slot !== slot));
  const { profile, skipped } = resolveProfile(config, discovery.providers, steerFallbackList(config, slot), {
    role: 'steer', advisorSlot, usedProfiles: used,
    quotaSnapshot, quotaExhaustedPct, zerosub,
  });
  if (!profile) throw new SwitchRefused(`Profile "${profileName}" for Steer ${slot} is not startable${skipped[0] ? `: ${skipped[0].reason}` : ''} (no fallback available)`);
  const warnings = [];
  if (advisorSlot) warnings.push(`Steer ${slot} is an advisor (profile "${profileName}"); advisors never coordinate`);
  if (profile.name !== profileName) warnings.push(`Profile "${profileName}" is not startable (${skipped[0]?.reason ?? 'unknown reason'}); using fallback "${profile.name}"`);

  // Same create request the planner builds for a slot (mirrored here; planner
  // internals are not exported), bound to the current epoch so a retry before the
  // state write reuses the key while every applied fresh gets a new one.
  const scopeId = discovery.scope?.id ?? status.repo;
  const labels = { [LABEL.repo]: status.repo, [LABEL.role]: 'steer', [LABEL.slot]: slot, [LABEL.scope]: scopeId };
  const request = {
    workspaceId: status.workspace.id, title: markSteerTitle(`Steer ${slot}`, activeMarker(config)), labels,
    config: { provider: `${profile.provider}/${profile.model}`, ...(profile.mode ? { modeId: profile.mode } : {}), ...(profile.thinking ? { thinkingOptionId: profile.thinking } : {}) },
  };
  const key = idempotencyKey(status.repo, 'steer', slot, `fresh-e${expected.epoch}`, requestDigest(request));
  const op = { key: `steer.${slot}.fresh`, kind: 'paseo.agent.create', summary: `Create fresh Steer ${slot} (${profile.provider}/${profile.model}) without prompt`, params: { ...request, idempotencyKey: key } };

  const gitSnapshot = git ? readGitSnapshot(git, status.workspace.directory) : null;
  const result = {
    repo: status.repo, slot, from: single?.id ?? null, to: null, epoch: expected.epoch + 1, profile: profile.name,
    provider: profile.provider, model: profile.model, idempotencyKey: key, packet: '', packetChars: 0,
    checkpoint: Boolean(status.checkpoint?.task), applied: false, delivered: false, deliveryError: null, previousNotified: false, reused: false, renameError: null,
    warnings, fallbackFrom: profile.name !== profileName ? profileName : null,
  };
  if (!apply) {
    if (!single) throw new SwitchRefused(`Steer ${slot} has several live agents (${holders.map((s) => s.id).join(', ')}); if a previous fresh apply was interrupted, rerun with --apply to recover it, otherwise archive the retired one in Paseo`);
    result.packet = handoffWithBrief(status, { from: single, to: { slot, id: 'new agent, created on apply' }, epoch: expected.epoch, git: gitSnapshot, lastMessage: await hintOf(client, single.id), language }, { discovery, git, language, workerModel, quotaSnapshot, quotaWarnPct, zerosub });
    result.packetChars = result.packet.length;
    return result;
  }
  if (typeof lookupReceipt !== 'function') throw new SwitchRefused('Fresh needs a receipt lookup; refusing to create without a receipt');
  const run = execute ?? createExecutors({ client });

  const workspace = client.workspaces.ref(status.workspace.id);
  let from = single;
  let freshId;
  await lock(workspaceLockName(status.workspace.id), async (held) => {
    const current = (await workspace.refresh())?.metadata?.[METADATA_KEY];
    if (!current || current.epoch !== expected.epoch || current.activeSteer !== expected.activeSteer) {
      throw new SwitchRefused(`Steer state changed (expected ${expected.activeSteer}@${expected.epoch}, found ${current?.activeSteer}@${current?.epoch}); rerun the fresh command`);
    }
    let receipt;
    try {
      receipt = await lookupReceipt('agent', key);
    } catch (error) {
      throw new SwitchRefused(`Fresh receipt lookup failed (${error.message}); refusing to create without a receipt`);
    }
    if (!receipt) {
      if (!from) throw new SwitchRefused(`Steer ${slot} has several live agents (${holders.map((s) => s.id).join(', ')}); archive the retired one in Paseo, then rerun`);
      freshId = (await run(op, config))?.agentId; // the executor verifies parent freedom, labels and workspace
      if (!freshId) throw new Error('Fresh agent creation returned no agent id');
    } else {
      // A completed receipt re-sends the identical request (the daemon returns the
      // existing agent and creates nothing); anything else stops, as in apply.mjs.
      if (receipt.idempotencyKey && receipt.idempotencyKey !== key) throw new SwitchRefused('Fresh recovery stopped: the receipt belongs to a different key');
      if (receipt.outcomeUnknown) throw new SwitchRefused(`Fresh recovery stopped: the receipt has an unknown outcome (${receipt.error ?? 'outcome unknown'})`);
      if (receipt.phase !== 'completed') throw new SwitchRefused(`Fresh recovery stopped: the receipt is in phase ${receipt.phase}${receipt.error ? ` (${receipt.error})` : ''}`);
      if (!receipt.agentId) throw new SwitchRefused('Fresh recovery stopped: the receipt names no agent');
      if (!from) {
        // Interrupted apply: the receipt names the in-flight agent, the other
        // holder is the old steer. Anything else stays ambiguous and stops.
        const rest = holders.filter((h) => h.id !== receipt.agentId);
        if (!holders.some((h) => h.id === receipt.agentId) || rest.length !== 1) {
          throw new SwitchRefused(`Steer ${slot} has several live agents (${holders.map((s) => s.id).join(', ')}); archive the retired one in Paseo, then rerun`);
        }
        from = rest[0];
        if (BUSY.has(from.status)) throw new SwitchRefused(`Active Steer ${slot} is ${from.status}; stop it or wait for its turn to end first`);
      }
      let confirmed;
      try {
        confirmed = await run(op, config);
      } catch (error) {
        throw new SwitchRefused(`Fresh recovery stopped: the identical request was rejected (${error.message})`);
      }
      if (confirmed?.agentId !== receipt.agentId) throw new SwitchRefused(`Fresh recovery stopped: the identical request returned ${confirmed?.agentId}, receipt says ${receipt.agentId}`);
      if (receipt.agentId === from.id) throw new SwitchRefused('Fresh recovery stopped: the receipt names the current Steer itself');
      freshId = receipt.agentId;
      result.reused = true;
    }
    held.verify(); // the lock file must still be the locked inode right before the write
    await workspace.setMetadata({ [METADATA_KEY]: { ...current, activeSteer: slot, epoch: current.epoch + 1, previousSteer: from.id, switchedAt: now().toISOString() } });
    const written = (await workspace.refresh())?.metadata?.[METADATA_KEY];
    if (written?.epoch !== expected.epoch + 1 || written?.activeSteer !== slot) throw new Error('Fresh steer not verifiable after write');
  });
  result.from = from.id;
  result.applied = true;
  result.to = freshId;
  result.renameError = applyActiveMarker({ // the new agent is created marked; only the retired one loses the marker
    paseoCli, marker: activeMarker(config),
    mark: null, unmark: { id: from.id, title: from.title ?? null, slot },
  });
  result.packet = handoffWithBrief(status, { from, to: { slot, id: freshId }, epoch: expected.epoch, git: gitSnapshot, lastMessage: await hintOf(client, from.id), language }, { discovery, git, language, workerModel, quotaSnapshot, quotaWarnPct, zerosub });
  result.packetChars = result.packet.length;
  try {
    await client.agents.ref(freshId).send(result.packet);
    result.delivered = true;
  } catch (error) {
    result.deliveryError = error.message; // the fresh steer stands; resend the packet manually
  }
  try {
    await client.agents.ref(from.id).send(previousSteerNotice({ slot, id: freshId }, expected.epoch + 1, language)); // costs one turn of the retired steer
    result.previousNotified = true;
  } catch {
    result.previousNotified = false;
  }
  return result;
}

export async function hintOf(client, agentId) {
  try {
    return lastAssistantText(await client.agents.ref(agentId).timeline.refetch({ direction: 'tail', limit: 20 }));
  } catch {
    return null;
  }
}

/** Records a short task checkpoint for the current epoch (same lock as switches). A fresh checkpoint clears the interrupted flag — except source `auto`, which never clears it. Source `failover` logs a takeover with the previous steer and reason. */
export async function writeCheckpoint({ client, discovery, task, tests = [], blockers = [], next = null, source = 'manual', agentId = null, turnId = null, previousSteer = null, failoverReason = null, lock = withLock, now = () => new Date() }) {
  const status = steerStatus(discovery);
  if (!status.workspace || !status.state) throw new SwitchRefused('No factory main workspace with steer state');
  if (typeof task !== 'string' || !task.trim()) throw new SwitchRefused('A checkpoint needs a task');
  const workspace = client.workspaces.ref(status.workspace.id);
  return lock(workspaceLockName(status.workspace.id), async (held) => {
    const metadata = (await workspace.refresh())?.metadata ?? {};
    const fresh = metadata[METADATA_KEY];
    const stamp = now().toISOString();
    const checkpoint = { task: task.trim(), tests, blockers, next: next?.trim() || null, epoch: fresh?.epoch ?? null, updatedAt: stamp, source, agentId, turnId, capturedAt: stamp, interrupted: source === 'auto' ? (metadata[CHECKPOINT_KEY]?.interrupted ?? null) : null, ...(source === 'failover' ? { failover: { previousSteer, reason: failoverReason } } : {}) };
    held.verify();
    await workspace.setMetadata({ [CHECKPOINT_KEY]: checkpoint });
    return checkpoint;
  });
}
