// factory-config v2: migration, validation, settings-to-config, and the
// factory.models.list/set RPC handlers (fake loader and catalog, no daemon).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const { factoryConfigSettings, migrateFactoryConfig } = await import("../shared/settings.ts");
const { validateFactorySettings, configFromSettings, settingsFromConfig } = await import("../shared/settings-validate.ts");
const { listModels, setModels, resetCatalogCache } = await import("../server/models-rpc.ts");
const { formatModelList, formatModelChange } = await import("../shared/models-format.ts");

const v1 = () => ({
  profiles: {
    codex: { provider: "codex", model: "gpt-6.2-sol", thinking: "high", mode: "full-access" },
    muse: { provider: "muse", model: "muse-1.3", thinking: null, mode: null },
    keep: { provider: "muse", model: "m2", thinking: null, mode: null, sensitive: false },
    anti: { provider: "antigravity", model: "g", thinking: null, mode: null },
  },
  slots: { A: "codex" },
  prepare: ["A"],
  initialActive: "A",
  workerDefault: "muse",
});

test("migration v1 to v2: workerDefault becomes workerPriority, sensitive from provider", () => {
  const migrated = migrateFactoryConfig(v1(), 1);
  assert.deepEqual(migrated.workerPriority, ["muse"]);
  assert.equal("workerDefault" in migrated, false);
  assert.equal(migrated.profiles.muse.sensitive, true, "muse without flag is sensitive");
  assert.equal(migrated.profiles.keep.sensitive, false, "explicit false stays false");
  assert.equal(migrated.profiles.anti.sensitive, false);
  assert.equal(migrated.profiles.codex.sensitive, false);
  assert.equal(migrated.profiles.codex.advisor, false);
  // The migrated document satisfies the v2 schema and validation.
  const parsed = factoryConfigSettings.schema.parse(migrated);
  assert.deepEqual(validateFactorySettings(parsed), []);
  assert.equal(factoryConfigSettings.version, 3);
});

test("migration retains a v2 snapshot, leaves v3 and non-objects alone; defaults parse", () => {
  const v2 = { profiles: {}, workerPriority: ["x"] };
  const v3 = migrateFactoryConfig(v2, 2);
  assert.deepEqual(v3.legacySnapshot, { version: 2, values: v2 });
  assert.equal(migrateFactoryConfig(v3, 3), v3);
  assert.equal(migrateFactoryConfig(null, 1), null);
  const defaults = factoryConfigSettings.schema.parse({});
  assert.deepEqual(defaults.workerPriority, ["factory-default"]);
  assert.equal(defaults.profiles["factory-default"].advisor, false);
  assert.deepEqual(validateFactorySettings(defaults), []);
});

function v2doc() {
  const d = factoryConfigSettings.schema.parse(migrateFactoryConfig(v1(), 1));
  d.slots = { A: "codex", B: "anti" };
  d.prepare = ["A", "B"];
  d.githubOwner = "octocat";
  d.checkoutRoot = "/tmp/x";
  return d;
}

test("validation: worker priority and advisor rules", () => {
  const d = v2doc();
  d.workerPriority = [];
  assert.match(JSON.stringify(validateFactorySettings(d)), /workerPriority must list/);
  const dup = v2doc();
  dup.workerPriority = ["muse", "muse"];
  assert.match(JSON.stringify(validateFactorySettings(dup)), /duplicates/);
  const adv = v2doc();
  adv.profiles.anti.advisor = true;
  adv.workerPriority = ["anti"];
  assert.match(JSON.stringify(validateFactorySettings(adv)), /tagged as advisor/);
  const active = v2doc();
  active.profiles.codex.advisor = true;
  assert.match(JSON.stringify(validateFactorySettings(active)), /incompatible advisor classification/);
  delete active.steerPriority;
  assert.match(JSON.stringify(validateFactorySettings(active)), /initialActive A is an advisor slot/);
  const all = v2doc();
  all.profiles.codex.advisor = true;
  all.profiles.anti.advisor = true;
  delete all.steerPriority;
  assert.match(JSON.stringify(validateFactorySettings(all)), /non-advisor/);
});

test("configFromSettings writes workers.priority, defaultProfile and flags", () => {
  const d = v2doc();
  d.workerPriority = ["muse", "codex"];
  const config = configFromSettings(d);
  assert.deepEqual(config.workers, { priority: ["muse", "codex"], defaultProfile: "muse" });
  assert.equal(config.profiles.muse.sensitive, true);
  assert.equal(config.profiles.codex.advisor, false);
});

test("settingsFromConfig keeps stored profiles and adds used ones", () => {
  const d = v2doc();
  const config = configFromSettings(d);
  config.profiles.added = { provider: "x", model: "y", thinking: null, mode: null };
  config.workers.priority = ["added", "codex"];
  config.profiles.codex.advisor = false;
  config.profiles.anti.advisor = true;
  const next = settingsFromConfig(config, d);
  assert.deepEqual(next.workerPriority, ["added", "codex"]);
  assert.equal(next.profiles.added.provider, "x", "used planned profile is copied in");
  assert.equal(next.profiles.anti.advisor, true);
  assert.equal(next.profiles.muse.sensitive, true, "stored profile kept");
});

function catalog() {
  return [
    { provider: "codex", enabled: true, status: "ready", models: [{ id: "gpt-6.2-sol", thinkingOptions: [{ id: "high" }] }], modes: [{ id: "full-access" }] },
    { provider: "muse", enabled: false, status: "unavailable", models: [], modes: [] },
    { provider: "antigravity", enabled: true, status: "ready", models: [{ id: "g", thinkingOptions: [] }, { id: "g2", thinkingOptions: [] }], modes: [] },
  ];
}

function fixture(doc = v2doc()) {
  resetCatalogCache();
  let calls = 0;
  const ctx = { paseo: { providers: { snapshot: async () => (calls += 1, { entries: catalog() }) } } };
  const hostSettings = { read: async () => ({ status: "ready", revision: "r1", values: doc }) };
  const loader = {
    loadEffectiveConfig: async () => configFromSettings(doc),
  };
  return { ctx, hostSettings, loader, calls: () => calls };
}

test("factory.models.list: priority rows with availability and selection", async () => {
  const f = fixture();
  const list = await listModels({}, f.ctx, f.loader, f.hostSettings, Date.now, async () => null);
  assert.equal(list.revision, "r1");
  assert.deepEqual(list.workers.map((w) => [w.profile, w.available, w.sensitive, w.selected]), [["muse", false, true, false]]);
  // muse is unavailable and the only worker: nothing selected
  assert.equal(list.selectedWorker, null);
  assert.deepEqual(list.steers.map((s) => [s.slot, s.profile, s.available]), [["A", "codex", true], ["B", "anti", true]]);
  assert.match(list.workers[0].reasons.join(), /muse/);
  const text = formatModelList("worker", list);
  assert.match(text, /✗ muse/);
  assert.match(text, /sensitive/);
  await listModels({}, f.ctx, f.loader, f.hostSettings, Date.now, async () => null);
  assert.equal(f.calls(), 1, "catalog is cached for 60 s");
});

test("factory.models.list renders role preferences in their configured order", async () => {
  const doc = v2doc();
  doc.steerPriority = ["anti", "codex"];
  doc.profiles.muse.advisor = true;
  doc.advisorPriority = ["muse"];
  const f = fixture(doc);
  const list = await listModels({}, f.ctx, f.loader, f.hostSettings, Date.now, async () => null);
  assert.deepEqual(list.steerPreferences.map((profile) => profile.profile), ["anti", "codex"]);
  assert.deepEqual(list.advisorPreferences.map((profile) => profile.profile), ["muse"]);
  const text = formatModelList("steer", list);
  assert.match(text, /Steer priority:\n  1\.  ✓ anti[\s\S]*Advisor priority:\n  1\.  ✗ muse/);
  assert.doesNotMatch(text, /Steer slots/);
});

test("factory.models.list: an exhausted ZeroSub family is not selected and shows the pick reason", async () => {
  const doc = v2doc();
  doc.workerPriority = ["codex", "anti"];
  const f = fixture(doc);
  const reset = new Date(Date.now() + 3 * 3600_000).toISOString();
  const zerosub = {
    accounts: [{ id: "c1", family: "codex", label: "c1", status: "active", limitedUntil: null, windows: [{ id: "five_hour", usedPct: 99, resetsAt: reset }], maxUsedPct: 99, exhausted: false }],
    agentAccount: {}, pending: {}, waiting: {}, version: null,
  };
  const list = await listModels({}, f.ctx, f.loader, f.hostSettings, Date.now, async () => zerosub);
  assert.equal(list.selectedWorker, "anti");
  assert.deepEqual(list.workers.map((w) => [w.profile, w.selected]), [["codex", false], ["anti", true]]);
  assert.match(list.workers[0].skipReason, /accounts exhausted/);
  assert.match(formatModelList("worker", list), /skipped: accounts exhausted/);
});

test("factory.models.set: worker-set returns a new settings document, no write", async () => {
  const f = fixture();
  const out = await setModels({ action: "worker-set", n: "1", spec: "codex" }, f.ctx, f.loader, f.hostSettings);
  assert.equal(out.revision, "r1");
  assert.deepEqual(out.values.workerPriority, ["codex", "muse"]);
  assert.deepEqual(validateFactorySettings(out.values), []);
  assert.match(out.summary, /workers\.priority/);
  assert.match(formatModelChange(out, true), /^Saved\./);
  assert.match(formatModelChange(out, false), /Preview only/);
});

test("factory.models.set: legacy steer edits stop before loading or writing settings", async () => {
  const f = fixture();
  const forbidden = { read: () => assert.fail("legacy edit must not load settings") };
  await assert.rejects(setModels({ action: "steer-set", n: "B", spec: "antigravity/g2" }, f.ctx, f.loader, forbidden), /Factory settings.*live steers/);
  await assert.rejects(setModels({ action: "steer-rm", n: "A" }, f.ctx, f.loader, forbidden), /Factory settings.*live steers/);
});

test("factory.models.set: advisor and sensitive flip tags", async () => {
  const f = fixture();
  const adv = await setModels({ action: "advisor", spec: "anti", on: true }, f.ctx, f.loader, f.hostSettings);
  assert.equal(adv.values.profiles.anti.advisor, true);
  const sens = await setModels({ action: "sensitive", spec: "muse", on: false }, f.ctx, f.loader, f.hostSettings);
  assert.equal(sens.values.profiles.muse.sensitive, false);
  await assert.rejects(setModels({ action: "worker-rm", n: "1" }, f.ctx, f.loader, f.hostSettings), /last worker/);
  await assert.rejects(setModels({ action: "worker-rm", n: "1" }, f.ctx, f.loader, null), /not available/);
  await assert.rejects(setModels({ action: "worker-set", spec: "codex" }, f.ctx, f.loader, f.hostSettings), /needs a position/);
});

test("factory.models.set: advisor profile cannot join the worker list", async () => {
  const doc = v2doc();
  doc.profiles.anti.advisor = true;
  const f = fixture(doc);
  await assert.rejects(setModels({ action: "worker-set", n: "1", spec: "anti" }, f.ctx, f.loader, f.hostSettings), /advisor/);
});
