import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

register("./ts-resolve-hooks.mjs", import.meta.url);
const { registerPromptSettings } = await import("../server/prompt-settings.ts");

test("the prompt settings RPC reports the git-checkout install and the display preference", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-plugin-findings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginDir = join(root, "plugin");
  mkdirSync(pluginDir);
  let values = {};
  let handler;
  let configReads = 0;
  const server = { handle(contract, fn) {
    assert.equal(contract.name, "factory.prompt-settings");
    handler = fn;
  } };
  const loadPromptOptions = registerPromptSettings(server, { read: async () => ({ status: "ready", values }) });
  const paseo = { config: { async get() {
    configReads++;
    return { config: { plugins: { "workspace-factory": { path: pluginDir } } } };
  } } };

  // Snapshot/registry install (no git checkout around the plugin): no passage,
  // but the install dir is always reported for the CLI path.
  assert.deepEqual(await handler({}, { paseo }), { steerDelivery: true, findingsInPrompts: false, factoryRoot: null, pluginDir });
  assert.deepEqual(await loadPromptOptions(paseo), { findingsInPrompts: false, factoryRoot: null, pluginDir });
  writeFileSync(join(root, ".git"), "gitdir: /example/worktrees/factory\n");
  writeFileSync(join(root, "FINDINGS.md"), "# Findings\n");
  // Git-checkout install: the passage follows the setting.
  assert.deepEqual(await handler({}, { paseo }), { steerDelivery: true, findingsInPrompts: true, factoryRoot: realpathSync(root), pluginDir });
  assert.deepEqual(await loadPromptOptions(paseo), { findingsInPrompts: true, factoryRoot: realpathSync(root), pluginDir });

  values = { findingsInPrompts: false };
  assert.deepEqual(await handler({}, { paseo }), { steerDelivery: true, findingsInPrompts: false, factoryRoot: realpathSync(root), pluginDir });
  assert.deepEqual(await loadPromptOptions(paseo), { findingsInPrompts: false, factoryRoot: realpathSync(root), pluginDir });
  assert.equal(configReads, 6);
});
