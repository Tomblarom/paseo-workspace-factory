// @ts-nocheck
// GENERATED from src/apply.mjs by npm run plugin:sync. Do not edit.
// Controlled apply. The dry-run stores the complete plan; apply executes only
// operations of that stored, hash-confirmed plan. Rediscovery after each step is an
// observation: the next pending operation must match the authorized one exactly
// (after resolving symbolic references from verified results of this plan), and the
// authorized operation, not the rediscovered one, is what runs. Progress is stored
// so an interrupted run resumes the same plan.
import { lstatSync, realpathSync, mkdirSync, writeFileSync, linkSync, unlinkSync, readFileSync, renameSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';
import { withLock, workspaceLockName } from './lock.js';
import { planHash, WORKSPACE_REF } from './planner.js';
import { checkedCreationReceipt, confirmCreationReceipt, lookupCreation, verifySteerPlacement } from './steer-create.js';
import { getRepo, GitHubNotFound, remoteToFullName } from './github.js';
import { inspectCloneTarget, readRemotes } from './local.js';
import { LABEL, METADATA_KEY, LEGACY_PREFIX, parentOf, newKeyForLegacyKey } from './paseo.js';
import { validScope } from './scope.js';
import { isWorktreeWorkspace } from './discovery.js';

export class ApplyRefused extends Error {}
export class NotAuthorized extends Error {}
export class RecoveryRefused extends Error {}

const CREATE_KINDS = { 'paseo.workspace.create': 'workspace', 'paseo.agent.create': 'agent' };

function refuse(key, why) {
  throw new RecoveryRefused(`Recovery stopped: ${key} was attempted without a stored result and ${why}. Check manually and run a new dry-run.`);
}

async function readReceipt(op, lookupReceipt) {
  return lookupCreation(lookupReceipt, CREATE_KINDS[op.kind], op.params.idempotencyKey, (message) => refuse(op.key, message));
}

function completedId(op, receipt) {
  const fail = (message) => refuse(op.key, message);
  if (CREATE_KINDS[op.kind] === 'agent') return checkedCreationReceipt(receipt, op.params.idempotencyKey, fail);
  if (receipt.workspace?.id && receipt.workspaceId && receipt.workspace.id !== receipt.workspaceId) {
    fail('the receipt names no unambiguous workspace');
  }
  return checkedCreationReceipt(receipt, op.params.idempotencyKey, fail, {
    idOf: (entry) => entry.workspace?.id ?? entry.workspaceId, missing: 'the receipt names no unambiguous workspace',
  });
}

/**
 * Reconciles one authorized create operation that was attempted but has no stored
 * result (lost response, process death). Identity comes only from the daemon receipt
 * of the authorized idempotency key:
 * - no receipt: the request never reached the daemon (it persists the receipt before
 *   creating anything). A fresh execution is allowed only while discovery still lists
 *   the operation as pending and nothing it would create is observed; otherwise stop.
 * - completed receipt: the identical authorized request is re-sent (same key and
 *   request: the daemon returns the existing object, creates nothing) and must return
 *   the receipt's id; observed objects must match it; for workspace.main, path, title,
 *   initial metadata and creation time are extra consistency checks.
 * - outcomeUnknown, failed, ambiguous or contradicting receipt: stop, nothing re-sent.
 * @returns { result } to record, or { retry: true } to allow one normal execution
 */
export async function reconcileAttempt({ op, pending, observed = {}, authorization, lookupReceipt, execute, config }) {
  const receipt = await readReceipt(op, lookupReceipt);
  const isWorkspace = CREATE_KINDS[op.kind] === 'workspace';
  const seen = isWorkspace ? observed.mainWorkspace?.id : observed.steers?.[op.params.labels?.[LABEL.slot]];
  if (!receipt) {
    if (!pending) refuse(op.key, 'the daemon has no receipt although discovery no longer lists it as pending, so whatever exists was not created by this plan');
    if (seen) refuse(op.key, `the daemon has no receipt but ${seen} is observed`);
    return { retry: true };
  }
  const id = completedId(op, receipt);
  if (seen && seen !== id) refuse(op.key, `its receipt names ${id} but ${seen} is observed`);
  if (isWorkspace && observed.mainWorkspace) {
    const main = observed.mainWorkspace;
    const { path, title, metadata } = op.params;
    if (resolve(main.directory ?? '') !== resolve(path)) refuse(op.key, `workspace ${id} uses ${main.directory}, not ${path}`);
    if (main.title !== title) refuse(op.key, `workspace ${id} is titled "${main.title}", not "${title}"`);
    if (!isDeepStrictEqual(main.metadata?.[METADATA_KEY], metadata[METADATA_KEY])) refuse(op.key, `workspace ${id} carries different factory metadata`);
    const created = Date.parse(main.createdAt ?? '');
    if (!Number.isFinite(created) || created < Date.parse(authorization.createdAt)) refuse(op.key, `workspace ${id} was not created after the dry-run`);
  }
  const { confirmed } = await confirmCreationReceipt(execute, op, config, id, (message) => refuse(op.key, message), {
    idOf: (result) => (isWorkspace ? result?.workspaceId : result?.agentId),
  });
  return { result: { ...confirmed, recovered: true, via: 'receipt' } };
}

/**
 * Stores an authorization without ever replacing one: a new file is linked into
 * place atomically (link fails if the name exists). An existing authorization with
 * the same hash is kept unchanged (original createdAt) after a consistency check;
 * a damaged or different one aborts.
 */
export function storeAuthorization(dir, authorization, config, fs = { mkdirSync, writeFileSync, linkSync, unlinkSync, readFileSync }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `${authorization.hash}.json`);
  const temporary = join(dir, `.${authorization.hash}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(authorization, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(temporary, target);
    return { status: 'created', authorization, file: target };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (parseError) {
      throw new ApplyRefused(`Stored authorization ${target} is unreadable (${parseError.message}); not replacing it`);
    }
    const same = existing?.hash === authorization.hash
      && planHash(existing.plans ?? [], config) === authorization.hash
      && isDeepStrictEqual(existing.entries, authorization.entries)
      && existing.allowFork === authorization.allowFork
      && isDeepStrictEqual(existing.adopt, authorization.adopt)
      && isDeepStrictEqual(existing.slots ?? null, authorization.slots ?? null)
      && isDeepStrictEqual(existing.adoptWorker ?? {}, authorization.adoptWorker ?? {})
      && (existing.detach ?? false) === (authorization.detach ?? false)
      && (existing.retitle ?? false) === (authorization.retitle ?? false)
      && (existing.renameProject ?? null) === (authorization.renameProject ?? null)
      && Number.isFinite(Date.parse(existing.createdAt));
    if (!same) throw new ApplyRefused(`Stored authorization ${target} differs from this dry-run or is damaged; not replacing it`);
    return { status: 'kept', authorization: existing, file: target };
  } finally {
    fs.unlinkSync(temporary);
  }
}

/** Progress file written atomically (temporary file + rename). */
export function fileProgress(path) {
  return {
    load: () => {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new ApplyRefused(`Progress file ${path} is unreadable (${error.message})`);
      }
    },
    save: (state) => {
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    },
  };
}

/** One factory apply at a time on this host (global flock, see lock.mjs). */
export const APPLY_LOCK = 'factory-apply';
export function withApplyLock(fn, options) {
  return withLock(APPLY_LOCK, fn, options);
}

/** Everything apply may later do, frozen at dry-run time. */
export function createAuthorization(plans, config, { entries, allowFork = false, adopt = {}, slots, adoptWorker = {}, detach = false, retitle = false, renameProject = null } = {}) {
  return { version: 1, hash: planHash(plans, config), createdAt: new Date().toISOString(), entries, allowFork, adopt, adoptWorker, detach, retitle, renameProject, ...(slots !== undefined ? { slots } : {}), plans: structuredClone(plans) };
}

function authorizedOps(plan) {
  const map = new Map();
  for (const op of plan.ops) {
    map.set(op.key, op);
    for (const implied of op.implies ?? []) map.set(implied.key, implied);
  }
  return map;
}

function isRef(value) {
  return isDeepStrictEqual(value, WORKSPACE_REF);
}

/** Resolves symbolic references only from verified results of this plan's own operations. */
export function resolveAuthorized(op, results) {
  const params = structuredClone(op.params);
  if (isRef(params.workspaceId)) {
    const created = results['workspace.main']?.workspaceId;
    if (typeof created !== 'string') throw new NotAuthorized(`${op.key}: main workspace reference is unresolved (workspace.main has no verified result in this plan)`);
    params.workspaceId = created;
  }
  return { key: op.key, kind: op.kind, params };
}

/** Effect-relevant comparison; the idempotency key is derived and stays the authorized one. */
export function authorizationMismatch(observed, authorized) {
  if (observed.kind !== authorized.kind) return [`kind ${observed.kind} instead of ${authorized.kind}`];
  const strip = ({ idempotencyKey, ...rest }) => rest;
  const a = strip(observed.params ?? {});
  const b = strip(authorized.params ?? {});
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !isDeepStrictEqual(a[k], b[k])).map((k) => `${k} differs`);
}

export function memoryProgress(initial = null) {
  let state = initial;
  return { load: () => structuredClone(state), save: (next) => { state = structuredClone(next); } };
}

/**
 * @param authorization stored dry-run plan (createAuthorization)
 * @param runPlans      async (entries, options) => fresh plans (observation only)
 * @param execute       async (op, config) => verified result
 * @param progress      { load(), save(state) } persisted per authorization
 * @param guard         called right before every daemon/git call and progress write
 *                      (the CLI passes the apply lock's inode check)
 */
export async function applyPlans({ authorization, config, confirm, runPlans, execute, lookupReceipt, progress = memoryProgress(), journal = () => {}, guard = () => {}, maxStepsPerRepo = 20 }) {
  if (!authorization) throw new ApplyRefused('No stored plan; run plan first and confirm its hash');
  if (!confirm || confirm !== authorization.hash) throw new ApplyRefused(`Apply needs --confirm ${authorization.hash} (hash of the stored dry-run)`);
  if (planHash(authorization.plans, config) !== authorization.hash) throw new ApplyRefused('Stored plan does not match the current config or was altered; run a new dry-run');
  const options = { allowFork: authorization.allowFork, adopt: authorization.adopt, adoptWorker: authorization.adoptWorker ?? {}, detach: authorization.detach ?? false, retitle: authorization.retitle ?? false, renameProject: authorization.renameProject ?? null, ...(authorization.slots !== undefined ? { slots: authorization.slots } : {}) };
  const state = progress.load() ?? { hash: authorization.hash, started: false, results: {} };
  if (state.hash !== authorization.hash) throw new ApplyRefused('Progress belongs to a different plan');
  if (!state.started) {
    const fresh = await runPlans(authorization.entries, options);
    if (planHash(fresh, config) !== authorization.hash) throw new ApplyRefused('State changed since the dry-run (fresh plan hash differs); run a new dry-run');
    state.started = true; // from here on, a rerun resumes this plan even if nothing was recorded yet
    guard();
    progress.save(state);
  }

  const report = [];
  for (const [index, plan] of authorization.plans.entries()) {
    const results = (state.results[plan.repo] ??= {});
    const outcome = { repo: plan.repo, executed: [], status: plan.status, error: null };
    report.push(outcome);
    if (plan.status !== 'pending') continue;
    const allowed = authorizedOps(plan);
    const creates = [...allowed.values()].filter((op) => CREATE_KINDS[op.kind] && op.params?.idempotencyKey);
    const retryAllowed = new Set();
    try {
      for (let step = 0; ; step += 1) {
        if (step >= maxStepsPerRepo) throw new Error('Too many steps; aborting to avoid a loop');
        const [current] = await runPlans([authorization.entries[index]], options);
        if (current.repo !== plan.repo) throw new NotAuthorized(`Repository identity changed: ${current.repo} instead of ${plan.repo}`);
        if (current.conflicts.length) throw new Error(`Conflict appeared during apply: ${current.conflicts.map((c) => c.reason).join('; ')}`);
        const pendingKeys = new Set(current.ops.map((o) => o.key));

        // Before anything else, whatever the next observed operation is (or if none is
        // left): every attempted create without a stored result is reconciled first.
        for (const createOp of creates) {
          const tag = `${plan.repo}#${createOp.key}`;
          if (results[createOp.key] || !(state.attempted ?? []).includes(tag) || retryAllowed.has(tag)) continue;
          if (isRef(createOp.params.workspaceId) && !results['workspace.main']) continue; // its workspace is reconciled first
          guard();
          const reconciled = await reconcileAttempt({
            op: resolveAuthorized(createOp, results), pending: pendingKeys.has(createOp.key), observed: current.observed ?? {},
            authorization, lookupReceipt, execute, config,
          });
          if (reconciled.retry) {
            retryAllowed.add(tag);
            journal({ event: 'retry-allowed', repo: plan.repo, key: createOp.key, reason: 'no receipt; request never reached the daemon' });
          } else {
            results[createOp.key] = reconciled.result;
            guard();
            progress.save(state);
            journal({ event: 'recovered', repo: plan.repo, key: createOp.key, output: reconciled.result });
          }
        }

        const observed = current.ops[0];
        if (!observed) {
          outcome.status = 'complete';
          break;
        }
        const authorizedOp = allowed.get(observed.key);
        if (!authorizedOp) throw new NotAuthorized(`Operation ${observed.key} is not part of the confirmed plan`);
        if (results[observed.key]) throw new Error(`Operation ${observed.key} is still pending after it ran; state did not converge`);
        const tag = `${plan.repo}#${observed.key}`;
        // Creates are only repeated after receipt reconciliation; other executors re-check
        // their preconditions (target absent, remote absent, metadata absent, unlabelled).
        if (CREATE_KINDS[authorizedOp.kind] && (state.attempted ?? []).includes(tag) && !retryAllowed.has(tag)) {
          throw new RecoveryRefused(`Operation ${observed.key} was attempted before without a stored result; refusing to repeat it unverified`);
        }
        const op = resolveAuthorized(authorizedOp, results);
        const mismatch = authorizationMismatch(observed, op);
        if (mismatch.length) throw new NotAuthorized(`Operation ${observed.key} no longer matches the confirmed plan (${mismatch.join(', ')}); run a new dry-run`);
        guard();
        journal({ event: 'start', repo: plan.repo, key: op.key, kind: op.kind, params: op.params });
        state.attempted = [...new Set([...(state.attempted ?? []), tag])];
        progress.save(state); // recorded before the call: recovery may only adopt what this plan requested
        retryAllowed.delete(tag);
        const output = await execute(op, config);
        results[op.key] = output ?? {};
        guard();
        progress.save(state);
        outcome.executed.push({ key: op.key, kind: op.kind, output });
        journal({ event: 'done', repo: plan.repo, key: op.key, output });
      }
    } catch (error) {
      outcome.status = 'failed';
      outcome.error = error.message;
      try {
        journal({ event: 'failed', repo: plan.repo, error: error.message }); // the journal checks the lock itself
      } catch (journalError) {
        outcome.error += ` (journal not written: ${journalError.message})`;
      }
    }
  }
  return { hash: authorization.hash, report };
}

async function poll(check, { attempts = 10, delayMs = 3000, sleep }) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check();
    if (value) return value;
    await sleep(delayMs);
  }
  return null;
}

/** Real executors. Every write is guarded by a fresh precondition and verified afterwards. */
export function createExecutors({ client, gh, git, paseoCli, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fs = { lstatSync, realpathSync } }) {
  const handlers = {
    async 'github.fork'(op, config) {
      const name = op.params.upstream.split('/')[1];
      gh(['repo', 'fork', op.params.upstream, '--clone=false', '--remote=false']);
      const fork = await poll(async () => {
        try {
          const repo = getRepo(gh, `${config.github.owner}/${name}`);
          return repo.isFork ? repo : null;
        } catch (error) {
          if (error instanceof GitHubNotFound) return null;
          throw error;
        }
      }, { sleep });
      if (!fork) throw new Error(`Fork ${config.github.owner}/${name} did not appear`);
      return { fork: fork.fullName };
    },

    async 'paseo.clone'(op, config) {
      const { repo, parentDir, protocol, expectedPath, guard } = op.params;
      // Recheck immediately before the write: same canonical root, no symlink component,
      // target absent, deepest existing directory still the one inspected at plan time.
      const now = inspectCloneTarget(config.checkoutRoot, parentDir, expectedPath, fs);
      if (!now.ok) throw new Error(`Clone target unsafe: ${now.reason}`);
      if (now.root !== guard?.root || now.anchor !== guard?.anchor || now.anchorId !== guard?.anchorId) {
        throw new Error(`Clone target changed since the dry-run (${guard?.anchor} ${guard?.anchorId} -> ${now.anchor} ${now.anchorId})`);
      }
      const out = paseoCli(['clone', repo, '--dir', parentDir, '--protocol', protocol]);
      if (resolve(out?.checkoutPath ?? '') !== resolve(expectedPath) || !out?.projectId) {
        throw new Error(`Clone reported ${JSON.stringify(out)}; expected checkout ${expectedPath}`);
      }
      const st = fs.lstatSync(expectedPath);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${expectedPath} is not a plain directory after cloning`);
      if (fs.realpathSync(expectedPath) !== resolve(expectedPath)) throw new Error(`${expectedPath} resolves elsewhere after cloning`);
      const origin = remoteToFullName(readRemotes(git, expectedPath).origin ?? '');
      if (origin !== repo.toLowerCase()) throw new Error(`Cloned origin is ${origin}, expected ${repo}`);
      return { checkoutPath: out.checkoutPath, projectId: out.projectId };
    },

    async 'git.remote.add'(op) {
      const { path, origin, name, url } = op.params;
      const st = fs.lstatSync(path);
      if (st.isSymbolicLink() || !st.isDirectory() || fs.realpathSync(path) !== resolve(path)) throw new Error(`${path} is not the inspected checkout directory`);
      const remotes = readRemotes(git, path);
      if (remoteToFullName(remotes.origin ?? '') !== origin.toLowerCase()) throw new Error(`${path} origin is ${remotes.origin}, expected ${origin}`);
      if (name in remotes) throw new Error(`Remote ${name} already exists in ${path}`);
      git(path, ['remote', 'add', name, url]);
      if (readRemotes(git, path)[name] !== url) throw new Error(`Remote ${name} not verifiable in ${path}`);
      return { path, remote: name };
    },

    async 'paseo.project.add'(op) {
      const out = paseoCli(['project', 'create', op.params.path]);
      if (!out?.projectId) throw new Error(`Project registration returned ${JSON.stringify(out)}`);
      return { projectId: out.projectId };
    },

    async 'paseo.workspace.create'(op) {
      const { path, title, metadata, idempotencyKey } = op.params;
      const handle = await client.workspaces.create({ source: { kind: 'directory', path }, title, metadata, idempotencyKey });
      const workspace = await handle.refresh();
      if (resolve(workspace?.workspaceDirectory ?? '') !== resolve(path)) throw new Error(`Workspace ${handle.id} points to ${workspace?.workspaceDirectory}`);
      if (workspace.metadata?.[METADATA_KEY]?.main !== true) throw new Error(`Workspace ${handle.id} lacks factory metadata`);
      return { workspaceId: handle.id };
    },

    async 'paseo.workspace.metadata'(op) {
      const handle = client.workspaces.ref(op.params.workspaceId);
      const before = await handle.refresh();
      if (before?.metadata?.[METADATA_KEY]) throw new Error(`Workspace ${op.params.workspaceId} already carries factory metadata`);
      if (op.params.expectWorktree) {
        if (!isWorktreeWorkspace(before)) throw new Error(`Workspace ${op.params.workspaceId} is no longer a worktree workspace; run a new dry-run`);
        if (resolve(before.workspaceDirectory ?? '') !== resolve(op.params.expectWorktree.directory ?? '')) {
          throw new Error(`Workspace ${op.params.workspaceId} moved from ${op.params.expectWorktree.directory} to ${before.workspaceDirectory}; run a new dry-run`);
        }
      }
      await handle.setMetadata(op.params.metadata);
      const after = await handle.refresh();
      if (after?.metadata?.[METADATA_KEY]?.main !== true) throw new Error('Workspace metadata not verifiable');
      return { workspaceId: op.params.workspaceId };
    },

    async 'paseo.workspace.scope'(op) {
      const { workspaceId, scope } = op.params;
      if (!validScope(scope)) throw new Error('paseo.workspace.scope needs a valid scope { id, kind, locator? }');
      return withLock(workspaceLockName(workspaceId), async (held) => {
        const handle = client.workspaces.ref(workspaceId);
        const before = (await handle.refresh())?.metadata ?? {};
        const base = { ...(before[LEGACY_PREFIX] ?? {}), ...(before[METADATA_KEY] ?? {}) };
        if (base.main !== true) throw new Error(`Workspace ${workspaceId} carries no factory main metadata`);
        if (validScope(base.scope)) throw new Error(`Workspace ${workspaceId} already carries scope ${JSON.stringify(base.scope.id)}`);
        held.verify();
        await handle.setMetadata({ [METADATA_KEY]: { ...base, scope: structuredClone(scope) } });
        const after = (await handle.refresh())?.metadata?.[METADATA_KEY] ?? {};
        if (!isDeepStrictEqual(after.scope, scope)) throw new Error(`Workspace ${workspaceId} scope not verifiable after write`);
        for (const [key, value] of Object.entries(base)) {
          if (key !== 'scope' && !isDeepStrictEqual(after[key], value)) throw new Error(`Workspace ${workspaceId} metadata field ${key} changed by the scope top-up`);
        }
        return { workspaceId, scope: scope.id };
      });
    },

    async 'paseo.workspace.retitle'(op) {
      const { workspaceId, title } = op.params;
      if (typeof title !== 'string' || !title.trim()) throw new Error('paseo.workspace.retitle needs a title');
      const before = await client.workspaces.ref(workspaceId).refresh();
      if (!before) throw new Error(`Workspace ${workspaceId} is missing`);
      if ((before.title ?? before.name) === title) throw new Error(`Workspace ${workspaceId} is already titled ${JSON.stringify(title)}`);
      await client.workspaces.ref(workspaceId).setTitle(title);
      const after = await client.workspaces.ref(workspaceId).refresh();
      if ((after?.title ?? after?.name) !== title) throw new Error(`Workspace ${workspaceId} title is ${JSON.stringify(after?.title ?? after?.name)}, expected ${JSON.stringify(title)}`);
      return { workspaceId, title };
    },

    async 'paseo.project.rename'(op) {
      const { projectId, name } = op.params;
      if (typeof name !== 'string' || !name.trim()) throw new Error('paseo.project.rename needs a name');
      paseoCli(['project', 'rename', projectId, name]);
      const projects = await client.projects.list().then((result) => result.projects ?? []);
      const project = projects.find((p) => p.projectId === projectId) ?? null;
      if (project?.projectDisplayName !== name) throw new Error(`Project ${projectId} name is ${JSON.stringify(project?.projectDisplayName)}, expected ${JSON.stringify(name)}`);
      return { projectId, name };
    },

    async 'agent.detach'(op) {
      const { agentId, parent } = op.params;
      const handle = client.agents.ref(agentId);
      const before = (await handle.refresh())?.agent;
      if (!before || before.archivedAt) throw new Error(`Agent ${agentId} is missing or archived`);
      const current = parentOf(before);
      if (!current) throw new Error(`Agent ${agentId} has no parent; nothing to detach`);
      if (parent !== undefined && current !== parent) throw new Error(`Agent ${agentId} parent is ${current}, expected ${parent}`);
      await handle.detach();
      const after = (await handle.refresh())?.agent;
      if (parentOf(after)) throw new Error(`Agent ${agentId} still has parent ${parentOf(after)} after detach`);
      return { agentId, detachedFrom: current };
    },

    async 'paseo.agent.worker'(op) {
      const { agentId, workspaceId, labels } = op.params;
      const handle = client.agents.ref(agentId);
      const before = (await handle.refresh())?.agent;
      if (!before || before.archivedAt) throw new Error(`Agent ${agentId} is missing or archived`);
      if (before.workspaceId !== workspaceId) throw new Error(`Agent ${agentId} is in workspace ${before.workspaceId}, expected ${workspaceId}`);
      if (before.labels?.[LABEL.role]) throw new Error(`Agent ${before.id} is already labelled ${before.labels[LABEL.role]}`);
      const labelArg = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
      paseoCli(['agent', 'update', before.id, '--label', labelArg]);
      const after = (await handle.refresh())?.agent;
      for (const [key, value] of Object.entries(labels)) {
        if (after?.labels?.[key] !== value) throw new Error(`Agent ${before.id} label ${key} is ${after?.labels?.[key]}, expected ${value}`);
      }
      return { agentId: after.id };
    },

    async 'scope.convert'(op) {
      const { workspaceId, scope } = op.params;
      if (!validScope(scope) || scope.kind !== 'hub') throw new Error('scope.convert needs a hub scope { id, kind: "hub", locator? }');
      const handle = client.workspaces.ref(workspaceId);
      const before = (await handle.refresh())?.metadata ?? {};
      const base = { ...(before[LEGACY_PREFIX] ?? {}), ...(before[METADATA_KEY] ?? {}) };
      if (base.main !== true) throw new Error(`Workspace ${workspaceId} carries no factory main metadata`);
      if (validScope(base.scope) && base.scope.kind !== 'hub' && base.scope.kind !== 'dir') {
        throw new Error(`Workspace ${workspaceId} carries a ${base.scope.kind} scope; only dir scopes convert to hub`);
      }
      await handle.setMetadata({ [METADATA_KEY]: { ...base, scope: structuredClone(scope) } });
      const after = (await handle.refresh())?.metadata?.[METADATA_KEY] ?? {};
      if (!isDeepStrictEqual(after.scope, scope)) throw new Error(`Workspace ${workspaceId} scope not verifiable after write`);
      for (const [key, value] of Object.entries(base)) {
        if (key !== 'scope' && !isDeepStrictEqual(after[key], value)) throw new Error(`Workspace ${workspaceId} metadata field ${key} changed by the conversion`);
      }
      return { workspaceId, scope: scope.id, convertedFrom: base.scope?.id ?? null };
    },

    async 'scope.domain'(op) {
      const { workspaceId, domain, epoch } = op.params;
      if (!workspaceId || !Number.isInteger(epoch) || (domain !== null && (typeof domain !== 'string' || !domain))) {
        throw new Error('scope.domain needs workspaceId, domain (or null to clear) and the planned epoch');
      }
      return withLock(workspaceLockName(workspaceId), async (held) => {
        const handle = client.workspaces.ref(workspaceId);
        const meta = (await handle.refresh())?.metadata?.[METADATA_KEY];
        if (!meta || typeof meta !== 'object') throw new Error(`Workspace ${workspaceId} has no factory state; refusing to set the domain`);
        if (meta.epoch !== epoch) throw new Error(`Scope state changed (expected epoch ${epoch}, found ${meta.epoch}); replan`);
        if (meta.retired === true) throw new Error(`Workspace ${workspaceId} scope is retired; refusing to set the domain`);
        if (!validScope(meta.scope)) throw new Error(`Workspace ${workspaceId} has no scope; plan the scope supplement first`);
        const have = typeof meta.scope.domain === 'string' && meta.scope.domain ? meta.scope.domain : null;
        const norm = (v) => (v ? v.toLowerCase() : null);
        if (norm(domain) === norm(have)) return { workspaceId, domain: have, already: true };
        const next = domain ? { ...meta.scope, domain } : (({ domain: _drop, ...rest }) => rest)(meta.scope);
        held.verify();
        await handle.setMetadata({ [METADATA_KEY]: { ...meta, scope: next } });
        const written = (await handle.refresh())?.metadata?.[METADATA_KEY]?.scope;
        if (!isDeepStrictEqual(written, next)) throw new Error(`Workspace ${workspaceId} domain not verifiable after write`);
        return { workspaceId, domain };
      });
    },

    async 'paseo.agent.create'(op) {
      const { workspaceId, title, config: agentConfig, labels, idempotencyKey, metadata, clearInheritedParent: clearParent = false } = op.params;
      if (!workspaceId || workspaceId === WORKSPACE_REF || typeof workspaceId !== 'string') throw new Error('Main workspace is not resolved yet');
      // Deliberately no `parent` and no `prompt`: a top-level steer without a first turn.
      // Optional `metadata` pins the agent (e.g. {"zerosub.account": id}, Paseo 0.16+).
      // `clearInheritedParent` (fresh only) detaches a link inherited from the
      // calling agent; plan/apply keeps failing closed with PARENT VIOLATION.
      const handle = await client.workspaces.ref(workspaceId).agents.create({ config: agentConfig, title, labels, idempotencyKey, ...(metadata ? { metadata } : {}) });
      let agent = (await handle.refresh())?.agent;
      if (clearParent) agent = await detachInheritedParent(handle, agent);
      verifySteerPlacement(agent, { workspaceId, labels, parent: null });
      return { agentId: agent.id, parent: null };
    },

    async 'paseo.agent.createWorker'(op) {
      const { workspaceId, title, config: agentConfig, labels, parent = null, idempotencyKey, metadata, clearInheritedParent: clearParent = false } = op.params;
      if (!workspaceId || typeof workspaceId !== 'string') throw new Error('Worker workspace is not resolved yet');
      if (parent !== null && (typeof parent !== 'string' || !parent)) throw new Error('Worker parent must be an agent id or null');
      // A fresh worker starts without a first turn; the brief is delivered
      // afterwards like the steer handoff. The parent is the owning steer
      // taken from the refreshed worker — never the calling agent. A parent
      // expected to be absent is detached when the fresh flag allows it.
      const handle = await client.workspaces.ref(workspaceId).agents.create({
        title, labels, config: agentConfig, idempotencyKey,
        ...(parent ? { parent } : {}),
        ...(metadata ? { metadata } : {}),
      });
      let agent = (await handle.refresh())?.agent;
      if (!parent && clearParent) agent = await detachInheritedParent(handle, agent);
      verifySteerPlacement(agent, { workspaceId, labels, parent });
      return { agentId: agent.id, parent };
    },

    async 'paseo.agent.adopt'(op) {
      const handle = client.agents.ref(op.params.agentId);
      const before = (await handle.refresh())?.agent;
      if (!before || before.archivedAt) throw new Error(`Agent ${op.params.agentId} is missing or archived`);
      if (parentOf(before)) throw new Error(`Agent ${before.id} has parent ${parentOf(before)}`);
      if (before.labels?.[LABEL.role]) throw new Error(`Agent ${before.id} is already labelled`);
      const labelArg = Object.entries(op.params.labels).map(([k, v]) => `${k}=${v}`).join(',');
      paseoCli(['agent', 'update', before.id, '--label', labelArg]);
      const after = (await handle.refresh())?.agent;
      verifySteerPlacement(after, { workspaceId: before.workspaceId, labels: op.params.labels, parent: null });
      return { agentId: after.id };
    },

    async 'labels.migrate'(op) {
      const { target, migrate } = op.params;
      if (!Array.isArray(migrate) || !migrate.length) throw new Error('labels.migrate needs at least one legacy key');
      for (const oldKey of migrate) {
        if (!newKeyForLegacyKey(oldKey)) throw new Error(`Not a legacy key: ${oldKey}`);
      }
      if (target === 'workspace') return migrateWorkspaceMetadata(client, op.params);
      if (target === 'agent') return migrateAgentLabels(client, paseoCli, op.params);
      throw new Error(`labels.migrate needs target workspace or agent, got ${target}`);
    },

    async 'labels.set'(op) {
      const { agentId, labels } = op.params ?? {};
      if (!agentId || !labels || typeof labels !== 'object' || !Object.keys(labels).length) {
        throw new Error('labels.set needs agentId and at least one label');
      }
      const known = new Set(Object.values(LABEL));
      for (const [key, value] of Object.entries(labels)) {
        if (!known.has(key)) throw new Error(`labels.set refuses unknown label ${JSON.stringify(key)} (only wsf.* factory labels)`);
        if (typeof value !== 'string' || !value) throw new Error(`labels.set needs a non-empty string for ${key}`);
      }
      const handle = client.agents.ref(agentId);
      const before = (await handle.refresh())?.agent;
      if (!before || before.archivedAt) throw new Error(`Agent ${agentId} is missing or archived`);
      paseoCli(['agent', 'update', before.id, '--label', Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',')]);
      const after = (await handle.refresh())?.agent;
      for (const [key, value] of Object.entries(labels)) {
        if (after?.labels?.[key] !== value) throw new Error(`Agent ${before.id} label ${key} is ${after?.labels?.[key]}, expected ${value}`);
      }
      return { agentId: before.id, labels: { ...labels } };
    },
  };
  return async function execute(op, config) {
    const handler = handlers[op.kind];
    if (!handler) throw new Error(`No executor for ${op.kind}`);
    return handler(op, config);
  };
}

/**
 * Copies legacy workspace metadata keys to their new counterparts and removes
 * the old ones (`null` removes a top-level key). A persisted new key always
 * wins and is never overwritten. Verified by re-reading afterwards.
 */
async function migrateWorkspaceMetadata(client, { workspaceId, migrate }) {
  return withLock(workspaceLockName(workspaceId), async (held) => {
    const handle = client.workspaces.ref(workspaceId);
    const before = (await handle.refresh())?.metadata ?? {};
    const patch = {};
    const expected = {};
    for (const oldKey of migrate) {
      const newKey = newKeyForLegacyKey(oldKey);
      if (before[newKey] === undefined && before[oldKey] !== undefined) patch[newKey] = before[oldKey];
      if (before[oldKey] !== undefined) patch[oldKey] = null;
      if (before[newKey] !== undefined) expected[newKey] = before[newKey];
      else if (before[oldKey] !== undefined) expected[newKey] = before[oldKey];
    }
    if (Object.keys(patch).length) {
      held.verify();
      await handle.setMetadata(patch);
    }
    const after = (await handle.refresh())?.metadata ?? {};
    for (const oldKey of migrate) {
      if (after[oldKey] !== undefined) throw new Error(`Legacy key ${oldKey} still present in workspace ${workspaceId}`);
      const newKey = newKeyForLegacyKey(oldKey);
      if (expected[newKey] !== undefined && !isDeepStrictEqual(after[newKey], expected[newKey])) {
        throw new Error(`Migrated key ${newKey} not verifiable in workspace ${workspaceId}`);
      }
    }
    return { workspaceId, migrated: migrate };
  });
}

/**
 * Persists the new counterparts of legacy agent labels via the native CLI.
 * Old labels are left in place: neither the SDK nor `paseo agent update`
 * can remove agent labels. Verified by re-reading afterwards.
 */
async function migrateAgentLabels(client, paseoCli, { agentId, migrate }) {
  const handle = client.agents.ref(agentId);
  const before = (await handle.refresh())?.agent;
  if (!before || before.archivedAt) throw new Error(`Agent ${agentId} is missing or archived`);
  const labels = {};
  for (const oldKey of migrate) {
    const newKey = newKeyForLegacyKey(oldKey);
    if (before.labels?.[newKey] === undefined && before.labels?.[oldKey] !== undefined) labels[newKey] = before.labels[oldKey];
  }
  if (Object.keys(labels).length) {
    paseoCli(['agent', 'update', before.id, '--label', Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',')]);
  }
  const after = (await handle.refresh())?.agent;
  for (const [newKey, value] of Object.entries(labels)) {
    if (after?.labels?.[newKey] !== value) throw new Error(`Agent ${before.id} label ${newKey} is ${after?.labels?.[newKey]}, expected ${value}`);
  }
  return { agentId: before.id, migrated: migrate, oldLabelsRemain: true };
}

/**
 * Clears a parent link the daemon inherited from the calling agent context:
 * steer creates never pass `parent`, so any parent on the fresh snapshot is
 * unintended. Detaches once through the public SDK handle (the same native
 * call the CLI uses) and re-reads. Without a parent the agent is returned
 * unchanged and the caller verifies (verifySteerPlacement refuses a remaining parent).
 */
async function detachInheritedParent(handle, agent) {
  if (!agent || !parentOf(agent)) return agent;
  await handle.detach();
  return (await handle.refresh())?.agent ?? agent;
}
