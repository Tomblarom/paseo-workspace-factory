// Step-3 menu logic: handover targets with unavailable-row reasons, safe
// resume/refresh route selection, staged delivery per the "Initialize new
// steer" setting, expired-preview detection, per-agent results and the
// Open-Factory bridge. Pure modules only; no sends, no daemon.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const menu = await import("../client/steer-menu.ts");
const results = await import("../client/steer-results.ts");
const nav = await import("../client/steer-nav.ts");
const pill = await import("../client/steer-pill.ts");

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
// Labels
// ---------------------------------------------------------------------------

test("menu labels are English", () => {
  for (const [key, value] of Object.entries(menu.STEER_MENU_LABELS)) {
    assert.match(value, /^[\x20-\x7E…‹→·]+$/, `label is English: ${key}=${value}`);
  }
  assert.equal(menu.resumeActionLabel("needs-resume"), "Resume…");
  assert.equal(menu.resumeActionLabel("warm"), "Refresh context…");
  assert.equal(menu.resumeActionLabel("cold"), "Refresh context…");
});

// ---------------------------------------------------------------------------
// Handover targets
// ---------------------------------------------------------------------------

test("handover lists holders in slot order with state, provider and model", () => {
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
  assert.equal(targets[1].stateLabel, "warm");
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
  assert.equal(byId["steer-d"].permissionNeeded, true);
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
  assert.equal(byId["steer-b"].limited, true);
  assert.equal(byId["steer-c"].reason, "Quota depleted (reset unknown)");
  assert.equal(byId["steer-c"].resetUnknown, true);
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
// Resume / refresh route selection
// ---------------------------------------------------------------------------

test("resume refuses busy, waiting and replaced tabs", () => {
  assert.deepEqual(
    menu.resumeRouteFor(row("a", { state: "running", liveStatus: "running" }), { keepChatHistory: false }),
    { kind: "blocked", reason: "This steer is running. Wait for the turn to end, then refresh." },
  );
  assert.equal(
    menu.resumeRouteFor(row("a", { liveStatus: "initializing", state: "waiting", detail: "Agent initializing" }), { keepChatHistory: false }).kind,
    "blocked",
  );
  assert.deepEqual(
    menu.resumeRouteFor(row("a", { state: "waiting", detail: "Factory operation in progress" }), { keepChatHistory: false }),
    { kind: "blocked", reason: "Busy (Factory operation in progress). Try again after it finishes." },
  );
  assert.equal(
    menu.resumeRouteFor(row("a", { state: "retired" }), { keepChatHistory: false }).kind,
    "blocked",
  );
  assert.match(
    menu.resumeRouteFor(row("a", { state: "unknown", detail: "Membership ambiguous" }), { keepChatHistory: false }).reason,
    /Membership ambiguous/,
  );
});

test("resume refuses a pending permission before anything else unsafe", () => {
  assert.deepEqual(
    menu.resumeRouteFor(row("a", { permissionNeeded: true }), { keepChatHistory: false }),
    { kind: "blocked", reason: "A permission request is waiting. Answer it first, then refresh." },
  );
});

test("resume on depleted quota shows reset details instead of refreshing", () => {
  assert.deepEqual(
    menu.resumeRouteFor(row("a", { state: "limited", limited: true }), { keepChatHistory: false }),
    { kind: "reset-details" },
  );
});

test("resume uses the verified in-place clear for Claude", () => {
  assert.deepEqual(
    menu.resumeRouteFor(row("a", { provider: "claude", state: "needs-resume" }), { keepChatHistory: false }),
    { kind: "resume-apply" },
  );
  assert.deepEqual(
    menu.resumeRouteFor(row("a", { provider: "claude", state: "large" }), {
      keepChatHistory: false,
      clearProviders: ["claude", "other"],
    }),
    { kind: "resume-apply" },
  );
});

test("resume with Keep chat history rewinds instead of clearing", () => {
  assert.deepEqual(
    menu.resumeRouteFor(row("a", { provider: "claude" }), { keepChatHistory: true }),
    { kind: "fresh", note: "Keep chat history is on, so refresh rewinds instead of clearing." },
  );
});

test("a Codex refresh always rewinds and says so", () => {
  for (const keepChatHistory of [false, true]) {
    assert.deepEqual(
      menu.resumeRouteFor(row("a", { provider: "codex", state: "needs-resume" }), { keepChatHistory }),
      { kind: "fresh", note: "Codex has no native clear, so refresh rewinds the chat." },
    );
  }
});

test("providers without a verified clear go through fresh planning", () => {
  assert.deepEqual(
    menu.resumeRouteFor(row("a", { provider: "mystery" }), { keepChatHistory: false }),
    {
      kind: "fresh",
      note: "This provider has no verified in-place clear, so refresh rewinds or replaces the tab.",
    },
  );
  assert.equal(
    menu.resumeRouteFor(row("a", { provider: null }), { keepChatHistory: false }).kind,
    "fresh",
  );
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

test("partial apply with a staged packet offers a retry", () => {
  assert.equal(menu.needsDeliveryRetry({ applied: true, delivered: false, staged: true }), true);
  assert.equal(menu.needsDeliveryRetry({ applied: true, delivered: true, staged: true }), false);
  assert.equal(menu.needsDeliveryRetry({ applied: true, delivered: false, staged: false }), false);
  assert.equal(menu.needsDeliveryRetry({ applied: true, delivered: false }), false);
  assert.equal(menu.needsDeliveryRetry({ applied: false, delivered: false, staged: true }), false);
});

// ---------------------------------------------------------------------------
// Per-agent results and navigation
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

test("the Open-Factory bridge fans out and unsubscribes", () => {
  const seen = [];
  const stop = nav.subscribeOpenFactory((target) => seen.push(target));
  nav.requestOpenFactory({ workspaceId: "wks_1", agentId: "agt_a" });
  assert.deepEqual(seen, [{ workspaceId: "wks_1", agentId: "agt_a" }]);
  stop();
  nav.requestOpenFactory({ workspaceId: "wks_1" });
  assert.equal(seen.length, 1);
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

test("state words are lowercase in labels and titles", () => {
  assert.equal(menu.stateWord("waiting"), "waiting");
  assert.equal(menu.stateWord("needs-resume"), "needs resume");
  assert.equal(menu.stateWord("warm"), "warm");
  assert.equal(menu.stateWord("unknown"), "unknown");
});

test("the menu lists actions with a handover submenu and a settings item", () => {
  const items = menu.describeSteerMenu(
    self(),
    [self(), row("steer-b", { slot: "B", state: "warm" }), row("steer-c", { slot: "C", state: "cooling" })],
    { keepChatHistory: false, observedChanged: false, revertAllowed: false },
  );
  const ids = items.map((entry) => entry.id);
  assert.deepEqual(ids, ["create", "handover", "refresh", "settings", "sep-open", "open-factory"]);
  const handover = items.find((entry) => entry.id === "handover");
  assert.equal(handover.kind, "item");
  assert.deepEqual(
    handover.submenu.map((entry) => entry.title),
    ["Steer A · warm — Already active", "Steer B · warm", "Steer C · cooling"],
  );
  assert.deepEqual(handover.submenu.map((entry) => entry.disabled), [true, false, false]);
  const refresh = items.find((entry) => entry.id === "refresh");
  assert.equal(refresh.title, "Refresh context…");
  assert.equal(refresh.disabled, undefined);
  const settingsItem = items.find((entry) => entry.id === "settings");
  assert.equal(settingsItem.title, "Change settings…");
});

test("activation offers the own standby at its observed epoch, and an active receipt offers retry", () => {
  const standby = row("steer-b", { slot: "B", activationEpoch: 3 });
  const activation = (own, others = []) => menu.describeSteerMenu(own, [own, ...others], {
    keepChatHistory: false, observedChanged: false, revertAllowed: false,
  }).find((entry) => entry.action === "activate");
  assert.deepEqual(activation(standby, [self()]), {
    kind: "item", id: "activate", title: "Activate Steer", icon: "ArrowRight", action: "activate", disabled: false, activationEpoch: 3,
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

test("unavailable handover holders carry the short reason in the title", () => {
  const items = menu.describeSteerMenu(
    self(),
    [
      self(),
      row("steer-b", { slot: "B", state: "running", liveStatus: "running" }),
      row("steer-c", { slot: "C", state: "limited", limited: true, resetUnknown: true }),
    ],
    { keepChatHistory: false, observedChanged: false, revertAllowed: false },
  );
  const handover = items.find((entry) => entry.id === "handover");
  assert.deepEqual(
    handover.submenu.map((entry) => entry.title),
    [
      "Steer A · warm — Already active",
      "Steer B · running — Busy (turn running)",
      "Steer C · limited — Quota depleted (reset unknown)",
    ],
  );
});

test("settings changes disable with a short reason under Maximum efficiency", () => {
  const locked = menu.describeSteerMenu(
    row("steer-a", { slot: "A", active: true, settingsLocked: true, settingsLockReason: "Maximum efficiency protects this warm context. Use Refresh." }),
    [row("steer-a", { slot: "A", active: true })],
    { keepChatHistory: false, observedChanged: false, revertAllowed: false },
  );
  const settingsItem = locked.find((entry) => entry.id === "settings");
  assert.equal(settingsItem.disabled, true);
  assert.equal(settingsItem.title, "Change settings… (maximum efficiency)");
});

test("the warning adds revert and fresh-context items first", () => {
  const items = menu.describeSteerMenu(
    self(),
    [self()],
    { keepChatHistory: false, observedChanged: true, revertAllowed: true },
  );
  assert.deepEqual(items.slice(0, 3).map((entry) => entry.id), ["revert-settings", "fresh-context", "sep-warning"]);
  assert.equal(items[0].disabled, false);
  const blocked = menu.describeSteerMenu(
    self(),
    [self()],
    { keepChatHistory: false, observedChanged: true, revertAllowed: false, revertReason: "Settings changed again. Review before reverting." },
  );
  assert.equal(blocked[0].disabled, true);
  assert.equal(blocked[0].title, "Revert settings (changed again)");
});

test("a staged brief adds its own item, refresh disables while busy", () => {
  const staged = menu.describeSteerMenu(
    row("steer-a", { slot: "A", active: true, stagedBrief: true }),
    [row("steer-a", { slot: "A", active: true, stagedBrief: true })],
    { keepChatHistory: false, observedChanged: false, revertAllowed: false },
  );
  assert.ok(staged.some((entry) => entry.id === "staged"));
  const busy = menu.describeSteerMenu(
    row("steer-a", { slot: "A", active: true, state: "running", liveStatus: "running" }),
    [row("steer-a", { slot: "A", active: true })],
    { keepChatHistory: false, observedChanged: false, revertAllowed: false },
  );
  const refresh = busy.find((entry) => entry.id === "refresh");
  assert.equal(refresh.disabled, true);
  assert.match(refresh.title, /turn running/);
});

test("menu keys stay stable for identical descriptors", () => {
  const opts = { keepChatHistory: false, observedChanged: false, revertAllowed: false };
  const rows = [self(), row("steer-b", { slot: "B" })];
  assert.equal(menu.menuKeyFor(menu.describeSteerMenu(self(), rows, opts)), menu.menuKeyFor(menu.describeSteerMenu(self(), rows, opts)));
  assert.notEqual(
    menu.menuKeyFor(menu.describeSteerMenu(self(), rows, opts)),
    menu.menuKeyFor(menu.describeSteerMenu(self(), rows, { ...opts, observedChanged: true, revertAllowed: true })),
  );
});

// ---------------------------------------------------------------------------
// Wiring (static)
// ---------------------------------------------------------------------------

const menuSource = readFileSync(new URL("../client/steer-menu-content.tsx", import.meta.url), "utf8");
const entrySource = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");

test("the menu calls the /factory preview/apply RPCs and stages efficiently", () => {
  for (const token of [
    "factorySteerAddPreview",
    "factorySteerAdd",
    "factorySwitchPreview",
    "factorySwitch",
    "factoryResume",
    "factoryResumeApply",
    "factoryFreshPreview",
    "factoryFresh",
    "factorySteerBrief",
    "factoryHistoryOpen",
    "factorySteerSettingsPreview",
    "factorySteerSettings",
    "factorySteerSettingsRevert",
    "notifyPrevious: false",
    "deliver",
    "isExpiredPreviewError",
    "useComposers({ agentId:",
    "transferStagedBrief(callBrief, target, composer, attempt, automatic)",
    "initialAction",
    "resumeRouteFor",
  ]) {
    assert.ok(menuSource.includes(token), `steer-menu-content.tsx contains ${token}`);
  }
});

test("waiting for a composer has no timer-driven delivery", () => {
  assert.doesNotMatch(menuSource, /setTimeout/);
  assert.match(menuSource, /pendingComposer && postStage && destComposer && !busy/);
});

test("the entry builds the native menu and opens the Factory panel on request", () => {
  for (const token of [
    "subscribeOpenFactory",
    "requestOpenFactory",
    'client.openPanel("factory"',
    "buildSteerMenuBehavior",
    "describeSteerMenu",
    'kind: "menu"',
    'kind: "popover"',
  ]) {
    assert.ok(entrySource.includes(token), `index.client.tsx contains ${token}`);
  }
});
