// Steer pill actions and their preview, apply and brief delivery contracts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const menu = await import("../client/steer-menu.ts");
const results = await import("../client/steer-results.ts");
const pill = await import("../client/steer-pill.ts");

test("one native activation press sends exactly one RPC even when the menu is rebuilt", async () => {
  const entry = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
  assert.match(entry, /case "activate":[\s\S]*?behavior: activationMenuBehavior\(/);
  const target = row("steer-b", { slot: "B", activationEpoch: 3 });
  const requests = [];
  const activate = async (input) => {
    requests.push(input);
    menu.activationMenuBehavior({ ...target, active: true }, 3, activate);
  };
  const behavior = menu.activationMenuBehavior(target, 3, activate);
  assert.equal(behavior.kind, "action");
  assert.deepEqual(requests, []);
  await behavior.onPress();
  assert.deepEqual(requests, [{ agentId: target.agentId, workspaceId: target.workspaceId, epoch: 3 }]);
});

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

function row(agentId, over = {}) {
  return {
    agentId,
    workspaceId: "wks_main",
    scopeId: "o/r",
    slot: "A",
    title: null,
    provider: "codex",
    model: "gpt-6.2-sol",
    liveStatus: "idle",
    advisor: false,
    active: false,
    permissionNeeded: false,
    stagedBrief: false,
    successor: null,
    state: "warm",
    warmth: "warm",
    tokens: 5000,
    large: false,
    limited: false,
    resetAt: null,
    resetUnknown: false,
    awaitingUpdate: false,
    quotaRows: [],
    headerFacts: ["Estimated"],
    primaryAction: "focus",
    detail: "Cache warm · cooling in 20m",
    nextBoundaryAt: null,
    ...over,
  };
}

const self = () => row("steer-a", { slot: "A", active: true });

// ---------------------------------------------------------------------------
// Handover targets
// ---------------------------------------------------------------------------

test("handover lists holders in slot order with provider and model", () => {
  const targets = menu.handoffTargets(
    [
      self(),
      row("steer-c", { slot: "C", provider: "claude", model: "m", state: "cooling" }),
      row("steer-b", { slot: "B", state: "warm" }),
    ],
    "steer-a",
  );
  assert.deepEqual(targets.map((t) => t.slot), ["A", "B", "C"]);
  assert.deepEqual(targets.map((t) => t.eligible), [false, true, true]);
  assert.equal(targets[2].provider, "claude");
  assert.equal(targets[2].model, "m");
});

test("handover needs the current tab and its scope", () => {
  assert.deepEqual(menu.handoffTargets([row("steer-b", { slot: "B" })], "steer-a"), []);
  assert.deepEqual(menu.handoffTargets([row("steer-a", { scopeId: null })], "steer-a"), []);
  // Foreign scopes are not listed.
  assert.deepEqual(
    menu.handoffTargets([
      self(), row("steer-x", { slot: "B", scopeId: "o/other" }), row("steer-y", { slot: "A", workspaceId: "wks_other" }),
    ], "steer-a").map((t) => t.slot),
    ["A"],
  );
});

test("handover reasons cover active, advisor, retired and ambiguous rows", () => {
  const targets = menu.handoffTargets(
    [
      self(),
      row("steer-b", { slot: "B", advisor: true }),
      row("steer-c", { slot: "C", state: "retired" }),
      row("steer-d1", { slot: "D" }),
      row("steer-d2", { slot: "D" }),
      row("steer-e", { slot: "E", state: "unknown", detail: "Membership ambiguous" }),
    ],
    "steer-a",
  );
  const byId = Object.fromEntries(targets.map((t) => [t.agentId, t]));
  assert.equal(byId["steer-a"].reason, "Already active");
  assert.equal(byId["steer-b"].reason, "Advisor steers never coordinate");
  assert.equal(byId["steer-c"].reason, "retired");
  assert.match(byId["steer-d1"].reason, /Ambiguous/);
  assert.match(byId["steer-d2"].reason, /Ambiguous/);
  assert.match(byId["steer-e"].reason, /Ambiguous membership \(Membership ambiguous\)/);
  for (const t of targets) assert.equal(t.eligible, false);
});

test("retired rows do not make a live destination ambiguous", () => {
  const targets = menu.handoffTargets([
    self(), row("old", { slot: "B", state: "retired" }), row("new", { slot: "B" }),
  ], "steer-a");
  assert.equal(targets.find((target) => target.agentId === "new").eligible, true);
  assert.equal(targets.find((target) => target.agentId === "old").reason, "retired");
});

test("handover reasons cover busy targets and pending permissions", () => {
  const targets = menu.handoffTargets(
    [
      self(),
      row("steer-b", { slot: "B", state: "running", liveStatus: "running" }),
      row("steer-c", { slot: "C", state: "waiting", detail: "Factory operation in progress" }),
      row("steer-d", { slot: "D", permissionNeeded: true }),
      row("steer-e", { slot: "E", liveStatus: "initializing", state: "waiting", detail: "Agent initializing" }),
    ],
    "steer-a",
  );
  const byId = Object.fromEntries(targets.map((t) => [t.agentId, t]));
  assert.equal(byId["steer-b"].reason, "Busy (turn running)");
  assert.equal(byId["steer-c"].reason, "Busy (Factory operation in progress)");
  assert.equal(byId["steer-d"].reason, "Permission request pending");
  assert.equal(byId["steer-e"].reason, "Busy (turn running)");
});

test("handover reasons cover depleted quota with reset details", () => {
  const targets = menu.handoffTargets(
    [
      self(),
      row("steer-b", { slot: "B", state: "limited", limited: true, resetAt: iso(NOW + 60 * MIN) }),
      row("steer-c", { slot: "C", state: "limited", limited: true, resetUnknown: true }),
    ],
    "steer-a",
  );
  const byId = Object.fromEntries(targets.map((t) => [t.agentId, t]));
  assert.equal(byId["steer-b"].eligible, false);
  assert.equal(byId["steer-b"].reason, "Quota depleted (waiting for reset)");
  assert.equal(byId["steer-c"].reason, "Quota depleted (reset unknown)");
});

test("a destination that needs recovery stays eligible with a recovery flag", () => {
  const [target] = menu.handoffTargets(
    [self(), row("steer-b", { slot: "B", state: "needs-resume" })],
    "steer-a",
  ).filter((t) => t.slot === "B");
  assert.equal(target.eligible, true);
  assert.equal(target.reason, null);
  assert.equal(target.needsRecovery, true);
});

// ---------------------------------------------------------------------------
// Reset eligibility
// ---------------------------------------------------------------------------

test("reset blocks busy tabs and incomplete membership", () => {
  for (const [state, reason] of [
    [{ state: "running" }, /running/],
    [{ liveStatus: "initializing" }, /running/],
    [{ state: "waiting", detail: "Factory operation in progress" }, /Factory operation in progress/],
    [{ permissionNeeded: true }, /permission/],
    [{ state: "retired" }, /replaced/],
    [{ state: "unknown", detail: "Membership ambiguous" }, /Membership ambiguous/],
    [{ scopeId: null }, /membership/],
  ]) {
    assert.match(menu.resetSteerBlock(row("a", state)), reason);
  }
  assert.equal(menu.resetSteerBlock(row("a", { state: "needs-resume" })), null);
});

// ---------------------------------------------------------------------------
// Staged delivery per the "Initialize new steer" setting
// ---------------------------------------------------------------------------

test("the setting normalizes to send, composer or later (default composer)", () => {
  assert.equal(menu.normalizeInitializeNewSteer("send"), "send");
  assert.equal(menu.normalizeInitializeNewSteer("composer"), "composer");
  assert.equal(menu.normalizeInitializeNewSteer("later"), "later");
  assert.equal(menu.normalizeInitializeNewSteer(undefined), "composer");
  assert.equal(menu.normalizeInitializeNewSteer("at-once"), "composer");
  assert.equal(menu.normalizeInitializeNewSteer(null), "composer");
  assert.equal(menu.INITIALIZE_NEW_STEER_DEFAULT, "composer");
});

test("composer staging replaces an empty prompt and appends to a draft", () => {
  assert.deepEqual(menu.stageComposerText("", "PACKET"), { method: "setPrompt", text: "PACKET" });
  assert.deepEqual(menu.stageComposerText("  \n ", "PACKET"), { method: "setPrompt", text: "PACKET" });
  assert.deepEqual(menu.stageComposerText("draft", "PACKET"), {
    method: "insertText",
    text: "\n\nPACKET",
  });
});

// ---------------------------------------------------------------------------
// Expired previews and partial applies
// ---------------------------------------------------------------------------

test("expired-preview detection matches every stale-confirmation error", () => {
  for (const message of [
    "Something changed since the switch preview (for example another switch or checkpoint). Run /factory switch again and confirm the new preview.",
    "Something changed since the fresh preview (for example another switch). Open the preview again and confirm the new one.",
    "Something changed since the checkpoint preview (steer state or the agent's answer). Run /factory checkpoint again and confirm the new preview.",
    "Something changed since the resume preview (steer state or checkpoint). Run /factory resume again and confirm the new preview.",
    "Steer state changed (expected A@3, found B@4); rerun the switch",
    "Steer state changed (expected A@3, found A@4); rerun the fresh command",
    "the scope moved on (epoch changed); run /factory resume again",
  ]) {
    assert.equal(menu.isExpiredPreviewError(new Error(message)), true, message);
    assert.equal(menu.isExpiredPreviewError(message), true, message);
  }
});

test("expired-preview detection rejects delivery and validation errors", () => {
  for (const message of [
    "Handover applied, but the brief did not go out: agent unreachable",
    "Steer B is running",
    "Steer B has several live agents (a1, a2); archive the retired one in Paseo, then rerun",
    "Unknown agent \"agt_nope\"",
    "",
  ]) {
    assert.equal(menu.isExpiredPreviewError(new Error(message)), false, message);
  }
  assert.equal(menu.isExpiredPreviewError(null), false);
  assert.equal(menu.isExpiredPreviewError(undefined), false);
});

// ---------------------------------------------------------------------------
// Per-agent results
// ---------------------------------------------------------------------------

test("result keys separate hosts and agents", () => {
  assert.equal(menu.steerResultKey("h1", "agt_a"), "h1::agt_a");
  assert.notEqual(menu.steerResultKey("h1", "agt_a"), menu.steerResultKey("h1", "agt_b"));
  assert.notEqual(menu.steerResultKey("h1", "agt_a"), menu.steerResultKey("h2", "agt_a"));
});

test("per-agent results store, notify and clear per key", () => {
  const first = { kind: "info", at: iso(NOW), text: "one" };
  const second = { kind: "info", at: iso(NOW), text: "two" };
  assert.equal(results.getSteerResult("h1", "agt_a"), null);
  let calls = 0;
  const stop = results.subscribeSteerResult("h1", "agt_a", () => {
    calls += 1;
  });
  results.setSteerResult("h1", "agt_a", first);
  results.setSteerResult("h1", "agt_b", second);
  assert.deepEqual(results.getSteerResult("h1", "agt_a"), first);
  assert.deepEqual(results.getSteerResult("h1", "agt_b"), second);
  assert.equal(calls, 1);
  results.clearSteerResult("h1", "agt_a");
  assert.equal(results.getSteerResult("h1", "agt_a"), null);
  assert.deepEqual(results.getSteerResult("h1", "agt_b"), second);
  assert.equal(calls, 2);
  stop();
  results.setSteerResult("h1", "agt_a", first);
  assert.equal(calls, 2);
  results.clearSteerResult("h1", "agt_a");
  results.clearSteerResult("h1", "agt_b");
});

test("the host registration defaults and updates", () => {
  assert.equal(typeof results.currentSteerHost(), "string");
  results.registerSteerHost("host-7");
  assert.equal(results.currentSteerHost(), "host-7");
  results.registerSteerHost("");
  assert.equal(results.currentSteerHost(), "host-7");
});

// ---------------------------------------------------------------------------
// Feed parsing for the new flags
// ---------------------------------------------------------------------------

test("steerRowsOf parses permission and staged-brief flags", () => {
  const [parsed] = pill.steerRowsOf({
    steers: [{ agentId: "a1", workspaceId: "w1", permissionNeeded: true, stagedBrief: true }],
  });
  assert.equal(parsed.permissionNeeded, true);
  assert.equal(parsed.stagedBrief, true);
  const [fallback] = pill.steerRowsOf({ steers: [{ agentId: "a1", workspaceId: "w1" }] });
  assert.equal(fallback.permissionNeeded, false);
  assert.equal(fallback.stagedBrief, false);
});

// ---------------------------------------------------------------------------
// Native menu descriptor
// ---------------------------------------------------------------------------

test("the active steer menu lists actions and leaf-only handover targets", () => {
  const active = { ...self(), stagedBrief: true };
  const warmup = row("steer-b", { slot: "B", state: "running", warmth: "cooling" });
  const recovery = row("steer-c", { slot: "C", state: "needs-resume", warmth: "cold", large: true });
  const items = menu.describeSteerMenu(active, [active, recovery, warmup]);
  assert.deepEqual(items.map((entry) => entry.title ?? entry.kind), [
    "Handover", "Reset Steer", "separator", "Open Factory",
  ]);
  const [handover, reset] = items;
  assert.equal(handover.disabled, false);
  assert.deepEqual(handover.targets, [
    { id: "handover-steer-b", title: "Steer B · cooling", icon: pill.faceFor(warmup).icon, slot: "B", agentId: "steer-b", disabled: true },
    { id: "handover-steer-c", title: "Steer C · large", icon: pill.faceFor(recovery).icon, slot: "C", agentId: "steer-c", disabled: false },
  ]);
  assert.deepEqual(reset, { kind: "reset", id: "reset", title: "Reset Steer", disabled: false, icon: "ListRestart" });
});

test("standby menus have a visible, disabled Handover with no submenu", () => {
  const standby = row("steer-b", { slot: "B", activationEpoch: 3, state: "needs-resume" });
  const items = menu.describeSteerMenu(standby, [self(), standby, row("steer-c", { slot: "C" })]);
  assert.deepEqual(items.map((entry) => entry.title ?? entry.kind), [
    "Activate Steer", "Handover", "Reset Steer", "separator", "Open Factory",
  ]);
  assert.deepEqual(items[1], {
    kind: "handover", id: "handover", title: "Handover", icon: "ArrowRightLeft", disabled: true, targets: [],
  });
});

test("activation offers the own standby at its observed epoch, and an active receipt offers retry", () => {
  const standby = row("steer-b", { slot: "B", activationEpoch: 3 });
  const activation = (own, others = []) => menu.describeSteerMenu(own, [own, ...others]).find((entry) => entry.kind === "activate");
  assert.deepEqual(activation(standby, [self()]), {
    kind: "activate", id: "activate", title: "Activate Steer", icon: "ArrowRight", disabled: false, activationEpoch: 3, quotaConfirmation: null, activationAlternatives: [],
  });
  assert.equal(activation(self(), [standby]), undefined);
  assert.equal(activation({ ...standby, advisor: true }), undefined);
  assert.equal(activation({ ...standby, state: "retired" }), undefined);
  assert.equal(activation({ ...standby, scopeId: null }), undefined);
  assert.equal(activation(standby, [row("duplicate-b", { slot: "B" })]).disabled, true);
  assert.equal(activation({ ...standby, permissionNeeded: true }).disabled, true);
  assert.equal(activation({ ...standby, active: true, state: "waiting" }).title, "Retry activation delivery");
  assert.deepEqual(activation(standby, [self(), row("steer-c", { slot: "C" })]).activationAlternatives, [
    { agentId: "steer-c", slot: "C" },
  ]);
});

test("depleted and unknown quota both leave Reset and Activate reachable with the right confirmation", () => {
  for (const quotaConfirmation of ["depleted", "unknown"]) {
    const own = row("steer-b", { slot: "B", active: false, activationEpoch: 3, quotaConfirmation,
      state: quotaConfirmation === "depleted" ? "limited" : "unknown", detail: "Not enough data" });
    const entries = menu.describeSteerMenu(own, [self(), own]);
    const activate = entries.find(({ kind }) => kind === "activate");
    assert.equal(activate.disabled, false);
    assert.equal(activate.quotaConfirmation, quotaConfirmation);
    assert.equal(entries.find(({ kind }) => kind === "reset").disabled, false);
    assert.match(menu.quotaConfirmationText(quotaConfirmation, own), new RegExp(`Quota is ${quotaConfirmation}`));
  }
});

test("Reset Steer states unknown quota in one exact sentence and keeps depleted wording", () => {
  assert.equal(menu.resetQuotaConfirmationText("unknown"), "Quota is unknown.");
  assert.match(menu.resetQuotaConfirmationText("depleted"), /^Quota is depleted\. The reset time is unknown\./);
});

test("unrelated target state changes do not rebuild the open menu", () => {
  const active = self();
  const standby = row("steer-b", { slot: "B" });
  const key = (state) => menu.menuKeyFor(menu.describeSteerMenu(active, [active, { ...standby, state }]));
  assert.equal(key("warm"), key("cooling"));
  assert.equal(key("warm"), key("needs-resume"));
  assert.notEqual(key("warm"), key("running"));
});

test("a Handover target previews and applies in one press with source and target identity checks", async () => {
  const active = self();
  const target = { agentId: "steer-b", slot: "B" };
  const calls = [];
  const plan = { workspaceId: active.workspaceId, fromId: active.agentId, toId: target.agentId, fingerprint: "switch-fingerprint" };
  const preview = async (input) => { calls.push(["preview", input]); return plan; };
  const apply = async (input) => { calls.push(["apply", input]); return { applied: true }; };
  assert.deepEqual(await menu.handoverSteer(active, target, "composer", preview, apply), { applied: true });
  const expected = { workspaceId: active.workspaceId, callerId: active.agentId, to: "B" };
  assert.deepEqual(calls, [
    ["preview", expected],
    ["apply", { ...expected, fingerprint: "switch-fingerprint", deliver: "stage" }],
  ]);
  for (const change of [{ fromId: "other" }, { toId: "replacement" }, { workspaceId: "other" }]) {
    await assert.rejects(menu.handoverSteer(active, target, "send",
      async () => ({ ...plan, ...change }), async () => assert.fail("stale handover applied")), /changed/);
  }
});

test("Reset saves the inverse of Clear chat history before applying its bound preview", async () => {
  const source = self();
  for (const clearChatHistory of [true, false]) {
    const calls = [];
    const plan = { workspaceId: source.workspaceId, from: source.agentId, slot: source.slot, fingerprint: "reset-fingerprint" };
    const result = { applied: true, refreshMode: clearChatHistory ? "rewind" : "new-agent" };
    const reset = await menu.resetSteer(source, clearChatHistory,
      async (keep) => { calls.push(["save", keep]); return "send"; },
      async (input) => { calls.push(["preview", input]); return plan; },
      async (input) => { calls.push(["apply", input]); return result; });
    const keepChatHistory = !clearChatHistory;
    const expected = { workspaceId: source.workspaceId, slot: source.slot, keepChatHistory };
    assert.deepEqual(calls, [
      ["preview", expected],
      ["save", keepChatHistory],
      ["apply", { ...expected, fingerprint: plan.fingerprint, deliver: "send", notifyPrevious: false }],
    ]);
    assert.deepEqual(reset, { result, initialize: "send" });
  }
});

test("Reset stops on a stale holder or a failed settings write", async () => {
  const source = self();
  const plan = { workspaceId: source.workspaceId, from: source.agentId, slot: source.slot, fingerprint: "reset-fingerprint" };
  const apply = async () => assert.fail("reset applied");
  await assert.rejects(menu.resetSteer(source, false, async () => assert.fail("settings written"),
    async () => ({ ...plan, from: "new-holder" }), apply), /steer changed/);
  await assert.rejects(menu.resetSteer(source, false, async () => { throw new Error("Settings unavailable"); },
    async () => plan, apply), /Settings unavailable/);
});

const menuSource = readFileSync(new URL("../client/steer-menu-content.tsx", import.meta.url), "utf8");
const entrySource = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");

test("the single confirmation popover prefills from the saved setting and Cancel closes it", () => {
  assert.match(menuSource, /choice \?\? \(state.status === "ready" && !state.values.keepChatHistory\)/);
  assert.match(menuSource, /accessibilityRole="checkbox"[\s\S]*?>Clear chat history</);
  assert.match(menuSource, /change\("history"\)\(\(current\) => \(\{ \.\.\.current, keepChatHistory \}\)\)/);
  assert.match(menuSource, /onPress=\{close\}[\s\S]*?>Cancel</);
  assert.match(menuSource, /onPress=\{\(\) => void confirmReset\(\)\}[\s\S]*?>Reset</);
});

test("Paseo receives one Reset popover and a submenu of direct Handover actions", () => {
  assert.equal([...entrySource.matchAll(/kind: "popover", Content: actions\./g)].length, 1);
  assert.match(entrySource, /case "reset":[\s\S]*?kind: "popover", Content: actions.reset/);
  assert.match(entrySource, /items: entry.targets.map[\s\S]*?kind: "action", onPress: \(\) => actions.handover/);
  assert.match(entrySource, /async handover[\s\S]*?reportSteerResult\(source, summary,/);
  assert.match(entrySource, /client.openPanel\("factory", \{ workspaceId, agentId \}\)/);
});
