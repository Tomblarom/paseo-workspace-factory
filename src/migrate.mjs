// One-time migration of legacy factory state (K16a). Dry-run is the default;
// --apply backs up the exact old values first, then rewrites under the
// workspace lock and verifies by re-reading. CLI only, no RPC/panel.
// Covers: `ari.wsf*` workspace metadata keys -> `wsf*`, old per-agent fields
// in `wsf.agents[id]` folded via the existing lazy-fold logic, and
// `ari.wsf.*` agent labels -> `wsf.*` (archived agents tried, else reported).
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_PREFIX, METADATA_KEY, newKeyForLegacyKey } from './paseo.mjs';
import { AGENTS_KEY } from './agent-state.mjs';
import { readSteerAction, actionEntry } from './steer-action.mjs';
import { ACTION_FACTS } from './action-facts.mjs';
import { withWorkspaceLock } from './lock.mjs';
import { runtime } from './runtime.mjs';

/** Old per-agent fields folded lazily today; the migration persists the fold. */
export const LEGACY_AGENT_FIELDS = ['pendingWakeBrief', 'stagedBrief', 'lastSteerDeliveryId', 'pendingAction', ...ACTION_FACTS];

/** Legacy top-level metadata/label keys present in a (possibly normalized) dict. */
function legacyKeysOf(dict) {
  if (!dict || typeof dict !== 'object') return [];
  return Object.keys(dict).filter((key) => newKeyForLegacyKey(key) !== null);
}

/**
 * Classify one legacy key against its new counterpart. `pending` lists the
 * old keys whose new counterpart was never persisted (from readPaseoState
 * normalization; inferred new keys must not read as conflicts).
 * Returns { oldKey, newKey, oldValue, newValue, persistedNew, status } where
 * status is `rename` (new missing), `equal` (both persisted, same value) or
 * `conflict` (both persisted, different values).
 */
export function classifyLegacyKey(dict, oldKey, pending = null) {
  const newKey = newKeyForLegacyKey(oldKey);
  const oldValue = dict?.[oldKey];
  const newValue = dict?.[newKey];
  const isPending = Array.isArray(pending) ? pending.includes(oldKey) : newValue === undefined;
  if (isPending || newValue === undefined) {
    return { oldKey, newKey, oldValue, newValue: undefined, persistedNew: false, status: 'rename' };
  }
  if (isDeepStrictEqual(oldValue, newValue)) {
    return { oldKey, newKey, oldValue, newValue, persistedNew: true, status: 'equal' };
  }
  return { oldKey, newKey, oldValue, newValue, persistedNew: true, status: 'conflict' };
}

/** Legacy top-level fields still present on one `wsf.agents` entry. */
export function foldableFields(entry) {
  if (!entry || typeof entry !== 'object') return [];
  return LEGACY_AGENT_FIELDS.filter((field) => Object.hasOwn(entry, field));
}

/**
 * Fold one entry through the existing lazy-fold logic (single implementation:
 * readSteerAction + actionEntry, no copy). Returns { changed, folded, fields }.
 * Unchanged entries return the input by reference with changed:false.
 */
export function foldAgentEntry(entry, workspaceId) {
  const fields = foldableFields(entry);
  if (!fields.length) return { changed: false, folded: entry, fields: [] };
  const action = readSteerAction(entry, workspaceId);
  const folded = actionEntry(entry, action);
  if (isDeepStrictEqual(folded, entry)) return { changed: false, folded: entry, fields: [] };
  return { changed: true, folded, fields };
}

/** Newer-of-two checkpoint-ish values for conflict reports (null when unknown). */
function newerOf(oldValue, newValue) {
  const at = (value) => value?.capturedAt ?? value?.updatedAt ?? null;
  const oldAt = at(oldValue);
  const newAt = at(newValue);
  const oldMs = typeof oldAt === 'string' ? Date.parse(oldAt) : NaN;
  const newMs = typeof newAt === 'string' ? Date.parse(newAt) : NaN;
  if (Number.isFinite(oldMs) && Number.isFinite(newMs)) {
    if (newMs > oldMs) return 'wsf';
    if (oldMs > newMs) return 'legacy';
    return 'same-time';
  }
  return null;
}

function workspaceTitle(workspace) {
  return workspace?.title ?? workspace?.name ?? workspace?.id ?? null;
}

/**
 * Plan the whole-host migration over a normalized daemon snapshot
 * (readPaseoState). Pure; no writes. Returns { workspaces, agents, summary }.
 * Workspaces list metadata renames/removals/conflicts plus per-agent folds;
 * agents list label rewrites (pending keys) plus conflicts. Both-exist-equal
 * agent labels need nothing (old labels linger, Paseo cannot remove them).
 */
export function planMigration(paseoState) {
  const workspaces = [];
  const agents = [];
  for (const workspace of paseoState?.workspaces ?? []) {
    const metadata = workspace?.metadata ?? {};
    const pending = workspace?.legacyPending ?? null;
    const renames = [];
    const removals = [];
    const conflicts = [];
    for (const oldKey of legacyKeysOf(metadata)) {
      // The agents map itself is renamed as a key; its entries fold below.
      const classified = classifyLegacyKey(metadata, oldKey, pending);
      if (classified.status === 'rename') {
        renames.push({ oldKey, newKey: classified.newKey });
      } else if (classified.status === 'equal') {
        removals.push({ oldKey, newKey: classified.newKey });
      } else {
        const newer = newerOf(classified.oldValue, classified.newValue);
        conflicts.push({
          oldKey, newKey: classified.newKey,
          detail: `both exist with different values; keeping wsf${newer ? ` (newer: ${newer})` : ''}, old key left for manual review`,
          ...(newer ? { newer } : {}),
        });
      }
    }
    const folds = [];
    const entries = metadata?.[AGENTS_KEY] ?? null;
    if (entries && typeof entries === 'object') {
      for (const [agentId, entry] of Object.entries(entries)) {
        const fields = foldableFields(entry);
        if (fields.length) folds.push({ agentId, fields: [...fields].sort() });
      }
    }
    folds.sort((a, b) => a.agentId.localeCompare(b.agentId));
    if (renames.length || removals.length || conflicts.length || folds.length) {
      workspaces.push({
        workspaceId: workspace.id, title: workspaceTitle(workspace),
        renames: renames.sort((a, b) => a.oldKey.localeCompare(b.oldKey)),
        removals: removals.sort((a, b) => a.oldKey.localeCompare(b.oldKey)),
        conflicts: conflicts.sort((a, b) => a.oldKey.localeCompare(b.oldKey)),
        folds,
      });
    }
  }
  workspaces.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
  for (const agent of paseoState?.agents ?? []) {
    const labels = agent?.labels ?? {};
    const pending = agent?.legacyPending ?? null;
    const migrate = [];
    const conflicts = [];
    for (const oldKey of legacyKeysOf(labels)) {
      const classified = classifyLegacyKey(labels, oldKey, pending);
      if (classified.status === 'rename') {
        migrate.push(oldKey);
      } else if (classified.status === 'conflict') {
        conflicts.push({
          oldKey, newKey: classified.newKey,
          detail: `both exist with different values (${JSON.stringify(classified.oldValue)} vs ${JSON.stringify(classified.newValue)}); keeping wsf, old label lingers`,
        });
      }
      // `equal` needs nothing: old labels cannot be removed and count as done.
    }
    if (migrate.length || conflicts.length) {
      const next = {};
      for (const oldKey of migrate.sort()) next[newKeyForLegacyKey(oldKey)] = labels[oldKey];
      agents.push({
        agentId: agent.id, title: agent?.title ?? null, workspaceId: agent?.workspaceId ?? null,
        archived: Boolean(agent?.archivedAt),
        migrate: migrate.sort(), labels: next,
        conflicts: conflicts.sort((a, b) => a.oldKey.localeCompare(b.oldKey)),
      });
    }
  }
  agents.sort((a, b) => a.agentId.localeCompare(b.agentId));
  const summary = {
    workspaces: workspaces.length,
    workspaceRenames: workspaces.reduce((sum, w) => sum + w.renames.length, 0),
    workspaceRemovals: workspaces.reduce((sum, w) => sum + w.removals.length, 0),
    workspaceConflicts: workspaces.reduce((sum, w) => sum + w.conflicts.length, 0),
    folds: workspaces.reduce((sum, w) => sum + w.folds.length, 0),
    agents: agents.length,
    agentMigrations: agents.reduce((sum, a) => sum + a.migrate.length, 0),
    agentConflicts: agents.reduce((sum, a) => sum + a.conflicts.length, 0),
    archivedAgents: agents.filter((a) => a.archived).length,
  };
  summary.total = summary.workspaceRenames + summary.workspaceRemovals + summary.folds + summary.agentMigrations;
  return { workspaces, agents, summary };
}

/** True when the plan carries no actionable change (conflicts alone need no write). */
export function migrationEmpty(plan) {
  return (plan?.summary?.total ?? 0) === 0;
}

/** One section per workspace/agent with its change; `(nothing to migrate)` when clean. */
export function formatMigration(plan) {
  const lines = [];
  for (const workspace of plan?.workspaces ?? []) {
    const head = `workspace ${workspace.workspaceId}${workspace.title ? ` "${workspace.title}"` : ''}`;
    for (const rename of workspace.renames) lines.push(`${head}: rename ${rename.oldKey} -> ${rename.newKey}`);
    for (const removal of workspace.removals) lines.push(`${head}: remove ${removal.oldKey} (same value as ${removal.newKey})`);
    for (const fold of workspace.folds) lines.push(`${head}: fold wsf.agents[${fold.agentId}] fields ${fold.fields.join(', ')}`);
    for (const conflict of workspace.conflicts) lines.push(`${head}: conflict ${conflict.oldKey} vs ${conflict.newKey} — ${conflict.detail}`);
  }
  for (const agent of plan?.agents ?? []) {
    const head = `agent ${agent.agentId}${agent.title ? ` "${agent.title}"` : ''}${agent.archived ? ' (archived)' : ''}`;
    if (agent.migrate.length) {
      const sets = Object.entries(agent.labels).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ');
      lines.push(`${head}: set ${sets} (migrates ${agent.migrate.join(', ')})`);
    }
    for (const conflict of agent.conflicts) lines.push(`${head}: conflict ${conflict.oldKey} vs ${conflict.newKey} — ${conflict.detail}`);
  }
  const summary = plan?.summary ?? {};
  const counts = `${summary.workspaces ?? 0} workspace(s), ${summary.folds ?? 0} fold(s), ${summary.agents ?? 0} agent(s)`;
  const pending = `${summary.workspaceRenames ?? 0} rename(s), ${summary.workspaceRemovals ?? 0} removal(s), ${summary.agentMigrations ?? 0} label(s)`;
  const conflicts = `${summary.workspaceConflicts ?? 0} workspace conflict(s), ${summary.agentConflicts ?? 0} agent conflict(s)`;
  if (!lines.length) return `(nothing to migrate) · ${counts} · ${conflicts}`;
  lines.push(`Migration: ${counts} · ${pending} · ${conflicts}.`);
  return lines.join('\n');
}

/**
 * Backup payload: the exact old metadata/labels the plan will touch, plus the
 * existing new counterparts for conflicts. Full dicts of touched records so a
 * restore has everything; callers write it before the first write.
 */
/** Strip inferred new keys (normalization artifacts) so the backup holds persisted values only. */
function persistedDict(record, field) {
  const dict = structuredClone(record?.[field] ?? {});
  for (const oldKey of record?.legacyPending ?? []) {
    const newKey = newKeyForLegacyKey(oldKey);
    // Pending means the new key was never persisted: the normalized value is inferred.
    if (newKey && dict[newKey] !== undefined && isDeepStrictEqual(dict[newKey], dict[oldKey])) delete dict[newKey];
  }
  return dict;
}

export function migrationBackup(plan, paseoState) {
  const workspaceById = new Map((paseoState?.workspaces ?? []).map((w) => [w.id, w]));
  const agentById = new Map((paseoState?.agents ?? []).map((a) => [a.id, a]));
  return {
    createdAt: new Date().toISOString(),
    prefix: { legacy: LEGACY_PREFIX, current: METADATA_KEY },
    workspaces: (plan?.workspaces ?? []).map((w) => ({
      workspaceId: w.workspaceId,
      metadata: persistedDict(workspaceById.get(w.workspaceId), 'metadata'),
    })),
    agents: (plan?.agents ?? []).map((a) => ({
      agentId: a.agentId, archived: Boolean(agentById.get(a.agentId)?.archivedAt),
      labels: persistedDict(agentById.get(a.agentId), 'labels'),
    })),
  };
}

function backupFilename(now = new Date()) {
  return `migrate-backup-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

/**
 * Apply a planned migration. Writes the JSON backup first (to the runtime
 * state dir), then rewrites each workspace under its lock (renames, removals,
 * folds; conflicts skipped) and each agent's labels via the native CLI
 * (archived agents tried, failures reported). Verifies every write by
 * re-reading. Returns { backupPath, workspaces, agents, summary }.
 */
export async function applyMigration({
  client, paseoCli, plan = null, paseoState = null,
  lock = withWorkspaceLock, stateDir = runtime().stateDir,
  now = () => new Date(), writeFile = writeFileSync, mkdir = mkdirSync,
} = {}) {
  if (!client) throw new Error('applyMigration needs a Paseo client');
  if (!paseoCli) throw new Error('applyMigration needs the native paseo CLI wrapper');
  if (!plan) {
    if (!paseoState) throw new Error('applyMigration needs a plan or a daemon snapshot to plan from');
    plan = planMigration(paseoState);
  }
  const backup = migrationBackup(plan, paseoState);
  mkdir(stateDir, { recursive: true, mode: 0o700 });
  const backupPath = join(stateDir, backupFilename(now()));
  writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
  const workspaceResults = [];
  for (const item of plan.workspaces ?? []) {
    workspaceResults.push(await migrateOneWorkspace({ client, item, lock }));
  }
  const agentResults = [];
  for (const item of plan.agents ?? []) {
    agentResults.push(await migrateOneAgent({ client, paseoCli, item }));
  }
  const failedWorkspaces = workspaceResults.filter((r) => !r.ok).length;
  const failedAgents = agentResults.filter((r) => !r.ok && !r.skipped).length;
  const skippedAgents = agentResults.filter((r) => r.skipped).length;
  return {
    backupPath,
    workspaces: workspaceResults,
    agents: agentResults,
    summary: {
      ...plan.summary,
      workspacesMigrated: workspaceResults.filter((r) => r.ok).length,
      agentsMigrated: agentResults.filter((r) => r.ok).length,
      failed: failedWorkspaces + failedAgents,
      skippedAgents,
    },
    ...(failedWorkspaces + failedAgents ? { failed: true } : {}),
  };
}

async function migrateOneWorkspace({ client, item, lock }) {
  const handle = client.workspaces.ref(item.workspaceId);
  try {
    return await lock(item.workspaceId, async (held) => {
      const before = (await handle.refresh())?.metadata ?? {};
      const patch = {};
      const expected = {};
      // Renames: copy old -> new (new is missing by plan), then remove old.
      for (const rename of item.renames ?? []) {
        if (before[rename.newKey] !== undefined) {
          throw new Error(`Workspace ${item.workspaceId} key ${rename.newKey} appeared since the plan; rerun migrate`);
        }
        if (before[rename.oldKey] === undefined) {
          throw new Error(`Workspace ${item.workspaceId} key ${rename.oldKey} disappeared since the plan; rerun migrate`);
        }
        patch[rename.newKey] = structuredClone(before[rename.oldKey]);
        patch[rename.oldKey] = null;
        expected[rename.newKey] = structuredClone(before[rename.oldKey]);
      }
      // Removals: both persisted with the same value; drop the old key.
      for (const removal of item.removals ?? []) {
        if (before[removal.oldKey] === undefined) continue;
        if (!isDeepStrictEqual(before[removal.oldKey], before[removal.newKey])) {
          throw new Error(`Workspace ${item.workspaceId} key ${removal.oldKey} changed since the plan; rerun migrate`);
        }
        patch[removal.oldKey] = null;
        expected[removal.newKey] = structuredClone(before[removal.newKey]);
      }
      // Folds: apply the lazy fold to the effective agents map (renamed map included).
      const effective = { ...before };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete effective[key];
        else effective[key] = value;
      }
      const entries = { ...(effective[AGENTS_KEY] ?? {}) };
      let foldedCount = 0;
      for (const fold of item.folds ?? []) {
        const current = entries[fold.agentId] ?? effective[AGENTS_KEY]?.[fold.agentId];
        if (!current) throw new Error(`Workspace ${item.workspaceId} entry ${fold.agentId} disappeared since the plan; rerun migrate`);
        const { changed, folded } = foldAgentEntry(current, item.workspaceId);
        if (!changed) continue;
        entries[fold.agentId] = folded;
        foldedCount += 1;
      }
      if ((item.folds ?? []).length) {
        patch[AGENTS_KEY] = entries;
        expected[AGENTS_KEY] = structuredClone(entries);
      }
      if (Object.keys(patch).length) {
        held.verify();
        await handle.setMetadata(patch);
      }
      const after = (await handle.refresh())?.metadata ?? {};
      for (const rename of item.renames ?? []) {
        if (after[rename.oldKey] !== undefined) throw new Error(`Legacy key ${rename.oldKey} still present in workspace ${item.workspaceId}`);
        if (!isDeepStrictEqual(after[rename.newKey], expected[rename.newKey])) {
          throw new Error(`Migrated key ${rename.newKey} not verifiable in workspace ${item.workspaceId}`);
        }
      }
      for (const removal of item.removals ?? []) {
        if (after[removal.oldKey] !== undefined) throw new Error(`Legacy key ${removal.oldKey} still present in workspace ${item.workspaceId}`);
      }
      if ((item.folds ?? []).length && !isDeepStrictEqual(after[AGENTS_KEY], expected[AGENTS_KEY])) {
        throw new Error(`Folded wsf.agents not verifiable in workspace ${item.workspaceId}`);
      }
      return {
        ok: true, workspaceId: item.workspaceId,
        renames: (item.renames ?? []).length, removals: (item.removals ?? []).length,
        folds: foldedCount, conflicts: (item.conflicts ?? []).length,
      };
    });
  } catch (error) {
    return { ok: false, workspaceId: item.workspaceId, error: error instanceof Error ? error.message : String(error) };
  }
}

async function migrateOneAgent({ client, paseoCli, item }) {
  const handle = client.agents.ref(item.agentId);
  const before = (await handle.refresh())?.agent ?? null;
  if (!before) return { ok: false, agentId: item.agentId, archived: false, error: `Agent ${item.agentId} is missing` };
  const archived = Boolean(before.archivedAt);
  const labels = {};
  for (const [newKey, value] of Object.entries(item.labels ?? {})) {
    if (before.labels?.[newKey] === undefined && value !== undefined) labels[newKey] = value;
  }
  if (!Object.keys(labels).length) {
    return { ok: true, agentId: before.id, archived, migrated: [], conflicts: (item.conflicts ?? []).length, note: 'nothing to set (already migrated)' };
  }
  try {
    paseoCli(['agent', 'update', before.id, '--label', Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',')]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Archived agents: the native API may refuse; report instead of failing the run.
    if (archived) return { ok: false, skipped: true, agentId: before.id, archived: true, error: `archived agent not migrated (${detail})`, wanted: labels };
    return { ok: false, agentId: before.id, archived, error: detail, wanted: labels };
  }
  const after = (await handle.refresh())?.agent ?? null;
  for (const [newKey, value] of Object.entries(labels)) {
    if (after?.labels?.[newKey] !== value) {
      const detail = `Agent ${before.id} label ${newKey} is ${after?.labels?.[newKey]}, expected ${value}`;
      if (archived) return { ok: false, skipped: true, agentId: before.id, archived: true, error: detail, wanted: labels };
      return { ok: false, agentId: before.id, archived, error: detail, wanted: labels };
    }
  }
  return { ok: true, agentId: before.id, archived, migrated: Object.keys(labels), conflicts: (item.conflicts ?? []).length, oldLabelsRemain: true };
}

/** Human-readable apply result (backup path printed separately by the CLI). */
export function formatMigrationResult(result) {
  const lines = [];
  for (const workspace of result?.workspaces ?? []) {
    lines.push(workspace.ok
      ? `${workspace.workspaceId}: ${workspace.renames} rename(s), ${workspace.removals} removal(s), ${workspace.folds} fold(s)${workspace.conflicts ? `, ${workspace.conflicts} conflict(s) skipped` : ''}`
      : `${workspace.workspaceId}: FAILED: ${workspace.error}`);
  }
  for (const agent of result?.agents ?? []) {
    if (agent.ok) lines.push(`${agent.agentId}: labels set${agent.archived ? ' (archived)' : ''}`);
    else if (agent.skipped) lines.push(`${agent.agentId}: SKIPPED: ${agent.error}`);
    else lines.push(`${agent.agentId}: FAILED: ${agent.error}`);
  }
  const summary = result?.summary ?? {};
  lines.push(`Migrate: ${summary.workspacesMigrated ?? 0} workspace(s), ${summary.agentsMigrated ?? 0} agent(s)${summary.failed ? `, ${summary.failed} failed` : ''}${summary.skippedAgents ? `, ${summary.skippedAgents} skipped` : ''}.`);
  return lines.join('\n');
}
