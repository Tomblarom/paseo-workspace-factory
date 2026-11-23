// @ts-nocheck
// GENERATED from src/discovery.mjs by npm run plugin:sync. Do not edit.
// Read-only discovery for one repository: GitHub identity, local checkout and
// the Paseo project, main workspace, steers and workers that belong to it.
import { basename, join, resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { resolveGitHub, remoteToFullName } from './github.js';
import { classifyCheckouts, inspectCloneTarget } from './local.js';
import { LABEL, METADATA_KEY, parentOf } from './paseo.js';
import { validScope } from './scope.js';

const STEER_TITLE = /^Steer ([A-Z])$/;
const MAIN_TITLE = /(^|· )Main$/;

function real(path, realpath = realpathSync) {
  if (!path) return null;
  try {
    return realpath(path);
  } catch {
    return resolve(path);
  }
}

export function isWorktreeWorkspace(workspace) {
  return workspace?.workspaceKind === 'worktree' || workspace?.project?.checkout?.isPaseoOwnedWorktree === true;
}

function localNameFromRepo(repo) {
  const trimmed = repo.trim();
  if (!/^local\//i.test(trimmed)) return null;
  const name = trimmed.slice('local/'.length).trim();
  if (!name || name.includes('/') || name === '.' || name === '..') {
    throw new Error(`Not a local repository name: ${JSON.stringify(repo)} (expected "local/<folder>")`);
  }
  return name;
}

/**
 * Workspace id from a repository string: "workspace:<id>", "worktree:<id>"
 * (alias) or a bare "wks_..." id. Returns the id or null when it is not a
 * workspace reference. Anything else falls through to local/GitHub parsing.
 */
function workspaceIdFromRepo(repo) {
  const trimmed = typeof repo === 'string' ? repo.trim() : '';
  if (!trimmed) return null;
  const prefixed = trimmed.match(/^(?:workspace|worktree)\s*:\s*(.+)$/i);
  if (prefixed) {
    const id = prefixed[1].trim();
    if (!id) throw new Error(`Not a workspace reference: ${JSON.stringify(repo)} (expected "workspace:<id>")`);
    return id;
  }
  if (/^wks_[A-Za-z0-9]+$/.test(trimmed)) return trimmed;
  return null;
}

/** True for an existing directory (follows symlinks); injectable for tests. */
export function defaultExistsDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Validates a per-entry scope name (`--name` / repos-file `"name"`). Scope ids
 * stay addressable: no "/" (github form), no ":" (`--adopt scope:X=...`), no
 * control characters. Returns the trimmed name or null when absent.
 */
function normalizeScopeName(raw, entry) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new Error(`Scope name must be a string: ${JSON.stringify(entry)}`);
  const name = raw.trim();
  if (!name) throw new Error(`Scope name must not be empty: ${JSON.stringify(entry)}`);
  if (name.length > 100) throw new Error(`Scope name is too long (max 100 characters): ${JSON.stringify(entry)}`);
  if (name === '.' || name === '..') throw new Error(`Scope name must not be "." or "..": ${JSON.stringify(entry)}`);
  if (name.includes('/') || name.includes(':') || /[\0-\x1f\x7f]/.test(name)) {
    throw new Error(`Scope name must not contain "/", ":" or control characters: ${JSON.stringify(entry)}`);
  }
  return name;
}

/**
 * Validates a per-entry title subject (`--subject` / repos-file `"subject"`).
 * Titles are free text (spaces, slashes and dots allowed); only control
 * characters are rejected. Returns the trimmed subject or null when absent.
 */
function normalizeSubject(raw, entry) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new Error(`Subject must be a string: ${JSON.stringify(entry)}`);
  const subject = raw.trim();
  if (!subject) throw new Error(`Subject must not be empty: ${JSON.stringify(entry)}`);
  if (subject.length > 140) throw new Error(`Subject is too long (max 140 characters): ${JSON.stringify(entry)}`);
  if (/[\0-\x1f\x7f]/.test(subject)) throw new Error(`Subject must not contain control characters: ${JSON.stringify(entry)}`);
  return subject;
}

/** Normalizes a repository list entry: "owner/repo", a URL, { repo, parentDir?, checkout?, name?, subject?, hub? }, { local: <path>, name?, subject?, hub? } or "local/<folder>", { workspace: <id>, hub? } or "workspace:<id>" (bare "wks_..." ids too). A hub entry plans a hub-kind scope (S5b). */
export function normalizeEntry(entry, config) {
  if (typeof entry === 'object' && entry !== null && typeof entry.local === 'string') {
    const raw = entry.local.trim();
    if (!raw) throw new Error(`Repository entry needs a non-empty "local" path: ${JSON.stringify(entry)}`);
    const local = resolve(raw);
    const base = basename(local);
    if (!base || base === '.' || base === '..') throw new Error(`Local path has no folder name: ${JSON.stringify(entry)}`);
    const name = normalizeScopeName(entry.name, entry);
    const subject = normalizeSubject(entry.subject, entry);
    if (entry.hub !== undefined && typeof entry.hub !== 'boolean') throw new Error(`Entry "hub" must be a boolean: ${JSON.stringify(entry)}`);
    return { repo: `local/${base}`, local, parentDir: resolve(entry.parentDir ?? config.checkoutRoot), checkout: entry.checkout ? resolve(entry.checkout) : null, ...(name !== null ? { name } : {}), ...(subject !== null ? { subject } : {}), ...(entry.hub === true ? { hub: true } : {}) };
  }
  if (typeof entry === 'object' && entry !== null && (typeof entry.workspace === 'string' || typeof entry.workspaceId === 'string')) {
    const raw = (entry.workspace ?? entry.workspaceId).trim();
    if (!raw) throw new Error(`Repository entry needs a non-empty "workspace" id: ${JSON.stringify(entry)}`);
    const name = normalizeScopeName(entry.name, entry);
    const subject = normalizeSubject(entry.subject, entry);
    if (entry.hub !== undefined && typeof entry.hub !== 'boolean') throw new Error(`Entry "hub" must be a boolean: ${JSON.stringify(entry)}`);
    return { repo: `workspace:${raw}`, workspaceId: raw, parentDir: resolve(entry.parentDir ?? config.checkoutRoot), checkout: entry.checkout ? resolve(entry.checkout) : null, ...(name !== null ? { name } : {}), ...(subject !== null ? { subject } : {}), ...(entry.hub === true ? { hub: true } : {}) };
  }
  const value = typeof entry === 'string' ? { repo: entry } : { ...entry };
  if (typeof value.repo !== 'string') throw new Error(`Repository entry needs "repo", "local" or "workspace": ${JSON.stringify(entry)}`);
  const name = normalizeScopeName(value.name, entry);
  const subject = normalizeSubject(value.subject, entry);
  if (value.hub !== undefined && typeof value.hub !== 'boolean') throw new Error(`Entry "hub" must be a boolean: ${JSON.stringify(entry)}`);
  const withName = { ...(name !== null ? { name } : {}), ...(subject !== null ? { subject } : {}), ...(value.hub === true ? { hub: true } : {}) };
  const workspaceId = workspaceIdFromRepo(value.repo);
  if (workspaceId) {
    return { repo: `workspace:${workspaceId}`, workspaceId, parentDir: resolve(value.parentDir ?? config.checkoutRoot), checkout: value.checkout ? resolve(value.checkout) : null, ...withName };
  }
  const localName = localNameFromRepo(value.repo);
  if (localName) {
    return { repo: `local/${localName}`, localName, parentDir: resolve(value.parentDir ?? config.checkoutRoot), checkout: value.checkout ? resolve(value.checkout) : null, ...withName };
  }
  return { repo: value.repo, parentDir: resolve(value.parentDir ?? config.checkoutRoot), checkout: value.checkout ? resolve(value.checkout) : null, ...withName };
}

function worktreesAt(paseo, wantedReal, realpath) {
  return paseo.workspaces.filter((w) => isWorktreeWorkspace(w) && real(w.workspaceDirectory, realpath) === wantedReal);
}

/** Live agents explicitly labelled as workers of a scope (any workspace, S7). */
function labelledWorkers(paseo, scopeId) {
  if (!scopeId) return [];
  const want = scopeId.toLowerCase();
  return paseo.agents.filter((a) => !a.archivedAt && a.labels?.[LABEL.role] === 'worker'
    && typeof a.labels?.[LABEL.scope] === 'string' && a.labels[LABEL.scope].toLowerCase() === want);
}

/** Parent-linked workers plus labelled scope workers (deduped by id). */
function allWorkers(paseo, steerIds, scopeId) {
  const parentLinked = paseo.agents.filter((a) => !a.archivedAt && steerIds.has(parentOf(a)));
  const seen = new Set(parentLinked.map((w) => w.id));
  return [...parentLinked, ...labelledWorkers(paseo, scopeId).filter((w) => !seen.has(w.id))];
}

/** Current branch of a worktree directory; null when unreadable or detached (HEAD). Never throws. */
function worktreeBranch(git, dirReal) {
  if (typeof git !== 'function' || !dirReal) return null;
  try {
    const branch = git(dirReal, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const name = typeof branch === 'string' ? branch.trim() : '';
    return name && name !== 'HEAD' ? name : null;
  } catch {
    return null;
  }
}

/**
 * Parent scope of a worktree from its owning project checkout: a github scope
 * when the origin parses to owner/repo (the live scope id wins on case, so the
 * link stays resolvable), else a dir scope for the project folder, else none.
 * Local git data only, no network. Never throws.
 */
function worktreeParent({ projectRootPath, dirReal, checkouts, realpath, liveScopes }) {
  try {
    if (!projectRootPath) return null;
    const rootReal = real(projectRootPath, realpath);
    if (!rootReal || rootReal === dirReal) return null;
    const atRoot = checkouts.find((c) => real(c.path, realpath) === rootReal) ?? null;
    const parsed = atRoot?.remotes?.origin ? remoteToFullName(atRoot.remotes.origin) : null;
    if (parsed) {
      const live = (liveScopes ?? []).find((s) => s.kind === 'github' && s.id.toLowerCase() === parsed);
      return { id: live?.id ?? parsed, kind: 'github' };
    }
    const folder = basename(projectRootPath);
    if (folder && folder !== '.' && folder !== '..') return { id: folder, kind: 'dir' };
    return null;
  } catch {
    return null;
  }
}

/**
 * Discovery for an existing Paseo worktree workspace adopted as the factory
 * main workspace. No new project is registered and no duplicate workspace is
 * created: the matched worktree becomes the main workspace (via metadata) and
 * the scope id names it (`--name`, else `<parent>@<branch>`, else the folder).
 * A stored scope field wins over a recomputed one (stable identity); steers
 * labelled with the legacy `local/<folder>` name still match. Unlike normal
 * discovery the title does not matter; ambiguity is reported, never resolved
 * silently.
 */
function buildWorktreeDiscovery(matched, { normalized, parentDir, checkouts, paseo, realpath, checkoutIssues, git, liveScopes }) {
  const first = matched[0] ?? null;
  const dirReal = first ? real(first.workspaceDirectory, realpath) : null;
  const base = first ? basename(first.workspaceDirectory ?? '') : null;
  const folder = base && base !== '.' && base !== '..' && !base.includes('/') ? base : null;
  const requestedName = normalized.name ?? null;
  const requestedSubject = normalized.subject ?? null;
  const mainWorkspace = matched.length === 1 ? matched[0] : null;
  const stored = mainWorkspace && validScope(mainWorkspace.metadata?.[METADATA_KEY]?.scope)
    ? mainWorkspace.metadata[METADATA_KEY].scope
    : null;
  // A hub entry converts the scope kind to hub (fresh: --name else 'hub';
  // existing: the stored id is kept unless --name renames); hubs stay parentless.
  const wantHub = normalized.hub === true;
  let scope = null;
  if (wantHub && first) {
    scope = { id: requestedName ?? stored?.id ?? 'hub', kind: 'hub', locator: first.id };
  } else if (stored) {
    scope = { id: stored.id, kind: stored.kind, locator: stored.locator ?? mainWorkspace.id, ...(stored.parent !== undefined ? { parent: stored.parent } : {}) };
  } else if (first && folder) {
    const project = paseo.projects.find((p) => p.projectId === first.projectId) ?? null;
    const parent = worktreeParent({ projectRootPath: project?.projectRootPath, dirReal, checkouts, realpath, liveScopes });
    const branch = worktreeBranch(git, dirReal);
    const id = requestedName ?? (parent && branch ? `${parent.id}@${branch}` : folder);
    scope = { id, kind: 'workspace', locator: first.id, ...(parent ? { parent } : {}) };
  }
  const forkName = scope?.id ?? normalized.repo;
  const input = normalized.local ?? normalized.repo;
  const repoKey = forkName.toLowerCase();
  const legacyKey = folder ? `local/${folder}`.toLowerCase() : null;
  const matchKeys = new Set([repoKey]);
  if (legacyKey) matchKeys.add(legacyKey);
  if (stored && stored.id.toLowerCase() !== repoKey) matchKeys.add(stored.id.toLowerCase());
  const issues = [...checkoutIssues];

  let checkout = null;
  if (dirReal && !issues.length) {
    checkout = checkouts.find((c) => real(c.path, realpath) === dirReal) ?? null;
    if (checkout) {
      checkout = { ...checkout, local: true, worktree: true };
    } else {
      checkout = { path: dirReal, linkedWorktree: true, remotes: {}, repos: {}, local: true, worktree: true };
    }
  }

  const projectIds = new Set(matched.map((w) => w.projectId).filter(Boolean));
  const projects = paseo.projects.filter((p) => projectIds.has(p.projectId));
  const mainCandidates = matched;

  const labelled = paseo.agents.filter((a) => a.labels?.[LABEL.role] === 'steer' && matchKeys.has(a.labels?.[LABEL.repo]?.toLowerCase()));
  const legacy = mainWorkspace
    ? paseo.agents.filter((a) => a.workspaceId === mainWorkspace.id && !a.archivedAt && !a.labels?.[LABEL.role] && STEER_TITLE.test((a.title ?? '').trim()))
    : [];
  const steerIds = new Set([...labelled, ...legacy].map((a) => a.id));
  const projectWorkspaceIds = new Set(paseo.workspaces.filter((w) => projectIds.has(w.projectId)).map((w) => w.id));
  const workers = allWorkers(paseo, steerIds, forkName);
  const worktreeAgents = mainWorkspace
    ? paseo.agents.filter((a) => a.workspaceId === mainWorkspace.id && !a.archivedAt && !steerIds.has(a.id) && a.labels?.[LABEL.role] !== 'steer')
    : [];

  return {
    input,
    parentDir,
    local: true,
    localPath: dirReal,
    github: { local: true, fork: { status: 'local' }, upstream: null, source: null, notes: [] },
    forkName,
    scope,
    requestedName,
    requestedSubject,
    liveScopes: (liveScopes ?? []).map((s) => ({ id: s.id, kind: s.kind, workspaceId: s.workspaceId })),
    expectedPath: dirReal,
    cloneTarget: null,
    checkout,
    checkoutIssues: issues,
    relatedCheckouts: [],
    upstreamRemote: null,
    projects,
    mainCandidates,
    otherLocalWorkspaces: [],
    mainWorkspace,
    steers: { labelled, legacy },
    workers,
    agents: paseo.agents,
    worktreeAgents,
    worktree: first ? { workspaceId: mainWorkspace?.id ?? null, workspaceIds: matched.map((w) => w.id), projectId: first.projectId ?? null, directory: first.workspaceDirectory } : null,
    projectWorkspaceIds: [...projectWorkspaceIds],
    providers: paseo.providers,
  };
}

/** Worktree adoption by workspace id ("workspace:<id>" or bare "wks_..."). */
function discoverWorktreeById(normalized, { checkouts, paseo, realpath, git, liveScopes }) {
  const id = normalized.workspaceId;
  const parentDir = normalized.parentDir;
  const found = paseo.workspaces.find((w) => w.id === id) ?? null;
  if (!found) {
    return buildWorktreeDiscovery([], {
      normalized, parentDir, checkouts, paseo, realpath, git, liveScopes,
      checkoutIssues: [`Workspace ${id} not found; pass an existing worktree workspace id (see "workspace:<id>" in docs/configuration.md)`],
    });
  }
  if (!isWorktreeWorkspace(found)) {
    return buildWorktreeDiscovery([], {
      normalized, parentDir, checkouts, paseo, realpath, git, liveScopes,
      checkoutIssues: [`Workspace ${id} ("${found.title ?? found.name}") is not a worktree workspace; adopt plain directories with {"local": <path>}`],
    });
  }
  return buildWorktreeDiscovery([found], { normalized, parentDir, checkouts, paseo, realpath, git, liveScopes, checkoutIssues: [] });
}

function discoverLocal(normalized, { config, checkouts, paseo, realpath, existsDir, git, liveScopes }) {
  const live = (liveScopes ?? []).map((s) => ({ id: s.id, kind: s.kind, workspaceId: s.workspaceId }));
  const requestedName = normalized.name ?? null;
  const requestedSubject = normalized.subject ?? null;
  // An explicit local path that is a worktree directory adopts that worktree
  // workspace instead of planning a duplicate project/workspace.
  if (normalized.local) {
    const matched = worktreesAt(paseo, real(normalized.local, realpath), realpath);
    if (matched.length === 1) {
      return buildWorktreeDiscovery(matched, { normalized, parentDir: normalized.parentDir, checkouts, paseo, realpath, git, liveScopes, checkoutIssues: [] });
    }
    if (matched.length > 1) {
      return buildWorktreeDiscovery(matched, {
        normalized, parentDir: normalized.parentDir, checkouts, paseo, realpath, git, liveScopes,
        checkoutIssues: [`Several worktree workspaces use ${normalized.local}: ${matched.map((w) => `${w.id} "${w.title ?? w.name}"`).join(', ')}; name one with {"workspace": <id>}`],
      });
    }
  }
  const input = normalized.local ?? normalized.repo;
  const parentDir = normalized.parentDir;
  const workspaceAt = (path) => paseo.workspaces.filter((w) => !isWorktreeWorkspace(w) && real(w.workspaceDirectory, realpath) === path);
  const isMain = (w) => w.metadata?.[METADATA_KEY]?.main === true || MAIN_TITLE.test((w.title ?? w.name ?? '').trim());

  let localPath = normalized.local ?? null;
  const checkoutIssues = [];
  if (!localPath && normalized.localName) {
    const wanted = normalized.localName;
    const candidates = new Map();
    const addCandidate = (p) => {
      if (!p) return;
      const r = real(p, realpath);
      if (!candidates.has(r)) candidates.set(r, p);
    };
    for (const c of checkouts) {
      if (c.linkedWorktree) continue;
      if (basename(c.path) === wanted) addCandidate(c.path);
    }
    for (const pr of paseo.projects) {
      if (basename(pr.projectRootPath) === wanted) addCandidate(pr.projectRootPath);
    }
    for (const w of paseo.workspaces) {
      if (!isWorktreeWorkspace(w) && basename(w.workspaceDirectory) === wanted) addCandidate(w.workspaceDirectory);
    }
    for (const a of paseo.agents) {
      const label = a.labels?.[LABEL.repo]?.toLowerCase();
      if (a.labels?.[LABEL.role] === 'steer' && (label === `local/${wanted}`.toLowerCase() || label === wanted.toLowerCase())) {
        const ws = paseo.workspaces.find((w) => w.id === a.workspaceId);
        if (ws && !isWorktreeWorkspace(ws)) addCandidate(ws.workspaceDirectory);
      }
    }
    // Worktree directories with the same folder name join the same ambiguity
    // check; without any worktree match this block behaves exactly as before.
    const worktreeMatches = paseo.workspaces.filter((w) => isWorktreeWorkspace(w) && basename(w.workspaceDirectory ?? '') === wanted);
    const worktreeDirs = new Map();
    for (const w of worktreeMatches) {
      const r = real(w.workspaceDirectory, realpath);
      if (!worktreeDirs.has(r)) worktreeDirs.set(r, []);
      worktreeDirs.get(r).push(w);
    }
    for (const r of worktreeDirs.keys()) {
      if (!candidates.has(r)) candidates.set(r, r);
    }
    if (worktreeDirs.size) {
      if (candidates.size > 1) {
        checkoutIssues.push(`Several local directories match "${wanted}": ${[...candidates.keys()].join(', ')}; name one with {"local": <path>} or {"workspace": <id>}`);
      } else {
        const only = [...worktreeDirs.values()][0];
        if (only.length === 1 && candidates.size === 1) {
          return buildWorktreeDiscovery(only, { normalized, parentDir, checkouts, paseo, realpath, git, liveScopes, checkoutIssues: [] });
        }
        if (only.length > 1) {
          return buildWorktreeDiscovery(only, {
            normalized, parentDir, checkouts, paseo, realpath, git, liveScopes,
            checkoutIssues: [`Several worktree workspaces share the folder "${wanted}": ${only.map((w) => `${w.id} "${w.title ?? w.name}"`).join(', ')}; name one with {"workspace": <id>}`],
          });
        }
      }
      if (checkoutIssues.length) {
        // Fall through to the normal result shape with the ambiguity issue;
        // localPath stays null so nothing else is planned on it.
      } else if (candidates.size === 1 && !worktreeDirs.has([...candidates.keys()][0])) {
        localPath = [...candidates.keys()][0];
      }
    } else if (candidates.size === 1) {
      localPath = [...candidates.keys()][0];
    } else if (candidates.size > 1) {
      checkoutIssues.push(`Several local directories match "${wanted}": ${[...candidates.keys()].join(', ')}; name one with {"local": <path>}`);
    } else {
      localPath = join(parentDir, wanted);
    }
  }

  const expectedPath = localPath;
  let checkout = null;
  if (localPath && !checkoutIssues.length) {
    const wantedReal = real(localPath, realpath);
    checkout = checkouts.find((c) => !c.linkedWorktree && real(c.path, realpath) === wantedReal) ?? null;
    if (!checkout) {
      const known = paseo.projects.some((p) => real(p.projectRootPath, realpath) === wantedReal)
        || workspaceAt(wantedReal).length > 0;
      if (known || existsDir(localPath)) {
        checkout = { path: wantedReal, linkedWorktree: false, remotes: {}, repos: {}, local: true };
      } else {
        checkoutIssues.push(`Local path ${localPath} does not exist or is not a directory`);
      }
    }
  }

  const path = checkout?.path ?? null;
  const mainCandidates = path ? workspaceAt(path) : [];
  const projectIds = new Set(mainCandidates.map((w) => w.projectId).filter(Boolean));
  for (const project of paseo.projects) if (path && real(project.projectRootPath, realpath) === path) projectIds.add(project.projectId);
  const projects = paseo.projects.filter((p) => projectIds.has(p.projectId));

  const marked = mainCandidates.filter((w) => w.metadata?.[METADATA_KEY]?.main === true);
  const titled = mainCandidates.filter(isMain);
  const mainMatches = marked.length ? marked : titled;
  const mainWorkspace = mainMatches.length === 1 ? mainMatches[0] : null;

  // The scope id names the plan (`--name`, else the folder); a stored scope
  // field wins (stable identity). A hub entry converts the kind to hub (fresh:
  // --name else 'hub'; existing: the stored id is kept unless --name renames).
  // Steers labelled with the legacy `local/<folder>` name still match.
  const folder = localPath ? basename(localPath) : normalized.localName;
  const stored = mainWorkspace && validScope(mainWorkspace.metadata?.[METADATA_KEY]?.scope)
    ? mainWorkspace.metadata[METADATA_KEY].scope
    : null;
  const wantHub = normalized.hub === true;
  const scope = wantHub
    ? { id: requestedName ?? stored?.id ?? 'hub', kind: 'hub', locator: localPath }
    : stored
      ? { id: stored.id, kind: stored.kind, locator: stored.locator ?? localPath, ...(stored.parent !== undefined ? { parent: stored.parent } : {}) }
      : { id: requestedName ?? folder, kind: 'dir', locator: localPath };
  const forkName = scope.id;
  const repoKey = forkName.toLowerCase();
  const legacyKey = `local/${folder}`.toLowerCase();
  const matchKeys = new Set([repoKey, legacyKey]);
  if (stored && stored.id.toLowerCase() !== repoKey) matchKeys.add(stored.id.toLowerCase());
  const labelled = paseo.agents.filter((a) => a.labels?.[LABEL.role] === 'steer' && matchKeys.has(a.labels?.[LABEL.repo]?.toLowerCase()));
  const legacy = mainWorkspace
    ? paseo.agents.filter((a) => a.workspaceId === mainWorkspace.id && !a.archivedAt && !a.labels?.[LABEL.role] && STEER_TITLE.test((a.title ?? '').trim()))
    : [];
  const steerIds = new Set([...labelled, ...legacy].map((a) => a.id));
  const projectWorkspaceIds = new Set(paseo.workspaces.filter((w) => projectIds.has(w.projectId)).map((w) => w.id));
  const workers = allWorkers(paseo, steerIds, forkName);

  return {
    input,
    parentDir,
    local: true,
    localPath,
    github: { local: true, fork: { status: 'local' }, upstream: null, source: null, notes: [] },
    forkName,
    scope,
    requestedName,
    requestedSubject,
    liveScopes: live,
    expectedPath,
    cloneTarget: null,
    checkout,
    checkoutIssues,
    relatedCheckouts: [],
    upstreamRemote: null,
    projects,
    mainCandidates: mainMatches,
    otherLocalWorkspaces: mainCandidates.filter((w) => !mainMatches.includes(w)),
    mainWorkspace,
    steers: { labelled, legacy },
    workers,
    agents: paseo.agents,
    projectWorkspaceIds: [...projectWorkspaceIds],
    providers: paseo.providers,
  };
}

export function discoverRepository(entry, { config, gh, git, checkouts, paseo, realpath = realpathSync, inspectTarget = inspectCloneTarget, existsDir = defaultExistsDir, liveScopes = null }) {
  const normalized = normalizeEntry(entry, config);
  if (normalized.workspaceId) {
    return discoverWorktreeById(normalized, { checkouts, paseo, realpath, git, liveScopes });
  }
  if (normalized.local || normalized.localName) {
    return discoverLocal(normalized, { config, checkouts, paseo, realpath, existsDir, git, liveScopes });
  }
  const { repo: input, parentDir, checkout: explicitCheckout } = normalized;
  const github = resolveGitHub(gh, input, config.github.owner);
  const forkRepo = github.fork.repo ?? null;
  const forkName = forkRepo?.fullName ?? github.fork.planned ?? null;
  const repoName = forkName ? forkName.split('/')[1] : null;
  const expectedPath = repoName ? join(parentDir, repoName) : null;

  const workspaceAt = (path) => paseo.workspaces.filter((w) => !isWorktreeWorkspace(w) && real(w.workspaceDirectory, realpath) === path);
  const { exact, related } = classifyCheckouts(checkouts, { fork: forkName, upstream: github.upstream?.fullName, source: github.source?.fullName });

  const isMain = (w) => w.metadata?.[METADATA_KEY]?.main === true || MAIN_TITLE.test((w.title ?? w.name ?? '').trim());
  let checkout = null;
  const checkoutIssues = [];
  if (explicitCheckout) {
    const wanted = real(explicitCheckout, realpath);
    checkout = exact.find((c) => c.path === wanted) ?? null;
    if (!checkout) checkoutIssues.push(`Requested checkout ${explicitCheckout} is not a checkout with origin ${forkName}`);
  } else if (exact.length === 1) checkout = exact[0];
  else if (exact.length > 1) {
    // Several clones of the fork: only unambiguous signals decide, otherwise ask.
    const atExpected = exact.filter((c) => c.path === real(expectedPath, realpath));
    const withMain = exact.filter((c) => workspaceAt(c.path).some(isMain));
    const pick = withMain.length === 1 ? withMain : atExpected;
    if (pick.length === 1) checkout = pick[0];
    else checkoutIssues.push(`Several checkouts have origin ${forkName}: ${exact.map((c) => c.path).join(', ')}; name one with {"repo": ..., "checkout": <path>}`);
  }
  const cloneTarget = expectedPath && !checkout && !checkoutIssues.length ? inspectTarget(config.checkoutRoot, parentDir, expectedPath) : null;

  let upstreamRemote = null;
  if (checkout && github.upstream) {
    const name = config.github.upstreamRemote;
    const current = checkout.repos[name] ?? null;
    upstreamRemote = !(name in checkout.remotes)
      ? { status: 'missing' }
      : current === github.upstream.fullName.toLowerCase()
        ? { status: 'ok' }
        : { status: 'mismatch', url: checkout.remotes[name] };
  }

  const path = checkout?.path ?? null;
  const mainCandidates = path ? workspaceAt(path) : [];
  const projectIds = new Set(mainCandidates.map((w) => w.projectId).filter(Boolean));
  for (const project of paseo.projects) if (path && real(project.projectRootPath, realpath) === path) projectIds.add(project.projectId);
  const projects = paseo.projects.filter((p) => projectIds.has(p.projectId));

  // Several local workspaces may share one checkout (one per task); only a marked or
  // Main-titled one is the main workspace. Marked wins over title.
  const marked = mainCandidates.filter((w) => w.metadata?.[METADATA_KEY]?.main === true);
  const titled = mainCandidates.filter(isMain);
  const mainMatches = marked.length ? marked : titled;
  const mainWorkspace = mainMatches.length === 1 ? mainMatches[0] : null;

  // Steers are identified by labels; an unlabelled top-level "Steer X" in the main
  // workspace is a legacy steer that can be adopted.
  const repoKey = forkName?.toLowerCase();
  const labelled = paseo.agents.filter((a) => a.labels?.[LABEL.role] === 'steer' && a.labels?.[LABEL.repo]?.toLowerCase() === repoKey);
  const legacy = mainWorkspace
    ? paseo.agents.filter((a) => a.workspaceId === mainWorkspace.id && !a.archivedAt && !a.labels?.[LABEL.role] && STEER_TITLE.test((a.title ?? '').trim()))
    : [];
  const steerIds = new Set([...labelled, ...legacy].map((a) => a.id));
  const projectWorkspaceIds = new Set(paseo.workspaces.filter((w) => projectIds.has(w.projectId)).map((w) => w.id));
  const workers = allWorkers(paseo, steerIds, forkName);
  // The github scope id is the resolved fork; the network-verified identity
  // always wins over a stored field (a mismatch is a planner conflict).
  const scope = forkName ? { id: forkName, kind: 'github', locator: forkName } : null;

  return {
    input,
    parentDir,
    github,
    forkName,
    scope,
    requestedName: normalized.name ?? null,
    requestedSubject: normalized.subject ?? null,
    requestedHub: normalized.hub === true,
    liveScopes: (liveScopes ?? []).map((s) => ({ id: s.id, kind: s.kind, workspaceId: s.workspaceId })),
    expectedPath,
    cloneTarget,
    checkout,
    checkoutIssues,
    relatedCheckouts: related.map((c) => ({ path: c.path, remotes: c.remotes })),
    upstreamRemote,
    projects,
    mainCandidates: mainMatches,
    otherLocalWorkspaces: mainCandidates.filter((w) => !mainMatches.includes(w)),
    mainWorkspace,
    steers: { labelled, legacy },
    workers,
    agents: paseo.agents,
    projectWorkspaceIds: [...projectWorkspaceIds],
    providers: paseo.providers,
  };
}

export { STEER_TITLE };
