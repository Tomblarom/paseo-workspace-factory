// Step-2 tests for the persistent steer composer pill: feed parsing, the
// collapsed face (label, title, icon, color), stable registration (no
// re-register churn), reconnect/teardown, countdown ticks that keep an open
// confirmation, coexistence with the worker-attention and result pills,
// discovery pagination, and the offline-testable aria/rendering contract.
//
// Manual checks (need a running Paseo host with the factory installed):
// - Keyboard: Tab reaches the steer pill, Enter/Space opens the menu, arrows
//   move through the direct Handover items. Enter on Reset Steer opens the
//   Factory dialog. Tab to Cancel and press Space to dismiss it without a
//   rewind. Switch back to the steer tab and reopen to test Escape, then
//   reopen again, Tab to Reset and press Enter to apply the previewed rewind.
// - Screen reader: the pill announces slot, role and state
//   ("Steer A · Active · warm …"); menu items name their action.
// - Compact layout: narrow window keeps face and menu readable; long
//   popover content scrolls.
// - Light/dark: face and menu follow the host theme in both appearances.
// - Desktop host menu with the ZeroSub pill visible: no overlap, overflow
//   handled; steer, worker-attention and result pills coexist.
// - Copies: no German strings, state words lowercase, hover titles break
//   after the state.
// - Reconnect: restart the daemon; pills show unknown, then restore.
// - History-only tab (no composer): no pill, the Factory panel still opens.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const pill = await import("../client/steer-pill.ts");
const { collectSteerStates } = await import("../server/steer-feed.ts");
const { CLEANUP_DEFAULTS } = await import("../shared/idle-cleanup.ts");
const { readPaseoState, LABEL } = await import("../server/core/paseo.mjs");

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
    active: true,
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
    thinking: null,
    speed: null,
    sessionId: null,
    ...over,
  };
}

/** Stable menu builder stub: one key per agent. */
function stubMenu(row) {
  return {
    behavior: { kind: "menu", items: [] },
    menuKey: row.agentId,
  };
}

function fakeClient(fail = {}) {
  const addThrows = fail.addThrowsFor ?? new Set();
  const updateThrows = fail.updateThrowsFor ?? new Set();
  const removeThrows = fail.removeThrowsFor ?? new Set();
  const calls = [];
  const regs = new Map();
  return {
    calls,
    regs,
    addThrows,
    updateThrows,
    removeThrows,
    addComposerPill(contribution) {
      calls.push(["add", contribution.id, contribution.agentId]);
      if (addThrows.has(contribution.agentId)) throw new Error("no composer");
      const reg = {
        update(patch) {
          calls.push(["update", contribution.agentId, { ...patch }]);
          if (updateThrows.has(contribution.agentId)) throw new Error("gone");
        },
        remove() {
          calls.push(["remove", contribution.agentId]);
          if (removeThrows.has(contribution.agentId)) throw new Error("gone");
        },
      };
      regs.set(contribution.agentId, { contribution, reg });
      return reg;
    },
  };
}

const kinds = (calls) => calls.map(([kind]) => kind);

// ---------------------------------------------------------------------------
// Feed parsing
// ---------------------------------------------------------------------------

test("steerRowsOf parses factory.steers events and skips untargeted rows", () => {
  assert.deepEqual(pill.steerRowsOf(null), []);
  assert.deepEqual(pill.steerRowsOf({}), []);
  assert.deepEqual(pill.steerRowsOf({ steers: "nope" }), []);
  const rows = pill.steerRowsOf({
    steers: [
      { agentId: "a1", workspaceId: "w1", slot: "A", state: "warm" },
      { agentId: "", workspaceId: "w1" },
      { workspaceId: "w1" },
      { agentId: "a2" },
      null,
    ],
    updatedAt: iso(NOW),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentId, "a1");
  assert.equal(rows[0].state, "warm");
  assert.equal(rows[0].primaryAction, "reload-or-open");
  assert.deepEqual(rows[0].quotaRows, []);
});

test("steerRowsOf falls back on invalid state, action and quota shapes", () => {
  const [parsed] = pill.steerRowsOf({
    steers: [
      {
        agentId: "a1",
        workspaceId: "w1",
        state: "melting",
        primaryAction: "launch",
        quotaRows: [{ id: "5h", scope: "model", usedPct: 54, resetsAt: iso(NOW + MIN), stale: false }, null],
        headerFacts: ["Estimated", 42, ""],
        tokens: Number.NaN,
      },
    ],
  });
  assert.equal(parsed.state, "unknown");
  assert.equal(parsed.primaryAction, "reload-or-open");
  assert.deepEqual(parsed.quotaRows, [
    { id: "5h", scope: "model", usedPct: 54, resetsAt: iso(NOW + MIN), stale: false },
  ]);
  assert.deepEqual(parsed.headerFacts, ["Estimated"]);
  assert.equal(parsed.tokens, null);
});

test("steerRowsOf parses runtime settings for the Factory panel", () => {
  const [parsed] = pill.steerRowsOf({
    steers: [{
      agentId: "a1",
      workspaceId: "w1",
      thinking: "high",
      speed: "flex",
      sessionId: "sess-1",
    }],
  });
  assert.equal(parsed.thinking, "high");
  assert.equal(parsed.speed, "flex");
  assert.equal(parsed.sessionId, "sess-1");
  const [fallback] = pill.steerRowsOf({ steers: [{ agentId: "a1", workspaceId: "w1" }] });
  assert.equal(fallback.thinking, null);
});

test("steerAgentIds collects covered tabs for the attention filter", () => {
  assert.deepEqual(
    [...pill.steerAgentIds([row("a1"), row("a2", { slot: "B" })])].sort(),
    ["a1", "a2"],
  );
});

// ---------------------------------------------------------------------------
// Collapsed face
// ---------------------------------------------------------------------------

test("collapsed face shows slot and state with role, context and quota", () => {
  const face = pill.faceFor(row("a1"));
  assert.equal(face.label, "A · warm");
  assert.equal(face.title, "Steer A · Active · warm\n5,000 tokens");
  assert.equal(face.icon, "Flame");
  assert.equal(face.accessibilityLabel, "Steer A · Active · warm · 5,000 tokens");
});

test("face title covers limited, awaiting and percent quota states", () => {
  const limited = pill.faceFor(
    row("b", { slot: "B", active: false, state: "limited", tokens: null, limited: true }),
  );
  assert.equal(limited.label, "B · warm");
  assert.equal(limited.title, "Steer B · Standby · limited");
  assert.equal(limited.icon, "Flame");
  assert.equal(
    pill.faceFor(row("c", { awaitingUpdate: true, tokens: null })).title,
    "Steer A · Active · warm\nAwaiting quota update",
  );
  assert.equal(
    pill.faceFor(
      row("d", {
        tokens: null,
        quotaRows: [
          { id: "5h", scope: "account", usedPct: 54, resetsAt: null, stale: false },
          { id: "7d", scope: "account", usedPct: 90, resetsAt: null, stale: true },
        ],
      }),
    ).title,
    "Steer A · Active · warm\n54% used",
  );
  assert.equal(
    pill.faceFor(row("e", { tokens: 42117, quotaRows: [{ id: "5h", scope: "account", usedPct: 12, resetsAt: null, stale: false }] })).title,
    "Steer A · Active · warm\n42,117 tokens · 12% used",
  );
});

test("face falls back for missing slot and unknown state", () => {
  const face = pill.faceFor(row("x", { slot: null, state: "unknown", warmth: "unknown", tokens: null }));
  assert.equal(face.label, "? · unknown");
  assert.equal(face.title, "Steer ? · Active · unknown");
  assert.equal(face.icon, "CircleHelp");
  assert.equal(pill.sameFace(face, pill.faceFor(row("x", { slot: null, state: "unknown", warmth: "unknown", tokens: null }))), true);
  assert.equal(pill.sameFace(face, pill.faceFor(row("x"))), false);
});

test("the recovery state stays in the tooltip while the pill keeps the context label and icon", () => {
  const face = pill.faceFor(row("c", { slot: "C", state: "needs-resume" }));
  assert.equal(face.label, "C · warm");
  assert.equal(face.title, "Steer C · Active · needs resume\n5,000 tokens");
  assert.equal(face.icon, "Flame");
  assert.equal(face.accessibilityLabel, "Steer C · Active · needs resume · 5,000 tokens");
});

test("face icons pin one Lucide name per state-table row", () => {
  assert.deepEqual(pill.STEER_PILL_ICONS, {
    running: "Activity",
    limited: "Gauge",
    waiting: "Clock",
    "needs-resume": "RotateCcw",
    ready: "CircleCheck",
    cold: "Snowflake",
    large: "Layers",
    cooling: "Timer",
    warm: "Flame",
    unknown: "CircleHelp",
  });
});

test("face colors come from the host theme, cold turns warning when large", () => {
  const theme = {
    colors: {
      surface0: "s0",
      surface1: "s1",
      surface2: "s2",
      border: "b",
      foreground: "fg",
      foregroundMuted: "muted",
      accent: "acc",
      accentForeground: "af",
      statusSuccess: "ok",
      statusWarning: "warn",
      statusDanger: "bad",
    },
  };
  const color = (state, large = false) => pill.steerStateColor(theme, state, large);
  assert.equal(color("running"), "acc");
  assert.equal(color("limited"), "bad");
  assert.equal(color("waiting"), "muted");
  assert.equal(color("needs-resume"), "warn");
  assert.equal(color("ready"), "ok");
  assert.equal(color("cold"), "muted");
  assert.equal(color("cold", true), "warn");
  assert.equal(color("large"), "warn");
  assert.equal(color("cooling"), "warn");
  assert.equal(color("warm"), "ok");
  assert.equal(color("unknown"), "muted");
});

test("role and header title name Active, Advisor and Standby", () => {
  assert.equal(pill.steerRole(row("a")), "Active");
  assert.equal(pill.steerRole(row("a", { active: false })), "Standby");
  assert.equal(pill.steerRole(row("a", { active: false, advisor: true })), "Advisor");
  assert.equal(pill.steerHeaderTitle(row("a")), "Steer A · Active");
  assert.equal(pill.steerHeaderTitle(row("a", { active: false, slot: "B" })), "Steer B · Standby");
  assert.equal(
    pill.steerHeaderTitle(row("a", { active: false, advisor: true, slot: "C" })),
    "Steer C · Advisor",
  );
});

// ---------------------------------------------------------------------------
// Stable registration
// ---------------------------------------------------------------------------

test("sync adds one pill per row with the native menu behavior", () => {
  const client = fakeClient();
  const pills = new Map();
  pill.syncSteerPills(client, pills, [row("a1"), row("a2", { slot: "B" })], stubMenu);
  assert.deepEqual(client.calls, [
    ["add", "factory-steer-a1", "a1"],
    ["add", "factory-steer-a2", "a2"],
  ]);
  assert.equal(pills.size, 2);
  for (const agentId of ["a1", "a2"]) {
    const contribution = client.regs.get(agentId).contribution;
    assert.equal(contribution.workspaceId, "wks_main");
    assert.equal(contribution.button.behavior.kind, "menu");
  }
  assert.equal(pills.get("a1").menuKey, "a1");
});

test("sync patches the face and the menu only when each changes", () => {
  const client = fakeClient();
  const pills = new Map();
  const first = [row("a1")];
  pill.syncSteerPills(client, pills, first, stubMenu);
  assert.deepEqual(kinds(client.calls), ["add"]);
  // Identical event: no churn.
  pill.syncSteerPills(client, pills, [row("a1")], stubMenu);
  assert.deepEqual(kinds(client.calls), ["add"]);
  // Detail-only change: face unchanged, row refreshed, no update call.
  pill.syncSteerPills(client, pills, [row("a1", { detail: "Cache warm · cooling in 19m" })], stubMenu);
  assert.deepEqual(kinds(client.calls), ["add"]);
  assert.equal(pills.get("a1").row.detail, "Cache warm · cooling in 19m");
  // State change: one in-place face patch without a behavior replacement.
  pill.syncSteerPills(client, pills, [row("a1", { state: "cold", warmth: "cold" })], stubMenu);
  assert.deepEqual(kinds(client.calls), ["add", "update"]);
  const patch = client.calls.at(-1)[2];
  assert.deepEqual(Object.keys(patch).sort(), ["icon", "label", "title"]);
  assert.equal(patch.label, "A · cold");
  // Second identical event after the change: quiet again.
  pill.syncSteerPills(client, pills, [row("a1", { state: "cold", warmth: "cold" })], stubMenu);
  assert.deepEqual(kinds(client.calls), ["add", "update"]);
});

test("sync patches the menu behavior only when its key changes", () => {
  const client = fakeClient();
  const pills = new Map();
  let key = "v1";
  const builder = (entry) => ({ behavior: { kind: "menu", items: [] }, menuKey: key });
  pill.syncSteerPills(client, pills, [row("a1")], builder);
  pill.syncSteerPills(client, pills, [row("a1")], builder);
  assert.deepEqual(kinds(client.calls), ["add"]);
  key = "v2";
  pill.syncSteerPills(client, pills, [row("a1")], builder);
  assert.deepEqual(kinds(client.calls), ["add", "update"]);
  assert.deepEqual(Object.keys(client.calls.at(-1)[2]), ["behavior"]);
});

test("sync removes authoritatively missing rows and retries missing composers", () => {
  const client = fakeClient();
  client.addThrows.add("ghost");
  const pills = new Map();
  pill.syncSteerPills(client, pills, [row("a1"), row("ghost", { slot: "B" })], stubMenu);
  assert.equal(pills.size, 1);
  assert.deepEqual(kinds(client.calls), ["add", "add"]);
  // The ghost tab gets a composer later; the gone tab is removed.
  client.addThrows.delete("ghost");
  pill.syncSteerPills(client, pills, [row("a1"), row("ghost", { slot: "B" })], stubMenu);
  assert.equal(pills.size, 2);
  assert.deepEqual(kinds(client.calls), ["add", "add", "add"]);
  pill.syncSteerPills(client, pills, [row("ghost", { slot: "B" })], stubMenu);
  assert.deepEqual(kinds(client.calls), ["add", "add", "add", "remove"]);
  assert.equal(pills.has("a1"), false);
});

test("sync drops a pill whose update throws and re-adds it on the next event", () => {
  const client = fakeClient({ updateThrowsFor: new Set(["a1"]) });
  const pills = new Map();
  pill.syncSteerPills(client, pills, [row("a1")], stubMenu);
  pill.syncSteerPills(client, pills, [row("a1", { state: "cold", warmth: "cold" })], stubMenu);
  assert.equal(pills.size, 0);
  const healed = fakeClient();
  pill.syncSteerPills(healed, pills, [row("a1", { state: "cold", warmth: "cold" })], stubMenu);
  assert.equal(pills.size, 1);
  assert.equal(pills.get("a1").face.label, "A · cold");
});

// ---------------------------------------------------------------------------
// Reconnect and teardown
// ---------------------------------------------------------------------------

test("disconnect keeps pills as unknown and reconnect restores faces", () => {
  const client = fakeClient();
  const pills = new Map();
  pill.syncSteerPills(client, pills, [row("a1"), row("a2", { slot: "B" })], stubMenu);
  pill.markSteerPillsDisconnected(pills);
  assert.equal(pills.size, 2);
  assert.deepEqual(kinds(client.calls), ["add", "add", "update", "update"]);
  for (const entry of pills.values()) {
    assert.match(entry.face.label, /unknown/);
    assert.match(entry.face.title, /host disconnected/);
  }
  assert.equal(pills.get("a1").face.title, "Steer A · Active · unknown\nhost disconnected");
  assert.equal(pills.get("a1").face.accessibilityLabel, "Steer A · Active · unknown · host disconnected");
  // Marking twice is quiet.
  pill.markSteerPillsDisconnected(pills);
  assert.deepEqual(kinds(client.calls), ["add", "add", "update", "update"]);
  // The next connected event restores faces without re-adding pills.
  pill.syncSteerPills(client, pills, [row("a1"), row("a2", { slot: "B" })], stubMenu);
  assert.deepEqual(kinds(client.calls), ["add", "add", "update", "update", "update", "update"]);
  assert.equal(pills.get("a1").face.label, "A · warm");
});

test("disconnect keeps pills whose update throws; teardown removes everything", () => {
  const client = fakeClient({ updateThrowsFor: new Set(["a1"]) });
  const pills = new Map();
  pill.syncSteerPills(client, pills, [row("a1")], stubMenu);
  pill.markSteerPillsDisconnected(pills);
  assert.equal(pills.size, 1);
  assert.equal(pills.get("a1").face.label, "A · warm");
  const failing = fakeClient({ removeThrowsFor: new Set(["a1", "a2"]) });
  const doomed = new Map([
    ["a1", { registration: failing.addComposerPill({ id: "x", workspaceId: "w", agentId: "a1", button: {} }), face: pill.faceFor(row("a1")), row: row("a1") }],
    ["a2", { registration: failing.addComposerPill({ id: "y", workspaceId: "w", agentId: "a2", button: {} }), face: pill.faceFor(row("a2")), row: row("a2") }],
  ]);
  failing.calls.length = 0;
  pill.teardownSteerPills(doomed);
  assert.equal(doomed.size, 0);
  assert.deepEqual(kinds(failing.calls), ["remove", "remove"]);
});

// ---------------------------------------------------------------------------
// Countdown ticks keep an open confirmation
// ---------------------------------------------------------------------------

test("quota countdown labels tick locally from the reset time", () => {
  assert.equal(pill.quotaCountdownLabel(null, NOW), null);
  assert.equal(pill.quotaCountdownLabel("not-a-date", NOW), null);
  assert.equal(pill.quotaCountdownLabel(iso(NOW - MIN), NOW), "resetting now");
  assert.equal(pill.quotaCountdownLabel(iso(NOW), NOW), "resetting now");
  assert.equal(pill.quotaCountdownLabel(iso(NOW + 72 * MIN), NOW), "resets in 1h 12m");
  assert.equal(pill.quotaCountdownLabel(iso(NOW + 2 * 24 * 60 * MIN), NOW), "resets in 2d");
});

test("quota rows match the design wording with model and pool labels", () => {
  assert.equal(
    pill.formatQuotaRow({ id: "5h", scope: "account", usedPct: 54, resetsAt: iso(NOW + 72 * MIN), stale: false }, NOW),
    "5h 54% used · resets in 1h 12m",
  );
  assert.equal(
    pill.formatQuotaRow({ id: "7d", scope: "account", usedPct: 48, resetsAt: iso(NOW + 2 * 24 * 60 * MIN), stale: false }, NOW),
    "7d 48% used · resets in 2d",
  );
  assert.equal(
    pill.formatQuotaRow({ id: "sonnet", scope: "model", usedPct: 90, resetsAt: null, stale: false }, NOW),
    "sonnet (model) 90% used",
  );
  assert.equal(
    pill.formatQuotaRow({ id: "session", scope: "pool", usedPct: null, resetsAt: null, stale: true }, NOW),
    "session (pool) · stale",
  );
});

test("tick delay fires at the next boundary inside the minute", () => {
  assert.equal(pill.nextTickDelayMs(iso(NOW + 20 * MIN), NOW), 60_000);
  assert.equal(pill.nextTickDelayMs(iso(NOW + 30_000), NOW), 30_000);
  assert.equal(pill.nextTickDelayMs(iso(NOW + 500), NOW), 1_000);
  assert.equal(pill.nextTickDelayMs(iso(NOW - MIN), NOW), 60_000);
  assert.equal(pill.nextTickDelayMs(null, NOW), 60_000);
  assert.equal(pill.nextTickDelayMs("not-a-date", NOW), 60_000);
});

test("a local tick keeps the open confirmation object as is", () => {
  const confirmation = { fingerprint: "abc123", summary: "Hand over to B" };
  const next = pill.tickPopoverState({ confirmation, nowMs: NOW }, NOW + 60_000);
  assert.equal(next.confirmation, confirmation);
  assert.equal(next.nowMs, NOW + 60_000);
});

test("context, route and speed helpers stay English and total", () => {
  assert.equal(pill.formatContextTokens(5000), "Context 5,000 tokens");
  assert.equal(pill.formatContextTokens(null), "Context unknown");
  assert.equal(
    pill.describeRoute({ provider: "codex", model: "gpt-6.2-sol", thinking: "high", speed: "Fast" }),
    "codex · gpt-6.2-sol · thinking high · Fast",
  );
  assert.equal(pill.describeRoute({ provider: "codex" }), "codex");
  assert.equal(pill.describeRoute({}), null);
  assert.equal(pill.speedOfOptions({ fast_mode: true }), "Fast");
  assert.equal(pill.speedOfOptions({ fast_mode: false }), "Standard");
  assert.equal(pill.speedOfOptions({ service_tier: "flex" }), "Tier flex");
  assert.equal(pill.speedOfOptions({}), null);
  assert.equal(pill.speedOfOptions(null), null);
  assert.equal(pill.speedOfOptions([]), null);
});

// ---------------------------------------------------------------------------
// Coexistence with worker-attention and result pills
// ---------------------------------------------------------------------------

test("pill id prefixes are pairwise distinct", () => {
  const prefixes = [pill.STEER_PILL_ID_PREFIX, pill.ATTENTION_PILL_ID_PREFIX, pill.RESULT_PILL_ID_PREFIX];
  assert.equal(new Set(prefixes).size, 3);
  const ids = [pill.steerPillId("a1"), pill.attentionPillId("a1"), pill.resultPillId("a1")];
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(ids, ["factory-steer-a1", "factory-attention-a1", "factory-result-a1"]);
});

test("sync, disconnect and teardown never touch foreign pills", () => {
  const client = fakeClient();
  const foreign = [
    client.addComposerPill({ id: pill.attentionPillId("worker-1"), workspaceId: "w", agentId: "worker-1", button: {} }),
    client.addComposerPill({ id: pill.resultPillId("worker-1"), workspaceId: "w", agentId: "worker-1", button: {} }),
  ];
  assert.equal(foreign.length, 2);
  client.calls.length = 0;
  const pills = new Map();
  pill.syncSteerPills(client, pills, [row("steer-a", { slot: "A" })], stubMenu);
  pill.markSteerPillsDisconnected(pills);
  pill.syncSteerPills(client, pills, [row("steer-a", { slot: "A" })], stubMenu);
  pill.teardownSteerPills(pills);
  for (const call of client.calls) {
    const agentId = call[0] === "add" ? call[2] : call[1];
    assert.equal(agentId, "steer-a");
  }
});

// ---------------------------------------------------------------------------
// Discovery pagination
// ---------------------------------------------------------------------------

test("steers on later daemon pages get feed rows and pills", async () => {
  const MAIN = "wks_main";
  const workspace = {
    id: MAIN,
    workspaceDirectory: "/tmp/o-r",
    title: "Main",
    metadata: {
      wsf: { main: MAIN, activeSteer: "A", epoch: 1, scope: { id: "o/r", kind: "github" } },
      "wsf.agents": {},
    },
  };
  const agent = (id, slot) => ({
    id,
    title: `Steer ${slot}`,
    provider: "codex",
    model: "gpt-6.2-sol",
    status: "idle",
    workspaceId: MAIN,
    labels: { [LABEL.scope]: "o/r", [LABEL.role]: "steer", [LABEL.slot]: slot },
    lastUsage: { contextWindowUsedTokens: 100 },
    pendingPermissions: [],
    archivedAt: null,
  });
  const first = agent("steer-a", "A");
  const older = agent("steer-b", "B");
  const daemon = {
    projects: { list: async () => ({ projects: [] }) },
    workspaces: { list: async () => ({ entries: [workspace], pageInfo: { hasMore: false } }) },
    agents: {
      list: async (args) =>
        args?.page?.cursor === "c1"
          ? { entries: [older], pageInfo: { hasMore: false } }
          : { entries: [first], pageInfo: { hasMore: true, nextCursor: "c1" } },
    },
    providers: { snapshot: async () => ({ entries: [] }) },
  };
  const state = await readPaseoState(daemon);
  assert.equal(state.agents.length, 2);
  const feed = collectSteerStates(state, { settings: CLEANUP_DEFAULTS, nowMs: NOW });
  assert.deepEqual(feed.map((entry) => entry.agentId).sort(), ["steer-a", "steer-b"]);
  const client = fakeClient();
  const pills = new Map();
  pill.syncSteerPills(client, pills, pill.steerRowsOf({ steers: feed }), stubMenu);
  assert.equal(pills.size, 2);
  assert.deepEqual([...pills.keys()].sort(), ["steer-a", "steer-b"]);
});

test("bulk sync registers hundreds of tabs without churn on repeat", () => {
  const slots = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const rows = Array.from({ length: 250 }, (_, index) =>
    row(`steer-${index}`, { slot: slots[index % slots.length] }),
  );
  const client = fakeClient();
  const pills = new Map();
  pill.syncSteerPills(client, pills, rows, stubMenu);
  assert.equal(pills.size, 250);
  assert.equal(client.calls.length, 250);
  pill.syncSteerPills(client, pills, rows.map((entry) => ({ ...entry })), stubMenu);
  assert.equal(client.calls.length, 250);
});

// ---------------------------------------------------------------------------
// Wiring, aria and rendering contract (static)
// ---------------------------------------------------------------------------

const entrySource = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
const menuSource = readFileSync(new URL("../client/steer-menu-content.tsx", import.meta.url), "utf8");
const logicSource = readFileSync(new URL("../client/steer-pill.ts", import.meta.url), "utf8");
const submitSource = readFileSync(new URL("../client/factory-submit.ts", import.meta.url), "utf8");

test("entry subscribes to factory.steers and keeps attention worker-only", () => {
  for (const token of [
    "factorySteers",
    "buildSteerMenuBehavior",
    "syncSteerPills",
    "markSteerPillsDisconnected",
    "teardownSteerPills",
    "steerIds.has(row.agentId)",
    "steerFeed.release()",
  ]) {
    assert.ok(entrySource.includes(token), `index.client.tsx contains ${token}`);
  }
});

test("the Reset dialog is keyboard/screen-reader labelled and theme driven", () => {
  for (const token of [
    'accessibilityRole="button"',
    'accessibilityRole="alert"',
    "accessibilityState={{ busy }}",
    "theme.colors.",
    "resetQuotaConfirmationText",
  ]) {
    assert.ok(menuSource.includes(token), `steer-menu-content.tsx contains ${token}`);
  }
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(menuSource), false, "no hardcoded hex colors");
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(logicSource), false, "logic carries no colors");
  assert.ok(
    pill.faceFor(row("a1")).accessibilityLabel.includes("Steer A"),
    "accessible title names the slot",
  );
  assert.ok(
    pill.faceFor(row("a1")).accessibilityLabel.includes("warm"),
    "accessible title names the state",
  );
});

test("new UI text and pill summaries are English", () => {
  for (const value of Object.values(pill.STEER_PRIMARY_ACTION_LABELS)) {
    assert.match(value, /^[\x20-\x7E]+$/, `action label is English: ${value}`);
  }
  for (const file of [logicSource, menuSource, submitSource]) {
    for (const german of [
      "Hilfe",
      "Kandidaten",
      "Projekte",
      "Modelle",
      "Resume-Brief",
      "Worker-Modelle",
      "Steer-Slots",
      "Worker-Pick",
      "Steer-Add",
    ]) {
      assert.equal(file.includes(german), false, `no German string ${german}`);
    }
  }
  for (const english of [
    'pill("Help")',
    'pill("Candidates")',
    'pill("Projects")',
    'pill("Models")',
    'pill("Resume brief")',
    '"Worker models"',
    '"Steer priorities"',
    'pill("Worker pick")',
    'pill("Steer add")',
  ]) {
    assert.ok(submitSource.includes(english), `factory-submit.ts contains ${english}`);
  }
});
