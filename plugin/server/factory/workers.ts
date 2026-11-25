// @ts-nocheck
// GENERATED from src/workers.mjs by npm run plugin:sync. Do not edit.
// Scoped worker creation plus the git-state reader the archive guards use.
// Accepted workers are archived natively in Paseo (`paseo archive`); there is
// no factory retire command.
import { LABEL, METADATA_KEY, parentOf } from './paseo.js';
import { idempotencyKey, requestDigest } from './planner.js';
import { ACCOUNT_METADATA_KEY } from './zerosub.js';
import { findingsPassage } from './findings.js';

export async function startScopedWorker({ client, status, callerId, profile, accountId, prompt, title, apply = false, promptOptions }) {
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
  const findings = findingsPassage(promptOptions);
  const request = {
    title: title?.trim() || 'Worker',
    parent: parent.id,
    prompt: findings ? `${prompt}\n\n${findings}` : prompt,
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

  // The same assignment keeps its key when prompt settings change between retries.
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
