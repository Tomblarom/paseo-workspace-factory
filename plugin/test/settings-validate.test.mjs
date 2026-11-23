import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCleanupSettings,
  validateFactorySettings,
  mergeFactoryConfig,
  validateProfilesAgainstCatalogLocal,
} from "../shared/settings-validate.ts";
import { CLEANUP_DEFAULTS } from "../shared/idle-cleanup.ts";

function validSettings() {
  return {
    profiles: {
      "factory-default": { provider: "codex", model: "gpt-6.2-sol", thinking: "high", mode: "full-access" },
      spare: { provider: "codex", model: "gpt-6.2-sol", thinking: null, mode: null },
    },
    slots: { A: "factory-default", B: "spare" },
    prepare: ["A", "B"],
    initialActive: "A",
    workerDefault: "spare",
  };
}

test("validateFactorySettings accepts a complete document", () => {
  assert.deepEqual(validateFactorySettings(validSettings()), []);
  assert.deepEqual(
    validateFactorySettings({
      profiles: { d: { provider: "p", model: "m", thinking: null, mode: null } },
      slots: { A: "d" },
      prepare: ["A"],
      initialActive: "A",
      workerDefault: "d",
    }),
    [],
  );
});

test("validateFactorySettings reports structural problems", () => {
  assert.match(JSON.stringify(validateFactorySettings(null)), /object/);
  const empty = validSettings();
  empty.profiles = {};
  assert.match(JSON.stringify(validateFactorySettings(empty)), /at least one profile/);

  const badSlot = validSettings();
  badSlot.slots = { ab: "factory-default" };
  assert.match(JSON.stringify(validateFactorySettings(badSlot)), /single capital letter/);

  const badRef = validSettings();
  badRef.slots = { A: "missing" };
  assert.match(JSON.stringify(validateFactorySettings(badRef)), /unknown profile/);

  const badPrepare = validSettings();
  badPrepare.prepare = ["A", "Z"];
  assert.match(JSON.stringify(validateFactorySettings(badPrepare)), /unknown slot/);

  const dupes = validSettings();
  dupes.prepare = ["A", "A"];
  assert.match(JSON.stringify(validateFactorySettings(dupes)), /duplicates/);

  const badActive = validSettings();
  badActive.initialActive = "B";
  badActive.prepare = ["A"];
  assert.match(JSON.stringify(validateFactorySettings(badActive)), /initialActive/);

  const badWorker = validSettings();
  badWorker.workerDefault = "missing";
  assert.match(JSON.stringify(validateFactorySettings(badWorker)), /workerDefault/);

  const badProfile = validSettings();
  badProfile.profiles["factory-default"] = { provider: "", model: "m", thinking: null, mode: null };
  assert.match(JSON.stringify(validateFactorySettings(badProfile)), /provider is required/);

  const badThinking = validSettings();
  badThinking.profiles["factory-default"] = { provider: "p", model: "m", thinking: 42, mode: null };
  assert.match(JSON.stringify(validateFactorySettings(badThinking)), /thinking must be a string or null/);
});

test("mergeFactoryConfig overlays profiles and replaces slots", () => {
  const file = {
    version: 1,
    github: { owner: "o" },
    profiles: {
      keep: { provider: "a", model: "m", thinking: null, mode: null },
      shared: { provider: "old", model: "m", thinking: null, mode: null },
    },
    steers: { slots: { Z: "keep" }, prepare: ["Z"], initialActive: "Z" },
    workers: { defaultProfile: "keep" },
    runtime: { stateDir: "/tmp/x" },
  };
  const snapshot = JSON.parse(JSON.stringify(file));
  const merged = mergeFactoryConfig(file, validSettings());
  assert.deepEqual(file, snapshot);
  assert.deepEqual(merged.profiles.keep, { provider: "a", model: "m", thinking: null, mode: null });
  assert.deepEqual(merged.profiles.shared, { provider: "old", model: "m", thinking: null, mode: null });
  assert.equal(merged.profiles["factory-default"].provider, "codex");
  assert.deepEqual(merged.steers.slots, { A: "factory-default", B: "spare" });
  assert.deepEqual(merged.steers.prepare, ["A", "B"]);
  assert.equal(merged.steers.initialActive, "A");
  assert.equal(merged.workers.defaultProfile, "spare");
  assert.deepEqual(merged.github, { owner: "o" });
  assert.deepEqual(merged.runtime, { stateDir: "/tmp/x" });
});

function catalog() {
  return [
    {
      provider: "codex",
      enabled: true,
      status: "ready",
      models: [{ id: "gpt-6.2-sol", thinkingOptions: [{ id: "high" }] }],
      modes: [{ id: "full-access" }],
    },
    {
      provider: "copilot",
      enabled: true,
      status: "ready",
      models: [{ id: "claude-sonnet-5.5", thinkingOptions: [{ id: "high" }] }],
      modes: [{ id: "allow-all" }],
    },
  ];
}

test("validateProfilesAgainstCatalogLocal matches the CLI semantics", () => {
  const profiles = {
    ok: { provider: "codex", model: "gpt-6.2-sol", thinking: "high", mode: "full-access" },
    plain: { provider: "codex", model: "gpt-6.2-sol", thinking: null, mode: null },
  };
  assert.deepEqual(validateProfilesAgainstCatalogLocal(profiles, catalog(), ["ok", "plain"]), {});

  const missing = validateProfilesAgainstCatalogLocal(profiles, catalog(), ["nope"]);
  assert.match(JSON.stringify(missing), /unknown profile/);

  const badProvider = validateProfilesAgainstCatalogLocal(
    { p: { provider: "ghost", model: "m", thinking: null, mode: null } },
    catalog(),
    ["p"],
  );
  assert.match(JSON.stringify(badProvider), /not configured/);

  const badModel = validateProfilesAgainstCatalogLocal(
    { p: { provider: "codex", model: "ghost", thinking: null, mode: null } },
    catalog(),
    ["p"],
  );
  assert.match(JSON.stringify(badModel), /not offered/);

  const badThinking = validateProfilesAgainstCatalogLocal(
    { p: { provider: "codex", model: "gpt-6.2-sol", thinking: "max", mode: null } },
    catalog(),
    ["p"],
  );
  assert.match(JSON.stringify(badThinking), /not available/);

  const badMode = validateProfilesAgainstCatalogLocal(
    { p: { provider: "codex", model: "gpt-6.2-sol", thinking: null, mode: "ghost" } },
    catalog(),
    ["p"],
  );
  assert.match(JSON.stringify(badMode), /not available/);

  const copilot = validateProfilesAgainstCatalogLocal(
    { p: { provider: "copilot", model: "claude-sonnet-5.5", thinking: "high", mode: null } },
    catalog(),
    ["p"],
  );
  assert.match(JSON.stringify(copilot), /rejects a reasoning effort/);

  const copilotPlain = validateProfilesAgainstCatalogLocal(
    { p: { provider: "copilot", model: "claude-sonnet-5.5", thinking: null, mode: null } },
    catalog(),
    ["p"],
  );
  assert.deepEqual(copilotPlain, {});
});

test("validateProfilesAgainstCatalogLocal honors knownLimits", () => {
  const profiles = {
    p: { provider: "codex", model: "gpt-6.2-sol", thinking: null, mode: "full-access" },
  };
  const limits = [
    { provider: "codex", model: "gpt-6.2-sol", field: "mode", reason: "mode blocked by policy" },
  ];
  const hit = validateProfilesAgainstCatalogLocal(profiles, catalog(), ["p"], limits);
  assert.match(JSON.stringify(hit), /blocked by policy/);

  const miss = validateProfilesAgainstCatalogLocal(
    profiles,
    catalog(),
    ["p"],
    [{ provider: "codex", modelPattern: "^other-", field: "mode", reason: "nope" }],
  );
  assert.deepEqual(miss, {});

  const disabled = validateProfilesAgainstCatalogLocal(
    profiles,
    [{ provider: "codex", enabled: false, status: "ready", models: [], modes: [] }],
    ["p"],
  );
  assert.match(JSON.stringify(disabled), /disabled/);
});

test("validateCleanupSettings accepts the defaults and reports each bad field", () => {
  assert.deepEqual(validateCleanupSettings({ ...CLEANUP_DEFAULTS }), []);
  assert.deepEqual(
    validateCleanupSettings({ ...CLEANUP_DEFAULTS, mode: "clear", clearAcknowledged: true }),
    [],
  );
  assert.match(JSON.stringify(validateCleanupSettings(null)), /object/);
  const bad = {
    ...CLEANUP_DEFAULTS,
    mode: "fresh",
    idleMinutes: 2,
    compactAtMinutes: 0,
    minContextTokens: 10,
    providers: [],
    roles: ["advisor"],
    seedAfterClear: "yes",
    clearAcknowledged: 1,
    dailyCap: 0,
  };
  const errors = validateCleanupSettings(bad);
  assert.match(JSON.stringify(errors), /mode must be off, clear, or compact-warm/);
  assert.match(JSON.stringify(errors), /idleMinutes must be an integer of at least 5/);
  assert.match(JSON.stringify(errors), /compactAtMinutes must be an integer of at least 5/);
  assert.match(JSON.stringify(errors), /minContextTokens must be an integer of at least 1000/);
  assert.match(JSON.stringify(errors), /at least one provider/);
  assert.match(JSON.stringify(errors), /steer or worker/);
  assert.match(JSON.stringify(errors), /seedAfterClear must be a boolean/);
  assert.match(JSON.stringify(errors), /clearAcknowledged must be a boolean/);
  assert.match(JSON.stringify(errors), /dailyCap must be an integer of at least 1/);
});
