import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { LABEL, METADATA_KEY } from "../server/core/paseo.mjs";
import { AGENTS_KEY, CHECKPOINT_AGENTS_KEY } from "../server/core/agent-state.mjs";
import { effectReceiptKey } from "../server/core/steer-action.mjs";
import { WORKERS_KEY } from "../server/core/supervision.mjs";

register("./ts-resolve-hooks.mjs", import.meta.url);
const { runBootCheck, readDaemonStartedAtViaCli } = await import("../server/boot-check.ts");

const bootCheck = readFileSync(new URL("../server/boot-check.ts", import.meta.url), "utf8");
const serverEntry = readFileSync(new URL("../index.server.ts", import.meta.url), "utf8");
const turnHook = readFileSync(new URL("../server/turn-hook.ts", import.meta.url), "utf8");
const autoCheckpoint = readFileSync(new URL("../shared/auto-checkpoint.ts", import.meta.url), "utf8");

test("boot check marks daemon-restart interruptions idempotently", () => {
  for (const name of ["runBootCheck", "ensureBootChecked", "readDaemonStartedAtViaCli", "resetBootCheckForTests"]) {
    assert.ok(
      bootCheck.includes(`export async function ${name}`) || bootCheck.includes(`export function ${name}`),
      `boot-check.ts exports ${name}`,
    );
  }
  assert.ok(bootCheck.includes('["daemon", "status", "--json"]'), "daemon start comes from `paseo daemon status --json`");
  assert.ok(bootCheck.includes("startedAt"), "real daemon status field startedAt is read");
  assert.ok(bootCheck.includes('reason: "daemon-restart"'), "interrupted carries reason daemon-restart");
  assert.ok(bootCheck.includes("isOpenTurnBeforeRestart"), "uses the synced open-turn decision");
  assert.ok(bootCheck.includes("buildRestartInterrupted"), "uses the synced C2-shaped record builder");
  assert.ok(bootCheck.includes("openTurnId: null"), "clears the open turn so a second start finds nothing");
  assert.ok(bootCheck.includes("turnStartedAt: null"), "clears the turn start");
});

test("server entry runs the boot check and tracks turn starts", () => {
  assert.ok(serverEntry.includes('ensureBootChecked'), "server entry calls the boot check");
  assert.ok(serverEntry.includes('"agent.turn.before"'), "server entry registers agent.turn.before");
  assert.ok(serverEntry.includes('"agent.turn.after"'), "server entry keeps agent.turn.after");
  assert.ok(serverEntry.includes('handleTurnBefore'), "turn.before handler is wired");
  assert.ok(serverEntry.includes('removeTurnBefore'), "turn.before remover is cleaned up");
});

test("turn hooks store the open turn and clear it afterwards", () => {
  assert.ok(turnHook.includes('export async function handleTurnBefore'), "turn-hook.ts exports handleTurnBefore");
  assert.ok(turnHook.includes('openTurnId'), "turn.before stores openTurnId");
  assert.ok(turnHook.includes('turnStartedAt'), "turn.before stores turnStartedAt");
  assert.ok(turnHook.includes('updateAgentEntry'), "turn.before writes through the synced agent-state helper");
  assert.ok(autoCheckpoint.includes('openTurnId: null'), "turn.after clears openTurnId via the shared decision");
  assert.ok(autoCheckpoint.includes('turnStartedAt: null'), "turn.after clears turnStartedAt");
});

test("daemon status runs without --host (host view has no startedAt) and logs errors", () => {
  const body = bootCheck.slice(bootCheck.indexOf("export function readDaemonStartedAtViaCli"));
  assert.ok(!body.slice(0, body.indexOf("async function defaultReadExcerpt")).includes("--host"), "no --host");
  assert.ok(!bootCheck.includes("createPaseoCli"), "createPaseoCli always adds --host");
  assert.ok(bootCheck.includes("daemon status failed"), "errors are logged, not swallowed");
});

// Recorded key shapes of `paseo daemon status --json` (Paseo 0.16.2, keys only).
const LOCAL = JSON.stringify({ home: "h", pid: 1, startedAt: "2026-01-01T00:00:00.000Z", listen: "x", daemonVersion: "0.16.2" });
const HOST = JSON.stringify({ host: "h:1", serverId: "s", daemonVersion: "0.16.2", connectedDaemon: {} });

test("reads startedAt from the local status shape and never passes --host", () => {
  const calls = [];
  const got = readDaemonStartedAtViaCli((bin, args) => { calls.push([bin, args]); return LOCAL; }, () => {}, "paseo");
  assert.equal(got, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(calls, [["paseo", ["daemon", "status", "--json"]]]);
});

test("host-view shape (the former bug) yields null with a log line", () => {
  const logs = [];
  assert.equal(readDaemonStartedAtViaCli(() => HOST, (m) => logs.push(m), "paseo"), null);
  assert.match(logs[0], /no startedAt/);
});

test("runner errors are logged and return null", () => {
  const logs = [];
  const got = readDaemonStartedAtViaCli(() => { throw new Error("spawn paseo ENOENT"); }, (m) => logs.push(m), "paseo");
  assert.equal(got, null);
  assert.match(logs[0], /daemon status failed \(spawn paseo ENOENT\)/);
});

const SCOPE = "owner/repo";
const START = "2026-11-27T09:00:00.000Z";
const END = "2026-11-27T09:05:00.000Z";
const RESTART = "2026-11-27T09:10:00.000Z";
const NOW = "2026-11-27T09:15:00.000Z";

function recoveryWorld(entries, receipts = {}) {
  const workspace = {
    id: "workspace-1",
    workspaceDirectory: "/repo",
    metadata: {
      [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 3, scope: { id: SCOPE, kind: "github", locator: SCOPE } },
      [AGENTS_KEY]: structuredClone(entries),
      [CHECKPOINT_AGENTS_KEY]: { task: "Steer task" },
      [WORKERS_KEY]: { worker: { task: "Worker task", state: "partial" } },
      ...receipts,
    },
  };
  const agents = [
    { id: "steer", workspaceId: workspace.id, status: "closed", labels: { [LABEL.scope]: SCOPE, [LABEL.role]: "steer", [LABEL.slot]: "A" } },
    { id: "worker", workspaceId: workspace.id, status: "closed", metadata: { "wsf.worker": { scopeId: SCOPE, task: "Worker task" } } },
  ];
  const writes = [];
  const paseo = {
    projects: { list: async () => ({ projects: [] }) },
    workspaces: {
      list: async () => ({ entries: [structuredClone(workspace)] }),
      ref: () => ({
        refresh: async () => structuredClone(workspace),
        setMetadata: async (patch) => {
          writes.push(structuredClone(patch));
          Object.assign(workspace.metadata, structuredClone(patch));
        },
      }),
    },
    agents: { list: async () => ({ entries: agents }) },
    providers: { snapshot: async () => ({ entries: [] }) },
  };
  const boot = (overrides) => runBootCheck({
    paseo, getDaemonStartedAt: () => RESTART, now: () => NOW, log: () => {},
    lock: (_id, fn) => fn({ verify() {} }), readExcerpt: async () => "partial output", readGit: () => null,
    ...overrides,
  });
  return { boot, workspace, writes };
}

test("boot clears stale open markers for recorded terminal turns and preserves their outcomes", async () => {
  for (const outcome of ["completed", "failed", "canceled"]) {
    const terminal = { lastTurnId: "same-turn", lastTurnEndedAt: END, outcome,
      interrupted: outcome === "completed" ? null : { at: END, outcome, error: "Original outcome" } };
    const entry = { ...terminal, openTurnId: "same-turn", turnStartedAt: START };
    const { boot, workspace, writes } = recoveryWorld({ worker: entry });
    let excerpts = 0;
    const marks = await boot({ readExcerpt: async () => { excerpts++; return null; } });
    assert.deepEqual(marks, []);
    assert.equal(excerpts, 0);
    assert.deepEqual(workspace.metadata[AGENTS_KEY].worker, { ...terminal, openTurnId: null, turnStartedAt: null });
    assert.deepEqual(workspace.metadata[CHECKPOINT_AGENTS_KEY], { task: "Steer task" });
    assert.equal(workspace.metadata[WORKERS_KEY].worker.state, "partial");
    assert.deepEqual(await boot(), []);
    assert.equal(writes.length, 1);
  }
});

test("boot marks a metadata-identified worker with a genuinely unrecorded terminal outcome", async () => {
  const { boot, workspace, writes } = recoveryWorld({
    worker: { lastTurnId: "earlier-turn", lastTurnEndedAt: START, openTurnId: "open-turn", turnStartedAt: END },
  });
  const [mark] = await boot();
  assert.equal(mark.agentId, "worker");
  assert.equal(mark.cause, "interrupted");
  const entry = workspace.metadata[AGENTS_KEY].worker;
  assert.equal(entry.lastTurnId, "open-turn");
  assert.equal(entry.interrupted.reason, "daemon-restart");
  assert.equal(entry.interrupted.excerpt, "partial output");
  assert.equal(entry.openTurnId, null);
  assert.deepEqual(await boot(), []);
  assert.equal(writes.length, 1);
});

test("boot rechecks the turn generation under the lock before applying an excerpt", async () => {
  const { boot, workspace, writes } = recoveryWorld({ worker: { openTurnId: "first", turnStartedAt: START } });
  const marks = await boot({
    readExcerpt: async () => {
      workspace.metadata[AGENTS_KEY].worker = { openTurnId: "other", turnStartedAt: END };
      return "first turn excerpt";
    },
  });
  assert.deepEqual(marks, []);
  assert.deepEqual(writes, []);
  assert.equal(workspace.metadata[AGENTS_KEY].worker.openTurnId, "other");
});

test("boot parks real standalone cleanup intents and preserves receipt-bearing actions", async () => {
  const cleanup = { kind: "cleanup", wakeId: "cleanup", phase: "renewing",
    cleanup: { kind: "clear", at: START, messageId: "cleanup" } };
  const rewind = { kind: "rewind", wakeId: "rewind", phase: "rewinding", queuedAt: START, packet: "exact brief" };
  const send = { kind: "delivery", wakeId: "send", phase: "uncertain", queuedAt: START, attemptedAt: START, packet: "exact wake" };
  const sent = { ...send, wakeId: "sent", phase: "sent", observedAt: END };
  const recentRewind = { kind: "delivery", wakeId: "recent-rewind", phase: "renewing", queuedAt: START,
    rewindAttempt: { at: NOW, phase: "uncertain" } };
  const receipts = { [effectReceiptKey("rewind")]: { kind: "rewind", at: END }, [effectReceiptKey("send")]: { kind: "send", at: END } };
  const { boot, workspace, writes } = recoveryWorld({
    steer: { action: cleanup },
    rewind: { action: rewind },
    send: { action: send },
    sent: { action: sent },
    recent: { action: recentRewind },
    protected: { action: { ...rewind, wakeId: "unconfirmed-rewind" } },
  }, receipts);
  await boot();
  const entries = workspace.metadata[AGENTS_KEY];
  assert.equal(entries.steer.action.phase, "blocked");
  assert.equal(entries.steer.action.cleanup.uncertain, true);
  assert.equal(entries.steer.action.cleanup.messageId, cleanup.cleanup.messageId);
  assert.match(entries.steer.action.cleanup.error, /restarted before cleanup was confirmed/);
  assert.deepEqual(entries.rewind.action, rewind);
  assert.deepEqual(entries.send.action, send);
  assert.deepEqual(entries.sent.action, sent);
  assert.deepEqual(entries.recent.action, recentRewind);
  assert.equal(entries.protected.action.phase, "uncertain");
  for (const [key, receipt] of Object.entries(receipts)) assert.deepEqual(workspace.metadata[key], receipt);
  await boot();
  assert.equal(writes.length, 1);
});
