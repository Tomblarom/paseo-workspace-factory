// Scope authority is checked against a fresh observation while the workspace
// lock is held. This is a cooperative generation fence, not authentication.
import { liveSlotHolders, resolveSteerHolders } from './discovery.mjs';
import { LABEL, LEGACY_PREFIX, METADATA_KEY, parentOf, readPaseoAgents } from './paseo.mjs';
import { sameScopeId } from './scope.mjs';
import { isAdvisorSlot } from './config.mjs';

export class ScopeGuardError extends Error {}

/** Resolve a unique, live holder using the same continuation and slot rules as discovery. */
export function scopeHolder({ agents, workspaceId, scopeId, slot, switches = [], excludeIds = [], aliases = [], ownerId = null, previousSteer = null, strictLegacy = false }) {
  const excluded = new Set(excludeIds);
  const labelled = (agents ?? []).filter((a) => {
    const labels = a?.labels ?? {};
    const scope = labels[LABEL.scope] ?? labels[LABEL.repo] ?? labels[`${LEGACY_PREFIX}.scope`] ?? labels[`${LEGACY_PREFIX}.repo`];
    const role = labels[LABEL.role] ?? labels[`${LEGACY_PREFIX}.role`];
    return !excluded.has(a?.id) && role === 'steer' && [scopeId, ...aliases].some((id) => sameScopeId(scope, id));
  });
  const resolved = resolveSteerHolders(labelled, agents, switches).filter((a) => !a.archivedAt && (a.labels?.[LABEL.slot] ?? a.labels?.[`${LEGACY_PREFIX}.slot`]) === slot);
  const holders = ownerId
    ? resolved.filter((a) => a.id === ownerId || a.continuedFrom === ownerId)
    : liveSlotHolders(resolved, slot);
  if (holders.length !== 1) throw new ScopeGuardError(`Expected one active Steer ${slot}, found ${holders.length}`);
  const holder = holders[0];
  if (!ownerId && strictLegacy && resolved.some((a) => a.id !== holder.id && a.id !== previousSteer)) {
    throw new ScopeGuardError(`Active Steer ${slot} has ambiguous legacy membership`);
  }
  if (holder.workspaceId !== workspaceId || parentOf(holder)) throw new ScopeGuardError('Active steer has invalid workspace or parent');
  return holder;
}

/** Call only inside the matching workspace lock; verify the lock again immediately before writing. */
export async function guardScope({ client, held, workspaceId, scopeId, epoch, agentId, slot = null, switches = [], excludeIds = [], aliases = [], config = null }) {
  if (!workspaceId || !scopeId || !Number.isInteger(epoch) || !agentId) throw new ScopeGuardError('Scope guard needs workspace, scope, integer epoch and active agent id');
  const metadata = (await client.workspaces.ref(workspaceId).refresh())?.metadata ?? {};
  const state = metadata[METADATA_KEY] ?? metadata[LEGACY_PREFIX];
  if (!state || state.retired || state.epoch !== epoch || (slot && state.activeSteer !== slot) || (state.scope?.id && !sameScopeId(state.scope.id, scopeId))) {
    throw new ScopeGuardError(`Scope state changed since discovery (expected ${slot ?? '?'}@${epoch}, found ${state?.activeSteer}@${state?.epoch}); repeat the operation`);
  }
  if (config && isAdvisorSlot(config, state.activeSteer)) throw new ScopeGuardError('An advisor steer cannot hold scope authority');
  const agents = await readPaseoAgents(client);
  const holder = scopeHolder({ agents, workspaceId, scopeId, slot: state.activeSteer, switches, excludeIds, aliases, ownerId: state.activeAgentId, previousSteer: state.previousSteer, strictLegacy: true });
  if (holder.id !== agentId) throw new ScopeGuardError('Active steer changed since discovery; repeat the operation');
  held.verify();
  return { metadata, state, holder, agents };
}

/** Discovery verifies legacy repo aliases before selecting these labelled members. */
export function discoveryScopeAliases(discovery) {
  return [...new Set((discovery?.steers?.labelled ?? []).flatMap((agent) => [agent.labels?.[LABEL.scope], agent.labels?.[LABEL.repo]]).filter(Boolean))];
}
