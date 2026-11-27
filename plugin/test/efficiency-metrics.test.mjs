import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REFERENCE_TARIFFS,
  appendLedgerEvent,
  comparePairedArms,
  computeColdTurnRate,
  computeRecoveryCost,
  computeRequestCost,
  computeUnusedQuotaAtReset,
  deduplicateLedgerEvents,
  exportAllowlistedLedger,
  normalizeProviderUsage,
  summarizeArmCost,
} from "../server/core/efficiency-metrics.mjs";

const codex = (input = 100, cacheRead = 40, output = 8) =>
  normalizeProviderUsage("codex", { input, cacheRead, output });
const claude = (usage) => normalizeProviderUsage("claude", usage);

const request = (providerRequestId, fields = {}) => ({
  runId: "run-1", packageId: "A", attemptId: "attempt-1", agentAlias: "agent-1",
  sessionAlias: "session-1", accountAlias: "account-1", provider: "codex",
  providerRequestId, startedAt: 0, endedAt: 10, usage: codex(),
  ...fields,
});
const delta = (start, end, epoch = "epoch-1") => ({ start, end, epoch, verified: true });
const codexTariff = REFERENCE_TARIFFS.codex;
const claudeTariff = REFERENCE_TARIFFS.claude;

test("normalizes inclusive input and SDK aliases without charging writes or reasoning twice", () => {
  const expected = { U: 60, R: 40, W5: 0, W60: 0, O: 8, W: 0, writeTtlUnknown: false, invalid: false };
  assert.deepEqual(codex(), expected);
  assert.deepEqual(normalizeProviderUsage("openai", {
    inputTokens: 100, cachedInputTokens: 40, outputTokens: 8, reasoningOutputTokens: 5,
  }), expected);
  assert.deepEqual(normalizeProviderUsage("CODEX", {
    input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 8, cacheWrite: 20,
  }), expected);
  for (const key of ["cache_read", "cacheReadInputTokens", "cached_input_tokens"]) {
    assert.deepEqual(normalizeProviderUsage("codex", { input: 100, [key]: 40, output: 8 }), expected);
  }
});

test("keeps explicit zero, missing, and invalid token observations distinct", () => {
  assert.deepEqual(codex(0, 0, 0), {
    U: 0, R: 0, W5: 0, W60: 0, O: 0, W: 0, writeTtlUnknown: false, invalid: false,
  });
  for (const value of [undefined, null, "", false, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const normalized = normalizeProviderUsage("codex", { input: 100, cachedInputTokens: value, output: value });
    assert.equal(normalized.U, null);
    assert.equal(normalized.R, null);
    assert.equal(normalized.O, null);
  }
  const impossible = codex(30, 40, 0);
  assert.equal(impossible.U, null);
  assert.equal(impossible.invalid, true);
  assert.equal(computeRequestCost(impossible, codexTariff).complete, false);
  assert.equal(normalizeProviderUsage("unsupported", { input: 2, output: 1 }).invalid, true);
});

test("reconciles Claude exclusive input, verified TTL buckets, and cache write totals", () => {
  const expected = { U: 7, R: 17, W5: 9, W60: 4, O: 2, W: 13, writeTtlUnknown: false, invalid: false };
  const cacheCreation = { ephemeral_5m_input_tokens: 9, ephemeral_1h_input_tokens: 4 };
  assert.deepEqual(claude({
    input_tokens: 7, cache_read_input_tokens: 17, cache_creation_input_tokens: 13,
    cache_creation: cacheCreation, output_tokens: 2,
  }), expected);
  assert.deepEqual(claude({
    inputTokens: 7, cacheReadInputTokens: 17, cacheCreationInputTokens: 13,
    cacheCreation: { ephemeral1hInputTokens: 4 }, outputTokens: 2,
  }), expected);
  assert.deepEqual(claude({
    input: 7, cacheRead: 17, cache_creation: { W5: 9, W60: 4 }, output: 2,
  }), expected);
  const onlyTotal = claude({ input: 7, cacheRead: 17, cacheWrite: 13, output: 2 });
  assert.deepEqual(onlyTotal, { ...expected, W5: null, W60: null, writeTtlUnknown: true });
  assert.equal(claude({ cache_write: 0 }).W60, 0);
  const missing = claude({ cache_creation: { W5: 0 } });
  assert.equal(missing.W5, 0);
  assert.equal(missing.W60, null);
  assert.equal(missing.W, null);
  assert.equal(missing.writeTtlUnknown, false);
  for (const W of [8, 12, 14]) {
    const invalid = claude({ cacheWrite: W, cache_creation: cacheCreation });
    assert.equal(invalid.invalid, true);
    assert.equal(invalid.W, null);
  }
  assert.equal(claude({ cacheWrite: 3, cache_creation: { W5: 4 } }).invalid, true);
});

test("subtracts a distinct write bucket from inclusive API input when configured", () => {
  const options = { separatelyBilledWrites: true };
  const source = { input: 10, cacheRead: 3, cacheWrite: 2, cache_creation: { W5: 1, W60: 1 }, output: 4 };
  const usage = normalizeProviderUsage("openai", source, options);
  assert.equal(usage.U, 5);
  assert.equal(computeRequestCost(usage, { U: 1, R: 0, W5: 0.5, W60: 1.5, O: 0 }).costUsd, 0.000007);
  assert.equal(normalizeProviderUsage("openai", { ...source, input: 4 }, options).invalid, true);
  assert.equal(normalizeProviderUsage("openai", { input: 10, cacheRead: 3 }, options).U, null);
  const flat = normalizeProviderUsage("openai", { ...source, cache_creation: undefined }, options);
  assert.equal(computeRequestCost(flat, { U: 1, R: 0, W: 1, O: 0 }).costUsd, 0.000007);
});

test("prices reference and custom requests using exact decimal arithmetic", () => {
  assert.deepEqual(REFERENCE_TARIFFS, { codex: { U: 2, R: 0.1, O: 10 },
    claude: { U: 3, R: 0.3, W5: 3.75, W60: 6, O: 15 } });
  assert.deepEqual(computeRequestCost(codex(), codexTariff), {
    complete: true, costUsd: 0.000204, minUsd: 0.000204, maxUsd: 0.000204,
  });
  assert.equal(computeRequestCost(claude({
    input: 100_000, cacheRead: 200_000, cache_creation: { W5: 300_000, W60: 400_000 },
    output: 500_000,
  }), claudeTariff).costUsd, 11.385);
  assert.equal(computeRequestCost(codex(3, 3, 0), codexTariff).costUsd, 0.0000003);
  assert.equal(computeRequestCost(codex(4, 0, 0), { U: 2.5e-12, R: 0, O: 0 }).costUsd, 1e-17);
  assert.equal(computeRequestCost(codex(0, 0, 0), codexTariff).costUsd, 0);
  for (const usage of [null, claude({ input: 1, cacheRead: 1, output: 1 }), codex(10, 0, null)]) {
    assert.deepEqual(computeRequestCost(usage, claudeTariff), {
      complete: false, costUsd: null, minUsd: null, maxUsd: null,
    });
  }
  assert.equal(computeRequestCost(codex(), { U: 2, R: -1, O: 10 }).complete, false);
});

test("publishes Claude write bounds at request and arm level without a point estimate", () => {
  const usage = claude({ input: 100_000, cacheRead: 100_000, cacheWrite: 100_000, output: 10_000 });
  assert.deepEqual(computeRequestCost(usage, claudeTariff), {
    complete: false, costUsd: null, minUsd: 0.855, maxUsd: 1.08,
  });
  assert.deepEqual(computeRequestCost(usage, { U: 0, R: 0, W5: 6, W60: 2, O: 0 }), {
    complete: false, costUsd: null, minUsd: 0.2, maxUsd: 0.6,
  });
  const events = [
    request("req-1", { provider: "claude", usage }),
    request("req-2", { packageId: "B", usage: codex(100_000, 0, 0) }),
  ];
  const arm = summarizeArmCost({
    events, acceptedPackages: 2, tariff: (event) => REFERENCE_TARIFFS[event.provider],
  });
  assert.equal(arm.complete, false);
  assert.equal(arm.costPerPackageUsd, null);
  assert.equal(arm.minPerPackageUsd, 0.5275);
  assert.equal(arm.maxPerPackageUsd, 0.64);
  assert.equal(arm.unknownRequests, 0);
});

test("arm costs include setup, failed attempts, retries, worker and cleanup charges once", () => {
  const worker = request("worker", { packageId: "B", parentDeliveryId: "parent-1", agentAlias: "agent-2" });
  const events = [
    request("setup", { route: "fresh" }),
    request("fail", { outcome: "failed" }),
    request("retry", { attemptId: "attempt-2" }),
    worker, worker,
    request("parent", { packageId: "B", kind: "summary", usage: codex(100_000, 0, 0) }),
    request("cleanup", { packageId: "B", route: "cleanup" }),
  ];
  const arm = summarizeArmCost({ events, acceptedPackages: 2, offeredPackages: 2, tariff: codexTariff });
  assert.equal(arm.complete, true);
  assert.equal(arm.requestCount, 5);
  assert.equal(arm.costUsd, 0.00102);
  assert.equal(arm.costPerPackageUsd, 0.00051);
  const noAcceptance = summarizeArmCost({ events, acceptedPackages: 0, tariff: codexTariff });
  assert.equal(noAcceptance.complete, false);
  assert.equal(noAcceptance.costUsd, 0.00102);
  assert.equal(noAcceptance.costPerPackageUsd, null);
  assert.equal(noAcceptance.minPerPackageUsd, null);
  assert.equal(summarizeArmCost({ events: [], acceptedPackages: 1, tariff: codexTariff }).complete, false);
});

test("arm point estimates require reconciled timing, attribution, identity, and usage", () => {
  const good = request("good");
  for (const unresolved of [
    request("open", { endedAt: null }),
    request("ambiguous", { ambiguous: true }),
    request("unattributed", { packageId: null }),
    request(null),
    { kind: "turn", runId: "run-1", sessionAlias: "session-1", providerTurnId: "turn-1", startedAt: 11 },
  ]) {
    const arm = summarizeArmCost({ events: [good, unresolved], acceptedPackages: 1, tariff: codexTariff });
    assert.equal(arm.unresolvedEvents, 1);
    assert.equal(arm.complete, false);
    assert.equal(arm.costPerPackageUsd, null);
  }
  const noUsage = summarizeArmCost({
    events: [good, request("missing", { usage: null })], acceptedPackages: 1, tariff: codexTariff,
  });
  assert.equal(noUsage.unknownRequests, 1);
  assert.equal(noUsage.costUsd, null);
});

const arm = (costPerPackageUsd, acceptedPackages = 3) => ({
  complete: true, costPerPackageUsd, acceptedPackages, offeredPackages: 3,
});

test("reports paired reductions, linear quartiles, and a reproducible paired bootstrap", () => {
  const pairs = [
    { baseline: arm(8), factory: arm(6) },
    { baseline: arm(4), factory: arm(4) },
    { baseline: arm(1), factory: arm(0.25) },
    { baseline: arm(10), factory: arm(5) },
  ];
  const result = comparePairedArms(pairs, { seed: 37 });
  assert.deepEqual(result, {
    complete: true, pairReductionsPct: [25, 0, 75, 50], medianReductionPct: 37.5,
    iqr: [18.75, 56.25], ci95: [0, 75], claimEligible: false,
  });
  assert.deepEqual(comparePairedArms(pairs, { seed: 37 }), result);
  assert.notDeepEqual(comparePairedArms(pairs, { seed: 1, resamples: 10 }).ci95,
    comparePairedArms(pairs, { seed: 2, resamples: 10 }).ci95);
  assert.deepEqual(comparePairedArms([{ baseline: arm(2), factory: arm(1) }]).ci95, [50, 50]);
});

test("paired reports hold back incomplete comparisons and qualify only positive fully accepted suites", () => {
  const pair = { baseline: arm(2), factory: arm(1) };
  assert.equal(comparePairedArms(Array(10).fill(pair)).claimEligible, true);
  assert.equal(comparePairedArms([...Array(9).fill(pair), { ...pair, factory: arm(1, 2) }]).claimEligible, false);
  assert.equal(comparePairedArms(Array(10).fill({ baseline: arm(1), factory: arm(2) })).claimEligible, false);
  assert.equal(comparePairedArms([{ baseline: arm(0), factory: arm(0) }]).complete, false);
  assert.equal(comparePairedArms([]).medianReductionPct, null);
  assert.deepEqual(comparePairedArms([pair, { ...pair, factory: { complete: false } }]), {
    complete: false, pairReductionsPct: [50, null], medianReductionPct: null, iqr: null, ci95: null,
    claimEligible: false,
  });
});

test("cold turns use a union with three-valued evidence and continuing work denominator", () => {
  const turns = [
    { startedAt: 1_001, previousRequestEndedAt: 0, preTurnContextTokens: null },
    { preTurnContextTokens: 100_000 },
    { idleAgeMs: 1_010, preTurnContextTokens: 200_000 },
    { startedAt: 1_500, previousRequestEndedAt: 500, preTurnContextTokens: 99_999 },
    { idleAgeMs: 0, preTurnContextTokens: null },
    { startedAt: 1, previousRequestEndedAt: 2, preTurnContextTokens: 0 },
    { route: "fresh", idleAgeMs: 1_501 },
    { fresh: true, route: "normal" },
    { maintenanceOnly: true, route: "cleanup", idleAgeMs: 2_000, preTurnContextTokens: 200_000 },
  ];
  const { observedFirstRequestHits, hitRatiosByGapAndRoute, ...counts } =
    computeColdTurnRate(turns, { retentionMs: 1_000 });
  assert.deepEqual(counts, {
    workTurns: 8, continuingTurns: 6, classifiableTurns: 4, freshTurns: 2, maintenanceOnlyTurns: 1,
    coldTurns: 3, warmTurns: 1, unknownTurns: 2, idleExpiredTurns: 2, oversizedTurns: 2, overlapTurns: 1,
    idleUnknownTurns: 2, contextUnknownTurns: 2, coldTurnRate: 0.75, freshTurnShare: 0.25,
  });
  assert.equal(observedFirstRequestHits.hitRatio, null);
  assert.equal(hitRatiosByGapAndRoute.some((group) => group.route === "cleanup"), false);
  assert.equal(computeColdTurnRate([{ preTurnContextTokens: 20 }], { contextFloor: 20 }).coldTurnRate, 1);
  assert.equal(computeColdTurnRate([], { retentionMs: 1_000 }).coldTurnRate, null);
});

test("first-request hit ratios include total Claude writes and fresh shared-prefix hits", () => {
  const usage = claude({ input: 10, cacheRead: 30, cacheWrite: 10 });
  const { observedFirstRequestHits, hitRatiosByGapAndRoute } = computeColdTurnRate([
    { route: "resume", gapMs: 6_000, idleAgeMs: 6_003, firstRequestUsage: usage },
    { route: "resume", gapMs: 6_000, idleAgeMs: 6_001, firstRequestUsage: codex(150, 0, null) },
    { route: "resume", gapMs: 6_000, firstRequestUsage: claude({ input: 10, cacheRead: 30 }) },
    { route: "fresh", firstRequestUsage: codex(40, 40, null) },
    { route: "normal", idleAgeMs: 1_000, firstRequestUsage: codex(0, 0, 0) },
  ]);
  assert.deepEqual(hitRatiosByGapAndRoute, [
    { gapMs: 6_000, route: "resume", turns: 3, observed: 2, unknown: 1, hitRatio: 0.15,
      medianHitRatio: 0.3, range: [0, 0.6] },
    { gapMs: null, route: "fresh", turns: 1, observed: 1, unknown: 0, hitRatio: 1,
      medianHitRatio: 1, range: [1, 1] },
    { gapMs: 1_000, route: "normal", turns: 1, observed: 0, unknown: 1, hitRatio: null,
      medianHitRatio: null, range: null },
  ]);
  assert.equal(observedFirstRequestHits.hitRatio, 70 / 240);
  assert.equal(observedFirstRequestHits.medianHitRatio, 0.6);
});

const reset = (accountAlias, fields = {}) => ({
  provider: "codex", accountAlias, windowType: "session", resetAt: 500_000, capacity: 100, capacityUnit: "credits",
  ...fields,
});
const observation = (window, observedAt, usedPct) => ({ ...window, observedAt, usedPct });

test("quota uses the latest matching provider sample strictly before reset with coverage", () => {
  const a = reset("account-1");
  const b = reset("account-2");
  const c = reset("account-3");
  const weekly = reset("account-1", { windowType: "weekly" });
  const result = computeUnusedQuotaAtReset([a, b, c, weekly], [
    observation(a, 380_000, 50),
    observation(a, 499_999, 80),
    observation(a, 480_000, 10),
    observation(a, 500_000, 1),
    observation(reset(a.accountAlias, { resetAt: 510_000 }), 499_999, 4),
    observation(reset(a.accountAlias, { provider: "claude" }), 499_999, 3),
    observation(b, 379_999, 45),
    observation(b, null, 0),
    observation(c, 499_000, 100),
    observation(weekly, 380_000, 0),
  ]);
  assert.deepEqual(result.windows.map(({ unusedPct }) => unusedPct), [20, null, 0, 100]);
  assert.equal(result.windows[0].observedAt, 499_999);
  assert.equal(result.windows[1].observedAt, null);
  assert.equal(result.coverage, 0.75);
  assert.deepEqual(result.groups, [
    { provider: "codex", windowType: "session", known: 2, unknown: 1, coverage: 2 / 3,
      medianUnusedPct: 10, rangeUnusedPct: [0, 20], weightedUnusedPct: null },
    { provider: "codex", windowType: "weekly", known: 1, unknown: 0, coverage: 1,
      medianUnusedPct: 100, rangeUnusedPct: [100, 100], weightedUnusedPct: 100 },
  ]);
  assert.equal(result.weightedUnusedPct, null);
});

test("quota capacity weighting requires comparable windows and current, consistent observations", () => {
  const a = reset("account-1");
  const b = reset("account-2", { capacity: 300 });
  const observations = [observation(a, 498_000, 60), observation(b, 499_000, 80)];
  const result = computeUnusedQuotaAtReset([a, b, a], observations);
  assert.equal(result.weightedUnusedPct, 25);
  assert.equal(result.groups[0].weightedUnusedPct, 25);
  assert.equal(result.groups[0].medianUnusedPct, 30);
  assert.equal(computeUnusedQuotaAtReset([a, b].map((window) => ({ ...window, capacity: 1e308 })),
    observations).weightedUnusedPct, 30);
  assert.equal(computeUnusedQuotaAtReset([a, { ...b, capacityUnit: "tokens" }], observations).weightedUnusedPct, null);
  assert.equal(computeUnusedQuotaAtReset([a, { ...b, capacity: 0 }], observations).weightedUnusedPct, null);
  assert.equal(computeUnusedQuotaAtReset([a], [...observations, observation(a, 499_000, 101)]).unknown, 1);
  assert.equal(computeUnusedQuotaAtReset([a], [...observations, observation(a, 498_000, 61)]).unknown, 1);
  assert.equal(computeUnusedQuotaAtReset([], []).coverage, null);
});

test("ledger append is opt-in and export recursively projects only approved values", () => {
  const original = Object.freeze([]);
  const event = request("req-1", {
    deliveryId: "delivery-1", parentDeliveryId: "parent-1", receiptId: "receipt-1",
    trigger: "worker-wake", route: "resume", outcome: "completed", briefChars: 0, enqueuedAt: 0,
    accountEmail: "someone@example.test", prompt: "private", filesystemPath: "/private",
    usage: { ...codex(), prompt: "private", extra: { text: "private" } },
    counterDelta: { ...delta(0, 3), context: "private" },
    ambiguous: false,
  });
  assert.equal(appendLedgerEvent(original, event), original);
  const ledger = appendLedgerEvent(original, event, { enabled: true });
  assert.equal(ledger.length, 1);
  assert.equal(original.length, 0);
  assert.deepEqual(ledger, exportAllowlistedLedger([event]));
  assert.deepEqual(ledger[0], request("req-1", {
    deliveryId: "delivery-1", parentDeliveryId: "parent-1", receiptId: "receipt-1",
    trigger: "worker-wake", route: "resume", outcome: "completed", briefChars: 0, enqueuedAt: 0,
    counterDelta: delta(0, 3), ambiguous: false,
  }));
  event.usage.U = 999;
  assert.equal(ledger[0].usage.U, 60);
  assert.deepEqual(exportAllowlistedLedger([{
    accountAlias: "someone@example.test", agentAlias: "Firstname Lastname", sessionAlias: "/private",
    route: "private", outcome: "private", trigger: "private", briefChars: "private",
    usage: { U: { text: "private" }, R: 0, O: "private" },
  }]), [{ usage: { U: null, R: 0, W5: null, W60: null, O: null, W: null,
    writeTtlUnknown: false, invalid: false } }]);
});

test("ledger request IDs deduplicate snapshots only within provider/account namespace", () => {
  const pending = request("req-1", { endedAt: null, usage: null });
  const complete = request("req-1");
  const rows = deduplicateLedgerEvents([
    pending, complete, complete,
    request("req-1", { accountAlias: "account-2" }),
    request("req-1", { provider: "openai" }),
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { kind: "request", ambiguous: false, ...complete });
  const [conflict] = deduplicateLedgerEvents([complete, request("req-1", { packageId: "B", usage: codex(90) })]);
  assert.equal(conflict.ambiguous, true);
  assert.equal(conflict.packageId, undefined);
  assert.equal(deduplicateLedgerEvents([request("req-1", { startedAt: 11 })])[0].ambiguous, true);
});

test("verified monotonic counter ranges handle replay, resets, overlaps and ID bridging", () => {
  const row = (counterDelta, fields = {}) => request(null, { counterDelta, ...fields });
  const a = row(delta(0, 10));
  const b = row(delta(10, 20));
  const resetEpoch = row(delta(0, 10, "epoch-2"));
  const resetSession = row(delta(0, 10), { sessionAlias: "session-2" });
  const resetRun = row(delta(0, 10), { runId: "run-2" });
  const results = deduplicateLedgerEvents([a, b, resetEpoch, a, resetSession, resetRun]);
  assert.equal(results.length, 5);
  assert.ok(results.every((event) => !event.ambiguous));
  const bridge = [a, request("req-1"), request("req-1", { counterDelta: delta(0, 10) })];
  for (const order of [bridge, bridge.slice().reverse()]) {
    const [result, extra] = deduplicateLedgerEvents(order);
    assert.equal(result.providerRequestId, "req-1");
    assert.equal(result.ambiguous, false);
    assert.equal(extra, undefined);
  }
  assert.ok(deduplicateLedgerEvents([a, b, row(delta(5, 15))]).every((event) => event.ambiguous));
  const conflictingIds = deduplicateLedgerEvents([
    request("req-1", { counterDelta: delta(0, 10) }), request("req-2", { counterDelta: delta(0, 10) }),
  ]);
  assert.deepEqual(conflictingIds.map((event) => event.providerRequestId), ["req-1", "req-2"]);
  assert.ok(conflictingIds.every((event) => event.ambiguous));
  for (const bad of [delta(0, 0), delta(10, 1), { ...delta(0, 9), verified: false }, { ...delta(0, 9), epoch: null }]) {
    assert.ok(deduplicateLedgerEvents([row(bad), row(bad)]).every((event) => event.ambiguous));
    assert.equal(deduplicateLedgerEvents([row(bad), row(bad)]).length, 2);
  }
});

test("lifecycle rows reconcile from receipt or turn ID while ambiguous joins remain flagged", () => {
  const delivery = { kind: "delivery", runId: "run-1", deliveryId: "delivery-1", receiptId: "receipt-1" };
  const turn = { kind: "turn", runId: "run-1", sessionAlias: "session-1", providerTurnId: "turn-1",
    receiptId: "receipt-1", startedAt: 0 };
  assert.equal(deduplicateLedgerEvents([turn])[0].ambiguous, true);
  const reconciled = deduplicateLedgerEvents([
    { ...delivery, enqueuedAt: 0 },
    { kind: "delivery", runId: "run-1", receiptId: "receipt-1", endedAt: 1 },
    turn,
    { ...turn, endedAt: 10 },
    request("req-1", { deliveryId: "delivery-1", providerTurnId: "turn-1" }),
    request("req-2", { deliveryId: "delivery-1", providerTurnId: "turn-1" }),
  ]);
  assert.equal(reconciled.length, 4);
  assert.ok(reconciled.every((event) => !event.ambiguous));
  assert.equal(deduplicateLedgerEvents([turn, { ...turn, providerTurnId: "turn-2", endedAt: 8 }])[0].ambiguous, true);
  assert.equal(deduplicateLedgerEvents([turn, { ...turn, ambiguous: true, endedAt: 8 }])[0].ambiguous, true);
});

test("recovery stops at the first verified same-package milestone and counts an interrupted request once", () => {
  const interrupted = request("interrupted", { startedAt: 30_000, endedAt: 65_000, outcome: "aborted" });
  const result = computeRecoveryCost({
    runId: "run-1", packageId: "A", failedAt: 60_000, capAt: 240_000, tariff: codexTariff,
    milestones: [
      { runId: "run-1", packageId: "A", at: 61_000, verified: false },
      { runId: "run-1", packageId: "B", at: 62_000, verified: true },
      { runId: "run-2", packageId: "A", at: 63_000, verified: true },
      { runId: "run-1", packageId: "A", at: 180_000, verified: true },
      { runId: "run-1", packageId: "A", at: 120_000, verified: true },
    ],
    continuationTurns: [
      { runId: "run-1", packageId: "A", startedAt: 90_000 },
      { runId: "run-1", packageId: "B", startedAt: 66_000 },
    ],
    events: [
      request("before"),
      interrupted, interrupted,
      request("continue", { startedAt: 90_000, endedAt: 105_000 }),
      request("after", { startedAt: 121_000, endedAt: 150_000 }),
      request("other", { packageId: "B", startedAt: 90_000, endedAt: null }),
      request("other-run", { runId: "run-2", startedAt: 90_000, endedAt: 105_000 }),
    ],
  });
  assert.deepEqual(result, {
    complete: true, costUsd: 0.000408, minUsd: 0.000408, maxUsd: 0.000408,
    requestCount: 2, unknownRequests: 0, unresolvedEvents: 0,
    recovered: true, milestoneAt: 120_000, endedAt: 120_000, continuationAt: 90_000,
    elapsedMinutes: 1, continuationMinutes: 0.5, totalTokens: 216, interruptedRequests: 1,
  });
});

test("recovery reports time caps, token totals despite unknown write TTL, and unresolved open requests", () => {
  const priced = request("claude", {
    provider: "claude", startedAt: 20_000, endedAt: 50_000,
    usage: claude({ input: 2, cacheRead: 3, cacheWrite: 5, output: 7 }),
  });
  const scope = {
    packageId: "A", failedAt: 10_000, capAt: 70_000, tariff: claudeTariff,
    milestones: [{ packageId: "A", at: 72_000, verified: true }],
  };
  const capped = computeRecoveryCost({ ...scope, events: [priced] });
  assert.equal(capped.elapsedMinutes, 1);
  assert.equal(capped.recovered, false);
  assert.equal(capped.milestoneAt, null);
  assert.equal(capped.continuationMinutes, null);
  assert.equal(capped.totalTokens, 17);
  assert.equal(capped.complete, false);
  assert.equal(capped.minUsd, 0.00013065);
  assert.equal(capped.maxUsd, 0.0001419);
  const open = computeRecoveryCost({ ...scope, events: [priced, { ...priced, endedAt: null }] });
  assert.equal(open.requestCount, 1);
  assert.equal(open.unresolvedEvents, 0);
  assert.equal(open.totalTokens, 17);
  const unresolved = computeRecoveryCost({
    ...scope, events: [priced, { ...priced, providerRequestId: "open", endedAt: null }],
  });
  assert.equal(unresolved.unresolvedEvents, 1);
  assert.equal(unresolved.totalTokens, null);
});
