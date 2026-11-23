// Pure planner: discovery + config -> ordered operations, conflicts and notes.
// Operations carry stable keys; apply only executes keys confirmed in a dry-run.
import { createHash } from 'node:crypto';
import { slotProfile, validateProfilesAgainstCatalog } from './config.mjs';
import { LABEL, METADATA_KEY, parentOf, pendingLegacyKeys } from './paseo.mjs';
import { STEER_TITLE } from './discovery.mjs';
import { validScope } from './scope.mjs';

export const WORKSPACE_REF = { ref: 'main-workspace' };

export function idempotencyKey(forkName, ...parts) {
  return ['wsf', forkName.toLowerCase(), ...parts].join(':');
}

/** Short digest of a create request: the daemon rejects a reused key with a different request. */
export function requestDigest(request) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 10);
}

function agentConfig(profile) {
  return {
    provider: `${profile.provider}/${profile.model}`,
    ...(profile.mode ? { modeId: profile.mode } : {}),
    ...(profile.thinking ? { thinkingOptionId: profile.thinking } : {}),
  };
}

function steerLabels(scopeId, slot) {
  return { [LABEL.repo]: scopeId, [LABEL.role]: 'steer', [LABEL.slot]: slot, [LABEL.scope]: scopeId };
}

/**
 * Renders the workspaceTitle template: {name} is the scope short form (the
 * repo name for github, else the scope id), {subject} the entry subject.
 * Returns { title } or { error } (missing subject, unknown placeholder).
 */
export function renderWorkspaceTitle(template, scopeId, subject) {
  const name = scopeId.includes('/') ? scopeId.slice(scopeId.lastIndexOf('/') + 1) : scopeId;
  let title = template.replaceAll('{name}', name);
  if (template.includes('{subject}')) {
    if (!subject) return { error: 'workspaceTitle template needs {subject}; pass --subject <text> (or per-entry "subject")' };
    title = title.replaceAll('{subject}', subject);
  }
  const unknown = title.match(/\{[^}]+\}/);
  if (unknown) return { error: `workspaceTitle template has unknown placeholder ${unknown[0]} (supported: {name}, {subject})` };
  return { title };
}

export function planRepository(discovery, config, { allowFork = false, adopt = {}, slots, adoptWorker = {}, detach = false, retitle = false, renameProject = null } = {}) {
  const ops = [];
  const conflicts = [];
  const notes = [...(discovery.github?.notes ?? [])];
  const add = (key, kind, summary, params = {}) => ops.push({ key, kind, summary, params });
  const conflict = (key, reason) => conflicts.push({ key, reason });
  const { github, forkName } = discovery;
  const isLocal = Boolean(discovery.local) || github?.local === true || github?.fork?.status === 'local';
  const isWorktree = Boolean(discovery.worktree);

  // Per-run slot selection (--slots overrides prepare; subset of defined slots).
  let effectivePrepare = config.steers.prepare;
  let effectiveInitialActive = config.steers.initialActive;
  if (slots !== undefined) {
    for (const slot of slots) {
      if (!config.steers.slots[slot]) conflict(`steer.${slot}`, `--slots names slot ${slot}, which is not defined in steers.slots`);
    }
    effectivePrepare = [...new Set(slots.filter((s) => config.steers.slots[s]))];
    if (effectivePrepare.length && !effectivePrepare.includes(effectiveInitialActive)) {
      effectiveInitialActive = effectivePrepare[0];
    }
  }

  // Adopting a defined slot outside prepare plans only the adopted slots,
  // not the whole prepare list; the active steer must be one of them.
  const definedAdopts = Object.keys(adopt).filter((s) => config.steers.slots[s]);
  const adoptOutside = definedAdopts.some((s) => !effectivePrepare.includes(s));
  const slotsToPlan = adoptOutside ? definedAdopts : effectivePrepare;
  if (slotsToPlan.length && !slotsToPlan.includes(effectiveInitialActive)) effectiveInitialActive = slotsToPlan[0];

  // 1. GitHub fork (skipped in local mode: no gh, fork, clone or upstream remote)
  if (!isLocal) {
    if (github.fork.status === 'conflict') conflict('github.fork', github.fork.reason);
    else if (github.fork.status === 'missing') {
      if (allowFork) add('github.fork', 'github.fork', `Fork ${github.upstream.fullName} to ${github.fork.planned}`, { upstream: github.upstream.fullName, owner: config.github.owner });
      else conflict('github.fork', `Fork ${github.fork.planned} does not exist; rerun with --allow-fork to plan its creation`);
    } else if (github.fork.repo.archived) conflict('github.fork', `${forkName} is archived on GitHub`);
  }
  if (!forkName) return finish(discovery, config, ops, conflicts, notes);

  // 2. Checkout and project registration
  for (const issue of discovery.checkoutIssues) conflict('checkout', issue);
  if (discovery.checkoutIssues.length) return finish(discovery, config, ops, conflicts, notes);
  const willClone = !discovery.checkout && !discovery.checkoutIssues.length;
  if (isLocal && willClone) {
    conflict('checkout', `Local path ${discovery.expectedPath} is not available; it must exist as a directory`);
    return finish(discovery, config, ops, conflicts, notes);
  }
  if (willClone) {
    const target = discovery.cloneTarget;
    if (!target?.ok) {
      conflict('checkout', `Cannot clone ${forkName} to ${discovery.expectedPath}: ${target?.reason ?? 'target not inspected'}`);
      return finish(discovery, config, ops, conflicts, notes);
    }
    add('checkout.clone', 'paseo.clone', `Clone ${forkName} to ${discovery.expectedPath} and register the Paseo project`, {
      repo: forkName, parentDir: discovery.parentDir, protocol: config.github.cloneProtocol, expectedPath: discovery.expectedPath,
      guard: { root: target.root, anchor: target.anchor, anchorId: target.anchorId },
    });
    // The daemon registers the project during clone; if that half fails, registering it is the recovery.
    ops.at(-1).implies = [{ key: 'paseo.project', kind: 'paseo.project.add', summary: `Register ${discovery.expectedPath} as Paseo project`, params: { path: discovery.expectedPath } }];
  }
  for (const related of discovery.relatedCheckouts) {
    notes.push(`Related checkout left untouched: ${related.path} (${Object.entries(related.remotes).map(([n, u]) => `${n}=${u}`).join(', ')})`);
  }
  const checkoutPath = discovery.checkout?.path ?? discovery.expectedPath;

  if (!isLocal && github?.upstream) {
    const status = willClone ? 'missing' : discovery.upstreamRemote?.status;
    if (status === 'missing') {
      add('checkout.upstream-remote', 'git.remote.add', `Add remote ${config.github.upstreamRemote} -> ${github.upstream.fullName}`, {
        path: checkoutPath, origin: forkName, name: config.github.upstreamRemote,
        url: config.github.cloneProtocol === 'ssh' ? github.upstream.sshUrl : github.upstream.cloneUrl,
      });
    } else if (status === 'mismatch') {
      conflict('checkout.upstream-remote', `Remote ${config.github.upstreamRemote} in ${checkoutPath} points to ${discovery.upstreamRemote.url}, expected ${github.upstream.fullName}`);
    }
  }
  // A worktree workspace already belongs to its Paseo project; adopting it
  // never registers a new project, even when the project list is empty.
  if (!isWorktree) {
    if (discovery.checkout && !discovery.projects.length) {
      add('paseo.project', 'paseo.project.add', `Register ${checkoutPath} as Paseo project`, { path: checkoutPath });
    } else if (discovery.projects.length > 1) {
      conflict('paseo.project', `Checkout belongs to several Paseo projects: ${discovery.projects.map((p) => p.projectId).join(', ')}`);
    }
  }
  // Optional project rename: only with --rename-project, only onto exactly one
  // existing project (a missing registration runs first, in a run of its own).
  if (renameProject) {
    if (discovery.projects.length === 1 && discovery.projects[0].projectDisplayName !== renameProject) {
      add('project.rename', 'paseo.project.rename', `Rename Paseo project ${discovery.projects[0].projectId} to ${JSON.stringify(renameProject)}`, {
        projectId: discovery.projects[0].projectId, name: renameProject,
      });
    } else if (!discovery.projects.length) {
      conflict('project.rename', `--rename-project ${JSON.stringify(renameProject)}: no Paseo project for ${checkoutPath} yet; register it first`);
    } else if (discovery.projects.length > 1) {
      conflict('project.rename', `--rename-project ${JSON.stringify(renameProject)}: several Paseo projects for ${checkoutPath}, ambiguous`);
    }
  }

  // 2b. Scope identity. The scope id (discovery.scope) names everything the
  // plan writes; collisions with a live scope (or a sibling entry of this run)
  // are conflicts resolved with --name. Without scope data (legacy callers)
  // these checks are skipped.
  const plannedScope = discovery.scope ?? null;
  if (!isLocal && discovery.requestedName) {
    conflict('scope.name', `--name ${JSON.stringify(discovery.requestedName)} is only supported for dir/workspace scopes, not for github ${forkName ?? discovery.input}`);
  }
  if (!isLocal && discovery.requestedHub) {
    conflict('scope.hub', `--hub is only supported for dir/workspace entries, not for github ${forkName ?? discovery.input}`);
  }
  let main = discovery.mainWorkspace;
  const stored = main && validScope(main.metadata?.[METADATA_KEY]?.scope) ? main.metadata[METADATA_KEY].scope : null;
  const convertingToHub = plannedScope?.kind === 'hub' && (!stored || stored.kind !== 'hub' || stored.id !== plannedScope.id);
  if (plannedScope && stored && stored.id !== plannedScope.id && !convertingToHub) {
    conflict('workspace.main.scope', `Workspace ${main.id} is scoped ${JSON.stringify(stored.id)} (${stored.kind}), but this entry plans scope ${JSON.stringify(plannedScope.id)}; adopt it under its own address instead`);
  }
  if (plannedScope && main?.id) {
    const clash = (discovery.liveScopes ?? []).find((s) => s.id === plannedScope.id && s.workspaceId !== main.id);
    if (clash) {
      conflict('scope.id', `Scope id ${JSON.stringify(plannedScope.id)} is already used by workspace ${clash.workspaceId} (${clash.kind}); rerun with --name <id> or a per-entry "name"`);
    }
  } else if (plannedScope) {
    const clash = (discovery.liveScopes ?? []).find((s) => s.id === plannedScope.id);
    if (clash) {
      conflict('scope.id', `Scope id ${JSON.stringify(plannedScope.id)} is already used by workspace ${clash.workspaceId} (${clash.kind}); rerun with --name <id> or a per-entry "name"`);
    }
  }
  const siblings = discovery.siblingScopes ?? (discovery.siblingScopeIds ?? []).map((id) => ({ id, kind: null }));
  if (plannedScope && siblings.some((s) => s.id === plannedScope.id)) {
    conflict('scope.id', `Several entries in this run plan scope id ${JSON.stringify(plannedScope.id)}; give each a distinct --name (or per-entry "name")`);
  }
  // At most one hub scope lives on a host: neither beside a live hub nor
  // beside a second hub entry of this run.
  if (plannedScope?.kind === 'hub') {
    const liveHub = (discovery.liveScopes ?? []).find((s) => s.kind === 'hub' && s.workspaceId !== main?.id);
    if (liveHub) {
      conflict('scope.hub', `Hub scope ${JSON.stringify(liveHub.id)} already lives on workspace ${liveHub.workspaceId}; at most one hub per host`);
    } else if (siblings.some((s) => s.kind === 'hub')) {
      conflict('scope.hub', 'Several entries in this run plan a hub scope; at most one hub per host');
    }
  }
  // Labels and metadata use the stored id when one exists, else the planned one;
  // a hub conversion already labels new steers with the planned hub id.
  const effScopeId = convertingToHub ? plannedScope.id : (stored?.id ?? plannedScope?.id ?? forkName);
  // Expected main title from the workspaceTitle template (S8). Without a
  // renderable title no title op or note is planned; the conflict blocks apply.
  const rendered = renderWorkspaceTitle(config.workspaceTitle, effScopeId, discovery.requestedSubject ?? null);
  if (rendered.error) conflict('workspace.title', rendered.error);
  const expectedTitle = rendered.title ?? null;

  // 3. Main workspace
  const initial = plannedScope
    ? { main: true, activeSteer: effectiveInitialActive, epoch: 1, scope: { id: plannedScope.id, kind: plannedScope.kind, locator: plannedScope.locator, ...(plannedScope.parent !== undefined ? { parent: plannedScope.parent } : {}) } }
    : { main: true, activeSteer: effectiveInitialActive, epoch: 1 };
  if (discovery.mainCandidates.length > 1 && !main) {
    conflict('workspace.main', `Several main workspaces use ${checkoutPath}: ${discovery.mainCandidates.map((w) => `${w.id} "${w.title ?? w.name}"`).join(', ')}`);
  } else if (!main) {
    if (expectedTitle !== null) {
      add('workspace.main', 'paseo.workspace.create', `Create local workspace "${expectedTitle}" for ${checkoutPath}`, {
        path: checkoutPath, title: expectedTitle, metadata: { [METADATA_KEY]: initial },
        idempotencyKey: idempotencyKey(forkName, 'workspace', 'main', requestDigest({ path: checkoutPath, title: expectedTitle, metadata: initial })),
      });
    }
  } else {
    const state = main.metadata?.[METADATA_KEY];
    if (!state) {
      const summary = isWorktree
        ? `Adopt worktree workspace ${main.id} "${main.title ?? main.name}" as factory main workspace (no new project or workspace)`
        : `Mark existing workspace ${main.id} "${main.title ?? main.name}" as factory main workspace`;
      add('workspace.main.adopt', 'paseo.workspace.metadata', summary, {
        workspaceId: main.id, metadata: { [METADATA_KEY]: initial },
      });
    } else if (state.retired === true) {
      conflict('workspace.main', `Scope in workspace ${main.id} is retired, movedTo ${state.movedTo ?? '(unknown)'}; use the successor scope instead of planning here`);
    } else if (!config.steers.slots[state.activeSteer]) {
      conflict('workspace.main', `Workspace ${main.id} names unknown active steer "${state.activeSteer}"`);
    }
  }
  if (discovery.otherLocalWorkspaces?.length) {
    notes.push(`Other local workspaces on this checkout stay untouched: ${discovery.otherLocalWorkspaces.map((w) => `${w.id} "${w.title ?? w.name}"`).join(', ')}`);
  }
  const workspaceId = main?.id ?? WORKSPACE_REF;

  // 3b. Legacy prefix migration: `ari.wsf*` keys are still read, but new state
  // uses `wsf*`. One op rewrites the main workspace metadata (old keys are
  // removed); one op per agent rewrites its labels (old labels linger: Paseo
  // cannot remove agent labels). Stored `legacyPending` wins over a recomputed
  // check: normalization adds inferred new keys that were never persisted.
  const pendingOf = (record, field) => record?.legacyPending ?? pendingLegacyKeys(record?.[field]);
  if (main && pendingOf(main, 'metadata').length) {
    add('labels.migrate.workspace', 'labels.migrate', `Rewrite legacy ari.wsf metadata keys of workspace ${main.id} to wsf.*`, {
      target: 'workspace', workspaceId: main.id, migrate: [...pendingOf(main, 'metadata')],
    });
  }
  const seenAgents = new Set();
  for (const agent of [...discovery.steers.labelled.filter((a) => !a.archivedAt), ...discovery.workers]) {
    if (seenAgents.has(agent.id)) continue;
    seenAgents.add(agent.id);
    if (!pendingOf(agent, 'labels').length) continue;
    add(`labels.migrate.agent.${agent.id}`, 'labels.migrate', `Rewrite legacy ari.wsf labels of agent ${agent.id} to wsf.*`, {
      target: 'agent', agentId: agent.id, migrate: [...pendingOf(agent, 'labels')],
    });
  }

  // 3c. Scope supplement: an existing main workspace without a scope field gets
  // a non-destructive top-up (other metadata untouched, verified after write).
  // Planned after the prefix migration so the supplement lands on migrated keys.
  const stateNow = main?.metadata?.[METADATA_KEY];
  if (main && plannedScope && stateNow && !validScope(stateNow.scope) && plannedScope.kind !== 'hub') {
    add('workspace.main.scope', 'paseo.workspace.scope', `Record scope ${JSON.stringify(plannedScope.id)} (${plannedScope.kind}) on workspace ${main.id} (other metadata untouched)`, {
      workspaceId: main.id, scope: initial.scope,
    });
  }

  // 3c-hub. dir→hub conversion rewrites only the scope field (steers, epoch and
  // checkpoint untouched); other stored kinds never convert implicitly.
  if (main && stateNow && plannedScope?.kind === 'hub' && convertingToHub) {
    if (stored && stored.kind !== 'hub' && stored.kind !== 'dir') {
      conflict('scope.convert', `Cannot convert ${stored.kind} scope ${JSON.stringify(stored.id)} on workspace ${main.id} to hub; only dir scopes convert`);
    } else {
      add('scope.convert', 'scope.convert', `Convert scope ${JSON.stringify(stored?.id ?? plannedScope.id)} on workspace ${main.id} to kind hub (steers, epoch and checkpoint untouched)`, {
        workspaceId: main.id, scope: { id: plannedScope.id, kind: 'hub', locator: plannedScope.locator },
      });
    }
  }

  // 3d. Title: a main workspace deviating from the rendered template is renamed
  // only with --retitle (native workspace rename), otherwise just reported.
  if (main && expectedTitle !== null && (main.title ?? main.name) !== expectedTitle) {
    if (retitle) {
      add('workspace.retitle', 'paseo.workspace.retitle', `Rename workspace ${main.id} from "${main.title ?? main.name}" to "${expectedTitle}"`, {
        workspaceId: main.id, from: main.title ?? main.name, title: expectedTitle,
      });
    } else {
      notes.push(`Workspace ${main.id} is titled "${main.title ?? main.name}"; template expects "${expectedTitle}" (rerun with --retitle to plan a rename)`);
    }
  }

  // 4. Steer slots
  for (const slot of Object.keys(adopt)) {
    if (!config.steers.slots[slot]) conflict(`steer.${slot}`, `--adopt names slot ${slot}, which is not defined in steers.slots`);
  }
  const catalogProblems = validateProfilesAgainstCatalog(config, discovery.providers, new Set(slotsToPlan.map((slot) => config.steers.slots[slot])));
  // Retired scopes keep their conflict above and plan no steers at all.
  const scopeRetired = main?.metadata?.[METADATA_KEY]?.retired === true;
  for (const slot of (scopeRetired ? [] : slotsToPlan)) {
    const key = `steer.${slot}`;
    const profile = slotProfile(config, slot);
    const labelled = discovery.steers.labelled.filter((a) => a.labels[LABEL.slot] === slot);
    const live = labelled.filter((a) => !a.archivedAt);
    const legacy = discovery.steers.legacy.filter((a) => (a.title ?? '').trim().match(STEER_TITLE)[1] === slot);

    if (live.length > 1) {
      conflict(key, `Several agents are labelled as Steer ${slot}: ${live.map((a) => a.id).join(', ')}`);
      continue;
    }
    if (live.length === 1) {
      const existing = live[0];
      const parent = parentOf(existing);
      if (adopt[slot] && adopt[slot] !== existing.id) conflict(key, `--adopt ${slot}=${adopt[slot]} conflicts with the already labelled Steer ${slot} ${existing.id}`);
      else if (parent) conflict(key, `Steer ${slot} (${existing.id}) has parent ${parent}; detach it in Paseo or archive it before the factory can use the slot`);
      else if (main && existing.workspaceId !== main.id) conflict(key, `Steer ${slot} (${existing.id}) lives in workspace ${existing.workspaceId}, not in main workspace ${main.id}`);
      else if (existing.provider !== profile.provider || existing.model !== profile.model) {
        notes.push(`Steer ${slot} runs ${existing.provider}/${existing.model}; config profile "${profile.name}" names ${profile.provider}/${profile.model} (kept, no recreation)`);
      }
      continue;
    }

    // Unlabelled agents titled "Steer X" are only candidates. Adoption needs an
    // explicit --adopt X=<agent-id> and is refused when anything is ambiguous.
    const confirmedId = adopt[slot] ?? null;
    if (legacy.length || confirmedId) {
      const describe = (a) => `${a.id} (${a.provider}/${a.model}, ${a.status})`;
      if (legacy.length > 1) {
        conflict(key, `Several unlabelled "Steer ${slot}" candidates in the main workspace: ${legacy.map(describe).join(', ')}; resolve manually`);
      } else if (!confirmedId) {
        const candidate = legacy[0];
        const parent = parentOf(candidate);
        conflict(key, parent
          ? `Candidate "Steer ${slot}" ${candidate.id} has parent ${parent}; it cannot become a steer — confirm with --adopt ${slot}=${candidate.id} plus --detach to plan a native detach first`
          : `Unlabelled candidate "Steer ${slot}" ${describe(candidate)}; confirm with --adopt ${slot}=${candidate.id} or rename/archive it`);
      } else if (!legacy.some((a) => a.id === confirmedId)) {
        conflict(key, `--adopt ${slot}=${confirmedId} does not name the unlabelled "Steer ${slot}" candidate in the main workspace`);
      } else {
        const candidate = legacy[0];
        const currentParent = parentOf(candidate);
        if (currentParent && !detach) {
          conflict(key, `Candidate ${confirmedId} has parent ${currentParent}; it cannot become a steer (rerun with --detach to plan a native detach first)`);
        } else {
          if (currentParent) {
            add(`${key}.detach`, 'agent.detach', `Detach candidate ${confirmedId} from parent ${currentParent} (native agent detach, verified after)`, { agentId: confirmedId, parent: currentParent });
          }
          add(key, 'paseo.agent.adopt', `Label confirmed agent ${candidate.id} as Steer ${slot} (title and model unchanged)`, { agentId: candidate.id, labels: steerLabels(effScopeId, slot) });
          if (candidate.provider !== profile.provider || candidate.model !== profile.model) {
            notes.push(`Adopted Steer ${slot} runs ${candidate.provider}/${candidate.model}; profile "${profile.name}" names ${profile.provider}/${profile.model} (kept)`);
          }
        }
      }
      continue;
    }
    if (catalogProblems[profile.name]) {
      conflict(key, `Profile "${profile.name}" for Steer ${slot} is not startable: ${catalogProblems[profile.name].join('; ')}`);
      continue;
    }
    const generation = labelled.length + 1; // archived steers of this slot get a fresh key
    const request = { workspaceId, title: `Steer ${slot}`, config: agentConfig(profile), labels: steerLabels(effScopeId, slot) };
    add(key, 'paseo.agent.create', `Create top-level Steer ${slot} (${profile.provider}/${profile.model}) without prompt`, {
      ...request, idempotencyKey: idempotencyKey(forkName, 'steer', slot, `g${generation}`, requestDigest(request)),
    });
  }

  // 4b. Worker adoption (--adopt-worker <id>[@<slot>]): label only, the agent
  // stays in its workspace (possibly a foreign one). Already-adopted workers
  // are reported; anything else labelled is a conflict, never reassigned.
  const defaultOwner = main?.metadata?.[METADATA_KEY]?.activeSteer ?? effectiveInitialActive;
  for (const [agentId, slot] of Object.entries(adoptWorker)) {
    const key = `worker.${agentId}`;
    const agent = (discovery.agents ?? []).find((a) => a.id === agentId) ?? null;
    if (!agent) {
      conflict(key, `--adopt-worker ${agentId}: agent not found`);
      continue;
    }
    if (agent.archivedAt) {
      conflict(key, `--adopt-worker ${agentId}: agent is archived`);
      continue;
    }
    if (slot && !config.steers.slots[slot]) {
      conflict(key, `--adopt-worker ${agentId}@${slot}: slot ${slot} is not defined in steers.slots`);
      continue;
    }
    const owner = slot ?? defaultOwner;
    const want = { [LABEL.scope]: effScopeId, [LABEL.role]: 'worker', [LABEL.owner]: owner };
    const role = agent.labels?.[LABEL.role];
    if (role === 'worker' && agent.labels?.[LABEL.scope] === effScopeId && agent.labels?.[LABEL.owner] === owner) {
      notes.push(`Worker ${agentId} "${agent.title}" is already adopted for Steer ${owner} (kept)`);
      continue;
    }
    if (role) {
      conflict(key, `--adopt-worker ${agentId}: agent is already labelled ${role}; reassignment is not automatic`);
      continue;
    }
    add(key, 'paseo.agent.worker', `Label agent ${agentId} "${agent.title ?? ''}" as worker of Steer ${owner} (stays in workspace ${agent.workspaceId})`, {
      agentId, workspaceId: agent.workspaceId, labels: want,
    });
  }

  if (discovery.workers.length) {
    notes.push(`Workers kept as they are: ${discovery.workers.map((w) => `${w.id} "${w.title}" (parent ${parentOf(w)})`).join(', ')}`);
  }
  // Existing agents of an adopted worktree workspace are only listed here for
  // reuse by id; the plan never renames or archives them.
  if (isWorktree && (discovery.worktreeAgents ?? []).length) {
    notes.push(`Existing worktree agents kept as they are (reuse by id, not renamed or archived): ${discovery.worktreeAgents.map((a) => `${a.id} "${a.title}" (${a.provider}/${a.model}, ${a.status})`).join(', ')}`);
  }
  return finish(discovery, config, ops, conflicts, notes);
}

function finish(discovery, config, ops, conflicts, notes) {
  const status = conflicts.length ? 'conflict' : ops.length ? 'pending' : 'complete';
  const main = discovery.mainWorkspace;
  // Observation only (not hashed): lets apply recover a workspace it created but could not record.
  const steers = Object.fromEntries((discovery.steers?.labelled ?? []).filter((a) => !a.archivedAt).map((a) => [a.labels[LABEL.slot], a.id]));
  const observed = { mainWorkspace: main ? { id: main.id, directory: main.workspaceDirectory, title: main.title ?? main.name, metadata: main.metadata ?? {}, createdAt: main.createdAt ?? null } : null, steers };
  return { repo: discovery.forkName ?? discovery.input, input: discovery.input, status, ops, conflicts, notes, observed };
}

/** Hash over everything apply would do; the dry-run prints it, apply must quote it. */
export function planHash(plans, config) {
  const material = {
    config: { github: config.github, checkoutRoot: config.checkoutRoot, workspaceTitle: config.workspaceTitle, profiles: config.profiles, steers: config.steers },
    plans: plans.map((p) => ({ repo: p.repo, status: p.status, ops: p.ops.map(({ key, kind, params, implies }) => ({ key, kind, params, implies: implies ?? [] })), conflicts: p.conflicts })),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16);
}
