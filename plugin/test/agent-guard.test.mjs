import test from "node:test";
import assert from "node:assert/strict";
import { isWorkerAgent, assertSteerContext } from "../shared/agent-guard.ts";

test("isWorkerAgent detects parented and labelled workers", () => {
  assert.equal(isWorkerAgent(null), false);
  assert.equal(isWorkerAgent(undefined), false);
  assert.equal(isWorkerAgent({ parentAgent: null, labels: {} }), false);
  assert.equal(isWorkerAgent({ parentAgent: { id: "a" }, labels: {} }), true);
  assert.equal(isWorkerAgent({ parentAgent: null, labels: { "wsf.role": "worker" } }), true);
  assert.equal(isWorkerAgent({ parentAgent: null, labels: { "wsf.role": "steer" } }), false);
  assert.equal(isWorkerAgent({}), false);
});

test("assertSteerContext throws for workers only", () => {
  assert.throws(
    () => assertSteerContext({ parentAgent: null, labels: { "wsf.role": "worker" } }),
    /not available in workers/,
  );
  assert.throws(
    () => assertSteerContext({ parentAgent: "x", labels: {} }, "Factory"),
    /Factory is not available in workers/,
  );
  assert.doesNotThrow(() => assertSteerContext({ parentAgent: null, labels: {} }));
  assert.doesNotThrow(() => assertSteerContext(null));
});
