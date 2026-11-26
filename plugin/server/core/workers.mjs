// Scoped worker creation plus the git-state reader the archive guards use.
// Accepted workers are archived natively in Paseo (`paseo archive`); there is
// no factory retire command.
import { LABEL, METADATA_KEY } from './paseo.mjs';
import { liveSlotHolders } from './discovery.mjs';
import { idempotencyKey, profileAgentConfig, requestDigest } from './steer-create.mjs';
import { ACCOUNT_METADATA_KEY } from './zerosub.mjs';
import { findingsPassage } from './findings.mjs';
import { WORKER_ROLE_PROMPT, withFactoryCli } from './role-prompts.mjs';
import { withWorkspaceLock } from './lock.mjs';
import { guardScope } from './scope-guard.mjs';
import { createExecutors } from './apply.mjs';

export async function startScopedWorker({ client, status, callerId, aliases = [], profile, accountId, prompt, title, apply = false, promptOptions, execute = null }) {
  const { state, workspace, repo, steers } = status;
  const slot = state?.activeSteer;
  const holders = liveSlotHolders(steers, slot);
  const parent = holders.length === 1 ? holders[0] : null;
  if (!workspace?.id || state?.retired || !parent || parent.id !== callerId || parent.advisor || parent.parent || parent.workspaceId !== workspace.id) {
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
    ...(accountId ? { metadata: { [ACCOUNT_METADATA_KEY]: accountId } } : {}),
  };
  const result = { scope: scopeId, workspaceId: workspace.id, parentId: parent.id, profile: profile.name, provider: request.config.provider, accountId: accountId ?? null };
  if (!apply) return result;

  // The same assignment keeps its key when prompt settings change between retries: the digest covers the raw task, not the appended role text.
  const key = idempotencyKey(scopeId, 'worker', slot, `e${state.epoch}`, requestDigest({ parentId: parent.id, title: request.title, prompt }));
  const run = execute ?? createExecutors({ client });
  const created = await withWorkspaceLock(workspace.id, async (held) => {
    await guardScope({ client, held, workspaceId: workspace.id, scopeId, epoch: state.epoch, agentId: parent.id, aliases });
    held.verify();
    return run({ key, kind: 'paseo.agent.createWorker', params: { ...request, workspaceId: workspace.id, idempotencyKey: key } });
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
