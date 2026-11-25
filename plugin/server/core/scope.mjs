// Scope resolution (S2 read side, S3 write side). A scope is one main workspace
// with factory metadata: metadata[METADATA_KEY].scope = { id, kind, locator, parent? }.
// The planner writes the field; a missing field is derived from the workspace
// kind and its steer labels. Unknown addresses return null so the caller falls
// back to legacy discovery; ambiguous ones throw ScopeConflict.
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { LABEL, METADATA_KEY } from './paseo.mjs';
import { isWorktreeWorkspace } from './discovery.mjs';

export const SCOPE_KINDS = ['github', 'dir', 'workspace', 'hub'];

/** True for a usable stored scope field ({ id, kind }); the locator may be filled in later. */
export function validScope(value) {
  return Boolean(value && typeof value === 'object'
    && typeof value.id === 'string' && value.id.trim()
    && SCOPE_KINDS.includes(value.kind));
}

/** Case-insensitive scope id comparison (stored/live spelling stays canonical for display). */
export function sameScopeId(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** Domain pointer of a stored scope field: the domain scope id, or null when unset. Logical only, never a parent. */
export function domainOfScope(value) {
  return value && typeof value.domain === 'string' && value.domain.trim() ? value.domain : null;
}

/** Ambiguous address (or duplicate scope id); candidates carry id, kind, workspace id and path. */
export class ScopeConflict extends Error {
  constructor(message, candidates = [], code = 'ambiguous') {
    super(message);
    this.name = 'ScopeConflict';
    this.candidates = candidates;
    this.code = code;
  }
}

function real(path, realpath = realpathSync) {
  if (!path) return null;
  try {
    return realpath(path);
  } catch {
    return resolve(path);
  }
}

function expandHome(path) {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function folderOf(directory) {
  if (typeof directory !== 'string' || !directory) return null;
  const base = basename(directory);
  return base && base !== '.' && base !== '..' ? base : null;
}

function candidateOf(scope) {
  return { id: scope.id, kind: scope.kind, workspaceId: scope.workspaceId, path: scope.directory };
}

function describe(candidates) {
  return candidates.map((c) => `${JSON.stringify(c.id)} (${c.kind}, ${c.workspaceId}, ${c.path})`).join('; ');
}

function baseOf(workspace) {
  return {
    workspaceId: workspace.id,
    directory: workspace.workspaceDirectory ?? null,
    title: workspace.title ?? workspace.name ?? null,
    workspace,
  };
}

function isGithubRepo(value) {
  return typeof value === 'string' && !/^local\//i.test(value) && value.includes('/');
}

/**
 * One scope per workspace carrying factory metadata. A stored scope field wins;
 * otherwise the kind is derived (worktree -> workspace, steer label owner/repo
 * -> github, else dir) with the folder name as the transitional id.
 */
export function listScopes(paseoState) {
  const scopes = [];
  for (const w of paseoState?.workspaces ?? []) {
    const meta = w.metadata?.[METADATA_KEY];
    if (!meta || typeof meta !== 'object') continue;
    const stored = meta.scope;
    if (validScope(stored)) {
      scopes.push({
        id: stored.id,
        kind: stored.kind,
        locator: typeof stored.locator === 'string' && stored.locator ? stored.locator : null,
        ...(stored.parent !== undefined ? { parent: stored.parent } : {}),
        ...(domainOfScope(stored) ? { domain: domainOfScope(stored) } : {}),
        ...baseOf(w),
      });
      continue;
    }
    const labels = new Set();
    for (const a of paseoState?.agents ?? []) {
      if (a.workspaceId !== w.id) continue;
      if (a.labels?.[LABEL.role] !== 'steer') continue;
      const repo = a.labels?.[LABEL.repo];
      if (typeof repo === 'string' && repo) labels.add(repo);
    }
    const folder = folderOf(w.workspaceDirectory) ?? w.id;
    if (isWorktreeWorkspace(w)) {
      scopes.push({ id: folder, kind: 'workspace', locator: w.id, ...baseOf(w) });
      continue;
    }
    const distinct = [...labels].sort();
    if (distinct.length === 1 && isGithubRepo(distinct[0])) {
      scopes.push({ id: distinct[0], kind: 'github', locator: distinct[0], ...baseOf(w) });
    } else {
      scopes.push({ id: folder, kind: 'dir', locator: w.workspaceDirectory ?? w.id, ...baseOf(w) });
    }
  }
  return scopes;
}

function workspaceIdFromAddress(raw) {
  const prefixed = raw.match(/^(?:workspace|worktree)\s*:\s*(.+)$/i);
  if (prefixed) return prefixed[1].trim() || null;
  if (/^wks_[A-Za-z0-9]+$/.test(raw)) return raw;
  return null;
}

/** Only absolute-looking input counts as a path; bare "a/b" stays a repo id for legacy discovery. */
function looksLikePath(raw) {
  return raw.startsWith('/') || raw.startsWith('~') || raw === '.' || raw.startsWith('./') || raw.startsWith('../');
}

/** Inner address string of a repository entry object ({ local }/{ workspace }/{ repo }) or the string itself. */
export function keyOfAddress(address) {
  if (typeof address === 'string') return address;
  if (address && typeof address === 'object') {
    if (typeof address.local === 'string') return address.local;
    if (typeof address.workspace === 'string') return `workspace:${address.workspace}`;
    if (typeof address.workspaceId === 'string') return `workspace:${address.workspaceId}`;
    if (typeof address.repo === 'string') return address.repo;
  }
  return null;
}

/**
 * Resolves an address to a live scope: scope id (case-insensitive; the stored
 * id is the canonical form) -> workspace id (wks_.../workspace:<id>) -> path
 * -> legacy alias local/<folder> (flagged with deprecatedAlias). Returns null
 * when no live scope matches; throws ScopeConflict when the address (or a
 * duplicated id) is ambiguous.
 */
export function resolveScope(address, paseoState) {
  const scopes = listScopes(paseoState);
  const raw = (keyOfAddress(address) ?? '').trim();
  if (!raw) return null;

  const byId = scopes.filter((s) => s.id.toLowerCase() === raw.toLowerCase());
  if (byId.length === 1) return { ...byId[0] };
  if (byId.length > 1) {
    const candidates = byId.map(candidateOf);
    throw new ScopeConflict(
      `Scope id ${JSON.stringify(raw)} names several live scopes: ${describe(candidates)}; disambiguate with the workspace id (workspace:<id>) or path`,
      candidates, 'duplicate-id',
    );
  }

  const wid = workspaceIdFromAddress(raw);
  if (wid) {
    const hit = scopes.filter((s) => s.workspaceId === wid);
    if (hit.length === 1) return { ...hit[0] };
    if (hit.length > 1) {
      const candidates = hit.map(candidateOf);
      throw new ScopeConflict(`Workspace ${wid} carries several scopes: ${describe(candidates)}`, candidates, 'duplicate-id');
    }
    return null;
  }

  if (looksLikePath(raw)) {
    const want = real(expandHome(raw));
    const hit = scopes.filter((s) => s.directory && real(s.directory) === want);
    if (hit.length === 1) return { ...hit[0] };
    if (hit.length > 1) {
      const candidates = hit.map(candidateOf);
      throw new ScopeConflict(`Path ${raw} matches several scopes: ${describe(candidates)}; use the scope id or workspace id`, candidates);
    }
    return null;
  }

  const alias = raw.match(/^local\/(.+)$/i);
  if (alias) {
    const folder = alias[1].trim();
    // The alias is the legacy address of dir/workspace scopes; github scopes
    // keep owner/repo and stay on the legacy path when addressed this way.
    const hit = scopes.filter((s) => s.kind !== 'github' && s.directory && basename(s.directory) === folder);
    if (hit.length === 1) return { ...hit[0], deprecatedAlias: true };
    if (hit.length > 1) {
      const candidates = hit.map(candidateOf);
      throw new ScopeConflict(`Alias ${JSON.stringify(raw)} matches several scopes: ${describe(candidates)}; use the scope id, workspace id or full path`, candidates);
    }
    return null;
  }

  return null;
}

/**
 * Maps a resolved scope back to a discovery entry (github keeps owner/repo
 * verbatim). Live fields win over the stored locator: a stale locator (kept
 * for stable identity) must not misroute discovery to a missing workspace.
 */
export function scopeToEntry(scope) {
  if (scope.kind === 'github') return scope.locator;
  if (scope.kind === 'dir') return { local: scope.directory ?? scope.locator };
  if (scope.kind === 'workspace') return { workspace: scope.workspaceId ?? scope.locator };
  const locator = scope.directory ?? scope.locator ?? scope.workspaceId;
  return /^wks_[A-Za-z0-9]+$/.test(String(locator ?? '')) ? { workspace: locator } : { local: locator };
}

/**
 * Default scope address for bare `worker pick` / `worker list` / `worker start`:
 * the calling agent's scope label first, else the calling workspace, else the
 * workspace of the current directory. Only live scopes count (ambiguous or
 * unknown addresses fall through); null means the catalog-only pick without
 * repo visibility. Pure over the state, env/cwd injectable for tests.
 */
export function defaultPickAddress(paseoState, { agentId = process.env.PASEO_AGENT_ID, workspaceId = process.env.PASEO_WORKSPACE_ID, cwd = process.cwd() } = {}) {
  const liveScope = (address) => {
    try {
      return resolveScope(address, paseoState);
    } catch {
      return null;
    }
  };
  if (agentId) {
    const scopeId = paseoState?.agents?.find((a) => a.id === agentId)?.labels?.[LABEL.scope];
    if (typeof scopeId === 'string' && scopeId && liveScope(scopeId)) return scopeId;
  }
  if (workspaceId && liveScope(`workspace:${workspaceId}`)) return `workspace:${workspaceId}`;
  const cwdScope = cwd ? liveScope(cwd) : null;
  if (cwdScope) return cwdScope.id;
  return null;
}
