import test from "node:test";
import assert from "node:assert/strict";
import { parseFactoryArgs, FACTORY_COMMANDS } from "../shared/factory-args.ts";
import { steerAddFingerprint } from "../shared/preview.ts";

test("steer add parses slot and spec positionals", () => {
  assert.deepEqual(parseFactoryArgs("steer add"), { command: "steerAdd", dryRun: false });
  assert.deepEqual(parseFactoryArgs("steer add C"), { command: "steerAdd", slot: "C", dryRun: false });
  assert.deepEqual(parseFactoryArgs("steer add c"), { command: "steerAdd", slot: "C", dryRun: false });
  assert.deepEqual(parseFactoryArgs("steer add my-profile"), { command: "steerAdd", spec: "my-profile", dryRun: false });
  assert.deepEqual(parseFactoryArgs("steer add codex/gpt-6.2-sol"), { command: "steerAdd", spec: "codex/gpt-6.2-sol", dryRun: false });
  assert.deepEqual(parseFactoryArgs("steer add C codex/gpt-6.2-sol --thinking high --mode auto --profile p --dry-run"), {
    command: "steerAdd",
    slot: "C",
    spec: "codex/gpt-6.2-sol",
    thinking: "high",
    mode: "auto",
    profile: "p",
    dryRun: true,
  });
});

test("steer add rejects bad input with usage", () => {
  assert.throws(() => parseFactoryArgs("steer add C D E"), /at most a slot and a profile/);
  assert.throws(() => parseFactoryArgs("steer add CC my-profile"), /slot letter A-Z first/);
  assert.throws(() => parseFactoryArgs("steer add my-profile --thinking high"), /only go with provider\/model/);
  assert.throws(() => parseFactoryArgs("steer add --thinking high"), /need a provider\/model/);
  assert.throws(() => parseFactoryArgs("steer add C --to B"), /Unknown flag/);
  assert.throws(() => parseFactoryArgs("worker add"), /workers have no add/);
});

test("steer help covers add with runnable examples", () => {
  assert.match(FACTORY_COMMANDS.steer.usage, /add \[slot\] \[profile\|provider\/model\]/);
  for (const example of FACTORY_COMMANDS.steer.examples) {
    if (example.includes("steer add") && !example.includes("<")) parseFactoryArgs(example.replace(/^\/factory /, ""));
  }
});

test("steerAddFingerprint is stable and sensitive to slot, profile, model and account", () => {
  const base = { scope: "Test/scope", repo: "Test/scope", workspaceId: "wks_1", slot: "C", profile: "gamma", provider: "fake-x", model: "x2", thinking: null, mode: null, account: "acc-1" };
  assert.equal(steerAddFingerprint(base), steerAddFingerprint({ ...base }));
  assert.notEqual(steerAddFingerprint(base), steerAddFingerprint({ ...base, slot: "D" }));
  assert.notEqual(steerAddFingerprint(base), steerAddFingerprint({ ...base, profile: "delta" }));
  assert.notEqual(steerAddFingerprint(base), steerAddFingerprint({ ...base, model: "x9" }));
  assert.notEqual(steerAddFingerprint(base), steerAddFingerprint({ ...base, account: "acc-2" }));
});
