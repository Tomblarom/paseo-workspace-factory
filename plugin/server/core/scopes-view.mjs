// Hub overview, read-only: one row per live scope plus adoption candidates.
// Pure functions over a Paseo state snapshot ({ workspaces, agents, projects }).
import { basename } from 'node:path';
import { listScopes } from './scope.mjs';
import { LABEL, METADATA_KEY, parentOf, restartMessage } from './paseo.mjs';
import { AGENTS_KEY } from './agent-state.mjs';
import { CHECKPOINT_KEY, agentUsage, isHeuristicRestart, restartInterruptions } from './steer.mjs';
import { isAdvisorSteer, providerIsSensitive } from './config.mjs';
import { applyContinuations, isWorktreeWorkspace, liveSlotHolders, resolveSteerHolders } from './discovery.mjs';

/** One row per live scope: id, kind, active steer, epoch, checkpoint, usage, hints. */
export function scopeRows(paseoState, { now = () => Date.now(), daemonStartedAt = null, lastTurnCheckpoints = null, config = null, zerosubSwitches = [] } = {}) {
  const agents = (paseoState?.agents ?? []).filter((agent) => !agent.archivedAt);
  const scopes = listScopes(paseoState);
  const liveIds = new Set(agents.map((agent) => agent.id));
  // Live continuation tabs inherit their origin's slot/scope labels (see
  // zerosub.mjs); the heuristic scan below runs over the resolved list so the
  // live tab — not the superseded origin — is checked, without duplicates.
  const resolvedAll = applyContinuations(agents, agents, zerosubSwitches);
  const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : null);
  const blockersOf = new Map(scopes.map((s) => {
    const blockers = s.workspace.metadata?.[CHECKPOINT_KEY]?.blockers;
    return [s.id, Array.isArray(blockers) ? blockers : []];
  }));
  return scopes.map((scope) => {
    const meta = scope.workspace.metadata?.[METADATA_KEY];
    const state = meta && typeof meta === 'object' ? meta : null;
    const checkpoint = scope.workspace.metadata?.[CHECKPOINT_KEY] ?? null;
    const agentState = scope.workspace.metadata?.[AGENTS_KEY] ?? null;
    // Slot holders follow the live continuation tab: origins in this workspace
    // are replaced by their live tab (which inherits role/slot), so the active
    // holder is the live tab and the origin never appears as a second holder.
    // Two live tabs titled for the active slot are ambiguous: no active holder.
    const labelledFound = agents.filter((a) => a.workspaceId === scope.workspaceId && a.labels?.[LABEL.role] === 'steer');
    const live = resolveSteerHolders(labelledFound, agents, zerosubSwitches).filter((a) => a && !a.archivedAt);
    const holders = liveSlotHolders(live, state?.activeSteer);
    const active = holders.length === 1 ? holders[0] : null;
    const updatedAt = checkpoint?.updatedAt ?? null;
    const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN;
    const ageMs = Number.isFinite(updatedMs) ? Math.max(0, now() - updatedMs) : null;
    const blockers = blockersOf.get(scope.id) ?? [];
    const marked = restartInterruptions({ checkpoint, agentState }).filter(({ agentId }) => liveIds.has(agentId));
    const markedIds = new Set(marked.map((m) => m.agentId));
    const heuristic = [];
    const checkpointAt = checkpoint?.capturedAt ?? checkpoint?.updatedAt ?? null;
    if (daemonStartedAt && lastTurnCheckpoints && typeof lastTurnCheckpoints === 'object' && checkpointAt) {
      for (const a of resolvedAll) {
        if (!a || a.archivedAt || markedIds.has(a.id)) continue;
        if (a.continuedFrom && markedIds.has(a.continuedFrom)) continue;
        const scopeId = a.labels?.[LABEL.scope];
        if (scopeId !== scope.id) continue;
        const role = a.labels?.[LABEL.role];
        if (role !== 'steer' && role !== 'worker') continue;
        if (isHeuristicRestart({ daemonStartedAt, checkpointAt, agentStatus: a.status, lastTurnHadCheckpoint: lastTurnCheckpoints[a.id] })) {
          heuristic.push({ agentId: a.id, reason: 'daemon-restart', at: null, heuristic: true });
        }
      }
      heuristic.sort((a, b) => a.agentId.localeCompare(b.agentId));
    }
    const restartInterrupted = [...marked, ...heuristic].sort((a, b) => a.agentId.localeCompare(b.agentId));
    const hints = [];
    const legacyAlias = (scope.kind === 'dir' || scope.kind === 'workspace') && scope.directory
      ? `local/${basename(scope.directory)}`
      : null;
    // Domain role: the pointer up (`domain`), the children down, and the inbox
    // of escalated blockers (`domain:` from direct children for a domain, all
    // `hub:` for the hub since `hub:` passes through the domain level).
    const domain = typeof scope.domain === 'string' && scope.domain ? scope.domain : null;
    const children = scopes.filter((s) => lower(s.domain) !== null && lower(s.domain) === lower(scope.id)).map((s) => s.id);
    const inbox = scope.kind === 'hub'
      ? scopes.filter((s) => lower(s.id) !== lower(scope.id)).flatMap((s) => (blockersOf.get(s.id) ?? []).filter((b) => typeof b === 'string' && b.startsWith('hub:')).map((b) => `${s.id}: ${b}`))
      : children.flatMap((id) => (blockersOf.get(id) ?? []).filter((b) => typeof b === 'string' && b.startsWith('domain:')).map((b) => `${id}: ${b}`));
    const activeSlot = active?.labels?.[LABEL.slot] ?? null;
    const warnings = [];
    if (config && active && activeSlot && isAdvisorSteer(config, active.labels, active.metadata)) {
      warnings.push(`Active steer ${activeSlot} is an advisor; advisors never coordinate`);
    }
    return {
      id: scope.id,
      kind: scope.kind,
      workspaceId: scope.workspaceId,
      domain,
      children,
      active: active ? { slot: active.labels[LABEL.slot], id: active.id, model: `${active.provider}/${active.model}`, status: active.status, ...(active.continuedFrom ? { continuedFrom: active.continuedFrom } : {}), ...(config ? { advisor: isAdvisorSteer(config, active.labels, active.metadata), sensitive: providerIsSensitive(config, active.provider) } : {}) } : null,
      ...(config ? { warnings } : {}),
      epoch: state?.epoch ?? null,
      checkpoint: checkpoint?.task
        ? {
          updatedAt, ageMs, next: checkpoint.next ?? null,
          escalations: blockers.filter((b) => typeof b === 'string' && b.startsWith('hub:')),
          domainEscalations: blockers.filter((b) => typeof b === 'string' && b.startsWith('domain:')),
          ...(liveIds.has(checkpoint.interrupted?.agentId) ? { interrupted: checkpoint.interrupted } : {}),
        }
        : null,
      usage: agentUsage(active),
      ...(restartInterrupted.length ? { restartInterrupted } : {}),
      ...(inbox.length ? { inbox } : {}),
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
  // Grouped by domain: hubs first, then each domain with its children (two
  // levels: Hub → Domain → Kind), then the rest. Rows without a domain keep
  // their exact previous shape.
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  // Emission is keyed by workspace: multiple scoped workspaces can
  // share the scope id (the domain pointer is carried over),
  // and both rows — old and new — must print.
  const emitted = new Set();
  const ordered = [];
  const push = (row) => {
    if (row && !emitted.has(row.workspaceId)) {
      emitted.add(row.workspaceId);
      ordered.push(row);
    }
  };
  for (const row of rows.filter((r) => r.kind === 'hub')) push(row);
  for (const row of rows.filter((r) => r.kind !== 'hub' && (r.children ?? []).length)) {
    push(row);
    for (const childId of row.children) {
      const child = byId.get(childId.toLowerCase());
      push(child);
      for (const grandchildId of child?.children ?? []) push(byId.get(grandchildId.toLowerCase()));
    }
  }
  for (const row of rows) push(row);
  return ordered.map((row) => {
    const tags = `${row.active?.advisor ? ' [advisor]' : ''}${row.active?.sensitive ? ' [sensitive]' : ''}`;
    const continued = row.active?.continuedFrom ? ` continued-from ${row.active.continuedFrom}` : '';
    const parts = [
      `${row.id} [${row.kind}]`,
      row.active ? `steer ${row.active.slot} ${row.active.model}${tags}${continued}` : 'steer -',
      `epoch ${row.epoch ?? '-'}`,
      `cp ${formatAge(row.checkpoint?.ageMs ?? null)}`,
      `next: ${row.checkpoint?.next ? JSON.stringify(row.checkpoint.next) : '-'}`,
      `hub: ${row.checkpoint?.escalations?.length ? row.checkpoint.escalations.join('; ') : '-'}`,
    ];
    for (const w of row.warnings ?? []) parts.push(`! ${w}`);
    if (row.checkpoint?.domainEscalations?.length) parts.push(`domain: ${row.checkpoint.domainEscalations.join('; ')}`);
    if (row.inbox?.length) parts.push(`inbox: ${row.inbox.join('; ')}`);
    parts.push(`ctx ${formatUsage(row.usage)}`);
    if (row.domain) parts.push(`domain ${row.domain}`);
    if ((row.children ?? []).length) parts.push(`domain (${row.children.length} children)`);
    if (row.legacyAlias) parts.push(`alias ${row.legacyAlias} (deprecated)`);
    for (const hint of row.hints ?? []) parts.push(hint);
    for (const r of row.restartInterrupted ?? []) {
      parts.push(`! ${restartMessage(r.agentId)} (${r.reason}${r.heuristic ? ', vermutet' : ''})`);
    }
    return parts.join(' · ');
  }).join('\n');
}

/** Workspaces without factory metadata: adoption candidates with a plan suggestion. Read-only. */
export function scopeCandidates(paseoState, { factoryCmd = '/factory' } = {}) {
  const agents = (paseoState?.agents ?? []).filter((agent) => !agent.archivedAt);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const projects = new Map((paseoState?.projects ?? []).map((p) => [p.projectId, p]));
  return (paseoState?.workspaces ?? [])
    .filter((w) => !w.archivedAt && (!w.metadata?.[METADATA_KEY] || typeof w.metadata[METADATA_KEY] !== 'object'))
    .map((w) => {
      const live = agents.filter((a) => a.workspaceId === w.id && !a.archivedAt);
      const project = projects.get(w.projectId) ?? null;
      const worktree = isWorktreeWorkspace(w);
      const directory = w.workspaceDirectory ?? null;
      let directoryArg = directory;
      if (directory && !/^[\p{L}\p{N}/_.:-]+$/u.test(directory)) {
        directoryArg = factoryCmd === '/factory' ? JSON.stringify(directory) : `'${directory.replace(/'/g, "'\\''")}'`;
      }
      return {
        workspaceId: w.id,
        title: w.title ?? w.name ?? null,
        directory,
        projectKind: project?.kind ?? project?.projectKind ?? null,
        worktree,
        agents: live.map((a) => {
          const parent = parentOf(a) ? byId.get(parentOf(a)) : null;
          const scope = parent?.labels?.[LABEL.scope] ?? parent?.labels?.[LABEL.repo] ?? null;
          const slot = parent?.labels?.[LABEL.slot] ?? null;
          const hint = (parent && parent.labels?.[LABEL.role] === 'steer' && typeof scope === 'string' && scope && typeof slot === 'string' && slot)
            ? `Worker von ${scope} Steer ${slot}`
            : null;
          return { id: a.id, title: a.title ?? null, provider: a.provider ?? null, model: a.model ?? null, status: a.status ?? null, parentId: parentOf(a), ...(hint ? { hint } : {}) };
        }),
        suggestedPlan: worktree || !directory ? `${factoryCmd} plan workspace:${w.id}` : `${factoryCmd} plan --local ${directoryArg}`,
      };
    });
}

export function formatScopeCandidates(rows) {
  if (!rows.length) return '(no adoption candidates)';
  return rows.map((row) => {
    // Agent form matches the candidate hints in plan notes
    // (`<id> "<title>" (<provider>/<model>, <status>)`, plus `parent <id>`
    // and the `Worker von <scope> Steer <slot>` hint when the parent is a
    // labelled steer); a test pins it against describeParent() so neither drifts.
    const agents = row.agents.length
      ? row.agents.map((a) => `${a.id} "${a.title ?? a.id}" (${a.provider}/${a.model}, ${a.status})${a.parentId ? ` parent ${a.parentId}` : ''}${a.hint ? ` · ${a.hint}` : ''}`).join(', ')
      : 'none';
    return `${row.workspaceId} "${row.title ?? '(untitled)'}" ${row.directory ?? '(no directory)'} · project ${row.projectKind ?? '?'} · worktree ${row.worktree ? 'yes' : 'no'} · agents ${row.agents.length} (${agents}) · plan: ${row.suggestedPlan}`;
  }).join('\n');
}

function formatStatusUsage(usage) {
  if (!usage) return 'ctx n/a';
  const pct = usage.maxTokens > 0 ? ` (${Math.round((usage.usedTokens / usage.maxTokens) * 100)}%)` : '';
  return `ctx ${usage.usedTokens}/${usage.maxTokens}${pct}`;
}

/** Human-readable `status` output: checkpoint, steers, workers, warnings. */
export function formatStatus(status, warnContextTokens) {
  const domain = status.domain ? ` · domain ${status.domain}` : '';
  const children = (status.domainChildren ?? []).length ? ` · domain of ${status.domainChildren.length} (${status.domainChildren.join(', ')})` : '';
  const lines = [`${status.repo} · workspace ${status.workspace?.id ?? '(none)'}${status.worktree ? ' (worktree)' : ''} · active Steer ${status.state?.activeSteer ?? '-'} (epoch ${status.state?.epoch ?? '-'})${domain}${children}`];
  const cp = status.checkpoint;
  if (cp?.task) {
    const stale = cp.epoch !== status.state?.epoch ? ` · from epoch ${cp.epoch}, older than the current one` : '';
    lines.push(`  checkpoint ${cp.updatedAt}${stale}`, `    task: ${cp.task}`);
    if (cp.next) lines.push(`    next: ${cp.next}`);
    if (cp.source === 'failover' && cp.failover) lines.push(`    failover from ${cp.failover.previousSteer ?? '?'}: ${cp.failover.reason ?? 'no reason recorded'}`);
    if (cp.interrupted) lines.push(typeof cp.interrupted === 'object' ? `    ! interrupted: ${cp.interrupted.agentId ?? 'unknown agent'} at ${cp.interrupted.at ?? 'unknown time'} — run resume for the last answer tail` : '    ! interrupted — run resume for details');
  } else {
    lines.push('  checkpoint: none');
  }
  for (const r of status.restartInterrupted ?? []) {
    lines.push(`  ! ${restartMessage(r.agentId)} (${r.reason}${r.heuristic ? ', vermutet' : ''})`);
  }
  for (const w of status.warnings ?? []) lines.push(`  ! ${w}`);
  for (const s of status.steers) {
    const tags = `${s.advisor ? ' [advisor]' : ''}${s.sensitive ? ' [sensitive]' : ''}`;
    lines.push(`  Steer ${s.slot}${tags}  ${s.id}  ${s.provider}/${s.model}  ${s.status}  ${formatStatusUsage(s.usage)}${s.continuedFrom ? `  continued-from ${s.continuedFrom}` : ''}${s.parent ? `  PARENT ${s.parent}` : ''}${s.quota ? ` · quota: ${s.quota}` : ''}`);
  }
  for (const c of status.candidates ?? []) lines.push(`  candidate "${c.title}" ${c.id} ${c.provider}/${c.model} ${c.status}  ${formatStatusUsage(c.usage)} → adopt with --adopt ${c.slot ?? '<slot>'}=${c.id}${c.parent ? ` (has parent ${c.parent}; needs --detach)` : ''}`);
  const supervised = new Map((status.openWorkers ?? []).map((e) => [e.id, e]));
  for (const w of status.workers) lines.push(`  worker ${w.id} "${w.title}" ${w.provider}/${w.model} ${w.status}  ${formatStatusUsage(w.usage)}${(w.parentSlot ?? w.owner) ? ` ← Steer ${w.parentSlot ?? w.owner}` : w.parentCandidate ? ` ← candidate "${w.parentCandidate.title}" ${w.parentCandidate.id}` : ' ← Steer ?'}${w.workspaceId && status.workspace && w.workspaceId !== status.workspace.id ? ` · workspace ${w.workspaceId}` : ''}${w.continuedFrom ? ` · continued-from ${w.continuedFrom}` : ''}${supervised.has(w.id) ? ` · supervised ${supervised.get(w.id).state}` : ''}`);
  for (const e of (status.openWorkers ?? []).filter((entry) => !status.workers.some((w) => w.id === entry.id))) lines.push(`  worker ${e.id} (agent not live) · supervised ${e.state} "${(e.task ?? '').slice(0, 120)}"`);
  for (const warn of status.usageWarnings ?? []) {
    lines.push(warn.kind === 'steer'
      ? `  ! Steer ${warn.slot} context ${warn.usedTokens}/${warn.maxTokens} tokens exceeds usage.warnContextTokens=${warnContextTokens}; consider checkpoint + switch/fresh (docs/saving-context.md)`
      : `  ! worker ${warn.id} context ${warn.usedTokens}/${warn.maxTokens} tokens exceeds usage.warnContextTokens=${warnContextTokens}; consider retiring and recreating it`);
  }
  return lines.join('\n');
}
