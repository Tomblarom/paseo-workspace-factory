// Step-1 tests for the steer-state feed: live-state assembly, discovery
// reuse (continuation + same-slot supersession), and quota wiring. The
// projection itself is covered by steer-state.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const { collectSteerStates } = await import("../server/steer-feed.ts");
const { applySteerTitleLabels } = await import("../server/steer-title-labels.ts");
const { CLEANUP_DEFAULTS } = await import("../shared/idle-cleanup.ts");

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const SCOPE = "o/r";
const MAIN = "wks_main";

function agent(id, over = {}) {
  return {
    id,
    title: `Steer ${over.labels?.["wsf.slot"] ?? "A"}`,
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

test("title labels use the injected writer and update only the selected snapshot agent", async () => {
  const state = paseoState([
    agent("candidate", { title: "Steer C", labels: { other: "kept" } }),
    agent("other", { title: "Steer B", labels: {} }),
  ], { wsf: { main: true } });
  const writes = [];
  const applied = await applySteerTitleLabels(state, {
    agentId: "candidate",
    write: async (id, labels) => { writes.push([id, labels]); },
  });
  const labels = { "wsf.role": "steer", "wsf.slot": "C", "wsf.scope": SCOPE, "wsf.repo": SCOPE };
  assert.equal(applied, 1);
  assert.deepEqual(writes, [["candidate", labels]]);
  assert.deepEqual(state.agents[0].labels, { other: "kept", ...labels });
  assert.deepEqual(state.agents[1].labels, {});
});

test("renaming a legacy advisor preserves its role through a model change and a second feed pass", async () => {
  const config = { profiles: { lead: {}, review: { advisor: true } }, steers: { slots: { A: "review", B: "lead" } } };
  const state = paseoState([agent("reviewer", { title: "Steer B" })], { wsf: { main: true } });
  const writes = [];
  const write = async (id, patch) => { writes.push({ id, patch }); };
  await applySteerTitleLabels(state, { config, write });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].patch["wsf.slot"], "B");
  assert.equal(writes[0].patch["wsf.steer-role"], "advisor");
  state.agents[0].model = "new-model";
  config.profiles.review.advisor = false;
  assert.equal(feed(state, { config })[0].advisor, true);
  assert.equal(await applySteerTitleLabels(state, { config, write }), 0);
});

test("a live steer projects a warm row with identity and flags", () => {
  const rows = feed(paseoState([agent("steer-a")], { entries: { "steer-a": { ...TURN } } }));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    scopeId: SCOPE,
    workspaceId: MAIN,
    agentId: "steer-a",
    slot: "A",
    title: "Steer A",
    provider: "codex",
    model: "gpt-6.2-sol",
    liveStatus: "idle",
    advisor: false,
    active: true,
    activationEpoch: null,
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
    quotaConfirmation: "unknown",
    headerFacts: ["Estimated"],
    primaryAction: "focus",
    detail: "Cache warm · cooling in 20m",
    nextBoundaryAt: iso(NOW + 20 * MIN),
    thinking: null,
    speed: null,
    sessionId: null,
    baseline: null,
    confirmed: null,
    settingsLocked: false,
    settingsLockReason: null,
  });
});

test("archived tabs have no row even when legacy metadata names them", () => {
  const rows = feed(paseoState([
    agent("old", { archivedAt: iso(NOW) }),
    agent("current"),
  ], { entries: { old: { ...TURN }, current: { ...TURN } }, wsf: { retired: true, previousSteer: "old" } }));
  assert.deepEqual(rows.map(({ agentId, state, active }) => ({ agentId, state, active })),
    [{ agentId: "current", state: "warm", active: true }]);
});

test("a continuation origin gets no row; the live tab holds the slot", () => {
  const origin = agent("steer-old");
  const live = agent("cont-1", { labels: { "zerosub.continued-from": "steer-old" }, lastUsage: null });
  const rows = feed(paseoState([origin, live], { entries: { "steer-old": { ...TURN } } }));
  const byId = Object.fromEntries(rows.map((row) => [row.agentId, row]));
  assert.equal(byId["steer-old"], undefined);
  // The live continuation inherits the slot and projects its own state.
  assert.equal(byId["cont-1"].slot, "A");
  assert.equal(byId["cont-1"].state, "ready");
});

test("same-slot holders remain ambiguous regardless of creation time", () => {
  const old = agent("steer-old", { createdAt: iso(NOW - 120 * MIN) });
  const current = agent("steer-new", { createdAt: iso(NOW - MIN) });
  const rows = feed(paseoState([old, current], { entries: { "steer-old": { ...TURN }, "steer-new": { ...TURN } } }));
  const byId = Object.fromEntries(rows.map((row) => [row.agentId, row]));
  assert.deepEqual(rows.map((row) => row.state), ["unknown", "unknown"]);
  assert.match(rows[0].detail, /ambiguous/);
  assert.equal(byId["steer-old"].successor, null);
  assert.equal(byId["steer-new"].successor, null);
});

test("archived tabs get no row and do not or make the live holder ambiguous", () => {
  const rows = feed(paseoState([agent("old", { archivedAt: iso(NOW - MIN) }), agent("live")]));
  const byId = Object.fromEntries(rows.map((row) => [row.agentId, row]));
  assert.equal(byId.old, undefined);
  assert.equal(byId.live.active, true);
  assert.notEqual(byId.live.state, "unknown");
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
          "steer-c": { ...TURN, openTurnId: "turn-1", turnStartedAt: iso(NOW - MIN), action: { kind: "cleanup", wakeId: "c", phase: "renewing", cleanup: { kind: "compact", at: iso(NOW - MIN) } } },
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
  assert.equal(limited[0].quotaConfirmation, "depleted");
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
      entries: { "steer-a": { ...TURN, action: { kind: "memory", wakeId: "context-facts", phase: "done", facts: { freshHint: { at: iso(NOW - MIN), reason: "package boundary" } } } } },
    }),
  );
  assert.ok(hinted[0].headerFacts.includes("Refresh recommended"));
  const stale = feed(
    paseoState([agent("steer-a")], {
      entries: { "steer-a": { ...TURN, action: { kind: "memory", wakeId: "context-facts", phase: "done", facts: { freshHint: { at: iso(NOW - 10 * MIN), reason: "package boundary" } } } } },
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

test("the feed exposes pending permissions and staged briefs", () => {
  const rows = feed(
    paseoState(
      [
        agent("steer-a", { pendingPermissions: [{ id: "perm-1" }] }),
        agent("steer-b", { labels: { "wsf.scope": SCOPE, "wsf.role": "steer", "wsf.slot": "B" } }),
      ],
      {
        entries: {
          "steer-a": { ...TURN },
          "steer-b": { ...TURN, action: { kind: "stage", wakeId: "s", phase: "staged", packet: "PACKET", stageKind: "switch" } },
        },
      },
    ),
  );
  const byId = Object.fromEntries(rows.map((row) => [row.agentId, row]));
  assert.equal(byId["steer-a"].permissionNeeded, true);
  assert.equal(byId["steer-a"].stagedBrief, false);
  assert.equal(byId["steer-b"].permissionNeeded, false);
  assert.equal(byId["steer-b"].stagedBrief, true);
  const delivered = feed(
    paseoState([agent("steer-a")], {
      entries: { "steer-a": { ...TURN, action: { kind: "delivery", wakeId: "d", phase: "done" } } },
    }),
  );
  assert.equal(delivered[0].stagedBrief, false);
});

test("the feed exposes live thinking, speed, session and baseline", () => {
  const rows = feed(
    paseoState(
      [agent("steer-a", {
        thinkingOptionId: "high",
        effectiveThinkingOptionId: "high",
        options: { service_tier: "flex" },
        persistence: { sessionId: "sess-1" },
      })],
      {
        entries: {
          "steer-a": {
            ...TURN,
            settingsBaseline: {
              provider: "codex",
              model: "gpt-6.2-sol",
              thinking: "high",
              speed: "flex",
              sessionId: "sess-1",
              turnId: "t-1",
              at: iso(NOW - 5 * MIN),
            },
          },
        },
      },
    ),
  );
  assert.equal(rows[0].thinking, "high");
  assert.equal(rows[0].speed, "flex");
  assert.equal(rows[0].sessionId, "sess-1");
  assert.deepEqual(rows[0].baseline, {
    provider: "codex",
    model: "gpt-6.2-sol",
    thinking: "high",
    speed: "flex",
    sessionId: "sess-1",
  });
  assert.equal(rows[0].state, "warm");
});

test("a live tuple that differs from a comparable baseline is a prefix break", () => {
  const rows = feed(
    paseoState([agent("steer-a", { model: "gpt-5.5", persistence: { sessionId: "sess-1" } })], {
      entries: {
        "steer-a": {
          ...TURN,
          settingsBaseline: {
            provider: "codex",
            model: "gpt-6.2-sol",
            thinking: null,
            speed: null,
            sessionId: "sess-1",
            turnId: "t-1",
            at: iso(NOW - 5 * MIN),
          },
        },
      },
    }),
  );
  assert.equal(rows[0].warmth, "cold");
  assert.equal(rows[0].state, "cold");
  assert.match(rows[0].detail, /Settings changed/);
});

test("the feed flags the efficiency lock for warm steers", () => {
  const rows = feed(
    paseoState([agent("steer-a")], { entries: { "steer-a": { ...TURN } } }),
    { settings: { ...CLEANUP_DEFAULTS, profile: "efficiency" } },
  );
  assert.equal(rows[0].settingsLocked, true);
  assert.match(rows[0].settingsLockReason, /Maximum efficiency/);
  const cold = feed(
    paseoState([agent("steer-a")], { entries: { "steer-a": { lastTurnEndedAt: iso(NOW - 120 * MIN) } } }),
    { settings: { ...CLEANUP_DEFAULTS, profile: "efficiency" } },
  );
  assert.equal(cold[0].settingsLocked, false);
  assert.equal(cold[0].settingsLockReason, null);
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
