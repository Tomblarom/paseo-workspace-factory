// Wiring: one fresh discovery pass over GitHub, the filesystem and Paseo.
import { realpathSync } from 'node:fs';
import { discoverRepository, normalizeEntry } from './discovery.mjs';
import { scanCheckouts, inspectCloneTarget } from './local.mjs';
import { readPaseoState } from './paseo.mjs';
import { planRepository } from './planner.mjs';

export function createRunner({ config, client, gh, git, readState = readPaseoState, scan = scanCheckouts, inspectTarget = inspectCloneTarget, realpath = realpathSync }) {
  async function discoverAll(entries) {
    const paseo = await readState(client);
    const roots = [...new Set([config.checkoutRoot, ...entries.map((e) => normalizeEntry(e, config).parentDir)])];
    const knownDirs = [
      ...paseo.projects.map((p) => p.projectRootPath),
      ...paseo.workspaces.map((w) => w.workspaceDirectory),
    ];
    const checkouts = scan({ roots, knownDirs, git });
    return entries.map((entry) => discoverRepository(entry, { config, gh, git, checkouts, paseo, realpath, inspectTarget }));
  }
  return {
    discoverAll,
    async runPlans(entries, { allowFork = false, adopt = {} } = {}) {
      const discoveries = await discoverAll(entries);
      return discoveries.map((d) => planRepository(d, config, { allowFork, adopt: adopt[d.forkName?.toLowerCase()] ?? adopt['*'] ?? {} }));
    },
  };
}
