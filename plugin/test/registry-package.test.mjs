import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { settingsRpc } from "@getpaseo/plugin";
import { PluginIdSchema, PluginRequirementsSchema } from "@getpaseo/protocol/messages";
import { validatePluginRequirements } from "@getpaseo/protocol/plugin-requirements";
import { buildSnapshot } from "../../scripts/build-snapshot.mjs";
import { paseoBinary } from "../server/core/paseo.mjs";

register("./ts-resolve-hooks.mjs", import.meta.url);
const {
  factoryCleanupSettings,
  factoryConfigSettings,
  factoryDisplaySettings,
  factoryMetricsSettings,
  factoryResumeSettings,
  factorySteerMenuSettings,
  factorySupervisionSettings,
} = await import("../shared/settings.ts");

const pluginDir = fileURLToPath(new URL("..", import.meta.url));
const icon = "assets/icon.png";
const shippedFiles = ["cli.mjs", "paseo-plugin.json", "OVERVIEW.md", icon, "index.client.tsx", "index.server.ts"];
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "factory-registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("registry manifest has valid listing metadata and Paseo requirements", async () => {
  const manifest = await readJson(join(pluginDir, "paseo-plugin.json"));
  assert.equal(PluginIdSchema.parse(manifest.id), "workspace-factory");
  assert.match(manifest.name, /\S/);
  assert.match(manifest.description, /\S/);
  assert.equal(manifest.icon, icon);
  const signature = (await readFile(join(pluginDir, manifest.icon))).subarray(0, 8);
  assert.equal(signature.toString("hex"), "89504e470d0a1a0a");
  const requirements = PluginRequirementsSchema.strict().parse(manifest.requirements);
  assert.match(requirements.paseo, /\S/);
  validatePluginRequirements(requirements);
});

test("npm pack and build-snapshot ship the registry files and omit test and dependency trees", async (t) => {
  const dir = await scratch(t);
  const manifest = await readJson(join(pluginDir, "package.json"));
  assert.ok(Array.isArray(manifest.files));
  for (const path of shippedFiles) {
    assert.ok(manifest.files.includes(path) || manifest.files.some(
      (entry) => entry.endsWith("/") && path.startsWith(entry),
    ), `${path} is missing from package.json files`);
  }

  const [pack] = JSON.parse(execFileSync("npm", [
    "pack", "--dry-run", "--json", "--ignore-scripts", "--update-notifier=false", "--cache", join(dir, "npm-cache"),
  ], { cwd: pluginDir, encoding: "utf8" }));
  const snapshot = buildSnapshot({ pluginDir, releasesDir: join(dir, "releases") });

  for (const [label, paths] of [
    ["npm pack", pack.files.map(({ path }) => path)],
    ["snapshot", snapshot.files],
  ]) {
    for (const path of shippedFiles) {
      assert.ok(paths.includes(path), `${label} is missing ${path}`);
    }
    assert.deepEqual(paths.filter((path) => /(^|\/)(?:test|node_modules)(?:\/|$)/.test(path)), [],
      `${label} contains tests or installed dependencies`);
  }

  const snapshotRoot = await readdir(snapshot.snapshotDir);
  assert.ok(!snapshotRoot.includes("test") && !snapshotRoot.includes("node_modules"));
  for (const path of shippedFiles) {
    assert.ok((await stat(join(snapshot.snapshotDir, path))).isFile(), path);
  }
});

async function installedSettingsStore() {
  let cli;
  try {
    cli = paseoBinary("paseo");
  } catch {
    return null;
  }
  let serverEntry;
  try {
    serverEntry = createRequire(realpathSync(cli)).resolve("@getpaseo/server");
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") return null;
    throw error;
  }
  const storePath = join(dirname(serverEntry), "plugins/settings/index.js");
  if (!existsSync(storePath)) return null;
  return (await import(pathToFileURL(storePath).href)).PluginSettingsStore;
}

// npm-only CI has the plugin SDK. Exercise the same persisted envelope and RPC
// schema there, and use Paseo's own file-backed store when the CLI ships it.
const PluginSettingsStore = await installedSettingsStore();

function settingsReader(dir, definition) {
  if (PluginSettingsStore) {
    return new PluginSettingsStore(dir, () => {}).register(definition).read.handle;
  }
  return async () => {
    const file = join(dir, `${definition.id}.json`);
    const raw = await readFile(file, "utf8");
    const stored = JSON.parse(raw);
    const upgraded = stored.version < definition.version;
    const values = await definition.schema.parseAsync(upgraded
      ? await definition.migrate(stored.values, stored.version)
      : stored.values);
    const revision = upgraded ? JSON.stringify({ version: definition.version, values }) : raw;
    if (upgraded) await writeFile(file, revision);
    return { status: "ready", revision, values };
  };
}

async function verifyStoredSettings(t, definition, from, to, values, expected) {
  assert.equal(definition.scope, "host");
  assert.equal(definition.version, to);
  const dir = await scratch(t);
  const file = join(dir, `${definition.id}.json`);
  await writeFile(file, JSON.stringify({ version: from, values }));

  const rpc = settingsRpc(definition.id).read;
  const read = async () => {
    const result = await settingsReader(dir, definition)(rpc.input.parse({}));
    return rpc.output.parse(JSON.parse(JSON.stringify(result)));
  };
  const migrated = await read();
  assert.equal(migrated.status, "ready", migrated.error);
  assert.deepEqual(migrated.values, expected);
  assert.deepEqual(await readJson(file), { version: to, values: expected });
  assert.deepEqual(await read(), migrated, "opening a fresh store keeps the saved values and revision");
}

const host = {
  githubOwner: "example-owner",
  checkoutRoot: "/srv/example-checkouts",
  slots: { C: "review", B: "backup", A: "main" },
  prepare: ["B", "A"],
  initialActive: "B",
  quota: { exhaustedPct: 97, warnPct: 74 },
};
const v1Profiles = {
  main: { provider: "codex", model: "main-model", thinking: "high", mode: "full-access" },
  backup: { provider: "claude", model: "backup-model", thinking: null, mode: "review" },
  review: { provider: "muse", model: "review-model", thinking: "max", mode: null },
};
const v1 = { ...host, profiles: v1Profiles, workerDefault: "review" };
const v1MigratedProfiles = {
  main: { ...v1Profiles.main, advisor: false, sensitive: false },
  backup: { ...v1Profiles.backup, advisor: false, sensitive: false },
  review: { ...v1Profiles.review, advisor: false, sensitive: true },
};
const v2 = {
  ...host,
  profiles: {
    ...v1MigratedProfiles,
    review: { ...v1MigratedProfiles.review, advisor: true, sensitive: false },
  },
  workerPriority: ["backup", "main"],
};
const v3 = {
  ...v2,
  steerPriority: ["backup", "main"],
  advisorPriority: ["review"],
  routingStrategy: "preference",
  legacySnapshot: { version: 1, values: v1 },
};

for (const [from, values, expected] of [
  [1, v1, {
    ...host,
    profiles: v1MigratedProfiles,
    workerPriority: ["review"],
    steerPriority: ["main", "backup", "review"],
    advisorPriority: [],
    routingStrategy: "efficiency",
    legacySnapshot: { version: 1, values: v1 },
  }],
  [2, v2, {
    ...v2,
    steerPriority: ["main", "backup"],
    advisorPriority: ["review"],
    routingStrategy: "efficiency",
    legacySnapshot: { version: 2, values: v2 },
  }],
  [3, v3, v3],
]) {
  test(`factory-config v${from} → v4 preserves host fields, profiles, priorities and rollback data`, (t) =>
    verifyStoredSettings(t, factoryConfigSettings, from, 4, values, { ...expected, noSuitableSteer: "wait" }));
}

for (const [from, values, expected] of [
  [1, { initializeNewSteer: "send" }, { afterReset: "continue", keepChatHistory: false }],
  [1, { initializeNewSteer: "composer" }, { afterReset: "composer", keepChatHistory: false }],
  [1, { initializeNewSteer: "later" }, { afterReset: "wait", keepChatHistory: false }],
  [1, {}, { afterReset: "composer", keepChatHistory: false }],
  [2, { initializeNewSteer: "composer", keepChatHistory: true }, { afterReset: "composer", keepChatHistory: true }],
  [2, { initializeNewSteer: "later", keepChatHistory: false }, { afterReset: "wait", keepChatHistory: false }],
]) {
  test(`factory-steer-menu v${from} → v3 preserves ${JSON.stringify(values)}`, (t) =>
    verifyStoredSettings(t, factorySteerMenuSettings, from, 3, values, expected));
}

test("factory-cleanup v1 → v2 preserves the settings retained by the cost profile schema", (t) => {
  const retained = {
    mode: "compact-warm",
    idleMinutes: 76,
    minContextTokens: 87000,
    providers: ["codex", "claude"],
    roles: ["worker"],
    clearAcknowledged: true,
    dailyCap: 7,
  };
  return verifyStoredSettings(t, factoryCleanupSettings, 1, 2,
    { ...retained, compactAtMinutes: 32, seedAfterClear: true },
    { ...retained, profile: "balanced", rewindFresh: false });
});

for (const [definition, values] of [
  [factoryDisplaySettings, { checkpointInChat: false, findingsInPrompts: false }],
  [factoryMetricsSettings, { enabled: true }],
  [factoryResumeSettings, { providers: ["codex", "claude"], recentHours: 36 }],
  [factorySupervisionSettings, {
    enabled: false, paused: true, batchMinutes: 2, wakeDebounceSeconds: 42, watchdogMinutes: 19,
    staleMinutes: 81, answerMinutes: 14, maxAutoResumes: 1,
    quota: { exhaustedPct: 98, warnPct: 78 }, quotaSampleMinutes: 20,
  }],
]) {
  test(`${definition.id} v1 retains user values when reopened after an update`, (t) =>
    verifyStoredSettings(t, definition, 1, 1, values, values));
}
