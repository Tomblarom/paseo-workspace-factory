// Read-only discovery for one repository: GitHub identity, local checkout and
// the Paseo project, main workspace, steers and workers that belong to it.
import { basename, join, resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { resolveGitHub, parseRepoInput } from './github.mjs';
import { classifyCheckouts } from './local.mjs';
import { LABEL, LEGACY_PREFIX, METADATA_KEY, PARENT_LABEL, parentOf } from './paseo.mjs';
import { validScope } from './scope.mjs';
import { continuedFromId, inheritContinuationLabels, resolveContinuations } from './zerosub.mjs';

/**
 * Marker prefix on the active steer's tab title ("▷ Steer E"); the single
 * constant for it. Configurable per repository via `steers.activeMarker`
 * (empty disables the marker); see activeMarker().
 */
const ACTIVE_STEER_MARKER = '▷';
/** Earlier default markers: still stripped so existing tabs migrate without a doubled prefix. */
const LEGACY_STEER_MARKERS = ['●'];

/** Effective active-steer marker for a config: the default "▷" unless `steers.activeMarker` overrides it (empty disables). */
function activeMarker(config) {
  const value = config?.steers?.activeMarker;
  return value === undefined || value === null ? ACTIVE_STEER_MARKER : value;
}

/** Removes the leading "<marker> " prefix from a tab title (trims; idempotent). */
function stripActiveMarker(title, marker = ACTIVE_STEER_MARKER) {
  let trimmed = typeof title === 'string' ? title.trim() : '';
  for (const prefix of [marker, ...LEGACY_STEER_MARKERS]) {
    if (prefix && trimmed.startsWith(prefix)) trimmed = trimmed.slice(prefix.length).replace(/^\s+/, '');
  }
  return trimmed;
}

/** Adds the "<marker> " prefix to a tab title unless already present (idempotent; empty marker strips instead). */
function markSteerTitle(title, marker = ACTIVE_STEER_MARKER) {
  const base = stripActiveMarker(title, marker);
  return marker ? `${marker} ${base}` : base;
}

/**
 * Legacy steer titles: "Steer A" plus an optional suffix — bracketed
 * ("Steer A [kn]", "Steer A (kn)") or after a separator ("Steer A · fp") —
 * matched case-insensitively ("steer a"). Group 1 is always the UPPERCASE slot
 * letter, so planner.mjs:300 (`match(STEER_TITLE)[1] === slot`) works unchanged.
 * A digit ("Steer 3") never matches here: it is only a digit candidate, never
 * auto-assigned (see STEER_DIGIT_TITLE). An optional leading run of symbol
 * characters (the active-steer marker, e.g. "▷ Steer E") is tolerated and
 * ignored; word characters never match there, so "My Steer A" still rejects.
 */
const MARKER_PREFIX_PATTERN = String.raw`(?:[^\w\s]+\s+)?`;
const STEER_TITLE_PATTERN = String.raw`^${MARKER_PREFIX_PATTERN}steer\s+([a-z])(?:\s*(?:\([^()]*\)|\[[^\]]*\])|\s*[·\-–—:|]\s*\S.*)?$`;
class SteerTitleRegExp extends RegExp {
  exec(value) {
    const match = super.exec(value);
    if (match) match[1] = match[1].toUpperCase();
    return match;
  }
}
const STEER_TITLE = new SteerTitleRegExp(STEER_TITLE_PATTERN, 'i');
/** Digit steer titles ("Steer 3", same suffix and marker-prefix rules): candidates for explicit --adopt only. */
const STEER_DIGIT_TITLE = new RegExp(String.raw`^${MARKER_PREFIX_PATTERN}steer\s+(\d+)(?:\s*(?:\([^()]*\)|\[[^\]]*\])|\s*[·\-–—:|]\s*\S.*)?$`, 'i');
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

/** Live scopes as plan refs (id, kind, workspace id, domain pointer for grouping). */
function liveScopeRefs(liveScopes) {
  return (liveScopes ?? []).map((s) => ({ id: s.id, kind: s.kind, workspaceId: s.workspaceId, ...(typeof s.domain === 'string' && s.domain ? { domain: s.domain } : {}) }));
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
 * Validates a per-entry scope name (`--name` / entry `"name"`). Scope ids
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
 * Validates a per-entry main workspace override (`--main`).
 * Only a workspace reference (`workspace:<id>`, `worktree:<id>`, bare `wks_...`).
 * Returns the workspace id or null when absent.
 */
function normalizeMainRef(raw, entry) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new Error(`Entry "main" must be a workspace id string: ${JSON.stringify(entry)}`);
  const id = workspaceIdFromRepo(raw);
  if (!id) throw new Error(`Not a workspace reference in "main": ${JSON.stringify(raw)} (expected "workspace:<id>")`);
  return id;
}

/**
 * Validates a per-entry domain pointer (`--domain` / entry `"domain"`).
 * Undefined/null means "not requested" (no change); "" clears the pointer;
 * otherwise a scope id (owner/repo forms keep their "/", only ":" and control
 * characters are rejected). Returns undefined, "" or the trimmed id.
 */
function normalizeDomain(raw, entry) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new Error(`Entry "domain" must be a string: ${JSON.stringify(entry)}`);
  const id = raw.trim();
  if (!id) return '';
  if (id.length > 200) throw new Error(`Entry "domain" is too long (max 200 characters): ${JSON.stringify(entry)}`);
  if (id.includes(':') || /[\0-\x1f\x7f]/.test(id)) {
    throw new Error(`Entry "domain" must not contain ":" or control characters: ${JSON.stringify(entry)}`);
  }
  return id;
}

/** Normalizes a single workspace entry: "owner/repo", a URL, { repo, parentDir?, main?, domain?, name?, hub? }, { local: <path>, domain?, name?, hub? } or "local/<folder>", { workspace: <id>, domain?, name?, hub? } or "workspace:<id>" (bare "wks_..." ids too). A hub entry plans a hub-kind scope (S5b). `"main"` (github only) adopts that worktree workspace as the scope's main workspace. `"domain"` sets the domain pointer ("" clears it); hubs carry no domain. `"checkout"` and `"subject"` were retired with bulk provisioning (K13). */
export function normalizeEntry(entry, config) {
  const raw = typeof entry === 'object' && entry !== null ? entry : null;
  if (raw && raw.checkout !== undefined) throw new Error(`Entry "checkout" (--checkout) was retired; address the existing workspace directly (workspace:<id> or --local <path>): ${JSON.stringify(entry)}`);
  if (raw && raw.subject !== undefined) throw new Error(`Entry "subject" (--subject) was retired with the title templates; workspace titles stay as they are: ${JSON.stringify(entry)}`);
  if (typeof entry === 'object' && entry !== null && typeof entry.local === 'string') {
    if (entry.main !== undefined) throw new Error(`Entry "main" (--main) is only supported for github entries: ${JSON.stringify(entry)}`);
    const rawPath = entry.local.trim();
    if (!rawPath) throw new Error(`Repository entry needs a non-empty "local" path: ${JSON.stringify(entry)}`);
    const local = resolve(rawPath);
    const base = basename(local);
    if (!base || base === '.' || base === '..') throw new Error(`Local path has no folder name: ${JSON.stringify(entry)}`);
    const name = normalizeScopeName(entry.name, entry);
    if (entry.hub !== undefined && typeof entry.hub !== 'boolean') throw new Error(`Entry "hub" must be a boolean: ${JSON.stringify(entry)}`);
    const domain = normalizeDomain(entry.domain, entry);
    if (domain !== undefined && entry.hub === true) throw new Error(`Entry must not combine "hub" with "domain" (hubs carry no domain): ${JSON.stringify(entry)}`);
    return { repo: `local/${base}`, local, parentDir: resolve(entry.parentDir ?? config.checkoutRoot), ...(name !== null ? { name } : {}), ...(entry.hub === true ? { hub: true } : {}), ...(domain !== undefined ? { domain } : {}) };
  }
  if (typeof entry === 'object' && entry !== null && (typeof entry.workspace === 'string' || typeof entry.workspaceId === 'string')) {
    if (entry.main !== undefined) throw new Error(`Entry "main" (--main) is only supported for github entries: ${JSON.stringify(entry)}`);
    const rawId = (entry.workspace ?? entry.workspaceId).trim();
    if (!rawId) throw new Error(`Repository entry needs a non-empty "workspace" id: ${JSON.stringify(entry)}`);
    const name = normalizeScopeName(entry.name, entry);
    if (entry.hub !== undefined && typeof entry.hub !== 'boolean') throw new Error(`Entry "hub" must be a boolean: ${JSON.stringify(entry)}`);
    const domain = normalizeDomain(entry.domain, entry);
    if (domain !== undefined && entry.hub === true) throw new Error(`Entry must not combine "hub" with "domain" (hubs carry no domain): ${JSON.stringify(entry)}`);
    return { repo: `workspace:${rawId}`, workspaceId: rawId, parentDir: resolve(entry.parentDir ?? config.checkoutRoot), ...(name !== null ? { name } : {}), ...(entry.hub === true ? { hub: true } : {}), ...(domain !== undefined ? { domain } : {}) };
  }
  const value = typeof entry === 'string' ? { repo: entry } : { ...entry };
  if (typeof value.repo !== 'string') throw new Error(`Repository entry needs "repo", "local" or "workspace": ${JSON.stringify(entry)}`);
  const name = normalizeScopeName(value.name, entry);
  if (value.hub !== undefined && typeof value.hub !== 'boolean') throw new Error(`Entry "hub" must be a boolean: ${JSON.stringify(entry)}`);
  const withName = { ...(name !== null ? { name } : {}), ...(value.hub === true ? { hub: true } : {}) };
  const mainWorkspaceId = normalizeMainRef(value.main, entry);
  const domain = normalizeDomain(value.domain, entry);
  if (domain !== undefined && value.hub === true) throw new Error(`Entry must not combine "hub" with "domain" (hubs carry no domain): ${JSON.stringify(entry)}`);
  const workspaceId = workspaceIdFromRepo(value.repo);
  if (workspaceId) {
    if (mainWorkspaceId) throw new Error(`Entry "main" (--main) is only supported for github entries: ${JSON.stringify(entry)}`);
    return { repo: `workspace:${workspaceId}`, workspaceId, parentDir: resolve(value.parentDir ?? config.checkoutRoot), ...withName, ...(domain !== undefined ? { domain } : {}) };
  }
  const localName = localNameFromRepo(value.repo);
  if (localName) {
    if (mainWorkspaceId) throw new Error(`Entry "main" (--main) is only supported for github entries: ${JSON.stringify(entry)}`);
    return { repo: `local/${localName}`, localName, parentDir: resolve(value.parentDir ?? config.checkoutRoot), ...withName, ...(domain !== undefined ? { domain } : {}) };
  }
  return { repo: value.repo, parentDir: resolve(value.parentDir ?? config.checkoutRoot), ...withName, ...(mainWorkspaceId ? { mainWorkspaceId } : {}), ...(domain !== undefined ? { domain } : {}) };
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

/**
 * ZeroSub continuation tabs stand in for their origin (see zerosub.mjs):
 * every superseded origin in `list` is replaced by its live continuation,
 * which inherits the origin's factory labels (missing keys only) so slot
 * attribution and status display follow the live tab. Copies carry
 * `continuedFrom: <originId>`; an archived origin stays archived through
 * the copy, so it never resurfaces as a live steer. Results dedupe by id;
 * agents without a resolvable continuation pass through untouched.
 * `switches` carries timeline-derived { agentId, continuedIn } pairs.
 */
export function applyContinuations(list, agents, switches = []) {
  const resolution = resolveContinuations(agents ?? list ?? [], switches);
  const byId = new Map((agents ?? list ?? []).map((agent) => [agent?.id, agent]));
  const seen = new Set();
  const out = [];
  for (const agent of list ?? []) {
    if (!agent || typeof agent.id !== 'string' || !agent.id) {
      out.push(agent);
      continue;
    }
    const liveId = resolution.liveFor[agent.id];
    if (liveId && liveId !== agent.id && byId.get(liveId)) {
      const live = byId.get(liveId);
      const copy = {
        ...live,
        labels: inheritContinuationLabels(live, agent),
        continuedFrom: agent.id,
        ...(agent.archivedAt && !live.archivedAt ? { archivedAt: agent.archivedAt } : {}),
      };
      if (!seen.has(copy.id)) {
        seen.add(copy.id);
        out.push(copy);
      }
      continue;
    }
    const origin = continuedFromId(agent);
    if (origin && byId.has(origin) && !seen.has(agent.id)) {
      seen.add(agent.id);
      out.push({ ...agent, continuedFrom: origin });
      continue;
    }
    if (!seen.has(agent.id)) {
      seen.add(agent.id);
      out.push(agent);
    }
  }
  return out;
}

/**
 * Creation timestamp of an agent snapshot (ms), or null when missing or
 * unparsable. Tolerates both `createdAt` and `created_at`.
 */
function createdMs(agent) {
  const value = agent?.createdAt ?? agent?.created_at ?? null;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Same-slot newer-wins: while a refreshed slot holds two live agents (the
 * retired one not yet archived), the older holders are marked `superseded`
 * and the newest by creation stays the holder — no ambiguity error. Only
 * groups where every live holder carries a parseable creation timestamp
 * with a unique newest are marked; anything else (missing or tied
 * timestamps) passes through unmarked and keeps the ambiguity refusal.
 * Archived agents never participate. Returns a new array; marked holders
 * are copies with `superseded: true`, everything else passes through.
 * (Unrelated to ZeroSub continuation origins, which resolve to the live
 * tab in applyContinuations above instead of staying visible.)
 */
export function markSupersededSlotHolders(list) {
  const agents = [...(list ?? [])];
  const bySlot = new Map();
  for (const agent of agents) {
    if (!agent || agent.archivedAt) continue;
    const slot = agent.labels?.[LABEL.slot];
    if (typeof slot !== 'string' || !slot) continue;
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(agent);
  }
  const superseded = new Set();
  for (const holders of bySlot.values()) {
    if (holders.length < 2) continue;
    const stamps = holders.map((agent) => ({ agent, ms: createdMs(agent) }));
    if (stamps.some((entry) => entry.ms === null)) continue;
    const newest = Math.max(...stamps.map((entry) => entry.ms));
    if (stamps.filter((entry) => entry.ms === newest).length !== 1) continue;
    for (const entry of stamps) {
      if (entry.ms !== newest) superseded.add(entry.agent.id);
    }
  }
  if (!superseded.size) return agents;
  return agents.map((agent) => (agent && superseded.has(agent.id) ? { ...agent, superseded: true } : agent));
}

/** Resolve continuation tabs and mark superseded same-slot holders consistently. */
export function resolveSteerHolders(labelled, agents, switches = []) {
  return markSupersededSlotHolders(applyContinuations(labelled, agents, switches));
}

/**
 * Live holders of one slot from a resolved list: matching slot (legacy slot
 * labels count, new prefix wins), not archived, not superseded, not retired
 * unless `includeRetired`. Agents and status rows share this one selector.
 */
export function liveSlotHolders(list, slot, { includeRetired = false } = {}) {
  if (typeof slot !== 'string' || !slot) return [];
  return (list ?? []).filter((entry) => {
    if (!entry || entry.archivedAt || entry.superseded === true) return false;
    if (!includeRetired && entry.retired === true) return false;
    return (entry.labels?.[LABEL.slot] ?? entry.labels?.[`${LEGACY_PREFIX}.slot`] ?? entry.slot ?? null) === slot;
  });
}

/**
 * Rewrites worker parent links that point at a superseded origin to the live
 * continuation, so parentSlot attribution follows the live steer. Copies
 * carry `parentContinuedFrom: <originId>`; workers without a superseded
 * parent pass through untouched.
 */
export function remapWorkerParents(workers, agents, switches = []) {
  const resolution = resolveContinuations(agents ?? [], switches);
  if (!Object.keys(resolution.liveFor).length) return [...(workers ?? [])];
  return (workers ?? []).map((worker) => {
    const parent = parentOf(worker);
    const live = parent ? resolution.liveFor[parent] : null;
    if (!live || live === parent) return worker;
    return {
      ...worker,
      labels: { ...(worker.labels ?? {}), [PARENT_LABEL]: live },
      parentContinuedFrom: parent,
    };
  });
}

/**
 * Unlabelled live agents of one workspace titled like a steer with a digit
 * ("Steer 3"): never auto-assigned to a slot, only reported so the user can
 * adopt one explicitly (`--adopt <slot>=<id>`).
 */
function digitSteerCandidates(agents, workspaceId) {
  if (!workspaceId) return [];
  return (agents ?? []).filter((a) => a.workspaceId === workspaceId && !a.archivedAt && !a.labels?.[LABEL.role] && STEER_DIGIT_TITLE.test((a.title ?? '').trim()));
}

/**
 * Worker hint for a candidate whose parent is a labelled steer of another
 * scope: such agents are workers, never steer candidates. Returns
 * { scope, slot, hint } ("Worker von <scope> Steer <slot>") or null.
 * Same-scope parents (any repo/scope label in matchKeys) stay candidates
 * (existing --detach flow); parents without scope/slot labels cannot be
 * attributed and stay candidates too.
 */
function foreignWorkerHint(agent, matchKeys, agentsById) {
  const parentId = parentOf(agent);
  if (!parentId) return null;
  const parent = agentsById.get(parentId);
  if (!parent || parent.labels?.[LABEL.role] !== 'steer') return null;
  const scope = parent.labels?.[LABEL.scope] ?? parent.labels?.[LABEL.repo] ?? null;
  const slot = parent.labels?.[LABEL.slot] ?? null;
  if (typeof scope !== 'string' || !scope || typeof slot !== 'string' || !slot) return null;
  for (const label of [parent.labels?.[LABEL.scope], parent.labels?.[LABEL.repo]]) {
    if (typeof label === 'string' && label && matchKeys.has(label.toLowerCase())) return null;
  }
  return { scope, slot, hint: `Worker von ${scope} Steer ${slot}` };
}

/**
 * Splits steer candidates into true candidates and workers of other scopes'
 * steers. The workers keep their agent record plus the hint for plan notes;
 * they are never adoptable as steers of this scope.
 */
function splitCandidates(candidates, matchKeys, agentsById) {
  const kept = [];
  const foreignWorkers = [];
  for (const agent of candidates ?? []) {
    const info = foreignWorkerHint(agent, matchKeys, agentsById);
    if (info) foreignWorkers.push({ agent, ...info });
    else kept.push(agent);
  }
  return { kept, foreignWorkers };
}

/**
 * Half-labelled steers: live agents in the main workspace with role=steer but
 * without a scope identity — typically legacy ari.wsf.role/slot only
 * (normalized to wsf.role/slot, no wsf.scope/wsf.repo). Labelled steers (repo
 * present) and foreign-labelled agents (a scope label outside matchKeys) are
 * not half-labelled. Archived agents are ignored; closed ones stay visible
 * when they carry a scope assignment (a daemon restart closes real steers
 * too) and are ignored only without one.
 */
function halfLabelledSteers(paseo, mainWorkspace, matchKeys) {
  if (!mainWorkspace) return [];
  return (paseo.agents ?? []).filter((a) => {
    if (a.workspaceId !== mainWorkspace.id || a.archivedAt) return false;
    if (a.labels?.[LABEL.role] !== 'steer') return false;
    const repo = a.labels?.[LABEL.repo];
    if (typeof repo === 'string' && repo) return false;
    const scope = a.labels?.[LABEL.scope];
    if (typeof scope === 'string' && scope && !matchKeys.has(scope.toLowerCase())) return false;
    if (a.status === 'closed' && !(typeof scope === 'string' && scope)) return false;
    return true;
  });
}

/**
 * Steer membership of one discovery pass, shared by the worktree, local and
 * github builders: resolved holders, candidates, workers and parent ids.
 * `labelledFound` stays per builder; `scopeName` attributes workers.
 */
export function resolveScopeMembers(paseo, { mainWorkspace, matchKeys, labelledFound, scopeName, projectIds, zerosubSwitches = [] }) {
  const agentsById = new Map((paseo.agents ?? []).map((a) => [a.id, a]));
  const legacyAll = mainWorkspace
    ? paseo.agents.filter((a) => a.workspaceId === mainWorkspace.id && !a.archivedAt && !a.labels?.[LABEL.role] && STEER_TITLE.test((a.title ?? '').trim()))
    : [];
  const splitLegacy = splitCandidates(legacyAll, matchKeys, agentsById);
  const splitDigit = splitCandidates(digitSteerCandidates(paseo.agents, mainWorkspace?.id), matchKeys, agentsById);
  const legacy = splitLegacy.kept;
  const digitCandidates = splitDigit.kept;
  const foreignWorkers = [...splitLegacy.foreignWorkers, ...splitDigit.foreignWorkers];
  const halfLabelled = halfLabelledSteers(paseo, mainWorkspace, matchKeys);
  const labelled = resolveSteerHolders(labelledFound, paseo.agents, zerosubSwitches);
  // Worker parent ids: mapped steers plus the superseded origins they stand
  // in for (workers still point at the origin).
  const steerIds = new Set([...labelled, ...legacy].map((a) => a?.id).filter((id) => typeof id === 'string' && id));
  for (const [origin, live] of Object.entries(resolveContinuations(paseo.agents, zerosubSwitches).liveFor)) {
    if (steerIds.has(live)) steerIds.add(origin);
  }
  const projectWorkspaceIds = [...new Set(paseo.workspaces.filter((w) => projectIds.has(w.projectId)).map((w) => w.id))];
  const workers = remapWorkerParents(applyContinuations(allWorkers(paseo, steerIds, scopeName), paseo.agents, zerosubSwitches), paseo.agents, zerosubSwitches);
  return { labelled, legacy, digitCandidates, foreignWorkers, halfLabelled, steerIds, workers, projectWorkspaceIds };
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
 * when the origin parses to owner/repo (matched case-insensitively; the live
 * scope id wins as the canonical form, else the spelling from the remote URL),
 * else a dir scope for the project folder, else none.
 * Local git data only, no network. Never throws.
 */
function worktreeParent({ projectRootPath, dirReal, checkouts, realpath, liveScopes }) {
  try {
    if (!projectRootPath) return null;
    const rootReal = real(projectRootPath, realpath);
    if (!rootReal || rootReal === dirReal) return null;
    const atRoot = checkouts.find((c) => real(c.path, realpath) === rootReal) ?? null;
    let parsed = null;
    try {
      parsed = atRoot?.remotes?.origin ? parseRepoInput(atRoot.remotes.origin).fullName : null;
    } catch {
      parsed = null;
    }
    if (parsed) {
      const live = (liveScopes ?? []).find((s) => s.kind === 'github' && typeof s.id === 'string' && s.id.toLowerCase() === parsed.toLowerCase());
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
function buildWorktreeDiscovery(matched, { normalized, parentDir, checkouts, paseo, realpath, checkoutIssues, git, liveScopes, zerosubSwitches = [] }) {
  const first = matched[0] ?? null;
  const dirReal = first ? real(first.workspaceDirectory, realpath) : null;
  const base = first ? basename(first.workspaceDirectory ?? '') : null;
  const folder = base && base !== '.' && base !== '..' && !base.includes('/') ? base : null;
  const requestedName = normalized.name ?? null;
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
  // Domain pointer: an explicit --domain wins ("" clears, so the planned scope
  // carries none); otherwise the stored pointer is kept. Hubs carry no domain.
  const requestedDomain = normalized.domain;
  if (!wantHub && scope && requestedDomain !== '') {
    const domain = requestedDomain ?? stored?.domain ?? null;
    if (typeof domain === 'string' && domain) scope = { ...scope, domain };
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

  const labelledFound = paseo.agents.filter((a) => a.labels?.[LABEL.role] === 'steer' && matchKeys.has(a.labels?.[LABEL.repo]?.toLowerCase()));
  const { labelled, legacy, digitCandidates, foreignWorkers, halfLabelled, steerIds, workers, projectWorkspaceIds } = resolveScopeMembers(paseo, { mainWorkspace, matchKeys, labelledFound, scopeName: forkName, projectIds, zerosubSwitches });
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
    requestedDomain,
    liveScopes: liveScopeRefs(liveScopes),
    expectedPath: dirReal,
    checkout,
    checkoutIssues: issues,
    relatedCheckouts: [],
    projects,
    mainCandidates,
    otherLocalWorkspaces: [],
    mainWorkspace,
    steers: { labelled, legacy, digitCandidates, foreignWorkers, halfLabelled },
    workers,
    agents: paseo.agents,
    worktreeAgents,
    worktree: first ? { workspaceId: mainWorkspace?.id ?? null, workspaceIds: matched.map((w) => w.id), projectId: first.projectId ?? null, directory: first.workspaceDirectory } : null,
    projectWorkspaceIds,
    providers: paseo.providers,
  };
}

/** Worktree adoption by workspace id ("workspace:<id>" or bare "wks_..."). */
function discoverWorktreeById(normalized, { checkouts, paseo, realpath, git, liveScopes, zerosubSwitches = [] }) {
  const id = normalized.workspaceId;
  const parentDir = normalized.parentDir;
  const found = paseo.workspaces.find((w) => w.id === id) ?? null;
  if (!found) {
    return buildWorktreeDiscovery([], {
      normalized, parentDir, checkouts, paseo, realpath, git, liveScopes, zerosubSwitches,
      checkoutIssues: [`Workspace ${id} not found; pass an existing worktree workspace id (see "workspace:<id>" in docs/configuration.md)`],
    });
  }
  if (!isWorktreeWorkspace(found)) {
    return buildWorktreeDiscovery([], {
      normalized, parentDir, checkouts, paseo, realpath, git, liveScopes, zerosubSwitches,
      checkoutIssues: [`Workspace ${id} ("${found.title ?? found.name}") is not a worktree workspace; adopt plain directories with {"local": <path>}`],
    });
  }
  return buildWorktreeDiscovery([found], { normalized, parentDir, checkouts, paseo, realpath, git, liveScopes, zerosubSwitches, checkoutIssues: [] });
}

function discoverLocal(normalized, { config, checkouts, paseo, realpath, existsDir, git, liveScopes, zerosubSwitches = [] }) {
  const live = liveScopeRefs(liveScopes);
  const requestedName = normalized.name ?? null;
  const requestedDomain = normalized.domain;
  // An explicit local path that is a worktree directory adopts that worktree
  // workspace instead of planning a duplicate project/workspace.
  if (normalized.local) {
    const matched = worktreesAt(paseo, real(normalized.local, realpath), realpath);
    if (matched.length === 1) {
      return buildWorktreeDiscovery(matched, { normalized, parentDir: normalized.parentDir, checkouts, paseo, realpath, git, liveScopes, zerosubSwitches, checkoutIssues: [] });
    }
    if (matched.length > 1) {
      return buildWorktreeDiscovery(matched, {
        normalized, parentDir: normalized.parentDir, checkouts, paseo, realpath, git, liveScopes, zerosubSwitches,
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
          return buildWorktreeDiscovery(only, { normalized, parentDir, checkouts, paseo, realpath, git, liveScopes, zerosubSwitches, checkoutIssues: [] });
        }
        if (only.length > 1) {
          return buildWorktreeDiscovery(only, {
            normalized, parentDir, checkouts, paseo, realpath, git, liveScopes, zerosubSwitches,
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
  let scope = wantHub
    ? { id: requestedName ?? stored?.id ?? 'hub', kind: 'hub', locator: localPath }
    : stored
      ? { id: stored.id, kind: stored.kind, locator: stored.locator ?? localPath, ...(stored.parent !== undefined ? { parent: stored.parent } : {}) }
      : { id: requestedName ?? folder, kind: 'dir', locator: localPath };
  // Domain pointer: an explicit --domain wins ("" clears); otherwise the stored
  // pointer is kept. Hubs carry no domain.
  if (!wantHub && requestedDomain !== '') {
    const domain = requestedDomain ?? stored?.domain ?? null;
    if (typeof domain === 'string' && domain) scope = { ...scope, domain };
  }
  const forkName = scope.id;
  const repoKey = forkName.toLowerCase();
  const legacyKey = `local/${folder}`.toLowerCase();
  const matchKeys = new Set([repoKey, legacyKey]);
  if (stored && stored.id.toLowerCase() !== repoKey) matchKeys.add(stored.id.toLowerCase());
  const labelledFound = paseo.agents.filter((a) => a.labels?.[LABEL.role] === 'steer' && matchKeys.has(a.labels?.[LABEL.repo]?.toLowerCase()));
  const { labelled, legacy, digitCandidates, foreignWorkers, halfLabelled, steerIds, workers, projectWorkspaceIds } = resolveScopeMembers(paseo, { mainWorkspace, matchKeys, labelledFound, scopeName: forkName, projectIds, zerosubSwitches });

  return {
    input,
    parentDir,
    local: true,
    localPath,
    github: { local: true, fork: { status: 'local' }, upstream: null, source: null, notes: [] },
    forkName,
    scope,
    requestedName,
    requestedDomain,
    liveScopes: live,
    expectedPath,
    checkout,
    checkoutIssues,
    relatedCheckouts: [],
    projects,
    mainCandidates: mainMatches,
    otherLocalWorkspaces: mainCandidates.filter((w) => !mainMatches.includes(w)),
    mainWorkspace,
    steers: { labelled, legacy, digitCandidates, foreignWorkers, halfLabelled },
    workers,
    agents: paseo.agents,
    projectWorkspaceIds,
    providers: paseo.providers,
  };
}

export function discoverRepository(entry, { config, gh, git, checkouts, paseo, realpath = realpathSync, existsDir = defaultExistsDir, liveScopes = null, zerosubSwitches = [] }) {
  const normalized = normalizeEntry(entry, config);
  if (normalized.workspaceId) {
    return discoverWorktreeById(normalized, { checkouts, paseo, realpath, git, liveScopes, zerosubSwitches });
  }
  if (normalized.local || normalized.localName) {
    return discoverLocal(normalized, { config, checkouts, paseo, realpath, existsDir, git, liveScopes, zerosubSwitches });
  }
  const { repo: input, parentDir } = normalized;
  const github = resolveGitHub(gh, input, config.github.owner);
  const forkRepo = github.fork.repo ?? null;
  const forkName = forkRepo?.fullName ?? github.fork.planned ?? null;
  const repoName = forkName ? forkName.split('/')[1] : null;
  const expectedPath = repoName ? join(parentDir, repoName) : null;

  const workspaceAt = (path) => paseo.workspaces.filter((w) => !isWorktreeWorkspace(w) && real(w.workspaceDirectory, realpath) === path);
  const { exact, related } = classifyCheckouts(checkouts, { fork: forkName, upstream: github.upstream?.fullName, source: github.source?.fullName });

  const isMain = (w) => w.metadata?.[METADATA_KEY]?.main === true || MAIN_TITLE.test((w.title ?? w.name ?? '').trim());
  // --main workspace:<id>: that worktree workspace becomes this github scope's
  // main workspace (same existence/worktree validation as worktree adoption).
  // The scope id stays the resolved fork; no new project or workspace is used.
  const requestedMainId = normalized.mainWorkspaceId ?? null;
  let mainOverride = null;
  const checkoutIssues = [];
  if (requestedMainId) {
    const found = paseo.workspaces.find((w) => w.id === requestedMainId) ?? null;
    if (!found) {
      checkoutIssues.push(`Workspace ${requestedMainId} not found; pass an existing worktree workspace id (see "workspace:<id>" in docs/configuration.md)`);
    } else if (!isWorktreeWorkspace(found)) {
      checkoutIssues.push(`Workspace ${requestedMainId} ("${found.title ?? found.name}") is not a worktree workspace; --main needs a worktree of ${forkName ?? input}`);
    } else {
      mainOverride = found;
    }
  }
  if (!mainOverride && !requestedMainId && forkName) {
    // Re-plan/status after a --main adoption: the github scope already lives on
    // a worktree workspace, which the checkout-path lookup below cannot see.
    // The live scope (same id, worktree main with factory metadata) wins over
    // a fresh workspace at the checkout path — never a duplicate.
    const live = (liveScopes ?? []).find((s) => typeof s.id === 'string' && s.id.toLowerCase() === forkName.toLowerCase());
    const ws = live ? paseo.workspaces.find((w) => w.id === live.workspaceId) ?? null : null;
    if (ws && isWorktreeWorkspace(ws) && ws.metadata?.[METADATA_KEY]?.main === true) {
      mainOverride = ws;
    }
  }
  let checkout = null;
  if (mainOverride) {
    // The worktree directory is the checkout (linked worktrees never appear in
    // classifyCheckouts' exact list, so it is matched by path instead). A
    // scanned origin for another repository is refused; without a scanned
    // checkout the worktree is still adopted, like buildWorktreeDiscovery.
    const dirReal = real(mainOverride.workspaceDirectory, realpath);
    const atDir = dirReal ? checkouts.find((c) => real(c.path, realpath) === dirReal) ?? null : null;
    if (atDir) {
      let origin = atDir.repos?.origin ?? null;
      if (!origin && atDir.remotes?.origin) {
        try {
          origin = parseRepoInput(atDir.remotes.origin).fullName.toLowerCase();
        } catch {
          origin = null;
        }
      }
      if (origin && forkName && origin !== forkName.toLowerCase()) {
        checkoutIssues.push(`Workspace ${requestedMainId} ("${mainOverride.title ?? mainOverride.name}") is a worktree of ${origin}, not of ${forkName}; --main needs a worktree of this repository`);
      } else {
        checkout = { ...atDir, worktree: true };
      }
    } else if (dirReal) {
      checkout = { path: dirReal, linkedWorktree: true, remotes: {}, repos: {}, worktree: true };
    } else {
      checkoutIssues.push(`Workspace ${requestedMainId} has no readable directory; pass an existing worktree workspace id`);
    }
  } else if (requestedMainId) {
    // The validation issue above is the conflict; no fallback to normal selection.
  } else if (exact.length === 1) checkout = exact[0];
  else if (exact.length > 1) {
    // Several clones of the fork: only unambiguous signals decide, otherwise
    // ask. A main workspace wins first, then the Paseo project checkout, then
    // the expected path. Otherwise enroll one workspace directly by id.
    const atExpected = exact.filter((c) => c.path === real(expectedPath, realpath));
    const withMain = exact.filter((c) => workspaceAt(c.path).some(isMain));
    const atProject = exact.filter((c) => paseo.projects.some((p) => real(p.projectRootPath, realpath) === c.path));
    const pick = withMain.length === 1 ? withMain : atProject.length === 1 ? atProject : atExpected;
    if (pick.length === 1) checkout = pick[0];
    else checkoutIssues.push(`Several checkouts have origin ${forkName}: ${exact.map((c) => c.path).join(', ')}; enroll one workspace directly (workspace:<id> or --local <path>)`);
  }

  const path = checkout?.path ?? null;
  // With --main the named worktree is the main workspace whatever its title;
  // its owning project is attached and no new project is registered.
  const mainCandidates = mainOverride ? [mainOverride] : (path ? workspaceAt(path) : []);
  const projectIds = mainOverride
    ? new Set([mainOverride.projectId].filter(Boolean))
    : new Set(mainCandidates.map((w) => w.projectId).filter(Boolean));
  if (!mainOverride) {
    for (const project of paseo.projects) if (path && real(project.projectRootPath, realpath) === path) projectIds.add(project.projectId);
  }
  const projects = paseo.projects.filter((p) => projectIds.has(p.projectId));

  // Several local workspaces may share one checkout (one per task); only a marked or
  // Main-titled one is the main workspace. Marked wins over title.
  const marked = mainCandidates.filter((w) => w.metadata?.[METADATA_KEY]?.main === true);
  const titled = mainCandidates.filter(isMain);
  const mainMatches = mainOverride ? [mainOverride] : (marked.length ? marked : titled);
  const mainWorkspace = mainOverride ?? (mainMatches.length === 1 ? mainMatches[0] : null);

  // Steers are identified by labels; an unlabelled top-level "Steer X" in the main
  // workspace is a legacy steer that can be adopted.
  const repoKey = forkName?.toLowerCase();
  const labelledFound = paseo.agents.filter((a) => a.labels?.[LABEL.role] === 'steer' && a.labels?.[LABEL.repo]?.toLowerCase() === repoKey);
  const matchKeys = new Set(repoKey ? [repoKey] : []);
  const { labelled, legacy, digitCandidates, foreignWorkers, halfLabelled, steerIds, workers, projectWorkspaceIds } = resolveScopeMembers(paseo, { mainWorkspace, matchKeys, labelledFound, scopeName: forkName, projectIds, zerosubSwitches });
  // The github scope id is the resolved fork; the network-verified identity
  // always wins over a stored field (a mismatch is a planner conflict).
  // --main keeps that identity: the worktree is only the main workspace, never
  // a `<parent>@<branch>` scope of its own. The domain pointer rides along:
  // an explicit --domain wins ("" clears), otherwise the stored one is kept.
  const requestedDomain = normalized.domain;
  let scope = forkName ? { id: forkName, kind: 'github', locator: forkName } : null;
  if (scope && requestedDomain !== '') {
    const storedScope = mainWorkspace && validScope(mainWorkspace.metadata?.[METADATA_KEY]?.scope)
      ? mainWorkspace.metadata[METADATA_KEY].scope
      : null;
    const domain = requestedDomain ?? storedScope?.domain ?? null;
    if (typeof domain === 'string' && domain) scope = { ...scope, domain };
  }
  const untouchedExact = mainOverride && checkout ? exact.filter((c) => c.path !== checkout.path) : [];

  return {
    input,
    parentDir,
    github,
    forkName,
    scope,
    requestedName: normalized.name ?? null,
    requestedHub: normalized.hub === true,
    requestedMain: requestedMainId,
    requestedDomain,
    liveScopes: liveScopeRefs(liveScopes),
    expectedPath,
    checkout,
    checkoutIssues,
    relatedCheckouts: [...related, ...untouchedExact].map((c) => ({ path: c.path, remotes: c.remotes })),
    projects,
    mainCandidates: mainMatches,
    otherLocalWorkspaces: mainCandidates.filter((w) => !mainMatches.includes(w)),
    mainWorkspace,
    steers: { labelled, legacy, digitCandidates, foreignWorkers, halfLabelled },
    workers,
    agents: paseo.agents,
    ...(mainOverride ? { worktree: { workspaceId: mainOverride.id, workspaceIds: [mainOverride.id], projectId: mainOverride.projectId ?? null, directory: mainOverride.workspaceDirectory } } : {}),
    projectWorkspaceIds,
    providers: paseo.providers,
  };
}

export { STEER_TITLE, STEER_DIGIT_TITLE, ACTIVE_STEER_MARKER, activeMarker, stripActiveMarker, markSteerTitle };
