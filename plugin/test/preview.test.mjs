import test from "node:test";
import assert from "node:assert/strict";
import {
  isPlanHash,
  shortHash,
  fingerprintOf,
  switchFingerprint,
  checkpointFingerprint,
  freshFingerprint,
  labelsFingerprint,
} from "../shared/preview.ts";

test("isPlanHash accepts 16 lowercase hex only", () => {
  assert.equal(isPlanHash("0123456789abcdef"), true);
  assert.equal(isPlanHash("0123456789ABCDEF"), false);
  assert.equal(isPlanHash("0123456789abcde"), false);
  assert.equal(isPlanHash("0123456789abcdef0"), false);
  assert.equal(isPlanHash(""), false);
  assert.equal(isPlanHash("zzzzzzzzzzzzzzzz"), false);
});

test("shortHash is stable hex and discriminates", () => {
  const a = shortHash("hello");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(shortHash("hello"), a);
  assert.notEqual(shortHash("hello!"), a);
  assert.notEqual(shortHash(""), a);
});

test("fingerprintOf ignores key order but not values or array order", () => {
  assert.equal(fingerprintOf({ a: 1, b: 2 }), fingerprintOf({ b: 2, a: 1 }));
  assert.equal(
    fingerprintOf({ a: { x: [1, 2], y: null } }),
    fingerprintOf({ a: { y: null, x: [1, 2] } }),
  );
  assert.notEqual(fingerprintOf({ a: 1 }), fingerprintOf({ a: 2 }));
  assert.notEqual(fingerprintOf({ a: [1, 2] }), fingerprintOf({ a: [2, 1] }));
  assert.notEqual(fingerprintOf({ a: 1 }), fingerprintOf({ a: 1, b: null }));
});

test("switchFingerprint binds repo, slots, holders, workspace, epoch and checkpoint", () => {
  const id = {
    repo: "o/r",
    workspaceId: "wks_main",
    from: "A",
    to: "B",
    fromId: "agt_from",
    toId: "agt_to",
    epoch: 3,
    checkpointAt: "2026-11-25T10:00:00.000Z",
  };
  const base = switchFingerprint(id);
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(switchFingerprint({ ...id }), base);
  assert.notEqual(switchFingerprint({ ...id, epoch: 4 }), base);
  assert.notEqual(switchFingerprint({ ...id, to: "C" }), base);
  assert.notEqual(switchFingerprint({ ...id, from: "B" }), base);
  assert.notEqual(switchFingerprint({ ...id, repo: "o/other" }), base);
  assert.notEqual(switchFingerprint({ ...id, workspaceId: "wks_other" }), base);
  assert.notEqual(switchFingerprint({ ...id, fromId: "agt_new" }), base);
  assert.notEqual(switchFingerprint({ ...id, toId: "agt_new" }), base);
  assert.notEqual(switchFingerprint({ ...id, checkpointAt: "2026-11-25T11:00:00.000Z" }), base);
  assert.notEqual(switchFingerprint({ ...id, checkpointAt: null }), base);
});

test("checkpointFingerprint binds workspace, epoch and fields", () => {
  const id = {
    repo: "o/r",
    workspaceId: "ws-1",
    epoch: 2,
    task: "do it",
    tests: ["t"],
    blockers: [],
    next: null,
  };
  const base = checkpointFingerprint(id);
  assert.equal(checkpointFingerprint({ ...id }), base);
  assert.notEqual(checkpointFingerprint({ ...id, task: "do other" }), base);
  assert.notEqual(checkpointFingerprint({ ...id, tests: [] }), base);
  assert.notEqual(checkpointFingerprint({ ...id, blockers: ["b"] }), base);
  assert.notEqual(checkpointFingerprint({ ...id, next: "n" }), base);
  assert.notEqual(checkpointFingerprint({ ...id, epoch: 3 }), base);
  assert.notEqual(checkpointFingerprint({ ...id, workspaceId: "ws-2" }), base);
  assert.notEqual(checkpointFingerprint({ ...id, epoch: null }), base);
});

test("checkpoint and assign fingerprints bind the active holder", async () => {
  const { assignFingerprint } = await import("../shared/preview.ts");
  const assignment = { scope: "s", epoch: 1, steerId: "a", task: "t", tests: [], blockers: [], next: null };
  assert.notEqual(assignFingerprint(assignment), assignFingerprint({ ...assignment, steerId: "b" }));
  const checkpoint = { repo: "r", workspaceId: "w", epoch: 1, holderId: "a", task: "t", tests: [], blockers: [], next: null };
  assert.notEqual(checkpointFingerprint(checkpoint), checkpointFingerprint({ ...checkpoint, holderId: "b" }));
});

test("freshFingerprint binds repo, slot, holder, route, settings, epoch and checkpoint", () => {
  const id = {
    repo: "o/r",
    workspaceId: "wks_main",
    slot: "A",
    from: "agt_old",
    epoch: 3,
    refreshMode: "rewind",
    provider: "codex",
    model: "gpt-6.2-sol",
    checkpointAt: "2026-11-25T10:00:00.000Z",
  };
  const base = freshFingerprint(id);
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(freshFingerprint({ ...id }), base);
  assert.notEqual(freshFingerprint({ ...id, epoch: 4 }), base);
  assert.notEqual(freshFingerprint({ ...id, slot: "B" }), base);
  assert.notEqual(freshFingerprint({ ...id, repo: "o/other" }), base);
  assert.notEqual(freshFingerprint({ ...id, workspaceId: "wks_other" }), base);
  assert.notEqual(freshFingerprint({ ...id, from: "agt_new" }), base);
  assert.notEqual(freshFingerprint({ ...id, refreshMode: "new-agent" }), base);
  assert.notEqual(freshFingerprint({ ...id, provider: "claude" }), base);
  assert.notEqual(freshFingerprint({ ...id, model: "other" }), base);
  assert.notEqual(freshFingerprint({ ...id, checkpointAt: null }), base);
});

test("switch and checkpoint fingerprints live in separate domains", () => {
  const switched = switchFingerprint({ repo: "x", from: "A", to: "B", epoch: 1 });
  const checked = checkpointFingerprint({
    repo: "x",
    workspaceId: "A",
    epoch: 1,
    task: "B",
    tests: [],
    blockers: [],
    next: null,
  });
  assert.notEqual(switched, checked);
});

test("labelsFingerprint binds the address and the exact rows", () => {
  const rows = [{ agentId: "a1", labels: { "wsf.scope": "web" } }];
  const id = { address: null, rows };
  const base = labelsFingerprint(id);
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(labelsFingerprint({ address: null, rows: structuredClone(rows) }), base);
  assert.notEqual(labelsFingerprint({ address: "web", rows }), base);
  assert.notEqual(labelsFingerprint({ address: null, rows: [] }), base);
  assert.notEqual(
    labelsFingerprint({ address: null, rows: [{ agentId: "a1", labels: { "wsf.scope": "api" } }] }),
    base,
  );
  assert.notEqual(
    labelsFingerprint({ address: null, rows }),
    switchFingerprint({ repo: "x", from: "A", to: "B", epoch: 1 }),
  );
});
