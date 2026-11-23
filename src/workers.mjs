// Worker lifecycle preview. Paseo 0.16.2 archives a workspace by archiving its
// agents and terminals and then, for a Paseo-owned worktree no other active
// workspace references, runs `git worktree remove --force`: uncommitted, untracked
// and ignored files are deleted without a dirty check, and commits that exist only
// on a detached HEAD become unreachable. The factory therefore only previews
// retirement; archiving is disabled until these checks are proven on real data.
import { LABEL, parentOf } from './paseo.mjs';

export const LIFECYCLE_LABEL = 'wsf.lifecycle'; // "reusable" keeps a worker
export const RETIREMENT_ENABLED = false;

const BUSY = new Set(['running', 'initializing']);

/**
 * @param gitState { dirty, untracked, ignored, detached, ahead } from readGitState, or null if unknown
 * @param terminals live terminals of the worker's workspace (unknown = null)
 */
export function assessWorker(worker, { agents, workspaces, gitState, backgroundWork = null, terminals = null }) {
  const reasons = [];
  if (!worker) return { archiveAgent: false, archiveWorkspace: false, reasons: ['agent not found'], workspaceReasons: [], workspaceId: null };
  if (worker.archivedAt) reasons.push('already archived');
  if (worker.labels?.[LABEL.role] === 'steer') reasons.push('is a steer, not a worker');
  if (!parentOf(worker)) reasons.push('has no parent; not a delegated worker');
  if (BUSY.has(worker.status)) reasons.push(`status is ${worker.status}`);
  if (worker.activeTurn) reasons.push('has an active turn');
  if (worker.pendingPermissions?.length) reasons.push('has pending permission requests');
  if (worker.requiresAttention) reasons.push('requires attention');
  if (worker.labels?.[LIFECYCLE_LABEL] === 'reusable') reasons.push('marked reusable');
  if (backgroundWork === null) reasons.push('background work unknown');
  else if (backgroundWork.length) reasons.push(`${backgroundWork.length} background task(s) still listed`);
  const children = agents.filter((a) => !a.archivedAt && parentOf(a) === worker.id);
  if (children.length) reasons.push(`has ${children.length} live subagent(s)`);
  const archiveAgent = reasons.length === 0;

  const workspace = workspaces.find((w) => w.id === worker.workspaceId) ?? null;
  const workspaceReasons = [];
  if (!workspace) workspaceReasons.push('workspace not found');
  else {
    if (!(workspace.workspaceKind === 'worktree' && workspace.project?.checkout?.isPaseoOwnedWorktree === true)) workspaceReasons.push('not verifiably a Paseo-owned worktree workspace');
    const others = agents.filter((a) => !a.archivedAt && a.id !== worker.id && a.workspaceId === workspace.id);
    if (others.length) workspaceReasons.push(`${others.length} other live agent(s) use it`);
    if (terminals === null) workspaceReasons.push('terminal state unknown');
    else if (terminals.length) workspaceReasons.push(`${terminals.length} terminal(s) open; archiving kills their processes`);
    if (!gitState) workspaceReasons.push('git state unknown');
    else {
      if (gitState.dirty) workspaceReasons.push('uncommitted changes');
      if (gitState.untracked) workspaceReasons.push(`${gitState.untracked} untracked path(s)`);
      if (gitState.ignored) workspaceReasons.push(`${gitState.ignored} ignored path(s) would be deleted`);
      if (gitState.detached) workspaceReasons.push('detached HEAD; commits would lose their reference');
      if (gitState.ahead === null) workspaceReasons.push('no upstream to compare; commits may be unpublished');
      else if (gitState.ahead > 0) workspaceReasons.push(`${gitState.ahead} unpushed commit(s)`);
    }
  }
  return {
    archiveAgent,
    archiveWorkspace: archiveAgent && workspaceReasons.length === 0,
    reasons,
    workspaceReasons,
    workspaceId: workspace?.id ?? null,
  };
}

export function readGitState(git, path) {
  try {
    const lines = git(path, ['status', '--porcelain', '--ignored']).split('\n').filter(Boolean);
    const untracked = lines.filter((l) => l.startsWith('??')).length;
    const ignored = lines.filter((l) => l.startsWith('!!')).length;
    const dirty = lines.length - untracked - ignored > 0;
    let detached = false;
    try {
      git(path, ['symbolic-ref', '-q', 'HEAD']);
    } catch {
      detached = true;
    }
    let ahead = null;
    try {
      ahead = Number(git(path, ['rev-list', '--count', '@{upstream}..HEAD']).trim());
    } catch {
      ahead = null;
    }
    return { dirty, untracked, ignored, detached, ahead };
  } catch {
    return null;
  }
}

/** Archiving stays disabled for the pilot; this refuses before touching anything. */
export async function retireWorker({ client, workerId, loadContext, archiveWorkspace = false, enabled = RETIREMENT_ENABLED }) {
  if (!enabled) throw new Error('Worker archiving is disabled for the pilot; use the preview only');
  const context = await loadContext();
  const worker = context.agents.find((a) => a.id === workerId);
  const assessment = assessWorker(worker, context);
  if (!assessment.archiveAgent) throw new Error(`Worker ${workerId} must stay: ${assessment.reasons.join('; ')}`);
  if (archiveWorkspace && !assessment.archiveWorkspace) throw new Error(`Workspace must stay: ${assessment.workspaceReasons.join('; ')}`);
  await client.agents.ref(workerId).archive();
  let workspace = null;
  if (archiveWorkspace) {
    workspace = await client.workspaces.archive(assessment.workspaceId);
    if (workspace?.error) throw new Error(`Workspace archive failed after the agent was archived: ${workspace.error}`);
  }
  return { workerId, archivedAgent: true, workspace };
}
