// Plugin-runtime ZeroSub reader: pure unit tests with fake state. Never touches
// the live RPC: resolveZerosub is only exercised with values and injected
// suppliers, and the switch-row fixtures mirror upstream's SwitchRowSchema.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const runtime = await import("../server/zerosub-runtime.ts");
const {
  SWITCH_ROW_KIND,
  findZerosubSwitch,
  futureWakeAtMs,
  parseZerosubSwitchData,
  resolveZerosub,
  zerosubForkWarning,
  zerosubSwitchFollowup,
} = runtime;

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const RESET = "2026-11-24T15:00:00.000Z";

function switchData(overrides = {}) {
  return {
    family: "claude",
    from: "acc-old",
    to: "acc-new",
    reason: "limit",
    outcome: "switched",
    resetsAt: null,
    continued: true,
    continuedIn: null,
    toFamily: null,
    toProvider: null,
    detail: null,
    at: "2026-11-24T11:59:00.000Z",
    ...overrides,
  };
}

function switchEntry(data, itemOverrides = {}) {
  return {
    turnId: "t1",
    item: { type: "plugin", pluginId: "zerosub", kind: SWITCH_ROW_KIND, version: 1, data, ...itemOverrides },
  };
}

test("parse normalizes a switch row and tolerates sparse data", () => {
  assert.deepEqual(parseZerosubSwitchData(switchData()), {
    family: "claude",
    from: "acc-old",
    to: "acc-new",
    toFamily: null,
    at: "2026-11-24T11:59:00.000Z",
    reason: "limit",
    outcome: "switched",
    resetsAt: null,
    continued: true,
    continuedIn: null,
  });
  assert.equal(
    parseZerosubSwitchData(switchData({ continuedIn: { agentId: "agent-9", title: "Steer A" } })).continuedIn,
    "agent-9",
  );
  assert.equal(parseZerosubSwitchData(switchData({ continuedIn: "agent-9" })).continuedIn, "agent-9");
  assert.equal(parseZerosubSwitchData(switchData({ continued: "yes" })).continued, false);
  assert.equal(parseZerosubSwitchData(switchData({ from: "  acc-old  " })).from, "acc-old");
  assert.equal(parseZerosubSwitchData(switchData({ from: "   " })).from, null);
  assert.equal(parseZerosubSwitchData(switchData({ reason: "brand-new", family: "grok" })).reason, "brand-new");
  assert.equal(parseZerosubSwitchData({}).continued, false);
  for (const bad of [null, undefined, "zerosub-switch", 42, [], [{ reason: "x" }]]) {
    assert.equal(parseZerosubSwitchData(bad), null, `rejected: ${JSON.stringify(bad)}`);
  }
});

test("find returns the latest switch row and ignores other items", () => {
  const first = switchEntry(switchData({ reason: "limit", outcome: "switched" }));
  const last = switchEntry(switchData({ reason: "exhausted", outcome: "stayed", resetsAt: RESET, continued: false }));
  const entries = [
    { turnId: "t1", item: { type: "user_message", text: "do it" } },
    first,
    { turnId: "t1", item: { type: "plugin", pluginId: "other", kind: "other-kind", version: 1, data: switchData() } },
    { turnId: "t1", item: { type: "assistant_message", text: "done" } },
    last,
  ];
  const found = findZerosubSwitch(entries);
  assert.equal(found.reason, "exhausted");
  assert.equal(found.outcome, "stayed");
  assert.equal(found.resetsAt, RESET);
  assert.equal(found.continued, false);
  assert.equal(findZerosubSwitch(entries.slice(0, 4)).outcome, "switched");
  assert.equal(
    findZerosubSwitch([switchEntry(switchData(), { pluginId: "impostor" })]),
    null,
    "another plugin's kind does not match",
  );
  assert.equal(findZerosubSwitch([{ type: "plugin", kind: SWITCH_ROW_KIND, data: switchData() }]).reason, "limit");
  for (const bad of [null, undefined, {}, "x", [{ item: null }]]) {
    assert.equal(findZerosubSwitch(bad), null, `no row in ${JSON.stringify(bad)}`);
  }
});

test("follow-up: continued suppresses, exhausted+stayed proceeds at resetsAt", () => {
  assert.deepEqual(zerosubSwitchFollowup(null), {
    decision: "proceed",
    reason: "no-switch-signal",
    continuedIn: null,
    wakeAt: null,
  });
  assert.deepEqual(
    zerosubSwitchFollowup(parseZerosubSwitchData(switchData({ continued: true, continuedIn: { agentId: "agent-9", title: "t" } }))),
    { decision: "suppress", reason: "zerosub-continued", continuedIn: "agent-9", wakeAt: null },
  );
  assert.deepEqual(
    zerosubSwitchFollowup(parseZerosubSwitchData(switchData({ continued: true }))),
    { decision: "suppress", reason: "zerosub-continued", continuedIn: null, wakeAt: null },
  );
  assert.deepEqual(
    zerosubSwitchFollowup(
      parseZerosubSwitchData(switchData({ reason: "exhausted", outcome: "stayed", resetsAt: RESET, continued: false })),
    ),
    { decision: "proceed", reason: "no-account-free", continuedIn: null, wakeAt: RESET },
  );
  // continuedIn wins even over exhausted+stayed: follow the continuation.
  assert.deepEqual(
    zerosubSwitchFollowup(
      parseZerosubSwitchData(switchData({
        reason: "exhausted", outcome: "stayed", resetsAt: RESET, continued: false,
        continuedIn: { agentId: "agent-9", title: "t" },
      })),
    ),
    { decision: "suppress", reason: "zerosub-continued", continuedIn: "agent-9", wakeAt: null },
  );
  for (const data of [
    switchData({ reason: "limit", outcome: "switched", continued: false }),
    switchData({ reason: "exhausted", outcome: "continued", continued: false }),
    switchData({ reason: "manual", outcome: "stayed", continued: false }),
    {},
  ]) {
    const followup = zerosubSwitchFollowup(parseZerosubSwitchData(data));
    assert.equal(followup.decision, "proceed", JSON.stringify(data));
    assert.equal(followup.reason, "switch-no-action", JSON.stringify(data));
  }
});

test("fork warning fires only on cross-provider rows", () => {
  assert.equal(zerosubForkWarning(null), null);
  assert.equal(zerosubForkWarning(parseZerosubSwitchData(switchData())), null);
  const family = zerosubForkWarning(parseZerosubSwitchData(switchData({ toFamily: "codex" })));
  assert.match(family, /forked this chat to another provider/);
  assert.match(family, /the codex family/);
  assert.match(family, /CHECKPOINT handoff/);
  assert.match(family, /fork to other provider/);
});

test("futureWakeAtMs accepts only future stamps", () => {
  assert.equal(futureWakeAtMs(RESET, NOW), Date.parse(RESET));
  for (const bad of [null, undefined, "", "not-a-date", "2026-11-24T12:00:00.000Z", "2026-11-20T12:00:00.000Z", 42]) {
    assert.equal(futureWakeAtMs(bad, NOW), null, `rejected: ${JSON.stringify(bad)}`);
  }
});

test("resolveZerosub prefers the value and fails suppliers soft", async () => {
  const state = { accounts: [], agentAccount: {}, pending: {} };
  assert.equal(await resolveZerosub({ zerosub: state }), state);
  assert.equal(await resolveZerosub({ zerosub: null }), null);
  assert.equal(await resolveZerosub({ getZerosub: async () => state }), state);
  assert.equal(await resolveZerosub({ getZerosub: async () => null }), null);
  assert.equal(await resolveZerosub({ getZerosub: async () => { throw new Error("offline"); } }), null);
  assert.equal(await resolveZerosub({}), null);
});
