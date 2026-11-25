import test from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_GROUPS,
  CACHE_CHECK_INTERVAL_MS,
  cacheTtlForAgent,
  resolveCacheTtl,
  EFFICIENCY_MIN_CONTEXT_TOKENS,
  compactAtMinutes,
  effectiveMinContextTokens,
  groupForProviderModel,
  isCleanupProfile,
  isCompactOnlyGroup,
  parseGptVersion,
} from "../shared/cache-profiles.ts";

test("cache reference table pins one TTL per model group", () => {
  assert.equal(CACHE_GROUPS.claude.ttlMinutes, 60);
  assert.equal(CACHE_GROUPS["openai-new"].ttlMinutes, 30);
  assert.equal(CACHE_GROUPS["openai-old"].ttlMinutes, 10);
  assert.equal(CACHE_GROUPS.other.ttlMinutes, 30);
  assert.equal(CACHE_GROUPS.claude.cachedInput, "~0.1×");
  assert.equal(CACHE_GROUPS["openai-new"].cachedInput, "0.05× (Sol)");
  assert.match(CACHE_GROUPS.other.note, /unknown warmth/);
});

test("parseGptVersion reads major/minor from model ids", () => {
  assert.deepEqual(parseGptVersion("gpt-6.2-sol"), [6, 2]);
  assert.deepEqual(parseGptVersion("gpt-5.6"), [5, 6]);
  assert.deepEqual(parseGptVersion("gpt-5.5"), [5, 5]);
  assert.deepEqual(parseGptVersion("gpt-4o"), [4, 0]);
  assert.deepEqual(parseGptVersion("GPT-6.2-ASTRA"), [6, 2]);
  assert.equal(parseGptVersion("claude-sonnet-5-5"), null);
  assert.equal(parseGptVersion("o3"), null);
  assert.equal(parseGptVersion(null), null);
  assert.equal(parseGptVersion(""), null);
});

test("groupForProviderModel classifies provider and model", () => {
  assert.equal(groupForProviderModel("claude", "claude-sonnet-5-5"), "claude");
  assert.equal(groupForProviderModel("claude", null), "claude");
  assert.equal(groupForProviderModel("CLAUDE", "whatever"), "claude");
  // A claude model on another provider follows the model family.
  assert.equal(groupForProviderModel("copilot", "claude-sonnet-5-5"), "claude");
  assert.equal(groupForProviderModel("codex", "gpt-6.2-sol"), "openai-new");
  assert.equal(groupForProviderModel("codex", "gpt-6.2-terra"), "openai-new");
  assert.equal(groupForProviderModel("codex", "gpt-5.6"), "openai-new");
  assert.equal(groupForProviderModel("codex", "gpt-5.5"), "openai-old");
  assert.equal(groupForProviderModel("codex", "gpt-4o"), "openai-old");
  assert.equal(groupForProviderModel("openai", "gpt-5.4"), "openai-old");
  // Unparseable Codex models count as current.
  assert.equal(groupForProviderModel("codex", "future-x"), "openai-new");
  assert.equal(groupForProviderModel("codex", null), "openai-new");
  // Unknown providers stay conservative.
  assert.equal(groupForProviderModel("muse", "muse-1.3"), "other");
  assert.equal(groupForProviderModel("copilot", "gpt-4o"), "openai-old");
  assert.equal(groupForProviderModel("copilot", "some-model"), "other");
  assert.equal(groupForProviderModel("ghost", null), "other");
  assert.equal(groupForProviderModel(null, null), "other");
});

test("only the OpenAI groups are compact-only (no native /clear)", () => {
  assert.equal(isCompactOnlyGroup("openai-new"), true);
  assert.equal(isCompactOnlyGroup("openai-old"), true);
  assert.equal(isCompactOnlyGroup("claude"), false);
  assert.equal(isCompactOnlyGroup("other"), false);
});

test("isCleanupProfile accepts the three cost profiles", () => {
  assert.equal(isCleanupProfile("efficiency"), true);
  assert.equal(isCleanupProfile("balanced"), true);
  assert.equal(isCleanupProfile("comfort"), true);
  assert.equal(isCleanupProfile("turbo"), false);
  assert.equal(isCleanupProfile(null), false);
  assert.equal(isCleanupProfile(undefined), false);
});

test("balanced compacts shortly before the cache cools (claude keeps 50)", () => {
  assert.equal(compactAtMinutes("balanced", CACHE_GROUPS["claude"]), 50);
  assert.equal(compactAtMinutes("balanced", CACHE_GROUPS["openai-new"]), 25);
  assert.equal(compactAtMinutes("balanced", CACHE_GROUPS["other"]), 25);
  assert.equal(compactAtMinutes("balanced", CACHE_GROUPS["openai-old"]), 8);
});

test("efficiency compacts at half the TTL, comfort just before it", () => {
  assert.equal(compactAtMinutes("efficiency", CACHE_GROUPS["claude"]), 30);
  assert.equal(compactAtMinutes("efficiency", CACHE_GROUPS["openai-new"]), 15);
  assert.equal(compactAtMinutes("efficiency", CACHE_GROUPS["openai-old"]), 5);
  assert.equal(compactAtMinutes("comfort", CACHE_GROUPS["claude"]), 58);
  assert.equal(compactAtMinutes("comfort", CACHE_GROUPS["openai-new"]), 28);
  assert.equal(compactAtMinutes("comfort", CACHE_GROUPS["openai-old"]), 8);
  for (const group of ["claude", "openai-new", "openai-old", "other"]) {
    for (const profile of ["efficiency", "balanced", "comfort"]) {
      const at = compactAtMinutes(profile, CACHE_GROUPS[group]);
      assert.ok(at * 60_000 >= CACHE_CHECK_INTERVAL_MS, `${profile}/${group} respects the sweep cadence`);
      assert.ok(at < CACHE_GROUPS[group].ttlMinutes, `${profile}/${group} stays warm`);
    }
  }
});

test("efficiency lowers the context floor, balanced and comfort keep it", () => {
  assert.equal(EFFICIENCY_MIN_CONTEXT_TOKENS, 10_000);
  assert.equal(effectiveMinContextTokens("efficiency", 60_000), 10_000);
  assert.equal(effectiveMinContextTokens("efficiency", 2_000), 2_000);
  assert.equal(effectiveMinContextTokens("balanced", 60_000), 60_000);
  assert.equal(effectiveMinContextTokens("comfort", 60_000), 60_000);
});

test("a five-minute route leaves time for each cleanup profile before expiry", () => {
  const ttl = resolveCacheTtl({ provider: "claude", claudeBilling: "api-5m" });
  for (const profile of ["efficiency", "balanced", "comfort"]) {
    assert.ok((ttl.ttlMinutes - compactAtMinutes(profile, ttl)) * 60_000 > CACHE_CHECK_INTERVAL_MS);
  }
});

test("a pending account move cannot extend the confirmed cache window", () => {
  const agent = { id: "worker", provider: "claude" };
  const routes = {
    agentAccount: { worker: "subscription" },
    accounts: [{ id: "subscription", family: "claude", auth: "subscription" }],
  };
  assert.equal(cacheTtlForAgent(agent, routes).ttlMinutes, 60);
  const pending = cacheTtlForAgent(agent, { ...routes, pending: { worker: "another-account" } });
  assert.equal(pending.ttlMinutes, 5);
  assert.equal(pending.billingUnconfirmed, true);
});
