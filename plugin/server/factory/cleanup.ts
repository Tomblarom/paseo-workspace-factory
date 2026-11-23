// @ts-nocheck
// GENERATED from src/cleanup.mjs by npm run plugin:sync. Do not edit.
// Read-only cleanup report (S9a) and confirmable cleanup plans (S9b).
// Collects candidate scopes, workspaces and projects with a loss inventory
// each. Planning only builds ops and hints; execution happens through the
// hash-confirmed apply loop with the `workspace.archive`, `project.delete`
// and `scope.retire` executors.
import { statSync } from 'node:fs';
import { METADATA_KEY, readPaseoState } from './paseo.js';
import { listScopes } from './scope.js';
import { isWorktreeWorkspace } from './discovery.js';
import { readGitState } from './workers.js';

/** Agent label (live tests) or workspace metadata flag (agentless tests) marking scratch. */
export const SCRATCH_LABEL = 'wsf.scratch';

const BUSY = new Set(['running', 'initializing']);

/** True for an existing directory (follows symlinks); injectable for tests. */
export function defaultExistsDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function liveAgentsIn(agents, workspaceId) {
  return agents.filter((a) => !a.archivedAt && a.workspaceId === workspaceId);
}

/**
 * Archived agents per project, including agents whose workspace already
 * vanished from the list (archived workspaces are unlistable, but the daemon
 * still attributes their agents via the projectKeys filter). Archived agents
 * alone are recoverable (soft-delete); deleting their project destroys them
 * permanently, so project.delete inventories and verifies them. Callers
 * without a client get snapshot-attributable agents as a best-effort
 * fallback (see archivedFor).
 */
export async function attachProjectArchivedAgents(paseoState, client) {
  if (!client || typeof client.agents?.list !== 'function') return paseoState;
  const projects = paseoState?.projects ?? [];
  const map = { ...(paseoState?.projectArchivedAgents ?? {}) };
  for (const project of projects) {
    if (!project.projectKey) continue;
    const entries = [];
    let cursor;
    for (let guard = 0; guard < 100; guard += 1) {
      const page = await client.agents.list({ filter: { projectKeys: [project.projectKey], includeArchived: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      entries.push(...(page.entries ?? []));
      if (!page.pageInfo?.hasMore || !page.pageInfo.nextCursor) break;
      cursor = page.pageInfo.nextCursor;
    }
    map[project.projectId] = entries.map((entry) => entry.agent ?? entry)
      .filter((a) => a.archivedAt)
      .map((a) => ({ id: a.id, title: a.title ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  return { ...paseoState, projectArchivedAgents: map };
}

function archivedFor(paseoState, agents, workspaces, projectId) {
  if (paseoState?.projectArchivedAgents?.[projectId]) return paseoState.projectArchivedAgents[projectId];
  const liveWs = new Set(workspaces.filter((w) => w.projectId === projectId).map((w) => w.id));
  return agents.filter((a) => a.archivedAt && liveWs.has(a.workspaceId)).map((a) => ({ id: a.id, title: a.title ?? null }));
}

function gitInventory(git, dir) {
  if (typeof git !== 'function' || !dir) return null;
  const state = readGitState(git, dir); // null when the directory is gone or not a repo
  if (!state) return null;
  return { ...state, ...ignoredInventory(git, dir, state.ignored) };
}

/**
 * Ignored files as count plus first paths (same collapsed `!!` lines as
 * readGitState counts, so the pair stays consistent). Mirrored in apply.mjs
 * for the archive gate; the two cannot share a module across file bounds.
 */
function ignoredInventory(git, dir, fallbackCount) {
  let parsed = null;
  try {
    parsed = parseIgnoredPaths(git(dir, ['status', '--porcelain', '--ignored']));
  } catch {
    parsed = null;
  }
  if (!parsed) return { ignored: fallbackCount, ignoredPaths: [] };
  return { ignored: parsed.count, ignoredPaths: parsed.paths.slice(0, 5) };
}

function parseIgnoredPaths(output) {
  const paths = [];
  for (const line of String(output ?? '').split('\n')) {
    const match = line.match(/^!! (.+)$/);
    if (!match) continue;
    let path = match[1].trim();
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    path = path.replace(/\/+$/, '');
    if (path) paths.push(path);
  }
  return { count: paths.length, paths };
}

/**
 * Candidates over the whole instance: scratch scopes, workspaces with a
 * missing directory, empty projects, several projects on one path, non_git
 * projects without a scope, and retired factory scopes. One entry per match
 * (a workspace can match several rules); each carries a loss inventory and a
 * recommended action. Reads daemon state, the filesystem and git; writes
 * nothing.
 */
export function collectCleanupCandidates(paseoState, { git = null, existsDir = defaultExistsDir } = {}) {
  const projects = paseoState?.projects ?? [];
  const workspaces = paseoState?.workspaces ?? [];
  const agents = paseoState?.agents ?? [];
  const byWorkspaceId = new Map(workspaces.map((w) => [w.id, w]));
  const scopeWorkspaceIds = new Set(listScopes(paseoState ?? {}).map((s) => s.workspaceId));
  const candidates = [];

  const workspaceCandidate = (kind, ws, detail, action) => {
    const live = liveAgentsIn(agents, ws.id);
    candidates.push({
      kind, id: ws.id, title: ws.title ?? ws.name ?? null, path: ws.workspaceDirectory ?? null, detail, action,
      loss: {
        agents: live.length,
        running: live.filter((a) => BUSY.has(a.status)).length,
        worktree: isWorktreeWorkspace(ws),
        git: gitInventory(git, ws.workspaceDirectory),
      },
    });
  };

  // Scratch scopes: any agent labelled at creation, or the metadata flag the
  // agentless crash test sets. Archived scratch agents still mark the scope.
  const scratchWorkspaces = new Set();
  const scratchAgentsByWorkspace = new Map();
  for (const agent of agents) {
    if (agent.labels?.[SCRATCH_LABEL] === undefined) continue;
    const ws = byWorkspaceId.get(agent.workspaceId);
    if (!ws) {
      const live = !agent.archivedAt;
      candidates.push({
        kind: 'scratch', id: agent.id, title: agent.title ?? null, path: null,
        detail: `scratch agent in unknown workspace ${agent.workspaceId ?? '(none)'}`,
        action: 'archive scratch agent',
        loss: { agents: live ? 1 : 0, running: live && BUSY.has(agent.status) ? 1 : 0, worktree: false, git: null },
      });
      continue;
    }
    scratchWorkspaces.add(ws.id);
    scratchAgentsByWorkspace.set(ws.id, (scratchAgentsByWorkspace.get(ws.id) ?? 0) + 1);
  }
  for (const ws of workspaces) {
    if (ws.metadata?.[SCRATCH_LABEL]) scratchWorkspaces.add(ws.id);
  }
  for (const id of scratchWorkspaces) {
    const count = scratchAgentsByWorkspace.get(id) ?? 0;
    workspaceCandidate('scratch', byWorkspaceId.get(id),
      count ? `scratch scope with ${count} scratch agent(s)` : 'scratch scope (marked at creation)',
      'archive scratch workspace and its agents');
  }

  // Workspaces whose directory is gone: nothing on disk is at risk anymore.
  for (const ws of workspaces) {
    if (ws.workspaceDirectory && !existsDir(ws.workspaceDirectory)) {
      workspaceCandidate('missing-directory', ws, `directory ${ws.workspaceDirectory} is gone`, 'archive workspace (no files at risk)');
    }
  }

  const workspacesByProject = new Map();
  for (const ws of workspaces) {
    if (!ws.projectId) continue;
    if (!workspacesByProject.has(ws.projectId)) workspacesByProject.set(ws.projectId, []);
    workspacesByProject.get(ws.projectId).push(ws);
  }
  const projectLoss = (members, rootPath, projectIds) => {
    const live = members.flatMap((ws) => liveAgentsIn(agents, ws.id));
    const archived = projectIds.flatMap((id) => archivedFor(paseoState, agents, workspaces, id));
    return {
      agents: live.length,
      running: live.filter((a) => BUSY.has(a.status)).length,
      worktree: members.some(isWorktreeWorkspace),
      git: gitInventory(git, rootPath),
      archivedAgents: { count: archived.length, first: archived.slice(0, 5) },
    };
  };

  // Projects without workspaces hold nothing.
  for (const project of projects) {
    const members = workspacesByProject.get(project.projectId) ?? [];
    if (members.length) continue;
    candidates.push({
      kind: 'empty-project', id: project.projectId, title: project.projectDisplayName ?? null, path: project.projectRootPath ?? null,
      detail: 'project without workspaces', action: 'delete project',
      loss: projectLoss([], project.projectRootPath, [project.projectId]),
    });
  }

  // Several projects on one path: only one registration can stay.
  const projectsByPath = new Map();
  for (const project of projects) {
    if (!project.projectRootPath) continue;
    if (!projectsByPath.has(project.projectRootPath)) projectsByPath.set(project.projectRootPath, []);
    projectsByPath.get(project.projectRootPath).push(project);
  }
  for (const [path, group] of projectsByPath) {
    if (group.length < 2) continue;
    const members = group.flatMap((p) => workspacesByProject.get(p.projectId) ?? []);
    candidates.push({
      kind: 'duplicate-project-path', id: path, title: null, path,
      detail: `${group.length} projects share this path: ${group.map((p) => p.projectId).join(', ')}`,
      action: 'delete all but one project (manual choice)',
      loss: projectLoss(members, path, group.map((p) => p.projectId)),
    });
  }

  // Non-git projects whose workspaces form no factory scope.
  for (const project of projects) {
    if (project.projectKind !== 'non_git') continue;
    const members = workspacesByProject.get(project.projectId) ?? [];
    if (!members.length) continue; // covered by empty-project
    if (members.some((ws) => scopeWorkspaceIds.has(ws.id))) continue;
    candidates.push({
      kind: 'non-git-no-scope', id: project.projectId, title: project.projectDisplayName ?? null, path: project.projectRootPath ?? null,
      detail: `${members.length} workspace(s), none is a factory scope`, action: 'adopt a workspace as scope, or archive the workspaces',
      loss: projectLoss(members, project.projectRootPath, [project.projectId]),
    });
  }

  // Retired factory scopes (Decision 4: marked retired with movedTo).
  for (const scope of listScopes(paseoState ?? {})) {
    const meta = scope.workspace?.metadata?.[METADATA_KEY];
    if (meta?.retired !== true) continue;
    const ws = byWorkspaceId.get(scope.workspaceId) ?? scope.workspace;
    if (!ws) continue;
    workspaceCandidate('retired-scope', ws,
      meta.movedTo ? `retired scope, moved to ${meta.movedTo}` : 'retired scope',
      'archive retired scope workspace');
  }

  return candidates;
}

function formatGitLoss(git) {
  if (!git) return 'git n/a';
  const parts = [];
  if (!git.dirty && !git.untracked) parts.push('clean');
  if (git.dirty) parts.push('dirty');
  if (git.untracked) parts.push(`+${git.untracked} untracked`);
  if (git.ignored) {
    const shown = (git.ignoredPaths ?? []).slice(0, 5);
    parts.push(`+${git.ignored} ignored${shown.length ? ` (${shown.join(', ')}${git.ignored > shown.length ? ', …' : ''})` : ''}`);
  }
  if (git.detached) parts.push('detached');
  parts.push(git.ahead === null || git.ahead === undefined ? 'upstream unknown' : git.ahead === 0 ? 'up to date' : `${git.ahead} ahead`);
  return `git ${parts.join(', ')}`;
}

export function formatLoss(loss) {
  const base = `agents ${loss.agents} (${loss.running} running) · worktree ${loss.worktree ? 'yes' : 'no'} · ${formatGitLoss(loss.git)}`;
  const archived = loss.archivedAgents?.count
    ? ` · ${loss.archivedAgents.count} archived agent${loss.archivedAgents.count === 1 ? '' : 's'} (${(loss.archivedAgents.first ?? []).map((a) => a.title ?? a.id).join(', ')}${loss.archivedAgents.count > (loss.archivedAgents.first ?? []).length ? ', …' : ''})`
    : '';
  return `${base}${archived}`;
}

function irreversibleSuffix(archived) {
  return ` (irreversible${archived.length ? `: ${archived.length} archived agent${archived.length === 1 ? ' vanishes' : 's vanish'} permanently` : ''})`;
}

/** One compact line per candidate. */
export function formatCandidate(candidate) {
  const head = candidate.title ? `${candidate.kind} ${candidate.id} "${candidate.title}"` : `${candidate.kind} ${candidate.id}`;
  const where = candidate.path ? ` ${candidate.path}` : '';
  return `${head}${where} · ${candidate.detail} · ${formatLoss(candidate.loss)} · → ${candidate.action}`;
}

const ARCHIVABLE_WORKSPACE_KINDS = new Set(['scratch', 'missing-directory', 'retired-scope']);

/**
 * Builds cleanup ops from a daemon snapshot. `only` limits the plan to the
 * given candidate ids (unknown ids refuse); without `--allow-destructive`,
 * destructive ops become hints instead. Duplicate paths, scopeless non-git
 * projects and orphan scratch agents always stay hints: they need a human
 * choice (`project.delete` has no keeper rule, adoption is ambiguous, and S9b
 * defines no `agent.archive` op). Missing-directory worktrees stay manual
 * hints too: without the directory their git state is unverifiable, so the
 * archive gate could never pass. `scope.retire` is an executor building
 * block for relocate flows; cleanup planning never emits it.
 *
 * A `project.delete` is planned only for projects that are empty then or are
 * emptied by this plan's own archive ops — and chained deletes only in a full
 * plan, never under `--only` (which promises nothing beyond the selection).
 * `strictOnly` (default true) refuses unknown `--only` ids at plan time;
 * rediscovery passes false so drift surfaces as a conflict instead.
 */
export function planCleanupOps(paseoState, { allowDestructive = false, allowIgnored = false, only = null, strictOnly = true, git = null, existsDir = defaultExistsDir } = {}) {
  const candidates = collectCleanupCandidates(paseoState, { git, existsDir });
  if (only?.length && strictOnly) {
    const known = new Set(candidates.map((c) => c.id));
    const unknown = [...new Set(only)].filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Unknown cleanup candidate id(s): ${unknown.join(', ')}; run cleanup without --plan to list them`);
  }
  const selected = only?.length ? candidates.filter((c) => only.includes(c.id)) : candidates;
  const agents = paseoState?.agents ?? [];
  const workspaces = paseoState?.workspaces ?? [];
  const projects = paseoState?.projects ?? [];
  const planned = [];
  const hints = [];

  for (const candidate of selected) {
    if (ARCHIVABLE_WORKSPACE_KINDS.has(candidate.kind) && workspaces.some((w) => w.id === candidate.id)) {
      const ws = workspaces.find((w) => w.id === candidate.id);
      if (candidate.kind === 'missing-directory' && isWorktreeWorkspace(ws)) {
        hints.push({ id: candidate.id, kind: candidate.kind, detail: candidate.detail, loss: candidate.loss, reason: 'manual: worktree directory is gone, git state unverifiable; restore it or remove the workspace in Paseo' });
      } else {
        const live = liveAgentsIn(agents, candidate.id).map((a) => a.id).sort();
        planned.push({
          key: `workspace.archive.${candidate.id}`, kind: 'workspace.archive',
          summary: `Archive ${candidate.kind} workspace ${candidate.id} (${candidate.detail})`,
          params: { workspaceId: candidate.id, agents: live, allowIgnored }, loss: candidate.loss,
        });
      }
    } else if (candidate.kind === 'empty-project') {
      const archived = archivedFor(paseoState, agents, workspaces, candidate.id);
      planned.push({
        key: `project.delete.${candidate.id}`, kind: 'project.delete',
        summary: `Delete empty project ${candidate.id}${candidate.path ? ` (${candidate.path})` : ''}${irreversibleSuffix(archived)}`,
        params: { projectId: candidate.id, archivedAgents: archived.map((a) => a.id).sort() }, loss: candidate.loss,
      });
    } else if (candidate.kind === 'duplicate-project-path') {
      hints.push({ id: candidate.id, kind: candidate.kind, detail: candidate.detail, loss: candidate.loss, reason: 'manual choice: keep one project, delete the rest outside the factory' });
    } else if (candidate.kind === 'non-git-no-scope') {
      hints.push({ id: candidate.id, kind: candidate.kind, detail: candidate.detail, loss: candidate.loss, reason: 'adopt a workspace as scope, or archive the workspaces first' });
    } else if (candidate.kind === 'scratch') {
      hints.push({ id: candidate.id, kind: candidate.kind, detail: candidate.detail, loss: candidate.loss, reason: 'S9b defines no agent.archive op; archive the agent in Paseo' });
    }
  }

  if (!only?.length) {
    const archivedByPlan = new Set(planned.filter((op) => op.kind === 'workspace.archive').map((op) => op.params.workspaceId));
    for (const project of projects) {
      const members = workspaces.filter((w) => w.projectId === project.projectId);
      if (!members.length || !members.every((w) => archivedByPlan.has(w.id))) continue;
      if (planned.some((op) => op.kind === 'project.delete' && op.params.projectId === project.projectId)) continue;
      const live = members.flatMap((w) => liveAgentsIn(agents, w.id));
      const archived = archivedFor(paseoState, agents, workspaces, project.projectId);
      planned.push({
        key: `project.delete.${project.projectId}`, kind: 'project.delete',
        summary: `Delete project ${project.projectId}, emptied by this plan${irreversibleSuffix(archived)}`,
        params: { projectId: project.projectId, archivedAgents: archived.map((a) => a.id).sort() },
        loss: {
          agents: live.length,
          running: live.filter((a) => BUSY.has(a.status)).length,
          worktree: members.some(isWorktreeWorkspace),
          git: gitInventory(git, project.projectRootPath),
          archivedAgents: { count: archived.length, first: archived.slice(0, 5) },
        },
      });
    }
  }
  const ops = [];
  for (const op of planned) {
    if (allowDestructive) ops.push(op);
    else hints.push({ id: op.params.workspaceId ?? op.params.projectId, kind: op.kind, detail: op.summary, loss: op.loss, reason: `needs --allow-destructive: ${op.summary}` });
  }
  return { ops, hints, candidates };
}

/**
 * True when an authorized cleanup op needs no execution anymore: its target
 * already shows the goal state. Anything else that vanishes from a fresh plan
 * is drift, not convergence, and must stop the run loudly.
 */
export function opConverged(op, paseoState) {
  const workspaces = paseoState?.workspaces ?? [];
  if (op.kind === 'workspace.archive') return !workspaces.some((w) => w.id === op.params.workspaceId);
  if (op.kind === 'project.delete') return !(paseoState?.projects ?? []).some((p) => p.projectId === op.params.projectId);
  if (op.kind === 'scope.retire') {
    const meta = workspaces.find((w) => w.id === op.params.workspaceId)?.metadata?.[METADATA_KEY];
    return meta?.retired === true && meta?.activeSteer == null;
  }
  return false;
}

/**
 * Builds the rediscovery function the hash-confirmed apply loop needs:
 * same `(entries, options) => plans` shape as the repository runner. Filters
 * come from the authorization entries (`{ cleanup: { allowDestructive,
 * allowIgnored, only } }`), so they survive the apply loop's option forwarding
 * untouched. Every
 * authorized op that is neither pending anymore nor verifiably converged
 * becomes a conflict, which stops the run instead of silently skipping it.
 */
export const CLEANUP_OP_KINDS = new Set(['workspace.archive', 'project.delete', 'scope.retire']);

/**
 * Plan-kind routing for apply: cleanup authorizations rediscover through the
 * cleanup planner, everything else through the given repository runner. A
 * repository authorization carrying cleanup ops is refused outright instead
 * of being misrouted. Either runner validates its own entries, so a cleanup
 * plan can never execute via the repo runner and back.
 */
export function selectApplyRunPlans(authorization, { repoRunPlans, client, git = null, existsDir = defaultExistsDir } = {}) {
  const hasCleanupOps = (authorization?.plans ?? []).some((plan) => (plan.ops ?? []).some((op) => CLEANUP_OP_KINDS.has(op.kind)));
  if (hasCleanupOps && authorization?.kind !== 'cleanup') {
    throw new Error('Authorization mixes a repository plan with cleanup ops; run a new dry-run');
  }
  if (authorization?.kind === 'cleanup') return createCleanupRunPlans(authorization, { client, git, existsDir });
  return repoRunPlans;
}

export function createCleanupRunPlans(authorization, { client, git = null, existsDir = defaultExistsDir } = {}) {
  const entry = authorization?.entries?.[0]?.cleanup ?? null;
  if (!entry || typeof entry !== 'object') throw new Error('Not a cleanup authorization (entries lack cleanup filters)');
  const filters = { allowDestructive: entry.allowDestructive === true, allowIgnored: entry.allowIgnored === true, only: entry.only ?? null, strictOnly: false, git, existsDir };
  const authorized = authorization?.plans?.[0] ?? null;
  if (!authorized || !Array.isArray(authorized.ops)) throw new Error('Cleanup authorization carries no plan');
  return async function runCleanupPlans() {
    const state = await attachProjectArchivedAgents(await readPaseoState(client), client);
    const { ops } = planCleanupOps(state, filters);
    const freshKeys = new Set(ops.map((op) => op.key));
    const conflicts = [];
    for (const op of authorized.ops) {
      if (freshKeys.has(op.key)) continue;
      if (!opConverged(op, state)) conflicts.push({ key: op.key, reason: `cleanup drift: ${op.summary}; replan` });
    }
    return [{ repo: authorized.repo ?? 'cleanup', input: 'cleanup', status: conflicts.length ? 'conflict' : ops.length ? 'pending' : 'complete', ops, conflicts, notes: [], observed: {} }];
  };
}
