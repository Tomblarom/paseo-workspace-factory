// @ts-nocheck
// GENERATED from src/scopes-view.mjs by npm run plugin:sync. Do not edit.
// Hub overview, read-only: one row per live scope plus adoption candidates.
// Pure functions over a Paseo state snapshot ({ workspaces, agents, projects }).
import { basename } from 'node:path';
import { listScopes } from './scope.js';
import { LABEL, METADATA_KEY, parentOf } from './paseo.js';
import { CHECKPOINT_KEY, agentUsage } from './steer.js';
import { isWorktreeWorkspace } from './discovery.js';

/** One row per live scope: id, kind, active steer, epoch, checkpoint, usage, hints. */
export function scopeRows(paseoState, { now = () => Date.now() } = {}) {
  const agents = paseoState?.agents ?? [];
  return listScopes(paseoState).map((scope) => {
    const meta = scope.workspace.metadata?.[METADATA_KEY];
    const state = meta && typeof meta === 'object' ? meta : null;
    const checkpoint = scope.workspace.metadata?.[CHECKPOINT_KEY] ?? null;
    const live = agents.filter((a) => a.workspaceId === scope.workspaceId && !a.archivedAt && a.labels?.[LABEL.role] === 'steer');
    const active = live.find((a) => a.labels?.[LABEL.slot] === state?.activeSteer) ?? null;
    const updatedAt = checkpoint?.updatedAt ?? null;
    const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN;
    const ageMs = Number.isFinite(updatedMs) ? Math.max(0, now() - updatedMs) : null;
    const blockers = Array.isArray(checkpoint?.blockers) ? checkpoint.blockers : [];
    const hints = [];
    if (scope.workspace.legacyPrefix || live.some((a) => a.legacyPrefix)) hints.push('legacy-prefix');
    const legacyAlias = (scope.kind === 'dir' || scope.kind === 'workspace') && scope.directory
      ? `local/${basename(scope.directory)}`
      : null;
    return {
      id: scope.id,
      kind: scope.kind,
      workspaceId: scope.workspaceId,
      active: active ? { slot: active.labels[LABEL.slot], id: active.id, model: `${active.provider}/${active.model}`, status: active.status } : null,
      epoch: state?.epoch ?? null,
      checkpoint: checkpoint?.task
        ? { updatedAt, ageMs, next: checkpoint.next ?? null, escalations: blockers.filter((b) => typeof b === 'string' && b.startsWith('hub:')) }
        : null,
      usage: agentUsage(active),
      ...(legacyAlias ? { legacyAlias } : {}),
      ...(hints.length ? { hints } : {}),
    };
  });
}

function formatAge(ageMs) {
  if (ageMs === null || ageMs === undefined) return 'none';
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatUsage(usage) {
  if (!usage) return 'n/a';
  const pct = usage.maxTokens > 0 ? ` (${Math.round((usage.usedTokens / usage.maxTokens) * 100)}%)` : '';
  return `${usage.usedTokens}/${usage.maxTokens}${pct}`;
}

export function formatScopeRows(rows) {
  if (!rows.length) return '(no live scopes)';
  return rows.map((row) => {
    const parts = [
      `${row.id} [${row.kind}]`,
      row.active ? `steer ${row.active.slot} ${row.active.model}` : 'steer -',
      `epoch ${row.epoch ?? '-'}`,
      `cp ${formatAge(row.checkpoint?.ageMs ?? null)}`,
      `next: ${row.checkpoint?.next ? JSON.stringify(row.checkpoint.next) : '-'}`,
      `hub: ${row.checkpoint?.escalations?.length ? row.checkpoint.escalations.join('; ') : '-'}`,
      `ctx ${formatUsage(row.usage)}`,
    ];
    if (row.legacyAlias) parts.push(`alias ${row.legacyAlias} (deprecated)`);
    for (const hint of row.hints ?? []) parts.push(hint === 'legacy-prefix' ? 'uses ari.wsf keys (legacy-prefix)' : hint);
    return parts.join(' · ');
  }).join('\n');
}

/** Workspaces without factory metadata: adoption candidates with a plan suggestion. Read-only. */
export function scopeCandidates(paseoState) {
  const agents = paseoState?.agents ?? [];
  const projects = new Map((paseoState?.projects ?? []).map((p) => [p.projectId, p]));
  return (paseoState?.workspaces ?? [])
    .filter((w) => !w.archivedAt && (!w.metadata?.[METADATA_KEY] || typeof w.metadata[METADATA_KEY] !== 'object'))
    .map((w) => {
      const live = agents.filter((a) => a.workspaceId === w.id && !a.archivedAt);
      const project = projects.get(w.projectId) ?? null;
      const worktree = isWorktreeWorkspace(w);
      const directory = w.workspaceDirectory ?? null;
      return {
        workspaceId: w.id,
        title: w.title ?? w.name ?? null,
        directory,
        projectKind: project?.kind ?? project?.projectKind ?? null,
        worktree,
        agents: live.map((a) => ({ id: a.id, title: a.title ?? null, provider: a.provider ?? null, model: a.model ?? null, parent: parentOf(a) !== null })),
        suggestedPlan: worktree || !directory ? `paseo-factory plan workspace:${w.id}` : `paseo-factory plan --local ${directory}`,
      };
    });
}

export function formatScopeCandidates(rows) {
  if (!rows.length) return '(no adoption candidates)';
  return rows.map((row) => {
    const agents = row.agents.length
      ? row.agents.map((a) => `"${a.title ?? a.id}" ${a.provider}/${a.model}${a.parent ? ' parent' : ''}`).join(', ')
      : 'none';
    return `${row.workspaceId} "${row.title ?? '(untitled)'}" ${row.directory ?? '(no directory)'} · project ${row.projectKind ?? '?'} · worktree ${row.worktree ? 'yes' : 'no'} · agents ${row.agents.length} (${agents}) · plan: ${row.suggestedPlan}`;
  }).join('\n');
}
