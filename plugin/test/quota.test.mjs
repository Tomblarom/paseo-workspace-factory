import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./ts-resolve-hooks.mjs", import.meta.url);
const { extractTurnUsage, mergeTurnUsage, resetQuotaForTests, sampleQuota } = await import("../server/quota.ts");
const { validateQuotaSettings } = await import("../shared/settings-validate.ts");
const { failoverChain } = await import("../server/factory/supervision.ts");

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

test("quota sampling parses paseo usage without host arguments and fails soft", () => {
  resetQuotaForTests();
  const calls = [];
  const snapshot = sampleQuota((binary, args) => {
    calls.push({ binary, args });
    return JSON.stringify([{ sourceId: "claude", report: { windows: [{ id: "5h", usedPct: 78 }] } }]);
  });
  assert.equal(snapshot.claude.sessionPct, 78);
  assert.deepEqual(calls[0].args, ["usage", "--json"]);
  assert.equal(sampleQuota(() => { throw new Error("offline"); }, () => {}).claude.sessionPct, 78);
});

test("quota settings validate thresholds and sample floor", () => {
  assert.deepEqual(validateQuotaSettings({ quota: { exhaustedPct: 90, warnPct: 75 }, quotaSampleMinutes: 10 }), []);
  assert.match(JSON.stringify(validateQuotaSettings({ quota: { exhaustedPct: 101, warnPct: -1 }, quotaSampleMinutes: 5 })), /quota.exhaustedPct|quota.warnPct|quotaSampleMinutes/);
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
