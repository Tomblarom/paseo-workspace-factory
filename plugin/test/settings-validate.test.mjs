import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

// Shared modules import each other through `.js` specifiers, so
// they must load dynamically after the resolve hook is registered.
const {
  validateCleanupSettings,
  validateFactorySettings,
  configFromSettings,
  validateProfilesAgainstCatalogLocal,
} = await import("../shared/settings-validate.ts");

const { CLEANUP_DEFAULTS } = await import("../shared/idle-cleanup.ts");

function validSettings() {
  return {
    profiles: {
      "factory-default": { provider: "codex", model: "gpt-6.2-sol", thinking: "high", mode: "full-access" },
      spare: { provider: "codex", model: "gpt-6.2-sol", thinking: null, mode: null },
    },
    slots: { A: "factory-default", B: "spare" },
    prepare: ["A", "B"],
    initialActive: "A",
    workerPriority: ["spare"],
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
      workerPriority: ["d"],
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
  badWorker.workerPriority = ["missing"];
  assert.match(JSON.stringify(validateFactorySettings(badWorker)), /workerPriority/);

  const badProfile = validSettings();
  badProfile.profiles["factory-default"] = { provider: "", model: "m", thinking: null, mode: null };
  assert.match(JSON.stringify(validateFactorySettings(badProfile)), /provider is required/);

  const badThinking = validSettings();
  badThinking.profiles["factory-default"] = { provider: "p", model: "m", thinking: 42, mode: null };
  assert.match(JSON.stringify(validateFactorySettings(badThinking)), /thinking must be a string or null/);
});

test("configFromSettings builds the effective config from settings only", () => {
  const settings = {
    ...validSettings(),
    githubOwner: "octocat",
    checkoutRoot: "/tmp/x",
    quota: { exhaustedPct: 95, warnPct: 75 },
  };
  const snapshot = JSON.parse(JSON.stringify(settings));
  const config = configFromSettings(settings);
  assert.deepEqual(settings, snapshot);
  assert.equal(config.version, 1);
  assert.deepEqual(config.github, { owner: "octocat", cloneProtocol: "https", upstreamRemote: "upstream" });
  assert.equal(config.checkoutRoot, "/tmp/x");
  assert.equal(config.workspaceTitle, "Main");
  assert.equal(config.profiles["factory-default"].provider, "codex");
  assert.deepEqual(config.steers.slots, { A: "factory-default", B: "spare" });
  assert.deepEqual(config.steers.prepare, ["A", "B"]);
  assert.equal(config.steers.initialActive, "A");
  assert.equal(config.workers.defaultProfile, "spare");
  assert.deepEqual(config.workers.priority, ["spare"]);
  assert.deepEqual(config.quota, { exhaustedPct: 95, warnPct: 75 });
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
    profile: "turbo",
    idleMinutes: 2,
    minContextTokens: 10,
    providers: [],
    roles: ["advisor"],
    clearAcknowledged: 1,
    rewindFresh: "yes",
    dailyCap: 0,
  };
  const errors = validateCleanupSettings(bad);
  assert.match(JSON.stringify(errors), /mode must be off, clear, or compact-warm/);
  assert.match(JSON.stringify(errors), /profile must be efficiency, balanced, or comfort/);
  assert.match(JSON.stringify(errors), /idleMinutes must be an integer of at least 5/);
  assert.match(JSON.stringify(errors), /minContextTokens must be an integer of at least 1000/);
  assert.match(JSON.stringify(errors), /at least one provider/);
  assert.match(JSON.stringify(errors), /steer or worker/);
  assert.match(JSON.stringify(errors), /clearAcknowledged must be a boolean/);
  assert.match(JSON.stringify(errors), /rewindFresh must be a boolean/);
  assert.match(JSON.stringify(errors), /dailyCap must be an integer of at least 1/);
});

test("factory-cleanup v1 -> v2 drops compactAtMinutes and defaults the profile", async () => {
  const { factoryCleanupSettings, migrateFactoryCleanup } = await import("../shared/settings.ts");
  assert.equal(factoryCleanupSettings.version, 2);
  const v1 = { ...CLEANUP_DEFAULTS, compactAtMinutes: 50 };
  delete v1.profile;
  const migrated = migrateFactoryCleanup(v1, 1);
  assert.equal("compactAtMinutes" in migrated, false);
  assert.equal(migrated.mode, v1.mode);
  const parsed = factoryCleanupSettings.schema.parse(migrated);
  assert.equal(parsed.profile, "balanced");
  assert.deepEqual(factoryCleanupSettings.schema.parse({}), { ...CLEANUP_DEFAULTS });
  assert.equal(migrateFactoryCleanup({ a: 1 }, 2).a, 1);
});

test("validateCleanupSettings and the schema cover rewindFresh (default off)", async () => {
  const { factoryCleanupSettings } = await import("../shared/settings.ts");
  assert.equal(CLEANUP_DEFAULTS.rewindFresh, false);
  assert.deepEqual(validateCleanupSettings({ ...CLEANUP_DEFAULTS }), []);
  assert.deepEqual(validateCleanupSettings({ ...CLEANUP_DEFAULTS, rewindFresh: true }), []);
  assert.match(
    JSON.stringify(validateCleanupSettings({ ...CLEANUP_DEFAULTS, rewindFresh: "yes" })),
    /rewindFresh must be a boolean/,
  );
  assert.equal(factoryCleanupSettings.schema.parse({}).rewindFresh, false);
  // Stored v2 documents without the new key parse with the default.
  const stored = { ...CLEANUP_DEFAULTS };
  delete stored.rewindFresh;
  assert.equal(factoryCleanupSettings.schema.parse(stored).rewindFresh, false);
});

test("removed settings keys are ignored silently (old installs)", async () => {
  const { factoryCleanupSettings, factoryConfigSettings } = await import("../shared/settings.ts");
  // Old factory-config documents with the removed quotaSampleMinutes copy.
  const oldConfig = { ...validSettings(), quota: { exhaustedPct: 95, warnPct: 75 }, quotaSampleMinutes: 10 };
  assert.deepEqual(validateFactorySettings(oldConfig), []);
  const parsedConfig = factoryConfigSettings.schema.parse(oldConfig);
  assert.equal("quotaSampleMinutes" in parsedConfig, false);
  // Old factory-cleanup documents with the removed seedAfterClear key.
  const oldCleanup = { ...CLEANUP_DEFAULTS, seedAfterClear: true };
  assert.deepEqual(validateCleanupSettings(oldCleanup), []);
  const parsedCleanup = factoryCleanupSettings.schema.parse(oldCleanup);
  assert.equal("seedAfterClear" in parsedCleanup, false);
});
