#!/usr/bin/env node
// Syncs the factory core (src/*.mjs) into the plugin package as TypeScript.
// The plugin compiler only bundles files inside the plugin directory, so the
// core must travel inside the package. This script keeps src/ the single
// source of truth: generated files carry a banner and are never edited by hand.
// The CLI entry (cli.mjs) is skipped; plugin handlers call the core directly.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const destDir = join(root, 'plugin', 'server', 'factory');
const SKIP = new Set(['cli.mjs']);
// Pure leaf modules (zero imports, browser-safe) that plugin/shared/ — and
// therefore the plugin client — needs from the core. Mirrored 1:1 like the
// factory copy; the rest of shared/ stays hand-written. Must stay in sync
// with SHARED_MIRROR in scripts/build-snapshot.mjs.
const SHARED_MIRROR = [['defaults.mjs', join('shared', 'defaults.ts')]];

rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });

const synced = [];
for (const file of readdirSync(srcDir).sort()) {
  if (!file.endsWith('.mjs') || SKIP.has(file)) continue;
  const base = file.slice(0, -'.mjs'.length);
  const source = readFileSync(join(srcDir, file), 'utf8');
  // TypeScript with moduleResolution Bundler maps './x.js' to './x.ts'.
  const rewritten = source.replace(/\.mjs(?=['"])/g, '.js');
  const header = `// @ts-nocheck\n// GENERATED from src/${file} by npm run plugin:sync. Do not edit.\n`;
  writeFileSync(join(destDir, `${base}.ts`), `${header}${rewritten}`);
  synced.push(`${file} -> server/factory/${base}.ts`);
}
for (const [file, dest] of SHARED_MIRROR) {
  const source = readFileSync(join(srcDir, file), 'utf8');
  const rewritten = source.replace(/\.mjs(?=['"])/g, '.js');
  const header = `// @ts-nocheck\n// GENERATED from src/${file} by npm run plugin:sync. Do not edit.\n`;
  writeFileSync(join(root, 'plugin', dest), `${header}${rewritten}`);
  synced.push(`${file} -> ${dest}`);
}
console.log(`plugin:sync: ${synced.length} modules`);
for (const line of synced) console.log(`  ${line}`);
