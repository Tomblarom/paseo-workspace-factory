import test from "node:test";
import assert from "node:assert/strict";
import {
  CLEANUP_DEFAULTS,
  CLEAR_COMMAND,
  COMPACT_COMMAND,
  PREVIOUS_SESSIONS_MAX,
  cleanupIdentity,
  cleanupInputOf,
  coldHintText,
  decideCleanupAction,
  hasKeepContext,
  isCold,
  isSupervisionProtectedState,
  pushPreviousSession,
  scanCleanupEvidence,
  sendCleanupCommand,
} from "../shared/idle-cleanup.ts";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const HOUR = 3_600_000;
const at = (ms) => new Date(ms).toISOString();
const LABELS = { "wsf.scope": "s", "wsf.role": "steer", "wsf.slot": "A" };

function input(overrides = {}) {
  return {
    agentId: "agent-1",
    labels: { ...LABELS },
    provider: "claude",
    status: "idle",
    archivedAt: null,
    pendingPermissionCount: 0,
    lastTurnEndedAt: at(NOW - 2 * HOUR),
    contextTokens: 120_000,
    activeSteer: "A",
    checkpoint: { task: "Ship it", capturedAt: at(NOW - HOUR), interrupted: null },
    entry: { lastTurnEndedAt: at(NOW - 2 * HOUR) },
    settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm" },
    actionsToday: 0,
    effectBlocked: false,
    nowMs: NOW,
    ...overrides,
  };
}

test("cleanupIdentity accepts steers/workers incl. legacy labels", () => {
  assert.deepEqual(cleanupIdentity(LABELS), { scopeId: "s", role: "steer", slot: "A" });
  assert.deepEqual(cleanupIdentity({ "wsf.scope": "s", "wsf.role": "worker" }), {
    scopeId: "s",
    role: "worker",
    slot: null,
  });
  assert.deepEqual(
    cleanupIdentity({ "ari.wsf.scope": "s", "ari.wsf.role": "steer", "ari.wsf.slot": "B" }),
    { scopeId: "s", role: "steer", slot: "B" },
  );
  assert.equal(cleanupIdentity({ "wsf.scope": "s", "wsf.role": "advisor" }), null);
  assert.equal(cleanupIdentity({ "wsf.role": "steer" }), null);
  assert.equal(cleanupIdentity(null), null);
});

test("hasKeepContext honors the current and legacy keys", () => {
  assert.equal(hasKeepContext({ "wsf.keepContext": "true" }), true);
  assert.equal(hasKeepContext({ "ari.wsf.keepContext": "true" }), true);
  assert.equal(hasKeepContext({ "wsf.keepContext": "false" }), false);
  assert.equal(hasKeepContext({}), false);
  assert.equal(hasKeepContext(null), false);
});

test("compact-warm acts on a cold active steer with a fresh checkpoint", () => {
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
    input({ settings: { ...CLEANUP_DEFAULTS, mode: "clear", clearAcknowledged: true } }),
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

test("pendingAction and lastActionFailed block retries in the same idle period", () => {
  assert.match(
    decideCleanupAction(input({ entry: { pendingAction: { kind: "clear", at: at(NOW) } } })).reason,
    /already pending/,
  );
  assert.match(
    decideCleanupAction(input({ entry: { lastActionFailed: { at: at(NOW), error: "x" } } })).reason,
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
        checkpoint: { task: "t", capturedAt: at(NOW - HOUR), interrupted: { agentId: "a", at: at(NOW) } },
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
    worker({ note: "task: x", noteAt: at(NOW - HOUR), lastTurnEndedAt: at(NOW - 2 * HOUR) }),
  );
  assert.equal(fresh.action, "compact-warm");
  const otherSteer = decideCleanupAction(
    input({
      labels: { "wsf.scope": "s", "wsf.role": "steer", "wsf.slot": "B" },
      entry: { note: "task: x", noteAt: at(NOW - HOUR) },
    }),
  );
  assert.equal(otherSteer.action, "compact-warm");
});

test("already cleaned and opted-out agents are skipped", () => {
  assert.match(
    decideCleanupAction(input({ entry: { cleared: { at: at(NOW - HOUR), mode: "clear" } } })).reason,
    /already cleaned/,
  );
  assert.ok(
    decideCleanupAction(input({ entry: { cleared: { at: at(NOW - 3 * HOUR), mode: "clear" } } })).action,
    "an older cleaning does not block a new idle period",
  );
  assert.match(
    decideCleanupAction(input({ labels: { ...LABELS, "wsf.keepContext": "true" } })).reason,
    /keepContext/,
  );
});

test("isCold and coldHintText describe the C6 hint", () => {
  const base = { idleMinutes: 60, minContextTokens: 60_000, nowMs: NOW };
  assert.equal(
    isCold({ ...base, lastTurnEndedAt: at(NOW - 2 * HOUR), contextTokens: 120_000 }),
    true,
  );
  assert.equal(isCold({ ...base, lastTurnEndedAt: at(NOW - 10 * 60_000), contextTokens: 120_000 }), false);
  assert.equal(isCold({ ...base, lastTurnEndedAt: at(NOW - 2 * HOUR), contextTokens: 1000 }), false);
  assert.equal(isCold({ ...base, lastTurnEndedAt: null, contextTokens: 120_000 }), false);
  assert.equal(isCold({ ...base, lastTurnEndedAt: at(NOW - 2 * HOUR), contextTokens: null }), false);
  assert.equal(coldHintText(350_000, 2 * HOUR), "Kontext kalt · 350k · 2h");
  assert.equal(coldHintText(61_200, 45 * 60_000), "Kontext kalt · 61k · 45m");
});

test("scanCleanupEvidence finds compaction and session signals", () => {
  assert.deepEqual(scanCleanupEvidence([]), {
    turnReadable: false,
    compactionSeen: false,
    markerSeen: false,
    sessionNoteSeen: false,
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
    sessionNoteSeen: false,
  });
  const notice = [{ item: { type: "notification", level: "info", message: "Switched to a new session" } }];
  assert.equal(scanCleanupEvidence(notice).sessionNoteSeen, true);
  const plain = [{ item: { type: "assistant_message", text: "Sure, I cleared nothing." } }];
  assert.deepEqual(scanCleanupEvidence(plain), {
    turnReadable: true,
    compactionSeen: false,
    markerSeen: false,
    sessionNoteSeen: false,
  });
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
  });
  assert.equal(mapped.agentId, "agent-1");
  assert.equal(mapped.pendingPermissionCount, 2);
  assert.equal(mapped.contextTokens, 120_000);
  assert.equal(mapped.lastTurnEndedAt, at(NOW - HOUR));
  assert.equal(mapped.actionsToday, 3);
  assert.equal(mapped.effectBlocked, true);
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
        entry: { note: "task: x", noteAt: at(NOW - HOUR) },
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
        entry: { note: "task: x", noteAt: at(NOW - HOUR), lastTurnEndedAt: at(NOW - 2 * HOUR) },
        workerState,
      }),
    );
    assert.equal(worker.action, "compact-warm", String(workerState));
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
