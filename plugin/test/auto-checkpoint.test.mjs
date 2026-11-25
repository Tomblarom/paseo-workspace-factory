import test from "node:test";
import assert from "node:assert/strict";
import {
  checkRace,
  cleanupCommandKind,
  decideTurnUpdate,
  dropEntries,
  factoryIdentity,
  serializeNote,
  verifyCleanupEffect,
} from "../shared/auto-checkpoint.ts";

const NOW = "2026-11-23T12:00:00.000Z";
const BLOCK = { task: "Ship it", tests: ["npm test"], blockers: ["hub:x"], next: "Release" };
const CLEAR_SEEN = {
  sessionChanged: true,
  compactionSeen: false,
  markerSeen: false,
  sessionNoteSeen: false,
  turnReadable: true,
};
const COMPACT_SEEN = {
  sessionChanged: false,
  compactionSeen: true,
  markerSeen: false,
  sessionNoteSeen: false,
  turnReadable: true,
};

function input(overrides = {}) {
  return {
    agentId: "agent-1",
    slot: "A",
    role: "steer",
    activeSteer: "A",
    archived: false,
    turnId: "turn-1",
    outcome: "completed",
    error: null,
    block: null,
    lastAnswer: null,
    turnUserText: "do the thing",
    git: null,
    contextTokens: 12000,
    epoch: 3,
    checkpoint: null,
    previous: null,
    effect: null,
    now: NOW,
    ...overrides,
  };
}

test("factoryIdentity accepts steers/workers and ignores other labels", () => {
  assert.deepEqual(
    factoryIdentity({ "wsf.scope": "s", "wsf.role": "steer", "wsf.slot": "B" }),
    { scopeId: "s", role: "steer", slot: "B" },
  );
  assert.deepEqual(
    factoryIdentity({ "wsf.scope": "s", "wsf.role": "worker" }),
    { scopeId: "s", role: "worker", slot: null },
  );
  assert.equal(factoryIdentity({ "ari.wsf.scope": "s", "ari.wsf.role": "steer", "ari.wsf.slot": "A" }), null);
  assert.equal(factoryIdentity({ "wsf.scope": "s", "wsf.role": "advisor" }), null);
  assert.equal(factoryIdentity({ "wsf.role": "steer" }), null);
  assert.equal(factoryIdentity(null), null);
});

test("cleanupCommandKind matches bare /clear and /compact turns", () => {
  assert.equal(cleanupCommandKind("/clear"), "clear");
  assert.equal(cleanupCommandKind("  /compact Keep: task."), "compact");
  assert.equal(cleanupCommandKind("/clearly not"), null);
  assert.equal(cleanupCommandKind("please run /clear"), null);
  assert.equal(cleanupCommandKind(null), null);
});

test("completed block of the active steer writes the scope checkpoint", () => {
  const d = decideTurnUpdate(input({ block: BLOCK }));
  assert.deepEqual(d.checkpoint, {
    task: "Ship it",
    tests: ["npm test"],
    blockers: ["hub:x"],
    next: "Release",
    epoch: 3,
    updatedAt: NOW,
    source: "agent",
    agentId: "agent-1",
    turnId: "turn-1",
    capturedAt: NOW,
    interrupted: null,
  });
  assert.deepEqual(d.entryUpdate, {
    lastTurnId: "turn-1",
    lastTurnEndedAt: NOW,
    outcome: "completed",
    contextTokens: 12000,
    openTurnId: null,
    turnStartedAt: null,
    freshHint: null,
    interrupted: null,
    lastActionFailed: null,
  });
  assert.equal(d.patchInterrupted, undefined);
});

test("every turn.after clears the open-turn tracking from turn.before", () => {
  const completed = decideTurnUpdate(input({ block: BLOCK }));
  assert.equal(completed.entryUpdate.openTurnId, null);
  assert.equal(completed.entryUpdate.turnStartedAt, null);
  const failed = decideTurnUpdate(input({ outcome: "failed", error: "x" }));
  assert.equal(failed.entryUpdate.openTurnId, null);
  assert.equal(failed.entryUpdate.turnStartedAt, null);
  const cleanup = decideTurnUpdate(
    input({
      turnUserText: "/clear",
      effect: {
        sessionChanged: true,
        compactionSeen: false,
        markerSeen: false,
        sessionNoteSeen: false,
        turnReadable: true,
      },
      previous: { pendingAction: { kind: "clear", at: "then" } },
    }),
  );
  assert.equal(cleanup.entryUpdate.openTurnId, null);
  assert.equal(cleanup.entryUpdate.turnStartedAt, null);
});

test("completed block of another steer or worker lands in the note", () => {
  const other = decideTurnUpdate(input({ block: BLOCK, activeSteer: "B" }));
  assert.equal(other.checkpoint, undefined);
  assert.equal(other.entryUpdate.note, "task: Ship it\ntests: npm test\nblockers: hub:x\nnext: Release");
  assert.equal(other.entryUpdate.noteAt, NOW);
  const worker = decideTurnUpdate(
    input({ block: BLOCK, role: "worker", slot: null, activeSteer: "A" }),
  );
  assert.equal(worker.checkpoint, undefined);
  assert.ok(String(worker.entryUpdate.note).startsWith("task: Ship it"));
});

test("completed turn without a block lifts the retry block but keeps interrupted", () => {
  const d = decideTurnUpdate(
    input({ previous: { interrupted: { at: "then" }, lastActionFailed: { at: "then", error: "x" } } }),
  );
  assert.equal(d.checkpoint, undefined);
  assert.equal(d.entryUpdate.note, undefined);
  assert.equal(d.entryUpdate.lastTurnId, "turn-1");
  assert.equal(d.entryUpdate.outcome, "completed");
  assert.equal(d.entryUpdate.lastActionFailed, null);
  assert.ok(!("interrupted" in d.entryUpdate), "interrupted must survive a block-less turn");
});

test("failed and canceled turns record interrupted and flag the checkpoint", () => {
  const checkpoint = { task: "Ship it", updatedAt: "old" };
  const git = { branch: "main", sha: "abc123", changes: 2 };
  const failed = decideTurnUpdate(
    input({ outcome: "failed", error: "E1: boom", lastAnswer: "answer tail", git, checkpoint }),
  );
  assert.deepEqual(failed.entryUpdate.interrupted, {
    at: NOW,
    outcome: "failed",
    error: "E1: boom",
    excerpt: "answer tail",
    git,
  });
  assert.deepEqual(failed.patchInterrupted, { agentId: "agent-1", at: NOW });
  assert.equal(failed.checkpoint, undefined);
  const canceled = decideTurnUpdate(input({ outcome: "canceled", error: "user stop", checkpoint }));
  assert.equal(canceled.entryUpdate.interrupted.outcome, "canceled");
  assert.equal(canceled.entryUpdate.interrupted.error, "user stop");
  assert.deepEqual(canceled.patchInterrupted, { agentId: "agent-1", at: NOW });
});

test("interrupted without a task checkpoint skips the scope flag", () => {
  const d = decideTurnUpdate(input({ outcome: "failed", error: "x", checkpoint: null }));
  assert.ok(d.entryUpdate.interrupted);
  assert.equal(d.patchInterrupted, undefined);
  assert.match(d.log, /no scope checkpoint to flag/);
});

test("a completed cleanup turn resolves pendingAction and does nothing else", () => {
  const d = decideTurnUpdate(
    input({
      block: BLOCK,
      turnUserText: "/clear",
      effect: CLEAR_SEEN,
      previous: { pendingAction: { kind: "clear", at: "then" }, note: "keep me" },
    }),
  );
  assert.equal(d.checkpoint, undefined);
  assert.equal(d.entryUpdate.note, undefined);
  assert.ok(!("interrupted" in d.entryUpdate));
  assert.equal(d.resolvePending, true);
  assert.equal(d.effectFailed, undefined);
  assert.equal(d.entryUpdate.lastActionFailed, null);
  assert.equal(d.entryUpdate.actionVerified, true);
  assert.deepEqual(d.entryUpdate.cleared, { at: NOW, mode: "clear", checkpointAt: null });
  const withCp = decideTurnUpdate(
    input({
      turnUserText: "/compact Keep: task.",
      effect: COMPACT_SEEN,
      previous: { pendingAction: { kind: "compact", at: "then" } },
      checkpoint: { task: "t", capturedAt: "cap" },
    }),
  );
  assert.deepEqual(withCp.entryUpdate.cleared, { at: NOW, mode: "compact", checkpointAt: "cap" });
  assert.equal(withCp.entryUpdate.actionVerified, true);
});

test("an unverifiable clear reports failure without recording a reset", () => {
  const d = decideTurnUpdate(
    input({
      turnUserText: "/clear",
      effect: {
        sessionChanged: null,
        compactionSeen: false,
        markerSeen: false,
        sessionNoteSeen: false,
        turnReadable: false,
      },
      previous: { pendingAction: { kind: "clear", at: "then" } },
    }),
  );
  assert.equal(d.resolvePending, true);
  assert.equal(d.effectFailed, false);
  assert.equal(d.entryUpdate.cleared, undefined);
  assert.match(d.entryUpdate.lastActionFailed.error, /could not be confirmed/);
  assert.ok(!("actionVerified" in d.entryUpdate));
});

test("a cleanup turn without effect resolves into lastActionFailed and fails the effect", () => {
  const d = decideTurnUpdate(
    input({
      turnUserText: "/clear",
      effect: { ...CLEAR_SEEN, sessionChanged: false },
      previous: { pendingAction: { kind: "clear", at: "then" } },
      checkpoint: { task: "t" },
    }),
  );
  assert.equal(d.resolvePending, true);
  assert.equal(d.effectFailed, true);
  assert.deepEqual(d.entryUpdate.lastActionFailed, {
    at: NOW,
    error: "clear had no effect (session unchanged)",
  });
  assert.equal(d.entryUpdate.cleared, undefined);
  assert.ok(!("interrupted" in d.entryUpdate));
  assert.equal(d.patchInterrupted, undefined);
  const compact = decideTurnUpdate(
    input({
      turnUserText: "/compact Keep: task.",
      effect: COMPACT_SEEN,
      previous: { pendingAction: { kind: "compact", at: "then" }, actionVerified: true },
    }),
  );
  assert.ok(compact.entryUpdate.cleared, "a verified agent skips the check");
  assert.equal(compact.effectFailed, undefined);
});

test("a failed or canceled cleanup turn resolves pendingAction into lastActionFailed", () => {
  for (const outcome of ["failed", "canceled"]) {
    const d = decideTurnUpdate(
      input({
        outcome,
        error: "boom",
        turnUserText: "/clear",
        previous: { pendingAction: { kind: "clear", at: "then" } },
        checkpoint: { task: "t" },
      }),
    );
    assert.equal(d.resolvePending, true);
    assert.deepEqual(d.entryUpdate.lastActionFailed, { at: NOW, error: "boom" });
    assert.ok(!("interrupted" in d.entryUpdate), "our action is never an interruption");
    assert.equal(d.patchInterrupted, undefined);
    assert.equal(d.effectFailed, undefined);
  }
});

test("verifyCleanupEffect judges each signal", () => {
  const none = {
    sessionChanged: null,
    compactionSeen: false,
    markerSeen: false,
    sessionNoteSeen: false,
    turnReadable: false,
  };
  assert.equal(verifyCleanupEffect("clear", null, null), "unverifiable");
  assert.equal(verifyCleanupEffect("clear", null, none), "unverifiable");
  assert.equal(verifyCleanupEffect("clear", null, { ...none, sessionChanged: true }), "verified");
  assert.equal(verifyCleanupEffect("clear", null, { ...none, sessionNoteSeen: true }), "unverifiable");
  assert.equal(verifyCleanupEffect("clear", null, { ...none, sessionChanged: false }), "failed");
  assert.equal(
    verifyCleanupEffect("clear", null, { ...none, sessionChanged: null, turnReadable: true }),
    "unverifiable",
  );
  assert.equal(verifyCleanupEffect("compact", null, none), "unverifiable");
  assert.equal(verifyCleanupEffect("compact", null, { ...none, compactionSeen: true }), "verified");
  assert.equal(
    verifyCleanupEffect("compact", null, { ...none, markerSeen: true, turnReadable: true }),
    "unverifiable",
  );
  assert.equal(verifyCleanupEffect("compact", { actionVerified: true }, { ...none, turnReadable: true }), "unverifiable");
  assert.equal(
    verifyCleanupEffect("compact", null, { ...none, turnReadable: true }),
    "unverifiable",
  );
  assert.equal(
    verifyCleanupEffect("clear", { actionVerified: true }, { ...none, sessionChanged: false }),
    "failed",
  );
});

test("pendingAction plus an ordinary turn takes the normal path", () => {
  const d = decideTurnUpdate(
    input({ block: BLOCK, previous: { pendingAction: { kind: "clear", at: "then" } } }),
  );
  assert.ok(d.checkpoint);
  assert.equal(d.resolvePending, undefined);
});

test("bounds truncate excerpt, error, and note", () => {
  const d = decideTurnUpdate(
    input({ outcome: "failed", error: "e".repeat(500), lastAnswer: "a".repeat(2000) }),
  );
  assert.equal(d.entryUpdate.interrupted.error.length, 300);
  assert.equal(d.entryUpdate.interrupted.excerpt.length, 1500);
  const failedCleanup = decideTurnUpdate(
    input({
      outcome: "failed",
      error: "e".repeat(500),
      turnUserText: "/clear",
      previous: { pendingAction: { kind: "clear", at: "then" } },
    }),
  );
  assert.equal(failedCleanup.entryUpdate.lastActionFailed.error.length, 300);
  assert.equal(
    serializeNote({ task: "t".repeat(2000), tests: [], blockers: [], next: null }).length,
    1500,
  );
});

test("archived agents drop their entry", () => {
  const d = decideTurnUpdate(input({ archived: true, block: BLOCK }));
  assert.equal(d.dropSelf, true);
  assert.equal(d.entryUpdate, null);
});

test("race check compares epoch and active steer", () => {
  assert.equal(checkRace({ activeSteer: "A", epoch: 3 }, { activeSteer: "A", epoch: 3 }), null);
  assert.match(checkRace({ activeSteer: "A", epoch: 3 }, { activeSteer: "A", epoch: 4 }), /epoch moved 3 → 4/);
  assert.match(checkRace({ activeSteer: "A", epoch: 3 }, { activeSteer: "B", epoch: 3 }), /active steer moved/);
  assert.match(checkRace({ activeSteer: "A", epoch: 3 }, null), /scope state is gone/);
});

test("dropEntries removes archived ids", () => {
  assert.deepEqual(dropEntries({ a: 1, b: 2 }, ["a"]), { b: 2 });
  assert.deepEqual(dropEntries({ a: 1 }, []), { a: 1 });
});

test("a resolved compact spends one warm compaction and arms the base reading", () => {
  const first = decideTurnUpdate(
    input({
      turnUserText: "/compact Keep: task.",
      effect: COMPACT_SEEN,
      previous: { pendingAction: { kind: "compact", at: "then" } },
    }),
  );
  assert.equal(first.entryUpdate.compactions, 1);
  assert.equal(first.entryUpdate.compactionPendingBase, true);
  assert.equal(first.entryUpdate.freshHint, null);
  const second = decideTurnUpdate(
    input({
      turnUserText: "/compact Keep: task.",
      effect: COMPACT_SEEN,
      previous: {
        pendingAction: { kind: "compact", at: "then" },
        compactions: 1,
        lastCompactBaseTokens: 45000,
      },
    }),
  );
  assert.equal(second.entryUpdate.compactions, 2);
  assert.equal(second.entryUpdate.compactionPendingBase, true);
  // The counter stays bounded no matter how often the hint is ignored.
  const capped = decideTurnUpdate(
    input({
      turnUserText: "/compact Keep: task.",
      effect: COMPACT_SEEN,
      previous: { pendingAction: { kind: "compact", at: "then" }, compactions: 99 },
    }),
  );
  assert.equal(capped.entryUpdate.compactions, 99);
  const weird = decideTurnUpdate(
    input({
      turnUserText: "/compact Keep: task.",
      effect: COMPACT_SEEN,
      previous: { pendingAction: { kind: "compact", at: "then" }, compactions: "many" },
    }),
  );
  assert.equal(weird.entryUpdate.compactions, 1);
});

test("a resolved clear wipes the compaction debt and the fresh hint", () => {
  const d = decideTurnUpdate(
    input({
      turnUserText: "/clear",
      effect: CLEAR_SEEN,
      previous: {
        pendingAction: { kind: "clear", at: "then" },
        compactions: 2,
        lastCompactBaseTokens: 70000,
        compactionPendingBase: true,
        freshHint: { at: NOW, reason: "old" },
      },
    }),
  );
  assert.equal(d.entryUpdate.compactions, 0);
  assert.equal(d.entryUpdate.lastCompactBaseTokens, null);
  assert.equal(d.entryUpdate.compactionPendingBase, null);
  assert.equal(d.entryUpdate.freshHint, null);
});

test("the first completed turn after a compact settles the base reading", () => {
  const settled = decideTurnUpdate(
    input({ block: BLOCK, previous: { compactionPendingBase: true }, contextTokens: 64000 }),
  );
  assert.equal(settled.entryUpdate.lastCompactBaseTokens, 64000);
  assert.equal(settled.entryUpdate.compactionPendingBase, null);
  const unknown = decideTurnUpdate(
    input({ block: BLOCK, previous: { compactionPendingBase: true }, contextTokens: null }),
  );
  assert.ok(!("lastCompactBaseTokens" in unknown.entryUpdate));
  assert.equal(unknown.entryUpdate.compactionPendingBase, null);
  const plain = decideTurnUpdate(input({ block: BLOCK }));
  assert.ok(!("lastCompactBaseTokens" in plain.entryUpdate));
  assert.ok(!("compactionPendingBase" in plain.entryUpdate));
  // Failed turns leave the armed reading alone.
  const failed = decideTurnUpdate(
    input({ outcome: "failed", error: "x", previous: { compactionPendingBase: true } }),
  );
  assert.ok(!("compactionPendingBase" in failed.entryUpdate));
});

test("every real turn clears a recorded fresh hint", () => {
  const hinted = { freshHint: { at: NOW, reason: "boundary" } };
  assert.equal(decideTurnUpdate(input({ block: BLOCK, previous: hinted })).entryUpdate.freshHint, null);
  assert.equal(decideTurnUpdate(input({ previous: hinted })).entryUpdate.freshHint, null);
  // A failed cleanup turn keeps the hint: the package did not move.
  const failedCleanup = decideTurnUpdate(
    input({
      outcome: "failed",
      error: "x",
      turnUserText: "/compact Keep: task.",
      effect: COMPACT_SEEN,
      previous: { pendingAction: { kind: "compact", at: "then" }, ...hinted },
    }),
  );
  assert.ok(!("freshHint" in failedCleanup.entryUpdate));
});
