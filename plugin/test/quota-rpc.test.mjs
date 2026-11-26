import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./ts-resolve-hooks.mjs", import.meta.url);
const { shapeQuotaView } = await import("../server/quota-rpc.ts");
const { shapeWorkspaceResources } = await import("../server/resources-rpc.ts");
const { parseFactoryArgs, FACTORY_COMMANDS, factoryHelp } = await import("../shared/factory-args.ts");
const { validateQuotaSettings } = await import("../shared/settings-validate.ts");
import { parseUsageJson } from "../server/core/quota.mjs";
import { normalizeZerosubState } from "../server/core/zerosub.mjs";

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
  assert.equal(wrapped.warnPct, 93);
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
        { id: "api", label: "API testing", family: "codex", auth: "api", status: "ready", windows: [] },
        { id: "", family: "claude", maxUsedPct: 99, windows: [] },
        null,
      ],
    },
  });
  assert.deepEqual(
    view.accounts.map((account) => [account.account, account.usedPct, account.state]),
    [["acc-full", 99, "exhausted"], ["acc-ok", 10, "ok"], ["acc-warn", 80, "warn"], ["api", null, "unknown"]],
  );
  assert.equal(view.accounts.find((row) => row.account === "api").label, "API testing");
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
    [["acc-current", 99, "exhausted"], ["acc-expired", null, "unknown"], ["acc-mixed", 20, "ok"]],
  );
  assert.equal(view.accounts.find((account) => account.account === "acc-expired").resetsAt, null);
});

test("quota view has no accounts without ZeroSub", () => {
  const view = shapeQuotaView({ snapshot: null, sampledAt: null, config: fakeConfig(), nowMs: NOW });
  assert.deepEqual(view.accounts, []);
});

test("workspace Resources exposes current, stale and unavailable provider and account windows", () => {
  const pastReset = "2026-06-01T11:59:00.000Z";
  const futureReset = "2026-06-01T15:00:00.000Z";
  const weekReset = "2026-06-08T12:00:00.000Z";
  const olderSample = "2026-06-01T11:35:00.000Z";
  const snapshot = parseUsageJson([{ sourceId: "codex", report: { windows: [
    { id: "5h", usedPct: 99, resetsAt: pastReset },
    { id: "weekly", usedPct: 0, resetsAt: weekReset },
  ] } }]);
  const zerosub = normalizeZerosubState({ accounts: [
    { id: "a-current", family: "claude", auth: "subscription", usage: { fetchedAt: SAMPLED, windows: [
      { id: "five_hour", usedPercent: 98, resetsAt: pastReset },
      { id: "seven_day_sonnet", usedPercent: 20, resetsAt: futureReset },
      { id: "model-only", model: "opus", usedPercent: 50, resetsAt: futureReset },
    ] } },
    { id: "b-old", family: "claude", limitedUntil: weekReset, usage: { fetchedAt: olderSample, windows: [
      { id: "5h", usedPercent: 70, resetsAt: futureReset },
    ] } },
    { id: "c-unknown", family: "claude", auth: "api", usage: { windows: [{ id: "5h", usedPercent: 11 }] } },
  ] }, { now: NOW });
  const input = {
    workspaceId: "wks_app", config: fakeConfig(), nowMs: NOW, agents: [], snapshot, zerosub,
    quotaSampledAt: Date.parse(SAMPLED), repoPublic: null, selectedIndex: null, selectedAccount: null, exclusions: new Map(),
  };
  const view = shapeWorkspaceResources(input);
  const windowState = ({ state, usedPct, resetsAt }) => [state, usedPct, resetsAt];
  assert.deepEqual(view.pools.find(({ provider }) => provider === "codex").windows.map(windowState), [
    ["stale", null, pastReset], ["available", 0, weekReset],
  ]);
  assert.deepEqual(view.pools.find(({ provider }) => provider === "claude").windows.map(windowState), [
    ["unavailable", null, null], ["unavailable", null, null],
  ]);
  assert.deepEqual(view.accounts.map(({ windows }) => windows.map(windowState)), [
    [["stale", null, pastReset], ["available", 20, futureReset]],
    [["stale", null, futureReset]],
    [["unavailable", null, null]],
  ]);
  assert.deepEqual(view.accounts.map(({ alias, windows }) => [alias, windows.map((item) => item.alias)]), [
    ["Subscription 1", ["5-hour", "Sonnet weekly"]],
    ["Account 2", ["5-hour"]],
    ["API account 3", ["5-hour"]],
  ]);
  assert.ok(view.pools.every(({ alias }) => alias === "Provider pool"));
  assert.deepEqual(view.accounts.map(({ limited, limitedUntil }) => [limited, limitedUntil]), [
    [false, null], [true, weekReset], [false, null],
  ]);
  assert.equal(view.quotaSampleMinutes, 10);
  assert.equal(view.zeroSubState, "available");

  const old = shapeWorkspaceResources({ ...input, quotaSampledAt: Date.parse(olderSample), zerosub: null });
  assert.equal(old.pools.find(({ provider }) => provider === "codex").windows[1].state, "stale");
  assert.deepEqual(old.accounts, []);
  assert.equal(old.zeroSubState, "unavailable");

  const cached = parseUsageJson([{ sourceId: "codex", fetchedAt: SAMPLED, lastSuccessful: {
    fetchedAt: olderSample, report: { windows: [{ id: "5h", usedPct: 90, resetsAt: futureReset }] },
  } }]);
  const retained = shapeWorkspaceResources({ ...input, snapshot: cached });
  assert.deepEqual(retained.pools.find(({ provider }) => provider === "codex").windows[0], {
    alias: "Session", state: "stale", usedPct: null, sampledAt: olderSample, resetsAt: futureReset,
  });
  const timeless = parseUsageJson([{ sourceId: "codex", fetchedAt: SAMPLED, lastSuccessful: {
    report: { windows: [{ id: "5h", usedPct: 90, resetsAt: futureReset }] },
  } }]);
  const uncertain = shapeWorkspaceResources({ ...input, snapshot: timeless });
  assert.equal(uncertain.pools.find(({ provider }) => provider === "codex").windows[0].state, "unavailable");

  const slowerCadence = shapeWorkspaceResources({ ...input, quotaSampledAt: Date.parse(olderSample), quotaSampleMinutes: 15 });
  assert.equal(slowerCadence.quotaSampleMinutes, 15);
  assert.equal(slowerCadence.pools.find(({ provider }) => provider === "codex").windows[1].state, "available");
  assert.equal(slowerCadence.accounts[1].windows[0].state, "available");
  assert.deepEqual(shapeQuotaView({ ...input, sampledAt: SAMPLED }).pools[0], {
    pool: "codex", sessionPct: 99, weeklyPct: 0, resetAt: pastReset, sampledAt: SAMPLED, state: "exhausted",
  });
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
