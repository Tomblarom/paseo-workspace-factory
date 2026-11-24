import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SNAPSHOT_PATTERN,
  buildSnapshot,
  checkMirrorStale,
  collectSnapshotFiles,
  findInstalledSnapshot,
  generatedContent,
  hashSnapshotFiles,
  installCommands,
  installSnapshot,
  listSnapshots,
  main,
  parseArgs,
  parsePluginLsJson,
  parsePluginLsText,
  planPrune,
  pruneSnapshots,
  runChecks,
} from '../scripts/build-snapshot.mjs';

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'build-snapshot-'));
}

function writePluginFixture(pluginDir, extra = {}) {
  const files = {
    'paseo-plugin.json': '{"id": "workspace-factory"}\n',
    'package.json': '{"name": "fixture"}\n',
    'index.server.ts': 'export const x = 1;\n',
    'client/panel.tsx': 'export const panel = 1;\n',
    'server/handlers.ts': 'export const h = 1;\n',
    'shared/factory.ts': 'export const c = 1;\n',
    'node_modules/dep/index.js': 'should be excluded\n',
    'package-lock.json': '{"lockfileVersion": 3}\n',
    'test/example.test.mjs': 'should be excluded\n',
    ...extra,
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(pluginDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return files;
}

function writeSrcFactoryMirror(root, { stale = null, orphan = false } = {}) {
  const srcDir = join(root, 'src');
  const factoryDir = join(root, 'plugin', 'server', 'factory');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(factoryDir, { recursive: true });
  writeFileSync(join(srcDir, 'alpha.mjs'), `import { x } from './beta.mjs';\nexport const a = x;\n`);
  writeFileSync(join(srcDir, 'beta.mjs'), 'export const x = 1;\n');
  writeFileSync(join(srcDir, 'cli.mjs'), 'cli entry is skipped\n');
  for (const file of ['alpha.mjs', 'beta.mjs']) {
    const base = file.slice(0, -'.mjs'.length);
    writeFileSync(join(factoryDir, `${base}.ts`), generatedContent(file, readFileSync(join(srcDir, file), 'utf8')));
  }
  if (stale === 'modified') writeFileSync(join(factoryDir, 'alpha.ts'), '// hand edit\n');
  if (stale === 'missing-file') rmSync(join(factoryDir, 'alpha.ts'));
  if (orphan) {
    writeFileSync(join(factoryDir, 'gone.ts'), generatedContent('gone.mjs', 'export const g = 1;\n'));
  }
  return { srcDir, factoryDir };
}

// process-runner fake: handlers keyed by "cmd args…", records every call.
function fakeRun(handlers = {}) {
  const calls = [];
  const run = (cmd, args = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    const key = `${cmd} ${args.join(' ')}`;
    if (key in handlers) return handlers[key];
    if (cmd in handlers) return handlers[cmd](args, opts);
    throw new Error(`unexpected run call in test: ${key}`);
  };
  run.calls = calls;
  return run;
}

function captureOutput() {
  const lines = { out: [], err: [] };
  return {
    lines,
    deps: { out: (line) => lines.out.push(line), err: (line) => lines.err.push(line) },
  };
}

test('collectSnapshotFiles skips node_modules, package-lock.json and test/', () => {
  const pluginDir = join(makeTempRoot(), 'plugin');
  writePluginFixture(pluginDir);
  const files = collectSnapshotFiles(pluginDir);
  assert.deepEqual(files, [
    'client/panel.tsx',
    'index.server.ts',
    'package.json',
    'paseo-plugin.json',
    'server/handlers.ts',
    'shared/factory.ts',
  ]);
  assert.ok(!files.some((rel) => rel.includes('node_modules') || rel.includes('package-lock') || rel.startsWith('test/')));
});

test('hash12 is stable for identical content and changes with it', () => {
  const a = join(makeTempRoot(), 'plugin');
  const b = join(makeTempRoot(), 'plugin');
  writePluginFixture(a);
  writePluginFixture(b);
  const hashA = hashSnapshotFiles(a);
  const hashB = hashSnapshotFiles(b);
  assert.match(hashA, /^[0-9a-f]{12}$/);
  assert.equal(hashA, hashB);
  assert.match(`workspace-factory-${hashA}`, SNAPSHOT_PATTERN);
  writePluginFixture(b, { 'shared/factory.ts': 'export const c = 2;\n' });
  assert.notEqual(hashSnapshotFiles(b), hashA);
});

test('buildSnapshot copies the subset and reuses identical content', () => {
  const root = makeTempRoot();
  const pluginDir = join(root, 'plugin');
  writePluginFixture(pluginDir);
  const releasesDir = join(root, 'releases');
  const first = buildSnapshot({ pluginDir, releasesDir });
  assert.match(first.snapshotDir, /workspace-factory-[0-9a-f]{12}$/);
  assert.equal(first.existed, false);
  assert.equal(first.files.length, 6);
  assert.ok(existsSync(join(first.snapshotDir, 'shared', 'factory.ts')));
  assert.ok(!existsSync(join(first.snapshotDir, 'node_modules')));
  assert.ok(!existsSync(join(first.snapshotDir, 'package-lock.json')));
  assert.ok(!existsSync(join(first.snapshotDir, 'test')));
  const second = buildSnapshot({ pluginDir, releasesDir });
  assert.equal(second.snapshotDir, first.snapshotDir);
  assert.equal(second.existed, true);
});

test('buildSnapshot refuses to overwrite a same-named foreign directory', () => {
  const root = makeTempRoot();
  const pluginDir = join(root, 'plugin');
  writePluginFixture(pluginDir);
  const releasesDir = join(root, 'releases');
  mkdirSync(releasesDir, { recursive: true });
  const hash12 = hashSnapshotFiles(pluginDir);
  const foreign = join(releasesDir, `workspace-factory-${hash12}`);
  mkdirSync(join(foreign, 'server'), { recursive: true });
  writeFileSync(join(foreign, 'server', 'handlers.ts'), 'different content\n');
  assert.throws(() => buildSnapshot({ pluginDir, releasesDir }), /refusing to overwrite/);
});

test('checkMirrorStale mirrors plugin-sync exactly, including orphans', () => {
  const fresh = makeTempRoot();
  const { srcDir, factoryDir } = writeSrcFactoryMirror(fresh);
  assert.deepEqual(checkMirrorStale({ srcDir, factoryDir }), []);
  // .mjs imports are rewritten to .js like plugin-sync.mjs does.
  assert.ok(readFileSync(join(factoryDir, 'alpha.ts'), 'utf8').includes(`from './beta.js'`));
  // cli.mjs is skipped.
  assert.ok(!existsSync(join(factoryDir, 'cli.ts')));

  const modified = makeTempRoot();
  const mod = writeSrcFactoryMirror(modified, { stale: 'modified' });
  assert.deepEqual(checkMirrorStale(mod), ['modified: plugin/server/factory/alpha.ts']);

  const missing = makeTempRoot();
  const miss = writeSrcFactoryMirror(missing, { stale: 'missing-file' });
  assert.deepEqual(checkMirrorStale(miss), ['missing: plugin/server/factory/alpha.ts']);

  const orphaned = makeTempRoot();
  const orph = writeSrcFactoryMirror(orphaned, { orphan: true });
  assert.deepEqual(checkMirrorStale(orph), ['orphan: plugin/server/factory/gone.ts (src/gone.mjs gone)']);

  // Hand-written extras without the GENERATED banner are left alone.
  writeFileSync(join(orph.factoryDir, 'hand.ts'), 'export const h = 1;\n');
  assert.deepEqual(checkMirrorStale(orph), ['orphan: plugin/server/factory/gone.ts (src/gone.mjs gone)']);
});

test('runChecks runs typecheck and plugin tests in the plugin dir', () => {
  const run = fakeRun({
    'npm run typecheck': { status: 0, stdout: 'ok', stderr: '' },
    'npm test': { status: 0, stdout: 'pass 10', stderr: '' },
  });
  runChecks({ run, pluginDir: '/tmp/fake-plugin' });
  assert.deepEqual(run.calls.map((call) => call.args), [['run', 'typecheck'], ['test']]);
  assert.ok(run.calls.every((call) => call.opts.cwd === '/tmp/fake-plugin'));

  const failing = fakeRun({
    'npm run typecheck': { status: 0, stdout: '', stderr: '' },
    'npm test': { status: 1, stdout: '', stderr: '1 failing' },
  });
  assert.throws(() => runChecks({ run: failing, pluginDir: '/tmp/fake-plugin' }), /npm test \(plugin\) failed.*1 failing/s);
});

test('parsePluginLsJson and parsePluginLsText find the installed snapshot', () => {
  const json = JSON.stringify([
    { id: 'other', path: '/releases/other' },
    { id: 'workspace-factory', path: '/releases/workspace-factory-40513961cc4f', status: 'running' },
  ]);
  assert.equal(parsePluginLsJson(json), '/releases/workspace-factory-40513961cc4f');
  assert.equal(parsePluginLsJson('[]'), null);
  const identityOnly = JSON.stringify([
    { id: 'workspace-factory', installation: { identity: { kind: 'directory', path: '/snap/dir' } } },
  ]);
  assert.equal(parsePluginLsJson(identityOnly), '/snap/dir');

  const text = [
    'PLUGIN STATUS ENABLED SOURCE REVISION DIRECTORY ERROR',
    'other running yes /releases/other - /releases/other',
    'workspace-factory running yes /releases/workspace-factory-40513961cc4f - /releases/workspace-factory-40513961cc4f',
  ].join('\n');
  assert.equal(parsePluginLsText(text), '/releases/workspace-factory-40513961cc4f');
  assert.equal(parsePluginLsText('PLUGIN STATUS\n'), null);
  // A longer id sharing the prefix must not match.
  assert.equal(parsePluginLsText('workspace-factoryx running yes /a - /a\n'), null);
});

test('findInstalledSnapshot prefers --json and falls back to text', () => {
  const viaJson = fakeRun({
    'paseo plugin ls --json': { status: 0, stdout: JSON.stringify([{ id: 'workspace-factory', path: '/snap/a' }]), stderr: '' },
  });
  assert.deepEqual(findInstalledSnapshot({ run: viaJson }), { path: '/snap/a', via: '--json' });
  assert.equal(viaJson.calls.length, 1);

  const viaText = fakeRun({
    'paseo plugin ls --json': { status: 1, stdout: '', stderr: 'no json' },
    'paseo plugin ls': { status: 0, stdout: 'workspace-factory running yes /snap/b - /snap/b\n', stderr: '' },
  });
  assert.deepEqual(findInstalledSnapshot({ run: viaText }), { path: '/snap/b', via: 'text' });

  const missing = fakeRun({
    'paseo plugin ls --json': { status: 1, stdout: '', stderr: 'denied' },
    'paseo plugin ls': { status: 1, stdout: '', stderr: 'denied' },
  });
  const result = findInstalledSnapshot({ run: missing });
  assert.equal(result.path, null);
  assert.ok(result.note.includes('denied'));
});

test('installSnapshot needs the exact confirm hash and runs remove before install', () => {
  const run = fakeRun({
    'paseo plugin remove workspace-factory': { status: 0, stdout: 'removed', stderr: '' },
    'paseo plugin install /snap/new': { status: 0, stdout: 'installed', stderr: '' },
  });
  installSnapshot({ run, snapshotDir: '/snap/new', hash12: 'abc123', confirm: 'abc123' });
  assert.deepEqual(run.calls.map((call) => call.args), [
    ['plugin', 'remove', 'workspace-factory'],
    ['plugin', 'install', '/snap/new'],
  ]);

  for (const confirm of [null, undefined, 'wrong']) {
    const guarded = fakeRun({});
    assert.throws(
      () => installSnapshot({ run: guarded, snapshotDir: '/snap/new', hash12: 'abc123', confirm }),
      /--confirm must name the built hash/,
    );
    assert.equal(guarded.calls.length, 0);
  }

  const removeFails = fakeRun({
    'paseo plugin remove workspace-factory': { status: 1, stdout: '', stderr: 'not installed' },
  });
  assert.throws(
    () => installSnapshot({ run: removeFails, snapshotDir: '/snap/new', hash12: 'abc123', confirm: 'abc123' }),
    /remove failed/,
  );
  assert.equal(removeFails.calls.length, 1);
});

test('installCommands prints exact remove/install/rollback lines', () => {
  const commands = installCommands({ snapshotDir: '/rel/workspace-factory-new12345678', previousDir: '/rel/workspace-factory-old12345678' });
  assert.equal(commands.remove, 'paseo plugin remove workspace-factory');
  assert.equal(commands.install, 'paseo plugin install /rel/workspace-factory-new12345678');
  assert.equal(commands.rollback, 'paseo plugin remove workspace-factory && paseo plugin install /rel/workspace-factory-old12345678');
  assert.equal(installCommands({ snapshotDir: '/rel/new', previousDir: null }).rollback, null);
});

function seedSnapshots(releasesDir, names) {
  mkdirSync(releasesDir, { recursive: true });
  const base = Date.now() - names.length * 1000;
  names.forEach((name, index) => {
    const dir = join(releasesDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'marker.txt'), name);
    const mtime = new Date(base + index * 1000);
    utimesSync(dir, mtime, mtime);
  });
}

test('planPrune keeps installed and previous, ignores foreign names', () => {
  const releasesDir = join(makeTempRoot(), 'releases');
  seedSnapshots(releasesDir, [
    'workspace-factory-aaaaaaaaaaaa',
    'workspace-factory-bbbbbbbbbbbb',
    'workspace-factory-cccccccccccc',
    'workspace-factory-cli-bbacf4644e94',
    'browser-serial-422f978594c0',
  ]);
  // Newest is cccc; installed is aaaa (oldest) to prove both are kept.
  const plan = planPrune({ releasesDir, installedDir: join(releasesDir, 'workspace-factory-aaaaaaaaaaaa') });
  assert.deepEqual(plan.keep.map((shot) => shot.name), ['workspace-factory-aaaaaaaaaaaa', 'workspace-factory-cccccccccccc']);
  assert.deepEqual(plan.prune.map((shot) => shot.name), ['workspace-factory-bbbbbbbbbbbb']);
  assert.ok(!plan.snapshots.some((shot) => shot.name.includes('cli-') || shot.name.startsWith('browser-')));

  // Unknown installation: keep the two newest.
  const unknown = planPrune({ releasesDir, installedDir: null });
  assert.deepEqual(unknown.prune.map((shot) => shot.name), ['workspace-factory-aaaaaaaaaaaa']);

  // Two or fewer snapshots: nothing to prune.
  const small = join(makeTempRoot(), 'releases');
  seedSnapshots(small, ['workspace-factory-aaaaaaaaaaaa', 'workspace-factory-bbbbbbbbbbbb']);
  assert.deepEqual(planPrune({ releasesDir: small, installedDir: null }).prune, []);
});

test('pruneSnapshots previews without deleting, deletes only with confirm', () => {
  const releasesDir = join(makeTempRoot(), 'releases');
  seedSnapshots(releasesDir, [
    'workspace-factory-aaaaaaaaaaaa',
    'workspace-factory-bbbbbbbbbbbb',
    'workspace-factory-cccccccccccc',
  ]);
  const preview = pruneSnapshots({ releasesDir, installedDir: null, confirm: false });
  assert.deepEqual(preview.prune.map((shot) => shot.name), ['workspace-factory-aaaaaaaaaaaa']);
  assert.deepEqual(preview.deleted, []);
  assert.ok(existsSync(join(releasesDir, 'workspace-factory-aaaaaaaaaaaa')));

  const applied = pruneSnapshots({ releasesDir, installedDir: null, confirm: true });
  assert.deepEqual(applied.deleted.map((shot) => shot.name), ['workspace-factory-aaaaaaaaaaaa']);
  assert.ok(!existsSync(join(releasesDir, 'workspace-factory-aaaaaaaaaaaa')));
  assert.ok(existsSync(join(releasesDir, 'workspace-factory-cccccccccccc')));
});

test('listSnapshots returns newest first and tolerates a missing dir', () => {
  const releasesDir = join(makeTempRoot(), 'releases');
  seedSnapshots(releasesDir, ['workspace-factory-aaaaaaaaaaaa', 'workspace-factory-bbbbbbbbbbbb']);
  assert.deepEqual(listSnapshots(releasesDir).map((shot) => shot.name), [
    'workspace-factory-bbbbbbbbbbbb',
    'workspace-factory-aaaaaaaaaaaa',
  ]);
  assert.deepEqual(listSnapshots(join(makeTempRoot(), 'nope')), []);
});

test('main build prints commands and never installs by default', () => {
  const root = makeTempRoot();
  const pluginDir = join(root, 'plugin');
  writePluginFixture(pluginDir);
  writeSrcFactoryMirror(root);
  const releasesDir = join(root, 'releases');
  const run = fakeRun({
    'npm run typecheck': { status: 0, stdout: '', stderr: '' },
    'npm test': { status: 0, stdout: '', stderr: '' },
    'paseo plugin ls --json': {
      status: 0,
      stdout: JSON.stringify([{ id: 'workspace-factory', path: join(releasesDir, 'workspace-factory-40513961cc4f') }]),
      stderr: '',
    },
  });
  const { lines, deps } = captureOutput();
  const code = main(['--out-dir', releasesDir], { run, root, ...deps });
  assert.equal(code, 0);
  const output = lines.out.join('\n');
  assert.ok(output.includes('checks: mirror fresh, typecheck ok, plugin tests ok'));
  assert.ok(output.includes('paseo plugin remove workspace-factory'));
  assert.ok(output.includes('paseo plugin install'));
  assert.ok(output.includes('workspace-factory-40513961cc4f'));
  assert.ok(!run.calls.some((call) => call.args[1] === 'remove' || call.args[1] === 'install'));

  // Stale mirror fails the build before any check command runs.
  writeFileSync(join(pluginDir, 'server', 'factory', 'alpha.ts'), '// stale\n');
  const staleRun = fakeRun({
    'npm run typecheck': { status: 0, stdout: '', stderr: '' },
    'npm test': { status: 0, stdout: '', stderr: '' },
    'paseo plugin ls --json': { status: 0, stdout: '[]', stderr: '' },
    'paseo plugin ls': { status: 0, stdout: '', stderr: '' },
  });
  const staleCapture = captureOutput();
  const staleCode = main(['--out-dir', releasesDir], { run: staleRun, root, ...staleCapture.deps });
  assert.equal(staleCode, 1);
  assert.ok(staleCapture.lines.err.join('\n').includes('mirror is stale'));
  assert.equal(staleRun.calls.length, 0);
});

test('main rejects --install without a matching --confirm hash', () => {
  const root = makeTempRoot();
  writePluginFixture(join(root, 'plugin'));
  const { deps } = captureOutput();
  const run = fakeRun({});
  assert.equal(main(['--install', '--out-dir', join(root, 'releases')], { run, root, ...deps }), 1);
  assert.equal(run.calls.length, 0);
  assert.deepEqual(parseArgs(['--install', '--confirm', 'abc123']).confirm, 'abc123');
  assert.equal(parseArgs(['--prune', '--confirm']).confirmGiven, true);
});

test('main --prune previews and deletes only with --confirm', () => {
  const root = makeTempRoot();
  const releasesDir = join(root, 'releases');
  seedSnapshots(releasesDir, [
    'workspace-factory-aaaaaaaaaaaa',
    'workspace-factory-bbbbbbbbbbbb',
    'workspace-factory-cccccccccccc',
  ]);
  const lsJson = JSON.stringify([
    { id: 'workspace-factory', path: join(releasesDir, 'workspace-factory-cccccccccccc') },
  ]);
  const previewRun = fakeRun({ 'paseo plugin ls --json': { status: 0, stdout: lsJson, stderr: '' } });
  const preview = captureOutput();
  assert.equal(main(['--prune', '--out-dir', releasesDir], { run: previewRun, root, ...preview.deps }), 0);
  assert.ok(preview.lines.out.some((line) => line.includes('keep (installed): workspace-factory-cccccccccccc')));
  assert.ok(preview.lines.out.some((line) => line.includes('would delete: workspace-factory-aaaaaaaaaaaa')));
  assert.ok(existsSync(join(releasesDir, 'workspace-factory-aaaaaaaaaaaa')));

  const deleteRun = fakeRun({ 'paseo plugin ls --json': { status: 0, stdout: lsJson, stderr: '' } });
  const deleted = captureOutput();
  assert.equal(main(['--prune', '--confirm', '--out-dir', releasesDir], { run: deleteRun, root, ...deleted.deps }), 0);
  assert.ok(deleted.lines.out.some((line) => line.includes('deleted: workspace-factory-aaaaaaaaaaaa')));
  assert.ok(!existsSync(join(releasesDir, 'workspace-factory-aaaaaaaaaaaa')));
  assert.ok(existsSync(join(releasesDir, 'workspace-factory-cccccccccccc')));
});
