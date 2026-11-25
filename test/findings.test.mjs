import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCliPromptOptions } from '../src/cli.mjs';
import { findFactoryCheckout, findingsPassage } from '../src/findings.mjs';

test('findings passage only for a git-checkout install', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'factory-findings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'paseo-workspace-factory' }));
  assert.equal(findFactoryCheckout(root), null, 'a packaged copy lacks a Git checkout');
  assert.equal(findingsPassage(), '', 'no checkout, no passage');

  mkdirSync(join(root, '.git'));
  const factoryRoot = findFactoryCheckout(root);
  assert.equal(factoryRoot, root);
  const passage = findingsPassage({ factoryRoot });
  assert.ok(passage.includes(join(root, 'FINDINGS.md')));
  assert.equal(passage.split('\n').length, 3);
  assert.match(passage, /YYYY-MM-DD · <role\/slot> · <observation> · <evidence or suggestion>/);
  assert.match(passage, /user’s consent/);
  assert.equal(findingsPassage({ factoryRoot, findingsInPrompts: false }), '');
});

test('CLI prompt settings follow the plugin install and fall back to the CLI checkout', async () => {
  const calls = [];
  const reply = (value) => async () => ({
    async invokePluginRpc(...args) {
      calls.push(args);
      return value;
    },
    async close() { calls.push('closed'); },
  });
  const off = await readCliPromptOptions({ createClient: reply({ findingsInPrompts: false, factoryRoot: '/srv/factory' }) });
  assert.equal(off.findingsInPrompts, false);
  assert.deepEqual(calls, [['workspace-factory', 'factory.prompt-settings', {}], 'closed']);

  // A snapshot or registry install reports no checkout: no passage.
  const snapshot = await readCliPromptOptions({ createClient: reply({ findingsInPrompts: true, factoryRoot: null }) });
  assert.equal(snapshot.factoryRoot, null);
  assert.equal(findingsPassage(snapshot), '');
  const git = await readCliPromptOptions({ createClient: reply({ findingsInPrompts: true, factoryRoot: '/srv/factory' }) });
  assert.equal(git.factoryRoot, '/srv/factory');
  assert.match(findingsPassage(git), /\/srv\/factory\/FINDINGS\.md/);

  // Without the plugin the CLI's own checkout counts as the git install.
  const failed = async () => { throw new Error('unavailable'); };
  const standalone = await readCliPromptOptions({ createClient: failed });
  assert.equal(standalone.findingsInPrompts, true);
  const missingRpc = async () => ({ invokePluginRpc: failed });
  assert.equal((await readCliPromptOptions({ createClient: missingRpc })).findingsInPrompts, true);
});
