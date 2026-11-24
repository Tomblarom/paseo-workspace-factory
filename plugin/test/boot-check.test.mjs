// Static regression test for P1 wiring: server files import the synced core
// through `.js` specifiers (Bundler maps them to `.ts` at compile time), so
// plain node:test cannot import them. Instead the wiring is pinned here and
// the decision logic is covered by test/boot-restart.test.mjs plus the
// auto-checkpoint clearing test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

// Behavioural tests: extract the parse/read functions (core imports use .js
// specifiers and cannot load under plain node:test) by transpiling the slice.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
async function loadReader() {
  const ts = require("typescript");
  const start = bootCheck.indexOf("export function parseDaemonStartedAt");
  const end = bootCheck.indexOf("async function defaultReadExcerpt");
  const src = "const execFileSync = () => { throw new Error('no real exec'); };\nconst paseoBinary = () => '/bin/paseo';\n" +
    bootCheck.slice(start, end);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

// Recorded key shapes of `paseo daemon status --json` (Paseo 0.16.2, keys only).
const LOCAL = JSON.stringify({ home: "h", pid: 1, startedAt: "2026-01-01T00:00:00.000Z", listen: "x", daemonVersion: "0.16.2" });
const HOST = JSON.stringify({ host: "h:1", serverId: "s", daemonVersion: "0.16.2", connectedDaemon: {} });

test("reads startedAt from the local status shape and never passes --host", async () => {
  const { readDaemonStartedAtViaCli } = await loadReader();
  const calls = [];
  const got = readDaemonStartedAtViaCli((bin, args) => { calls.push([bin, args]); return LOCAL; }, () => {}, "paseo");
  assert.equal(got, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(calls, [["paseo", ["daemon", "status", "--json"]]]);
});

test("host-view shape (the former bug) yields null with a log line", async () => {
  const { readDaemonStartedAtViaCli } = await loadReader();
  const logs = [];
  assert.equal(readDaemonStartedAtViaCli(() => HOST, (m) => logs.push(m), "paseo"), null);
  assert.match(logs[0], /no startedAt/);
});

test("runner errors are logged and return null", async () => {
  const { readDaemonStartedAtViaCli } = await loadReader();
  const logs = [];
  const got = readDaemonStartedAtViaCli(() => { throw new Error("spawn paseo ENOENT"); }, (m) => logs.push(m), "paseo");
  assert.equal(got, null);
  assert.match(logs[0], /daemon status failed \(spawn paseo ENOENT\)/);
});
