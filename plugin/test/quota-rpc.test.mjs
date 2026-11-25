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

test("quota view exhausts only on threshold, explicit limit, or limited status", () => {
  const FUTURE = "2026-06-01T13:00:00.000Z";
  const PAST = "2026-06-01T11:00:00.000Z";
  const cases = [
    ["session threshold", { sessionPct: 95 }, "exhausted"],
    ["weekly threshold", { sessionPct: 10, weeklyPct: 91 }, "exhausted"],
    ["explicit future limitUntil", { sessionPct: 5, limitUntil: FUTURE }, "exhausted"],
    ["explicit future limitedUntil", { sessionPct: 5, limitedUntil: FUTURE }, "exhausted"],
    ["limited status", { sessionPct: 5, status: "limited" }, "exhausted"],
    ["exhausted flag", { sessionPct: 5, exhausted: true }, "exhausted"],
    ["healthy pool with ordinary future reset", { sessionPct: 12, weeklyPct: 20, resetsAt: FUTURE }, "ok"],
    ["past limitUntil is not a hold", { sessionPct: 5, limitUntil: PAST }, "ok"],
    ["warn band", { sessionPct: 82 }, "warn"],
  ];
  const snapshot = Object.fromEntries(cases.map(([name, entry], index) => [`pool-${index}`, entry]));
  const view = shapeQuotaView({ snapshot, sampledAt: SAMPLED, config: fakeConfig(), nowMs: NOW });
  const states = Object.fromEntries(view.pools.map((pool) => [pool.pool, pool.state]));
  for (const [index, [name, , want]] of cases.entries()) {
    assert.equal(states[`pool-${index}`], want, name);
  }
  const healthy = view.pools.find((pool) => pool.pool === "pool-6");
  assert.equal(healthy.sessionPct, 12);
  assert.equal(healthy.weeklyPct, 20);
  assert.equal(healthy.resetAt, FUTURE);
  const limited = view.pools.find((pool) => pool.pool === "pool-2");
  assert.equal(limited.resetAt, FUTURE);
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
  assert.equal(wrapped.exhaustedPct, 95);
});

test("quota view lists ZeroSub accounts with warn states", () => {
  const view = shapeQuotaView({
    snapshot: null,
    sampledAt: null,
    config: fakeConfig(),
    nowMs: NOW,
    zerosub: {
      accounts: [
        { id: "acc-full", family: "claude", status: "active", limitedUntil: null, maxUsedPct: 99, exhausted: false, windows: [{ id: "five_hour", usedPct: 99, resetsAt: "2026-06-01T15:00:00.000Z" }] },
        { id: "acc-warn", family: "claude", status: "active", limitedUntil: null, maxUsedPct: 80, exhausted: false, windows: [] },
        { id: "acc-ok", family: "codex", status: "active", limitedUntil: null, maxUsedPct: 10, exhausted: false, windows: [] },
        { id: "", family: "claude", maxUsedPct: 99, windows: [] },
        null,
      ],
    },
  });
  assert.deepEqual(
    view.accounts.map((account) => [account.account, account.usedPct, account.state]),
    [["acc-full", 99, "exhausted"], ["acc-ok", 10, "ok"], ["acc-warn", 80, "warn"]],
  );
  assert.equal(view.accounts[0].family, "claude");
  assert.equal(view.accounts[0].resetsAt, "2026-06-01T15:00:00.000Z");
  assert.equal(view.accounts[1].resetsAt, null);
});

test("quota view ignores expired ZeroSub windows", () => {
  const view = shapeQuotaView({
    snapshot: null,
    sampledAt: null,
    config: fakeConfig(),
    nowMs: NOW,
    zerosub: {
      accounts: [
        { id: "acc-expired", family: "claude", status: "active", limitedUntil: null, maxUsedPct: 99, exhausted: false, windows: [{ id: "five_hour", usedPct: 99, resetsAt: "2026-06-01T11:00:00.000Z" }] },
        { id: "acc-current", family: "claude", status: "active", limitedUntil: null, maxUsedPct: 99, exhausted: false, windows: [{ id: "five_hour", usedPct: 99, resetsAt: "2026-06-01T15:00:00.000Z" }] },
        { id: "acc-mixed", family: "claude", status: "active", limitedUntil: null, maxUsedPct: 99, exhausted: false, windows: [{ id: "five_hour", usedPct: 99, resetsAt: "2026-06-01T11:00:00.000Z" }, { id: "seven_day", usedPct: 20, resetsAt: "2026-06-08T12:00:00.000Z" }] },
      ],
    },
  });
  assert.deepEqual(
    view.accounts.map((account) => [account.account, account.usedPct, account.state]),
    [["acc-current", 99, "exhausted"], ["acc-expired", null, "ok"], ["acc-mixed", 20, "ok"]],
  );
  assert.equal(view.accounts.find((account) => account.account === "acc-expired").resetsAt, null);
});

test("quota view has no accounts without ZeroSub", () => {
  const view = shapeQuotaView({ snapshot: null, sampledAt: null, config: fakeConfig(), nowMs: NOW });
  assert.deepEqual(view.accounts, []);
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
  assert.deepEqual(validateQuotaSettings({ quota: { exhaustedPct: 100, warnPct: 0 } }), []);
  assert.deepEqual(validateQuotaSettings(null), ["settings must be an object"]);
  const errors = validateQuotaSettings({ quota: { exhaustedPct: 101, warnPct: -1 } });
  assert.match(JSON.stringify(errors), /quota\.exhaustedPct/);
  assert.match(JSON.stringify(errors), /quota\.warnPct/);
  assert.match(
    JSON.stringify(validateQuotaSettings({ quota: { exhaustedPct: NaN, warnPct: 75 } })),
    /quota\.exhaustedPct/,
  );
});
