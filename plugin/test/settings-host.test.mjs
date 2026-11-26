// Host setup in factory-config: githubOwner/checkoutRoot are required settings,
// and the effective config is built from the settings only. A legacy config
// file on disk (even an invalid one) has no effect. Offline: host settings
// are faked, no daemon.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./ts-resolve-hooks.mjs", import.meta.url);

const { factoryConfigSettings } = await import("../shared/settings.ts");
const validate = await import("../shared/settings-validate.ts");
const {
  validateFactorySettings,
  validateHostSettings,
  configFromSettings,
  settingsFromConfig,
  missingHostSettings,
  isAbsolutePath,
} = validate;
const { createConfigLoader } = await import("../server/config.ts");
const { validateConfig } = await import("../server/core/config.mjs");
const { runtime } = await import("../server/core/runtime.mjs");

function settingsDoc(overrides = {}) {
  return { ...factoryConfigSettings.schema.parse({}), ...overrides };
}

function readySettings(values) {
  return { read: async () => ({ status: "ready", revision: "r1", values }) };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "wsf-host-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("schema: {} parses with null host fields at version 3", () => {
  assert.equal(factoryConfigSettings.version, 3);
  const defaults = factoryConfigSettings.schema.parse({});
  assert.equal(defaults.githubOwner, null);
  assert.equal(defaults.checkoutRoot, null);
  assert.deepEqual(validateFactorySettings(defaults), []);
  const explicit = factoryConfigSettings.schema.parse({ githubOwner: "octocat", checkoutRoot: "/tmp/x" });
  assert.equal(explicit.githubOwner, "octocat");
  assert.equal(explicit.checkoutRoot, "/tmp/x");
});

test("validateHostSettings: unset passes structurally, explicit must be well-formed", () => {
  for (const doc of [
    {},
    { githubOwner: null, checkoutRoot: null },
    { githubOwner: "", checkoutRoot: "   " },
    { githubOwner: "octocat", checkoutRoot: "/home/you/projects" },
    { githubOwner: "a", checkoutRoot: "/" },
    { githubOwner: "o-9", checkoutRoot: "C:\\projects" },
  ]) {
    assert.deepEqual(validateHostSettings(doc), [], JSON.stringify(doc));
  }
  assert.match(JSON.stringify(validateHostSettings({ githubOwner: "-bad" })), /githubOwner/);
  assert.match(JSON.stringify(validateHostSettings({ githubOwner: "has space" })), /githubOwner/);
  assert.match(JSON.stringify(validateHostSettings({ githubOwner: "bad!" })), /githubOwner/);
  assert.match(JSON.stringify(validateHostSettings({ githubOwner: "x".repeat(40) })), /githubOwner/);
  assert.deepEqual(validateHostSettings({ githubOwner: "x".repeat(39) }), []);
  assert.match(JSON.stringify(validateHostSettings({ checkoutRoot: "relative/path" })), /checkoutRoot/);
  assert.match(JSON.stringify(validateHostSettings({ checkoutRoot: "C:relative" })), /checkoutRoot/);
  assert.equal(isAbsolutePath("/x"), true);
  assert.equal(isAbsolutePath("relative"), false);
});

test("validateFactorySettings includes host errors", () => {
  const bad = settingsDoc({ githubOwner: "-bad", checkoutRoot: "relative" });
  const errors = validateFactorySettings(bad);
  assert.match(JSON.stringify(errors), /githubOwner must be a GitHub account name/);
  assert.match(JSON.stringify(errors), /checkoutRoot must be an absolute path/);
  const good = settingsDoc({ githubOwner: "octocat", checkoutRoot: "/tmp/x" });
  assert.deepEqual(validateFactorySettings(good), []);
});

test("configFromSettings builds a complete config that passes the validator", () => {
  const settings = settingsDoc({ githubOwner: "octocat", checkoutRoot: "/tmp/x" });
  assert.deepEqual(missingHostSettings(settings), []);
  assert.deepEqual(missingHostSettings(settingsDoc()), ["githubOwner", "checkoutRoot"]);
  assert.deepEqual(missingHostSettings(settingsDoc({ githubOwner: "o" })), ["checkoutRoot"]);
  const snapshot = JSON.parse(JSON.stringify(settings));
  const config = configFromSettings(settings);
  assert.deepEqual(settings, snapshot, "building the config must not mutate the settings");
  assert.deepEqual(validateConfig(config), []);
  assert.equal(config.version, 1);
  assert.deepEqual(config.github, { owner: "octocat", cloneProtocol: "https", upstreamRemote: "upstream" });
  assert.equal(config.checkoutRoot, "/tmp/x");
  assert.equal(config.workspaceTitle, "Main");
  assert.deepEqual(config.steers.slots, { A: "factory-default" });
  assert.deepEqual(config.workers.priority, ["factory-default"]);
  assert.equal(config.workers.defaultProfile, "factory-default");
});

test("settingsFromConfig preserves host fields from the current settings", () => {
  const current = settingsDoc({ githubOwner: "ui-owner", checkoutRoot: null });
  const config = configFromSettings(settingsDoc({ githubOwner: "octocat", checkoutRoot: "/tmp/x" }));
  const next = settingsFromConfig(config, current);
  assert.equal(next.githubOwner, "ui-owner");
  assert.equal(next.checkoutRoot, null);
  const fresh = settingsFromConfig(config, settingsDoc());
  assert.equal(fresh.githubOwner, null);
  assert.equal(fresh.checkoutRoot, null);
});

test("loader builds the effective config from valid host settings", async () => {
  const settings = settingsDoc({ githubOwner: "octocat", checkoutRoot: "/tmp/x" });
  const config = await createConfigLoader(readySettings(settings)).loadEffectiveConfig();
  assert.deepEqual(validateConfig(config), []);
  assert.equal(config.github.owner, "octocat");
  assert.equal(config.checkoutRoot, "/tmp/x");
  assert.deepEqual(config.steers.slots, { A: "factory-default" });
  assert.equal(runtime().handoffLanguage, "en");
});

test("loader names the missing host piece", async () => {
  await assert.rejects(
    createConfigLoader(readySettings(settingsDoc())).loadEffectiveConfig(),
    /Set the GitHub owner and checkout root in Factory settings/,
  );
  await assert.rejects(
    createConfigLoader(readySettings(settingsDoc({ githubOwner: "o" }))).loadEffectiveConfig(),
    /Set the checkout root in Factory settings/,
  );
  await assert.rejects(
    createConfigLoader(readySettings(settingsDoc({ checkoutRoot: "/tmp/x" }))).loadEffectiveConfig(),
    /Set the GitHub owner in Factory settings/,
  );
});

test("loader fails clearly on invalid or unreadable settings", async () => {
  await assert.rejects(
    createConfigLoader(readySettings(settingsDoc({ githubOwner: "-bad", checkoutRoot: "/tmp/x" }))).loadEffectiveConfig(),
    /Factory settings are invalid/,
  );
  await assert.rejects(
    createConfigLoader({ read: async () => ({ status: "error", error: "boom" }) }).loadEffectiveConfig(),
    /Factory settings are error: boom/,
  );
  await assert.rejects(
    createConfigLoader(null).loadEffectiveConfig(),
    /Factory settings are not available/,
  );
});

test("a legacy config file has no effect, even when invalid", async () => {
  const dir = tempDir();
  try {
    const legacy = join(dir, "config.json");
    writeFileSync(legacy, "{not json");
    const invalid = join(dir, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ version: 1 }));
    const prevConfig = process.env.PASEO_FACTORY_CONFIG;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.PASEO_FACTORY_CONFIG = legacy;
    process.env.XDG_CONFIG_HOME = dir;
    try {
      const settings = settingsDoc({ githubOwner: "octocat", checkoutRoot: "/tmp/x" });
      const config = await createConfigLoader(readySettings(settings)).loadEffectiveConfig();
      assert.equal(config.github.owner, "octocat");
      assert.equal(config.checkoutRoot, "/tmp/x");
      assert.deepEqual(validateConfig(config), []);
      process.env.PASEO_FACTORY_CONFIG = invalid;
      const again = await createConfigLoader(readySettings(settings)).loadEffectiveConfig();
      assert.equal(again.github.owner, "octocat");
    } finally {
      if (prevConfig === undefined) delete process.env.PASEO_FACTORY_CONFIG;
      else process.env.PASEO_FACTORY_CONFIG = prevConfig;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  } finally {
    cleanup(dir);
  }
});
