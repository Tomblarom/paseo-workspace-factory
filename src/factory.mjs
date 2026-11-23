// Wiring: one fresh discovery pass over GitHub, the filesystem and Paseo.
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { discoverRepository, normalizeEntry } from './discovery.mjs';
import { scanCheckouts, inspectCloneTarget } from './local.mjs';
import { readPaseoState } from './paseo.mjs';
import { planRepository } from './planner.mjs';
import { listScopes } from './scope.mjs';

export function createRunner({ config, client, gh, git, readState = readPaseoState, scan = scanCheckouts, inspectTarget = inspectCloneTarget, realpath = realpathSync, existsDir } = {}) {
  async function discoverAll(entries) {
    const paseo = await readState(client);
    const liveScopes = listScopes(paseo);
    const normalized = entries.map((e) => normalizeEntry(e, config));
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
    return entries.map((entry) => discoverRepository(entry, { config, gh, git, checkouts, paseo, realpath, inspectTarget, liveScopes, ...(existsDir ? { existsDir } : {}) }));
  }
  // Location identity for the cross-entry scope check: same workspace (or same
  // expected path while creating) is the same scope addressed twice, not a dup.
  const scopeSite = (d) => d.mainWorkspace?.id ?? d.expectedPath ?? d.input;
  return {
    discoverAll,
    async runPlans(entries, { allowFork = false, adopt = {}, slots, adoptWorker = {}, detach = false, retitle = false, renameProject = null } = {}) {
      const discoveries = await discoverAll(entries);
      for (const [index, d] of discoveries.entries()) {
        d.siblingScopes = discoveries
          .filter((other, j) => j !== index && other.scope?.id && scopeSite(other) !== scopeSite(d))
          .map((other) => ({ id: other.scope.id, kind: other.scope.kind }));
      }
      return discoveries.map((d) => planRepository(d, config, {
        allowFork,
        // Scoped adoption (`--adopt <scope-id>:X=<agent>`) wins over the legacy
        // repo/input keys; '*' stays the single-entry fallback.
        adopt: adopt[d.scope?.id?.toLowerCase()] ?? adopt[d.forkName?.toLowerCase()] ?? adopt[String(d.input ?? '').toLowerCase()] ?? adopt['*'] ?? {},
        slots,
        adoptWorker,
        detach,
        retitle,
        renameProject,
      }));
    },
  };
}
