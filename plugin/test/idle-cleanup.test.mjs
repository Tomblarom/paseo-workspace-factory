import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const { resolveCacheTtl } = await import("../shared/cache-profiles.ts");
const { currentFreshHint } = await import("../server/core/agent-state.mjs");

const {
  CLEANUP_DEFAULTS,
  CLEAR_COMMAND,
  COMPACT_COMMAND,
  PREVIOUS_SESSIONS_MAX,
  cleanupIdentity,
  cleanupInputOf,
  coldHintText,
  decideCleanupAction,
  freshHintText,
  hasKeepContext,
  isCold,
  isSupervisionProtectedState,
  pushPreviousSession,
  scanCleanupEvidence,
  sendCleanupCommand,
  shouldRewindFresh,
} = await import("../shared/idle-cleanup.ts");

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const HOUR = 3_600_000;
const MIN = 60_000;
const at = (ms) => new Date(ms).toISOString();
const LABELS = { "wsf.scope": "s", "wsf.role": "steer", "wsf.slot": "A" };

function input(overrides = {}) {
  return {
    agentId: "agent-1",
    labels: { ...LABELS },
    provider: "claude",
    model: null,
    quotaAvailable: true,
    openWorkers: 1,
    status: "idle",
    archivedAt: null,
    pendingPermissionCount: 0,
    lastTurnEndedAt: at(NOW - 55 * MIN),
    contextTokens: 120_000,
    activeSteer: "A",
    checkpoint: { task: "Ship it", capturedAt: at(NOW - 30 * MIN), interrupted: null },
    entry: { lastTurnEndedAt: at(NOW - 55 * MIN) },
    settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm" },
    actionsToday: 0,
    effectBlocked: false,
    nowMs: NOW,
    cacheTtl: resolveCacheTtl({ provider: overrides.provider ?? "claude", model: overrides.model, claudeBilling: "subscription" }),
    ...overrides,
  };
}

test("cleanupIdentity accepts steers/workers and ignores other labels", () => {
  assert.deepEqual(cleanupIdentity(LABELS), { scopeId: "s", role: "steer", slot: "A" });
  assert.deepEqual(cleanupIdentity({ "wsf.scope": "s", "wsf.role": "worker" }), {
    scopeId: "s",
    role: "worker",
    slot: null,
  });
  assert.equal(cleanupIdentity({ "ari.wsf.scope": "s", "ari.wsf.role": "steer", "ari.wsf.slot": "B" }), null);
  // Older steers carry only the repo label (no wsf.scope): repo = scope id.
  assert.deepEqual(
    cleanupIdentity({ "wsf.repo": "o/r", "wsf.role": "steer", "wsf.slot": "D" }),
    { scopeId: "o/r", role: "steer", slot: "D" },
  );
  assert.equal(cleanupIdentity({ "wsf.scope": "s", "wsf.role": "advisor" }), null);
  assert.equal(cleanupIdentity({ "wsf.role": "steer" }), null);
  assert.equal(cleanupIdentity(null), null);
});

test("hasKeepContext honors the keepContext key only", () => {
  assert.equal(hasKeepContext({ "wsf.keepContext": "true" }), true);
  assert.equal(hasKeepContext({ "ari.wsf.keepContext": "true" }), false);
  assert.equal(hasKeepContext({ "wsf.keepContext": "false" }), false);
  assert.equal(hasKeepContext({}), false);
  assert.equal(hasKeepContext(null), false);
});

test("compact-warm acts on a cooling active steer with a fresh checkpoint", () => {
  const d = decideCleanupAction(input({}));
  assert.equal(d.action, "compact-warm");
  assert.equal(d.command, COMPACT_COMMAND);
  assert.match(d.reason, /compact-warm agent-1/);
});

test("clear needs the mode plus the acknowledgement", () => {
  const off = decideCleanupAction(input({ settings: { ...CLEANUP_DEFAULTS, mode: "off" } }));
  assert.equal(off.action, null);
  assert.match(off.reason, /mode is off/);
  const gated = decideCleanupAction(
    input({ settings: { ...CLEANUP_DEFAULTS, mode: "clear", clearAcknowledged: false } }),
  );
  assert.equal(gated.action, null);
  assert.match(gated.reason, /clearAcknowledged/);
  const go = decideCleanupAction(
    input({
      settings: { ...CLEANUP_DEFAULTS, mode: "clear", clearAcknowledged: true },
      lastTurnEndedAt: at(NOW - 2 * HOUR),
    }),
  );
  assert.equal(go.action, "clear");
  assert.equal(go.command, CLEAR_COMMAND);
});

test("each global gate denies on its own", () => {
  assert.match(decideCleanupAction(input({ effectBlocked: true })).reason, /disabled/);
  assert.match(
    decideCleanupAction(input({ actionsToday: 20, settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", dailyCap: 20 } })).reason,
    /daily cap/,
  );
  assert.ok(
    decideCleanupAction(
      input({ actionsToday: 19, settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", dailyCap: 20 } }),
    ).action,
  );
});

test("only factory agents in providers and roles act", () => {
  assert.match(decideCleanupAction(input({ labels: null })).reason, /not a factory/);
  assert.match(
    decideCleanupAction(input({ labels: { "wsf.scope": "s", "wsf.role": "advisor" } })).reason,
    /not a factory/,
  );
  assert.match(
    decideCleanupAction(
      input({ settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", roles: ["worker"] } }),
    ).reason,
    /not in roles/,
  );
  assert.match(
    decideCleanupAction(
      input({ settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", providers: ["codex"] } }),
    ).reason,
    /not in providers/,
  );
  assert.match(decideCleanupAction(input({ archivedAt: at(NOW) })).reason, /archived/);
});

test("busy, running, or permission-blocked agents are skipped", () => {
  assert.match(decideCleanupAction(input({ status: "running" })).reason, /running/);
  assert.match(decideCleanupAction(input({ status: "initializing" })).reason, /initializing/);
  assert.match(decideCleanupAction(input({ pendingPermissionCount: 1 })).reason, /permission/);
});

test("cleanup and lastActionFailed block retries in the same idle period", () => {
  assert.match(
    decideCleanupAction(input({ entry: { action: { cleanup: { kind: "clear", at: at(NOW) } } } })).reason,
    /already pending/,
  );
  assert.match(
    decideCleanupAction(input({ entry: { action: { facts: { lastActionFailed: { at: at(NOW), error: "x" } } } } })).reason,
    /new real turn/,
  );
});

test("idle and context thresholds fail closed on unknown values", () => {
  assert.match(
    decideCleanupAction(input({ lastTurnEndedAt: at(NOW - 10 * 60_000) })).reason,
    /below 50m/,
  );
  assert.match(decideCleanupAction(input({ lastTurnEndedAt: null })).reason, /unknown/);
  assert.match(decideCleanupAction(input({ lastTurnEndedAt: "not-a-date" })).reason, /unknown/);
  assert.match(decideCleanupAction(input({ contextTokens: 1000 })).reason, /below 60000/);
  assert.match(decideCleanupAction(input({ contextTokens: null })).reason, /unknown/);
  const clearIdle = input({
    settings: { ...CLEANUP_DEFAULTS, mode: "clear", clearAcknowledged: true },
    lastTurnEndedAt: at(NOW - 55 * 60_000),
  });
  assert.match(decideCleanupAction(clearIdle).reason, /below 60m/);
});

test("active steers need a fresh, unflagged task checkpoint", () => {
  assert.match(decideCleanupAction(input({ checkpoint: null })).reason, /no task checkpoint/);
  assert.match(
    decideCleanupAction(input({ checkpoint: { task: "  " } })).reason,
    /no task checkpoint/,
  );
  assert.match(
    decideCleanupAction(input({ checkpoint: { task: "t", capturedAt: at(NOW - 3 * HOUR) } })).reason,
    /older than the last turn/,
  );
  assert.match(
    decideCleanupAction(
      input({
        checkpoint: { task: "t", capturedAt: at(NOW - 30 * MIN), interrupted: { agentId: "a", at: at(NOW) } },
      }),
    ).reason,
    /flagged interrupted/,
  );
  assert.match(
    decideCleanupAction(input({ entry: { interrupted: { at: at(NOW) } } })).reason,
    /interrupted/,
  );
});

test("other agents need a note from the last turn", () => {
  const worker = (entry) =>
    input({
      labels: { "wsf.scope": "s", "wsf.role": "worker" },
      activeSteer: "A",
      checkpoint: null,
      entry,
    });
  assert.match(decideCleanupAction(worker({})).reason, /no note/);
  assert.match(decideCleanupAction(worker({ noteAt: at(NOW - 3 * HOUR) })).reason, /no note/);
  assert.match(decideCleanupAction(worker({ interrupted: { at: at(NOW) } })).reason, /interrupted/);
  const fresh = decideCleanupAction(
    worker({ note: "task: x", noteAt: at(NOW - 30 * MIN), lastTurnEndedAt: at(NOW - 55 * MIN) }),
  );
  assert.equal(fresh.action, "fresh-recommended");
  const otherSteer = decideCleanupAction(
    input({
      labels: { "wsf.scope": "s", "wsf.role": "steer", "wsf.slot": "B" },
      entry: { note: "task: x", noteAt: at(NOW - 30 * MIN) },
    }),
  );
  assert.equal(otherSteer.action, "compact-warm");
});

test("already cleaned and opted-out agents are skipped", () => {
  assert.match(
    decideCleanupAction(input({ entry: { action: { facts: { cleared: { at: at(NOW - 30 * MIN), mode: "clear" } } } } })).reason,
    /already cleaned/,
  );
  assert.ok(
    decideCleanupAction(input({ entry: { action: { facts: { cleared: { at: at(NOW - 3 * HOUR), mode: "clear" } } } } })).action,
    "an older cleaning does not block a new idle period",
  );
  assert.match(
    decideCleanupAction(input({ labels: { ...LABELS, "wsf.keepContext": "true" } })).reason,
    /keepContext/,
  );
});

test("isCold and coldHintText describe the C6 hint", () => {
  assert.equal(isCold("cold", true), true);
  assert.equal(isCold("warm", true), false);
  assert.equal(isCold("cold", false), false);
  assert.equal(isCold("unknown", true), false);
  assert.equal(coldHintText(350_000, 2 * HOUR), "Idle chat · 350k · 2h");
  assert.equal(coldHintText(61_200, 45 * 60_000), "Idle chat · 61k · 45m");
});

test("scanCleanupEvidence finds compaction signals", () => {
  assert.deepEqual(scanCleanupEvidence([]), {
    turnReadable: false,
    compactionSeen: false,
    markerSeen: false,
  });
  const entries = [
    { item: { type: "user_message", text: "/compact Keep: task." } },
    { item: { type: "compaction", status: "completed" } },
    { item: { type: "assistant_message", text: "Summary [Compacted] done" } },
  ];
  assert.deepEqual(scanCleanupEvidence(entries), {
    turnReadable: true,
    compactionSeen: true,
    markerSeen: true,
  });
  const plain = [{ item: { type: "assistant_message", text: "Switched to a new session" } }];
  assert.deepEqual(scanCleanupEvidence(plain), {
    turnReadable: true,
    compactionSeen: false,
    markerSeen: false,
  });
  assert.equal(scanCleanupEvidence([{ item: { type: "compaction", status: "loading" } }]).compactionSeen, false);
});

test("pushPreviousSession deduplicates and bounds the history", () => {
  assert.deepEqual(pushPreviousSession(null, "s1"), ["s1"]);
  assert.deepEqual(pushPreviousSession(["s1"], null), ["s1"]);
  assert.deepEqual(pushPreviousSession(["s1", "s2"], "s1"), ["s2", "s1"]);
  const full = ["s1", "s2", "s3", "s4", "s5"];
  assert.equal(full.length, PREVIOUS_SESSIONS_MAX);
  assert.deepEqual(pushPreviousSession(full, "s6"), ["s2", "s3", "s4", "s5", "s6"]);
  assert.deepEqual(pushPreviousSession(["", "s1"], ""), ["s1"]);
});

test("cleanupInputOf maps snapshots, entries, and checkpoints", () => {
  const agent = {
    id: "agent-1",
    labels: { ...LABELS },
    provider: "claude",
    model: "claude-sonnet-5-5",
    status: "idle",
    archivedAt: null,
    pendingPermissions: [{ id: "p1" }, { id: "p2" }],
    lastUsage: { contextWindowUsedTokens: 120_000, contextWindowMaxTokens: 200_000 },
  };
  const mapped = cleanupInputOf({
    agent,
    entry: { lastTurnEndedAt: at(NOW - HOUR) },
    checkpoint: { task: "t" },
    activeSteer: "A",
    settings: CLEANUP_DEFAULTS,
    actionsToday: 3,
    effectBlocked: true,
    nowMs: NOW,
    quotaAvailable: false,
    openWorkers: 2,
  });
  assert.equal(mapped.agentId, "agent-1");
  assert.equal(mapped.pendingPermissionCount, 2);
  assert.equal(mapped.contextTokens, 120_000);
  assert.equal(mapped.lastTurnEndedAt, at(NOW - HOUR));
  assert.equal(mapped.actionsToday, 3);
  assert.equal(mapped.effectBlocked, true);
  assert.equal(mapped.model, "claude-sonnet-5-5");
  assert.equal(mapped.quotaAvailable, false);
  assert.equal(mapped.openWorkers, 2);
  const legacy = cleanupInputOf({
    agent: { ...agent, lastUsage: null, LastUsage: { ContextWindowUsedTokens: 42 } },
    entry: { lastTurnEndedAt: 7 },
    checkpoint: null,
    activeSteer: null,
    settings: CLEANUP_DEFAULTS,
    actionsToday: 0,
    effectBlocked: false,
    nowMs: NOW,
  });
  assert.equal(legacy.contextTokens, 42);
  assert.equal(legacy.lastTurnEndedAt, null);
  assert.equal(legacy.pendingPermissionCount, 2);
  const missing = cleanupInputOf({
    agent: { id: "a", labels: null, provider: "x", status: "idle", archivedAt: null },
    entry: null,
    checkpoint: null,
    activeSteer: null,
    settings: CLEANUP_DEFAULTS,
    actionsToday: 0,
    effectBlocked: false,
    nowMs: NOW,
  });
  assert.equal(missing.contextTokens, null);
  assert.equal(missing.pendingPermissionCount, 0);
  assert.equal(missing.lastTurnEndedAt, null);
  assert.equal(missing.model, null);
  assert.equal(missing.quotaAvailable, null);
  assert.equal(missing.openWorkers, null);
});

test("C5 skips supervised workers the steer has not seen yet", () => {
  assert.equal(isSupervisionProtectedState("running"), true);
  assert.equal(isSupervisionProtectedState("blocked"), true);
  assert.equal(isSupervisionProtectedState("interrupted"), true);
  assert.equal(isSupervisionProtectedState("done"), false);
  assert.equal(isSupervisionProtectedState("partial"), false);
  assert.equal(isSupervisionProtectedState("stale"), false);
  assert.equal(isSupervisionProtectedState(null), false);
  assert.equal(isSupervisionProtectedState(undefined), false);
  for (const workerState of ["running", "blocked", "interrupted"]) {
    const denied = decideCleanupAction(
      input({
        labels: { "wsf.scope": "s", "wsf.role": "worker" },
        entry: { note: "task: x", noteAt: at(NOW - 30 * MIN) },
        workerState,
      }),
    );
    assert.equal(denied.action, null, workerState);
    assert.match(denied.reason, /steer has not seen it yet/);
  }
  for (const workerState of ["done", "partial", "stale", null, undefined]) {
    const worker = decideCleanupAction(
      input({
        labels: { "wsf.scope": "s", "wsf.role": "worker" },
        entry: { note: "task: x", noteAt: at(NOW - 30 * MIN), lastTurnEndedAt: at(NOW - 55 * MIN) },
        workerState,
      }),
    );
    assert.equal(worker.action, "fresh-recommended", String(workerState));
  }
});

test("cleanupInputOf carries the supervision register state", () => {
  const agent = { id: "w-1", labels: { "wsf.scope": "s", "wsf.role": "worker" }, provider: "claude", status: "idle", archivedAt: null };
  assert.equal(
    cleanupInputOf({
      agent, entry: null, checkpoint: null, activeSteer: "A", settings: CLEANUP_DEFAULTS,
      actionsToday: 0, effectBlocked: false, nowMs: NOW, workerState: "blocked",
    }).workerState,
    "blocked",
  );
  assert.equal(
    cleanupInputOf({
      agent, entry: null, checkpoint: null, activeSteer: "A", settings: CLEANUP_DEFAULTS,
      actionsToday: 0, effectBlocked: false, nowMs: NOW,
    }).workerState,
    null,
  );
});

test("sendCleanupCommand sends through the SDK without options", async () => {
  const calls = [];
  const paseo = {
    agents: {
      ref: (id) => ({
        send: (...args) => {
          calls.push({ id, args });
          return Promise.resolve();
        },
      }),
    },
  };
  await sendCleanupCommand(paseo, "agent-9", "/clear");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "agent-9");
  assert.deepEqual(calls[0].args, ["/clear"]);
  assert.equal(calls[0].args.length, 1, "no options: any sourceAgentId would void the command");
});

test("compact thresholds follow the profile and the model group", () => {
  const codex = {
    provider: "codex",
    model: "gpt-6.2-sol",
    checkpoint: { task: "Ship it", capturedAt: at(NOW - 5 * MIN), interrupted: null },
    settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", providers: ["claude", "codex"] },
  };
  assert.match(
    decideCleanupAction(input({ ...codex, lastTurnEndedAt: at(NOW - 20 * MIN) })).reason,
    /below 25m/,
  );
  assert.equal(
    decideCleanupAction(input({ ...codex, lastTurnEndedAt: at(NOW - 26 * MIN) })).action,
    "compact-warm",
  );
  const old = { ...codex, model: "gpt-5.5" };
  assert.match(
    decideCleanupAction(input({ ...old, lastTurnEndedAt: at(NOW - 7 * MIN) })).reason,
    /below 8m/,
  );
});

test("a short Claude route reaches cold at five minutes and an unconfirmed route skips warm compaction", () => {
  for (const claudeBilling of ["api-5m", "unknown"]) {
    const cacheTtl = resolveCacheTtl({ provider: "claude", claudeBilling });
    const checkpoint = { task: "Ship it", capturedAt: at(NOW - MIN) };
    const cooling = decideCleanupAction(input({ cacheTtl, checkpoint, lastTurnEndedAt: at(NOW - 4 * MIN) }));
    if (claudeBilling === "unknown") {
      assert.equal(cooling.action, null);
      assert.match(cooling.reason, /unconfirmed/);
    } else {
      assert.equal(cooling.action, "compact-warm");
    }
    const cold = decideCleanupAction(input({ cacheTtl, checkpoint, lastTurnEndedAt: at(NOW - 5 * MIN) }));
    assert.equal(cold.action, "fresh-recommended");
    assert.match(cold.reason, /5m claude cache/);
  }
});

test("already cold contexts get fresh-recommended, never a compact", () => {
  const cold = decideCleanupAction(input({ lastTurnEndedAt: at(NOW - 61 * MIN) }));
  assert.equal(cold.action, "fresh-recommended");
  assert.equal(cold.command, null);
  assert.match(cold.reason, /already passed the 60m claude cache/);
  assert.equal(
    decideCleanupAction(input({ lastTurnEndedAt: at(NOW - 59 * MIN) })).action,
    "compact-warm",
  );
  const codex = {
    provider: "codex",
    model: "gpt-6.2-sol",
    settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", providers: ["claude", "codex"] },
  };
  const coldCodex = decideCleanupAction(input({ ...codex, lastTurnEndedAt: at(NOW - 31 * MIN) }));
  assert.equal(coldCodex.action, "fresh-recommended");
  assert.match(coldCodex.reason, /already passed the 30m openai-new cache/);
  // Clear is free, so it still clears long-cold contexts.
  const cleared = decideCleanupAction(
    input({
      settings: { ...CLEANUP_DEFAULTS, mode: "clear", clearAcknowledged: true },
      lastTurnEndedAt: at(NOW - 5 * HOUR),
    }),
  );
  assert.equal(cleared.action, "clear");
});

test("mode clear maps Codex to compact, never /clear", () => {
  const codexClear = {
    provider: "codex",
    model: "gpt-6.2-sol",
    checkpoint: { task: "Ship it", capturedAt: at(NOW - 5 * MIN), interrupted: null },
    settings: { ...CLEANUP_DEFAULTS, mode: "clear", providers: ["claude", "codex"] },
    lastTurnEndedAt: at(NOW - 26 * MIN),
  };
  const mapped = decideCleanupAction(input(codexClear));
  assert.equal(mapped.action, "compact-warm");
  assert.equal(mapped.command, COMPACT_COMMAND);
  assert.match(mapped.reason, /maps to compact/);
  // No acknowledgement needed: nothing is cleared.
  assert.equal(mapped.command === CLEAR_COMMAND, false);
  const coldCodex = decideCleanupAction(
    input({ ...codexClear, lastTurnEndedAt: at(NOW - 45 * MIN) }),
  );
  assert.equal(coldCodex.action, "fresh-recommended");
  assert.match(coldCodex.reason, /already passed the 30m/);
});

test("quota gates the compact; unknown quota fails closed, clear stays free", () => {
  assert.match(
    decideCleanupAction(input({ quotaAvailable: false })).reason,
    /quota is exhausted/,
  );
  assert.equal(decideCleanupAction(input({ quotaAvailable: true })).action, "compact-warm");
  assert.match(decideCleanupAction(input({ quotaAvailable: null })).reason, /quota is unknown/);
  assert.match(decideCleanupAction(input({ quotaAvailable: undefined })).reason, /quota is unknown/);
  assert.match(
    decideCleanupAction(
      input({ entry: { needsResume: { reason: "limit", at: at(NOW - MIN) } } }),
    ).reason,
    /limit is flagged/,
  );
  const clearAtLimit = decideCleanupAction(
    input({
      settings: { ...CLEANUP_DEFAULTS, mode: "clear", clearAcknowledged: true },
      lastTurnEndedAt: at(NOW - 2 * HOUR),
      quotaAvailable: false,
      entry: { needsResume: { reason: "limit", at: at(NOW - MIN) } },
    }),
  );
  assert.equal(clearAtLimit.action, "clear");
});

test("efficiency compacts small contexts early, comfort compacts late", () => {
  const small = { contextTokens: 15_000, lastTurnEndedAt: at(NOW - 55 * MIN) };
  assert.equal(
    decideCleanupAction(
      input({ ...small, settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", profile: "efficiency" } }),
    ).action,
    "compact-warm",
  );
  assert.match(decideCleanupAction(input(small)).reason, /below 60000/);
  assert.match(
    decideCleanupAction(
      input({
        lastTurnEndedAt: at(NOW - 55 * MIN),
        settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", profile: "comfort" },
      }),
    ).reason,
    /below 58m/,
  );
  assert.equal(
    decideCleanupAction(
      input({
        lastTurnEndedAt: at(NOW - 59 * MIN),
        settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", profile: "comfort" },
      }),
    ).action,
    "compact-warm",
  );
});

test("package boundaries recommend fresh: idle workers and steers without open workers", () => {
  const worker = decideCleanupAction(
    input({
      labels: { "wsf.scope": "s", "wsf.role": "worker" },
      provider: "codex",
      model: "gpt-6.2-sol",
      lastTurnEndedAt: at(NOW - 26 * MIN),
      entry: { note: "task: x", noteAt: at(NOW - 10 * MIN) },
      settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", providers: ["claude", "codex"] },
    }),
  );
  assert.equal(worker.action, "fresh-recommended");
  assert.equal(worker.command, null);
  assert.match(worker.reason, /worker package done/);
  const boundary = decideCleanupAction(input({ openWorkers: 0 }));
  assert.equal(boundary.action, "fresh-recommended");
  assert.match(boundary.reason, /package boundary: valid checkpoint, no open workers/);
  assert.equal(decideCleanupAction(input({ openWorkers: 2 })).action, "compact-warm");
  // Unknown counts as mid-package, like before the hybrid rule.
  assert.equal(decideCleanupAction(input({ openWorkers: null })).action, "compact-warm");
  assert.equal(decideCleanupAction(input({ openWorkers: undefined })).action, "compact-warm");
  const workerCold = decideCleanupAction(
    input({
      labels: { "wsf.scope": "s", "wsf.role": "worker" },
      provider: "codex",
      model: "gpt-6.2-sol",
      lastTurnEndedAt: at(NOW - 60 * MIN),
      entry: { note: "task: x", noteAt: at(NOW - 59 * MIN) },
      settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", providers: ["claude", "codex"] },
    }),
  );
  assert.equal(workerCold.action, "fresh-recommended");
  assert.match(workerCold.reason, /already passed the 30m/);
});

test("after 2 compactions or a big post-compact base, fresh is recommended", () => {
  const twice = decideCleanupAction(input({ entry: { compactions: 2 } }));
  assert.equal(twice.action, "fresh-recommended");
  assert.match(twice.reason, /already compacted 2 times/);
  assert.equal(decideCleanupAction(input({ entry: { compactions: 1 } })).action, "compact-warm");
  const bigBase = decideCleanupAction(input({ entry: { lastCompactBaseTokens: 60001 } }));
  assert.equal(bigBase.action, "fresh-recommended");
  assert.match(bigBase.reason, /post-compact base 60001 tokens is above 60000/);
  assert.equal(
    decideCleanupAction(input({ entry: { lastCompactBaseTokens: 60000 } })).action,
    "compact-warm",
  );
  // Cold wins over the other fresh reasons.
  const coldAndTwice = decideCleanupAction(
    input({ lastTurnEndedAt: at(NOW - 61 * MIN), entry: { compactions: 5 } }),
  );
  assert.equal(coldAndTwice.action, "fresh-recommended");
  assert.match(coldAndTwice.reason, /already passed the 60m/);
});

test("fresh is recommended once per idle period, without quota or cap gates", () => {
  const hinted = decideCleanupAction(
    input({
      openWorkers: 0,
      entry: { action: { facts: { freshHint: { at: at(NOW - 10 * MIN), reason: "boundary" } } } },
    }),
  );
  assert.equal(hinted.action, null);
  assert.match(hinted.reason, /fresh already recommended after the last turn/);
  // A hint from before the last turn does not block a new one.
  const stale = decideCleanupAction(
    input({
      openWorkers: 0,
      entry: { action: { facts: { freshHint: { at: at(NOW - 2 * HOUR), reason: "boundary" } } } },
    }),
  );
  assert.equal(stale.action, "fresh-recommended");
  // Hints are free: quota and daily cap do not block them.
  const noQuota = decideCleanupAction(input({ openWorkers: 0, quotaAvailable: false }));
  assert.equal(noQuota.action, "fresh-recommended");
  const capped = decideCleanupAction(
    input({
      openWorkers: 0,
      actionsToday: 20,
      settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", dailyCap: 20 },
    }),
  );
  assert.equal(capped.action, "fresh-recommended");
  // ... but a stale hint never blocks a mid-package compact.
  const reopened = decideCleanupAction(
    input({
      openWorkers: 3,
      entry: { action: { facts: { freshHint: { at: at(NOW - 10 * MIN), reason: "boundary" } } } },
    }),
  );
  assert.equal(reopened.action, "compact-warm");
});

test("agents without a valid package state cool untouched", () => {
  assert.match(decideCleanupAction(input({ checkpoint: null })).reason, /no task checkpoint/);
  assert.match(
    decideCleanupAction(input({ openWorkers: 0, checkpoint: null })).reason,
    /no task checkpoint/,
  );
  assert.match(
    decideCleanupAction(
      input({
        labels: { "wsf.scope": "s", "wsf.role": "worker" },
        checkpoint: null,
        entry: {},
      }),
    ).reason,
    /no note/,
  );
});

test("currentFreshHint keeps only current hints, freshHintText labels the pill", () => {
  assert.equal(currentFreshHint(null), null);
  assert.equal(currentFreshHint(undefined), null);
  assert.equal(currentFreshHint({}), null);
  assert.equal(currentFreshHint({ action: { facts: { freshHint: null } }, lastTurnEndedAt: at(NOW - HOUR) }), null);
  assert.equal(currentFreshHint({ action: { facts: { freshHint: { at: at(NOW - 10 * MIN), reason: "  " } } } }), null);
  assert.equal(currentFreshHint({ action: { facts: { freshHint: { at: "not-a-date", reason: "x" } } } }), null);
  assert.equal(
    currentFreshHint({
      lastTurnEndedAt: at(NOW - HOUR),
      action: { facts: { freshHint: { at: at(NOW - 2 * HOUR), reason: "old" } } },
    }),
    null,
    "recorded before the last turn: stale",
  );
  assert.equal(
    currentFreshHint({
      lastTurnEndedAt: at(NOW - HOUR),
      action: { facts: { freshHint: { at: at(NOW - 10 * MIN), reason: "package\n  boundary" } } },
    }),
    "package boundary",
  );
  assert.equal(
    currentFreshHint({ action: { facts: { freshHint: { at: at(NOW - 10 * MIN), reason: "boundary" } } } }),
    "boundary",
    "unknown last turn keeps the hint, mirroring the resume brief",
  );
  assert.equal(freshHintText(120_000, 55 * MIN), "Chat refresh recommended · 120k · 55m");
  assert.equal(freshHintText(61_200, 2 * HOUR), "Chat refresh recommended · 61k · 2h");
});

test("shouldRewindFresh gates the rewind execution by setting and group", () => {
  const on = { ...CLEANUP_DEFAULTS, rewindFresh: true };
  const off = { ...CLEANUP_DEFAULTS, rewindFresh: false };
  assert.equal(CLEANUP_DEFAULTS.rewindFresh, false, "default off");
  // Codex (compact-only groups) with the setting on.
  assert.equal(
    shouldRewindFresh({ action: "fresh-recommended", provider: "codex", model: "gpt-6.2-sol", settings: on }),
    true,
  );
  assert.equal(
    shouldRewindFresh({ action: "fresh-recommended", provider: "codex", model: "gpt-5.5", settings: on }),
    true,
  );
  // Setting off: hint only.
  assert.equal(
    shouldRewindFresh({ action: "fresh-recommended", provider: "codex", model: "gpt-6.2-sol", settings: off }),
    false,
  );
  assert.equal(
    shouldRewindFresh({ action: "fresh-recommended", provider: "codex", model: "gpt-6.2-sol", settings: CLEANUP_DEFAULTS }),
    false,
  );
  // Claude keeps its native /clear even with the setting on.
  assert.equal(
    shouldRewindFresh({ action: "fresh-recommended", provider: "claude", model: null, settings: on }),
    false,
  );
  // Other groups and other actions never rewind.
  assert.equal(
    shouldRewindFresh({ action: "fresh-recommended", provider: "muse", model: "m", settings: on }),
    false,
  );
  assert.equal(
    shouldRewindFresh({ action: "compact-warm", provider: "codex", model: "gpt-6.2-sol", settings: on }),
    false,
  );
  assert.equal(
    shouldRewindFresh({ action: null, provider: "codex", model: "gpt-6.2-sol", settings: on }),
    false,
  );
});
