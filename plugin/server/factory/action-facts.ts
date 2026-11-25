// @ts-nocheck
// GENERATED from src/action-facts.mjs by npm run plugin:sync. Do not edit.
// Facts associated with the last context action travel with the action even
// when a later delivery replaces it. Writers pass new facts at the top level
// of the patch; the merge folds them into `action.facts`.
export const ACTION_FACTS = ['cleared', 'actionVerified', 'lastActionFailed', 'refreshed', 'freshHint'];

export function actionFact(entry, key) {
  const facts = entry?.action?.facts;
  return facts && Object.hasOwn(facts, key) ? facts[key] : undefined;
}

export function mergeActionFacts(base, patch) {
  const merged = { ...(base ?? {}), ...(patch ?? {}) };
  const facts = { ...(merged.action?.facts ?? {}), ...(base?.action?.facts ?? {}) };
  for (const key of ACTION_FACTS) {
    if (Object.hasOwn(patch ?? {}, key)) facts[key] = patch[key];
    delete merged[key];
  }
  if (Object.keys(facts).length) merged.action = { ...(merged.action ?? { kind: 'memory', phase: 'done', wakeId: 'context-facts' }), facts };
  return merged;
}
