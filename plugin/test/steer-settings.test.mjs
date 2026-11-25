// Step-4 settings logic: tuple normalization, catalog-backed support checks,
// the efficiency lock, Apply here vs Refresh routing, and the observed-change
// warning with revert eligibility. Pure module only; no sends, no daemon.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const settings = await import("../shared/steer-settings.ts");

const TUPLE = { provider: "codex", model: "gpt-6.2-sol", thinking: "high", speed: "default" };
const CLAUDE = { provider: "claude", model: "claude-opus-4-6", thinking: null, speed: "standard" };

const CATALOG = [
  {
    provider: "codex",
    enabled: true,
    status: "ready",
    models: [
      { id: "gpt-6.2-sol", thinkingOptions: [{ id: "high" }, { id: "low" }] },
      { id: "gpt-5.5", thinkingOptions: [] },
      { id: "gpt-hidden", isSelectable: false, thinkingOptions: [] },
    ],
  },
  {
    provider: "claude",
    enabled: true,
    status: "ready",
    models: [{ id: "claude-opus-4-6", thinkingOptions: [{ id: "think" }] }],
  },
  { provider: "off", enabled: false, status: "ready", models: [] },
];

// ---------------------------------------------------------------------------
// Tuples
// ---------------------------------------------------------------------------

test("thinking normalizes empty and explicit default to null", () => {
  assert.equal(settings.normalizeThinking(null), null);
  assert.equal(settings.normalizeThinking(""), null);
  assert.equal(settings.normalizeThinking("  "), null);
  assert.equal(settings.normalizeThinking("default"), null);
  assert.equal(settings.normalizeThinking("Default"), null);
  assert.equal(settings.normalizeThinking("high"), "high");
  assert.equal(settings.normalizeThinking(" high "), "high");
});

test("speed normalizes Claude fast_mode and Codex tiers", () => {
  assert.equal(settings.normalizeSpeed("claude", "m", true), "fast");
  assert.equal(settings.normalizeSpeed("claude", "m", false), "standard");
  assert.equal(settings.normalizeSpeed("claude", "m", "Fast"), "fast");
  assert.equal(settings.normalizeSpeed("codex", "m", "Flex"), "flex");
  assert.equal(settings.normalizeSpeed("codex", "m", ""), null);
  assert.equal(settings.normalizeSpeed("codex", "m", null), null);
});

test("speed comes from live options, null when the route reports none", () => {
  assert.equal(settings.speedOfLiveOptions("claude", "m", { fast_mode: true }), "fast");
  assert.equal(settings.speedOfLiveOptions("claude", "m", { fast_mode: false }), "standard");
  assert.equal(settings.speedOfLiveOptions("codex", "m", { service_tier: "flex" }), "flex");
  assert.equal(settings.speedOfLiveOptions("codex", "m", {}), null);
  assert.equal(settings.speedOfLiveOptions("codex", "m", null), null);
});

test("a no-op change compares normalized tuples", () => {
  const current = { provider: "Codex", model: "gpt-6.2-sol", thinking: "default", speed: "Default" };
  const requested = { provider: "codex", model: "gpt-6.2-sol", thinking: null, speed: "default" };
  assert.equal(settings.isNoopChange(current, requested), true);
  assert.equal(settings.isNoopChange(TUPLE, { ...TUPLE, thinking: "low" }), false);
  assert.equal(settings.isNoopChange(TUPLE, { ...TUPLE, speed: "fast" }), false);
  assert.equal(settings.isNoopChange(TUPLE, { ...TUPLE, model: "gpt-5.5" }), false);
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

test("only ready providers and selectable models are listed", () => {
  assert.deepEqual(settings.listSupportedModels(CATALOG, "codex"), ["gpt-6.2-sol", "gpt-5.5"]);
  assert.deepEqual(settings.listSupportedModels(CATALOG, "claude"), ["claude-opus-4-6"]);
  assert.deepEqual(settings.listSupportedModels(CATALOG, "off"), []);
  assert.deepEqual(settings.listSupportedModels(CATALOG, "missing"), []);
  assert.deepEqual(settings.listSupportedModels(null, "codex"), []);
});

test("thinking options follow the model, default-only when none are listed", () => {
  assert.deepEqual(settings.thinkingOptionsFor(CATALOG, "codex", "gpt-6.2-sol"), ["high", "low"]);
  assert.deepEqual(settings.thinkingOptionsFor(CATALOG, "codex", "gpt-5.5"), []);
  assert.deepEqual(settings.thinkingOptionsFor(CATALOG, "codex", "missing"), []);
});

test("unsupported settings fail with an English reason, supported ones pass", () => {
  assert.deepEqual(settings.checkSupportedCombination(CATALOG, "codex", "gpt-6.2-sol", "high"), {
    ok: true,
    reason: null,
  });
  assert.deepEqual(settings.checkSupportedCombination(CATALOG, "codex", "gpt-6.2-sol", null), {
    ok: true,
    reason: null,
  });
  assert.deepEqual(settings.checkSupportedCombination(CATALOG, "codex", "gpt-6.2-sol", "default"), {
    ok: true,
    reason: null,
  });
  const thinking = settings.checkSupportedCombination(CATALOG, "codex", "gpt-6.2-sol", "ultra");
  assert.equal(thinking.ok, false);
  assert.match(thinking.reason, /Thinking "ultra" is not available/);
  const model = settings.checkSupportedCombination(CATALOG, "codex", "gpt-9", null);
  assert.equal(model.ok, false);
  assert.match(model.reason, /not offered by codex/);
  const hidden = settings.checkSupportedCombination(CATALOG, "codex", "gpt-hidden", null);
  assert.equal(hidden.ok, false);
  const provider = settings.checkSupportedCombination(CATALOG, "missing", "m", null);
  assert.equal(provider.ok, false);
  const disabled = settings.checkSupportedCombination(CATALOG, "off", "m", null);
  assert.equal(disabled.ok, false);
  assert.match(disabled.reason, /disabled/);
});

test("Claude speeds are fast or standard, other tiers pass through", () => {
  assert.deepEqual(settings.checkSupportedSpeed("claude", "m", "fast"), { ok: true, reason: null });
  assert.deepEqual(settings.checkSupportedSpeed("claude", "m", null), { ok: true, reason: null });
  const bad = settings.checkSupportedSpeed("claude", "m", "flex");
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /Fast or Standard/);
  assert.deepEqual(settings.checkSupportedSpeed("codex", "m", "flex"), { ok: true, reason: null });
});

// ---------------------------------------------------------------------------
// Efficiency lock
// ---------------------------------------------------------------------------

test("efficiency locks warm, cooling and running steers", () => {
  for (const warmth of ["warm", "cooling"]) {
    const locked = settings.efficiencySettingsLock({ profile: "efficiency", warmth, state: warmth });
    assert.equal(locked.locked, true);
    assert.match(locked.reason, /Maximum efficiency/);
  }
  const largeWarm = settings.efficiencySettingsLock({ profile: "efficiency", warmth: "warm", state: "large" });
  assert.equal(largeWarm.locked, true);
  for (const liveStatus of ["running", "initializing"]) {
    const running = settings.efficiencySettingsLock({ profile: "efficiency", warmth: "cold", liveStatus });
    assert.equal(running.locked, true);
    assert.match(running.reason, /turn is running/);
  }
  const openTurn = settings.efficiencySettingsLock({ profile: "efficiency", warmth: "cold", openTurn: true });
  assert.equal(openTurn.locked, true);
  const runningFace = settings.efficiencySettingsLock({ profile: "efficiency", warmth: "unknown", state: "running" });
  assert.equal(runningFace.locked, true);
});

test("efficiency allows cold steers, other profiles never lock", () => {
  assert.deepEqual(
    settings.efficiencySettingsLock({ profile: "efficiency", warmth: "cold", state: "cold" }),
    { locked: false, reason: null },
  );
  assert.deepEqual(
    settings.efficiencySettingsLock({ profile: "efficiency", warmth: "unknown", state: "large" }),
    { locked: false, reason: null },
  );
  for (const profile of ["balanced", "comfort", null, "unknown"]) {
    assert.deepEqual(
      settings.efficiencySettingsLock({ profile, warmth: "warm", state: "warm" }),
      { locked: false, reason: null },
    );
    assert.deepEqual(
      settings.efficiencySettingsLock({ profile, warmth: "cold", liveStatus: "running" }),
      { locked: false, reason: null },
    );
  }
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

test("a no-op applies here without cache risk", () => {
  assert.deepEqual(
    settings.chooseSettingsRoute({ current: TUPLE, requested: { ...TUPLE }, warmth: "warm", large: true, tokens: 90000 }),
    { route: "apply-here", reason: "No change.", cacheRisk: false },
  );
});

test("warm, large and unknown contexts refresh", () => {
  const requested = { ...TUPLE, thinking: "low" };
  assert.equal(
    settings.chooseSettingsRoute({ current: TUPLE, requested, warmth: "warm", large: false, tokens: 1000 }).route,
    "refresh",
  );
  assert.equal(
    settings.chooseSettingsRoute({ current: TUPLE, requested, warmth: "cooling", large: false, tokens: 1000 }).route,
    "refresh",
  );
  assert.equal(
    settings.chooseSettingsRoute({ current: TUPLE, requested, warmth: "cold", large: true, tokens: 90000 }).route,
    "refresh",
  );
  assert.equal(
    settings.chooseSettingsRoute({ current: TUPLE, requested, warmth: "cold", large: false, tokens: null }).route,
    "refresh",
  );
  assert.equal(
    settings.chooseSettingsRoute({ current: TUPLE, requested, warmth: "cold", large: false, tokens: 1000, efficiencyLocked: true }).route,
    "refresh",
  );
});

test("a small cold context applies here with a cache-risk note", () => {
  assert.deepEqual(
    settings.chooseSettingsRoute({ current: TUPLE, requested: { ...TUPLE, thinking: "low" }, warmth: "cold", large: false, tokens: 1000 }),
    { route: "apply-here", reason: "Small cold context. Safe to apply here.", cacheRisk: true },
  );
});

// ---------------------------------------------------------------------------
// Observed change
// ---------------------------------------------------------------------------

const BASELINE = { ...TUPLE, sessionId: "sess-1" };

test("matching live and baseline is clean", () => {
  assert.deepEqual(
    settings.detectObservedChange({ live: { ...TUPLE }, liveSessionId: "sess-1", baseline: BASELINE }),
    { state: "clean", observed: null },
  );
});

test("a confirmed Factory transition raises no warning", () => {
  const live = { ...TUPLE, thinking: "low" };
  assert.deepEqual(
    settings.detectObservedChange({ live, liveSessionId: "sess-1", baseline: BASELINE, confirmed: { ...live } }),
    { state: "clean", observed: null },
  );
});

test("an external change is reported once with the observed tuple", () => {
  const live = { ...TUPLE, thinking: "low" };
  const verdict = settings.detectObservedChange({ live, liveSessionId: "sess-1", baseline: BASELINE });
  assert.equal(verdict.state, "changed");
  assert.deepEqual(verdict.observed, live);
  const first = settings.updateObservedTracker(null, verdict);
  assert.deepEqual(first.observed, live);
  const newer = { ...TUPLE, thinking: "ultra" };
  const second = settings.updateObservedTracker(first, settings.detectObservedChange({
    live: newer,
    liveSessionId: "sess-1",
    baseline: BASELINE,
  }));
  assert.deepEqual(second.observed, live);
  const cleared = settings.updateObservedTracker(second, settings.detectObservedChange({
    live: { ...TUPLE },
    liveSessionId: "sess-1",
    baseline: BASELINE,
  }));
  assert.deepEqual(cleared, { observed: null, state: "clean" });
});

test("no comparable baseline is unknown, never a warning", () => {
  const live = { ...TUPLE, thinking: "low" };
  assert.equal(settings.detectObservedChange({ live, liveSessionId: "sess-1", baseline: null }).state, "unknown");
  assert.equal(settings.detectObservedChange({ live: null, liveSessionId: "sess-1", baseline: BASELINE }).state, "unknown");
  assert.equal(settings.detectObservedChange({ live, liveSessionId: "sess-2", baseline: BASELINE }).state, "unknown");
  assert.equal(settings.detectObservedChange({ live, liveSessionId: null, baseline: BASELINE }).state, "unknown");
});

test("revert needs an idle tab with the observed tuple still live", () => {
  const observed = { ...TUPLE, thinking: "low" };
  assert.deepEqual(
    settings.canRevertObserved({ live: { ...observed }, observed, liveStatus: "idle" }),
    { allowed: true, reason: null },
  );
  assert.deepEqual(
    settings.canRevertObserved({ live: { ...TUPLE, thinking: "ultra" }, observed, liveStatus: "idle" }),
    { allowed: false, reason: "Settings changed again. Review before reverting." },
  );
  assert.deepEqual(
    settings.canRevertObserved({ live: { ...observed }, observed, liveStatus: "running" }),
    { allowed: false, reason: "A turn is running. Revert after it ends." },
  );
  assert.deepEqual(
    settings.canRevertObserved({ live: { ...observed }, observed: null, liveStatus: "idle" }),
    { allowed: false, reason: "No observed change to revert." },
  );
});

// ---------------------------------------------------------------------------
// Speed patch
// ---------------------------------------------------------------------------

test("speed patches touch only the provider speed key", () => {
  assert.deepEqual(settings.speedPatchFor("claude", "m", "fast"), { fast_mode: true });
  assert.deepEqual(settings.speedPatchFor("claude", "m", "standard"), { fast_mode: false });
  assert.equal(settings.speedPatchFor("claude", "m", null), null);
  assert.deepEqual(settings.speedPatchFor("codex", "m", "flex"), { service_tier: "flex" });
  assert.deepEqual(settings.speedPatchFor("codex", "m", null), { service_tier: null });
  assert.equal(settings.speedPatchFor("other", "m", "fast"), null);
});
