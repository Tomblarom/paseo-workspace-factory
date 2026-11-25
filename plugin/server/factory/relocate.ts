// @ts-nocheck
// GENERATED from src/relocate.mjs by npm run plugin:sync. Do not edit.
// Scope relocation (S10): a new main workspace at the target, fresh steers per
// checkpoint, the old scope retired with movedTo. Archival of the old scope
// goes through S9b cleanup planning, never automatically here.
//
// The filesystem move itself is the operator's job: the target directory must
// already exist (relocate never creates user directories). New steers keep
// their slot labels, so until the old scope is archived the slot is held
// twice; switch/plan refuse that ambiguity fail-closed (same as fresh).
// movedTo is the target directory path: directly usable as an address.
import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { LABEL, METADATA_KEY, readPaseoState } from './paseo.js';
import { withLock, workspaceLockName } from './lock.js';
import { runtime } from './runtime.js';
import { validScope, domainOfScope } from './scope.js';
import { isAdvisorSlot } from './config.js';
import { resolveProfile, steerFallbackList, usedProfilesByLiveSteers } from './models.js';
import { idempotencyKey, requestDigest } from './planner.js';
import { createExecutors } from './apply.js';
import { CHECKPOINT_KEY, steerStatus, buildHandoff, hintOf, previousSteerNotice, readGitSnapshot } from './steer.js';
import { defaultExistsDir } from './cleanup.js';

export class RelocateRefused extends Error {}

const BUSY = new Set(['running', 'initializing']);

function expandHome(path) {
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
}

/**
 * Parses `--to`: `project:<id>` or a bare `prj_*` id resolves through the
 * project list, anything else is a directory path. Returns { dir } or throws.
 */
export function parseRelocateTarget(to, projects) {
  const raw = typeof to === 'string' ? to.trim() : '';
  if (!raw) throw new RelocateRefused('relocate needs --to <path|project>');
  const projectMatch = raw.match(/^(?:project\s*:\s*)?(prj_[A-Za-z0-9]+)$/i);
  if (projectMatch) {
    const project = (projects ?? []).find((p) => p.projectId === projectMatch[1]);
    if (!project) throw new RelocateRefused(`Project ${projectMatch[1]} does not exist`);
    if (!project.projectRootPath) throw new RelocateRefused(`Project ${projectMatch[1]} has no root path`);
    return { kind: 'project', dir: project.projectRootPath, projectId: project.projectId };
  }
  const dir = expandHome(raw);
  if (!isAbsolute(dir)) throw new RelocateRefused(`Relocate target ${JSON.stringify(raw)} is neither a path nor project:<id>`);
  return { kind: 'path', dir };
}

function agentConfig(profile) {
  return {
    provider: `${profile.provider}/${profile.model}`,
    ...(profile.mode ? { modeId: profile.mode } : {}),
    ...(profile.thinking ? { thinkingOptionId: profile.thinking } : {}),
  };
}

function checkedReceipt(lookupReceipt, kind, key, idOf) {
  return lookupReceipt(kind, key).catch((error) => {
    throw new RelocateRefused(`Relocate receipt lookup failed (${error.message}); refusing to create without a receipt`);
  }).then((receipt) => {
    if (!receipt) return null;
    if (receipt.idempotencyKey && receipt.idempotencyKey !== key) throw new RelocateRefused('Relocate recovery stopped: the receipt belongs to a different key');
    if (receipt.outcomeUnknown) throw new RelocateRefused(`Relocate recovery stopped: the receipt has an unknown outcome (${receipt.error ?? 'outcome unknown'})`);
    if (receipt.phase !== 'completed') throw new RelocateRefused(`Relocate recovery stopped: the receipt is in phase ${receipt.phase}${receipt.error ? ` (${receipt.error})` : ''}`);
    const id = idOf(receipt);
    if (!id) throw new RelocateRefused('Relocate recovery stopped: the receipt names no object');
    return { ...receipt, recoveredId: id };
  });
}

/**
 * Hands a scope to a new main workspace: recreates every live steer of the
 * same slot/profile with the checkpoint handoff, then retires the old scope
 * with movedTo. Preview without apply. Apply, under the old workspace lock:
 * verify epoch and active steer, create or adopt the new workspace, create
 * or recover the steers (stable idempotency keys, receipt recovery, never
 * recreated), stamp movedTo, release; then the scope.retire executor runs
 * under its own lock (epoch-checked); deliveries happen after all locks.
 * Old agents keep everything except a short notice each. A retry resumes:
 * creations are idempotent, an already-retired old scope refuses with its
 * movedTo. Idempotency keys bind the target directory (not the workspace
 * id), so preview and apply show the same keys. The stored scope field —
 * including the domain pointer — is carried over verbatim and shown in the
 * preview as `domain <id>` (result `domain`, null when the scope has none).
 */
export async function relocateScope({ client, discovery, config, to, apply = false, language = runtime().handoffLanguage, git, lock = withLock, lookupReceipt, execute, readState = readPaseoState, existsDir = defaultExistsDir, workerModel = null, promptOptions }) {
  const status = steerStatus(discovery);
  if (!status.workspace || !status.state) throw new RelocateRefused('No factory main workspace with steer state; run the factory first');
  const expected = status.state;
  if (expected.retired === true) {
    throw new RelocateRefused(`Scope ${status.repo} is already retired${expected.movedTo ? ` (moved to ${expected.movedTo})` : ''}; archive it via cleanup --plan`);
  }
  const state = await readState(client);
  const target = parseRelocateTarget(to, state.projects);
  if (!existsDir(target.dir)) throw new RelocateRefused(`Relocate target ${target.dir} does not exist or is not a directory; move the checkout first`);
  if (resolve(target.dir) === resolve(status.workspace.directory)) throw new RelocateRefused(`Relocate target ${target.dir} is already the main workspace directory`);

  const holders = status.steers;
  if (!holders.length) throw new RelocateRefused(`Scope ${status.repo} has no live steers to relocate; plan and apply some first`);
  const active = holders.find((s) => s.slot === expected.activeSteer) ?? null;
  if (active && BUSY.has(active.status)) throw new RelocateRefused(`Active Steer ${active.slot} is ${active.status}; stop it or wait for its turn to end first`);
  const unmappable = holders.filter((s) => !/^[A-Z]$/.test(s.slot ?? '') || !config?.steers?.slots?.[s.slot]);
  if (unmappable.length) {
    throw new RelocateRefused(`Cannot relocate steers without a configured slot (${unmappable.map((s) => s.id).join(', ')}); define their slots or archive them first`);
  }
  const profiles = new Map();
  const notes = [];
  const assigned = new Set();
  for (const holder of holders) {
    const own = config.steers.slots[holder.slot];
    const used = [...usedProfilesByLiveSteers(config, holders.filter((h) => h.id !== holder.id)), ...assigned];
    const { profile, skipped } = resolveProfile(config, discovery.providers, steerFallbackList(config, holder.slot), {
      role: 'steer', advisorSlot: isAdvisorSlot(config, holder.slot), usedProfiles: used,
    });
    if (!profile) {
      throw new RelocateRefused(`Profile "${own}" for Steer ${holder.slot} is not startable${skipped[0] ? `: ${skipped[0].reason}` : ''} (no fallback available)`);
    }
    profiles.set(holder.slot, profile);
    assigned.add(profile.name);
    if (profile.name !== own) {
      notes.push(`Steer ${holder.slot}: profile "${own}" is not startable (${skipped[0]?.reason ?? 'unknown reason'}); using fallback "${profile.name}"`);
    }
  }

  const atTarget = (workspaces) => (workspaces ?? []).filter((w) => {
    try {
      return resolve(w.workspaceDirectory) === resolve(target.dir);
    } catch {
      return false;
    }
  });
  const assessTarget = (workspaces) => {
    const found = atTarget(workspaces);
    if (found.length > 1) throw new RelocateRefused(`Several workspaces use ${target.dir}: ${found.map((w) => w.id).join(', ')}; disambiguate manually`);
    if (!found.length) return { mode: 'create', workspace: null };
    const candidate = found[0];
    if (candidate.id === status.workspace.id) throw new RelocateRefused(`Relocate target ${target.dir} is the current main workspace; nothing to do`);
    const meta = candidate.metadata?.[METADATA_KEY] ?? null;
    if (!meta) return { mode: 'adopt', workspace: candidate };
    const ours = meta.main === true && meta.activeSteer === newState.activeSteer && meta.epoch === 1 && meta.retired !== true
      && isDeepStrictEqual(Object.keys(meta).sort(), Object.keys(newState).sort())
      && (checkpointCopy ? isDeepStrictEqual(candidate.metadata?.[CHECKPOINT_KEY], checkpointCopy) : candidate.metadata?.[CHECKPOINT_KEY] == null);
    if (!ours) throw new RelocateRefused(`Workspace ${candidate.id} at ${target.dir} carries foreign factory state; relocate to an empty directory or adopt it manually`);
    return { mode: 'adopt-ours', workspace: candidate };
  };
  const newTitle = status.workspace.title ?? config.workspaceTitle;
  // The new scope keeps the stored scope field verbatim — including the domain
  // pointer (scope.domain), so scopes/status/assign see it without a new plan.
  // The locator may point at the old directory or workspace id; live fields
  // win over it (scopeToEntry), and it stays preview/apply-stable for the keys.
  const carriedScope = validScope(expected.scope) ? structuredClone(expected.scope) : null;
  const carriedDomain = domainOfScope(carriedScope);
  const newState = { main: true, activeSteer: expected.activeSteer, epoch: 1, ...(carriedScope ? { scope: carriedScope } : {}) };
  const checkpointCopy = status.checkpoint?.task
    ? { task: status.checkpoint.task, tests: status.checkpoint.tests ?? [], blockers: status.checkpoint.blockers ?? [], next: status.checkpoint.next ?? null, epoch: 1, updatedAt: status.checkpoint.updatedAt ?? null }
    : null;
  const newMetadata = { [METADATA_KEY]: newState, ...(checkpointCopy ? { [CHECKPOINT_KEY]: checkpointCopy } : {}) };
  const workspaceKey = idempotencyKey(status.repo, 'relocate', 'workspace', requestDigest({ path: target.dir, title: newTitle, metadata: newMetadata }));

  const gitSnapshot = git ? readGitSnapshot(git, status.workspace.directory) : null;
  const previews = holders.map((holder) => {
    const profile = profiles.get(holder.slot);
    return {
      slot: holder.slot, from: holder.id, profile: profile.name, provider: profile.provider, model: profile.model,
      idempotencyKey: idempotencyKey(status.repo, 'relocate', 'steer', holder.slot, requestDigest({
        target: target.dir, title: `Steer ${holder.slot}`, config: agentConfig(profile),
        labels: { [LABEL.repo]: status.repo, [LABEL.role]: 'steer', [LABEL.slot]: holder.slot, [LABEL.scope]: status.repo },
      })),
    };
  });
  const packetFor = (holder, toId, lastMessage) => {
    const cover = `Scope relocated: ${status.workspace.id} → ${target.dir} (${toId}).`;
    return `${cover}\n${buildHandoff(status, { from: holder, to: { slot: holder.slot, id: toId }, epoch: expected.epoch, git: gitSnapshot, lastMessage, language, workerModel, promptOptions })}`;
  };
  const previewTarget = assessTarget(state.workspaces);
  const result = {
    scope: status.repo, fromWorkspace: status.workspace.id, toWorkspace: previewTarget.workspace?.id ?? null,
    adoptedWorkspace: previewTarget.mode !== 'create', notes,
    toDir: target.dir, epoch: 1, movedTo: target.dir, checkpoint: Boolean(status.checkpoint?.task), applied: false,
    domain: carriedDomain,
    workspaceKey, steers: previews.map((p) => ({ ...p, to: null, reused: false })),
    packets: [], delivered: [], deliveryErrors: [], previousNotified: [], notifyErrors: [],
  };
  if (!apply) {
    for (const holder of holders) {
      const packet = packetFor(holder, 'new agent, created on apply', await hintOf(client, holder.id));
      result.packets.push({ slot: holder.slot, to: null, chars: packet.length, packet });
    }
    return result;
  }
  if (typeof lookupReceipt !== 'function') throw new RelocateRefused('Relocate needs a receipt lookup; refusing to create without a receipt');
  const run = execute ?? createExecutors({ client });

  const fresh = await lock(workspaceLockName(status.workspace.id), async (held) => {
    const oldRef = client.workspaces.ref(status.workspace.id);
    const current = (await oldRef.refresh())?.metadata?.[METADATA_KEY];
    if (!current || current.epoch !== expected.epoch || current.activeSteer !== expected.activeSteer) {
      throw new RelocateRefused(`Scope state changed (expected ${expected.activeSteer}@${expected.epoch}, found ${current?.activeSteer}@${current?.epoch}); rerun relocate`);
    }
    if (current.retired === true) {
      throw new RelocateRefused(`Scope ${status.repo} is already retired${current.movedTo ? ` (moved to ${current.movedTo})` : ''}; archive it via cleanup --plan`);
    }
    const live = await readState(client);
    const assessed = assessTarget(live.workspaces);
    let newWsId;
    let adopted = false;
    if (assessed.mode === 'create') {
      const createOp = { key: 'relocate.workspace', kind: 'paseo.workspace.create', summary: `Create relocated main workspace at ${target.dir}`, params: { path: target.dir, title: newTitle, metadata: newMetadata, idempotencyKey: workspaceKey } };
      const receipt = await checkedReceipt(lookupReceipt, 'workspace', workspaceKey, (r) => r.workspace?.id ?? r.workspaceId);
      if (!receipt) {
        const out = await run(createOp, config);
        if (!out?.workspaceId) throw new Error('Relocated workspace creation returned no id');
        newWsId = out.workspaceId;
      } else {
        const confirmed = await run(createOp, config);
        if (confirmed?.workspaceId !== receipt.recoveredId) throw new RelocateRefused(`Relocate recovery stopped: identical request returned ${confirmed?.workspaceId}, receipt says ${receipt.recoveredId}`);
        newWsId = receipt.recoveredId;
      }
    } else {
      const candidate = assessed.workspace;
      newWsId = candidate.id;
      adopted = true;
      if (assessed.mode === 'adopt') {
        held.verify();
        await client.workspaces.ref(newWsId).setMetadata(structuredClone(newMetadata));
        const written = (await client.workspaces.ref(newWsId).refresh())?.metadata ?? {};
        if (written[METADATA_KEY]?.main !== true) throw new Error('Relocated workspace metadata not verifiable after write');
      }
    }

    const steers = [];
    for (const preview of previews) {
      const profile = profiles.get(preview.slot);
      const op = {
        key: `relocate.steer.${preview.slot}`, kind: 'paseo.agent.create', summary: `Create relocated Steer ${preview.slot} without prompt`,
        params: {
          workspaceId: newWsId, title: `Steer ${preview.slot}`, config: agentConfig(profile),
          labels: { [LABEL.repo]: status.repo, [LABEL.role]: 'steer', [LABEL.slot]: preview.slot, [LABEL.scope]: status.repo }, idempotencyKey: preview.idempotencyKey,
        },
      };
      const receipt = await checkedReceipt(lookupReceipt, 'agent', preview.idempotencyKey, (r) => r.agentId);
      if (!receipt) {
        const out = await run(op, config);
        if (!out?.agentId) throw new Error(`Relocated Steer ${preview.slot} creation returned no agent id`);
        steers.push({ ...preview, to: out.agentId, reused: false });
      } else {
        const confirmed = await run(op, config);
        if (confirmed?.agentId !== receipt.recoveredId) throw new RelocateRefused(`Relocate recovery stopped: identical request returned ${confirmed?.agentId}, receipt says ${receipt.recoveredId}`);
        steers.push({ ...preview, to: receipt.recoveredId, reused: true });
      }
    }

    held.verify();
    await oldRef.setMetadata({ [METADATA_KEY]: { ...current, movedTo: target.dir } });
    return { newWsId, adopted, steers };
  });

  result.toWorkspace = fresh.newWsId;
  result.adoptedWorkspace = fresh.adopted;
  result.steers = fresh.steers;
  result.applied = true;
  const retireResult = await run({ key: 'relocate.retire', kind: 'scope.retire', summary: `Retire relocated scope ${status.repo}`, params: { workspaceId: status.workspace.id, epoch: expected.epoch } }, config);
  if (!retireResult?.retired) throw new Error('Scope retire did not confirm');

  for (const steer of fresh.steers) {
    const holder = holders.find((h) => h.slot === steer.slot);
    const packet = packetFor(holder, steer.to, await hintOf(client, steer.from));
    result.packets.push({ slot: steer.slot, to: steer.to, chars: packet.length, packet });
    try {
      await client.agents.ref(steer.to).send(packet);
      result.delivered.push(steer.to);
    } catch (error) {
      result.deliveryErrors.push({ id: steer.to, error: error.message });
    }
  }
  for (const holder of holders) {
    const replacement = fresh.steers.find((s) => s.slot === holder.slot)?.to ?? '(unknown)';
    try {
      // New-scope epoch: the replacement coordinates from epoch 1 on.
      await client.agents.ref(holder.id).send(`Scope relocated to ${target.dir} (${fresh.newWsId}).\n${previousSteerNotice({ slot: holder.slot, id: replacement }, 1, language)}`);
      result.previousNotified.push(holder.id);
    } catch (error) {
      result.notifyErrors.push({ id: holder.id, error: error.message });
    }
  }
  return result;
}
