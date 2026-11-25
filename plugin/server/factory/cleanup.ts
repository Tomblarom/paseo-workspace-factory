// @ts-nocheck
// GENERATED from src/cleanup.mjs by npm run plugin:sync. Do not edit.
// Read-only scope health report (S9a): candidate scopes, workspaces and
// projects with a loss inventory each. It never writes; every suggested
// action names the native Paseo command that performs it (`paseo archive`,
// `paseo workspace archive`, `paseo project delete`).
import { statSync } from 'node:fs';
import { METADATA_KEY } from './paseo.js';
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
        action: 'archive the scratch agent natively (`paseo archive <agent-id>`)',
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
      'archive the scratch workspace natively (`paseo workspace archive <workspace-id>`)');
  }

  // Workspaces whose directory is gone: nothing on disk is at risk anymore.
  for (const ws of workspaces) {
    if (ws.workspaceDirectory && !existsDir(ws.workspaceDirectory)) {
      workspaceCandidate('missing-directory', ws, `directory ${ws.workspaceDirectory} is gone`, 'archive the workspace natively (`paseo workspace archive <workspace-id>`); no files at risk');
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
      detail: 'project without workspaces', action: 'delete the project natively (`paseo project delete <project-id>`)',
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
      action: 'manual choice: keep one project, delete the rest natively (`paseo project delete <project-id>`)',
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
      detail: `${members.length} workspace(s), none is a factory scope`, action: 'adopt a workspace as scope, or archive the workspaces natively (`paseo workspace archive <workspace-id>`)',
      loss: projectLoss(members, project.projectRootPath, [project.projectId]),
    });
  }

  // Retired factory scopes (marked retired, historically with movedTo).
  for (const scope of listScopes(paseoState ?? {})) {
    const meta = scope.workspace?.metadata?.[METADATA_KEY];
    if (meta?.retired !== true) continue;
    const ws = byWorkspaceId.get(scope.workspaceId) ?? scope.workspace;
    if (!ws) continue;
    workspaceCandidate('retired-scope', ws,
      meta.movedTo ? `retired scope, moved to ${meta.movedTo}` : 'retired scope',
      'archive the retired scope workspace natively (`paseo workspace archive <workspace-id>`)');
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

/** One compact line per candidate. */
export function formatCandidate(candidate) {
  const head = candidate.title ? `${candidate.kind} ${candidate.id} "${candidate.title}"` : `${candidate.kind} ${candidate.id}`;
  const where = candidate.path ? ` ${candidate.path}` : '';
  return `${head}${where} · ${candidate.detail} · ${formatLoss(candidate.loss)} · → ${candidate.action}`;
}
