import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findFactoryCheckout, findingsPassage } from '../plugin/server/core/findings.mjs';

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
