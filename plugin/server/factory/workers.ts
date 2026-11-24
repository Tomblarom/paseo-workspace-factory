// @ts-nocheck
// GENERATED from src/workers.mjs by npm run plugin:sync. Do not edit.
// Worker lifecycle preview. Paseo 0.16.2 archives a workspace by archiving its
// agents and terminals and then, for a Paseo-owned worktree no other active
// workspace references, runs `git worktree remove --force`: uncommitted, untracked
// and ignored files are deleted without a dirty check, and commits that exist only
// on a detached HEAD become unreachable. The factory therefore only previews
// retirement; archiving is disabled until these checks are proven on real data.
import { LABEL, METADATA_KEY, parentOf } from './paseo.js';
import { idempotencyKey, requestDigest } from './planner.js';
import { ACCOUNT_METADATA_KEY, continuedFromId, inheritContinuationLabels, resolveContinuations } from './zerosub.js';

export const LIFECYCLE_LABEL = 'wsf.lifecycle'; // "reusable" keeps a worker
export const RETIREMENT_ENABLED = false;

const BUSY = new Set(['running', 'initializing']);

export async function startScopedWorker({ client, status, callerId, profile, accountId, prompt, title, apply = false }) {
  const { state, workspace, repo, steers } = status;
  const slot = state?.activeSteer;
  const holders = steers.filter((steer) => steer.slot === slot && !steer.retired && !steer.superseded);
  const parent = holders.length === 1 ? holders[0] : null;
  if (!workspace?.id || state?.retired || !parent || parent.id !== callerId || parent.advisor || parent.parent || parent.workspaceId !== workspace.id) {
    throw new Error('Only the active steer can start a worker in this scope');
  }
  if (!prompt?.trim()) throw new Error('worker start needs --task <text>');
  const scopeId = state.scope?.id ?? repo;
  const labels = { [LABEL.scope]: scopeId, [LABEL.role]: 'worker', [LABEL.owner]: slot };
  const request = {
    title: title?.trim() || 'Worker',
    parent: parent.id,
    prompt,
    labels,
    config: {
      provider: `${profile.provider}/${profile.model}`,
      ...(profile.mode ? { modeId: profile.mode } : {}),
      ...(profile.thinking ? { thinkingOptionId: profile.thinking } : {}),
    },
    ...(accountId ? { metadata: { [ACCOUNT_METADATA_KEY]: accountId } } : {}),
  };
  const result = { scope: scopeId, workspaceId: workspace.id, parentId: parent.id, profile: profile.name, provider: request.config.provider, accountId: accountId ?? null };
  if (!apply) return result;

  const key = idempotencyKey(scopeId, 'worker', slot, `e${state.epoch}`, requestDigest({ parentId: parent.id, title: request.title, prompt }));
  const workspaceHandle = client.workspaces.ref(workspace.id);
  const current = (await workspaceHandle.refresh())?.metadata?.[METADATA_KEY];
  if (current?.activeSteer !== slot || current?.epoch !== state.epoch || current?.retired) {
    throw new Error('The active steer changed since discovery. Run worker start again from the active steer.');
  }
  const handle = await workspaceHandle.agents.create({ ...request, idempotencyKey: key });
  const agent = (await handle.refresh())?.agent;
  if (!agent || agent.workspaceId !== workspace.id || parentOf(agent) !== parent.id || (accountId && agent.metadata?.[ACCOUNT_METADATA_KEY] !== accountId)) {
    throw new Error('Worker creation could not be verified');
  }
  return { ...result, agentId: agent.id };
}

/**
 * @param gitState { dirty, untracked, ignored, detached, ahead } from readGitState, or null if unknown
 * @param terminals live terminals of the worker's workspace (unknown = null)
 * @param zerosubSwitches timeline-derived { agentId, continuedIn } pairs (see zerosub.mjs)
 */
export function assessWorker(worker, { agents, workspaces, gitState, backgroundWork = null, terminals = null, zerosubSwitches = [] }) {
  const reasons = [];
  if (!worker) return { archiveAgent: false, archiveWorkspace: false, reasons: ['agent not found'], workspaceReasons: [], workspaceId: null };
  const resolution = resolveContinuations(agents ?? [], zerosubSwitches);
  const supersededBy = resolution.liveFor[worker.id];
  if (supersededBy && supersededBy !== worker.id) {
    return { archiveAgent: false, archiveWorkspace: false, reasons: [`superseded by continuation ${supersededBy}; retire it instead`], workspaceReasons: [], workspaceId: null };
  }
  // A continuation tab is the same worker as its origin (ZeroSub copies no
  // labels): it is assessed with the origin's worker identity (parent, role,
  // lifecycle) while its own status and workspace decide the outcome.
  const originId = continuedFromId(worker);
  const origin = originId ? (agents ?? []).find((a) => a?.id === originId) : null;
  const effective = origin ? { ...worker, labels: inheritContinuationLabels(worker, origin) } : worker;
  if (effective.archivedAt) reasons.push('already archived');
  if (effective.labels?.[LABEL.role] === 'steer') reasons.push('is a steer, not a worker');
  if (!parentOf(effective)) reasons.push('has no parent; not a delegated worker');
  if (BUSY.has(effective.status)) reasons.push(`status is ${effective.status}`);
  if (effective.activeTurn) reasons.push('has an active turn');
  if (effective.pendingPermissions?.length) reasons.push('has pending permission requests');
  if (effective.requiresAttention) reasons.push('requires attention');
  if (effective.labels?.[LIFECYCLE_LABEL] === 'reusable') reasons.push('marked reusable');
  if (backgroundWork === null) reasons.push('background work unknown');
  else if (backgroundWork.length) reasons.push(`${backgroundWork.length} background task(s) still listed`);
  // Subagents parented to a superseded origin still belong to the live worker.
  const family = new Set([worker.id]);
  for (const [o, live] of Object.entries(resolution.liveFor)) if (live === worker.id) family.add(o);
  const children = (agents ?? []).filter((a) => !a.archivedAt && a.id !== worker.id && family.has(parentOf(a)));
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
