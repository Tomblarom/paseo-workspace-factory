// @ts-nocheck
// GENERATED from src/factory.mjs by npm run plugin:sync. Do not edit.
// Wiring: one fresh discovery pass over GitHub, the filesystem and Paseo.
// K13: single-workspace enrollment only — runPlans takes exactly one entry.
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { discoverRepository, normalizeEntry } from './discovery.js';
import { scanCheckouts } from './local.js';
import { readPaseoState } from './paseo.js';
import { planRepository } from './planner.js';
import { listScopes, resolveScope, scopeToEntry } from './scope.js';

/**
 * Plans existing scopes by id: before discovery, an address that hits a live
 * scope (scope id or workspace:<id>) is rewritten to that scope's own entry,
 * keeping per-entry options (--domain, --name, ...). A workspace:<id> on a
 * non-worktree workspace with a live scope thus plans that scope instead of
 * failing as "not a worktree workspace". Legacy local/<folder> aliases keep
 * their own lookup (ambiguity checks unchanged). Ambiguous addresses throw
 * ScopeConflict like status/resolveTargetEntry.
 */
function resolvePlanEntry(entry, paseoState) {
  const scope = resolveScope(entry, paseoState);
  if (!scope || scope.deprecatedAlias === true) return entry;
  const base = scopeToEntry(scope);
  if (typeof entry === 'string' || !entry || typeof entry !== 'object' || Array.isArray(entry)) return base;
  const keep = {};
  // Retired keys (checkout, subject) pass through so normalizeEntry reports
  // them as retired instead of silently dropping them.
  for (const key of ['name', 'subject', 'hub', 'domain', 'main', 'checkout', 'parentDir']) {
    if (entry[key] !== undefined) keep[key] = entry[key];
  }
  if (!Object.keys(keep).length) return base;
  return typeof base === 'string' ? { repo: base, ...keep } : { ...base, ...keep };
}

export function createRunner({ config, client, gh, git, readState = readPaseoState, scan = scanCheckouts, realpath = realpathSync, existsDir } = {}) {
  async function discoverAll(entries, { state = null } = {}) {
    const paseo = state ?? await readState(client);
    const liveScopes = listScopes(paseo);
    const resolved = entries.map((e) => resolvePlanEntry(e, paseo));
    const normalized = resolved.map((e) => normalizeEntry(e, config));
    const roots = [...new Set([
      config.checkoutRoot,
      ...normalized.map((n) => n.parentDir),
      ...normalized.filter((n) => n.local).map((n) => dirname(n.local)),
    ])];
    const knownDirs = [
      ...paseo.projects.map((p) => p.projectRootPath),
      ...paseo.workspaces.map((w) => w.workspaceDirectory),
    ];
    const checkouts = scan({ roots, knownDirs, git });
    return resolved.map((entry) => discoverRepository(entry, { config, gh, git, checkouts, paseo, realpath, liveScopes, ...(existsDir ? { existsDir } : {}) }));
  }
  return {
    discoverAll,
    async runPlans(entries, { adopt = {}, slots, adoptWorker = {}, detach = false, state = null } = {}) {
      if (!Array.isArray(entries) || entries.length !== 1) {
        throw new Error(`plan needs exactly one workspace entry, got ${Array.isArray(entries) ? entries.length : '?'}; enroll one existing workspace at a time`);
      }
      const discoveries = await discoverAll(entries, { state });
      const d = discoveries[0];
      // Single-entry adoption: the legacy '*' fallback plus exact scope/repo
      // keys (scoped per-entry keys are retired with multi-repo plans).
      const adoptFor = adopt['*'] ?? adopt[d.scope?.id?.toLowerCase()] ?? adopt[d.forkName?.toLowerCase()] ?? adopt[String(d.input ?? '').toLowerCase()] ?? {};
      return [planRepository(d, config, { adopt: adoptFor, slots, adoptWorker, detach })];
    },
  };
}
