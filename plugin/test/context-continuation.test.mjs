import assert from "node:assert/strict";
import test from "node:test";
import { attentionStatus, contextActionFor } from "../shared/context-continuation.ts";

const policy = { ttlMinutes: 30, minContextTokens: 60_000 };
const warm = {
  slot: "A",
  reason: "failed",
  idleMinutes: 29,
  contextTokens: 59_999,
  freshHint: null,
};

test("unflagged or warm chats can continue after a failure or a limit", () => {
  assert.equal(contextActionFor(null, policy), "continue");
  assert.equal(contextActionFor(warm, policy), "continue");
  assert.equal(contextActionFor({ ...warm, reason: "limit" }, policy), "continue");
});

test("cold or large contexts refresh even when a failure or limit supplies the pill label", () => {
  assert.equal(contextActionFor({ ...warm, idleMinutes: 30 }, policy), "refresh");
  assert.equal(contextActionFor({ ...warm, reason: "limit", contextTokens: 60_000 }, policy), "refresh");
  assert.equal(contextActionFor({ ...warm, reason: "cold" }, policy), "refresh");
  assert.equal(contextActionFor({ ...warm, reason: undefined }, policy), "refresh");
});

test("a restart or saved refresh recommendation refreshes even a small, recent context", () => {
  assert.equal(contextActionFor({ ...warm, reason: "daemon-restart" }, policy), "refresh");
  assert.equal(contextActionFor({ ...warm, freshHint: "package boundary" }, policy), "refresh");
});

test("an agent without a refresh target never offers ordinary continuation for flagged cold context", () => {
  assert.equal(contextActionFor({ ...warm, reason: "cold", slot: null }, policy), "unavailable");
  assert.equal(contextActionFor({ ...warm, slot: null }, policy), "continue");
});

test("status reports a plain-language reason without exposing stored cleanup diagnostics", () => {
  const cold = { ...warm, reason: "cold", idleMinutes: 120 };
  assert.equal(attentionStatus(cold), "Kontext kalt · seit 2 h inaktiv");
  assert.equal(attentionStatus({ ...cold, freshHint: "package boundary" }), "Auffrischen empfohlen");
  assert.equal(attentionStatus({ ...cold, reason: "limit", freshHint: "package boundary" }), "Nutzungslimit erreicht");
  assert.equal(attentionStatus({ ...cold, reason: "daemon-restart" }), "Paseo wurde neu gestartet");
});
