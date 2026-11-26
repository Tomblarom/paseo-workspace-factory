// P1 decision only: callers supply eligibility and observations from the same
// scope/account/settings snapshot. Effects keep their existing execution guards.
// Quota percentages are admission evidence, never a cross-provider cost score.
export const ROUTING_STRATEGIES = ['efficiency', 'balanced', 'preference'];
const KINDS = new Set(['continue', 'move', 'handover', 'renewal', 'create']);
const ORDER = {
  efficiency: ['uncachedInputTokens', 'preparationTurns', 'latencyMs', 'preferenceRank'],
  balanced: ['preparationTurns', 'preferenceRank', 'uncachedInputTokens', 'latencyMs'],
  preference: ['preferenceRank', 'uncachedInputTokens', 'preparationTurns', 'latencyMs'],
};

function observedNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Explicit intent constrains selection and is checked again before effects. */
export function routeMatchesIntent(candidate, intent = { mode: 'automatic' }) {
  return intent.mode !== 'explicit' ||
    ((!intent.agentId || candidate.agentId === intent.agentId) &&
     (!intent.provider || candidate.provider === intent.provider) &&
     (!intent.model || candidate.model === intent.model));
}

/**
 * Compare admitted alternatives for due work. `eligible: true` means the
 * caller checked role, privacy, task capability, permission, account quota
 * and native support. Unknown eligibility never grants permission.
 *
 * evidence: { uncachedInputTokens, preparationTurns, latencyMs, preferenceRank }
 * contains observations or explicit estimates, not quota-derived numbers.
 * `uncachedInputTokens` includes brief/reread input; a move cannot infer a
 * cache hit from preserved conversation identity. Leave it null when unknown.
 * confidence: 'observed' | 'estimated' | 'unknown' describes that evidence.
 *
 * Lexicographic priorities avoid unmeasured cost weights. Unknown values sort
 * after known values, never as zero. Stable input order breaks exact ties,
 * so there is no built-in preference for an account move or any other kind.
 * The returned observation is a binding for an executor's recheck, not a lease.
 */
export function planRoutes({ due = false, strategy = 'efficiency', candidates = [], observation = null, intent = { mode: 'automatic' } } = {}) {
  if (!ROUTING_STRATEGIES.includes(strategy)) throw new Error(`Unknown routing strategy: ${strategy}`);
  if (!['automatic', 'explicit'].includes(intent?.mode)) throw new Error('Unknown routing intent');
  if (intent.mode === 'explicit' && !intent.agentId && !(intent.provider && intent.model)) {
    throw new Error('Explicit routing needs a target steer or provider/model');
  }
  const ids = new Set();
  const alternatives = candidates.map((candidate, index) => {
    if (!candidate?.id || ids.has(candidate.id)) throw new Error('Route candidates need unique ids');
    ids.add(candidate.id);
    if (!KINDS.has(candidate.kind)) throw new Error(`Unknown route kind: ${candidate.kind}`);
    const evidence = Object.fromEntries(ORDER.efficiency.map((key) => [key, observedNumber(candidate.evidence?.[key])]));
    const requested = routeMatchesIntent(candidate, intent);
    const eligible = candidate.eligible === true && requested;
    return {
      ...candidate, eligible, evidence, requested,
      confidence: ['observed', 'estimated'].includes(candidate.confidence) ? candidate.confidence : 'unknown',
      reason: !requested ? 'outside explicit user selection' :
        eligible ? candidate.reason ?? 'eligible' : candidate.reason ?? 'eligibility not established',
      index,
    };
  });
  const order = ORDER[strategy];
  const ranked = alternatives.filter((candidate) => candidate.eligible).sort((a, b) => {
    for (const key of order) {
      const av = a.evidence[key] ?? Infinity;
      const bv = b.evidence[key] ?? Infinity;
      if (av !== bv) return av < bv ? -1 : 1;
    }
    return a.index - b.index;
  });
  const clean = ({ index, ...candidate }) => candidate;
  const selected = due && ranked.length ? clean(ranked[0]) : null;
  const runnerUp = ranked[1];
  const deciding = selected && runnerUp ? order.find((key) => selected.evidence[key] !== runnerUp.evidence[key]) : null;
  return {
    strategy, intent, observation, selected,
    reason: !due ? 'no due work' : !selected ? intent.mode === 'explicit' ? 'requested route unavailable' : 'no eligible route' :
      deciding ? `selected by ${deciding}` : ranked.length > 1 ? 'equal evidence; retained candidate order' : 'only eligible route',
    ranked: ranked.map(clean),
    excluded: alternatives.filter((candidate) => !candidate.eligible).map(clean),
    alternatives: alternatives.filter((candidate) => !candidate.requested && candidates[candidate.index].eligible === true).map(clean),
  };
}
