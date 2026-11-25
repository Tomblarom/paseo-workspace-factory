// Host setup in factory-config: optional githubOwner/checkoutRoot overlays in
// the settings document, and a settings-only minimal config when no file
// exists. Offline: the file path is steered with PASEO_FACTORY_CONFIG into a
// temp dir, host settings are faked, no daemon.
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
  mergeFactoryConfig,
  settingsFromConfig,
  minimalFileConfigBase,
  missingHostSettings,
  isAbsolutePath,
} = validate;
const { createConfigLoader, isMissingFileError, loadFileConfig } = await import("../server/config.ts");
const { validateConfig } = await import("../server/factory/config.ts");
const { runtime } = await import("../server/factory/runtime.ts");

function settingsDoc(overrides = {}) {
  return { ...factoryConfigSettings.schema.parse({}), ...overrides };
}

function readySettings(values) {
  return { read: async () => ({ status: "ready", revision: "r1", values }) };
}

function validFileConfig(overrides = {}) {
  return {
    version: 1,
    github: { owner: "file-owner", cloneProtocol: "https", upstreamRemote: "upstream" },
    checkoutRoot: "/file/root",
    workspaceTitle: "Main",
    profiles: {
      "factory-default": {
        provider: "codex",
        model: "gpt-6.2-sol",
        thinking: "high",
        mode: "full-access",
        advisor: false,
        sensitive: false,
      },
    },
    steers: { slots: { A: "factory-default" }, prepare: ["A"], initialActive: "A" },
    workers: { defaultProfile: "factory-default" },
    ...overrides,
  };
}

async function withConfigPath(path, fn) {
  const prev = process.env.PASEO_FACTORY_CONFIG;
  if (path === undefined) delete process.env.PASEO_FACTORY_CONFIG;
  else process.env.PASEO_FACTORY_CONFIG = path;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PASEO_FACTORY_CONFIG;
    else process.env.PASEO_FACTORY_CONFIG = prev;
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "wsf-host-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test("schema: {} parses with null host fields, version stays 2", () => {
  assert.equal(factoryConfigSettings.version, 2);
  const defaults = factoryConfigSettings.schema.parse({});
  assert.equal(defaults.githubOwner, null);
  assert.equal(defaults.checkoutRoot, null);
  assert.deepEqual(validateFactorySettings(defaults), []);
  const explicit = factoryConfigSettings.schema.parse({ githubOwner: "octocat", checkoutRoot: "/tmp/x" });
  assert.equal(explicit.githubOwner, "octocat");
  assert.equal(explicit.checkoutRoot, "/tmp/x");
});

test("validateHostSettings: unset is valid, explicit must be well-formed", () => {
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

test("merge keeps file host values unless explicit settings are saved", () => {
  const file = validFileConfig();
  const snapshot = JSON.parse(JSON.stringify(file));
  const unset = mergeFactoryConfig(file, settingsDoc());
  assert.deepEqual(file, snapshot, "merge must not mutate the file config");
  assert.deepEqual(unset.github, snapshot.github);
  assert.equal(unset.checkoutRoot, "/file/root");
  const blank = mergeFactoryConfig(file, settingsDoc({ githubOwner: "  ", checkoutRoot: "" }));
  assert.deepEqual(blank.github, snapshot.github);
  assert.equal(blank.checkoutRoot, "/file/root");

  const owner = mergeFactoryConfig(file, settingsDoc({ githubOwner: "  ui-owner " }));
  assert.equal(owner.github.owner, "ui-owner");
  assert.equal(owner.github.cloneProtocol, "https", "protocol stays file-owned");
  assert.equal(owner.github.upstreamRemote, "upstream", "remote stays file-owned");
  assert.equal(owner.checkoutRoot, "/file/root");

  const root = mergeFactoryConfig(file, settingsDoc({ checkoutRoot: "/ui/root" }));
  assert.equal(root.github.owner, "file-owner");
  assert.equal(root.checkoutRoot, "/ui/root");
});

test("settingsFromConfig preserves host fields instead of pinning the file", () => {
  const current = settingsDoc({ githubOwner: "ui-owner", checkoutRoot: null });
  const next = settingsFromConfig(validFileConfig(), current);
  assert.equal(next.githubOwner, "ui-owner");
  assert.equal(next.checkoutRoot, null);
  const fresh = settingsFromConfig(validFileConfig(), settingsDoc());
  assert.equal(fresh.githubOwner, null);
  assert.equal(fresh.checkoutRoot, null);
});

test("minimal base plus settings passes the CLI validator", () => {
  const settings = settingsDoc({ githubOwner: "octocat", checkoutRoot: "/tmp/x" });
  assert.deepEqual(missingHostSettings(settings), []);
  assert.deepEqual(missingHostSettings(settingsDoc()), ["githubOwner", "checkoutRoot"]);
  assert.deepEqual(missingHostSettings(settingsDoc({ githubOwner: "o" })), ["checkoutRoot"]);
  const merged = mergeFactoryConfig(minimalFileConfigBase(settings), settings);
  assert.deepEqual(validateConfig(merged), []);
  assert.equal(merged.version, 1);
  assert.deepEqual(merged.github, { owner: "octocat", cloneProtocol: "https", upstreamRemote: "upstream" });
  assert.equal(merged.checkoutRoot, "/tmp/x");
  assert.equal(merged.workspaceTitle, "Main");
  assert.deepEqual(merged.steers.slots, { A: "factory-default" });
  assert.deepEqual(merged.workers.priority, ["factory-default"]);
});

test("isMissingFileError matches only the not-found failure", () => {
  assert.equal(isMissingFileError(new Error("No factory config at /tmp/x; copy config.example.json there")), true);
  assert.equal(isMissingFileError(new Error("Invalid factory config /tmp/x:\n- version must be 1")), false);
  assert.equal(isMissingFileError(new SyntaxError("Unexpected token")), false);
  assert.equal(isMissingFileError(null), false);
});

test("loader without a file builds a complete config from valid host settings", async () => {
  const dir = tempDir();
  try {
    const settings = settingsDoc({ githubOwner: "octocat", checkoutRoot: "/tmp/x" });
    const config = await withConfigPath(join(dir, "missing", "config.json"), () =>
      createConfigLoader(readySettings(settings)).loadEffectiveConfig(),
    );
    assert.deepEqual(validateConfig(config), []);
    assert.equal(config.github.owner, "octocat");
    assert.equal(config.checkoutRoot, "/tmp/x");
    assert.deepEqual(config.steers.slots, { A: "factory-default" });
  } finally {
    cleanup(dir);
  }
});

test("loader without a file names the missing host piece", async () => {
  const dir = tempDir();
  try {
    const missing = join(dir, "missing", "config.json");
    await assert.rejects(
      withConfigPath(missing, () => createConfigLoader(readySettings(settingsDoc())).loadEffectiveConfig()),
      /No factory config at .*; set the GitHub owner and checkout root in Factory settings/,
    );
    await assert.rejects(
      withConfigPath(
        missing,
        () => createConfigLoader(readySettings(settingsDoc({ githubOwner: "o" }))).loadEffectiveConfig(),
      ),
      /set the checkout root in Factory settings/,
    );
    await assert.rejects(
      withConfigPath(
        missing,
        () => createConfigLoader(readySettings(settingsDoc({ githubOwner: "-bad", checkoutRoot: "/tmp/x" }))).loadEffectiveConfig(),
      ),
      /No factory config file; factory settings are invalid/,
    );
    await assert.rejects(
      withConfigPath(
        missing,
        () => createConfigLoader({ read: async () => ({ status: "error", error: "boom" }) }).loadEffectiveConfig(),
      ),
      /No factory config at .*; factory settings are error \(boom\)/,
    );
    await assert.rejects(
      withConfigPath(missing, () => createConfigLoader(null).loadEffectiveConfig()),
      /No factory config at /,
    );
  } finally {
    cleanup(dir);
  }
});

test("loader still fails clearly on malformed existing files", async () => {
  const dir = tempDir();
  try {
    const settings = settingsDoc({ githubOwner: "octocat", checkoutRoot: "/tmp/x" });
    const badJson = join(dir, "bad.json");
    writeFileSync(badJson, "{not json");
    await assert.rejects(
      withConfigPath(badJson, () => createConfigLoader(readySettings(settings)).loadEffectiveConfig()),
      /./,
      "JSON syntax errors propagate instead of falling back to settings",
    );
    const invalid = join(dir, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ version: 1 }));
    await assert.rejects(
      withConfigPath(invalid, () => createConfigLoader(readySettings(settings)).loadEffectiveConfig()),
      /Invalid factory config/,
    );
  } finally {
    cleanup(dir);
  }
});

test("loader with a file keeps file host values unless settings override them", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify(validFileConfig({ handoffLanguage: "de" })));
    const kept = await withConfigPath(file, () =>
      createConfigLoader(readySettings(settingsDoc())).loadEffectiveConfig(),
    );
    assert.equal(kept.github.owner, "file-owner");
    assert.equal(kept.checkoutRoot, "/file/root");
    assert.equal(kept.handoffLanguage, "de");
    assert.equal(runtime().handoffLanguage, "en");
    const over = await withConfigPath(file, () =>
      createConfigLoader(readySettings(settingsDoc({ githubOwner: "ui-owner", checkoutRoot: "/ui/root" }))).loadEffectiveConfig(),
    );
    assert.equal(over.github.owner, "ui-owner");
    assert.equal(over.checkoutRoot, "/ui/root");
    assert.deepEqual(validateConfig(over), []);
  } finally {
    cleanup(dir);
  }
});

test("loadFileConfig keeps the CLI file behavior", async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      withConfigPath(join(dir, "missing", "config.json"), () => loadFileConfig()),
      /No factory config at /,
    );
  } finally {
    cleanup(dir);
  }
});
