// Z1 preparation: the native move owns runtime changes; the existing delivery
// action owns its durable attempt. Automatic routing stays disabled until Z1's
// live gate passes. Neither entry point sends work or retries a native move.
import { AGENTS_KEY } from './agent-state.mjs';
import { actionEntry, readSteerAction } from './steer-action.mjs';
import { withLock, workspaceLockName } from './lock.mjs';
import { guardScope } from './scope-guard.mjs';
import { latestSwitchRow, moveZerosubBeforeLimit, readZerosubState } from './zerosub.mjs';

const result = (status, detail) => ({ status, detail });

async function observe(client, agentId) {
  const [snapshot, zerosub, timeline] = await Promise.all([
    client.agents.ref(agentId).refresh(), readZerosubState(),
    client.agents.ref(agentId).timeline.refetch({ direction: 'tail', limit: 20 }),
  ]);
  return { agent: snapshot?.agent, zerosub, row: latestSwitchRow(timeline) };
}

async function authority(args, action, held) {
  if (!action.authority || action.authority.agentId !== args.agentId) return false;
  try {
    await guardScope({ client: args.client, held, workspaceId: args.workspaceId,
      scopeId: action.authority.scopeId, epoch: action.epoch, agentId: args.agentId });
    return true;
  } catch { return false; }
}

function idleRuntime(agent) {
  return agent && !agent.archivedAt && agent.background !== true &&
    ['idle', 'error'].includes(agent.status) && !agent.activeTurn && !agent.pendingPermissions?.length;
}

function sameRuntime(agent, move) {
  return idleRuntime(agent) && agent.provider === move.provider && agent.model === move.model &&
    agent.persistence?.sessionId === move.sessionId;
}

/**
 * `validate` is required: recheck effective policy, open/idle runtime, privacy,
 * binding and account-specific fresh quota at each stage. It receives fresh
 * observations, never the planning snapshot. Source exhaustion is expected at
 * attempt time; destination quota must admit the work at reconcile time.
 * Return `true` to admit, `false` to defer, or (only during reconciliation)
 * `replan` when the runtime is verified but quota/policy requires another route.
 * A replan result may include an opaque eligibility key for recovery.
 */
export async function attemptSteerAccountMove(args) {
  const { client, workspaceId, agentId, actionId, accountId, validate,
    lock = withLock, now = () => new Date().toISOString(), readObservation = observe,
    move = moveZerosubBeforeLimit } = args;
  if (typeof validate !== 'function') throw new Error('Account move needs effect-time policy validation');
  if (typeof accountId !== 'string' || !accountId) throw new Error('Account move needs a target account');
  const workspace = client.workspaces.ref(workspaceId);
  const claimed = await lock(workspaceLockName(workspaceId), async (held) => {
    const meta = (await workspace.refresh())?.metadata ?? {};
    const entry = meta[AGENTS_KEY]?.[agentId];
    const action = readSteerAction(entry);
    if (action?.wakeId !== actionId) return result('blocked', 'Delivery action changed.');
    // One attempt per delivery, including no-effect refusals and waiting.
    if (action.accountMove) return result('reconcile', 'An account move attempt is already recorded.');
    if (!['reserved', 'ready'].includes(action.phase) || action.attemptedAt || action.cleanup || action.rewindAttempt ||
        !await authority(args, action, held)) return result('blocked', 'Delivery cannot start an account move.');
    const observation = await readObservation(client, agentId);
    const fromAccountId = observation.zerosub?.agentAccount?.[agentId];
    const agent = observation.agent;
    if (!fromAccountId || observation.zerosub?.pending?.[agentId] || !agent?.persistence?.sessionId || !idleRuntime(agent) ||
        await validate({ stage: 'attempt', accountId, observation, action, entry, meta }) !== true) {
      return result('blocked', 'Live account, runtime or policy no longer admits this move.');
    }
    // Recheck authority after asynchronous observation/policy reads.
    if (!await authority(args, action, held)) return result('blocked', 'Scope authority changed.');
    const accountMove = { phase: 'uncertain', attemptedAt: now(), fromAccountId, accountId,
      provider: agent.provider, model: agent.model, sessionId: agent.persistence.sessionId };
    held.verify();
    await workspace.setMetadata({ [AGENTS_KEY]: { ...meta[AGENTS_KEY],
      [agentId]: actionEntry(entry, { ...action, accountMove }) } });
    return { status: 'attempt', accountMove };
  });
  if (claimed.status !== 'attempt') return claimed;
  let reply;
  try { reply = await move({ agentId, accountId }); }
  catch { reply = { outcome: 'uncertain', reason: 'reply_lost', accountId: null, retryable: false }; }
  return lock(workspaceLockName(workspaceId), async (held) => {
    const meta = (await workspace.refresh())?.metadata ?? {};
    const entry = meta[AGENTS_KEY]?.[agentId];
    const action = readSteerAction(entry);
    if (action?.wakeId !== actionId || action.accountMove?.attemptedAt !== claimed.accountMove.attemptedAt) {
      return result('blocked', 'Move reply has no matching delivery action; do not retry.');
    }
    // Never let a late RPC reply overwrite read-only reconciliation.
    if (action.accountMove.phase === 'settled') return result('settled', 'The attempt was already reconciled.');
    const accountMove = { ...action.accountMove, reply: {
      outcome: reply.outcome, reason: reply.reason, accountId: reply.accountId, retryable: reply.retryable,
    } };
    held.verify();
    await workspace.setMetadata({ [AGENTS_KEY]: { ...meta[AGENTS_KEY], [agentId]: actionEntry(entry, { ...action, accountMove }) } });
    return result('reconcile', 'Read live runtime/account and quota before replanning or delivery.');
  });
}

function matchingSwitch(row, move, zerosub) {
  // ZeroSub rows contain display labels, not account IDs. Ambiguous or renamed
  // labels cannot confirm a lost reply. Live account identity is also required.
  const uniqueLabel = (id) => {
    const label = zerosub.accounts?.find((a) => a.id === id)?.label;
    return label && zerosub.accounts.filter((a) => a.label === label).length === 1 ? label : null;
  };
  const from = uniqueLabel(move.fromAccountId), to = uniqueLabel(move.accountId);
  return !!from && !!to && row?.from === from && row.to === to && row.family === move.provider &&
    row.reason === 'near_limit' && row.outcome === 'switched' &&
    !row.continued && !row.continuedIn && !row.toFamily &&
    Number.isFinite(Date.parse(row.at)) && Date.parse(row.at) >= Date.parse(move.attemptedAt);
}

/** Read-only recovery, including after a process restart or a lost native reply. */
export async function reconcileSteerAccountMove(args) {
  const { client, workspaceId, agentId, actionId, validate, lock = withLock,
    now = () => new Date().toISOString(), readObservation = observe } = args;
  if (typeof validate !== 'function') throw new Error('Account move needs effect-time policy validation');
  return lock(workspaceLockName(workspaceId), async (held) => {
    const workspace = client.workspaces.ref(workspaceId);
    const meta = (await workspace.refresh())?.metadata ?? {};
    const entry = meta[AGENTS_KEY]?.[agentId];
    const action = readSteerAction(entry), move = action?.accountMove;
    if (action?.wakeId !== actionId || !move) return result('blocked', 'No matching account move.');
    if (move.phase === 'settled') return result(move.resolution, 'The account move was already reconciled.');
    if (!await authority(args, action, held)) return result('blocked', 'Scope authority changed; the move remains recorded.');
    let observation;
    try { observation = await readObservation(client, agentId); }
    catch { return result('pending', 'Account move observation is unavailable.'); }
    const { agent, zerosub, row } = observation;
    if (!sameRuntime(agent, move) || !zerosub || zerosub.pending?.[agentId] || !zerosub.agentAccount?.[agentId]) {
      return result('pending', 'Live conversation/account is not confirmed.');
    }
    const liveAccount = zerosub.agentAccount[agentId];
    const outcome = move.reply?.outcome;
    const noEffect = ['waiting', 'refused', 'unsupported', 'unavailable'].includes(outcome);
    const acknowledged = ['moved', 'already'].includes(outcome) && move.reply.accountId === liveAccount;
    if (!noEffect && !acknowledged && !matchingSwitch(row, { ...move, accountId: liveAccount }, zerosub)) {
      return result('pending', 'A matching native switch observation is required.');
    }
    const observedResolution = liveAccount === move.accountId && !noEffect ? 'ready' : 'replan';
    const validation = await validate({ stage: 'reconcile', accountId: liveAccount, observation, action, entry, meta, resolution: observedResolution });
    const replan = validation === 'replan' || validation?.status === 'replan';
    if (validation !== true && !replan) {
      return result('pending', 'Current policy or account quota prevents continuation.');
    }
    const resolution = replan ? 'replan' : observedResolution;
    if (!await authority(args, action, held)) return result('blocked', 'Scope authority changed.');
    held.verify();
    await workspace.setMetadata({ [AGENTS_KEY]: { ...meta[AGENTS_KEY], [agentId]: actionEntry(entry, {
      ...action, accountMove: { ...move, phase: 'settled', resolution, observedAccountId: liveAccount, observedAt: now() },
      ...(resolution === 'replan' && typeof validation?.eligibilityKey === 'string'
        ? { accountMoveReplan: { status: 'waiting', eligibilityKey: validation.eligibilityKey } } : {}),
    }) } });
    return result(resolution, resolution === 'ready' ? 'Runtime and quota confirmed; normal delivery guards still apply.' : 'Replan from the observed runtime.');
  });
}
