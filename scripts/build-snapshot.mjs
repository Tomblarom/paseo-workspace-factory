#!/usr/bin/env node
// Build an immutable content-hashed plugin snapshot for the workspace factory.
//
// The live instance runs a snapshot install: a copy of plugin/ (without
// node_modules, package-lock.json and test/) under
// <releases>/workspace-factory-<hash12>, installed with id workspace-factory.
// hash12 is the first 12 hex chars of sha256 over the sorted file list with
// file hashes, so identical content always gives an identical directory.
//
// Default flow (build mode): verify the plugin/server/factory/ mirror is fresh
// (the equivalent of `node scripts/plugin-sync.mjs --check`; plugin-sync.mjs
// has no check mode, so the expected content is recomputed in memory), run
// `npm run typecheck` and the plugin tests, build the snapshot, then print the
// exact `paseo plugin remove`/`install` commands plus the rollback command for
// the previously installed snapshot. The script NEVER installs by default;
// installation only happens with `--install --confirm <hash12>`.
//
// `--prune` lists old snapshots (keeping the installed and the previous one)
// without deleting; deletion only happens with `--prune --confirm`.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLUGIN_ID = 'workspace-factory';
export const SNAPSHOT_PREFIX = 'workspace-factory-';
export const SNAPSHOT_PATTERN = /^workspace-factory-[0-9a-f]{12}$/;
// Top-level plugin/ entries that never ship in a snapshot.
export const SNAPSHOT_EXCLUDE = new Set(['node_modules', 'package-lock.json', 'test']);
// Must stay in sync with scripts/plugin-sync.mjs (single source of truth is
// src/; this is only the --check equivalent, never a second sync writer).
const SYNC_SKIP = new Set(['cli.mjs']);
const SYNC_HEADER = (file) =>
  `// @ts-nocheck\n// GENERATED from src/${file} by npm run plugin:sync. Do not edit.\n`;

export function defaultReleasesDir(home = homedir()) {
  return join(home, 'projects', 'paseo', 'releases');
}

export function parseArgs(argv) {
  const args = { outDir: null, install: false, confirm: null, confirmGiven: false, prune: false, skipChecks: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--out-dir' && i + 1 < argv.length) args.outDir = argv[++i];
    else if (token.startsWith('--out-dir=')) args.outDir = token.slice('--out-dir='.length);
    else if (token === '--install') args.install = true;
    else if (token === '--confirm' && i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
      args.confirm = argv[++i];
      args.confirmGiven = true;
    } else if (token === '--confirm') args.confirmGiven = true;
    else if (token.startsWith('--confirm=')) {
      args.confirm = token.slice('--confirm='.length);
      args.confirmGiven = true;
    } else if (token === '--prune') args.prune = true;
    else if (token === '--skip-checks') args.skipChecks = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token} (see --help)`);
  }
  return args;
}

export function usage() {
  return `usage: node scripts/build-snapshot.mjs [--out-dir <releases-dir>] [--skip-checks] [--install --confirm <hash12>]
       node scripts/build-snapshot.mjs --prune [--out-dir <releases-dir>] [--confirm]

Build mode verifies the factory mirror, runs the plugin typecheck and tests,
builds <releases>/workspace-factory-<hash12> (default releases dir
~/projects/paseo/releases) and prints the install/rollback commands.
Nothing is installed unless --install --confirm <hash12> names the built hash.

--prune only lists old snapshots (keeping installed and previous); files are
deleted only with --prune --confirm.`;
}

// What scripts/plugin-sync.mjs would write for one src file.
export function generatedContent(srcFile, source) {
  return SYNC_HEADER(srcFile) + source.replace(/\.mjs(?=['"])/g, '.js');
}

// Equivalent of `plugin-sync.mjs --check`: compare the mirror against freshly
// generated content without touching the working tree. Returns a list of stale
// entries (empty when fresh).
export function checkMirrorStale({ srcDir, factoryDir }) {
  const stale = [];
  if (!existsSync(factoryDir)) return ['missing directory: plugin/server/factory/ (run npm run plugin:sync)'];
  const generated = new Map(); // dest name -> expected content
  for (const file of readdirSync(srcDir).sort()) {
    if (!file.endsWith('.mjs') || SYNC_SKIP.has(file)) continue;
    const base = file.slice(0, -'.mjs'.length);
    generated.set(`${base}.ts`, generatedContent(file, readFileSync(join(srcDir, file), 'utf8')));
  }
  for (const [dest, expected] of generated) {
    const path = join(factoryDir, dest);
    if (!existsSync(path)) stale.push(`missing: plugin/server/factory/${dest}`);
    else if (readFileSync(path, 'utf8') !== expected) stale.push(`modified: plugin/server/factory/${dest}`);
  }
  for (const entry of readdirSync(factoryDir).sort()) {
    if (!entry.endsWith('.ts') || generated.has(entry)) continue;
    const content = readFileSync(join(factoryDir, entry), 'utf8');
    const match = content.match(/^\/\/ GENERATED from src\/(\S+) by npm run plugin:sync\./m);
    if (match && !existsSync(join(srcDir, match[1]))) stale.push(`orphan: plugin/server/factory/${entry} (src/${match[1]} gone)`);
  }
  return stale;
}

// Sorted snapshot file list as posix-style relative paths.
export function collectSnapshotFiles(pluginDir) {
  const relPaths = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (prefix === '' && SNAPSHOT_EXCLUDE.has(entry.name)) continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) relPaths.push(rel);
      // Anything else (symlinks, sockets, …) never ships in a snapshot.
    }
  };
  walk(pluginDir, '');
  return relPaths;
}

export function hashSnapshotFiles(pluginDir, relPaths = collectSnapshotFiles(pluginDir)) {
  const outer = createHash('sha256');
  for (const rel of relPaths) {
    const fileHash = createHash('sha256').update(readFileSync(join(pluginDir, rel))).digest('hex');
    outer.update(`${rel} ${fileHash}\n`);
  }
  return outer.digest('hex').slice(0, 12);
}

export function copySnapshotFiles(pluginDir, destDir, relPaths) {
  for (const rel of relPaths) {
    const dest = join(destDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(pluginDir, rel), dest);
  }
}

// Build (or reuse) the snapshot. Returns { snapshotDir, hash12, files, existed }.
export function buildSnapshot({ pluginDir, releasesDir }) {
  const relPaths = collectSnapshotFiles(pluginDir);
  if (relPaths.length === 0) throw new Error(`no snapshot files found in ${pluginDir}`);
  const hash12 = hashSnapshotFiles(pluginDir, relPaths);
  const snapshotDir = join(releasesDir, `${SNAPSHOT_PREFIX}${hash12}`);
  mkdirSync(releasesDir, { recursive: true });
  if (existsSync(snapshotDir)) {
    const existingHash = hashSnapshotFiles(snapshotDir, collectSnapshotFiles(snapshotDir));
    if (existingHash !== hash12) {
      throw new Error(`refusing to overwrite ${snapshotDir}: same name but different content`);
    }
    return { snapshotDir, hash12, files: relPaths, existed: true };
  }
  const staging = mkdtempSync(join(releasesDir, '.build-snapshot-'));
  try {
    copySnapshotFiles(pluginDir, staging, relPaths);
    const stagedHash = hashSnapshotFiles(staging, collectSnapshotFiles(staging));
    if (stagedHash !== hash12) throw new Error('staged snapshot hash mismatch (aborted before rename)');
    renameSync(staging, snapshotDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { snapshotDir, hash12, files: relPaths, existed: false };
}

export function defaultRun(cmd, args = [], opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' && error.stderr ? error.stderr : String(error.message ?? error),
    };
  }
}

// Run `npm run typecheck` and the plugin tests inside plugin/. Throws on failure.
export function runChecks({ run = defaultRun, pluginDir }) {
  const steps = [
    { name: 'npm run typecheck', args: ['run', 'typecheck'] },
    { name: 'npm test (plugin)', args: ['test'] },
  ];
  for (const step of steps) {
    const result = run('npm', step.args, { cwd: pluginDir });
    if (result.status !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      throw new Error(`${step.name} failed in ${pluginDir} (exit ${result.status})${output ? `:\n${output}` : ''}`);
    }
  }
}

// Installed source path of PLUGIN_ID from `paseo plugin ls --json`.
export function parsePluginLsJson(stdout) {
  const entries = JSON.parse(stdout);
  if (!Array.isArray(entries)) throw new Error('unexpected `paseo plugin ls --json` shape (not an array)');
  const entry = entries.find((item) => item && item.id === PLUGIN_ID);
  if (!entry) return null;
  return entry.path ?? entry.installation?.identity?.path ?? null;
}

// Fallback parser for the text table: the DIRECTORY column is the last
// absolute path on the plugin's row (ERROR would only add trailing words).
export function parsePluginLsText(stdout) {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(PLUGIN_ID) || !/^\S+\s/.test(line)) continue;
    const id = line.split(/\s+/, 1)[0];
    if (id !== PLUGIN_ID) continue;
    const paths = line.split(/\s+/).filter((token) => token.startsWith('/'));
    return paths.length > 0 ? paths[paths.length - 1] : null;
  }
  return null;
}

// Previously installed snapshot dir, via --json with a text fallback.
// Never throws: returns { path, via } with path null when undetectable.
export function findInstalledSnapshot({ run = defaultRun } = {}) {
  const json = run('paseo', ['plugin', 'ls', '--json']);
  if (json.status === 0) {
    try {
      const path = parsePluginLsJson(json.stdout);
      if (path) return { path, via: '--json' };
      return { path: null, via: '--json', note: `${PLUGIN_ID} is not installed` };
    } catch (error) {
      // Fall through to the text format.
    }
  }
  const text = run('paseo', ['plugin', 'ls']);
  if (text.status === 0) {
    try {
      const path = parsePluginLsText(text.stdout);
      if (path) return { path, via: 'text' };
      return { path: null, via: 'text', note: `${PLUGIN_ID} is not installed` };
    } catch (error) {
      return { path: null, via: 'text', note: String(error.message ?? error) };
    }
  }
  return { path: null, via: null, note: text.stderr.trim() || json.stderr.trim() || 'paseo CLI unavailable' };
}

export function shQuote(path) {
  return /[\s'"]/.test(path) ? `'${path.replace(/'/g, `'\\''`)}'` : path;
}

export function installCommands({ snapshotDir, previousDir }) {
  const remove = `paseo plugin remove ${PLUGIN_ID}`;
  const install = `paseo plugin install ${shQuote(snapshotDir)}`;
  const rollback = previousDir ? `${remove} && paseo plugin install ${shQuote(previousDir)}` : null;
  return { remove, install, rollback };
}

// Execute remove+install. Only runs when confirm names the built hash.
export function installSnapshot({ run = defaultRun, snapshotDir, hash12, confirm }) {
  if (!confirm || confirm !== hash12) {
    throw new Error(`refusing to install: --confirm must name the built hash (${hash12})`);
  }
  const remove = run('paseo', ['plugin', 'remove', PLUGIN_ID]);
  if (remove.status !== 0) {
    throw new Error(`paseo plugin remove failed (exit ${remove.status}): ${(remove.stderr || remove.stdout).trim()}`);
  }
  const install = run('paseo', ['plugin', 'install', snapshotDir]);
  if (install.status !== 0) {
    throw new Error(`paseo plugin install failed (exit ${install.status}): ${(install.stderr || install.stdout).trim()}`);
  }
  return { remove, install };
}

export function listSnapshots(releasesDir) {
  if (!existsSync(releasesDir)) return [];
  const snapshots = [];
  for (const entry of readdirSync(releasesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SNAPSHOT_PATTERN.test(entry.name)) continue;
    const dir = join(releasesDir, entry.name);
    snapshots.push({ name: entry.name, dir, mtimeMs: statSync(dir).mtimeMs });
  }
  snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return snapshots;
}

// Keep the installed snapshot and the previous (newest remaining) one.
export function planPrune({ releasesDir, installedDir }) {
  const snapshots = listSnapshots(releasesDir);
  const normalizedInstalled = installedDir ? resolve(installedDir) : null;
  const installed = normalizedInstalled
    ? snapshots.find((shot) => resolve(shot.dir) === normalizedInstalled) ?? null
    : null;
  const rest = snapshots.filter((shot) => shot !== installed);
  // Without a known installation, keep the two newest instead of one.
  const keep = installed
    ? [installed && { ...installed, reason: 'installed' }, rest[0] && { ...rest[0], reason: 'previous' }].filter(Boolean)
    : [rest[0] && { ...rest[0], reason: 'newest' }, rest[1] && { ...rest[1], reason: 'previous' }].filter(Boolean);
  const previous = installed ? (rest[0] ?? null) : (rest[1] ?? null);
  const keepDirs = new Set(keep.map((shot) => shot.dir));
  return { snapshots, installed, previous, keep, prune: snapshots.filter((shot) => !keepDirs.has(shot.dir)) };
}

export function pruneSnapshots({ releasesDir, installedDir, confirm }) {
  const plan = planPrune({ releasesDir, installedDir });
  if (!confirm) return { ...plan, deleted: [] };
  const deleted = [];
  for (const shot of plan.prune) {
    rmSync(shot.dir, { recursive: true, force: true });
    deleted.push(shot);
  }
  return { ...plan, deleted };
}

export function main(argv, deps = {}) {
  const { run = defaultRun, root = null, home = null, out = console.log, err = console.error } = deps;
  const repoRoot = root ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const fail = (message) => {
    err(`build-snapshot: ${message}`);
    return 1;
  };
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return fail(error.message);
  }
  if (args.help) {
    out(usage());
    return 0;
  }
  if (args.install && args.prune) return fail('--install and --prune are mutually exclusive');
  const releasesDir = args.outDir
    ? (isAbsolute(args.outDir) ? args.outDir : resolve(args.outDir))
    : defaultReleasesDir(home ?? homedir());
  const pluginDir = join(repoRoot, 'plugin');

  if (args.prune) {
    const installed = findInstalledSnapshot({ run });
    const result = pruneSnapshots({ releasesDir, installedDir: installed.path, confirm: args.confirmGiven });
    if (result.snapshots.length === 0) {
      out(`no snapshots in ${releasesDir}`);
      return 0;
    }
    if (!installed.path) out(`warning: installed snapshot unknown (${installed.note ?? 'not installed'}); keeping the two newest`);
    for (const shot of result.keep) out(`keep (${shot.reason}): ${shot.name}`);
    if (result.prune.length === 0) {
      out('nothing to prune');
      return 0;
    }
    if (args.confirmGiven) {
      for (const shot of result.deleted) out(`deleted: ${shot.name}`);
    } else {
      for (const shot of result.prune) out(`would delete: ${shot.name}`);
      out('preview only; re-run with --prune --confirm to delete');
    }
    return 0;
  }

  // Build mode.
  if (args.install && (!args.confirmGiven || !args.confirm)) return fail('--install requires --confirm <hash12> naming the built snapshot hash');
  if (!existsSync(pluginDir)) return fail(`plugin directory not found: ${pluginDir}`);
  if (!args.skipChecks) {
    const stale = checkMirrorStale({ srcDir: join(repoRoot, 'src'), factoryDir: join(pluginDir, 'server', 'factory') });
    if (stale.length > 0) {
      return fail(`plugin/server/factory/ mirror is stale (run npm run plugin:sync):\n  ${stale.join('\n  ')}`);
    }
    try {
      runChecks({ run, pluginDir });
    } catch (error) {
      return fail(error.message);
    }
    out('checks: mirror fresh, typecheck ok, plugin tests ok');
  }
  let built;
  try {
    built = buildSnapshot({ pluginDir, releasesDir });
  } catch (error) {
    return fail(error.message);
  }
  out(`snapshot: ${built.snapshotDir} (${built.files.length} files, hash ${built.hash12})${built.existed ? ' (already existed, identical content)' : ''}`);
  const installed = findInstalledSnapshot({ run });
  const previousDir = installed.path && resolve(installed.path) !== resolve(built.snapshotDir) ? installed.path : null;
  if (!installed.path) out(`warning: previous snapshot unknown (${installed.note ?? 'not installed'})`);
  const commands = installCommands({ snapshotDir: built.snapshotDir, previousDir });
  out('');
  out('Install (never automatic; remove wipes the installation\'s settings, note slots/profiles first):');
  out(`  ${commands.remove}`);
  out(`  ${commands.install}`);
  if (commands.rollback) {
    out('Rollback to the previous snapshot:');
    out(`  ${commands.rollback}`);
  }
  out('Then verify: paseo plugin ls (running), paseo plugin logs workspace-factory, /factory status');
  if (args.install) {
    try {
      installSnapshot({ run, snapshotDir: built.snapshotDir, hash12: built.hash12, confirm: args.confirm });
    } catch (error) {
      return fail(error.message);
    }
    out(`installed ${built.snapshotDir}`);
  }
  return 0;
}

const invokedAsScript = (() => {
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedAsScript) process.exit(main(process.argv.slice(2)));
