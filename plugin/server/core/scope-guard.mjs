// Scope authority is checked against a fresh observation while the workspace
// lock is held. This is a cooperative generation fence, not authentication.
import { liveSlotHolders, resolveSteerHolders } from './discovery.mjs';
import { LABEL, METADATA_KEY, parentOf, readPaseoAgents } from './paseo.mjs';
import { sameScopeId } from './scope.mjs';
import { isAdvisorSteer } from './config.mjs';
import { continuedFromId, resolveFactoryLabels } from './zerosub.mjs';

export class ScopeGuardError extends Error {}

/**
 * Resolve the one live holder of a slot with the same continuation and title
 * rules as discovery: the tab titled "Steer <slot>" is the holder; two such
 * tabs are ambiguous and never ranked.
 */
export function scopeHolder({ agents, workspaceId, scopeId, slot, switches = [], excludeIds = [], aliases = [] }) {
  const excluded = new Set(excludeIds);
  const labelled = (agents ?? []).filter((a) => {
    const labels = a?.labels ?? {};
    const scope = labels[LABEL.scope] ?? labels[LABEL.repo];
    const role = labels[LABEL.role];
    return !excluded.has(a?.id) && role === 'steer' && [scopeId, ...aliases].some((id) => sameScopeId(scope, id));
  });
  const resolved = resolveSteerHolders(labelled, agents, switches).filter((a) => {
    if (a.archivedAt || a.labels?.[LABEL.slot] !== slot) return false;
    const raw = (agents ?? []).find((agent) => agent.id === a.id);
    const labels = resolveFactoryLabels(raw, agents);
    return labels?.[LABEL.role] === 'steer' && labels[LABEL.slot] === slot &&
      [scopeId, ...aliases].some((id) => sameScopeId(labels[LABEL.scope] ?? labels[LABEL.repo], id));
  });
  // Membership is limited to parentless tabs of the scope main workspace.
  const holders = liveSlotHolders(resolved, slot).filter((a) => a.workspaceId === workspaceId && !parentOf(a));
  if (holders.length !== 1) throw new ScopeGuardError(`Expected one active Steer ${slot}, found ${holders.length}`);
  const holder = holders[0];
  if (holder.status === 'error' && (agents ?? []).some((agent) => continuedFromId(agent) === holder.id)) {
    throw new ScopeGuardError('Errored steer has a continuation and cannot resume scope authority');
  }
  return holder;
}

/** Call only inside the matching workspace lock; verify the lock again immediately before writing. */
export async function guardScope({ client, held, workspaceId, scopeId, epoch, agentId, slot = null, switches = [], excludeIds = [], aliases = [], config = null }) {
  if (!workspaceId || !scopeId || !Number.isInteger(epoch) || !agentId) throw new ScopeGuardError('Scope guard needs workspace, scope, integer epoch and active agent id');
  const metadata = (await client.workspaces.ref(workspaceId).refresh())?.metadata ?? {};
  const state = metadata[METADATA_KEY];
  if (!state || state.retired || state.epoch !== epoch || (slot && state.activeSteer !== slot) || (state.scope?.id && !sameScopeId(state.scope.id, scopeId))) {
    throw new ScopeGuardError(`Scope state changed since discovery (expected ${slot ?? '?'}@${epoch}, found ${state?.activeSteer}@${state?.epoch}); repeat the operation`);
  }
  const agents = await readPaseoAgents(client);
  const holder = scopeHolder({ agents, workspaceId, scopeId, slot: state.activeSteer, switches, excludeIds, aliases });
  if (isAdvisorSteer(config, holder.labels, holder.metadata)) throw new ScopeGuardError('An advisor steer cannot hold scope authority');
  if (holder.id !== agentId) throw new ScopeGuardError('Active steer changed since discovery; repeat the operation');
  held.verify();
  return { metadata, state, holder, agents };
}

/** Discovery verifies legacy repo aliases before selecting these labelled members. */
export function discoveryScopeAliases(discovery) {
  return [...new Set((discovery?.steers?.labelled ?? []).flatMap((agent) => [agent.labels?.[LABEL.scope], agent.labels?.[LABEL.repo]]).filter(Boolean))];
}
