// Facts associated with the last context action travel with the action even
// when a later delivery replaces it. Writers pass new facts at the top level
// of the patch; the merge folds them into `action.facts`.
import { isDeepStrictEqual } from 'node:util';
export const ACTION_FACTS = ['cleared', 'actionVerified', 'lastActionFailed', 'refreshed', 'freshHint'];

export function actionFact(entry, key) {
  const facts = entry?.action?.facts;
  return facts && Object.hasOwn(facts, key) ? facts[key] : undefined;
}

export function mergeActionFacts(base, patch) {
  const move = base?.action?.accountMove;
  if (move && move.phase !== 'settled' && Object.hasOwn(patch ?? {}, 'action')) {
    const next = patch.action;
    if (next?.wakeId !== base.action.wakeId || next?.accountMove?.attemptedAt !== move.attemptedAt ||
        next.accountMove.accountId !== move.accountId || next.accountMove.fromAccountId !== move.fromAccountId) {
      throw new Error('Account move needs reconciliation before replacing its delivery action');
    }
  }
  if (move?.phase === 'settled' && patch?.action?.wakeId === base.action.wakeId &&
      !isDeepStrictEqual(patch.action.accountMove, move)) {
    throw new Error('A settled account move receipt cannot change within its delivery action');
  }
  const merged = { ...(base ?? {}), ...(patch ?? {}) };
  const facts = { ...(merged.action?.facts ?? {}), ...(base?.action?.facts ?? {}) };
  for (const key of ACTION_FACTS) {
    if (Object.hasOwn(patch ?? {}, key)) facts[key] = patch[key];
    delete merged[key];
  }
  if (Object.keys(facts).length) merged.action = { ...(merged.action ?? { kind: 'memory', phase: 'done', wakeId: 'context-facts' }), facts };
  return merged;
}
