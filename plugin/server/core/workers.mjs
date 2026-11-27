// Scoped worker creation plus the git-state reader the archive guards use.
// Accepted workers are archived natively in Paseo (`paseo archive`); there is
// Paseo owns agent archiving.
import { createPaseoCli, LABEL, METADATA_KEY, PARENT_LABEL, parentOf } from './paseo.mjs';
import { liveSlotHolders } from './discovery.mjs';
import { idempotencyKey, profileAgentConfig, requestDigest } from './steer-create.mjs';
import { findingsPassage } from './findings.mjs';
import { WORKER_ROLE_PROMPT, withFactoryCli } from './role-prompts.mjs';
import { withWorkspaceLock, workspaceLockName } from './lock.mjs';
import { guardScope } from './scope-guard.mjs';
import { createExecutors } from './apply.mjs';
import { sameScopeId } from './scope.mjs';

export function planWorkerHandover({ agents, scopeId, workspaceId, fromId, fromSlot, aliases }) {
  if (!fromId) return [];
  return agents.flatMap((agent) => {
    if (agent.archivedAt || agent.background || !agent.workspaceId) return [];
    const labels = agent.labels ?? {};
    const scope = labels[LABEL.scope] ?? labels[LABEL.repo];
    if ((labels[LABEL.role] && labels[LABEL.role] !== 'worker') ||
        (scope && ![scopeId, ...aliases].some((id) => sameScopeId(id, scope)))) return [];
    const parent = parentOf(agent);
    const detachedWorker = !parent && agent.workspaceId === workspaceId && scope &&
      labels[LABEL.role] === 'worker' && labels[LABEL.owner] === fromSlot;
    return parent === fromId || detachedWorker ? [{ id: agent.id, parent, workspaceId: agent.workspaceId }] : [];
  });
}

/** Finish the native links reserved with the authority change. The same update
 * leaves the worker's tab, runtime and session intact and has no parentless gap. */
export async function finishWorkerHandover({ client, workspaceId, state, held, paseoCli }) {
  const pending = state?.workerHandover;
  if (!pending || pending.epoch !== state.epoch || pending.toId !== state.activeAgentId) return;
  const applyLabels = paseoCli ?? createPaseoCli();
  const { toId, scopeId } = pending;
  const target = (await client.agents.ref(toId).refresh())?.agent;
  if (!target || target.archivedAt || parentOf(target) || target.workspaceId !== workspaceId) {
    throw new Error('The new steer is no longer available for worker handover');
  }
  for (const { id, parent, workspaceId: workerWorkspaceId } of pending.workers) {
    const handle = client.agents.ref(id);
    const current = (await handle.refresh())?.agent;
    if (!current || current.archivedAt) continue;
    if (current.workspaceId !== workerWorkspaceId || current.background ||
        ![parent, toId].includes(parentOf(current))) continue; // a newer native placement wins
    const labels = {
      [PARENT_LABEL]: toId, [LABEL.scope]: scopeId, [LABEL.role]: 'worker', [LABEL.owner]: state.activeSteer,
    };
    const matches = (agent) => agent && Object.entries(labels).every(([key, value]) => agent.labels?.[key] === value);
    if (matches(current)) continue;
    held.verify();
    applyLabels(['agent', 'update', id, '--label', Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(',')]);
    if (!matches((await handle.refresh())?.agent)) throw new Error('Paseo did not confirm the worker handover');
  }
  const workspace = client.workspaces.ref(workspaceId);
  const { workerHandover, ...settled } = (await workspace.refresh())?.metadata?.[METADATA_KEY] ?? {};
  if (settled.epoch !== pending.epoch || settled.activeAgentId !== toId) throw new Error('Authority changed during worker handover');
  held.verify();
  await workspace.setMetadata({ [METADATA_KEY]: settled });
}

export async function retryWorkerHandover(client, workspaceId, lock, paseoCli) {
  const workspace = client.workspaces.ref(workspaceId);
  return lock(workspaceLockName(workspaceId), async (held) => {
    const live = (await workspace.refresh())?.metadata?.[METADATA_KEY];
    await finishWorkerHandover({ client, workspaceId, state: live, held, paseoCli });
  });
}

export async function startScopedWorker({ client, status, callerId, aliases = [], profile, accountId, prompt, title, apply = false, promptOptions, config, execute = null }) {
  const { state, workspace, repo, steers } = status;
  const slot = state?.activeSteer;
  const holders = liveSlotHolders(steers, slot);
  const parent = holders.length === 1 ? holders[0] : null;
  if (!workspace?.id || !parent || parent.id !== callerId || parent.advisor || parent.parent || parent.workspaceId !== workspace.id) {
    throw new Error('Only the active steer can start a worker in this scope');
  }
  if (!prompt?.trim()) throw new Error('worker start needs --task <text>');
  const scopeId = state.scope?.id ?? repo;
  const labels = { [LABEL.scope]: scopeId, [LABEL.role]: 'worker', [LABEL.owner]: slot };
  const findings = findingsPassage(promptOptions);
  const roleBlock = withFactoryCli(WORKER_ROLE_PROMPT, promptOptions);
  const request = {
    title: title?.trim() || 'Worker',
    parent: parent.id,
    prompt: [prompt, roleBlock, findings || null].filter(Boolean).join('\n\n'),
    labels,
    config: profileAgentConfig(profile),
  };
  const result = { scope: scopeId, workspaceId: workspace.id, parentId: parent.id, profile: profile.name, provider: request.config.provider, accountId: accountId ?? null };
  if (!apply) return result;

  // The same assignment keeps its key when prompt settings change between retries: the digest covers the raw task, not the appended role text.
  const key = idempotencyKey(scopeId, 'worker', slot, `e${state.epoch}`, requestDigest({ parentId: parent.id, title: request.title, prompt }));
  const run = execute ?? createExecutors({ client });
  const created = await withWorkspaceLock(workspace.id, async (held) => {
    await guardScope({ client, held, workspaceId: workspace.id, scopeId, epoch: state.epoch, agentId: parent.id, aliases });
    held.verify();
    return run({ key, kind: 'paseo.agent.createWorker', params: { ...request, workspaceId: workspace.id, idempotencyKey: key } }, config);
  });
  if (!created?.agentId) throw new Error('Worker creation returned no agent id');
  return { ...result, accountId: created.accountId ?? null, agentId: created.agentId };
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
