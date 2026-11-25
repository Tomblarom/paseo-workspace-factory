import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./ts-resolve-hooks.mjs", import.meta.url);
const { extractTurnUsage, mergeTurnUsage, resetQuotaForTests, sampleQuotaAsync, uncachedInputTokens } = await import("../server/quota.ts");
const { validateQuotaSettings } = await import("../shared/settings-validate.ts");
const { failoverChain } = await import("../server/core/supervision.mjs");

test("turn usage extracts provider counters and keeps cumulative totals", () => {
  const usage = extractTurnUsage({ outcome: { usage: {
    input_tokens: 4, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 5,
  } } });
  assert.deepEqual(usage, { input: 4, cacheWrite: 2, cacheRead: 3, output: 5 });
  assert.deepEqual(mergeTurnUsage({ cumulative: { input: 10, cacheWrite: 1, cacheRead: 2, output: 3 } }, usage), {
    cumulative: { input: 14, cacheWrite: 3, cacheRead: 5, output: 8 },
    lastTurn: usage,
  });
});

test("turn usage extraction covers provider shapes, legacy keys and missing fields", () => {
  const cases = [
    {
      name: "claude snake_case usage",
      payload: { outcome: { usage: {
        input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 10,
      } } },
      agent: null,
      want: { input: 100, cacheWrite: 20, cacheRead: 30, output: 10 },
    },
    {
      name: "claude camelCase usage",
      payload: { outcome: { usage: {
        inputTokens: 100, cacheCreationInputTokens: 20, cacheReadInputTokens: 30, outputTokens: 10,
      } } },
      agent: null,
      want: { input: 100, cacheWrite: 20, cacheRead: 30, output: 10 },
    },
    {
      name: "paseo live shape via agent.lastUsage (inputTokens/cachedInputTokens)",
      payload: { outcome: { kind: "completed" } },
      agent: { lastUsage: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50 } },
      want: { input: 1000, cacheWrite: 0, cacheRead: 800, output: 50 },
    },
    {
      name: "codex usage in outcome",
      payload: { outcome: { usage: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50 } } },
      agent: null,
      want: { input: 1000, cacheWrite: 0, cacheRead: 800, output: 50 },
    },
    {
      name: "snake_case paseo cache alias",
      payload: { outcome: { usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } } },
      agent: null,
      want: { input: 1000, cacheWrite: 0, cacheRead: 800, output: 50 },
    },
    {
      name: "legacy short keys",
      payload: { usage: { input: 7, cache_write: 1, cache_read: 2, output: 3 } },
      agent: null,
      want: { input: 7, cacheWrite: 1, cacheRead: 2, output: 3 },
    },
    {
      name: "partial fields default to zero",
      payload: { outcome: { kind: "completed" } },
      agent: { lastUsage: { inputTokens: 5 } },
      want: { input: 5, cacheWrite: 0, cacheRead: 0, output: 0 },
    },
    {
      name: "no usage anywhere yields null",
      payload: { outcome: { kind: "completed" } },
      agent: {},
      want: null,
    },
    {
      name: "all-zero usage yields null",
      payload: { outcome: { usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } } },
      agent: null,
      want: null,
    },
  ];
  for (const { name, payload, agent, want } of cases) {
    assert.deepEqual(extractTurnUsage(payload, agent), want, name);
  }
});

test("uncached input follows route semantics without double counting", () => {
  const codex = { input: 1000, cacheWrite: 0, cacheRead: 800, output: 50 };
  const claude = { input: 100, cacheWrite: 20, cacheRead: 30, output: 10 };
  const cases = [
    ["codex subtracts cache reads", codex, "codex", 200],
    ["openai subtracts cache reads", codex, "OpenAI", 200],
    ["claude keeps input as uncached", claude, "claude", 100],
    ["unknown route keeps input", codex, "other", 1000],
    ["missing route keeps input", codex, null, 1000],
    ["skewed snapshot clamps at zero", { ...codex, cacheRead: 9999 }, "codex", 0],
    ["missing usage is zero", null, "codex", 0],
  ];
  for (const [name, usage, route, want] of cases) {
    assert.equal(uncachedInputTokens(usage, route), want, name);
  }
});

test("cumulative totals accumulate raw counters across mixed routes", () => {
  const codexTurn = extractTurnUsage(
    { outcome: { kind: "completed" } },
    { lastUsage: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50 } },
  );
  const claudeTurn = extractTurnUsage({ outcome: { usage: {
    input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 10,
  } } });
  let stored = mergeTurnUsage(null, codexTurn);
  stored = mergeTurnUsage(stored, claudeTurn);
  assert.deepEqual(stored.cumulative, { input: 1100, cacheWrite: 20, cacheRead: 830, output: 60 });
  assert.deepEqual(stored.lastTurn, claudeTurn);
  // Raw storage: per-route uncached math still applies after accumulation.
  assert.equal(uncachedInputTokens(codexTurn, "codex"), 200);
  assert.equal(uncachedInputTokens(claudeTurn, "claude"), 100);
  assert.deepEqual(mergeTurnUsage(stored, null), stored);
});

test("quota sampling parses paseo usage without host arguments and fails soft", async () => {
  resetQuotaForTests();
  const calls = [];
  const snapshot = await sampleQuotaAsync((binary, args) => {
    calls.push({ binary, args });
    return JSON.stringify([{ sourceId: "claude", report: { windows: [{ id: "5h", usedPct: 78 }] } }]);
  });
  assert.equal(snapshot.claude.sessionPct, 78);
  assert.deepEqual(calls[0].args, ["usage", "--json"]);
  const kept = await sampleQuotaAsync(() => { throw new Error("offline"); }, () => {});
  assert.equal(kept.claude.sessionPct, 78);
});

test("concurrent quota samples share a single in-flight run", async () => {
  resetQuotaForTests();
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = async () => {
    runs += 1;
    await gate;
    return JSON.stringify([{ sourceId: "codex", report: { windows: [{ id: "5h", usedPct: 11 }] } }]);
  };
  const first = sampleQuotaAsync(run, () => {});
  const second = sampleQuotaAsync(run, () => {});
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(runs, 1);
  assert.equal(a.codex.sessionPct, 11);
  assert.equal(b.codex.sessionPct, 11);
  // After the run settles, the next sample runs again.
  assert.equal((await sampleQuotaAsync(run, () => {})).codex.sessionPct, 11);
  assert.equal(runs, 2);
});

test("quota settings validate thresholds", () => {
  assert.deepEqual(validateQuotaSettings({ quota: { exhaustedPct: 90, warnPct: 75 } }), []);
  assert.match(JSON.stringify(validateQuotaSettings({ quota: { exhaustedPct: 101, warnPct: -1 } })), /quota.exhaustedPct|quota.warnPct/);
});

test("failover chain prefers a different quota pool", () => {
  const chain = failoverChain({
    activeSlot: "A",
    failingPool: "claude",
    steers: [
      { slot: "B", id: "b", provider: "claude" },
      { slot: "C", id: "c", pool: "codex" },
    ],
  });
  assert.equal(chain[0].steerId, "c");
});
