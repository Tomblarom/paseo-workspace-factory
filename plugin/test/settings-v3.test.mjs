import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const { factoryConfigSettings, migrateFactoryConfig } = await import("../shared/settings.ts");
const { configFromSettings, settingsFromConfig, validateFactorySettings } = await import("../shared/settings-validate.ts");
const { isAdvisorSlot, isAdvisorSteer, isSensitiveProfile, validateConfig } = await import("../server/core/config.mjs");
const { LABEL } = await import("../server/core/paseo.mjs");
const { buildSteerCreate } = await import("../server/core/steer-create.mjs");

const profile = (overrides = {}) => ({
  provider: "codex", model: "model", thinking: "high", mode: "full", advisor: false, sensitive: false, ...overrides,
});
const legacy = () => ({
  profiles: {
    original: profile(),
    same: profile(),
    advisor: profile({ advisor: true }),
    private: profile({ sensitive: true }),
    different: profile({ thinking: "low" }),
    unused: profile({ model: "other" }),
  },
  slots: { F: "different", E: "private", D: "advisor", C: "same", B: "original", A: "same" },
  prepare: ["B", "D"],
  initialActive: "B",
  workerPriority: ["unused", "original"],
  quota: { warnPct: 90, exhaustedPct: 97 },
  githubOwner: "owner",
  checkoutRoot: "/checkout",
});

test("v2 migration preserves the original and derives ordered role-specific effective routes", () => {
  const source = legacy();
  const before = structuredClone(source);
  const migrated = migrateFactoryConfig(source, 2);
  assert.deepEqual(source, before);
  assert.deepEqual(migrated.steerPriority, ["same", "private", "different"]);
  assert.deepEqual(migrated.advisorPriority, ["advisor"]);
  assert.deepEqual(migrated.profiles, source.profiles);
  assert.deepEqual(migrated.slots, source.slots);
  assert.deepEqual(migrated.prepare, source.prepare);
  assert.equal(migrated.initialActive, source.initialActive);
  assert.deepEqual(migrated.workerPriority, source.workerPriority);
  assert.equal(migrated.routingStrategy, "efficiency");
  assert.equal(migrated.noSuitableSteer, "wait");
  assert.deepEqual(migrated.legacySnapshot, { version: 2, values: before });
  source.profiles.original.model = "changed";
  assert.deepEqual(migrated.legacySnapshot.values, before);
  const parsed = factoryConfigSettings.schema.parse(migrated);
  assert.deepEqual(validateFactorySettings(parsed), []);
});

test("v1 goes through v2 flags and worker conversion while snapshot retains v1", () => {
  const source = {
    profiles: {
      first: { provider: "codex", model: "x" },
      muse: { provider: "muse", model: "y" },
      optOut: { provider: "muse", model: "z", sensitive: false },
    },
    slots: { A: "first", B: "muse" }, prepare: ["A"], initialActive: "A", workerDefault: "optOut",
    extra: { retained: true },
  };
  const migrated = migrateFactoryConfig(source, 1);
  assert.deepEqual(migrated.workerPriority, ["optOut"]);
  assert.equal("workerDefault" in migrated, false);
  assert.equal(migrated.profiles.muse.sensitive, true);
  assert.equal(migrated.profiles.optOut.sensitive, false);
  assert.equal(migrated.profiles.first.advisor, false);
  assert.deepEqual(migrated.steerPriority, ["first", "muse"]);
  assert.deepEqual(factoryConfigSettings.schema.parse(migrated).legacySnapshot, { version: 1, values: source });
});

test("migration preserves legacy slot classification and creation request identity", () => {
  const source = legacy();
  const before = configFromSettings(source);
  const after = configFromSettings(factoryConfigSettings.schema.parse(migrateFactoryConfig(source, 2)));
  assert.deepEqual(after.steers.slots, before.steers.slots);
  assert.deepEqual(after.steers.prepare, before.steers.prepare);
  assert.equal(after.steers.initialActive, before.steers.initialActive);
  assert.deepEqual(after.workers, before.workers);
  for (const [slot, name] of Object.entries(before.steers.slots)) {
    assert.equal(isAdvisorSlot(after, slot), isAdvisorSlot(before, slot));
    assert.equal(isSensitiveProfile(after, name), isSensitiveProfile(before, name));
    const request = (config) => buildSteerCreate({
      keyScope: "scope", repo: "owner/repo", scopeId: "scope", slot,
      workspaceId: "workspace", profile: config.profiles[name], keyParts: ["steer", slot, "g1"],
    });
    assert.deepEqual(request(after), request(before));
  }
});

test("retagging presets preserves migrated steer roles and does not invalidate the deprecated initial slot", () => {
  const source = legacy();
  source.workerPriority = ["unused"];
  const current = factoryConfigSettings.schema.parse(migrateFactoryConfig(source, 2));
  current.profiles.original.advisor = true;
  current.profiles.advisor.advisor = false;
  current.advisorPriority = ["original"];
  current.steerPriority.push("advisor");
  const config = configFromSettings(current);
  assert.deepEqual(validateFactorySettings(current), []);
  assert.deepEqual(validateConfig(config), []);
  assert.equal(isAdvisorSteer(config, { [LABEL.slot]: "B" }), false);
  assert.equal(isAdvisorSteer(config, { [LABEL.slot]: "D" }), true);
  assert.equal(isAdvisorSteer(config, { [LABEL.slot]: "D" }, { [LABEL.steerRole]: "coordinator" }), false);
  assert.deepEqual(current.legacySnapshot.values, source);
});

test("explicit lists and strategy survive migration; current and future versions are unchanged", () => {
  const source = { ...legacy(), steerPriority: ["different", "original"], advisorPriority: [], routingStrategy: "preference" };
  const migrated = migrateFactoryConfig(source, 2);
  assert.deepEqual(migrated.steerPriority, source.steerPriority);
  assert.deepEqual(migrated.advisorPriority, []);
  assert.equal(migrated.routingStrategy, "preference");
  assert.equal(migrated.noSuitableSteer, "wait");
  const fromV3 = migrateFactoryConfig({ ...migrated, noSuitableSteer: undefined }, 3);
  assert.equal(fromV3.noSuitableSteer, "wait");
  assert.deepEqual(fromV3.legacySnapshot, migrated.legacySnapshot);
  const explicitV3 = migrateFactoryConfig({ ...migrated, noSuitableSteer: "offer" }, 3);
  assert.equal(explicitV3.noSuitableSteer, "offer");
  assert.strictEqual(migrateFactoryConfig(migrated, 4), migrated);
  assert.strictEqual(migrateFactoryConfig(migrated, 5), migrated);
  assert.equal(migrateFactoryConfig(null, 1), null);
});

test("deduplication compares the effective v2 profile defaults and every route dimension", () => {
  const source = legacy();
  source.profiles = {
    bare: { provider: "muse", model: "same" },
    same: profile({ provider: "muse", model: "same", thinking: null, mode: null }),
    mode: profile({ provider: "muse", model: "same", thinking: null, mode: "plan" }),
    model: profile({ provider: "muse", model: "other", thinking: null, mode: null }),
    provider: profile({ provider: "other", model: "same", thinking: null, mode: null }),
  };
  source.slots = { A: "bare", B: "same", C: "mode", D: "model", E: "provider" };
  source.prepare = ["A"];
  source.initialActive = "A";
  source.workerPriority = ["bare"];
  const migrated = migrateFactoryConfig(source, 2);
  assert.deepEqual(migrated.steerPriority, ["bare", "mode", "model", "provider"]);
  assert.deepEqual(validateFactorySettings(factoryConfigSettings.schema.parse(migrated)), []);
});

test("defaults and legacy inputs derive missing lists without replacing explicit empty lists", () => {
  const defaults = factoryConfigSettings.schema.parse({});
  assert.equal(factoryConfigSettings.version, 4);
  assert.deepEqual(defaults.steerPriority, ["factory-default"]);
  assert.deepEqual(defaults.advisorPriority, []);
  assert.equal(defaults.routingStrategy, "efficiency");
  assert.equal(defaults.noSuitableSteer, "create");
  assert.deepEqual(validateFactorySettings(defaults), []);
  const input = legacy();
  const parsed = factoryConfigSettings.schema.parse(input);
  assert.deepEqual(parsed.steerPriority, ["same", "private", "different"]);
  assert.deepEqual(parsed.advisorPriority, ["advisor"]);
  const config = configFromSettings({ ...input, steerPriority: [], advisorPriority: [] });
  assert.deepEqual(config.steers.priority, []);
  assert.deepEqual(config.advisors.priority, []);
  assert.deepEqual(configFromSettings(input).steers.priority, parsed.steerPriority);
});

test("settings layering retains all profiles, priorities, routing and immutable rollback snapshot", () => {
  const current = factoryConfigSettings.schema.parse(migrateFactoryConfig(legacy(), 2));
  const snapshot = structuredClone(current.legacySnapshot);
  const config = configFromSettings(current);
  assert.equal(config.routing.strategy, "efficiency");
  assert.equal(config.routing.noSuitableSteer, "wait");
  config.routing.strategy = "balanced";
  config.routing.noSuitableSteer = "offer";
  config.steers.priority = ["different", "same"];
  config.advisors.priority = ["advisor"];
  delete config.profiles.unused;
  const next = settingsFromConfig(config, current);
  assert.deepEqual(next.steerPriority, ["different", "same"]);
  assert.deepEqual(next.advisorPriority, ["advisor"]);
  assert.equal(next.routingStrategy, "balanced");
  assert.equal(next.noSuitableSteer, "offer");
  assert.deepEqual(next.profiles.unused, current.profiles.unused);
  assert.deepEqual(next.legacySnapshot, snapshot);
  next.legacySnapshot.values.profiles.original.model = "modified";
  assert.deepEqual(current.legacySnapshot, snapshot);
  const second = settingsFromConfig(configFromSettings(current), current);
  assert.deepEqual(second.legacySnapshot, snapshot);
  assert.deepEqual(factoryConfigSettings.schema.parse(second), second);
  const legacyConfig = configFromSettings(current);
  delete legacyConfig.profiles.advisor.advisor;
  delete legacyConfig.profiles.private.sensitive;
  const inherited = settingsFromConfig(legacyConfig, current);
  assert.equal(inherited.profiles.advisor.advisor, true);
  assert.equal(inherited.profiles.private.sensitive, true);
  legacyConfig.profiles.private.sensitive = "false";
  assert.throws(() => settingsFromConfig(legacyConfig, current), /sensitive must be a boolean/);
});

test("malformed classification is rejected rather than promoted into an eligible route", () => {
  for (const [field, value] of [["advisor", "false"], ["sensitive", "false"]]) {
    const source = legacy();
    source.profiles.original[field] = value;
    const migrated = migrateFactoryConfig(source, 1);
    assert.equal(migrated.profiles.original[field], value);
    assert.equal(migrated.steerPriority.includes("original"), false);
    assert.equal(factoryConfigSettings.schema.safeParse(migrated).success, false);
  }
  const values = factoryConfigSettings.schema.parse(migrateFactoryConfig(legacy(), 2));
  values.steerPriority = ["advisor"];
  assert.match(validateFactorySettings(values).join("\n"), /incompatible advisor classification/);
  values.steerPriority = ["missing"];
  assert.match(validateFactorySettings(values).join("\n"), /unknown profile/);
  values.routingStrategy = "unknown";
  assert.match(validateFactorySettings(values).join("\n"), /routingStrategy/);
  values.noSuitableSteer = "auto";
  assert.match(validateFactorySettings(values).join("\n"), /noSuitableSteer/);
  assert.match(validateConfig({ ...configFromSettings(factoryConfigSettings.schema.parse({})), routing: { noSuitableSteer: "auto" } }).join("\n"), /routing\.noSuitableSteer/);
  values.steerPriority = null;
  assert.throws(() => configFromSettings(values), TypeError);
  const malformedWorker = migrateFactoryConfig({ ...legacy(), workerPriority: undefined, workerDefault: 4 }, 1);
  assert.equal(factoryConfigSettings.schema.safeParse(malformedWorker).success, false);
});

test("role-priority configs do not require legacy slots, prepare or initialActive", () => {
  const modern = factoryConfigSettings.schema.parse({
    profiles: {
      coord: profile({ provider: "codex", model: "gpt-6.2-sol" }),
      adv: profile({ provider: "claude", model: "opus", advisor: true }),
    },
    slots: {},
    prepare: [],
    initialActive: "",
    workerPriority: ["coord"],
    steerPriority: ["coord"],
    advisorPriority: ["adv"],
    routingStrategy: "efficiency",
    noSuitableSteer: "create",
    githubOwner: "owner",
    checkoutRoot: "/checkout",
  });
  assert.deepEqual(validateFactorySettings(modern), []);
  const config = configFromSettings(modern);
  assert.deepEqual(validateConfig(config), []);

  // Legacy configs without steerPriority still require slots, prepare and initialActive.
  const missingLegacy = { ...modern, steerPriority: undefined };
  const legacyErrors = validateFactorySettings(missingLegacy).join("\n");
  assert.match(legacyErrors, /slots must define at least one slot/);
  assert.match(legacyErrors, /prepare must list at least one slot/);
  assert.match(legacyErrors, /initialActive must be one of prepare/);

  const legacyConfig = configFromSettings(modern);
  delete legacyConfig.steers.priority;
  const legacyConfigErrors = validateConfig(legacyConfig).join("\n");
  assert.match(legacyConfigErrors, /steers\.slots must define at least one slot/);
  assert.match(legacyConfigErrors, /steers\.prepare must list at least one slot/);
  assert.match(legacyConfigErrors, /steers\.initialActive must be one of steers\.prepare/);

  // Invalid legacy entries that are still present remain rejected even with steerPriority.
  const badSlot = { ...modern, slots: { Z: "missing" } };
  assert.match(validateFactorySettings(badSlot).join("\n"), /slot Z references unknown profile/);
  assert.match(validateConfig(configFromSettings(badSlot)).join("\n"), /steer slot Z references unknown profile/);
});
