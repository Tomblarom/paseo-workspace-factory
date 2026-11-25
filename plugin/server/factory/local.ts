// @ts-nocheck
// GENERATED from src/local.mjs by npm run plugin:sync. Do not edit.
// Read-only discovery of local git checkouts and their remotes.
import { execFileSync } from 'node:child_process';
import { readdirSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { remoteToFullName } from './github.js';

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
