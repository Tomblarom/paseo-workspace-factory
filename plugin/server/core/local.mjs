// Read-only discovery of local git checkouts and their remotes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { remoteToFullName } from './github.mjs';

const SKIP = new Set(['node_modules', 'vendor', 'build', 'dist', 'target', '__pycache__']);

export function createGit(exec = execFileSync) {
  return function git(cwd, args) {
    return exec('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  };
}

/** Observe HEAD and dirty files without reading their contents. */
export function readCheckpointGit(git, cwd, head = null) {
  if (!cwd) return null;
  let sha = head;
  try {
    sha ??= git(cwd, ['rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) return null;
  try {
    const status = git(cwd, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const changes = status.split('\0').filter(Boolean);
    const hash = createHash('sha256').update(status);
    if (changes.length) {
      if (changes.length > 1000 || status.includes('\ufffd')) return { head: sha, worktree: null };
      const root = git(cwd, ['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '');
      let staged = false;
      for (let index = 0; index < changes.length; index++) {
        const row = changes[index];
        const flags = row.slice(0, 2);
        staged ||= ![' ', '?'].includes(flags[0]);
        const path = row.slice(3);
        const info = lstatSync(join(root, path), { bigint: true, throwIfNoEntry: false });
        // A changed submodule or nested repository needs its own observation.
        if (info?.isDirectory()) return { head: sha, worktree: null };
        hash.update(info ? `${info.mode}/${info.size}/${info.mtimeNs}/${info.ctimeNs}\0` : 'missing\0');
        if (/[RC]/.test(flags)) index++;
      }
      if (staged) hash.update(git(cwd, ['diff', '--cached', '--raw', '--no-abbrev', '-z', 'HEAD', '--']));
    }
    return { head: sha, worktree: hash.digest('hex').slice(0, 16) };
  } catch {
    return { head: sha, worktree: null };
  }
}

export function readRemotes(git, path) {
  let output = '';
  try {
    output = git(path, ['config', '--get-regexp', '^remote\\..*\\.url$']);
  } catch {
    return {}; // repository without remotes
  }
  const remotes = {};
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^remote\.(.+)\.url\s+(\S+)$/);
    if (match) remotes[match[1]] = match[2];
  }
  return remotes;
}

/**
 * Finds git checkouts below the roots (bounded depth, hidden/build dirs skipped)
 * plus explicitly known directories such as Paseo project and workspace roots.
 */
export function scanCheckouts({ roots, knownDirs = [], git, maxDepth = 3, fs = { readdirSync, realpathSync, existsSync, lstatSync } }) {
  const found = new Map();
  const visit = (dir) => {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (found.has(real)) return;
    const remotes = readRemotes(git, real);
    let linkedWorktree = false;
    try {
      linkedWorktree = fs.lstatSync(join(real, '.git')).isFile(); // worktree or submodule, never a main checkout
    } catch {
      linkedWorktree = false;
    }
    found.set(real, {
      path: real,
      linkedWorktree,
      remotes,
      repos: Object.fromEntries(Object.entries(remotes).map(([name, url]) => [name, remoteToFullName(url)])),
    });
  };
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    if (fs.existsSync(join(dir, '.git'))) return visit(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };
  for (const root of roots) walk(resolve(root), 0);
  for (const dir of knownDirs) if (dir && fs.existsSync(join(dir, '.git'))) visit(dir);
  return [...found.values()];
}

/**
 * Classifies checkouts for one repository. Only a checkout whose `origin` is the
 * target fork is reusable; anything else that touches the network is reported.
 */
export function classifyCheckouts(checkouts, { fork, upstream, source }) {
  const forkKey = fork?.toLowerCase();
  const related = new Set([upstream, source].filter(Boolean).map((name) => name.toLowerCase()));
  const exact = [];
  const other = [];
  for (const checkout of checkouts) {
    if (checkout.linkedWorktree) continue;
    const names = Object.values(checkout.repos).filter(Boolean);
    if (forkKey && checkout.repos.origin === forkKey) exact.push(checkout);
    else if (names.some((name) => name === forkKey || related.has(name))) other.push(checkout);
  }
  return { exact, related: other };
}
