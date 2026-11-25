// Step-1 tests for the steer-state projection: state priority, exact TTL
// endpoints, billing routes, model changes, missing evidence, the profile
// floor, restart recovery, supersession, and ZeroSub quota fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const {
  STEER_STATE_LABELS,
  cacheAgeMs,
  coolingMinutesForTtl,
  formatCountdown,
  isLargeContext,
  projectSteer,
  resolveCacheTtl,
  resolveContextTokens,
  resolveQuota,
  resolveWarmth,
  zerosubSupported,
} = await import("../shared/steer-state.ts");

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

/** Warm Codex baseline: idle, 5m old turn, small context, no quota data. */
function base(over = {}) {
  return {
    nowMs: NOW,
    agentId: "steer-a",
    provider: "codex",
    model: "gpt-6.2-sol",
    liveStatus: "idle",
    lastTurnEndedAt: iso(NOW - 5 * MIN),
    baselineValid: true,
    liveUsedTokens: 5000,
    cleanupProfile: "balanced",
    minContextTokens: 60000,
    ...over,
  };
}

function exhaustedPool(over = {}) {
  return {
    pool: "codex",
    quotaSnapshot: { codex: { sessionPct: 95, resetsAt: iso(NOW + 60 * MIN) } },
    poolSampledAtMs: NOW,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Face priority
// ---------------------------------------------------------------------------

test("face priority follows the state table top to bottom", () => {
  // Cold, large context with a staged reset: Ready and below lose to it.
  const low = {
    lastTurnEndedAt: iso(NOW - 60 * MIN),
    liveUsedTokens: 70000,
    resetAwaitingBrief: true,
  };
  const cases = [
    ["retired", { ...low, needsResume: "failed", queuedWake: true, ...exhaustedPool(), liveStatus: "running", superseded: true }, "open-holder"],
    ["running", { ...low, needsResume: "failed", queuedWake: true, ...exhaustedPool(), liveStatus: "running" }, "view-turn"],
    ["limited", { ...low, needsResume: "failed", queuedWake: true, ...exhaustedPool() }, "handoff-or-reset"],
    ["waiting", { ...low, needsResume: "failed", queuedWake: true }, "view-operation"],
    ["needs-resume", { ...low, needsResume: "failed" }, "preview-recovery"],
    ["ready", low, "focus-or-deliver"],
  ];
  for (const [state, over, action] of cases) {
    const got = projectSteer(base(over));
    assert.equal(got.state, state, JSON.stringify(over));
    assert.equal(got.label, STEER_STATE_LABELS[state]);
    assert.equal(got.primaryAction, action, state);
  }
});

test("cold beats large, large beats cooling and warm", () => {
  assert.equal(projectSteer(base({ lastTurnEndedAt: iso(NOW - 60 * MIN), liveUsedTokens: 70000 })).state, "cold");
  assert.equal(projectSteer(base({ liveUsedTokens: 70000 })).state, "large");
  assert.equal(projectSteer(base({ lastTurnEndedAt: iso(NOW - 27 * MIN), liveUsedTokens: 70000 })).state, "large");
  assert.equal(projectSteer(base({ lastTurnEndedAt: iso(NOW - 27 * MIN) })).state, "cooling");
  assert.equal(projectSteer(base()).state, "warm");
});

test("disconnected, ambiguous or unknown membership renders Unknown", () => {
  assert.equal(projectSteer(base({ connected: false, liveStatus: "running" })).state, "unknown");
  assert.equal(projectSteer(base({ membership: "ambiguous", liveStatus: "running" })).state, "unknown");
  assert.equal(projectSteer(base({ membership: "unknown" })).state, "unknown");
  const unknown = projectSteer(base({ baselineValid: false, liveUsedTokens: null }));
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.primaryAction, "reload-or-open");
});

test("retired covers scope, replaced holder and supersession", () => {
  assert.equal(projectSteer(base({ scopeRetired: true, liveStatus: "running" })).state, "retired");
  assert.equal(projectSteer(base({ replacedHolder: true, liveStatus: "running" })).state, "retired");
  const retired = projectSteer(base({ superseded: true, liveStatus: "running" }));
  assert.equal(retired.state, "retired");
  assert.equal(retired.detail, "Superseded by the current holder");
});

test("running covers live status and open turns, with review requests", () => {
  assert.equal(projectSteer(base({ liveStatus: "running" })).state, "running");
  assert.equal(projectSteer(base({ openTurn: true })).state, "running");
  const review = projectSteer(base({ liveStatus: "RUNNING", openTurn: true, permissionNeeded: true }));
  assert.equal(review.state, "running");
  assert.equal(review.reviewRequest, true);
  assert.match(review.detail, /review requested/);
  assert.equal(projectSteer(base({ liveStatus: "running" })).reviewRequest, false);
});

test("waiting covers initializing, operations, queued wakes and pending moves", () => {
  assert.equal(projectSteer(base({ liveStatus: "initializing" })).state, "waiting");
  assert.equal(projectSteer(base({ pendingOperation: true })).state, "waiting");
  assert.equal(projectSteer(base({ queuedWake: true })).state, "waiting");
  const move = projectSteer(
    base({
      zerosub: { accounts: [], agentAccount: { "steer-a": "acc-new" }, pending: { "steer-a": "acc-old" } },
    }),
  );
  assert.equal(move.state, "waiting");
  assert.equal(move.quota.pendingMove, true);
  assert.match(move.detail, /Account move/);
});

test("header keeps lower-priority facts and marks TTL states estimated", () => {
  const running = projectSteer(base({ liveStatus: "running", liveUsedTokens: 70000 }));
  assert.deepEqual(running.headerFacts, ["Estimated", "Large context"]);
  const large = projectSteer(base({ liveUsedTokens: 70000 }));
  assert.ok(large.headerFacts.includes("Estimated"));
  assert.ok(large.headerFacts.some((fact) => fact.startsWith("Warm · cooling in")));
  assert.ok(!large.headerFacts.includes("Large context"));
  const hinted = projectSteer(base({ freshHint: "package boundary" }));
  assert.ok(hinted.headerFacts.includes("Refresh recommended"));
});

// ---------------------------------------------------------------------------
// TTL endpoints and billing
// ---------------------------------------------------------------------------

test("cooling width pins one minute per TTL step", () => {
  assert.equal(coolingMinutesForTtl(60), 10);
  assert.equal(coolingMinutesForTtl(30), 5);
  assert.equal(coolingMinutesForTtl(10), 2);
  assert.equal(coolingMinutesForTtl(5), 1);
});

test("warmth endpoints are exact for every TTL", () => {
  for (const ttl of [60, 30, 10, 5]) {
    const coolingMs = coolingMinutesForTtl(ttl) * MIN;
    const ttlMs = ttl * MIN;
    const at = (ageMs) =>
      resolveWarmth({ nowMs: NOW, ageMs, ttlMinutes: ttl, baselineValid: true }).warmth;
    assert.equal(at(ttlMs - coolingMs - 1), "warm", `ttl ${ttl}`);
    assert.equal(at(ttlMs - coolingMs), "cooling", `ttl ${ttl}`);
    assert.equal(at(ttlMs - 1), "cooling", `ttl ${ttl}`);
    assert.equal(at(ttlMs), "cold", `ttl ${ttl}`);
    assert.equal(at(0), "warm", `ttl ${ttl}`);
  }
});

test("warmth boundary points at the next TTL edge", () => {
  const warm = resolveWarmth({ nowMs: NOW, ageMs: 5 * MIN, ttlMinutes: 30, baselineValid: true });
  assert.equal(warm.boundaryAtMs, NOW + 20 * MIN);
  const cooling = resolveWarmth({ nowMs: NOW, ageMs: 27 * MIN, ttlMinutes: 30, baselineValid: true });
  assert.equal(cooling.boundaryAtMs, NOW + 3 * MIN);
  const cold = resolveWarmth({ nowMs: NOW, ageMs: 30 * MIN, ttlMinutes: 30, baselineValid: true });
  assert.equal(cold.boundaryAtMs, null);
  const face = projectSteer(base());
  assert.equal(face.nextBoundaryAt, iso(NOW + 20 * MIN));
});

test("Claude billing selects 60m, 5m or unconfirmed 5m", () => {
  assert.deepEqual(resolveCacheTtl({ provider: "claude", model: "sonnet", claudeBilling: "subscription" }), {
    ttlMinutes: 60, group: "claude", billingUnconfirmed: false,
  });
  assert.deepEqual(resolveCacheTtl({ provider: "claude", model: "sonnet", claudeBilling: "api-5m" }), {
    ttlMinutes: 5, group: "claude", billingUnconfirmed: false,
  });
  assert.deepEqual(resolveCacheTtl({ provider: "claude", model: "sonnet" }), {
    ttlMinutes: 5, group: "claude", billingUnconfirmed: true,
  });
  const unconfirmed = projectSteer(base({ provider: "claude", model: "claude-sonnet-5-5" }));
  assert.equal(unconfirmed.ttlMinutes, 5);
  assert.ok(unconfirmed.headerFacts.includes("Billing path unconfirmed"));
});

test("Codex TTL splits at GPT-5.6 with an extended-retention override", () => {
  assert.equal(resolveCacheTtl({ provider: "codex", model: "gpt-6.2-sol" }).ttlMinutes, 30);
  assert.equal(resolveCacheTtl({ provider: "codex", model: "gpt-5.6" }).ttlMinutes, 30);
  assert.equal(resolveCacheTtl({ provider: "codex", model: "future-x" }).ttlMinutes, 30);
  assert.equal(resolveCacheTtl({ provider: "codex", model: "gpt-5.5" }).ttlMinutes, 10);
  assert.equal(
    resolveCacheTtl({ provider: "codex", model: "gpt-5.5", openaiExtendedRetention: true }).ttlMinutes,
    30,
  );
  assert.equal(resolveCacheTtl({ provider: "muse", model: "muse-1.3" }).ttlMinutes, 30);
  const other = projectSteer(base({ provider: "muse", model: "muse-1.3" }));
  assert.equal(other.warmth, "unknown");
  assert.equal(other.state, "unknown");
  const supported = projectSteer(base({ provider: "muse", model: "muse-1.3", otherRouteSupported: true }));
  assert.equal(supported.warmth, "warm");
});

// ---------------------------------------------------------------------------
// Model changes, missing evidence, profile floor
// ---------------------------------------------------------------------------

test("a model change with retained history is cold for the new configuration", () => {
  const changed = projectSteer(base({ prefixBreakRetained: true }));
  assert.equal(changed.state, "cold");
  assert.equal(changed.warmth, "cold");
  assert.equal(changed.warmthSource, "prefix-break");
  assert.match(changed.detail, /Settings changed/);
  assert.ok(!changed.headerFacts.includes("Estimated"));
});

test("the live model selects the TTL after a model change", () => {
  const aged = iso(NOW - 11 * MIN);
  const old = projectSteer(base({ model: "gpt-5.5", lastTurnEndedAt: aged }));
  assert.equal(old.ttlMinutes, 10);
  assert.equal(old.state, "cold");
  const current = projectSteer(base({ model: "gpt-5.6", lastTurnEndedAt: aged }));
  assert.equal(current.ttlMinutes, 30);
  assert.equal(current.state, "warm");
});

test("missing or future timestamps yield unknown warmth", () => {
  assert.equal(cacheAgeMs({ nowMs: NOW, lastTurnEndedAt: null }), null);
  assert.equal(cacheAgeMs({ nowMs: NOW, lastTurnEndedAt: "not-a-date" }), null);
  assert.equal(cacheAgeMs({ nowMs: NOW, lastTurnEndedAt: iso(NOW + MIN) }), null);
  assert.equal(cacheAgeMs({ nowMs: NOW, lastTurnEndedAt: iso(NOW - 5 * MIN) }), 5 * MIN);
  // A confirmed cache request start wins over the turn end (Claude TTL).
  assert.equal(
    cacheAgeMs({ nowMs: NOW, lastTurnEndedAt: iso(NOW - 50 * MIN), cacheStartAt: iso(NOW - 5 * MIN) }),
    5 * MIN,
  );
  const missing = projectSteer(base({ lastTurnEndedAt: null }));
  assert.equal(missing.warmth, "unknown");
  assert.equal(missing.state, "unknown");
  const noBaseline = projectSteer(base({ baselineValid: false }));
  assert.equal(noBaseline.warmth, "unknown");
  assert.equal(resolveWarmth({ nowMs: NOW, ageMs: -1, ttlMinutes: 30, baselineValid: true }).warmth, "unknown");
});

test("context size prefers live usage, then same-session stored tokens", () => {
  assert.equal(resolveContextTokens({ liveUsedTokens: 100, storedTokens: 200, storedSameSession: true }), 100);
  assert.equal(resolveContextTokens({ liveUsedTokens: null, storedTokens: 200, storedSameSession: true }), 200);
  assert.equal(resolveContextTokens({ liveUsedTokens: null, storedTokens: 200 }), null);
  assert.equal(resolveContextTokens({ liveUsedTokens: -1, storedTokens: 200, storedSameSession: true }), 200);
  assert.equal(resolveContextTokens({ liveUsedTokens: NaN, storedTokens: null }), null);
  const stored = projectSteer(base({ liveUsedTokens: null, storedTokens: 70000, storedSameSession: true }));
  assert.equal(stored.tokens, 70000);
  assert.equal(stored.state, "large");
  const unknown = projectSteer(base({ liveUsedTokens: null, storedTokens: 70000 }));
  assert.equal(unknown.tokens, null);
  assert.equal(unknown.large, false);
});

test("the profile floor decides Large (efficiency 10k, balanced 60k)", () => {
  assert.equal(isLargeContext(10000, "efficiency", 60000), true);
  assert.equal(isLargeContext(9999, "efficiency", 60000), false);
  assert.equal(isLargeContext(10000, "balanced", 60000), false);
  assert.equal(isLargeContext(60000, "balanced", 60000), true);
  assert.equal(isLargeContext(60000, "comfort", 60000), true);
  assert.equal(isLargeContext(60000, "bogus", 60000), true);
  assert.equal(isLargeContext(null, "efficiency", 60000), false);
  assert.equal(projectSteer(base({ liveUsedTokens: 10000, cleanupProfile: "efficiency" })).state, "large");
  assert.equal(projectSteer(base({ liveUsedTokens: 10000 })).state, "warm");
});

// ---------------------------------------------------------------------------
// Restart recovery and interruption
// ---------------------------------------------------------------------------

test("restart flags and unrecovered interruptions need resume", () => {
  const restart = projectSteer(base({ needsResume: "daemon-restart" }));
  assert.equal(restart.state, "needs-resume");
  assert.match(restart.detail, /Paseo restarted/);
  assert.equal(projectSteer(base({ needsResume: "failed" })).state, "needs-resume");
  const interrupted = projectSteer(base({ interruptedUnrecovered: true }));
  assert.equal(interrupted.state, "needs-resume");
  assert.match(interrupted.detail, /interrupted/);
  // Below Waiting, above Ready and Cold.
  assert.equal(projectSteer(base({ needsResume: "daemon-restart", queuedWake: true })).state, "waiting");
  assert.equal(
    projectSteer(base({ needsResume: "daemon-restart", resetAwaitingBrief: true, lastTurnEndedAt: iso(NOW - 60 * MIN) })).state,
    "needs-resume",
  );
  assert.equal(projectSteer(base({ interruptedUnrecovered: true, liveUsedTokens: 70000 })).state, "needs-resume");
});

test("needs-resume uses a compact brief for large, cold or uncertain context", () => {
  assert.equal(projectSteer(base({ needsResume: "failed", liveUsedTokens: 70000 })).compactBrief, true);
  assert.equal(projectSteer(base({ needsResume: "failed", lastTurnEndedAt: iso(NOW - 60 * MIN) })).compactBrief, true);
  assert.equal(projectSteer(base({ needsResume: "failed", baselineValid: false })).compactBrief, true);
  assert.equal(projectSteer(base({ needsResume: "failed" })).compactBrief, false);
});

test("a recovered limit needs resume instead of limiting", () => {
  const recovered = projectSteer(base({ needsResume: "limit", limitRecovered: true }));
  assert.equal(recovered.state, "needs-resume");
  assert.match(recovered.detail, /limit/i);
  const flagged = projectSteer(base({ needsResume: "limit" }));
  assert.equal(flagged.state, "limited");
  assert.deepEqual(flagged.quota.limitedReasons, ["Provider limit flagged"]);
  assert.equal(flagged.quota.resetUnknown, true);
});

test("cold faces preview refresh except for small known contexts", () => {
  const small = projectSteer(base({ lastTurnEndedAt: iso(NOW - 60 * MIN) }));
  assert.equal(small.primaryAction, "focus-reuse");
  assert.equal(small.refreshPreview, false);
  assert.equal(projectSteer(base({ lastTurnEndedAt: iso(NOW - 60 * MIN), liveUsedTokens: 70000 })).primaryAction, "preview-refresh");
  assert.equal(projectSteer(base({ lastTurnEndedAt: iso(NOW - 60 * MIN), liveUsedTokens: null })).primaryAction, "preview-refresh");
  assert.equal(projectSteer(base({ lastTurnEndedAt: iso(NOW - 60 * MIN), freshHint: "x" })).primaryAction, "preview-refresh");
  assert.equal(projectSteer(base({ needsResume: "cold" })).state, "cold");
});

test("formatCountdown renders short local countdowns", () => {
  assert.equal(formatCountdown(45 * MIN), "45m");
  assert.equal(formatCountdown(72 * MIN), "1h 12m");
  assert.equal(formatCountdown(2 * 24 * 60 * MIN + 3 * 60 * MIN), "2d 3h");
  assert.equal(formatCountdown(-5), "0m");
});

// ---------------------------------------------------------------------------
// ZeroSub fixtures: live vs pending routes, versions, windows, staleness
// ---------------------------------------------------------------------------

function account(id, over = {}) {
  return {
    id,
    family: "claude",
    label: id,
    status: "active",
    limitedUntil: null,
    windows: [],
    maxUsedPct: null,
    exhausted: false,
    ...over,
  };
}

function window(id, usedPct, resetsAt, over = {}) {
  return { id, usedPct, resetsAt, ...over };
}

test("a pending move keeps the live route, the destination and the wait", () => {
  const quota = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    zerosub: {
      accounts: [
        account("acc-old", { windows: [window("five_hour", 20, iso(NOW + 60 * MIN))] }),
        account("acc-new", { windows: [window("five_hour", 99, iso(NOW + 60 * MIN))] }),
      ],
      agentAccount: { "steer-a": "acc-new" },
      pending: { "steer-a": "acc-old" },
      waiting: { "steer-a": "turn" },
    },
  });
  // pendingAccountId is the current session; accountId is its destination.
  assert.equal(quota.source, "account");
  assert.equal(quota.accountId, "acc-old");
  assert.equal(quota.destinationAccountId, "acc-new");
  assert.equal(quota.waiting, "turn");
  assert.equal(quota.pendingMove, true);
  assert.equal(quota.limited, false);
  const face = projectSteer(
    base({
      zerosub: {
        accounts: [account("acc-old", { windows: [window("five_hour", 20, iso(NOW + 60 * MIN))] })],
        agentAccount: { "steer-a": "acc-new" },
        pending: { "steer-a": "acc-old" },
      },
    }),
  );
  assert.equal(face.state, "waiting");
  assert.equal(face.restartAction, false);
});

test("a move waiting on a restart names the required session action", () => {
  const face = projectSteer(
    base({
      zerosub: {
        accounts: [account("acc-old", { windows: [window("five_hour", 20, iso(NOW + 60 * MIN))] })],
        agentAccount: { "steer-a": "acc-new" },
        pending: { "steer-a": "acc-old" },
        waiting: { "steer-a": "restart" },
      },
    }),
  );
  assert.equal(face.state, "waiting");
  assert.equal(face.restartAction, true);
  assert.match(face.detail, /restart/);
  assert.equal(projectSteer(base({ queuedWake: true })).restartAction, false);
});

test("missing versions read as v1, explicit unknown versions fall back", () => {
  assert.equal(zerosubSupported(null), false);
  assert.equal(zerosubSupported({}), true);
  assert.equal(zerosubSupported({ version: null }), true);
  assert.equal(zerosubSupported({ version: "1" }), true);
  assert.equal(zerosubSupported({ version: "v1" }), true);
  assert.equal(zerosubSupported({ version: 1 }), true);
  assert.equal(zerosubSupported({ version: "2" }), false);
  const full = {
    accounts: [account("acc-full", { windows: [window("five_hour", 99, iso(NOW + 60 * MIN))] })],
    agentAccount: { "steer-a": "acc-full" },
  };
  const v1 = resolveQuota({ nowMs: NOW, agentId: "steer-a", zerosub: full });
  assert.equal(v1.source, "account");
  assert.equal(v1.limited, true);
  const v2 = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    zerosub: { ...full, version: "2" },
    pool: "claude",
    quotaSnapshot: { claude: { sessionPct: 10, resetsAt: iso(NOW + 60 * MIN) } },
    poolSampledAtMs: NOW,
  });
  assert.equal(v2.source, "pool");
  assert.equal(v2.limited, false);
});

test("model windows only govern the selected model and get their own row", () => {
  const zerosub = {
    accounts: [
      account("acc-1", {
        windows: [
          window("five_hour", 20, iso(NOW + 60 * MIN)),
          window("opus-only", 99, iso(NOW + 60 * MIN), { models: ["opus"] }),
        ],
      }),
    ],
    agentAccount: { "steer-a": "acc-1" },
  };
  const sonnet = resolveQuota({ nowMs: NOW, agentId: "steer-a", model: "sonnet", zerosub });
  assert.equal(sonnet.limited, false);
  assert.deepEqual(sonnet.rows.map((row) => [row.id, row.scope, row.usedPct]), [["five_hour", "account", 20]]);
  const opus = resolveQuota({ nowMs: NOW, agentId: "steer-a", model: "Opus", zerosub });
  assert.equal(opus.limited, true);
  assert.deepEqual(opus.limitedReasons, ["Factory quota threshold"]);
  assert.deepEqual(opus.rows.map((row) => [row.id, row.scope, row.usedPct]), [
    ["five_hour", "account", 20],
    ["opus-only", "model", 99],
  ]);
  // A versioned live model matches its short restriction.
  const sol = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    model: "gpt-6.2-sol",
    zerosub: {
      accounts: [account("acc-1", { windows: [window("sol-only", 95, iso(NOW + 60 * MIN), { models: ["gpt-6.2"] })] })],
      agentAccount: { "steer-a": "acc-1" },
    },
  });
  assert.equal(sol.limited, true);
  // Without a live model, restricted windows stay out.
  const unknown = resolveQuota({ nowMs: NOW, agentId: "steer-a", zerosub });
  assert.equal(unknown.limited, false);
});

test("expired windows stop counting once their reset passes", () => {
  const zerosub = {
    accounts: [
      account("acc-1", {
        windows: [window("five_hour", 99, iso(NOW - MIN))],
        maxUsedPct: 99,
      }),
    ],
    agentAccount: { "steer-a": "acc-1" },
  };
  // Sampled before the reset: the 99% reading is expired, not a limit.
  const expired = resolveQuota({ nowMs: NOW, agentId: "steer-a", zerosub, zerosubSampledAtMs: NOW - 5 * MIN });
  assert.equal(expired.limited, false);
  assert.equal(expired.awaitingUpdate, true);
  assert.equal(expired.rows[0].usedPct, null);
  assert.equal(expired.rows[0].stale, true);
  // Sampled after the reset: a fresh reading counts again.
  const fresh = resolveQuota({ nowMs: NOW, agentId: "steer-a", zerosub, zerosubSampledAtMs: NOW });
  assert.equal(fresh.limited, true);
});

test("percentage data goes stale after two sampling intervals", () => {
  const zerosub = {
    accounts: [account("acc-1", { windows: [window("five_hour", 99, iso(NOW + 60 * MIN))] })],
    agentAccount: { "steer-a": "acc-1" },
  };
  const fresh = resolveQuota({ nowMs: NOW, agentId: "steer-a", zerosub, zerosubSampledAtMs: NOW - 20 * MIN });
  assert.equal(fresh.limited, true);
  assert.equal(fresh.awaitingUpdate, false);
  const stale = resolveQuota({ nowMs: NOW, agentId: "steer-a", zerosub, zerosubSampledAtMs: NOW - 20 * MIN - 1 });
  assert.equal(stale.limited, false);
  assert.equal(stale.awaitingUpdate, true);
  // An explicit future hold survives a stale sample.
  const held = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    zerosub: {
      accounts: [account("acc-1", { limitedUntil: iso(NOW + 30 * MIN), windows: [window("five_hour", 99, iso(NOW + 60 * MIN))] })],
      agentAccount: { "steer-a": "acc-1" },
    },
    zerosubSampledAtMs: NOW - 60 * MIN,
  });
  assert.equal(held.limited, true);
  assert.deepEqual(held.blockers, [{ label: "Limited until", resetsAt: iso(NOW + 30 * MIN) }]);
});

test("explicit status and holds limit with their own resets", () => {
  const status = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    zerosub: {
      accounts: [account("acc-1", { status: "limited", exhausted: true })],
      agentAccount: { "steer-a": "acc-1" },
    },
  });
  assert.equal(status.limited, true);
  assert.match(status.limitedReasons.join(";"), /Explicit limit status/);
  assert.equal(status.resetUnknown, true);
  // A stale sample cannot carry a fresh status limit.
  const stale = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    zerosub: {
      accounts: [account("acc-1", { status: "limited", exhausted: true })],
      agentAccount: { "steer-a": "acc-1" },
    },
    zerosubSampledAtMs: NOW - 60 * MIN,
  });
  assert.equal(stale.limited, false);
  // One timer: the latest known blocking reset; a missing time flags unknown.
  const timer = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    zerosub: {
      accounts: [
        account("acc-1", {
          limitedUntil: iso(NOW + 30 * MIN),
          windows: [window("five_hour", 99, iso(NOW + 90 * MIN))],
        }),
      ],
      agentAccount: { "steer-a": "acc-1" },
    },
  });
  assert.equal(timer.limited, true);
  assert.equal(timer.resetAt, iso(NOW + 90 * MIN));
  assert.equal(timer.resetUnknown, false);
  const unknown = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    zerosub: {
      accounts: [account("acc-1", { windows: [window("five_hour", 99, null)] })],
      agentAccount: { "steer-a": "acc-1" },
    },
  });
  assert.equal(unknown.resetAt, null);
  assert.equal(unknown.resetUnknown, true);
});

test("signed-out and disabled accounts are unavailable, never Limited", () => {
  for (const [status, reason] of [["signed-out", "Account signed out"], ["Disabled", "Account disabled"]]) {
    const quota = resolveQuota({
      nowMs: NOW,
      agentId: "steer-a",
      zerosub: {
        accounts: [account("acc-1", { status, windows: [window("five_hour", 99, iso(NOW + 60 * MIN))] })],
        agentAccount: { "steer-a": "acc-1" },
      },
    });
    assert.equal(quota.limited, false, status);
    assert.equal(quota.unavailableReason, reason, status);
  }
});

test("pool fallback limits on thresholds and holds, never on ordinary resets", () => {
  const hit = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    pool: "codex",
    quotaSnapshot: { codex: { sessionPct: 95, resetsAt: iso(NOW + 60 * MIN) } },
    poolSampledAtMs: NOW,
  });
  assert.equal(hit.source, "pool");
  assert.equal(hit.limited, true);
  assert.deepEqual(hit.limitedReasons, ["Factory quota threshold"]);
  // A healthy pool with a future regular reset is usable.
  const healthy = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    pool: "codex",
    quotaSnapshot: { codex: { sessionPct: 40, weeklyPct: 48, resetsAt: iso(NOW + 60 * MIN) } },
    poolSampledAtMs: NOW,
  });
  assert.equal(healthy.limited, false);
  assert.equal(healthy.awaitingUpdate, false);
  // An explicit snapshot hold limits without any percent.
  const held = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    pool: "codex",
    quotaSnapshot: { codex: { sessionPct: 10, limitUntil: iso(NOW + 15 * MIN) } },
    poolSampledAtMs: NOW,
  });
  assert.equal(held.limited, true);
  assert.equal(held.resetAt, iso(NOW + 15 * MIN));
  // A stale pool sample awaits an update instead of limiting.
  const stale = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    pool: "codex",
    quotaSnapshot: { codex: { sessionPct: 95 } },
    poolSampledAtMs: NOW - 60 * MIN,
  });
  assert.equal(stale.limited, false);
  assert.equal(stale.awaitingUpdate, true);
});

test("a past reset or newer usable evidence retires the limit inference", () => {
  const zerosub = {
    accounts: [account("acc-1", { windows: [window("five_hour", 20, iso(NOW + 60 * MIN))] })],
    agentAccount: { "steer-a": "acc-1" },
  };
  // Newer usable evidence: fresh 20% retires the flagged limit.
  const usable = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    zerosub,
    needsResumeReason: "limit",
    needsResumeAt: iso(NOW - 60 * MIN),
  });
  assert.equal(usable.limitRetired, true);
  assert.equal(usable.limited, false);
  const face = projectSteer(base({ zerosub, needsResume: "limit", needsResumeAt: iso(NOW - 60 * MIN) }));
  assert.equal(face.state, "needs-resume");
  // Past reset after the failure retires it even without fresh percents.
  const reset = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    zerosub: {
      accounts: [account("acc-1", { windows: [window("five_hour", null, iso(NOW - 10 * MIN))] })],
      agentAccount: { "steer-a": "acc-1" },
    },
    zerosubSampledAtMs: NOW,
    needsResumeReason: "limit",
    needsResumeAt: iso(NOW - 60 * MIN),
  });
  assert.equal(reset.limitRetired, true);
  assert.equal(reset.limited, false);
  // A reset before the failure changes nothing.
  const kept = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    zerosub: {
      accounts: [account("acc-1", { windows: [window("five_hour", null, iso(NOW - 90 * MIN))] })],
      agentAccount: { "steer-a": "acc-1" },
    },
    zerosubSampledAtMs: NOW,
    needsResumeReason: "limit",
    needsResumeAt: iso(NOW - 60 * MIN),
  });
  assert.equal(kept.limitRetired, false);
  assert.equal(kept.limited, true);
});

test("the legacy aggregate only fills in when no window carries a percent", () => {
  const aggregate = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    zerosub: {
      accounts: [account("acc-1", { maxUsedPct: 95 })],
      agentAccount: { "steer-a": "acc-1" },
    },
  });
  assert.equal(aggregate.limited, true);
  const windows = resolveQuota({
    nowMs: NOW,
    agentId: "steer-a",
    zerosub: {
      accounts: [account("acc-1", { windows: [window("five_hour", 20, iso(NOW + 60 * MIN))], maxUsedPct: 95 })],
      agentAccount: { "steer-a": "acc-1" },
    },
  });
  assert.equal(windows.limited, false);
});
