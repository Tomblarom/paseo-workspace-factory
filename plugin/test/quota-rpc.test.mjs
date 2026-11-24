import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./ts-resolve-hooks.mjs", import.meta.url);
const { shapeQuotaView } = await import("../server/quota-rpc.ts");
const { parseFactoryArgs, FACTORY_COMMANDS, factoryHelp } = await import("../shared/factory-args.ts");
const { validateQuotaSettings } = await import("../shared/settings-validate.ts");

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const SAMPLED = "2026-06-01T11:55:00.000Z";

function fakeConfig() {
  return {
    quota: { warnPct: 75, exhaustedPct: 90 },
    profiles: {
      "codex-high": { provider: "codex", model: "gpt-6.2-sol" },
      "claude-sonnet": { provider: "claude", model: "claude-sonnet-5-5" },
      reviewer: { provider: "claude", model: "opus", advisor: true },
    },
    steers: { slots: { A: "codex-high", B: "claude-sonnet", C: "reviewer" } },
    workers: { priority: ["claude-sonnet", "codex-high"] },
  };
}

test("quota view shapes snapshot pools with warn states and slot mappings", () => {
  const view = shapeQuotaView({
    snapshot: { codex: { sessionPct: 82 }, claude: { sessionPct: 40 } },
    sampledAt: SAMPLED,
    config: fakeConfig(),
    nowMs: NOW,
  });
  assert.equal(view.sampledAt, SAMPLED);
  assert.equal(view.warnPct, 75);
  assert.equal(view.exhaustedPct, 90);
  assert.deepEqual(
    view.pools.map((pool) => [pool.pool, pool.sessionPct, pool.state]),
    [["claude", 40, "ok"], ["codex", 82, "warn"]],
  );
  assert.ok(view.pools.every((pool) => pool.sampledAt === SAMPLED));
  assert.deepEqual(view.steers, [
    { slot: "A", profile: "codex-high", pool: "codex", advisor: false },
    { slot: "B", profile: "claude-sonnet", pool: "claude", advisor: false },
    { slot: "C", profile: "reviewer", pool: "claude", advisor: true },
  ]);
  assert.deepEqual(view.workers, [
    { position: 1, profile: "claude-sonnet", pool: "claude" },
    { position: 2, profile: "codex-high", pool: "codex" },
  ]);
});

test("quota view exhausts on session pct, weekly pct, or a future reset", () => {
  const view = shapeQuotaView({
    snapshot: {
      codex: { sessionPct: 95 },
      claude: { sessionPct: 10, weeklyPct: 91 },
      copilot: { sessionPct: 5, limitUntil: "2026-06-01T13:00:00.000Z" },
      muse: { sessionPct: 5, limitUntil: "2026-06-01T11:00:00.000Z" },
    },
    sampledAt: SAMPLED,
    config: fakeConfig(),
    nowMs: NOW,
  });
  const states = Object.fromEntries(view.pools.map((pool) => [pool.pool, pool.state]));
  assert.deepEqual(states, { codex: "exhausted", claude: "exhausted", copilot: "exhausted", muse: "ok" });
  assert.equal(view.pools.find((pool) => pool.pool === "claude").weeklyPct, 91);
  assert.equal(view.pools.find((pool) => pool.pool === "copilot").resetAt, "2026-06-01T13:00:00.000Z");
});

test("quota view tolerates a missing snapshot, pools wrapper, and missing thresholds", () => {
  const empty = shapeQuotaView({ snapshot: null, sampledAt: null, config: fakeConfig(), nowMs: NOW });
  assert.deepEqual(empty.pools, []);
  assert.equal(empty.sampledAt, null);
  assert.equal(empty.steers.length, 3);
  assert.equal(empty.workers.length, 2);
  const wrapped = shapeQuotaView({
    snapshot: { pools: { codex: { usedPct: 50 } } },
    sampledAt: SAMPLED,
    config: { ...fakeConfig(), quota: undefined },
    nowMs: NOW,
  });
  assert.deepEqual(wrapped.pools.map((pool) => [pool.pool, pool.sessionPct, pool.state]), [["codex", 50, "ok"]]);
  assert.equal(wrapped.warnPct, 75);
  assert.equal(wrapped.exhaustedPct, 90);
});

test("quota args take no scope, flags, or positionals", () => {
  assert.deepEqual(parseFactoryArgs("quota"), { command: "quota" });
  assert.throws(() => parseFactoryArgs("quota a/b"), /takes no arguments/);
  assert.throws(() => parseFactoryArgs("quota --brief"), /takes no flags/);
  assert.equal(FACTORY_COMMANDS.quota.usage, "/factory quota");
  assert.match(factoryHelp("quota"), /\/factory quota/);
  for (const example of FACTORY_COMMANDS.quota.examples) {
    assert.deepEqual(parseFactoryArgs(example.replace(/^\/factory /, "")), { command: "quota" });
  }
});

test("quota settings validation accepts boundaries and rejects bad numbers", () => {
  assert.deepEqual(validateQuotaSettings({ quota: { exhaustedPct: 100, warnPct: 0 }, quotaSampleMinutes: 10 }), []);
  assert.deepEqual(validateQuotaSettings(null), ["settings must be an object"]);
  const errors = validateQuotaSettings({ quota: { exhaustedPct: 101, warnPct: -1 }, quotaSampleMinutes: 9 });
  assert.match(JSON.stringify(errors), /quota\.exhaustedPct/);
  assert.match(JSON.stringify(errors), /quota\.warnPct/);
  assert.match(JSON.stringify(errors), /quotaSampleMinutes/);
  assert.match(
    JSON.stringify(validateQuotaSettings({ quota: { exhaustedPct: NaN, warnPct: 75 }, quotaSampleMinutes: 10.5 })),
    /quota\.exhaustedPct|quotaSampleMinutes/,
  );
});
