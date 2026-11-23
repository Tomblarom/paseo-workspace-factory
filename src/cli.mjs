#!/usr/bin/env node
// Paseo Workspace Factory. Dry-run is the default; every write needs --apply.
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, defaultConfigPath } from './config.mjs';
import { configureRuntime, runtime } from './runtime.mjs';
import { createGh } from './github.mjs';
import { createGit } from './local.mjs';
import { LABEL, connect, createPaseoCli, lookupCreationReceipt, readPaseoState } from './paseo.mjs';
import { createRunner } from './factory.mjs';
import { planHash } from './planner.mjs';
import { applyPlans, createExecutors, createAuthorization, storeAuthorization, fileProgress, withApplyLock } from './apply.mjs';
import { steerStatus, switchSteer, freshSteer, writeCheckpoint, parseCheckpointBlock, lastAssistantText, resolveTargetEntry, buildResumeBrief, readGitBrief } from './steer.mjs';
import { AGENTS_KEY } from './agent-state.mjs';
import { assessWorker, readGitState } from './workers.mjs';
import { assignScope } from './assign.mjs';
import { flagValue, formatCatalog, parseProviderModel, planSlotRemove, planSlotSet, planWorkerDefault, previewConfig, writeConfigAtomic } from './models.mjs';
import { scopeRows, scopeCandidates, formatScopeRows, formatScopeCandidates } from './scopes-view.mjs';
import { attachProjectArchivedAgents, collectCleanupCandidates, formatCandidate, formatLoss, planCleanupOps, selectApplyRunPlans } from './cleanup.mjs';
import { relocateScope } from './relocate.mjs';

const USAGE = `Usage: paseo-factory <command> [options]
  plan   <repo...> [--repos-file f.json] [--local <path>]... [--name <id>] [--subject <text>] [--hub <path|workspace:id>] [--allow-fork] [--adopt <scope-id>:A=<agent-id>] [--adopt-worker <agent-id>[@A]] [--detach] [--slots A,B] [--retitle] [--rename-project <name>] [--json] [--out f.json]
  apply  --confirm <hash>             run the stored dry-run plan; resumes after a failure
  status <repo> [--json]
  checkpoint <repo> --task <text> [--test <text>]... [--blocker <text>]... [--next <text>]
  checkpoint <repo> --from-agent <steer-id> [--next <text>]   take the CHECKPOINT block of its last answer
  switch <repo> --to <slot> [--apply] [--no-send] [--wait] [--notify-previous] [--language en|de]
  fresh <repo> [--apply]       hand the active steer to a new agent of the same slot/profile
  relocate <scope> --to <path|project> [--apply]
  assign <scope> --task <text> [--test <text>]... [--blocker <text>]... [--next <text>] [--apply] [--no-send]
  resume [scope] [--agent <id>] [--json]   cold-start brief: task, next step, git, workers
  workers <repo>                     preview only
  retire <agent-id>                  preview only; archiving is disabled
  cleanup [--json]                   read-only cleanup report over the whole instance
  cleanup --plan [--allow-destructive] [--allow-ignored] [--only <id,...>] [--json]
  models [--json]                    list the live provider catalog
  slot set <A-Z> <provider/model> [--thinking X] [--mode Y] [--profile name] [--dry-run]
  slot rm <A-Z> [--dry-run]
  worker-default <profile|provider/model> [--thinking X] [--mode Y] [--profile name] [--dry-run]
  scopes [--json] [--candidates]   one line per live scope; --candidates lists unadopted workspaces
--adopt SLOT=<agent-id> needs exactly one repository; with several entries use --adopt <scope-id>:SLOT=<agent-id> per entry.
--local is repeatable and plans existing directories without GitHub (no fork, clone or upstream remote); dir/workspace entries may carry "name" for the scope id (or --name with one entry).
local/<folder> stays an input alias only; scopes are addressed by id (owner/repo, folder/--name, <parent>@<branch>).
A --local worktree directory (or {"workspace": <id>}, "workspace:<id>") adopts that Paseo worktree workspace as the main workspace without a new project; status/checkpoint/switch/fresh/workers accept its scope id, local/<folder> alias or workspace id.
Main titles follow the workspaceTitle template ({name}, {subject}); a deviating title is only reported unless --retitle plans a rename. --rename-project renames the scope project (one entry).
--hub plans a hub-kind scope (at most one live; an existing dir scope converts, steers/epoch/checkpoint untouched).
--adopt-worker labels an agent as scope worker (stays in its workspace); --detach plans a native detach for parented steer candidates.
Options: --config <path> (default: $PASEO_FACTORY_CONFIG or ~/.config/paseo-workspace-factory/config.json); --dry-run previews config writes`;

/**
 * Default scope for bare `resume`: the calling agent's own scope label first
 * (it also covers workers in foreign workspaces), else the calling workspace.
 */
async function defaultResumeEntry(client) {
  const agentId = process.env.PASEO_AGENT_ID;
  const workspaceId = process.env.PASEO_WORKSPACE_ID;
  if (agentId || workspaceId) {
    const paseo = await readPaseoState(client);
    const scopeId = agentId ? paseo.agents.find((a) => a.id === agentId)?.labels?.[LABEL.scope] : null;
    if (typeof scopeId === 'string' && scopeId) return scopeId;
    if (workspaceId) return `workspace:${workspaceId}`;
  }
  throw new Error('resume needs a scope (or run it inside a factory agent or workspace)');
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
      'adopt-worker': { type: 'string', multiple: true }, detach: { type: 'boolean' }, agent: { type: 'string' },
      thinking: { type: 'string' }, mode: { type: 'string' }, profile: { type: 'string' }, 'dry-run': { type: 'boolean' },
      candidates: { type: 'boolean' }, plan: { type: 'boolean' }, 'allow-destructive': { type: 'boolean' }, 'allow-ignored': { type: 'boolean' }, only: { type: 'string' },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) return console.log(USAGE);
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
  if (localFlags.length && (command === 'models' || command === 'slot' || command === 'worker-default' || command === 'retire')) {
    throw new Error(`--local is not accepted with ${command}`);
  }
  if (hubFlags.length && (command === 'models' || command === 'slot' || command === 'worker-default' || command === 'retire')) {
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
  if (values.retitle && command !== 'plan') throw new Error('--retitle is only accepted with plan');
  if (values['rename-project'] !== undefined && command !== 'plan') throw new Error('--rename-project is only accepted with plan');
  if (values['rename-project'] !== undefined && entries.length !== 1) throw new Error('--rename-project needs exactly one repository entry');
  const gh = createGh();
  const git = createGit();
  const client = await connect();
  try {
    if (command === 'models' || command === 'slot' || command === 'worker-default') {
      return await runModelCommand({ command, args, values, config, configPath, client });
    }
    if (command === 'scopes') {
      if (entries.length) throw new Error('scopes takes no repository; use paseo-factory scopes [--json] [--candidates]');
      const paseo = await readPaseoState(client);
      if (values.candidates) {
        const rows = scopeCandidates(paseo);
        return console.log(values.json ? JSON.stringify(rows, null, 2) : formatScopeCandidates(rows));
      }
      const rows = scopeRows(paseo);
      return console.log(values.json ? JSON.stringify(rows, null, 2) : formatScopeRows(rows));
    }
    const runner = createRunner({ config, client, gh, git });
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
      const plans = await runner.runPlans(entries, planOptions);
      const hash = planHash(plans, config);
      if (plans.some((p) => p.ops.length)) {
        const stored = storeAuthorization(PLAN_DIR, createAuthorization(plans, config, { entries, ...planOptions }), config);
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
      if (command === 'resume' && !entries.length) entries.push(await defaultResumeEntry(client));
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
        const status = steerStatus(discovery, { warnContextTokens });
        return console.log(values.json ? JSON.stringify(status, null, 2) : formatStatus(status, warnContextTokens));
      }
      if (command === 'fresh') {
        const result = await freshSteer({
          client, discovery, config, apply: Boolean(values.apply), git,
          lookupReceipt: lookupCreationReceipt, language: runtime().handoffLanguage,
        });
        console.log(`${result.applied ? 'Refreshed' : 'Dry-run'}: Steer ${result.slot} ${result.from} → ${result.to ?? '(new agent)'} (epoch ${result.epoch}) · profile "${result.profile}" (${result.provider}/${result.model}) · handoff ${result.packetChars} characters, built without a model call${result.checkpoint ? '' : ' · NO task checkpoint'}${result.reused ? ' · agent reused after receipt' : ''}${result.delivered ? ' · delivered' : ''}${result.previousNotified ? ' · previous steer notified' : ''}${result.deliveryError ? ` · delivery failed: ${result.deliveryError}` : ''}\nNote: the retired steer ${result.from} keeps its chat and labels${result.applied ? ' (a short notice was sent)' : ' (a short notice will be sent on apply)'}; archive it in Paseo — until then the slot stays ambiguous for switch/plan.\n---\n${result.packet}`);
        return;
      }
      if (command === 'switch') {
        if (!values.to) throw new Error('switch needs --to <slot>');
        if (values.language && !['en', 'de'].includes(values.language)) throw new Error('--language must be en or de');
        const result = await switchSteer({
          client, discovery, toSlot: values.to, apply: Boolean(values.apply), send: !values['no-send'], git,
          wait: Boolean(values.wait), notifyPrevious: Boolean(values['notify-previous']), language: values.language ?? runtime().handoffLanguage,
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
          ...(expectEpoch !== undefined ? { expectEpoch } : {}),
        });
        if (values.json) return console.log(JSON.stringify(result, null, 2));
        console.log(`${result.applied ? 'Assigned' : 'Dry-run'}: ${result.scope} epoch ${result.epoch} · Steer ${result.slot} ${result.steerId}${result.previous ? '' : ' · NO previous checkpoint'}${result.delivered ? ' · delivered' : ''}${result.deliveryError ? ` · delivery failed: ${result.deliveryError}` : ''}`);
        if (result.previous) console.log(`Replaces task: ${result.previous}`);
        console.log(`---\n${result.packet}`);
        if (!result.applied) console.log(`---\nNothing written. Apply: paseo-factory assign ${JSON.stringify(entries[0])} --task ${JSON.stringify(values.task)} --apply`);
        return;
      }
      if (command === 'resume') {
        const status = steerStatus(discovery, {});
        const brief = buildResumeBrief(status, {
          agentId: values.agent ?? process.env.PASEO_AGENT_ID ?? null,
          agentState: discovery.mainWorkspace?.metadata?.[AGENTS_KEY] ?? null,
          git: status.workspace ? readGitBrief(git, status.workspace.directory) : null,
          scope: discovery.scope ?? null,
        });
        if (values.json) {
          return console.log(JSON.stringify({ scope: discovery.scope?.id ?? discovery.forkName, kind: discovery.scope?.kind ?? null, epoch: status.state?.epoch ?? null, agentId: values.agent ?? process.env.PASEO_AGENT_ID ?? null, brief }, null, 2));
        }
        return console.log(brief);
      }
      const paseo = await readPaseoState(client);
      const rows = discovery.workers.map((worker) => {
        const ws = paseo.workspaces.find((w) => w.id === worker.workspaceId);
        return { id: worker.id, title: worker.title, ...assessWorker(worker, { ...paseo, gitState: ws ? readGitState(git, ws.workspaceDirectory) : null }) };
      });
      console.log('Preview only. Background work and terminals are checked per agent by `retire <id>`.');
      return console.log(JSON.stringify(rows, null, 2));
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
      });
      console.log(`${result.applied ? 'Relocated' : 'Dry-run'}: ${result.scope} ${result.fromWorkspace} → ${result.toDir} (${result.toWorkspace ?? 'new workspace'}) · ${result.steers.length} steer(s) · epoch 1 · movedTo ${result.movedTo}${result.checkpoint ? '' : ' · NO task checkpoint'}${result.delivered.length ? ` · handoffs delivered to ${result.delivered.length}` : ''}${result.previousNotified.length ? ` · ${result.previousNotified.length} previous steer(s) notified` : ''}${result.deliveryErrors.map((d) => ` · delivery failed: ${d.error}`).join('')}${result.notifyErrors.map((d) => ` · notify failed: ${d.error}`).join('')}\nNote: the retired scope ${result.fromWorkspace} keeps its agents; archive it via \`cleanup --plan\` (never automatic). Until then, address the new scope by workspace id or path.`);
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

async function runModelCommand({ command, args, values, config, configPath, client }) {
  const dryRun = Boolean(values['dry-run']);
  if (command === 'models') {
    if (args.length) throw new Error('models takes no repository; use paseo-factory models [--json]');
    const snapshot = await client.providers.snapshot();
    return console.log(formatCatalog(snapshot?.entries ?? [], { json: Boolean(values.json) }));
  }
  if (command === 'slot') {
    const [sub, slotArg, specArg, ...rest] = args;
    if (sub === 'set') {
      if (!slotArg || !specArg || rest.length) throw new Error('slot set needs <A-Z> <provider/model>');
      const { provider, model } = parseProviderModel(specArg);
      const snapshot = await client.providers.snapshot();
      const planned = planSlotSet(config, snapshot?.entries ?? [], {
        slot: slotArg.toUpperCase(), provider, model,
        thinking: flagValue(values.thinking), mode: flagValue(values.mode), profile: values.profile,
      });
      if (dryRun) return console.log(`Dry-run: ${planned.summary} (not written)\n${previewConfig(planned.config)}`);
      await writeConfigAtomic(configPath, planned.config);
      return console.log(`${planned.summary}\n${planned.hint}\nWrote ${configPath}`);
    }
    if (sub === 'rm') {
      if (!slotArg || specArg || rest.length) throw new Error('slot rm needs <A-Z>');
      const planned = planSlotRemove(config, slotArg.toUpperCase());
      if (dryRun) return console.log(`Dry-run: ${planned.summary} (not written)\n${previewConfig(planned.config)}`);
      await writeConfigAtomic(configPath, planned.config);
      return console.log(`${planned.summary}\nWrote ${configPath}`);
    }
    throw new Error(`Unknown slot command ${sub ?? '(none)'}\n${USAGE}`);
  }
  const [specArg, ...rest] = args;
  if (!specArg || rest.length) throw new Error('worker-default needs <profile|provider/model>');
  const snapshot = await client.providers.snapshot();
  const planned = planWorkerDefault(config, snapshot?.entries ?? [], {
    spec: specArg, thinking: flagValue(values.thinking), mode: flagValue(values.mode), profile: values.profile,
  });
  if (dryRun) return console.log(`Dry-run: ${planned.summary} (not written)\n${previewConfig(planned.config)}`);
  await writeConfigAtomic(configPath, planned.config);
  return console.log(`${planned.summary}\nWrote ${configPath}`);
}

function formatUsage(usage) {
  if (!usage) return 'ctx n/a';
  const pct = usage.maxTokens > 0 ? ` (${Math.round((usage.usedTokens / usage.maxTokens) * 100)}%)` : '';
  return `ctx ${usage.usedTokens}/${usage.maxTokens}${pct}`;
}

function formatStatus(status, warnContextTokens) {
  const retired = status.state?.retired === true ? ` · RETIRED${status.state.movedTo ? ` → ${status.state.movedTo}` : ''}` : '';
  const lines = [`${status.repo} · workspace ${status.workspace?.id ?? '(none)'}${status.worktree ? ' (worktree)' : ''} · active Steer ${status.state?.activeSteer ?? '-'} (epoch ${status.state?.epoch ?? '-'})${retired}`];
  const cp = status.checkpoint;
  if (cp?.task) {
    const stale = cp.epoch !== status.state?.epoch ? ` · from epoch ${cp.epoch}, older than the current one` : '';
    lines.push(`  checkpoint ${cp.updatedAt}${stale}`, `    task: ${cp.task}`);
    if (cp.next) lines.push(`    next: ${cp.next}`);
    if (cp.interrupted) lines.push(typeof cp.interrupted === 'object' ? `    ! interrupted: ${cp.interrupted.agentId ?? 'unknown agent'} at ${cp.interrupted.at ?? 'unknown time'} — run resume for the last answer tail` : '    ! interrupted — run resume for details');
  } else {
    lines.push('  checkpoint: none');
  }
  for (const s of status.steers) lines.push(`  Steer ${s.slot}  ${s.id}  ${s.provider}/${s.model}  ${s.status}  ${formatUsage(s.usage)}${s.retired ? '  RETIRED — archive it in Paseo' : ''}${s.parent ? `  PARENT ${s.parent}` : ''}`);
  for (const w of status.workers) lines.push(`  worker ${w.id} "${w.title}" ${w.provider}/${w.model} ${w.status}  ${formatUsage(w.usage)} ← Steer ${w.parentSlot ?? w.owner ?? '?'}${w.workspaceId && status.workspace && w.workspaceId !== status.workspace.id ? ` · workspace ${w.workspaceId}` : ''}`);
  for (const warn of status.usageWarnings ?? []) {
    lines.push(warn.kind === 'steer'
      ? `  ! Steer ${warn.slot} context ${warn.usedTokens}/${warn.maxTokens} tokens exceeds usage.warnContextTokens=${warnContextTokens}; consider checkpoint + switch/fresh (docs/saving-context.md)`
      : `  ! worker ${warn.id} context ${warn.usedTokens}/${warn.maxTokens} tokens exceeds usage.warnContextTokens=${warnContextTokens}; consider retiring and recreating it`);
  }
  return lines.join('\n');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
