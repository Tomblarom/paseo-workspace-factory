// Pure planner: discovery + config -> ordered operations, conflicts and notes.
// Operations carry stable keys; apply only executes keys confirmed in a dry-run.
import { createHash } from 'node:crypto';
import { slotProfile, validateProfilesAgainstCatalog } from './config.mjs';
import { LABEL, METADATA_KEY, parentOf } from './paseo.mjs';
import { STEER_TITLE } from './discovery.mjs';

export const WORKSPACE_REF = { ref: 'main-workspace' };

export function idempotencyKey(forkName, ...parts) {
  return ['ari-wsf', forkName.toLowerCase(), ...parts].join(':');
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

function steerLabels(forkName, slot) {
  return { [LABEL.repo]: forkName, [LABEL.role]: 'steer', [LABEL.slot]: slot };
}

export function planRepository(discovery, config, { allowFork = false, adopt = {} } = {}) {
  const ops = [];
  const conflicts = [];
  const notes = [...(discovery.github?.notes ?? [])];
  const add = (key, kind, summary, params = {}) => ops.push({ key, kind, summary, params });
  const conflict = (key, reason) => conflicts.push({ key, reason });
  const { github, forkName } = discovery;

  // 1. GitHub fork
  if (github.fork.status === 'conflict') conflict('github.fork', github.fork.reason);
  else if (github.fork.status === 'missing') {
    if (allowFork) add('github.fork', 'github.fork', `Fork ${github.upstream.fullName} to ${github.fork.planned}`, { upstream: github.upstream.fullName, owner: config.github.owner });
    else conflict('github.fork', `Fork ${github.fork.planned} does not exist; rerun with --allow-fork to plan its creation`);
  } else if (github.fork.repo.archived) conflict('github.fork', `${forkName} is archived on GitHub`);
  if (!forkName) return finish(discovery, config, ops, conflicts, notes);

  // 2. Checkout and project registration
  for (const issue of discovery.checkoutIssues) conflict('checkout', issue);
  if (discovery.checkoutIssues.length) return finish(discovery, config, ops, conflicts, notes);
  const willClone = !discovery.checkout && !discovery.checkoutIssues.length;
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

  if (github.upstream) {
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
  if (discovery.checkout && !discovery.projects.length) {
    add('paseo.project', 'paseo.project.add', `Register ${checkoutPath} as Paseo project`, { path: checkoutPath });
  } else if (discovery.projects.length > 1) {
    conflict('paseo.project', `Checkout belongs to several Paseo projects: ${discovery.projects.map((p) => p.projectId).join(', ')}`);
  }

  // 3. Main workspace
  const initial = { main: true, activeSteer: config.steers.initialActive, epoch: 1 };
  let main = discovery.mainWorkspace;
  if (discovery.mainCandidates.length > 1 && !main) {
    conflict('workspace.main', `Several main workspaces use ${checkoutPath}: ${discovery.mainCandidates.map((w) => `${w.id} "${w.title ?? w.name}"`).join(', ')}`);
  } else if (!main) {
    add('workspace.main', 'paseo.workspace.create', `Create local workspace "${config.workspaceTitle}" for ${checkoutPath}`, {
      path: checkoutPath, title: config.workspaceTitle, metadata: { [METADATA_KEY]: initial },
      idempotencyKey: idempotencyKey(forkName, 'workspace', 'main', requestDigest({ path: checkoutPath, title: config.workspaceTitle, metadata: initial })),
    });
  } else {
    const state = main.metadata?.[METADATA_KEY];
    if (!state) {
      add('workspace.main.adopt', 'paseo.workspace.metadata', `Mark existing workspace ${main.id} "${main.title ?? main.name}" as factory main workspace`, {
        workspaceId: main.id, metadata: { [METADATA_KEY]: initial },
      });
    } else if (!config.steers.slots[state.activeSteer]) {
      conflict('workspace.main', `Workspace ${main.id} names unknown active steer "${state.activeSteer}"`);
    }
    if ((main.title ?? main.name) !== config.workspaceTitle) {
      notes.push(`Workspace ${main.id} is titled "${main.title ?? main.name}"; expected "${config.workspaceTitle}" (not renamed automatically)`);
    }
  }
  if (discovery.otherLocalWorkspaces?.length) {
    notes.push(`Other local workspaces on this checkout stay untouched: ${discovery.otherLocalWorkspaces.map((w) => `${w.id} "${w.title ?? w.name}"`).join(', ')}`);
  }
  const workspaceId = main?.id ?? WORKSPACE_REF;

  // 4. Steer slots
  for (const slot of Object.keys(adopt)) {
    if (!config.steers.prepare.includes(slot)) conflict(`steer.${slot}`, `--adopt names slot ${slot}, which is not prepared by the config`);
  }
  const catalogProblems = validateProfilesAgainstCatalog(config, discovery.providers, new Set(config.steers.prepare.map((slot) => config.steers.slots[slot])));
  for (const slot of config.steers.prepare) {
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
          ? `Candidate "Steer ${slot}" ${candidate.id} has parent ${parent}; it cannot become a steer`
          : `Unlabelled candidate "Steer ${slot}" ${describe(candidate)}; confirm with --adopt ${slot}=${candidate.id} or rename/archive it`);
      } else if (!legacy.some((a) => a.id === confirmedId)) {
        conflict(key, `--adopt ${slot}=${confirmedId} does not name the unlabelled "Steer ${slot}" candidate in the main workspace`);
      } else if (parentOf(legacy[0])) {
        conflict(key, `Candidate ${confirmedId} has parent ${parentOf(legacy[0])}; it cannot become a steer`);
      } else {
        const candidate = legacy[0];
        add(key, 'paseo.agent.adopt', `Label confirmed agent ${candidate.id} as Steer ${slot} (title and model unchanged)`, { agentId: candidate.id, labels: steerLabels(forkName, slot) });
        if (candidate.provider !== profile.provider || candidate.model !== profile.model) {
          notes.push(`Adopted Steer ${slot} runs ${candidate.provider}/${candidate.model}; profile "${profile.name}" names ${profile.provider}/${profile.model} (kept)`);
        }
      }
      continue;
    }
    if (catalogProblems[profile.name]) {
      conflict(key, `Profile "${profile.name}" for Steer ${slot} is not startable: ${catalogProblems[profile.name].join('; ')}`);
      continue;
    }
    const generation = labelled.length + 1; // archived steers of this slot get a fresh key
    const request = { workspaceId, title: `Steer ${slot}`, config: agentConfig(profile), labels: steerLabels(forkName, slot) };
    add(key, 'paseo.agent.create', `Create top-level Steer ${slot} (${profile.provider}/${profile.model}) without prompt`, {
      ...request, idempotencyKey: idempotencyKey(forkName, 'steer', slot, `g${generation}`, requestDigest(request)),
    });
  }

  if (discovery.workers.length) {
    notes.push(`Workers kept as they are: ${discovery.workers.map((w) => `${w.id} "${w.title}" (parent ${parentOf(w)})`).join(', ')}`);
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
