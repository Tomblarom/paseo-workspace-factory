// Offline benchmark arithmetic. Timestamps and durations are milliseconds,
// tokens are nonnegative safe integers, and tariff components are USD per 1M tokens.

export const REFERENCE_TARIFFS = Object.freeze({
  codex: Object.freeze({ U: 2, R: 0.10, O: 10 }),
  claude: Object.freeze({ U: 3, R: 0.30, W5: 3.75, W60: 6, O: 15 }),
});

const USAGE_KEYS = {
  I: ["input", "inputTokens", "input_tokens"],
  R: ["cacheRead", "cache_read", "cacheReadInputTokens", "cache_read_input_tokens",
    "cachedInputTokens", "cached_input_tokens"],
  W: ["cacheWrite", "cache_write", "cacheCreationInputTokens", "cache_creation_input_tokens"],
  O: ["output", "outputTokens", "output_tokens"],
  W5: ["ephemeral_5m_input_tokens", "ephemeral5mInputTokens", "W5"],
  W60: ["ephemeral_1h_input_tokens", "ephemeral1hInputTokens", "W60"],
};
const BUCKETS = ["U", "R", "W5", "W60", "O"];
const USAGE_FIELDS = [...BUCKETS, "W"];
const PROVIDERS = new Set(["codex", "openai", "claude"]);

const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const nonnegative = (value) => Number.isFinite(value) && value >= 0 ? value : null;

function tokenAt(source, keys) {
  for (const key of keys) {
    const count = tokenCount(source?.[key]);
    if (count !== null) return count;
  }
  return null;
}

function writeBuckets(W5, W60, W) {
  if (W5 !== null && W60 !== null) {
    const sum = tokenCount(W5 + W60);
    if (sum === null || (W !== null && sum !== W)) return null;
    return { W5, W60, W: sum };
  }
  if (W !== null) {
    if ((W5 ?? 0) + (W60 ?? 0) > W) return null;
    if (W5 !== null) W60 = W - W5;
    else if (W60 !== null) W5 = W - W60;
    else if (W === 0) W5 = W60 = 0;
  }
  return { W5, W60, W };
}

/**
 * Normalize a raw provider usage payload. Codex/OpenAI input is inclusive.
 * Set separatelyBilledWrites for a verified inclusive API tariff that also
 * bills cache writes separately. Claude input is already exclusive.
 */
export function normalizeProviderUsage(provider, usage, { separatelyBilledWrites = false } = {}) {
  provider = typeof provider === "string" ? provider.toLowerCase() : null;
  const I = tokenAt(usage, USAGE_KEYS.I);
  const R = tokenAt(usage, USAGE_KEYS.R);
  const O = tokenAt(usage, USAGE_KEYS.O);
  const creation = usage?.cache_creation ?? usage?.cacheCreation;
  const writes = provider === "claude" || separatelyBilledWrites
    ? writeBuckets(tokenAt(creation, USAGE_KEYS.W5), tokenAt(creation, USAGE_KEYS.W60),
      tokenAt(usage, USAGE_KEYS.W))
    : { W5: 0, W60: 0, W: 0 }; // Structural zeros for inclusive, single-rate fills.
  const inclusive = provider === "openai" || provider === "codex";
  const W = writes?.W ?? null;
  const invalid = !PROVIDERS.has(provider) || writes === null
    || (inclusive && I !== null && (
      (R !== null && R > I) || (W !== null && W > I - (R ?? 0))
    ));
  const U = invalid ? null : provider === "claude" ? I
    : I !== null && R !== null && W !== null ? I - R - W : null;
  return {
    U, R, W5: writes?.W5 ?? null, W60: writes?.W60 ?? null, O, W,
    writeTtlUnknown: W !== null && writes.W5 === null && writes.W60 === null,
    invalid,
  };
}

// Keep decimal tariff products and sums exact until conversion to the public
// USD number. This also avoids dependence on the order of request rows.
const ZERO = { units: 0n, exponent: 0 };

function addDecimal(a, b) {
  if (a.units === 0n) return b;
  if (b.units === 0n) return a;
  const exponent = Math.min(a.exponent, b.exponent);
  return {
    units: a.units * 10n ** BigInt(a.exponent - exponent)
      + b.units * 10n ** BigInt(b.exponent - exponent),
    exponent,
  };
}

function tokenPrice(count, rate) {
  const [coefficient, exponent = "0"] = rate.toString().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  return {
    units: BigInt(whole + fraction) * BigInt(count),
    exponent: Number(exponent) - fraction.length - 6,
  };
}

function decimalUsd(decimal) {
  const usd = Number(`${decimal.units}e${decimal.exponent}`);
  return Number.isFinite(usd) ? usd : null;
}

function pricedRequest(usage, tariff) {
  if (!usage || usage.invalid || !tariff) return null;
  const writes = writeBuckets(tokenCount(usage.W5), tokenCount(usage.W60), tokenCount(usage.W));
  if (!writes) return null;

  let base = ZERO;
  for (const bucket of ["U", "R", "O"]) {
    const count = tokenCount(usage[bucket]);
    const rate = nonnegative(tariff[bucket]);
    if (count === null || rate === null) return null;
    base = addDecimal(base, tokenPrice(count, rate));
  }
  if (tariff.W != null) {
    const rate = nonnegative(tariff.W);
    if (rate === null || writes.W === null || tariff.W5 != null || tariff.W60 != null) return null;
    const cost = addDecimal(base, tokenPrice(writes.W, rate));
    return { min: cost, max: cost, exact: true };
  }
  // Omitting all write rates declares that the tariff has no separate writes.
  if (tariff.W5 == null && tariff.W60 == null) {
    if (writes.W !== 0) return null;
    return { min: base, max: base, exact: true };
  }
  const rate5 = nonnegative(tariff.W5);
  const rate60 = nonnegative(tariff.W60);
  if (rate5 === null || rate60 === null || writes.W === null) return null;
  if (writes.W5 === null && writes.W60 === null) {
    return {
      min: addDecimal(base, tokenPrice(writes.W, Math.min(rate5, rate60))),
      max: addDecimal(base, tokenPrice(writes.W, Math.max(rate5, rate60))),
      exact: false,
    };
  }
  const cost = addDecimal(addDecimal(base, tokenPrice(writes.W5, rate5)), tokenPrice(writes.W60, rate60));
  return { min: cost, max: cost, exact: true };
}

function costResult(priced, reconciled = true) {
  const minUsd = priced ? decimalUsd(priced.min) : null;
  const maxUsd = priced ? decimalUsd(priced.max) : null;
  const complete = Boolean(reconciled && priced?.exact && minUsd !== null && maxUsd !== null);
  return { complete, costUsd: complete ? minUsd : null, minUsd, maxUsd };
}

/** Price normalized usage with TTL-specific W5/W60 rates or a flat W rate. */
export function computeRequestCost(usage, tariff) {
  return costResult(pricedRequest(usage, tariff));
}

const ALIAS_FIELDS = ["runId", "packageId", "attemptId", "agentAlias", "sessionAlias", "accountAlias",
  "deliveryId", "parentDeliveryId", "receiptId", "providerTurnId", "providerRequestId"];
const NUMBER_FIELDS = ["briefChars", "enqueuedAt", "startedAt", "endedAt",
  "preTurnContextTokens", "previousRequestEndedAt"];
const ENUM_FIELDS = {
  provider: PROVIDERS,
  kind: new Set(["request", "delivery", "turn", "summary"]),
  route: new Set(["normal", "wake", "handoff", "resume", "fresh", "cleanup"]),
  trigger: new Set(["task", "task-release", "continuation", "worker-wake", "manual", "switch",
    "wake", "handoff", "resume", "fresh", "cleanup", "rewind", "clear", "compact", "brief",
    "previous-agent-notice", "abort", "limit"]),
  outcome: new Set(["completed", "success", "failed", "error", "aborted", "cancelled", "canceled",
    "interrupted", "rate-limited", "timeout", "accepted", "rejected"]),
};
const alias = (value) => typeof value === "string" && value.length <= 128
  && /^[a-zA-Z0-9]/.test(value) && !/[^a-zA-Z0-9_.:-]/.test(value);

function projectLedgerEvent(source) {
  const event = {};
  for (const field of ALIAS_FIELDS) if (alias(source[field])) event[field] = source[field];
  for (const field of NUMBER_FIELDS) {
    const value = tokenCount(source[field]);
    if (value !== null) event[field] = value;
  }
  for (const [field, allowed] of Object.entries(ENUM_FIELDS)) {
    if (allowed.has(source[field])) event[field] = source[field];
  }
  if (typeof source.ambiguous === "boolean") event.ambiguous = source.ambiguous;
  if (source.usage && typeof source.usage === "object") {
    event.usage = {};
    for (const field of USAGE_FIELDS) event.usage[field] = tokenCount(source.usage[field]);
    event.usage.writeTtlUnknown = source.usage.writeTtlUnknown === true;
    event.usage.invalid = source.usage.invalid === true;
  }
  if (source.counterDelta && typeof source.counterDelta === "object") {
    const { epoch, start, end, verified } = source.counterDelta;
    event.counterDelta = { start: tokenCount(start), end: tokenCount(end), verified: verified === true };
    if (alias(epoch)) event.counterDelta.epoch = epoch;
  }
  return event;
}

/**
 * Project numeric fields, registered enums and benchmark-local aliases only.
 * Supply aliases for every ID, including receipts and provider IDs, before
 * collecting events. The same alias must be used for repeated observations.
 */
export function exportAllowlistedLedger(events) {
  return events.map(projectLedgerEvent);
}

/** Opt in explicitly. Returns an in-memory snapshot without changing its inputs. */
export function appendLedgerEvent(ledger, event, { enabled = false } = {}) {
  return enabled === true ? [...ledger, projectLedgerEvent(event)] : ledger;
}

const keyFor = (...parts) => JSON.stringify(parts);

function counterScope(event) {
  const { counterDelta: delta, runId, provider, accountAlias, sessionAlias } = event;
  if (!delta?.verified || !delta.epoch || delta.start === null || delta.end === null
    || delta.start >= delta.end || !runId || !provider || !accountAlias || !sessionAlias) return null;
  return keyFor("counter", runId, provider, accountAlias, sessionAlias, delta.epoch);
}

function ledgerKeys(event) {
  const { kind = "request", provider, accountAlias, providerRequestId, runId, sessionAlias,
    deliveryId, receiptId, providerTurnId } = event;
  const keys = [];
  if (kind === "request") {
    if (provider && accountAlias && providerRequestId) {
      keys.push(keyFor(kind, provider, accountAlias, providerRequestId));
    }
    const scope = counterScope(event);
    if (scope) keys.push(keyFor(scope, event.counterDelta.start, event.counterDelta.end));
  } else if (kind === "delivery" && runId) {
    if (deliveryId) keys.push(keyFor(kind, runId, "delivery", deliveryId));
    if (receiptId) keys.push(keyFor(kind, runId, "receipt", receiptId));
  } else if (kind === "turn" && runId && sessionAlias) {
    if (providerTurnId) keys.push(keyFor(kind, runId, sessionAlias, "turn", providerTurnId));
    if (receiptId) keys.push(keyFor(kind, runId, sessionAlias, "receipt", receiptId));
  }
  return keys;
}

function mergeLedgerGroup(rows) {
  const event = { ...rows[0], kind: rows[0].kind ?? "request" };
  const conflictingAttribution = new Set();
  let usage = event.usage ? { ...event.usage } : null;
  let ambiguous = event.ambiguous === true;
  for (const row of rows.slice(1)) {
    ambiguous ||= row.ambiguous === true;
    for (const [field, value] of Object.entries(row)) {
      if (field === "usage" || field === "ambiguous") continue;
      if (event[field] === undefined) event[field] = value;
      else if (field === "counterDelta") {
        if (!event.counterDelta.verified) event.counterDelta = value;
        else if (value.verified && keyFor(value.epoch, value.start, value.end)
          !== keyFor(event.counterDelta.epoch, event.counterDelta.start, event.counterDelta.end)) ambiguous = true;
      } else if (event[field] !== value) {
        ambiguous = true;
        if (field === "runId" || field === "packageId") conflictingAttribution.add(field);
      }
    }
    if (!row.usage) continue;
    if (!usage) usage = { ...row.usage };
    usage.invalid ||= row.usage.invalid;
    for (const field of USAGE_FIELDS) {
      if (usage[field] === null) usage[field] = row.usage[field];
      else if (row.usage[field] !== null && usage[field] !== row.usage[field]) ambiguous = true;
    }
  }
  if (usage) {
    const writes = writeBuckets(usage.W5, usage.W60, usage.W);
    if (writes) Object.assign(usage, writes);
    else usage.invalid = true;
    usage.writeTtlUnknown = Boolean(writes && writes.W !== null && writes.W5 === null && writes.W60 === null);
    event.usage = usage;
  }
  for (const field of conflictingAttribution) delete event[field];
  const open = event.endedAt === undefined || (event.startedAt !== undefined && event.endedAt < event.startedAt);
  event.ambiguous = ambiguous || (event.kind !== "summary" && (open || !ledgerKeys(event).length));
  return event;
}

/**
 * Coalesce observations of the same request or lifecycle record. A verified
 * counter delta names a half-open interval [start, end) in a session epoch.
 * An epoch must change on reset. The collector attests that a delta accounts
 * for one request; an overlapping interval or conflicting observation is
 * unresolved. Use kind "summary" for parent totals that duplicate child usage.
 * Mark uncertified joins and usage snapshots ambiguous at collection time.
 * Reconcile against the original rows, since this view marks pending rows as
 * ambiguous until the corresponding completion arrives.
 */
export function deduplicateLedgerEvents(events) {
  const entries = exportAllowlistedLedger(events).map((event) => ({ event, keys: ledgerKeys(event) }));
  const idsByCounter = new Map();
  for (const { event, keys } of entries) {
    if (event.kind !== undefined && event.kind !== "request") continue;
    if (keys.length !== 2) continue;
    const [id, counter] = keys;
    const previous = idsByCounter.get(counter);
    idsByCounter.set(counter, previous === undefined || previous === id ? id : null);
  }

  const groups = new Set();
  const byKey = new Map();
  for (const { event, keys: observedKeys } of entries) {
    // A counter conflict cannot combine distinct, explicitly identified requests.
    const keys = observedKeys.length === 2 && idsByCounter.get(observedKeys[1]) === null
      ? observedKeys.slice(0, 1) : observedKeys;
    const matches = [...new Set(keys.map((key) => byKey.get(key)).filter(Boolean))];
    const group = matches[0] ?? { rows: [], keys: new Set() };
    groups.add(group);
    group.rows.push(event);
    for (const key of keys) group.keys.add(key);
    for (const match of matches.slice(1)) {
      group.rows.push(...match.rows);
      for (const key of match.keys) group.keys.add(key);
      groups.delete(match);
    }
    for (const key of group.keys) byKey.set(key, group);
  }

  const result = [...groups].map(({ rows }) => mergeLedgerGroup(rows));
  const bySession = new Map();
  for (const event of result) {
    const scope = event.kind === "request" ? counterScope(event) : null;
    if (!scope) continue;
    if (!bySession.has(scope)) bySession.set(scope, []);
    bySession.get(scope).push(event);
  }
  for (const session of bySession.values()) {
    session.sort((a, b) => a.counterDelta.start - b.counterDelta.start);
    let furthest = null;
    for (const event of session) {
      if (furthest && event.counterDelta.start < furthest.counterDelta.end) {
        event.ambiguous = furthest.ambiguous = true;
      }
      if (!furthest || event.counterDelta.end > furthest.counterDelta.end) furthest = event;
    }
  }
  return result;
}

function sumLedgerCost(events, tariff) {
  let min = ZERO;
  let max = ZERO;
  let exact = true;
  let unknownRequests = 0;
  let requestCount = 0;
  let unresolvedEvents = 0;
  for (const event of events) {
    if (event.ambiguous || (event.kind === "request" && !event.packageId)) unresolvedEvents++;
    if (event.kind !== "request") continue;
    requestCount++;
    const priced = pricedRequest(event.usage, typeof tariff === "function" ? tariff(event) : tariff);
    if (!priced) {
      unknownRequests++;
      continue;
    }
    min = addDecimal(min, priced.min);
    max = addDecimal(max, priced.max);
    exact &&= priced.exact;
  }
  const bounds = unknownRequests === 0 && unresolvedEvents === 0 ? { min, max, exact } : null;
  return { ...costResult(bounds), requestCount, unknownRequests, unresolvedEvents };
}

/**
 * Price all attributed requests in an arm, including failures and retries.
 * tariff is a frozen rate card or a resolver of the registered tariff per event.
 * acceptedPackages is an independent harness count; offeredPackages is optional.
 */
export function summarizeArmCost({ events, acceptedPackages, offeredPackages, tariff }) {
  const total = sumLedgerCost(deduplicateLedgerEvents(events), tariff);
  const accepted = tokenCount(acceptedPackages);
  const offered = tokenCount(offeredPackages);
  const hasDenominator = accepted > 0 && (offered === null || accepted <= offered);
  const complete = total.complete && total.requestCount > 0 && hasDenominator;
  return {
    ...total,
    complete,
    acceptedPackages: accepted,
    offeredPackages: offered,
    costPerPackageUsd: complete ? total.costUsd / accepted : null,
    minPerPackageUsd: hasDenominator && total.minUsd !== null ? total.minUsd / accepted : null,
    maxPerPackageUsd: hasDenominator && total.maxUsd !== null ? total.maxUsd / accepted : null,
  };
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * fraction;
  const index = Math.floor(position);
  return sorted[index] + (sorted[Math.ceil(position)] - sorted[index]) * (position - index);
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Compare an array of { baseline, factory } arm summaries. Bootstrap the
 * median percentage reduction by sampling whole pairs with replacement.
 */
export function comparePairedArms(pairs, { seed = 0, resamples = 10_000 } = {}) {
  if (!Number.isSafeInteger(resamples) || resamples < 1) throw new RangeError("Expected positive resamples");
  const pairReductionsPct = pairs.map(({ baseline, factory }) => {
    if (!baseline?.complete || !factory?.complete) return null;
    const base = nonnegative(baseline.costPerPackageUsd);
    const cost = nonnegative(factory.costPerPackageUsd);
    if (base === null || base === 0 || cost === null) return null;
    const reduction = 100 * (1 - cost / base);
    return Number.isFinite(reduction) ? reduction : null;
  });
  const complete = pairs.length > 0 && pairReductionsPct.every((value) => value !== null);
  if (!complete) {
    return { complete, pairReductionsPct, medianReductionPct: null, iqr: null, ci95: null, claimEligible: false };
  }

  const random = mulberry32(seed);
  const sorted = pairReductionsPct.slice().sort((a, b) => a - b);
  const medians = [];
  for (let i = 0; i < resamples; i++) {
    const sample = sorted.map(() => sorted[Math.floor(random() * sorted.length)]);
    medians.push(quantile(sample.sort((a, b) => a - b), 0.5));
  }
  medians.sort((a, b) => a - b);
  const medianReductionPct = quantile(sorted, 0.5);
  const ci95 = [quantile(medians, 0.025), quantile(medians, 0.975)];
  return {
    complete,
    pairReductionsPct,
    medianReductionPct,
    iqr: [quantile(sorted, 0.25), quantile(sorted, 0.75)],
    ci95,
    claimEligible: pairs.length >= 10 && medianReductionPct > 0 && ci95[0] > 0
      && pairs.every(({ baseline, factory }) => baseline.offeredPackages === factory.offeredPackages
        && [baseline, factory].every(({ acceptedPackages, offeredPackages }) =>
          offeredPackages > 0 && acceptedPackages === offeredPackages)),
  };
}

function inputTokens(usage) {
  if (!usage || usage.invalid) return null;
  const writes = writeBuckets(tokenCount(usage.W5), tokenCount(usage.W60), tokenCount(usage.W));
  const buckets = [tokenCount(usage.U), tokenCount(usage.R), writes?.W ?? null];
  if (buckets.includes(null)) return null;
  return tokenCount(buckets[0] + buckets[1] + buckets[2]);
}

function idleAge(turn) {
  const age = tokenCount(turn.idleAgeMs);
  if (age !== null) return age;
  const started = tokenCount(turn.startedAt);
  const previous = tokenCount(turn.previousRequestEndedAt);
  return started === null || previous === null ? null : tokenCount(started - previous);
}

const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;

function hitSummary(turns, hits, input, reads) {
  const sorted = hits.slice().sort((a, b) => a - b);
  return {
    turns, observed: hits.length, unknown: turns - hits.length,
    hitRatio: ratio(reads, input),
    medianHitRatio: quantile(sorted, 0.5),
    range: sorted.length ? [sorted[0], sorted.at(-1)] : null,
  };
}

/**
 * Measure continuing work turns. Mark maintenanceOnly and fresh explicitly
 * when collecting turns; route "fresh" also identifies a fresh turn. gapMs
 * may label the scheduled gap, otherwise the observed idle age is used.
 */
export function computeColdTurnRate(turns, { retentionMs, contextFloor = 100_000 } = {}) {
  retentionMs = nonnegative(retentionMs);
  contextFloor = tokenCount(contextFloor);
  let workTurns = 0;
  let freshTurns = 0;
  let maintenanceOnlyTurns = 0;
  let coldTurns = 0;
  let warmTurns = 0;
  let unknownTurns = 0;
  let idleExpiredTurns = 0;
  let oversizedTurns = 0;
  let overlapTurns = 0;
  let idleUnknownTurns = 0;
  let contextUnknownTurns = 0;
  let allInput = 0;
  let allReads = 0;
  const allHits = [];
  const groups = new Map();

  for (const turn of turns) {
    if (turn.maintenanceOnly === true) {
      maintenanceOnlyTurns++;
      continue;
    }
    workTurns++;
    const idleAgeMs = idleAge(turn);
    const gapMs = tokenCount(turn.gapMs) ?? idleAgeMs;
    const route = ENUM_FIELDS.route.has(turn.route) ? turn.route : null;
    const key = keyFor(gapMs, route);
    if (!groups.has(key)) groups.set(key, { gapMs, route, turns: 0, hits: [], input: 0, reads: 0 });
    const group = groups.get(key);
    group.turns++;
    const input = inputTokens(turn.firstRequestUsage);
    if (input > 0) {
      const reads = turn.firstRequestUsage.R;
      const hit = reads / input;
      group.input += input;
      group.reads += reads;
      group.hits.push(hit);
      allInput += input;
      allReads += reads;
      allHits.push(hit);
    }
    if (turn.fresh === true || route === "fresh") {
      freshTurns++;
      continue;
    }
    const context = tokenCount(turn.preTurnContextTokens);
    const expired = idleAgeMs === null || retentionMs === null ? null : idleAgeMs > retentionMs;
    const oversized = context === null || contextFloor === null ? null : context >= contextFloor;
    if (expired) idleExpiredTurns++;
    if (oversized) oversizedTurns++;
    if (expired && oversized) overlapTurns++;
    if (expired === null) idleUnknownTurns++;
    if (oversized === null) contextUnknownTurns++;
    if (expired || oversized) coldTurns++;
    else if (expired === false && oversized === false) warmTurns++;
    else unknownTurns++;
  }

  const classifiableTurns = coldTurns + warmTurns;
  return {
    workTurns, continuingTurns: workTurns - freshTurns, classifiableTurns, freshTurns, maintenanceOnlyTurns,
    coldTurns, warmTurns, unknownTurns, idleExpiredTurns, oversizedTurns, overlapTurns,
    idleUnknownTurns, contextUnknownTurns,
    coldTurnRate: ratio(coldTurns, classifiableTurns),
    freshTurnShare: ratio(freshTurns, workTurns),
    observedFirstRequestHits: hitSummary(workTurns, allHits, allInput, allReads),
    hitRatiosByGapAndRoute: [...groups.values()].map(({ gapMs, route, turns, hits, input, reads }) => ({
      gapMs, route, ...hitSummary(turns, hits, input, reads),
    })),
  };
}

const QUOTA_LOOKBACK_MS = 2 * 60_000;
const windowKey = ({ provider, accountAlias, windowType, resetAt }) =>
  keyFor(provider, accountAlias, windowType, resetAt);

function weightedUnused(windows) {
  const first = windows[0];
  if (!first?.capacityUnit || !first.windowType || windows.some((window) => !window.known || !window.capacity
    || window.capacityUnit !== first.capacityUnit || window.windowType !== first.windowType)) return null;
  const maxCapacity = windows.reduce((max, window) => Math.max(max, window.capacity), 0);
  // Binary scaling avoids overflow without introducing an extra rounding step.
  const scale = 2 ** Math.min(1023, Math.floor(Math.log2(maxCapacity)));
  let capacity = 0;
  let unused = 0;
  for (const window of windows) {
    const weight = window.capacity / scale;
    capacity += weight;
    unused += weight * window.unusedPct;
  }
  return unused / capacity;
}

/**
 * windows lists the expected { provider, accountAlias, windowType, resetAt }
 * resets. observations have those same keys plus provider observedAt and
 * usedPct. Capacity weighting requires capacity and a common capacityUnit.
 */
export function computeUnusedQuotaAtReset(windows, observations) {
  const latest = new Map();
  for (const observation of observations) {
    const { observedAt, resetAt } = observation;
    if (tokenCount(observedAt) === null || tokenCount(resetAt) === null
      || observedAt >= resetAt || observedAt < resetAt - QUOTA_LOOKBACK_MS) continue;
    const key = windowKey(observation);
    const previous = latest.get(key);
    const usedPct = nonnegative(observation.usedPct);
    const current = { observedAt, usedPct: usedPct !== null && usedPct <= 100 ? usedPct : null };
    if (!previous || observedAt > previous.observedAt) latest.set(key, current);
    else if (observedAt === previous.observedAt && current.usedPct !== previous.usedPct) previous.usedPct = null;
  }

  const byGroup = new Map();
  const resets = [...new Map(windows.map((window) => [windowKey(window), window])).values()].map((window) => {
    const { provider, accountAlias, windowType, resetAt } = window;
    const observation = provider && accountAlias && windowType ? latest.get(windowKey(window)) : null;
    const known = observation?.usedPct != null;
    const row = {
      provider, accountAlias, windowType, resetAt, known,
      observedAt: observation?.observedAt ?? null,
      unusedPct: known ? 100 - observation.usedPct : null,
      capacity: nonnegative(window.capacity),
      capacityUnit: typeof window.capacityUnit === "string" ? window.capacityUnit : null,
    };
    const group = keyFor(provider, windowType);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(row);
    return row;
  });

  const groups = [...byGroup.values()].map((group) => {
    const { provider, windowType } = group[0];
    const unused = group.filter((window) => window.known).map((window) => window.unusedPct).sort((a, b) => a - b);
    return {
      provider, windowType,
      known: unused.length, unknown: group.length - unused.length,
      coverage: unused.length / group.length,
      medianUnusedPct: quantile(unused, 0.5),
      rangeUnusedPct: unused.length ? [unused[0], unused.at(-1)] : null,
      weightedUnusedPct: weightedUnused(group),
    };
  });
  const known = resets.filter((window) => window.known).length;
  return {
    windows: resets, groups, known, unknown: resets.length - known, coverage: ratio(known, resets.length),
    weightedUnusedPct: weightedUnused(resets),
  };
}

/**
 * Measure one package from failedAt through its first verified milestone or
 * capAt. Supply milestones as { packageId, at, verified } and continuation
 * turns as { packageId, startedAt }. Supply runId when inputs span runs.
 */
export function computeRecoveryCost({
  packageId, runId, failedAt, capAt, milestones = [], continuationTurns = [], events, tariff,
}) {
  if (!alias(packageId) || tokenCount(failedAt) === null || tokenCount(capAt) === null || capAt < failedAt) {
    throw new RangeError("Expected a package and ordered recovery timestamps");
  }
  const samePackage = (record) => record.packageId === packageId && (runId === undefined || record.runId === runId);
  const firstTime = (rows, getTime, end) => {
    let first = null;
    for (const row of rows) {
      const time = tokenCount(getTime(row));
      if (samePackage(row) && time !== null && time >= failedAt && time <= end && (first === null || time < first)) {
        first = time;
      }
    }
    return first;
  };
  const milestoneAt = firstTime(milestones, (row) => row.verified === true ? row.at : null, capAt);
  const endedAt = milestoneAt ?? capAt;
  const continuationAt = firstTime(continuationTurns, (row) => row.startedAt, endedAt);
  const relevant = [];
  for (const event of deduplicateLedgerEvents(events)) {
    // Unattributed rows in the run could belong to this package.
    if (runId !== undefined && event.runId !== undefined && event.runId !== runId) continue;
    if (event.packageId !== undefined && event.packageId !== packageId) continue;
    const start = event.kind === "request" ? event.startedAt : event.startedAt ?? event.enqueuedAt;
    const end = event.endedAt;
    if ((start ?? event.enqueuedAt) > endedAt || end < failedAt) continue;
    if (start !== undefined && start < failedAt && end > endedAt) continue;
    const uncertainTiming = event.kind === "request" && event.startedAt === undefined && end > endedAt;
    const uncertainRun = runId !== undefined && event.runId === undefined && event.kind !== "summary";
    relevant.push(uncertainTiming || uncertainRun ? { ...event, ambiguous: true } : event);
  }

  const total = sumLedgerCost(relevant, tariff);
  let tokens = 0;
  let interruptedRequests = 0;
  for (const event of relevant) {
    if (event.kind !== "request") continue;
    if (event.startedAt < failedAt && event.endedAt >= failedAt && event.endedAt <= endedAt) interruptedRequests++;
    const input = inputTokens(event.usage);
    const output = tokenCount(event.usage?.O);
    tokens = tokens === null || input === null || output === null ? null : tokenCount(tokens + input + output);
  }
  return {
    ...total,
    recovered: milestoneAt !== null, milestoneAt, endedAt, continuationAt,
    elapsedMinutes: (endedAt - failedAt) / 60_000,
    continuationMinutes: continuationAt === null ? null : (continuationAt - failedAt) / 60_000,
    totalTokens: total.unresolvedEvents === 0 ? tokens : null,
    interruptedRequests,
  };
}
