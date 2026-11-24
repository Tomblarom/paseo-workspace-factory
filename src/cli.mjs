#!/usr/bin/env node
// Paseo Workspace Factory. Dry-run is the default; every write needs --apply.
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, defaultConfigPath, workerPriority, isAdvisorProfile, isAdvisorSlot, isSensitiveProfile, isSensitiveSlot, slotOrder } from './config.mjs';
import { configureRuntime, runtime } from './runtime.mjs';
import { createGh } from './github.mjs';
import { createGit } from './local.mjs';
import { LABEL, METADATA_KEY, connect, createPaseoCli, daemonStartedAt, lookupCreationReceipt, readPaseoState, restartMessage } from './paseo.mjs';
import { createRunner } from './factory.mjs';
import { planHash } from './planner.mjs';
import { applyPlans, createExecutors, createAuthorization, storeAuthorization, fileProgress, withApplyLock } from './apply.mjs';
import { CHECKPOINT_KEY, restartInterruptions, steerStatus, switchSteer, freshSteer, writeCheckpoint, parseCheckpointBlock, lastAssistantText, resolveTargetEntry, buildResumeBrief, readGitBrief } from './steer.mjs';
import { AGENTS_KEY } from './agent-state.mjs';
import { listScopes, resolveScope, domainFirstPlanOrder } from './scope.mjs';
import { DRAIN_DEFAULT_TIMEOUT_MS, drain, parseTimeout } from './drain.mjs';
import { assessWorker, readGitState } from './workers.mjs';
import { formatWorkersText, readWorkers, workersReport } from './supervision.mjs';
import { assignScope } from './assign.mjs';
import { flagValue, formatCatalog, formatWorkerModel, parseProviderModel, paseoRunFlags, planAdvisorTag, planSensitiveTag, planSlotRemove, planSlotSet, planSteerRemove, planSteerSet, planWorkerDefault, planWorkerRemove, planWorkerSet, previewConfig, resolveProfile, steerFallbackList, writeConfigAtomic } from './models.mjs';
import { scopeRows, scopeCandidates, formatScopeRows, formatScopeCandidates, formatStatus } from './scopes-view.mjs';
import { validateProfilesAgainstCatalog } from './config.mjs';
import { recordProfileFailure } from './quota.mjs';
import { attachProjectArchivedAgents, collectCleanupCandidates, formatCandidate, formatLoss, planCleanupOps, selectApplyRunPlans } from './cleanup.mjs';
import { relocateScope } from './relocate.mjs';

const USAGE = `Usage: paseo-factory <command> [options]
  plan   <repo...> [--repos-file f.json] [--local <path>]... [--name <id>] [--subject <text>] [--checkout <path>] [--main workspace:<id>] [--domain <id>] [--hub <path|workspace:id>] [--allow-fork] [--adopt <scope-id>:A=<agent-id>] [--adopt-worker <agent-id>[@A]] [--detach] [--slots A,B] [--retitle] [--rename-project <name>] [--json] [--out f.json]
  apply  --confirm <hash>             run the stored dry-run plan; resumes after a failure
  status <repo> [--json]
  checkpoint <repo> --task <text> [--test <text>]... [--blocker <text>]... [--next <text>]
  checkpoint <repo> --from-agent <steer-id> [--next <text>]   take the CHECKPOINT block of its last answer
  switch <repo> --to <slot> [--apply] [--no-send] [--wait] [--notify-previous] [--language en|de]
  fresh <repo> [--apply]       hand the active steer to a new agent of the same slot/profile
  relocate <scope> --to <path|project> [--apply]
  assign <scope> --task <text> [--test <text>]... [--blocker <text>]... [--next <text>] [--apply] [--no-send]
  resume [scope] [--agent <id>] [--json]   cold-start brief: task, next step, git, workers
  workers [scope] [--json]           print the worker register (task, state, resumes)
  retire <agent-id>                  preview only; archiving is disabled
  cleanup [--json]                   read-only cleanup report over the whole instance
  cleanup --plan [--allow-destructive] [--allow-ignored] [--only <id,...>] [--json]
  models [--json]                    list the live provider catalog
  worker list [--json]                 worker priority with availability and the current pick
  worker set <n> <profile|provider/model> [--thinking X] [--mode Y] [--profile name] [--dry-run]
  worker rm <n> [--dry-run]
  worker pick [scope] [--json]         chosen worker profile plus paseo run flags
  steer list [--json]                  slots in priority order with tags, availability, fallbacks
  steer set <n|slot> <profile|provider/model> [--thinking X] [--mode Y] [--profile name] [--dry-run]
  steer rm <n|slot> [--dry-run]
  model advisor <profile|provider/model> on|off [--dry-run]
  model sensitive <profile|provider/model> on|off [--dry-run]
  slot set <A-Z> ... (deprecated, use steer set) | slot rm <A-Z> (deprecated, use steer rm)
  worker-default ... (deprecated, use worker set 1 ...)
  scopes [--json] [--candidates]   one line per live scope; --candidates lists unadopted workspaces
  drain [--timeout 10m] [--json]   wait until no factory agent runs; marks leftovers planned-restart (exit 2), never restarts itself
--adopt SLOT=<agent-id> needs exactly one repository; with several entries use --adopt <scope-id>:SLOT=<agent-id> per entry.
--checkout <path> names the checkout of one entry (same as per-entry "checkout" in --repos-file); use it when several checkouts share one origin.
--local is repeatable and plans existing directories without GitHub (no fork, clone or upstream remote); dir/workspace entries may carry "name" for the scope id (or --name with one entry).
local/<folder> stays an input alias only; scopes are addressed by id (owner/repo, folder/--name, <parent>@<branch>).
A --local worktree directory (or {"workspace": <id>}, "workspace:<id>") adopts that Paseo worktree workspace as the main workspace without a new project; status/checkpoint/switch/fresh/workers accept its scope id, local/<folder> alias or workspace id.
--main workspace:<id> adopts that worktree workspace as the main workspace of a github scope (one entry; the scope id stays owner/repo, no duplicate workspace or project).
--domain <id> sets the scope's domain pointer (Hub → Domain → Kind, logical only; --domain "" clears it); blockers prefixed domain: go to the domain steer, hub: further to the hub.
Main titles follow the workspaceTitle template ({name}, {subject}); a deviating title is only reported unless --retitle plans a rename. --rename-project renames the scope project (one entry).
--hub plans a hub-kind scope (at most one live; an existing dir scope converts, steers/epoch/checkpoint untouched).
--adopt-worker labels an agent as scope worker (stays in its workspace); --detach plans a native detach for parented steer candidates.
Model lists are ordered by priority, highest first. worker set <n> inserts at position n (later entries move down, an existing copy of the same model moves); worker rm <n> removes and closes the gap. Steer slots never shift: steer set <n|slot> replaces the slot's profile (2 is B). Unavailable models are stored with a warning and skipped by the fallback.
Options: --config <path> (default: $PASEO_FACTORY_CONFIG or ~/.config/paseo-workspace-factory/config.json); --dry-run previews config writes`;

/**
 * Default scope for bare `resume`: the calling agent's own scope label first
 * (it also covers workers in foreign workspaces), else the calling workspace.
 */
async function defaultResumeEntry(client, command = 'resume') {
  const agentId = process.env.PASEO_AGENT_ID;
  const workspaceId = process.env.PASEO_WORKSPACE_ID;
  if (agentId || workspaceId) {
    const paseo = await readPaseoState(client);
    const scopeId = agentId ? paseo.agents.find((a) => a.id === agentId)?.labels?.[LABEL.scope] : null;
    if (typeof scopeId === 'string' && scopeId) return scopeId;
    if (workspaceId) return `workspace:${workspaceId}`;
  }
  throw new Error(`${command} needs a scope (or run it inside a factory agent or workspace)`);
}

/**
 * Default scope address for bare `worker pick`, like `resume`: the calling
 * agent's scope label first, else the calling workspace, else the workspace
 * of the current directory. Only live scopes count (ambiguous or unknown
 * addresses fall through); null means the catalog-only pick without repo
 * visibility. Pure over the state, env/cwd injectable for tests.
 */
export function defaultPickAddress(paseoState, { agentId = process.env.PASEO_AGENT_ID, workspaceId = process.env.PASEO_WORKSPACE_ID, cwd = process.cwd() } = {}) {
  const liveScope = (address) => {
    try {
      return resolveScope(address, paseoState);
    } catch {
      return null;
    }
  };
  if (agentId) {
    const scopeId = paseoState.agents.find((a) => a.id === agentId)?.labels?.[LABEL.scope];
    if (typeof scopeId === 'string' && scopeId && liveScope(scopeId)) return scopeId;
  }
  if (workspaceId && liveScope(`workspace:${workspaceId}`)) return `workspace:${workspaceId}`;
  const cwdScope = cwd ? liveScope(cwd) : null;
  if (cwdScope) return cwdScope.id;
  return null;
}

/**
 * `Worker model:` line for briefs and handoffs: the resolved worker profile
 * for this scope (priority, catalog availability, advisor and sensitive rules;
 * sensitive profiles only run on provably public repos) or a none-startable
 * note with the reasons. Pure over the discovery, no extra catalog call.
 */
function workerModelLine(config, discovery) {
  const repoPublic = discovery?.github?.fork?.repo?.private === false;
  const profileHealth = discovery?.mainWorkspace?.metadata?.[METADATA_KEY]?.profileHealth ?? null;
  const { profile, skipped } = resolveProfile(config, discovery?.providers ?? [], workerPriority(config), { role: 'worker', repoPublic, profileHealth });
  if (!profile) {
    const tried = skipped.length ? skipped.map((s) => `"${s.name}" (${s.reason})`).join('; ') : 'no worker profiles configured';
    return `Worker model: none startable (${tried})`;
  }
  return formatWorkerModel(config, profile);
}

/**
 * Last-turn CHECKPOINT presence per agent (P2 heuristic): true when the last
 * answer carries a CHECKPOINT block, false when it has an answer without one,
 * missing when unreadable (fails closed, never marks). Only the given ids are
 * read; failures per agent are swallowed.
 */
async function fetchLastTurnCheckpoints(client, agentIds) {
  const out = {};
  for (const id of agentIds) {
    try {
      const text = lastAssistantText(await client.agents.ref(id).timeline.refetch({ direction: 'tail', limit: 20 }));
      if (typeof text !== 'string' || !text) continue;
      out[id] = parseCheckpointBlock(text) !== null;
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Heuristic inputs for one scope (P2): daemon start plus last-turn flags for
 * idle candidates whose checkpoint predates the restart and that carry no
 * plugin restart mark. Returns null when the heuristic cannot apply (no
 * daemon time, no checkpoint, checkpoint newer than the daemon), so callers
 * skip timeline reads and show plugin marks only.
 */
async function heuristicInputsForDiscovery(client, discovery) {
  let started = null;
  try {
    started = daemonStartedAt(createPaseoCli());
  } catch {
    started = null;
  }
  if (!started) return null;
  const checkpoint = discovery.mainWorkspace?.metadata?.[CHECKPOINT_KEY] ?? null;
  const checkpointAt = checkpoint?.capturedAt ?? checkpoint?.updatedAt ?? null;
  if (typeof checkpointAt !== 'string' || !checkpointAt) return null;
  if (!Number.isFinite(Date.parse(checkpointAt)) || Date.parse(started) <= Date.parse(checkpointAt)) return null;
  const agentState = discovery.mainWorkspace?.metadata?.[AGENTS_KEY] ?? null;
  const markedIds = new Set(restartInterruptions({ checkpoint, agentState }).map((m) => m.agentId));
  const candidates = [...(discovery.steers.labelled ?? []), ...(discovery.workers ?? [])]
    .filter((a) => a && !a.archivedAt && a.status === 'idle' && !markedIds.has(a.id))
    .map((a) => a.id);
  if (!candidates.length) return { daemonStartedAt: started, lastTurnCheckpoints: {} };
  return { daemonStartedAt: started, lastTurnCheckpoints: await fetchLastTurnCheckpoints(client, candidates) };
}

/**
 * Heuristic inputs across all live scopes (P2): same rule as the single-scope
 * helper, applied per scope. Returns null when no scope can match, so callers
 * skip timeline reads.
 */
async function heuristicInputsForScopes(client, paseoState) {
  let started = null;
  try {
    started = daemonStartedAt(createPaseoCli());
  } catch {
    started = null;
  }
  if (!started || !Number.isFinite(Date.parse(started))) return null;
  const scopes = listScopes(paseoState);
  const candidates = [];
  for (const scope of scopes) {
    const checkpoint = scope.workspace.metadata?.[CHECKPOINT_KEY] ?? null;
    const checkpointAt = checkpoint?.capturedAt ?? checkpoint?.updatedAt ?? null;
    if (typeof checkpointAt !== 'string' || !checkpointAt) continue;
    if (!Number.isFinite(Date.parse(checkpointAt)) || Date.parse(started) <= Date.parse(checkpointAt)) continue;
    const agentState = scope.workspace.metadata?.[AGENTS_KEY] ?? null;
    const markedIds = new Set(restartInterruptions({ checkpoint, agentState }).map((m) => m.agentId));
    for (const a of paseoState.agents ?? []) {
      if (!a || a.archivedAt || a.status !== 'idle' || markedIds.has(a.id)) continue;
      if (a.labels?.[LABEL.scope] !== scope.id) continue;
      const role = a.labels?.[LABEL.role];
      if (role !== 'steer' && role !== 'worker') continue;
      candidates.push(a.id);
    }
  }
  if (!candidates.length) {
    const anyOld = scopes.some((s) => {
      const at = s.workspace.metadata?.[CHECKPOINT_KEY]?.capturedAt ?? s.workspace.metadata?.[CHECKPOINT_KEY]?.updatedAt ?? null;
      return typeof at === 'string' && Number.isFinite(Date.parse(at)) && Date.parse(started) > Date.parse(at);
    });
    return anyOld ? { daemonStartedAt: started, lastTurnCheckpoints: {} } : null;
  }
  return { daemonStartedAt: started, lastTurnCheckpoints: await fetchLastTurnCheckpoints(client, [...new Set(candidates)]) };
}

function printPlans(plans, hash) {
  for (const plan of plans) {
    console.log(`\n${plan.repo}  [${plan.status}]`);
    for (const op of plan.ops) console.log(`  + ${op.key.padEnd(26)} ${op.summary}`);
    for (const c of plan.conflicts) console.log(`  ! ${c.key.padEnd(26)} ${c.reason}`);
    for (const n of plan.notes) console.log(`  · ${n}`);
  }
  const writes = plans.reduce((sum, p) => sum + p.ops.length, 0);
  console.log(`\nPlan hash ${hash} · ${writes} write operation(s) · dry-run, nothing changed`);
  if (writes) console.log(`Stored for review. Apply: paseo-factory apply --confirm ${hash}`);
}

function printCleanupPlan(plan, hints, hash) {
  console.log(`\n${plan.repo}  [${plan.status}]`);
  for (const h of hints) console.log(`  ~ ${h.id}  ${h.reason}`);
  for (const op of plan.ops.filter((o) => o.kind === 'scope.retire')) console.log(`  + ${op.key.padEnd(26)} ${op.summary}`);
  for (const op of plan.ops.filter((o) => o.kind !== 'scope.retire')) {
    console.log(`  ! DESTRUCTIVE ${op.key}  ${op.summary}`);
    if (op.loss) console.log(`    loss: ${formatLoss(op.loss)}`);
  }
  const writes = plan.ops.length;
  console.log(`\nPlan hash ${hash} · ${writes} write operation(s) · dry-run, nothing changed`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' }, 'repos-file': { type: 'string' }, 'allow-fork': { type: 'boolean' },
      json: { type: 'boolean' }, confirm: { type: 'string' }, to: { type: 'string' }, apply: { type: 'boolean' },
      'no-send': { type: 'boolean' }, 'archive-workspace': { type: 'boolean' }, help: { type: 'boolean' },
      adopt: { type: 'string', multiple: true }, slots: { type: 'string', multiple: true }, out: { type: 'string' }, task: { type: 'string' },
      test: { type: 'string', multiple: true }, blocker: { type: 'string', multiple: true },
      next: { type: 'string' }, 'from-agent': { type: 'string' }, wait: { type: 'boolean' }, 'expect-epoch': { type: 'string' },
      'notify-previous': { type: 'boolean' }, language: { type: 'string' }, local: { type: 'string', multiple: true }, name: { type: 'string' },
      retitle: { type: 'boolean' }, 'rename-project': { type: 'string' }, subject: { type: 'string' }, hub: { type: 'string', multiple: true },
      'adopt-worker': { type: 'string', multiple: true }, detach: { type: 'boolean' }, agent: { type: 'string' }, checkout: { type: 'string' },
      main: { type: 'string' }, domain: { type: 'string' },
      thinking: { type: 'string' }, mode: { type: 'string' }, profile: { type: 'string' }, 'dry-run': { type: 'boolean' },
      candidates: { type: 'boolean' }, plan: { type: 'boolean' }, 'allow-destructive': { type: 'boolean' }, 'allow-ignored': { type: 'boolean' }, only: { type: 'string' },
      timeout: { type: 'string' },
      failed: { type: 'string' }, reason: { type: 'string' },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) return console.log(USAGE);
  if (values.timeout !== undefined && command !== 'drain') throw new Error('--timeout is only accepted with drain');
  const configPath = values.config ?? defaultConfigPath();
  const config = await loadConfig(configPath);
  const { planDir: PLAN_DIR, journalDir: JOURNAL_DIR } = configureRuntime(config);
  const localFlags = values.local ?? [];
  for (const flag of localFlags) {
    if (!flag?.trim()) throw new Error('--local needs a directory path');
    const abs = resolve(flag);
    try {
      if (!statSync(abs).isDirectory()) throw new Error();
    } catch {
      throw new Error(`--local path ${flag} does not exist or is not a directory`);
    }
  }
  const hubFlags = values.hub ?? [];
  const hubEntries = hubFlags.map((flag) => {
    if (!flag?.trim()) throw new Error('--hub needs a directory path or workspace:<id>');
    const trimmed = flag.trim();
    const prefixed = trimmed.match(/^(?:workspace|worktree)\s*:\s*(.+)$/i);
    if (prefixed) {
      const workspace = prefixed[1].trim();
      if (!workspace) throw new Error(`--hub needs a workspace id, got ${flag}`);
      return { workspace, hub: true };
    }
    if (/^wks_[A-Za-z0-9]+$/.test(trimmed)) return { workspace: trimmed, hub: true };
    const abs = resolve(flag);
    try {
      if (!statSync(abs).isDirectory()) throw new Error();
    } catch {
      throw new Error(`--hub path ${flag} does not exist or is not a directory`);
    }
    return { local: abs, hub: true };
  });
  let entries = [...args, ...(values['repos-file'] ? JSON.parse(readFileSync(values['repos-file'], 'utf8')) : []), ...localFlags.map((p) => ({ local: resolve(p) })), ...hubEntries];
  if (localFlags.length && (command === 'models' || command === 'model' || command === 'slot' || command === 'steer' || command === 'worker' || command === 'worker-default' || command === 'retire')) {
    throw new Error(`--local is not accepted with ${command}`);
  }
  if (hubFlags.length && (command === 'models' || command === 'model' || command === 'slot' || command === 'steer' || command === 'worker' || command === 'worker-default' || command === 'retire')) {
    throw new Error(`--hub is not accepted with ${command}`);
  }
  if (values.name !== undefined) {
    if (command !== 'plan') throw new Error('--name is only accepted with plan');
    if (entries.length !== 1) throw new Error('--name needs exactly one repository entry (or use per-entry "name" in --repos-file)');
    const only = entries[0];
    if (only && typeof only === 'object' && !Array.isArray(only)) {
      if (only.name !== undefined) throw new Error('--name conflicts with the entry "name"; use one of them');
      entries = [{ ...only, name: values.name }];
    } else {
      entries = [{ repo: only, name: values.name }];
    }
  }
  if (values.subject !== undefined) {
    if (command !== 'plan') throw new Error('--subject is only accepted with plan');
    if (entries.length !== 1) throw new Error('--subject needs exactly one repository entry (or use per-entry "subject" in --repos-file)');
    const only = entries[0];
    if (only && typeof only === 'object' && !Array.isArray(only)) {
      if (only.subject !== undefined) throw new Error('--subject conflicts with the entry "subject"; use one of them');
      entries = [{ ...only, subject: values.subject }];
    } else {
      entries = [{ repo: only, subject: values.subject }];
    }
  }
  if (values.checkout !== undefined) {
    if (command !== 'plan') throw new Error('--checkout is only accepted with plan');
    if (entries.length !== 1) throw new Error('--checkout needs exactly one repository entry (or use per-entry "checkout" in --repos-file)');
    if (!values.checkout?.trim()) throw new Error('--checkout needs a checkout path');
    const only = entries[0];
    if (only && typeof only === 'object' && !Array.isArray(only)) {
      if (only.checkout !== undefined) throw new Error('--checkout conflicts with the entry "checkout"; use one of them');
      if (only.main !== undefined) throw new Error('--checkout conflicts with the entry "main"; use one of them');
      entries = [{ ...only, checkout: values.checkout }];
    } else {
      entries = [{ repo: only, checkout: values.checkout }];
    }
  }
  if (values.main !== undefined) {
    if (command !== 'plan') throw new Error('--main is only accepted with plan');
    if (entries.length !== 1) throw new Error('--main needs exactly one repository entry (or use per-entry "main" in --repos-file)');
    if (!values.main?.trim()) throw new Error('--main needs a workspace id (workspace:<id>)');
    const only = entries[0];
    if (only && typeof only === 'object' && !Array.isArray(only)) {
      if (only.main !== undefined) throw new Error('--main conflicts with the entry "main"; use one of them');
      if (only.checkout !== undefined) throw new Error('--main conflicts with the entry "checkout"; use one of them');
      entries = [{ ...only, main: values.main }];
    } else {
      entries = [{ repo: only, main: values.main }];
    }
  }
  if (values.domain !== undefined) {
    if (command !== 'plan') throw new Error('--domain is only accepted with plan');
    if (entries.length !== 1) throw new Error('--domain needs exactly one repository entry (or use per-entry "domain" in --repos-file)');
    const only = entries[0];
    if (only && typeof only === 'object' && !Array.isArray(only)) {
      if (only.domain !== undefined) throw new Error('--domain conflicts with the entry "domain"; use one of them');
      entries = [{ ...only, domain: values.domain }];
    } else {
      entries = [{ repo: only, domain: values.domain }];
    }
  }
  if (values.retitle && command !== 'plan') throw new Error('--retitle is only accepted with plan');
  if (values['rename-project'] !== undefined && command !== 'plan') throw new Error('--rename-project is only accepted with plan');
  if (values['rename-project'] !== undefined && entries.length !== 1) throw new Error('--rename-project needs exactly one repository entry');
  const gh = createGh();
  const git = createGit();
  const client = await connect();
  const runner = createRunner({ config, client, gh, git });
  try {
    if (command === 'models' || command === 'model' || command === 'slot' || command === 'steer' || command === 'worker' || command === 'worker-default') {
      return await runModelCommand({ command, args, values, config, configPath, client, runner });
    }
    if (command === 'scopes') {
      if (entries.length) throw new Error('scopes takes no repository; use paseo-factory scopes [--json] [--candidates]');
      const paseo = await readPaseoState(client);
      if (values.candidates) {
        const rows = scopeCandidates(paseo);
        return console.log(values.json ? JSON.stringify(rows, null, 2) : formatScopeCandidates(rows));
      }
      const heuristic = await heuristicInputsForScopes(client, paseo).catch(() => null);
      const rows = scopeRows(paseo, { ...(heuristic ?? {}), config });
      return console.log(values.json ? JSON.stringify(rows, null, 2) : formatScopeRows(rows));
    }
    if (command === 'drain') {
      if (entries.length) throw new Error('drain takes no repository; use paseo-factory drain [--timeout 10m] [--json]');
      const timeoutMs = values.timeout === undefined ? DRAIN_DEFAULT_TIMEOUT_MS : parseTimeout(values.timeout);
      const result = await drain({ client, timeoutMs, git, log: values.json ? null : (msg) => console.log(msg) });
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatDrain(result));
      }
      if (!result.clean) process.exitCode = 2;
      return;
    }
    const allowFork = Boolean(values['allow-fork']);
    const adoptPairs = (values.adopt ?? []).flatMap((v) => v.split(',')).filter(Boolean);
    const legacyAdopts = [];
    const scopedAdopts = {};
    for (const pair of adoptPairs) {
      const legacy = pair.match(/^([A-Z])=([0-9a-f-]{8,})$/i);
      if (legacy) {
        legacyAdopts.push([legacy[1].toUpperCase(), legacy[2]]);
        continue;
      }
      const scoped = pair.match(/^(.+):([A-Z])=([0-9a-f-]{8,})$/i);
      if (!scoped || !scoped[1].trim()) throw new Error(`--adopt expects SLOT=<agent-id> or <scope-id>:SLOT=<agent-id>, got ${pair}`);
      (scopedAdopts[scoped[1].trim().toLowerCase()] ??= {})[scoped[2].toUpperCase()] = scoped[3];
    }
    if (legacyAdopts.length && entries.length !== 1) throw new Error('--adopt SLOT=<agent-id> needs exactly one repository; use --adopt <scope-id>:SLOT=<agent-id> with several entries');
    const adopt = { ...(legacyAdopts.length ? { '*': Object.fromEntries(legacyAdopts) } : {}), ...scopedAdopts };
    const workerPairs = (values['adopt-worker'] ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
    if (workerPairs.length && command !== 'plan') throw new Error('--adopt-worker is only accepted with plan');
    if (workerPairs.length && entries.length !== 1) throw new Error('--adopt-worker needs exactly one repository entry; the worker is labelled for that scope');
    const adoptWorker = Object.fromEntries(workerPairs.map((pair) => {
      const match = pair.match(/^([0-9a-f-]{8,})(?:@([A-Za-z]))?$/);
      if (!match) throw new Error(`--adopt-worker expects <agent-id>[@<slot>], got ${pair}`);
      return [match[1], match[2] ? match[2].toUpperCase() : null];
    }));
    if (values.detach && command !== 'plan') throw new Error('--detach is only accepted with plan');

    if (command === 'plan') {
      if (!entries.length) throw new Error('plan needs at least one repository');
      const slots = (values.slots ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean).map((s) => s.toUpperCase());
      for (const slot of slots) {
        if (!/^[A-Z]$/.test(slot)) throw new Error(`--slots expects comma-separated slot letters A-Z, got ${slot}`);
      }
      if (new Set(slots).size !== slots.length) throw new Error('--slots contains duplicates');
      for (const slot of slots) {
        if (!config.steers.slots[slot]) throw new Error(`--slots names slot ${slot}, which is not defined in steers.slots`);
      }
      const slotsOverride = slots.length ? slots : undefined;
      const retitle = Boolean(values.retitle);
      const renameProject = values['rename-project']?.trim() || null;
      if (values['rename-project'] !== undefined && renameProject === null) throw new Error('--rename-project needs a project name');
      const planOptions = { allowFork, adopt, adoptWorker, detach: Boolean(values.detach), retitle, renameProject, ...(slotsOverride ? { slots: slotsOverride } : {}) };
      const unordered = await runner.runPlans(entries, planOptions);
      // Domain scopes first: a child may point at a domain planned in the
      // same run, and apply runs entries in order (replanning each alone),
      // so the domain must be live before its children are applied. Entries
      // travel with their plans — apply pairs them by index.
      const order = domainFirstPlanOrder(unordered);
      const plans = order.map((i) => unordered[i]);
      const orderedEntries = order.map((i) => entries[i]);
      const hash = planHash(plans, config);
      if (plans.some((p) => p.ops.length)) {
        const stored = storeAuthorization(PLAN_DIR, createAuthorization(plans, config, { entries: orderedEntries, ...planOptions }), config);
        if (stored.status === 'kept' && !values.json) console.log(`Existing authorization kept (created ${stored.authorization.createdAt}).`);
      }
      if (values.out) writeFileSync(values.out, `${JSON.stringify({ generatedAt: new Date().toISOString(), hash, plans }, null, 2)}\n`);
      return values.json ? console.log(JSON.stringify({ hash, plans }, null, 2)) : printPlans(plans, hash);
    }

    if (command === 'apply') {
      if (!values.confirm || !/^[0-9a-f]{16}$/.test(values.confirm)) throw new Error('apply needs --confirm <16-hex plan hash> from a stored dry-run');
      // One apply at a time: authorization, progress, rediscovery, every operation,
      // progress/journal writes and the final report all happen inside the lock.
      const result = await withApplyLock(async (held) => {
        const authorization = JSON.parse(readFileSync(join(PLAN_DIR, `${values.confirm}.json`), 'utf8'));
        if (entries.length && JSON.stringify(entries) !== JSON.stringify(authorization.entries)) throw new Error('Repositories differ from the stored plan; omit them or run a new dry-run');
        mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 });
        const journalFile = join(JOURNAL_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
        const outcome = await applyPlans({
          authorization, config, confirm: values.confirm, lookupReceipt: lookupCreationReceipt,
          progress: fileProgress(join(PLAN_DIR, `${values.confirm}.progress.json`)),
          guard: () => held.verify(),
          runPlans: selectApplyRunPlans(authorization, { repoRunPlans: (list, options) => runner.runPlans(list, options), client, git }),
          execute: createExecutors({ client, gh, git, paseoCli: createPaseoCli() }),
          journal: (event) => {
            held.verify();
            appendFileSync(journalFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
          },
        });
        held.verify();
        return { ...outcome, journal: journalFile };
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.report.some((r) => r.status === 'failed')) process.exitCode = 1;
      return;
    }

    if (['status', 'switch', 'fresh', 'workers', 'checkpoint', 'assign', 'resume'].includes(command)) {
      if ((command === 'resume' || command === 'workers') && !entries.length) entries.push(await defaultResumeEntry(client, command));
      if (entries.length !== 1) throw new Error(`${command} needs exactly one repository`);
      const raw = entries[0];
      const { entry: target, scope, deprecatedAlias } = resolveTargetEntry(raw, await readPaseoState(client));
      if (scope && deprecatedAlias) {
        const typed = typeof raw === 'string' ? raw : JSON.stringify(raw);
        console.error(`Note: ${JSON.stringify(typed)} is a legacy alias for scope ${JSON.stringify(scope.id)} (${scope.kind}); prefer the scope id.`);
      }
      const [discovery] = await runner.discoverAll([target]);
      if (command === 'status') {
        const warnContextTokens = config.usage?.warnContextTokens;
        const heuristic = await heuristicInputsForDiscovery(client, discovery).catch(() => null);
        const status = steerStatus(discovery, { warnContextTokens, ...(heuristic ?? {}), config });
        return console.log(values.json ? JSON.stringify(status, null, 2) : formatStatus(status, warnContextTokens));
      }
      if (command === 'fresh') {
        const result = await freshSteer({
          client, discovery, config, apply: Boolean(values.apply), git,
          lookupReceipt: lookupCreationReceipt, language: runtime().handoffLanguage,
          workerModel: workerModelLine(config, discovery),
        });
        console.log(`${result.applied ? 'Refreshed' : 'Dry-run'}: Steer ${result.slot} ${result.from} → ${result.to ?? '(new agent)'} (epoch ${result.epoch}) · profile "${result.profile}" (${result.provider}/${result.model})${result.fallbackFrom ? ` (fallback for "${result.fallbackFrom}")` : ''} · handoff ${result.packetChars} characters, built without a model call${result.checkpoint ? '' : ' · NO task checkpoint'}${result.reused ? ' · agent reused after receipt' : ''}${result.delivered ? ' · delivered' : ''}${result.previousNotified ? ' · previous steer notified' : ''}${result.deliveryError ? ` · delivery failed: ${result.deliveryError}` : ''}${(result.warnings ?? []).map((w) => `\nWarning: ${w}`).join('')}\nNote: the retired steer ${result.from} keeps its chat and labels${result.applied ? ' (a short notice was sent)' : ' (a short notice will be sent on apply)'}; archive it in Paseo — until then the slot stays ambiguous for switch/plan.\n---\n${result.packet}`);
        return;
      }
      if (command === 'switch') {
        if (!values.to) throw new Error('switch needs --to <slot>');
        if (values.language && !['en', 'de'].includes(values.language)) throw new Error('--language must be en or de');
        const result = await switchSteer({
          client, discovery, toSlot: values.to, apply: Boolean(values.apply), send: !values['no-send'], git,
          wait: Boolean(values.wait), notifyPrevious: Boolean(values['notify-previous']), language: values.language ?? runtime().handoffLanguage,
          config, workerModel: workerModelLine(config, discovery),
        });
        console.log(`${result.applied ? 'Switched' : 'Dry-run'}: Steer ${result.from} → ${result.to} (epoch ${result.epoch}) · handoff ${result.packetChars} characters, built without a model call${result.checkpoint ? '' : ' · NO task checkpoint'}${result.delivered ? ' · delivered' : ''}${result.previousNotified ? ' · previous steer notified' : ''}${result.deliveryError ? ` · delivery failed: ${result.deliveryError}` : ''}\n---\n${result.packet}`);
        if (result.reply !== null) console.log(`--- reply of Steer ${result.to}\n${result.reply ?? '(no answer text)'}`);
        return;
      }
      if (command === 'checkpoint') {
        let fields;
        if (values['from-agent']) {
          if (values.task) throw new Error('use either --task or --from-agent');
          const steer = steerStatus(discovery).steers.find((s) => s.id === values['from-agent'] || s.id.startsWith(values['from-agent']));
          if (!steer) throw new Error(`${values['from-agent']} is not a steer of ${discovery.forkName}`);
          const text = lastAssistantText(await client.agents.ref(steer.id).timeline.refetch({ direction: 'tail', limit: 20 }));
          fields = parseCheckpointBlock(text);
          if (!fields) throw new Error(`The last answer of Steer ${steer.slot} has no CHECKPOINT block with a task line`);
        } else {
          if (!values.task) throw new Error('checkpoint needs --task or --from-agent');
          fields = { task: values.task, tests: values.test ?? [], blockers: values.blocker ?? [], next: null };
        }
        if (values.next) fields.next = values.next;
        return console.log(JSON.stringify(await writeCheckpoint({ client, discovery, ...fields }), null, 2));
      }
      if (command === 'assign') {
        if (!values.task) throw new Error('assign needs --task <text>');
        let expectEpoch;
        if (values['expect-epoch'] !== undefined) {
          expectEpoch = Number.parseInt(values['expect-epoch'], 10);
          if (!Number.isInteger(expectEpoch)) throw new Error('--expect-epoch needs an integer epoch from the preview');
        }
        const result = await assignScope({
          client, discovery, task: values.task, tests: values.test ?? [], blockers: values.blocker ?? [],
          next: values.next ?? null, apply: Boolean(values.apply), send: !values['no-send'],
          assignedBy: process.env.PASEO_AGENT_ID ?? null,
          workerModel: workerModelLine(config, discovery),
          ...(expectEpoch !== undefined ? { expectEpoch } : {}),
        });
        if (values.json) return console.log(JSON.stringify(result, null, 2));
        console.log(`${result.applied ? 'Assigned' : 'Dry-run'}: ${result.scope} epoch ${result.epoch} · Steer ${result.slot} ${result.steerId}${result.domain ? ` · domain ${result.domain}` : ''}${(result.domainChildren ?? []).length ? ` · domain of ${result.domainChildren.length} (${result.domainChildren.join(', ')})` : ''}${result.previous ? '' : ' · NO previous checkpoint'}${result.delivered ? ' · delivered' : ''}${result.deliveryError ? ` · delivery failed: ${result.deliveryError}` : ''}`);
        if (result.previous) console.log(`Replaces task: ${result.previous}`);
        console.log(`---\n${result.packet}`);
        if (!result.applied) console.log(`---\nNothing written. Apply: paseo-factory assign ${JSON.stringify(entries[0])} --task ${JSON.stringify(values.task)} --apply`);
        return;
      }
      if (command === 'resume') {
        const heuristic = await heuristicInputsForDiscovery(client, discovery).catch(() => null);
        const status = steerStatus(discovery, { ...(heuristic ?? {}), config });
        const agentState = discovery.mainWorkspace?.metadata?.[AGENTS_KEY] ?? null;
        const brief = buildResumeBrief(status, {
          agentId: values.agent ?? process.env.PASEO_AGENT_ID ?? null,
          agentState,
          git: status.workspace ? readGitBrief(git, status.workspace.directory) : null,
          scope: discovery.scope ?? null,
          ...(heuristic ?? {}),
          config, workerModel: workerModelLine(config, discovery),
        });
        if (values.json) {
          const restartInterrupted = status.restartInterrupted ?? restartInterruptions({ checkpoint: status.checkpoint, agentState });
          return console.log(JSON.stringify({
            scope: discovery.scope?.id ?? discovery.forkName, kind: discovery.scope?.kind ?? null, epoch: status.state?.epoch ?? null,
            agentId: values.agent ?? process.env.PASEO_AGENT_ID ?? null, brief,
            openWorkers: status.openWorkers ?? [],
            interrupted: status.checkpoint?.interrupted ?? null,
            ...(restartInterrupted.length ? { restartInterrupted } : {}),
          }, null, 2));
        }
        return console.log(brief);
      }
      const scopeId = discovery.scope?.id ?? discovery.forkName;
      const epoch = discovery.mainWorkspace?.metadata?.[METADATA_KEY]?.epoch ?? null;
      const report = workersReport(readWorkers(discovery.mainWorkspace?.metadata ?? null));
      if (values.json) return console.log(JSON.stringify({ scope: scopeId, epoch, workers: report }, null, 2));
      return console.log(formatWorkersText(scopeId, epoch, report));
    }

    if (command === 'relocate') {
      if (entries.length !== 1) throw new Error('relocate needs exactly one scope');
      if (!values.to) throw new Error('relocate needs --to <path|project>');
      const raw = entries[0];
      const { entry: target, scope, deprecatedAlias } = resolveTargetEntry(raw, await readPaseoState(client));
      if (scope && deprecatedAlias) {
        const typed = typeof raw === 'string' ? raw : JSON.stringify(raw);
        console.error(`Note: ${JSON.stringify(typed)} is a legacy alias for scope ${JSON.stringify(scope.id)} (${scope.kind}); prefer the scope id.`);
      }
      const [discovery] = await runner.discoverAll([target]);
      const result = await relocateScope({
        client, discovery, config, to: values.to, apply: Boolean(values.apply), git,
        lookupReceipt: lookupCreationReceipt, language: runtime().handoffLanguage,
        workerModel: workerModelLine(config, discovery),
      });
      console.log(`${result.applied ? 'Relocated' : 'Dry-run'}: ${result.scope} ${result.fromWorkspace} → ${result.toDir} (${result.toWorkspace ?? 'new workspace'}) · ${result.steers.length} steer(s) · epoch 1 · movedTo ${result.movedTo}${result.domain ? ` · domain ${result.domain}` : ''}${result.checkpoint ? '' : ' · NO task checkpoint'}${result.delivered.length ? ` · handoffs delivered to ${result.delivered.length}` : ''}${result.previousNotified.length ? ` · ${result.previousNotified.length} previous steer(s) notified` : ''}${result.deliveryErrors.map((d) => ` · delivery failed: ${d.error}`).join('')}${result.notifyErrors.map((d) => ` · notify failed: ${d.error}`).join('')}${(result.notes ?? []).map((n) => `\nNote: ${n}`).join('')}\nNote: the retired scope ${result.fromWorkspace} keeps its agents; archive it via \`cleanup --plan\` (never automatic). Until then, address the new scope by workspace id or path.`);
      for (const packet of result.packets) console.log(`--- Steer ${packet.slot} → ${packet.to ?? '(new agent)'}\n${packet.packet}`);
      return;
    }

    if (command === 'retire') {
      if (entries.length !== 1) throw new Error('retire needs one agent id');
      if (values.apply || values['archive-workspace']) throw new Error('Worker archiving is disabled for the pilot (Paseo removes owned worktrees with --force); retire is preview only');
      const paseo = await readPaseoState(client);
      const worker = paseo.agents.find((a) => a.id === entries[0]);
      const ws = paseo.workspaces.find((w) => w.id === worker?.workspaceId);
      const backgroundWork = worker ? await client.agents.ref(worker.id).backgroundWork.list().catch(() => null) : null;
      const terminals = ws ? await client.terminals.list({ workspaceId: ws.id }).then((r) => r.entries ?? []).catch(() => null) : null;
      const gitState = ws ? readGitState(git, ws.workspaceDirectory) : null;
      return console.log(JSON.stringify(assessWorker(worker, { ...paseo, gitState, backgroundWork, terminals }), null, 2));
    }

    if (command === 'cleanup') {
      if (entries.length) throw new Error('cleanup takes no repository; it reports on the whole instance');
      const paseo = await attachProjectArchivedAgents(await readPaseoState(client), client);
      if (!values.plan) {
        const candidates = collectCleanupCandidates(paseo, { git });
        if (values.json) return console.log(JSON.stringify({ candidates }, null, 2));
        if (!candidates.length) return console.log('No cleanup candidates.');
        return console.log(candidates.map(formatCandidate).join('\n'));
      }
      const only = values.only ? values.only.split(',').map((s) => s.trim()).filter(Boolean) : null;
      if (values.only !== undefined && !only.length) throw new Error('--only needs at least one candidate id');
      const allowDestructive = Boolean(values['allow-destructive']);
      const allowIgnored = Boolean(values['allow-ignored']);
      const { ops, hints } = planCleanupOps(paseo, { allowDestructive, allowIgnored, only, git });
      const plans = [{ repo: 'cleanup', input: 'cleanup', status: ops.length ? 'pending' : 'complete', ops, conflicts: [], notes: hints.map((h) => `hint ${h.id}: ${h.reason}`), observed: {} }];
      const hash = planHash(plans, config);
      if (values.json) return console.log(JSON.stringify({ hash, plans, hints }, null, 2));
      printCleanupPlan(plans[0], hints, hash);
      if (!ops.length) return console.log('Nothing to store: no ops planned.');
      const stored = storeAuthorization(PLAN_DIR, { ...createAuthorization(plans, config, { entries: [{ cleanup: { allowDestructive, allowIgnored, only } }] }), kind: 'cleanup' }, config);
      if (stored.status === 'kept') console.log(`Existing authorization kept (created ${stored.authorization.createdAt}).`);
      return console.log(`Stored for review. Apply: paseo-factory apply --confirm ${hash}`);
    }
    throw new Error(`Unknown command ${command}\n${USAGE}`);
  } finally {
    await client.close().catch(() => {});
  }
}

async function writePlanned({ planned, configPath, dryRun, hint = null }) {
  const lines = [
    dryRun ? `Dry-run: ${planned.summary} (not written)` : planned.summary,
    ...(planned.notes ?? []).map((n) => `Note: ${n}`),
    ...(planned.warnings ?? []).map((w) => `Warning: ${w}`),
    ...(hint ? [hint] : []),
  ];
  if (dryRun) return console.log(`${lines.join('\n')}\n${previewConfig(planned.config)}`);
  await writeConfigAtomic(configPath, planned.config);
  return console.log(`${lines.join('\n')}\nWrote ${configPath}`);
}

async function runModelCommand({ command, args, values, config, configPath, client, runner }) {
  const dryRun = Boolean(values['dry-run']);
  const catalog = async () => (await client.providers.snapshot())?.entries ?? [];
  if (command === 'models') {
    if (args.length) throw new Error('models takes no repository; use paseo-factory models [--json]');
    return console.log(formatCatalog(await catalog(), { json: Boolean(values.json) }));
  }
  if (command === 'model') {
    const [flag, specArg, onOff, ...rest] = args;
    if ((flag !== 'advisor' && flag !== 'sensitive') || !specArg || !onOff || rest.length) {
      throw new Error('model needs advisor|sensitive <profile|provider/model> on|off');
    }
    if (onOff !== 'on' && onOff !== 'off') throw new Error(`model ${flag} needs on|off, got ${JSON.stringify(onOff)}`);
    const plan = flag === 'advisor' ? planAdvisorTag : planSensitiveTag;
    const planned = plan(config, await catalog(), { spec: specArg, on: onOff === 'on' });
    return writePlanned({ planned, configPath, dryRun });
  }
  if (command === 'worker') {
    const [sub, ...rest] = args;
    if (sub === 'list') {
      if (rest.length) throw new Error('worker list takes no arguments');
      const entries = await catalog();
      const priority = workerPriority(config);
      const problems = validateProfilesAgainstCatalog(config, entries, priority);
      const { profile } = resolveProfile(config, entries, priority, { role: 'worker', repoPublic: null });
      const rows = priority.map((name, index) => ({
        position: index + 1, profile: name,
        provider: config.profiles[name]?.provider ?? '?', model: config.profiles[name]?.model ?? '?',
        advisor: isAdvisorProfile(config, name), sensitive: isSensitiveProfile(config, name),
        startable: !problems[name], issues: problems[name] ?? [], chosen: profile?.name === name,
      }));
      if (values.json) return console.log(JSON.stringify({ defaultProfile: config.workers?.defaultProfile ?? null, priority, chosen: profile?.name ?? null, entries: rows }, null, 2));
      const lines = [`Worker priority (default "${config.workers?.defaultProfile ?? '-'}", → currently picked):`];
      for (const row of rows) {
        const tags = `${row.advisor ? ' [advisor]' : ''}${row.sensitive ? ' [sensitive]' : ''}`;
        lines.push(`${row.chosen ? '→' : ' '} ${row.position}. ${row.profile}${tags} ${row.startable ? '✓' : '✗'} ${row.provider}/${row.model}${row.startable ? '' : ` (${row.issues.join('; ')})`}`);
      }
      if (!rows.length) lines.push('(no worker profiles configured)');
      return console.log(lines.join('\n'));
    }
    if (sub === 'set') {
      const [nArg, specArg, ...extra] = rest;
      if (!nArg || !specArg || extra.length) throw new Error('worker set needs <n> <profile|provider/model>');
      const planned = planWorkerSet(config, await catalog(), {
        n: nArg, spec: specArg,
        thinking: flagValue(values.thinking), mode: flagValue(values.mode), profile: values.profile,
      });
      return writePlanned({ planned, configPath, dryRun });
    }
    if (sub === 'rm') {
      const [nArg, ...extra] = rest;
      if (!nArg || extra.length) throw new Error('worker rm needs <n>');
      const planned = planWorkerRemove(config, nArg);
      return writePlanned({ planned, configPath, dryRun });
    }
    if (sub === 'pick') {
      const [scopeArg, ...extra] = rest;
      if (extra.length) throw new Error('worker pick takes at most one scope');
      if (values.failed !== undefined && !values.reason) throw new Error('worker pick --failed needs --reason <text>');
      if (values.reason !== undefined && values.failed === undefined) throw new Error('worker pick --reason needs --failed <profile>');
      let entries;
      let repoPublic = null;
      let discovery = null;
      let scopeAddress = scopeArg ?? null;
      let paseoState = null;
      if (!scopeAddress) {
        paseoState = await readPaseoState(client);
        scopeAddress = defaultPickAddress(paseoState);
      }
      if (scopeAddress) {
        paseoState ??= await readPaseoState(client);
        const { entry: target } = resolveTargetEntry(scopeAddress, paseoState);
        [discovery] = await runner.discoverAll([target]);
        entries = discovery.providers ?? [];
        const priv = discovery.github?.fork?.repo?.private;
        repoPublic = priv === false ? true : priv === true ? false : null;
      } else {
        if (values.failed !== undefined) throw new Error('worker pick --failed needs a scope so the failure can be recorded');
        entries = await catalog();
      }
      let profileHealth = discovery?.mainWorkspace?.metadata?.[METADATA_KEY]?.profileHealth ?? null;
      if (values.failed !== undefined) {
        const failed = config.profiles?.[values.failed];
        if (!failed) throw new Error(`Unknown profile "${values.failed}"`);
        const record = recordProfileFailure({ ...failed, name: values.failed }, values.reason);
        const metadata = discovery.mainWorkspace?.metadata?.[METADATA_KEY] ?? {};
        profileHealth = { ...(metadata.profileHealth ?? {}), [values.failed]: record };
        await client.workspaces.ref(discovery.mainWorkspace.id).setMetadata({ [METADATA_KEY]: { ...metadata, profileHealth } });
      }
      const { profile, skipped } = resolveProfile(config, entries, workerPriority(config), { role: 'worker', repoPublic, profileHealth });
      if (!profile) {
        const tried = skipped.length ? skipped.map((s) => `"${s.name}" (${s.reason})`).join('; ') : 'no worker profiles configured';
        throw new Error(`No startable worker profile (tried ${tried})`);
      }
      if (values.json) {
        return console.log(JSON.stringify({ profile: profile.name, provider: profile.provider, model: profile.model, thinking: profile.thinking ?? null, mode: profile.mode ?? null, sensitive: isSensitiveProfile(config, profile.name), flags: paseoRunFlags(profile), skipped, repoPublic }, null, 2));
      }
      const lines = [
        `Worker pick: "${profile.name}" (${profile.provider}/${profile.model})${isSensitiveProfile(config, profile.name) ? ' [sensitive: give only sanitized technical tasks]' : ''}`,
        `paseo run ${paseoRunFlags(profile)}`,
        ...skipped.map((s) => `skipped "${s.name}": ${s.reason}`),
      ];
      return console.log(lines.join('\n'));
    }
    throw new Error(`Unknown worker command ${sub ?? '(none)'}\n${USAGE}`);
  }
  if (command === 'steer') {
    const [sub, ...rest] = args;
    if (sub === 'list') {
      if (rest.length) throw new Error('steer list takes no arguments');
      const entries = await catalog();
      const rows = slotOrder(config).map((slot, index) => {
        const name = config.steers.slots[slot];
        const problems = validateProfilesAgainstCatalog(config, entries, [name]);
        const { profile } = resolveProfile(config, entries, steerFallbackList(config, slot), { role: 'steer', advisorSlot: isAdvisorSlot(config, slot) });
        return {
          position: index + 1, slot, profile: name,
          provider: config.profiles[name]?.provider ?? '?', model: config.profiles[name]?.model ?? '?',
          advisor: isAdvisorSlot(config, slot), sensitive: isSensitiveSlot(config, slot),
          startable: !problems[name], issues: problems[name] ?? [],
          fallback: profile && profile.name !== name ? profile.name : null,
        };
      });
      if (values.json) return console.log(JSON.stringify({ slots: rows }, null, 2));
      const lines = ['Steer slots (priority order, no scope: duplicates cannot be excluded):'];
      for (const row of rows) {
        const tags = `${row.advisor ? ' [advisor]' : ''}${row.sensitive ? ' [sensitive]' : ''}`;
        lines.push(`${row.position}. ${row.slot} → "${row.profile}"${tags} ${row.startable ? '✓' : '✗'} ${row.provider}/${row.model}${row.startable ? '' : ` (${row.issues.join('; ')})`}${row.fallback ? ` → fallback "${row.fallback}"` : ''}`);
      }
      return console.log(lines.join('\n'));
    }
    if (sub === 'set') {
      const [targetArg, specArg, ...extra] = rest;
      if (!targetArg || !specArg || extra.length) throw new Error('steer set needs <n|slot> <profile|provider/model>');
      const planned = planSteerSet(config, await catalog(), {
        target: targetArg, spec: specArg,
        thinking: flagValue(values.thinking), mode: flagValue(values.mode), profile: values.profile,
      });
      return writePlanned({ planned, configPath, dryRun, hint: planned.hint });
    }
    if (sub === 'rm') {
      const [targetArg, ...extra] = rest;
      if (!targetArg || extra.length) throw new Error('steer rm needs <n|slot>');
      const planned = planSteerRemove(config, targetArg);
      return writePlanned({ planned, configPath, dryRun });
    }
    throw new Error(`Unknown steer command ${sub ?? '(none)'}\n${USAGE}`);
  }
  if (command === 'slot') {
    const [sub, slotArg, specArg, ...rest] = args;
    if (sub === 'set') {
      if (!slotArg || !specArg || rest.length) throw new Error('slot set needs <A-Z> <provider/model>');
      console.error('Note: "slot set" is deprecated, use "steer set".');
      const { provider, model } = parseProviderModel(specArg);
      const planned = planSlotSet(config, await catalog(), {
        slot: slotArg.toUpperCase(), provider, model,
        thinking: flagValue(values.thinking), mode: flagValue(values.mode), profile: values.profile,
      });
      return writePlanned({ planned, configPath, dryRun, hint: planned.hint });
    }
    if (sub === 'rm') {
      if (!slotArg || specArg || rest.length) throw new Error('slot rm needs <A-Z>');
      console.error('Note: "slot rm" is deprecated, use "steer rm".');
      const planned = planSlotRemove(config, slotArg.toUpperCase());
      return writePlanned({ planned, configPath, dryRun });
    }
    throw new Error(`Unknown slot command ${sub ?? '(none)'}\n${USAGE}`);
  }
  const [specArg, ...rest] = args;
  if (!specArg || rest.length) throw new Error('worker-default needs <profile|provider/model>');
  console.error('Note: "worker-default" is deprecated, use "worker set 1".');
  const planned = planWorkerDefault(config, await catalog(), {
    spec: specArg, thinking: flagValue(values.thinking), mode: flagValue(values.mode), profile: values.profile,
  });
  return writePlanned({ planned, configPath, dryRun });
}

function formatDrain(result) {
  const waited = `${Math.round((result.waitedMs ?? 0) / 1000)}s`;
  const timeout = `${Math.round((result.timeoutMs ?? 0) / 1000)}s`;
  const initial = result.initial ?? [];
  if (result.clean && !initial.length) return 'Drain: no running factory agents — safe to restart.';
  if (result.clean) return `Drain: ${initial.length} factory agent(s) idle after ${waited} — safe to restart.`;
  const markedIds = new Set((result.marked ?? []).map((m) => m.agentId));
  const lines = [`Drain: timeout after ${waited} (limit ${timeout}), ${result.running.length} still running — marked planned-restart, exit 2:`];
  for (const a of result.running) {
    const what = a.role === 'steer' && a.slot ? `steer ${a.slot}` : a.role;
    lines.push(`  - ${a.id} ${what} in ${a.scopeId} ${a.status}${markedIds.has(a.id) ? ' — marked planned-restart' : ' — NOT marked (scope gone)'}`);
  }
  lines.push('Restart would interrupt them; run status/resume for the last answer tails.');
  return lines.join('\n');
}

// Importable for tests (defaultPickAddress); only run when executed directly.
const invokedAsMain = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
