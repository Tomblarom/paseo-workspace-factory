// @ts-nocheck
// GENERATED from src/labels.mjs by npm run plugin:sync. Do not edit.
// Agent label audit: which factory agents (steers, workers) carry
// missing or wrong labels, and what to set. Pure over a normalized Paseo
// state snapshot ({ workspaces, agents }); the CLI prints the rows (dry-run)
// or writes them through the `labels.set` apply op. Paseo cannot remove
// labels, only add/overwrite — fixes only set `wsf.*` keys, which win on
// read. Archived agents and agents of unrelated scopes are never touched;
// agents whose role or slot cannot be derived are reported without a fix.
import { LABEL, parentOf, newKeyForLegacyKey, pendingLegacyKeys } from './paseo.js';
import { listScopes, resolveScope, sameScopeId } from './scope.js';
import { STEER_TITLE } from './discovery.js';
import { continuedFromId, resolveContinuations } from './zerosub.js';

const LETTER = /^[A-Za-z]$/;

/** Slot letter from a "Steer X" title (case-insensitive), else null. */
function slotOfTitle(title) {
  const match = (title ?? '').trim().match(STEER_TITLE);
  return match ? match[1].toUpperCase() : null;
}

/** Uppercase slot/owner letter from a label value, else null. */
function asLetter(value) {
  return typeof value === 'string' && LETTER.test(value) ? value.toUpperCase() : null;
}

function noteRow(agent, scopeId, kind, note) {
  return {
    agentId: agent.id, title: agent.title ?? null, workspaceId: agent.workspaceId ?? null,
    scope: scopeId, kind, slot: null, owner: null, labels: {}, was: {}, migrate: [], note,
  };
}

/**
 * One agent → { attributed, row }: attributed tells whether the agent shows
 * any factory signal (role label, scope/repo label of a live scope, or a
 * steer parent of a live scope). Unattributed agents return no row (random
 * agents are never claimed); clean agents return no row either.
 */
function classifyAgent(agent, { scopes, byId, byWorkspace, liveScopeOf, superseded }) {
  const labels = agent.labels ?? {};
  const role = labels[LABEL.role] ?? null;
  // ZeroSub continuation tabs are the live agent of their origin's slot or
  // worker (see zerosub.mjs); neither they nor the superseded origin are
  // ever flagged, so the audit proposes no duplicate slot or worker labels.
  const continuedOrigin = continuedFromId(agent);
  if (continuedOrigin && byId.has(continuedOrigin)) return { attributed: true, row: null };
  if (superseded?.has(agent.id)) return { attributed: true, row: null };
  const wsScope = byWorkspace.get(agent.workspaceId) ?? null;
  const labelScope = liveScopeOf(labels[LABEL.scope]) ?? liveScopeOf(labels[LABEL.repo]) ?? null;
  const parent = byId.get(parentOf(agent)) ?? null;
  const parentIsSteer = parent?.labels?.[LABEL.role] === 'steer';
  const parentScope = parentIsSteer
    ? (liveScopeOf(parent.labels[LABEL.scope]) ?? liveScopeOf(parent.labels[LABEL.repo]) ?? null)
    : null;
  const parentSlot = parentIsSteer ? asLetter(parent.labels[LABEL.slot]) : null;
  // Normalized snapshots carry the persisted-vs-inferred split; raw label
  // dicts (tests, callers without readPaseoState) recompute the pending keys.
  const pending = agent.legacyPending ?? pendingLegacyKeys(labels);
  const inferred = new Set(pending.map((old) => newKeyForLegacyKey(old)));

  if (role !== 'steer' && role !== 'worker' && !labelScope && !parentScope) {
    return { attributed: false, row: null };
  }
  const attributed = true;

  let kind = role === 'steer' || role === 'worker' ? role : null;
  const titleSlot = slotOfTitle(agent.title);
  if (!kind) {
    if (titleSlot && (wsScope || labelScope)) kind = 'steer';
    else if (parentScope) kind = 'worker';
    else {
      return { attributed, row: noteRow(agent, labelScope?.id ?? null, null, 'carries factory labels but neither wsf.role nor a Steer title/steer parent; adopt it explicitly (plan --adopt/--adopt-worker) or fix manually') };
    }
  }

  // Attribution: explicit scope labels win; a steer living in another
  // scope's workspace (or a worker labelled for one scope under another
  // scope's steer) is reported, never silently rewritten.
  let target = null;
  let conflict = null;
  if (kind === 'steer') {
    if (labelScope && wsScope && !sameScopeId(labelScope.id, wsScope.id)) {
      conflict = `labels point to scope ${labelScope.id} but the agent lives in the ${wsScope.id} workspace; move or relabel it manually`;
      target = labelScope;
    } else {
      target = labelScope ?? wsScope;
    }
    if (!target) {
      return { attributed, row: noteRow(agent, null, 'steer', 'steer is not attributable to a live scope (no matching workspace or scope label)') };
    }
  } else {
    if (labelScope && parentScope && !sameScopeId(labelScope.id, parentScope.id)) {
      conflict = `labels point to scope ${labelScope.id} but the parent steer belongs to ${parentScope.id}; relabel it manually`;
      target = labelScope;
    } else {
      target = labelScope ?? parentScope ?? (role === 'worker' ? wsScope : null);
    }
    if (!target) {
      return { attributed, row: noteRow(agent, null, 'worker', 'worker is not attributable to a live scope (no matching scope label or steer parent)') };
    }
  }

  // Expected values; whatever cannot be derived stays out of the fix and is
  // named in the note instead (partial fixes still help).
  const desired = {};
  let note = conflict;
  let slot = null;
  let owner = null;
  if (kind === 'steer') {
    slot = asLetter(labels[LABEL.slot]) ?? titleSlot;
    desired[LABEL.repo] = target.id;
    desired[LABEL.scope] = target.id;
    desired[LABEL.role] = 'steer';
    if (slot) desired[LABEL.slot] = slot;
    else note = [conflict, 'slot unknown (no wsf.slot and the title is not "Steer X"); set wsf.slot manually'].filter(Boolean).join('; ');
  } else {
    // Workers never carry wsf.repo (adopt-worker sets scope/role/owner only).
    owner = asLetter(labels[LABEL.owner])
      ?? (parentScope && sameScopeId(parentScope.id, target.id) ? parentSlot : null);
    desired[LABEL.scope] = target.id;
    desired[LABEL.role] = 'worker';
    if (owner) desired[LABEL.owner] = owner;
    else note = [conflict, 'owner unknown (no wsf.owner and no parent steer of this scope); set wsf.owner manually'].filter(Boolean).join('; ');
  }
  if (conflict) {
    // Conflicting attribution: migrate legacy keys (value-preserving) but
    // do not rewrite scope identity.
    const row = noteRow(agent, target.id, kind, conflict);
    for (const old of pending) {
      const next = newKeyForLegacyKey(old);
      row.labels[next] = labels[old];
      row.was[next] = null;
      row.migrate.push(old);
    }
    return { attributed, row };
  }

  const fixes = {};
  const was = {};
  for (const [key, value] of Object.entries(desired)) {
    if (labels[key] === value && !inferred.has(key)) continue;
    fixes[key] = value;
    was[key] = inferred.has(key) || labels[key] === undefined ? null : labels[key];
  }
  const migrate = [];
  for (const old of pending) {
    const next = newKeyForLegacyKey(old);
    if (!(next in fixes)) {
      fixes[next] = labels[old];
      was[next] = null;
    }
    migrate.push(old);
  }
  const row = {
    agentId: agent.id, title: agent.title ?? null, workspaceId: agent.workspaceId ?? null,
    scope: target.id, kind, slot, owner, labels: fixes, was, migrate, note,
  };
  if (!Object.keys(fixes).length && !note) return { attributed, row: null };
  return { attributed, row };
}

const KIND_ORDER = { steer: 0, worker: 1 };

function compareRows(a, b) {
  return (a.scope ?? '').localeCompare(b.scope ?? '')
    || (KIND_ORDER[a.kind] ?? 2) - (KIND_ORDER[b.kind] ?? 2)
    || (a.slot ?? a.owner ?? '').localeCompare(b.slot ?? b.owner ?? '')
    || a.agentId.localeCompare(b.agentId);
}

/**
 * Label fixes for every scope (or one scope/agent address). The address is a
 * scope id first (workspace id, path and legacy alias included; ambiguous
 * addresses throw ScopeConflict like everywhere else), else an agent id.
 * Unknown addresses and unattributed agents throw; clean agents simply
 * produce no row.
 */
export function planLabelFixes(paseoState, { address, switches = [] } = {}) {
  const scopes = listScopes(paseoState ?? {});
  const agents = paseoState?.agents ?? [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  const byWorkspace = new Map(scopes.map((s) => [s.workspaceId, s]));
  const liveScopeOf = (value) => {
    if (typeof value !== 'string' || !value) return null;
    return scopes.find((s) => sameScopeId(s.id, value)) ?? null;
  };
  const superseded = new Set(resolveContinuations(agents, switches).superseded);
  const ctx = { scopes, byId, byWorkspace, liveScopeOf, superseded };

  let onlyScope = null;
  let onlyAgent = null;
  const trimmed = typeof address === 'string' ? address.trim() : address;
  if (trimmed !== undefined && trimmed !== null && trimmed !== '') {
    const scope = resolveScope(trimmed, paseoState);
    if (scope) {
      onlyScope = scope;
    } else if (typeof trimmed === 'string' && byId.has(trimmed)) {
      onlyAgent = byId.get(trimmed);
      if (onlyAgent.archivedAt) throw new Error(`Agent ${trimmed} is archived; label fixes never touch archived agents`);
    } else {
      throw new Error(`Unknown scope or agent ${JSON.stringify(address)} (no live scope, workspace, path or agent id matches)`);
    }
  }

  const rows = [];
  let agentSeen = false;
  for (const agent of agents) {
    if (agent.archivedAt) continue;
    if (onlyAgent && agent.id !== onlyAgent.id) continue;
    const { attributed, row } = classifyAgent(agent, ctx);
    if (onlyAgent && attributed) agentSeen = true;
    if (!row) continue;
    if (onlyScope && !sameScopeId(row.scope, onlyScope.id)) continue;
    rows.push(row);
  }
  if (onlyAgent && !agentSeen) {
    throw new Error(`Agent ${onlyAgent.id} carries no factory labels and is not attributable to a live scope; nothing to fix`);
  }
  return rows.sort(compareRows);
}

function formatWas(value) {
  return value === null ? 'missing' : JSON.stringify(value);
}

/** One line per agent with its fix (or note); `(no label fixes needed)` when clean. */
export function formatLabelFixes(rows) {
  if (!rows.length) return '(no label fixes needed)';
  return rows.map((row) => {
    const where = row.scope ? `${row.scope} ` : '';
    const what = row.kind ? `${row.kind}${row.kind === 'steer' && row.slot ? ` ${row.slot}` : ''}${row.kind === 'worker' && row.owner ? ` (owner ${row.owner})` : ''}` : 'agent';
    const head = `${row.agentId} "${row.title ?? row.agentId}" · ${where}${what}`;
    const sets = Object.entries(row.labels).map(([key, value]) => `${key}: ${formatWas(row.was[key] ?? null)} → ${JSON.stringify(value)}`);
    if (!sets.length) return `${head}: ${row.note ?? 'nothing to fix'}`;
    const migrate = row.migrate.length ? `; migrates ${row.migrate.join(', ')}` : '';
    const note = row.note ? `; note: ${row.note}` : '';
    return `${head}: set ${sets.join(', ')}${migrate}${note}`;
  }).join('\n');
}
