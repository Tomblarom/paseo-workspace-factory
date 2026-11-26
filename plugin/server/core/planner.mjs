// Pure planner: discovery + config -> ordered operations, conflicts and notes.
// Operations carry stable keys; apply only executes keys confirmed in a dry-run.
// K13: single-workspace enrollment + repair only. No fork/clone/project or
// workspace provisioning, no retitle/rename, no title templates, no multi-repo.
import { createHash } from 'node:crypto';
import { isAdvisorSlot, isAdvisorSteer, providerIsSensitive, slotOrder, slotProfile, configWarnings } from './config.mjs';
import { resolveProfile, steerFallbackList, usedProfilesByLiveSteers } from './models.mjs';
import { LABEL, METADATA_KEY, describeParent, parentOf, agentUsage } from './paseo.mjs';
import { STEER_TITLE, STEER_DIGIT_TITLE, discoveredRepoPublic, liveSlotHolders, resolveSteerHolders, steerTitleSlot } from './discovery.mjs';
import { sameScopeId, validScope } from './scope.mjs';
import { buildSteerCreate, idempotencyKey, requestDigest, steerCreateLabels } from './steer-create.mjs';
import { resolveContinuations, resolveFactoryLabels } from './zerosub.mjs';

// Kept for old stored plans only: new plans never emit it (enrollment needs
// an existing main workspace, so steer creates always carry a real id).
export const WORKSPACE_REF = { ref: 'main-workspace' };
export { idempotencyKey, requestDigest };

export function planRepository(discovery, config, { adopt = {}, slots, adoptWorker = {}, detach = false, zerosub = null, legacyEnrollment = false, enrollmentVersion } = {}) {
  const ops = [];
  const conflicts = [];
  const notes = [...(discovery.github?.notes ?? [])];
  const currentEnrollment = !legacyEnrollment && enrollmentVersion !== 'live';
  const oldLiveEnrollment = !legacyEnrollment && !currentEnrollment;
  const liveEnrollment = currentEnrollment || oldLiveEnrollment;
  const complete = () => finish(discovery, config, ops, conflicts, notes, currentEnrollment ? 'live-v2' : oldLiveEnrollment ? 'live' : null);
  const add = (key, kind, summary, params = {}) => ops.push({ key, kind, summary, params });
  const conflict = (key, reason) => conflicts.push({ key, reason });
  const { github, forkName } = discovery;
  const isLocal = Boolean(discovery.local) || github?.local === true || github?.fork?.status === 'local';
  const isWorktree = Boolean(discovery.worktree);

  // Per-run slot selection (--slots overrides prepare; subset of defined slots).
  let effectivePrepare = liveEnrollment ? [] : config.steers.prepare;
  let effectiveInitialActive = liveEnrollment ? null : config.steers.initialActive;
  if (!liveEnrollment && slots !== undefined) {
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
  const definedAdopts = liveEnrollment ? [] : Object.keys(adopt).filter((s) => config.steers.slots[s]);
  const adoptOutside = definedAdopts.some((s) => !effectivePrepare.includes(s));
  const slotsToPlan = adoptOutside ? definedAdopts : effectivePrepare;
  if (slotsToPlan.length && !slotsToPlan.includes(effectiveInitialActive)) effectiveInitialActive = slotsToPlan[0];

  // 1. GitHub identity (read-only): a missing or conflicting fork is a
  // conflict — create it natively in Paseo/GitHub, then enroll the workspace.
  if (!isLocal) {
    if (github.fork.status === 'conflict') conflict('github.fork', github.fork.reason);
    else if (github.fork.status === 'missing') {
      conflict('github.fork', `Fork ${github.fork.planned} does not exist; create it natively, open the workspace in Paseo, then enroll that workspace`);
    } else if (github.fork.repo.archived) conflict('github.fork', `${forkName} is archived on GitHub`);
  }
  if (!forkName) return complete();

  // 2. Checkout and project: enrollment needs both to exist already (created
  // natively in Paseo). Nothing is cloned or registered here.
  for (const issue of discovery.checkoutIssues) conflict('checkout', issue);
  if (discovery.checkoutIssues.length) return complete();
  if (isLocal && !discovery.checkout) {
    conflict('checkout', `Local path ${discovery.expectedPath} is not available; it must exist as a directory`);
    return complete();
  }
  if (!isLocal && !discovery.checkout && !isWorktree) {
    conflict('checkout', `No checkout with origin ${forkName}; clone it natively, open the workspace in Paseo, then enroll that workspace`);
    return complete();
  }
  for (const related of discovery.relatedCheckouts) {
    notes.push(`Related checkout left untouched: ${related.path} (${Object.entries(related.remotes).map(([n, u]) => `${n}=${u}`).join(', ')})`);
  }
  const checkoutPath = discovery.checkout?.path ?? discovery.expectedPath;
  if (!isWorktree && discovery.projects.length > 1) {
    conflict('paseo.project', `Checkout belongs to several Paseo projects: ${discovery.projects.map((p) => p.projectId).join(', ')}`);
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
  // Scope ids are case-insensitive (the stored/live spelling is canonical for display).
  const convertingToHub = plannedScope?.kind === 'hub' && (!stored || stored.kind !== 'hub' || !sameScopeId(stored.id, plannedScope.id));
  if (plannedScope && stored && !sameScopeId(stored.id, plannedScope.id) && !convertingToHub) {
    conflict('workspace.main.scope', `Workspace ${main.id} is scoped ${JSON.stringify(stored.id)} (${stored.kind}), but this entry plans scope ${JSON.stringify(plannedScope.id)}; adopt it under its own address instead`);
  }
  if (plannedScope && main?.id) {
    const clash = (discovery.liveScopes ?? []).find((s) => sameScopeId(s.id, plannedScope.id) && s.workspaceId !== main.id);
    if (clash) {
      conflict('scope.id', `Scope id ${JSON.stringify(plannedScope.id)} is already used by workspace ${clash.workspaceId} (${clash.kind}); rerun with --name <id> or a per-entry "name"`);
    }
  } else if (plannedScope) {
    const clash = (discovery.liveScopes ?? []).find((s) => sameScopeId(s.id, plannedScope.id));
    if (clash) {
      conflict('scope.id', `Scope id ${JSON.stringify(plannedScope.id)} is already used by workspace ${clash.workspaceId} (${clash.kind}); rerun with --name <id>`);
    }
  }
  // At most one hub scope lives on a host.
  if (plannedScope?.kind === 'hub') {
    const liveHub = (discovery.liveScopes ?? []).find((s) => s.kind === 'hub' && s.workspaceId !== main?.id);
    if (liveHub) {
      conflict('scope.hub', `Hub scope ${JSON.stringify(liveHub.id)} already lives on workspace ${liveHub.workspaceId}; at most one hub per host`);
    }
  }
  // Domain pointer resolution (used by initial.scope below and 3c-domain): an
  // explicit --domain wins ("" clears), otherwise the planned pointer (stored
  // kept). The pointer must name a live scope; single-entry plans cannot
  // create the domain in the same run. Canonical spelling is the live id.
  const domainWant = plannedScope && discovery.requestedDomain !== undefined
    ? (discovery.requestedDomain === '' ? null : discovery.requestedDomain)
    : undefined;
  const domainLive = typeof domainWant === 'string'
    ? (discovery.liveScopes ?? []).find((s) => sameScopeId(s.id, domainWant)) ?? null
    : null;
  const domainCanonical = domainLive?.id ?? null;
  const domainConflictReason = !plannedScope || domainWant === undefined ? null
    : (plannedScope.kind === 'hub' || stored?.kind === 'hub')
      ? '--domain is not supported for hub scopes (hubs carry no domain)'
      : (domainWant && sameScopeId(domainWant, plannedScope.id))
        ? `Domain scope ${JSON.stringify(domainWant)} is the scope itself`
        : (domainWant && !domainLive)
          ? `Domain scope ${JSON.stringify(domainWant)} is not a live scope; enroll it first or clear with --domain ""`
          : null;
  // Labels and metadata use the stored id when one exists, else the planned one;
  // a hub conversion already labels new steers with the planned hub id.
  const effScopeId = convertingToHub ? plannedScope.id : (stored?.id ?? plannedScope?.id ?? forkName);
  const stateNow = main?.metadata?.[METADATA_KEY];
  const repoPublic = discoveredRepoPublic(discovery);
  const scopeId = stored?.id ?? effScopeId;
  const expectWorktree = discovery.requestedMain && main ? { directory: main.workspaceDirectory } : null;
  const archiveHistory = liveEnrollment ? (discovery.agents ?? []).filter((agent) =>
    agent.archivedAt && agent.workspaceId === main?.id && agent.labels?.[LABEL.role] === 'steer' &&
    sameScopeId(agent.labels[LABEL.scope] ?? agent.labels[LABEL.repo], effScopeId)) : [];
  const historicalSteers = [...discovery.steers.labelled, ...archiveHistory];

  const planCreate = (slot, profile) => {
    const matching = historicalSteers.filter((a) => a.labels[LABEL.slot] === slot);
    const generation = (liveEnrollment ? new Set(matching.map((a) => a.id)).size : matching.length) + 1;
    const { request, idempotencyKey: createKey } = buildSteerCreate({
      keyScope: forkName, repo: effScopeId, scopeId: effScopeId, slot, workspaceId: main.id, profile,
      keyParts: ['steer', slot, `g${generation}`],
    });
    const key = `steer.${slot}`;
    add(key, 'paseo.agent.create', `Create top-level Steer ${slot} (${profile.provider}/${profile.model}) without prompt`, {
      ...request, idempotencyKey: createKey,
      ...(liveEnrollment ? { steerRole: 'coordinator', requireEmptyWorkspace: true, ...(expectWorktree ? { expectWorktree } : {}) } : {}),
    });
    return key;
  };

  let activeAgentId;
  let holderScopeId;
  let enrollment;
  if (currentEnrollment && main && !stateNow?.retired) {
    enrollment = planLiveEnrollment({ discovery, config, adopt, slots, adoptWorker, detach, zerosub, add, conflict, notes,
      scopeId, effScopeId, stateNow, repoPublic, expectWorktree, planCreate });
    ({ activeAgentId, holderScopeId, activeSlot: effectiveInitialActive } = enrollment);
  }
  if (oldLiveEnrollment && main && !stateNow?.retired) {
    const { coordinators, occupied } = enrollmentHolders(discovery, config, scopeId, conflict);
    const eligible = (agent) => {
      if (agent.provider && (repoPublic || !providerIsSensitive(config, agent.provider))) return true;
      const slot = agent.labels[LABEL.slot];
      conflict(`steer.${slot}`, `Steer ${slot} (${agent.id}) ${agent.provider ? 'requires a public scope for its sensitive runtime' : 'has an unknown runtime provider'}`);
      return false;
    };
    if (stateNow) {
      const active = coordinators.find((agent) => agent.labels[LABEL.slot] === stateNow.activeSteer);
      if (active) {
        if (eligible(active) && stateNow.activeAgentId && stateNow.activeAgentId !== active.id && stateNow.activeAgentId !== active.continuedFrom) {
          conflict('workspace.main', `Steer ${stateNow.activeSteer} no longer resolves to the controlling agent ${stateNow.activeAgentId}`);
        }
      } else if (!conflicts.length) {
        conflict('workspace.main', `The existing scope has no eligible holder for active Steer ${stateNow.activeSteer}; resolve the current authority in Paseo`);
      }
    } else if (!conflicts.length) {
      if (coordinators.length === 1) {
        const [holder] = coordinators;
        if (eligible(holder)) {
          effectiveInitialActive = holder.labels[LABEL.slot];
          activeAgentId = holder.id;
          holderScopeId = holder.labels[LABEL.scope] ?? holder.labels[LABEL.repo];
        }
      } else if (coordinators.length > 1) {
        conflict('workspace.main', `Several live coordinators (${coordinators.map((a) => `Steer ${a.labels[LABEL.slot]}`).join(', ')}); select the initial controller explicitly with --slots`);
      } else if (occupied) {
        conflict('workspace.main', 'The workspace has live agents but no coordinating steer; enroll a coordinator explicitly');
      } else {
        // Host settings already migrate legacy bindings into role priorities.
        // The fallback also accepts older in-memory configs from direct callers.
        const priority = config.steers.priority ?? [...new Set(slotOrder(config).map((slot) => config.steers.slots[slot]))];
        const { profile, skipped } = resolveProfile(config, discovery.providers, priority, { role: 'steer', repoPublic, zerosub, liveProviderPrivacy: true });
        if (!profile) {
          conflict('steer.A', `No coordinator profile is startable (tried ${skipped.map(({ name, reason }) => `"${name}" (${reason})`).join('; ') || 'no profiles configured'})`);
        } else {
          effectiveInitialActive = 'A';
          activeAgentId = { ref: planCreate(effectiveInitialActive, profile) };
          holderScopeId = effScopeId;
          for (const { name, reason } of skipped) notes.push(`Skipped coordinator profile "${name}": ${reason}`);
        }
      }
    }
  }

  // 3. Main workspace: enrollment adopts one existing workspace. Nothing is
  // created here — open the workspace natively in Paseo first.
  const initialDomain = domainWant === undefined ? plannedScope?.domain : (domainCanonical ?? domainWant);
  const initial = plannedScope
    ? { main: true, activeSteer: effectiveInitialActive, epoch: 1, scope: { id: plannedScope.id, kind: plannedScope.kind, locator: plannedScope.locator, ...(plannedScope.parent !== undefined ? { parent: plannedScope.parent } : {}), ...(initialDomain ? { domain: initialDomain } : {}) } }
    : { main: true, activeSteer: effectiveInitialActive, epoch: 1 };
  if (activeAgentId) initial.activeAgentId = activeAgentId;
  if (discovery.mainCandidates.length > 1 && !main) {
    conflict('workspace.main', `Several main workspaces use ${checkoutPath}: ${discovery.mainCandidates.map((w) => `${w.id} "${w.title ?? w.name}"`).join(', ')}`);
  } else if (!main) {
    conflict('workspace.main', `No factory main workspace for ${checkoutPath ?? forkName}; open or create the Paseo workspace natively, then enroll it (plan workspace:<id> or --local <path>)`);
  } else {
    const state = main.metadata?.[METADATA_KEY];
    if (!state && effectiveInitialActive && (!currentEnrollment || activeAgentId)) {
      const summary = isWorktree
        ? `Adopt worktree workspace ${main.id} "${main.title ?? main.name}" as factory main workspace (no new project or workspace)`
        : `Mark existing workspace ${main.id} "${main.title ?? main.name}" as factory main workspace`;
      // --main pins the adoption to the named worktree: apply re-checks that the
      // workspace is still that worktree before writing the github metadata.
      add('workspace.main.adopt', 'paseo.workspace.metadata', summary, {
        workspaceId: main.id, metadata: { [METADATA_KEY]: initial },
        ...(holderScopeId ? { holderScopeId, repoPublic } : {}),
        ...(currentEnrollment ? { liveHolder: true, ...(enrollment?.activeRuntime ? { holderRuntime: enrollment.activeRuntime } : {}) } : {}),
        ...(expectWorktree ? { expectWorktree } : {}),
      });
    } else if (state?.retired === true) {
      conflict('workspace.main', `Scope in workspace ${main.id} is retired, movedTo ${state.movedTo ?? '(unknown)'}; use the successor scope instead of planning here`);
    } else if (!liveEnrollment && state && !config.steers.slots[state.activeSteer]) {
      conflict('workspace.main', `Workspace ${main.id} names unknown active steer "${state.activeSteer}"`);
    }
  }
  if (discovery.otherLocalWorkspaces?.length) {
    notes.push(`Other local workspaces on this checkout stay untouched: ${discovery.otherLocalWorkspaces.map((w) => `${w.id} "${w.title ?? w.name}"`).join(', ')}`);
  }
  const workspaceId = main?.id ?? null;

  // 3c. Scope supplement: an existing main workspace without a scope field gets
  // a non-destructive top-up (other metadata untouched, verified after write).
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
      if (stored?.domain) notes.push(`Hub conversion drops domain ${JSON.stringify(stored.domain)} (hubs carry no domain)`);
      add('scope.convert', 'scope.convert', `Convert scope ${JSON.stringify(stored?.id ?? plannedScope.id)} on workspace ${main.id} to kind hub (steers, epoch and checkpoint untouched)`, {
        workspaceId: main.id, scope: { id: plannedScope.id, kind: 'hub', locator: plannedScope.locator },
      });
    }
  }

  // 3c-domain. --domain sets the domain pointer (Hub → Domain → Kind, logical
  // only, never a parent); --domain "" clears it. The op carries the planned
  // epoch and is epoch-checked at apply like assign. Fresh mains and scope
  // supplements inherit a valid pointer through initial.scope above.
  if (discovery.requestedDomain !== undefined && plannedScope) {
    if (domainConflictReason) {
      conflict('scope.domain', domainConflictReason);
    } else if (main && stateNow && validScope(stateNow.scope)) {
      const have = typeof stored?.domain === 'string' && stored.domain ? stored.domain : null;
      const canonical = domainWant ? domainCanonical : null;
      const norm = (v) => (v ? v.toLowerCase() : null);
      if (norm(canonical) !== norm(have)) {
        add('scope.domain', 'scope.domain', domainWant
          ? `Set domain of scope ${JSON.stringify(plannedScope.id)} to ${JSON.stringify(canonical)} (Hub → Domain → Kind; epoch-checked)`
          : `Clear domain of scope ${JSON.stringify(plannedScope.id)} (was ${JSON.stringify(have)})`,
        { workspaceId: main.id, domain: canonical, epoch: stateNow.epoch });
      }
    }
  }

  if (enrollment) enrollment.planWorkers();

  // 4. Steer slots
  for (const slot of liveEnrollment ? [] : Object.keys(adopt)) {
    if (!config.steers.slots[slot]) conflict(`steer.${slot}`, `--adopt names slot ${slot}, which is not defined in steers.slots`);
  }
  // Profiles already used by live steers of this scope: fallback entries never
  // pick them (no duplicate models), the slot's own profile stays exempt.
  const usedProfiles = liveEnrollment ? null : usedProfilesByLiveSteers(config, (discovery.steers.labelled ?? []).filter((a) => !a.archivedAt));
  // Shared adoption tail for lettered and digit-titled candidates: the privacy
  // rule first (a sensitive provider only runs on
  // provably public code — unknown counts as private), then detach/adopt, then
  // the context note. The live model is kept as-is (no drift reconciliation).
  const repoPublicity = discovery.github?.fork?.repo?.private === true ? 'is private' : 'is of unknown publicity (no GitHub repo info)';
  const planAdoption = (slot, key, candidate, profile) => {
    const sensitive = providerIsSensitive(config, candidate.provider);
    if (sensitive && !repoPublic) {
      conflict(key, `Cannot adopt ${candidate.id} (${candidate.provider}/${candidate.model}) as Steer ${slot}: ${candidate.provider} agents are restricted to public code, but ${forkName} ${repoPublicity} (profile "${profile.name}" names ${profile.provider}/${profile.model})`);
      return;
    }
    const currentParent = parentOf(candidate);
    if (currentParent && !detach) {
      conflict(key, `Candidate ${candidate.id} has ${describeParent(candidate)}; it cannot become a steer (rerun with --detach to plan a native detach first)`);
      return;
    }
    if (currentParent) {
      add(`${key}.detach`, 'agent.detach', `Detach candidate ${candidate.id} from ${describeParent(candidate)} (native agent detach, verified after)`, { agentId: candidate.id, parent: currentParent });
    }
    add(key, 'paseo.agent.adopt', `Label confirmed agent ${candidate.id} as Steer ${slot} (title and model unchanged)`, { agentId: candidate.id, ...(sensitive ? { repoPublic: true } : {}), labels: steerCreateLabels(effScopeId, effScopeId, slot) });
    if (profile.advisor === true) {
      notes.push(`Steer ${slot} uses advisor profile "${profile.name}" (advisor, never active)`);
    }
    const warn = config.usage?.warnContextTokens;
    const usage = agentUsage(candidate);
    if (Number.isInteger(warn) && warn > 0 && usage && usage.usedTokens >= warn) {
      notes.push(`Adopted Steer ${slot} context ${usage.usedTokens}/${usage.maxTokens} tokens reaches usage.warnContextTokens=${warn}; consider fresh after the takeover (docs/saving-context.md)`);
    }
  };
  // Retired scopes keep their conflict above and plan no steers at all.
  const scopeRetired = main?.metadata?.[METADATA_KEY]?.retired === true;
  const plannedSlots = new Set(slotsToPlan);
  const prepared = new Set(effectivePrepare);
  // Live labelled steers in slots outside prepare (e.g. D/E running while the
  // config prepares A/C) signal drift — hand-made steers or a renamed slot
  // set. Creating more steers on top is refused; the plan points at --slots
  // instead. Covering the runners with --slots acknowledges them (no block),
  // and prepared slots stay plannable in any per-run narrowing — so small
  // --slots rollouts and adoptions never trip over their own running steers.
  const liveOutsidePrepare = (liveEnrollment ? [] : discovery.steers.labelled ?? [])
    .filter((a) => !a.archivedAt && typeof a.labels?.[LABEL.slot] === 'string' && !prepared.has(a.labels[LABEL.slot]) && !plannedSlots.has(a.labels[LABEL.slot]));
  const outsideLetters = [...new Set(liveOutsidePrepare.map((a) => a.labels[LABEL.slot]))].sort();
  const outsideSlotsFlag = [...effectivePrepare, ...outsideLetters.filter((s) => config.steers.slots[s] && !prepared.has(s))].join(',');
  const outsideDesc = liveOutsidePrepare.map((a) => `${a.labels[LABEL.slot]} (${a.id})`).join(', ');
  const outsideUndefined = outsideLetters.filter((s) => !config.steers.slots[s]);
  let outsideBlocked = false;
  for (const slot of (scopeRetired ? [] : slotsToPlan)) {
    const key = `steer.${slot}`;
    const profile = slotProfile(config, slot);
    const labelled = discovery.steers.labelled.filter((a) => a.labels[LABEL.slot] === slot);
    const legacy = discovery.steers.legacy.filter((a) => (a.title ?? '').trim().match(STEER_TITLE)[1] === slot);

    // Several live tabs titled for one slot conflict (never ranked).
    const holders = liveSlotHolders(labelled, slot);
    if (holders.length > 1) {
      conflict(key, `Several agents are labelled as Steer ${slot}: ${holders.map((a) => a.id).join(', ')}`);
      continue;
    }
    if (holders.length === 1) {
      const existing = holders[0];
      const parent = parentOf(existing);
      if (adopt[slot] && adopt[slot] !== existing.id) conflict(key, `--adopt ${slot}=${adopt[slot]} conflicts with the already labelled Steer ${slot} ${existing.id}`);
      else if (parent) conflict(key, `Steer ${slot} (${existing.id}) has ${describeParent(existing)}; detach it in Paseo or archive it before the factory can use the slot`);
      else if (main && existing.workspaceId !== main.id) conflict(key, `Steer ${slot} (${existing.id}) lives in workspace ${existing.workspaceId}, not in main workspace ${main.id}`);
      // A live model differing from the slot profile is kept silently (K13:
      // no expected-model drift handling; point the slot at it with steer set).
      continue;
    }

    // Unlabelled agents titled "Steer X" are only candidates. Adoption needs an
    // explicit --adopt X=<agent-id> and is refused when anything is ambiguous.
    // Digit-titled candidates ("Steer 3") fill any slot the same way, but only
    // when named explicitly — they never match a slot on their own.
    const confirmedId = adopt[slot] ?? null;
    const digitHit = confirmedId ? (discovery.steers.digitCandidates ?? []).find((a) => a.id === confirmedId) : null;
    if (digitHit) {
      planAdoption(slot, key, digitHit, profile);
      continue;
    }
    if (legacy.length || confirmedId) {
      const describe = (a) => `${a.id} (${a.provider}/${a.model}, ${a.status})`;
      if (legacy.length > 1) {
        conflict(key, `Several unlabelled "Steer ${slot}" candidates in the main workspace: ${legacy.map(describe).join(', ')}; resolve manually`);
      } else if (!confirmedId) {
        const candidate = legacy[0];
        const parent = parentOf(candidate);
        conflict(key, parent
          ? `Candidate "Steer ${slot}" ${candidate.id} has ${describeParent(candidate)}; it cannot become a steer — confirm with --adopt ${slot}=${candidate.id} plus --detach to plan a native detach first`
          : `Unlabelled candidate "Steer ${slot}" ${describe(candidate)}; confirm with --adopt ${slot}=${candidate.id} or rename/archive it`);
      } else if ((discovery.steers.foreignWorkers ?? []).some((w) => w.agent?.id === confirmedId)) {
        const info = (discovery.steers.foreignWorkers ?? []).find((w) => w.agent?.id === confirmedId);
        conflict(key, `--adopt ${slot}=${confirmedId} names ${info.hint} (${describeParent(info.agent)}); workers of other scopes cannot become steers`);
      } else if (!legacy.some((a) => a.id === confirmedId)) {
        conflict(key, `--adopt ${slot}=${confirmedId} does not name the unlabelled "Steer ${slot}" candidate in the main workspace`);
      } else {
        planAdoption(slot, key, legacy[0], profile);
      }
      continue;
    }
    // Advisor slots join the plan only via config prepare or explicit adoption;
    // a --slots override does not enroll them implicitly.
    const advisorSlot = isAdvisorSlot(config, slot);
    if (advisorSlot && !config.steers.prepare.includes(slot) && !adopt[slot]) {
      notes.push(`Steer ${slot} uses advisor profile "${profile.name}" and is not in prepare; skipping (advisor, never active)`);
      continue;
    }
    if (liveOutsidePrepare.length) {
      outsideBlocked = true;
      conflict(key, `Steer ${slot} has no live agent, but live steers ${outsideDesc} run in slots outside prepare (${effectivePrepare.join(', ') || 'none'}); refusing to create another steer — re-run with --slots ${outsideSlotsFlag} or archive them in Paseo${outsideUndefined.length ? ` (slot ${outsideUndefined.join(', ')} is not defined in steers.slots; define it or archive the steer)` : ''}`);
      continue;
    }
    if (!main || !workspaceId) {
      conflict(key, `Steer ${slot} has no live agent and there is no main workspace to create it in; enroll the workspace first`);
      continue;
    }
    const { profile: resolved, skipped } = resolveProfile(config, discovery.providers, steerFallbackList(config, slot), {
      role: 'steer', advisorSlot, usedProfiles, repoPublic, zerosub,
    });
    if (!resolved) {
      const tried = skipped.length
        ? skipped.map((s) => `"${s.name}" (${s.reason})`).join('; ')
        : 'no profiles configured';
      conflict(key, `Profile "${profile.name}" for Steer ${slot} is not startable${skipped[0] ? `: ${skipped[0].reason}` : ''} (no fallback available; tried ${tried})`);
      continue;
    }
    if (resolved.name !== profile.name) {
      notes.push(`Steer ${slot}: profile "${profile.name}" is not startable (${skipped[0]?.reason ?? 'unknown reason'}); using fallback "${resolved.name}"`);
    }
    if (advisorSlot) {
      notes.push(`Steer ${slot} uses advisor profile "${profile.name}" (advisor, never active)`);
    }
    planCreate(slot, resolved);
  }

  // Digit-titled candidates are never auto-assigned; each gets a plan note with
  // the explicit --adopt form. The STEER_DIGIT_TITLE re-check keeps the note in
  // sync with discovery's definition (title suffixes, case).
  for (const candidate of discovery.steers.digitCandidates ?? []) {
    const title = (candidate.title ?? '').trim();
    const digit = title.match(STEER_DIGIT_TITLE)?.[1] ?? '?';
    notes.push(currentEnrollment
      ? `Rename candidate "Steer ${digit}" ${candidate.id} to a free Steer letter in Paseo, then use --adopt <slot>=${candidate.id}.`
      : `Assign candidate "Steer ${digit}" ${candidate.id} (${candidate.provider}/${candidate.model}, ${candidate.status}) to a slot with --adopt <slot>=${candidate.id}.`);
  }

  // Workers of other scopes' steers are never steer candidates; each keeps its
  // hint ("Worker von <scope> Steer <slot>") so the plan names the owner.
  for (const worker of discovery.steers.foreignWorkers ?? []) {
    const agent = worker.agent ?? {};
    notes.push(`${agent.id ?? '?'} "${agent.title ?? ''}" (${agent.provider}/${agent.model}, ${agent.status}) is ${worker.hint} (${describeParent(agent)}), not a steer candidate`);
  }

  // Outside-prepare runners stay visible even when nothing would be created:
  // adopted or already-live planned slots leave them untouched but named.
  if (!scopeRetired && liveOutsidePrepare.length && !outsideBlocked) {
    notes.push(`Live steers ${outsideDesc} run in slots outside prepare (${effectivePrepare.join(', ') || 'none'}) and are left untouched; cover them with --slots ${outsideSlotsFlag} to include them`);
  }

  // Unlabelled "Steer X" candidates for slots outside this plan stay visible:
  // adopting one needs an explicit --adopt (plus --slots when its slot is not
  // prepared). Planned slots already conflict or plan above, never here.
  for (const candidate of liveEnrollment ? [] : discovery.steers.legacy ?? []) {
    const letter = (candidate.title ?? '').trim().match(STEER_TITLE)?.[1] ?? null;
    if (!letter || plannedSlots.has(letter)) continue;
    const describe = `${candidate.id} (${candidate.provider}/${candidate.model}, ${candidate.status})`;
    const shown = (candidate.title ?? '').trim() || `Steer ${letter}`;
    if (!config.steers.slots[letter]) {
      notes.push(`Unlabelled candidate "${shown}" ${describe} names slot ${letter}, which is not defined in steers.slots`);
    } else {
      notes.push(`Unlabelled candidate "${shown}" ${describe} is outside this plan's slots (${slotsToPlan.join(', ') || 'none'}); adopt with --adopt ${letter}=${candidate.id} or add the slot via --slots`);
    }
  }

  // Half-labelled steers (role=steer without wsf.scope/wsf.repo) are conflicts
  // with a hint: archive the agent in Paseo or complete its labels. Archived
  // and scope-less closed agents are already ignored by discovery.
  for (const agent of discovery.steers.halfLabelled ?? []) {
    if (currentEnrollment && labelledScope(agent)) continue; // A scope-only label is a native scope projection.
    const rawSlot = agent.labels?.[LABEL.slot] ?? null;
    const slot = typeof rawSlot === 'string' && /^[A-Za-z]$/.test(rawSlot) ? rawSlot.toUpperCase() : null;
    conflict(slot ? `steer.${slot}` : `labels.half.${agent.id}`,
      `Half-labelled Steer ${slot ?? '?'} ${agent.id} (${agent.provider}/${agent.model}, ${agent.status}) has wsf.role without wsf.scope/wsf.repo; archive it in Paseo or complete its labels`);
  }

  // 4b. Worker adoption (--adopt-worker <id>[@<slot>]): label only, the agent
  // stays in its workspace (possibly a foreign one). Already-adopted workers
  // are reported; anything else labelled is a conflict, never reassigned.
  const defaultOwner = stateNow?.activeSteer ?? effectiveInitialActive;
  for (const [agentId, slot] of currentEnrollment ? [] : Object.entries(adoptWorker)) {
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
    if (!owner) continue; // Workspace enrollment already reported why it has no controller.
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
  return complete();
}

/** Live enrollment uses a tab's durable role or its running model on first adoption. */
export function enrollmentRole(config, agent) {
  const evidence = [agent.labels?.[LABEL.steerRole], agent.metadata?.[LABEL.steerRole]].filter((value) => value !== undefined);
  if (evidence.length) return evidence.every((role) => role === 'coordinator') ? 'coordinator' : 'advisor';
  if (agent.labels?.[LABEL.role] === 'steer' && config.legacyAdvisorSlots?.includes(agent.labels[LABEL.slot])) return 'advisor';
  return Object.values(config.profiles ?? {}).some((p) => p.advisor === true && p.provider === agent.provider && p.model === agent.model)
    ? 'advisor' : 'coordinator';
}

export function enrollmentRuntime(agent) {
  return { provider: agent.provider ?? null, model: agent.model ?? null };
}

export function enrollmentState(state) {
  return state ? { scopeId: state.scope?.id ?? null, epoch: state.epoch ?? null, activeSlot: state.activeSteer ?? null,
    persistedHolderId: state.activeAgentId ?? null } : null;
}

const labelledScope = (agent) => agent.labels?.[LABEL.scope] ?? agent.labels?.[LABEL.repo];
const matchesScope = (agent, scopeId, aliases) => [scopeId, ...aliases].some((id) => sameScopeId(labelledScope(agent), id));

/** Index titled tabs and valid continuations of this exact workspace. */
export function enrollmentTabs(agents, workspaceId, scopeId, aliases = []) {
  const local = agents.filter((a) => a.workspaceId === workspaceId);
  const origins = local.filter((a) => a.labels?.[LABEL.role] === 'steer' && matchesScope(a, scopeId, aliases));
  const resolved = resolveSteerHolders(origins, local).filter((a) => !a.archivedAt);
  const superseded = new Set(resolveContinuations(local).superseded);
  const tabs = new Map();
  for (const agent of local) {
    if (agent.archivedAt || agent.background === true || agent.superseded || superseded.has(agent.id)) continue;
    const labels = resolveFactoryLabels(agent, local) ?? agent.labels;
    if (labels?.[LABEL.role] && labels[LABEL.role] !== 'steer') continue;
    if (enrollmentForeignParent(agent, agents, scopeId, aliases)) continue;
    const slot = steerTitleSlot(agent.title);
    if (slot) tabs.set(agent.id, { slot, agent, registered: false });
  }
  for (const agent of resolved) {
    if (agent.background === true || agent.superseded || superseded.has(agent.id)) continue;
    const labels = resolveFactoryLabels(local.find((a) => a.id === agent.id), local);
    if (labels?.[LABEL.role] !== 'steer' || !matchesScope({ labels }, scopeId, aliases)) continue;
    tabs.set(agent.id, { slot: agent.labels[LABEL.slot], agent, registered: true });
  }
  return Map.groupBy(tabs.values(), ({ slot }) => slot);
}

export function enrollmentHolder(tabs, slot, config, repoPublic) {
  const entries = tabs.get(slot) ?? [];
  if (entries.length !== 1 || !entries[0].registered) return null;
  const agent = entries[0].agent;
  return !parentOf(agent) && enrollmentRole(config, agent) === 'coordinator' && agent.provider &&
    (!providerIsSensitive(config, agent.provider) || repoPublic === true) ? agent : null;
}

export function enrollmentAdoptionProblem({ agent, agents, tabs, workspaceId, scopeId, aliases, slot, config, repoPublic }) {
  if (!agent || agent.archivedAt || agent.workspaceId !== workspaceId || agent.background === true) {
    return 'must name a live foreground tab in the main workspace';
  }
  const foreignParent = enrollmentForeignParent(agent, agents, scopeId, aliases);
  if (foreignParent) return `is a worker of ${foreignParent} (${describeParent(agent)}); workers of other scopes cannot become steers`;
  if (resolveFactoryLabels(agent, agents)?.[LABEL.role] || agent.labels?.[LABEL.role] ||
      [LABEL.scope, LABEL.repo].some((label) => agent.labels?.[label] &&
        ![scopeId, ...aliases].some((id) => sameScopeId(agent.labels[label], id)))) {
    return 'already has a Factory role or belongs to another scope';
  }
  const entries = tabs.get(slot) ?? [];
  if (entries.length > 1) return `several live agents are titled Steer ${slot}: ${entries.map(({ agent: rival }) => rival.id).join(', ')}`;
  if (entries.length !== 1 || entries[0].agent.id !== agent.id || entries[0].registered) {
    return `must name the unique unregistered tab titled Steer ${slot} in the main workspace`;
  }
  if (!agent.provider) return 'has an unknown runtime provider';
  if (providerIsSensitive(config, agent.provider) && repoPublic !== true) {
    return `${agent.provider} agents are restricted to public code; scope visibility is ${repoPublic === false ? 'private' : 'unknown'}`;
  }
  return null;
}

function enrollmentForeignParent(agent, agents, scopeId, aliases) {
  const parentId = parentOf(agent);
  if (!parentId) return null;
  const parent = agents.find((item) => item.id === parentId);
  const labels = resolveFactoryLabels(parent, agents) ?? parent?.labels;
  const id = labelledScope({ labels });
  return labels?.[LABEL.role] === 'steer' && id && !matchesScope({ labels }, scopeId, aliases)
    ? `${id} Steer ${labels[LABEL.slot] ?? '?'}` : null;
}

function planLiveEnrollment({ discovery, config, adopt, slots, adoptWorker, detach, zerosub, add, conflict, notes,
  scopeId, effScopeId, stateNow, repoPublic, expectWorktree, planCreate }) {
  const workspaceId = discovery.mainWorkspace.id;
  const agents = discovery.agents ?? discovery.steers.labelled;
  const aliases = [...new Set(discovery.steers.labelled.filter((a) => a.workspaceId === workspaceId && sameScopeId(labelledScope(a), a.labels?.[LABEL.repo]))
    .map(labelledScope).filter((id) => !sameScopeId(id, scopeId)))].sort();
  const tabs = enrollmentTabs(agents, workspaceId, scopeId, aliases);
  const projected = new Map(tabs);
  const expectedState = enrollmentState(stateNow);
  const adoptions = [];
  const requestedIds = new Set();
  const requestedInitial = slots?.[0];
  if (slots !== undefined && (slots.length !== 1 || !/^[A-Z]$/.test(requestedInitial))) {
    conflict('workspace.main', '--slots expects one live coordinator letter A-Z for initial enrollment');
  } else if (requestedInitial && stateNow && stateNow.activeSteer !== requestedInitial) {
    conflict('workspace.main', `Scope already has active Steer ${stateNow.activeSteer}; use switch to change it`);
  }

  for (const [slot, id] of Object.entries(adopt)) {
    const key = `steer.${slot}`;
    const candidate = agents.find((agent) => agent.id === id);
    if (!/^[A-Z]$/.test(slot) || requestedIds.has(id)) {
      conflict(key, `--adopt ${slot}=${id} must assign one distinct tab per letter A-Z`);
      continue;
    }
    requestedIds.add(id);
    const entries = tabs.get(slot) ?? [];
    if (entries.length === 1 && entries[0].registered && entries[0].agent.id === id && !parentOf(entries[0].agent)) continue;
    const problem = enrollmentAdoptionProblem({ agent: candidate, agents, tabs, workspaceId, scopeId, aliases, slot, config, repoPublic });
    if (problem) {
      conflict(key, `Cannot adopt ${id} as Steer ${slot}: ${problem}`);
      continue;
    }
    const parent = parentOf(candidate);
    if (parent && !detach) {
      conflict(key, `Candidate ${id} has ${describeParent(candidate)}; confirm with --detach to plan a native detach first`);
      continue;
    }
    const role = enrollmentRole(config, candidate);
    const labels = { ...steerCreateLabels(effScopeId, effScopeId, slot), [LABEL.steerRole]: role };
    projected.set(slot, [{ slot, registered: true, agent: { ...candidate, labels, parent: null } }]);
    adoptions.push({ slot, candidate, labels, parent });
  }

  for (const [slot, entries] of tabs) {
    const key = `steer.${slot}`;
    if (entries.length > 1) {
      if (!adopt[slot]) conflict(key, `Several live agents are titled Steer ${slot}: ${entries.map(({ agent }) => agent.id).join(', ')}; resolve the ambiguity in Paseo`);
    } else if (!adopt[slot]) {
      const [{ agent, registered }] = entries;
      const parent = parentOf(agent);
      if (registered) {
        if (parent) conflict(key, `Steer ${slot} (${agent.id}) must be top-level; it has ${describeParent(agent)}`);
        continue;
      }
      if (agent.labels?.[LABEL.role] || enrollmentForeignParent(agent, agents, scopeId, aliases)) continue;
      const hint = `Unlabelled candidate "${agent.title}" ${agent.id}${parent ? ` has ${describeParent(agent)}` : ''}; confirm with --adopt ${slot}=${agent.id}${parent ? ' --detach' : ''} or rename/archive it`;
      if (!stateNow || stateNow.activeSteer === slot) conflict(key, hint);
      else notes.push(hint);
    }
  }

  const coordinator = (slot) => enrollmentHolder(projected, slot, config, repoPublic);
  const coordinators = [...projected.keys()].filter(coordinator);
  let activeSlot = stateNow?.activeSteer ?? requestedInitial ?? Object.keys(adopt).find(coordinator) ?? null;
  let active = activeSlot ? coordinator(activeSlot) : null;
  let activeAgentId = active?.id;
  let holderScopeId = active ? labelledScope(active) : undefined;
  if (stateNow) {
    if (active && stateNow.activeAgentId && stateNow.activeAgentId !== active.id && stateNow.activeAgentId !== active.continuedFrom) {
      conflict('workspace.main', `Steer ${activeSlot} no longer resolves to the controlling agent ${stateNow.activeAgentId}`);
    } else if (!active) {
      conflict('workspace.main', `The existing scope has no eligible holder for active Steer ${activeSlot} in the main workspace; resolve the current authority in Paseo`);
    }
  } else if (activeSlot && !active) {
    conflict('workspace.main', `Steer ${activeSlot} must be one live eligible coordinator in the main workspace`);
  } else if (!active && coordinators.length === 1) {
    [activeSlot] = coordinators;
    active = coordinator(activeSlot);
    activeAgentId = active.id;
    holderScopeId = labelledScope(active);
  } else if (!active && coordinators.length > 1) {
    conflict('workspace.main', `Several live coordinators (${coordinators.map((slot) => `Steer ${slot}`).join(', ')}); select one with --slots <letter>`);
  } else if (!active && agents.some((agent) => agent.workspaceId === workspaceId && !agent.archivedAt)) {
    conflict('workspace.main', 'The workspace has live agents but no coordinating steer; enroll a coordinator explicitly');
  } else if (!active && !Object.keys(adopt).length && slots === undefined) {
    const { profile, skipped } = resolveProfile(config, discovery.providers, enrollmentPriority(config), { role: 'steer', repoPublic, zerosub, liveProviderPrivacy: true });
    if (!profile) {
      conflict('steer.A', `No coordinator profile is startable (tried ${skipped.map(({ name, reason }) => `"${name}" (${reason})`).join('; ') || 'no profiles configured'})`);
    } else {
      activeSlot = 'A';
      activeAgentId = { ref: planCreate(activeSlot, profile) };
      holderScopeId = effScopeId;
      for (const { name, reason } of skipped) notes.push(`Skipped coordinator profile "${name}": ${reason}`);
    }
  }

  // Repair the active tab before touching standby tabs. No scope metadata is
  // written until the planned holder can be read back as a live coordinator.
  adoptions.sort((a, b) => Number(b.slot === activeSlot) - Number(a.slot === activeSlot));
  const guard = { workspaceId, scopeId, aliases, expectedState, ...(expectWorktree ? { expectWorktree } : {}), repoPublic,
    activeSlot, activeHolderId: activeAgentId ?? null };
  for (const { slot, candidate, labels, parent } of adoptions) {
    const key = `steer.${slot}`;
    const enrollmentGuard = { ...guard, slot, runtime: enrollmentRuntime(candidate), role: labels[LABEL.steerRole] };
    if (parent) add(`${key}.detach`, 'agent.detach', `Detach candidate ${candidate.id} from ${describeParent(candidate)}`, { agentId: candidate.id, parent, enrollmentGuard });
    add(key, 'paseo.agent.adopt', `Adopt ${candidate.id} (${candidate.provider}/${candidate.model}) as Steer ${slot} (${labels[LABEL.steerRole]})`, {
      agentId: candidate.id, labels, enrollmentGuard,
    });
    const usage = agentUsage(candidate);
    const warn = config.usage?.warnContextTokens;
    if (warn > 0 && usage?.usedTokens >= warn) notes.push(`Adopted Steer ${slot} context ${usage.usedTokens}/${usage.maxTokens} tokens reaches usage.warnContextTokens=${warn}; consider fresh after the takeover (docs/saving-context.md)`);
  }

  return { activeSlot, activeAgentId, holderScopeId,
    activeRuntime: active && (requestedInitial || adopt[activeSlot]) ? enrollmentRuntime(active) : null,
    planWorkers() {
      for (const [agentId, slot] of Object.entries(adoptWorker)) {
        const key = `worker.${agentId}`;
        const agent = agents.find((a) => a.id === agentId);
        const owner = slot ?? activeSlot;
        const role = resolveFactoryLabels(agent, agents)?.[LABEL.role] ?? agent?.labels?.[LABEL.role];
        const labels = { [LABEL.scope]: effScopeId, [LABEL.role]: 'worker', [LABEL.owner]: owner };
        const holderId = coordinator(owner)?.id ?? (owner === activeSlot ? activeAgentId : null);
        if (!agent?.workspaceId || agent.archivedAt) {
          conflict(key, `--adopt-worker ${agentId}: ${agent ? 'agent is archived or has no workspace' : 'agent not found'}`);
        } else if (role !== 'worker' && (role || requestedIds.has(agentId) || labelledScope(agent) || steerTitleSlot(agent.title))) {
          conflict(key, `--adopt-worker ${agentId}: agent ${role ? `is already labelled ${role}` : 'has steer or scope membership'}`);
        } else if (!holderId || holderId === agentId) {
          conflict(key, `--adopt-worker ${agentId}: owner Steer ${owner ?? '?'} must be one live eligible coordinator in the main workspace`);
        } else if (role === 'worker') {
          if (Object.entries(labels).every(([k, value]) => agent.labels?.[k] === value)) notes.push(`Worker ${agentId} "${agent.title}" is already adopted for Steer ${owner} (kept)`);
          else conflict(key, `--adopt-worker ${agentId}: agent is already labelled worker; reassignment is not automatic`);
        } else {
          const workerState = expectedState ? { ...expectedState, scopeId: effScopeId } :
            { scopeId: effScopeId, epoch: 1, activeSlot, persistedHolderId: activeAgentId };
          add(key, 'paseo.agent.worker', `Adopt ${agentId} as worker of Steer ${owner} (${typeof holderId === 'string' ? holderId : 'planned creation'})`, {
            agentId, workspaceId: agent.workspaceId, labels,
            enrollmentGuard: { ...guard, scopeId: effScopeId, expectedState: workerState, activeHolderId: activeAgentId, ownerHolderId: holderId },
          });
        }
      }
    },
  };
}

function enrollmentHolders(discovery, config, scopeId, conflict) {
  const { labelled, legacy = [], digitCandidates = [], halfLabelled = [] } = discovery.steers;
  const workspaceId = discovery.mainWorkspace.id;
  // Discovery has already matched repo labels (including legacy aliases).
  const members = labelled.filter((agent) => !agent.labels[LABEL.scope] || sameScopeId(agent.labels[LABEL.scope], scopeId) ||
    sameScopeId(agent.labels[LABEL.scope], agent.labels[LABEL.repo]));
  const memberIds = new Set(members.flatMap((a) => [a.id, a.continuedFrom]));
  const candidates = Map.groupBy(legacy.filter((a) => !a.archivedAt && !memberIds.has(a.id)), (agent) => steerTitleSlot(agent.title));
  const slots = new Set([...members.map((a) => a.labels[LABEL.slot]), ...candidates.keys()]);
  const coordinators = [];
  for (const slot of slots) {
    const holders = liveSlotHolders(members, slot);
    const unlabelled = candidates.get(slot) ?? [];
    const count = holders.length + unlabelled.length;
    const key = `steer.${slot}`;
    if (count > 1) {
      conflict(key, `Several live agents are titled Steer ${slot}: ${[...holders, ...unlabelled].map((a) => a.id).join(', ')}; resolve the ambiguity in Paseo`);
    } else if (unlabelled.length) {
      const [candidate] = unlabelled;
      const parent = parentOf(candidate);
      conflict(key, `Unlabelled candidate "Steer ${slot}" ${candidate.id}${parent ? ` has ${describeParent(candidate)}; detach first or use --detach` : ''}; confirm with --adopt ${slot}=${candidate.id} or rename/archive it`);
    } else if (holders.length) {
      const [holder] = holders;
      if (holder.workspaceId !== workspaceId || holder.background === true || parentOf(holder)) {
        conflict(key, `Steer ${slot} (${holder.id}) must be a top-level tab in the main workspace${parentOf(holder) ? `; it has ${describeParent(holder)}` : ''}`);
      } else if (!isAdvisorSteer(config, holder.labels, holder.metadata)) {
        coordinators.push(holder);
      }
    }
  }
  const occupied = [...(discovery.agents ?? []), ...labelled, ...legacy, ...digitCandidates, ...halfLabelled]
    .some((agent) => agent.workspaceId === workspaceId && !agent.archivedAt);
  return { coordinators, occupied };
}

function finish(discovery, config, ops, conflicts, notes, enrollment) {
  notes = [...notes, ...configWarnings(config)];
  const status = conflicts.length ? 'conflict' : ops.length ? 'pending' : 'complete';
  const main = discovery.mainWorkspace;
  // Observation only (not hashed): lets apply reconcile an attempted agent
  // create it could not record (old plans also observed workspaces).
  const labelled = discovery.steers?.labelled ?? [];
  const steers = Object.fromEntries(labelled.filter((a) => !a.archivedAt && (enrollment !== 'live-v2' || a.workspaceId === main?.id))
    .map((a) => [a.labels[LABEL.slot], a.id]));
  const observed = { mainWorkspace: main ? { id: main.id, directory: main.workspaceDirectory, title: main.title ?? main.name, metadata: main.metadata ?? {}, createdAt: main.createdAt ?? null } : null, steers };
  return { repo: discovery.forkName ?? discovery.input, input: discovery.input, status, ops, conflicts, notes, observed, ...(enrollment ? { enrollment } : {}) };
}

/** Hash over everything apply would do; the dry-run prints it, apply must quote it. */
export function planHash(plans, config) {
  const current = plans.every((plan) => plan.enrollment === 'live-v2') && plans.length > 0;
  const steers = current ? { priority: enrollmentPriority(config) } : config.steers;
  const material = {
    // K13: only the owner still matters (scope identity + visibility); the
    // retired clone/title knobs are ignored so old configs keep hashing.
    config: { github: { owner: config?.github?.owner }, checkoutRoot: config.checkoutRoot, profiles: config.profiles, steers,
      ...(current ? { legacyAdvisorSlots: config.legacyAdvisorSlots ?? [], exhaustedPct: config.quota?.exhaustedPct ?? null } : {}) },
    plans: plans.map((p) => ({ repo: p.repo, status: p.status, ops: p.ops.map(({ key, kind, params, implies }) => ({ key, kind, params, implies: implies ?? [] })), conflicts: p.conflicts, ...(p.enrollment ? { enrollment: p.enrollment } : {}) })),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16);
}

function enrollmentPriority(config) {
  return config.steers.priority ?? [...new Set(slotOrder(config).map((slot) => config.steers.slots[slot]))];
}
