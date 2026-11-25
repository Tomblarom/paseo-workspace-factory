import assert from "node:assert/strict";
import test from "node:test";
import { attentionStatus, contextActionFor } from "../shared/context-continuation.ts";

const warm = {
  slot: "A",
  reason: "failed",
  idleMinutes: 29,
  contextTokens: 59_999,
  freshHint: null,
};

test("unflagged or warm chats can continue after a failure or a limit", () => {
  assert.equal(contextActionFor(null), "continue");
  assert.equal(contextActionFor(warm), "continue");
  assert.equal(contextActionFor({ ...warm, reason: "limit" }), "continue");
});

test("cold or large contexts refresh even when a failure or limit supplies the pill label", () => {
  assert.equal(contextActionFor({ ...warm, warmth: "cold" }), "refresh");
  assert.equal(contextActionFor({ ...warm, reason: "limit", large: true }), "refresh");
  assert.equal(contextActionFor({ ...warm, reason: "cold" }), "refresh");
  assert.equal(contextActionFor({ ...warm, reason: undefined }), "refresh");
});

test("a restart or saved refresh recommendation refreshes even a small, recent context", () => {
  assert.equal(contextActionFor({ ...warm, reason: "daemon-restart" }), "refresh");
  assert.equal(contextActionFor({ ...warm, freshHint: "package boundary" }), "refresh");
});

test("an agent without a refresh target never offers ordinary continuation for flagged cold context", () => {
  assert.equal(contextActionFor({ ...warm, reason: "cold", slot: null }), "unavailable");
  assert.equal(contextActionFor({ ...warm, slot: null }), "continue");
});

test("status reports a plain-language reason without exposing stored cleanup diagnostics", () => {
  const cold = { ...warm, reason: "cold", idleMinutes: 120 };
  assert.equal(attentionStatus(cold), "Idle chat · 2 h");
  assert.equal(attentionStatus({ ...cold, freshHint: "package boundary" }), "Chat refresh recommended");
  assert.equal(attentionStatus({ ...cold, reason: "limit", freshHint: "package boundary" }), "Usage limit reached");
  assert.equal(attentionStatus({ ...cold, reason: "daemon-restart" }), "Paseo restarted");
  assert.equal(attentionStatus({ ...cold, reason: "failed" }), "Last reply failed");
});
