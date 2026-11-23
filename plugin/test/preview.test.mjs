import test from "node:test";
import assert from "node:assert/strict";
import {
  isPlanHash,
  shortHash,
  fingerprintOf,
  switchFingerprint,
  checkpointFingerprint,
  freshFingerprint,
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

test("switchFingerprint binds repo, slots and epoch", () => {
  const id = { repo: "o/r", from: "A", to: "B", epoch: 3 };
  const base = switchFingerprint(id);
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(switchFingerprint({ ...id }), base);
  assert.notEqual(switchFingerprint({ ...id, epoch: 4 }), base);
  assert.notEqual(switchFingerprint({ ...id, to: "C" }), base);
  assert.notEqual(switchFingerprint({ ...id, from: "B" }), base);
  assert.notEqual(switchFingerprint({ ...id, repo: "o/other" }), base);
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

test("freshFingerprint binds repo, slot and epoch", () => {
  const id = { repo: "o/r", slot: "A", epoch: 3 };
  const base = freshFingerprint(id);
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(freshFingerprint({ ...id }), base);
  assert.notEqual(freshFingerprint({ ...id, epoch: 4 }), base);
  assert.notEqual(freshFingerprint({ ...id, slot: "B" }), base);
  assert.notEqual(freshFingerprint({ ...id, repo: "o/other" }), base);
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
