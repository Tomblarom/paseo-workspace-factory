// @ts-nocheck
// GENERATED from src/steer-action.mjs by npm run plugin:sync. Do not edit.
// Durable, per-target delivery state. An attempted request is immutable: Paseo's
// message receipt can only be replayed with the same recipient, bytes and options.
import { randomUUID } from 'node:crypto';
import { AGENTS_KEY } from './agent-state.js';
import { withLock, workspaceLockName } from './lock.js';
import { METADATA_KEY, LEGACY_PREFIX } from './paseo.js';
import { guardScope } from './scope-guard.js';
import { actionFact, mergeActionFacts } from './action-facts.js';

export function readSteerAction(entry, workspaceId) {
  if (entry?.action) return entry.pendingAction && !entry.action.cleanup ? { ...entry.action, cleanup: entry.pendingAction } : entry.action;
  const old = entry?.pendingWakeBrief;
  if (old?.wakeId) {
    let action = { ...old, kind: 'delivery' };
    if (!old.renewal && Array.isArray(old.events)) {
      const phase = old.briefSent ? 'sent' : entry.pendingAction ? 'renewing' :
        actionFact(entry, 'cleared')?.mode === 'clear' && actionFact(entry, 'actionVerified') === true ? 'ready' : 'blocked';
      action = { ...action, renewal: 'clear', phase, queuedAt: old.queuedAt ?? '', epoch: old.epoch ?? null,
        batch: { workspaceId, epoch: old.epoch ?? null, events: old.events },
        ...(phase === 'blocked' ? { lastError: 'The previous context clear could not be confirmed.' } : {}) };
    }
    // Old versions allowed an independent stage while renewal was pending.
    if (entry.stagedBrief?.packet) action = { ...action, legacyStage: entry.stagedBrief };
    if (entry.lastSteerDeliveryId) action.lastDeliveryId = entry.lastSteerDeliveryId;
    if (entry.pendingAction) action.cleanup = entry.pendingAction;
    return action;
  }
  if (entry?.pendingAction) return { kind: 'cleanup', wakeId: entry.pendingAction.messageId ?? `legacy-cleanup-${entry.pendingAction.at ?? 'unknown'}`, phase: 'renewing', cleanup: entry.pendingAction };
  if (entry?.stagedBrief?.packet?.trim()) return { kind: 'stage', wakeId: randomUUID(), phase: 'staged', ...entry.stagedBrief, ...(entry.lastSteerDeliveryId ? { lastDeliveryId: entry.lastSteerDeliveryId } : {}) };
  if (entry?.lastSteerDeliveryId) return { kind: 'delivery', wakeId: entry.lastSteerDeliveryId, phase: 'done' };
  return null;
}

export function actionEntry(entry, action) {
  const { pendingWakeBrief, stagedBrief, lastSteerDeliveryId, pendingAction, ...rest } = entry ?? {};
  if (pendingAction && action && !action.cleanup) action = { ...action, cleanup: pendingAction };
  return mergeActionFacts(rest, { action });
}

export function readCleanupAction(entry) {
  return entry?.action?.cleanup ?? entry?.pendingAction ?? null;
}

/** @param {any} input @returns {any} */
export function newSteerAction(input) {
  const { kind = 'delivery', epoch = null, at = new Date().toISOString(), text, options, batch, note, renewal = 'send', phase = 'ready', id = randomUUID() } = input;
  return { kind, wakeId: id, epoch, queuedAt: at, renewal, phase, note: note ?? '',
    ...(text === undefined ? {} : { packet: text }), ...(options ? { sendOptions: options } : {}), ...(batch ? { batch } : {}) };
}

// Persist the attempt under the interprocess lock before calling send.
// A native receipt replay uses exactly the persisted request; no new key or
// packet may be created after an attempted dispatch. A process death releases
// the lock, so the next reconciliation can ask the daemon about that receipt.
// Concurrent exact replays are serialized by the native receipt, not by a lock
// held across an RPC that can itself cause a hook to take the workspace lock.
export async function reconcileSteerSend({ client, workspaceId, agentId, actionId, lock = withLock, validate = null, now = () => new Date().toISOString() }) {
  const workspace = client.workspaces.ref(workspaceId);
  const claim = await lock(workspaceLockName(workspaceId), async (held) => {
    const meta = (await workspace.refresh())?.metadata ?? {};
    const entries = meta[AGENTS_KEY] ?? {};
    const action = readSteerAction(entries[agentId], workspaceId);
    if (!action || action.wakeId !== actionId) return { status: 'missing' };
    if (action.phase === 'sent' || action.phase === 'done') return { status: 'sent', action };
    if (!['ready', 'uncertain'].includes(action.phase) || typeof action.packet !== 'string') return { status: 'pending', action };
    const scope = meta[METADATA_KEY] ?? meta[LEGACY_PREFIX];
    if (scope?.retired || (action.epoch != null && action.epoch !== scope?.epoch)) return { status: 'blocked', action, detail: 'Scope authority changed before delivery.' };
    if (action.authority) {
      try { await guardScope({ client, held, workspaceId, scopeId: action.authority.scopeId, epoch: action.epoch, agentId: action.authority.agentId }); }
      catch (error) { return { status: 'blocked', action, detail: `Scope authority changed before delivery (${error.message}).` }; }
    }
    if (validate && !await validate(action, meta)) return { status: 'pending', action };
    const attempted = { ...action, phase: 'uncertain', attemptedAt: action.attemptedAt ?? now() };
    held.verify();
    await workspace.setMetadata({ [AGENTS_KEY]: { ...entries, [agentId]: actionEntry(entries[agentId], attempted) } });
    return { status: 'attempt', action: attempted };
  });
  if (claim.status !== 'attempt') return claim;
  try {
    await client.agents.ref(agentId).send(claim.action.packet, { ...claim.action.sendOptions, messageId: claim.action.wakeId });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await lock(workspaceLockName(workspaceId), async (held) => {
      const meta = (await workspace.refresh())?.metadata ?? {};
      const entries = meta[AGENTS_KEY] ?? {};
      const current = readSteerAction(entries[agentId], workspaceId);
      if (current?.wakeId !== actionId || current.phase !== 'uncertain') return;
      held.verify();
      await workspace.setMetadata({ [AGENTS_KEY]: { ...entries, [agentId]: actionEntry(entries[agentId], { ...current, lastError: detail.slice(0, 300) }) } });
    }).catch(() => {});
    return { status: 'uncertain', action: claim.action, detail };
  }
  return lock(workspaceLockName(workspaceId), async (held) => {
    const current = (await workspace.refresh())?.metadata ?? {};
    const entries = current[AGENTS_KEY] ?? {};
    const action = readSteerAction(entries[agentId], workspaceId);
    if (action?.wakeId !== actionId) return { status: 'uncertain', action: claim.action, detail: 'Delivery accepted but its record changed.' };
    if (action.phase === 'done' || action.phase === 'sent') return { status: 'sent', action };
    const sent = { ...action, phase: 'sent', observedAt: now() };
    held.verify();
    await workspace.setMetadata({ [AGENTS_KEY]: { ...entries, [agentId]: actionEntry(entries[agentId], sent) } });
    return { status: 'sent', action: sent };
  });
}
