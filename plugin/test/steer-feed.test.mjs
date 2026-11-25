// Step-1 tests for the steer-state feed: live-state assembly, discovery
// reuse (continuation + same-slot supersession), and quota wiring. The
// projection itself is covered by steer-state.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const { collectSteerStates } = await import("../server/steer-feed.ts");
const { CLEANUP_DEFAULTS } = await import("../shared/idle-cleanup.ts");

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const SCOPE = "o/r";
const MAIN = "wks_main";

function agent(id, over = {}) {
  return {
    id,
    title: `Steer ${id}`,
    provider: "codex",
    model: "gpt-6.2-sol",
    status: "idle",
    workspaceId: MAIN,
    labels: { "wsf.scope": SCOPE, "wsf.role": "steer", "wsf.slot": "A" },
    lastUsage: { contextWindowUsedTokens: 5000 },
    pendingPermissions: [],
    archivedAt: null,
    ...over,
  };
}

function paseoState(agents, { entries = {}, wsf = {} } = {}) {
  return {
    agents,
    workspaces: [
      {
        id: MAIN,
        workspaceDirectory: "/tmp/o-r",
        title: "Main",
        metadata: {
          wsf: { main: MAIN, activeSteer: "A", epoch: 1, scope: { id: SCOPE, kind: "github" }, ...wsf },
          "wsf.agents": entries,
        },
      },
    ],
  };
}

function feed(state, over = {}) {
  return collectSteerStates(state, { settings: CLEANUP_DEFAULTS, nowMs: NOW, ...over });
}

const TURN = { lastTurnEndedAt: iso(NOW - 5 * MIN) };

test("a live steer projects a warm row with identity and flags", () => {
  const rows = feed(paseoState([agent("steer-a")], { entries: { "steer-a": { ...TURN } } }));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    scopeId: SCOPE,
    workspaceId: MAIN,
    agentId: "steer-a",
    slot: "A",
    title: "Steer steer-a",
    provider: "codex",
    model: "gpt-6.2-sol",
    liveStatus: "idle",
    advisor: false,
    active: true,
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
    nextBoundaryAt: iso(NOW + 20 * MIN),
  });
});

test("retired scopes and replaced holders project Retired", () => {
  const retired = feed(
    paseoState([agent("steer-a")], { entries: { "steer-a": { ...TURN } }, wsf: { retired: true } }),
  );
  assert.equal(retired[0].state, "retired");
  const replaced = feed(
    paseoState([agent("steer-a"), agent("steer-b", { labels: { "wsf.scope": SCOPE, "wsf.role": "steer", "wsf.slot": "B" } })], {
      entries: { "steer-a": { ...TURN }, "steer-b": { ...TURN } },
      wsf: { previousSteer: "steer-a" },
    }),
  );
  assert.deepEqual(replaced.map((row) => [row.slot, row.state]), [["A", "retired"], ["B", "warm"]]);
});

test("a continuation origin retires with the live tab as successor", () => {
  const origin = agent("steer-old");
  const live = agent("cont-1", { labels: { "zerosub.continued-from": "steer-old" }, lastUsage: null });
  const rows = feed(paseoState([origin, live], { entries: { "steer-old": { ...TURN } } }));
  const byId = Object.fromEntries(rows.map((row) => [row.agentId, row]));
  assert.equal(byId["steer-old"].state, "retired");
  assert.equal(byId["steer-old"].successor, "cont-1");
  assert.equal(byId["steer-old"].slot, "A");
  // The live continuation inherits the slot and projects its own state.
  assert.equal(byId["cont-1"].slot, "A");
  assert.equal(byId["cont-1"].state, "ready");
});

test("same-slot newer-wins retires the older holder", () => {
  const old = agent("steer-old", { createdAt: iso(NOW - 120 * MIN) });
  const current = agent("steer-new", { createdAt: iso(NOW - MIN) });
  const rows = feed(paseoState([old, current], { entries: { "steer-old": { ...TURN }, "steer-new": { ...TURN } } }));
  const byId = Object.fromEntries(rows.map((row) => [row.agentId, row]));
  assert.equal(byId["steer-old"].state, "retired");
  assert.equal(byId["steer-old"].successor, "steer-new");
  assert.equal(byId["steer-new"].state, "warm");
});

test("holders without a unique newest stay ambiguous", () => {
  const rows = feed(
    paseoState([agent("steer-a"), agent("steer-b")], { entries: { "steer-a": { ...TURN }, "steer-b": { ...TURN } } }),
  );
  assert.deepEqual(rows.map((row) => row.state), ["unknown", "unknown"]);
  assert.match(rows[0].detail, /ambiguous/);
});

test("recovery flags, operations and open turns map to faces", () => {
  const rows = feed(
    paseoState(
      [
        agent("steer-a"),
        agent("steer-b", { labels: { "wsf.scope": SCOPE, "wsf.role": "steer", "wsf.slot": "B" }, status: "initializing" }),
        agent("steer-c", { labels: { "wsf.scope": SCOPE, "wsf.role": "steer", "wsf.slot": "C" } }),
      ],
      {
        entries: {
          "steer-a": { ...TURN, needsResume: { reason: "daemon-restart", at: iso(NOW - MIN) } },
          "steer-b": { ...TURN },
          "steer-c": { ...TURN, openTurnId: "turn-1", turnStartedAt: iso(NOW - MIN), pendingAction: { kind: "compact", at: iso(NOW - MIN) } },
        },
      },
    ),
  );
  assert.deepEqual(rows.map((row) => [row.slot, row.state]), [["A", "needs-resume"], ["B", "waiting"], ["C", "running"]]);
  const interrupted = feed(
    paseoState([agent("steer-a")], { entries: { "steer-a": { ...TURN, interrupted: { at: iso(NOW - MIN), outcome: "canceled" } } } }),
  );
  assert.equal(interrupted[0].state, "needs-resume");
});

test("pool quota and ZeroSub routes feed the Limited and Waiting faces", () => {
  const limited = feed(
    paseoState([agent("steer-a")], { entries: { "steer-a": { ...TURN } } }),
    {
      quotaSnapshot: { codex: { sessionPct: 95, resetsAt: iso(NOW + 60 * MIN) } },
      poolSampledAtMs: NOW,
    },
  );
  assert.equal(limited[0].state, "limited");
  assert.equal(limited[0].resetUnknown, false);
  const waiting = feed(
    paseoState([agent("steer-a")], { entries: { "steer-a": { ...TURN } } }),
    {
      zerosub: {
        accounts: [],
        agentAccount: { "steer-a": "acc-new" },
        pending: { "steer-a": "acc-old" },
        waiting: { "steer-a": "restart" },
        version: null,
      },
    },
  );
  assert.equal(waiting[0].state, "waiting");
});

test("only fresh hints valid for the idle period surface", () => {
  const hinted = feed(
    paseoState([agent("steer-a")], {
      entries: { "steer-a": { ...TURN, freshHint: { at: iso(NOW - MIN), reason: "package boundary" } } },
    }),
  );
  assert.ok(hinted[0].headerFacts.includes("Refresh recommended"));
  const stale = feed(
    paseoState([agent("steer-a")], {
      entries: { "steer-a": { ...TURN, freshHint: { at: iso(NOW - 10 * MIN), reason: "package boundary" } } },
    }),
  );
  assert.ok(!stale[0].headerFacts.includes("Refresh recommended"));
});

test("the feed tolerates missing settings, scopes and identities", () => {
  const rows = collectSteerStates(
    paseoState(
      [agent("steer-a"), agent("plain", { labels: {} }), agent("worker-1", { labels: { "wsf.scope": SCOPE, "wsf.role": "worker" } })],
      { entries: { "steer-a": { ...TURN } } },
    ),
    { settings: null, nowMs: NOW },
  );
  assert.deepEqual(rows.map((row) => row.agentId), ["steer-a"]);
  assert.equal(collectSteerStates({ agents: [], workspaces: [] }, { settings: null, nowMs: NOW }).length, 0);
});

test("rows sort by scope, slot and agent", () => {
  const rows = feed(
    paseoState(
      [
        agent("steer-b", { labels: { "wsf.scope": SCOPE, "wsf.role": "steer", "wsf.slot": "B" } }),
        agent("steer-a2", { labels: { "wsf.scope": SCOPE, "wsf.role": "steer", "wsf.slot": "A" }, createdAt: iso(NOW - MIN) }),
        agent("steer-a1", { createdAt: iso(NOW - 2 * MIN) }),
      ],
      { entries: { "steer-a1": { ...TURN }, "steer-a2": { ...TURN }, "steer-b": { ...TURN } } },
    ),
  );
  assert.deepEqual(rows.map((row) => row.agentId), ["steer-a1", "steer-a2", "steer-b"]);
});
