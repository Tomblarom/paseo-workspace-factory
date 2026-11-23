#!/usr/bin/env node
// Paseo Workspace Factory. Dry-run is the default; every write needs --apply.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, defaultConfigPath } from './config.mjs';
import { configureRuntime, runtime } from './runtime.mjs';
import { createGh } from './github.mjs';
import { createGit } from './local.mjs';
import { connect, createPaseoCli, lookupCreationReceipt, readPaseoState } from './paseo.mjs';
import { createRunner } from './factory.mjs';
import { planHash } from './planner.mjs';
import { applyPlans, createExecutors, createAuthorization, storeAuthorization, fileProgress, withApplyLock } from './apply.mjs';
import { steerStatus, switchSteer, writeCheckpoint, parseCheckpointBlock, lastAssistantText } from './steer.mjs';
import { assessWorker, readGitState } from './workers.mjs';

const USAGE = `Usage: paseo-factory <command> [options]
  plan   <repo...> [--repos-file f.json] [--allow-fork] [--adopt A=<agent-id>] [--json] [--out f.json]
  apply  --confirm <hash>             run the stored dry-run plan; resumes after a failure
  status <repo> [--json]
  checkpoint <repo> --task <text> [--test <text>]... [--blocker <text>]... [--next <text>]
  checkpoint <repo> --from-agent <steer-id> [--next <text>]   take the CHECKPOINT block of its last answer
  switch <repo> --to <slot> [--apply] [--no-send] [--wait] [--notify-previous] [--language en|de]
  workers <repo>                     preview only
  retire <agent-id>                  preview only; archiving is disabled
--adopt is only accepted with exactly one repository.
Options: --config <path> (default: $PASEO_FACTORY_CONFIG or ~/.config/paseo-workspace-factory/config.json)`;

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

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' }, 'repos-file': { type: 'string' }, 'allow-fork': { type: 'boolean' },
      json: { type: 'boolean' }, confirm: { type: 'string' }, to: { type: 'string' }, apply: { type: 'boolean' },
      'no-send': { type: 'boolean' }, 'archive-workspace': { type: 'boolean' }, help: { type: 'boolean' },
      adopt: { type: 'string', multiple: true }, out: { type: 'string' }, task: { type: 'string' },
      test: { type: 'string', multiple: true }, blocker: { type: 'string', multiple: true },
      next: { type: 'string' }, 'from-agent': { type: 'string' }, wait: { type: 'boolean' },
      'notify-previous': { type: 'boolean' }, language: { type: 'string' },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) return console.log(USAGE);
  const config = await loadConfig(values.config ?? defaultConfigPath());
  const { planDir: PLAN_DIR, journalDir: JOURNAL_DIR } = configureRuntime(config);
  const entries = [...args, ...(values['repos-file'] ? JSON.parse(readFileSync(values['repos-file'], 'utf8')) : [])];
  const gh = createGh();
  const git = createGit();
  const client = await connect();
  try {
    const runner = createRunner({ config, client, gh, git });
    const allowFork = Boolean(values['allow-fork']);
    const adoptPairs = (values.adopt ?? []).flatMap((v) => v.split(',')).filter(Boolean);
    if (adoptPairs.length && entries.length !== 1) throw new Error('--adopt needs exactly one repository');
    const adopt = { '*': Object.fromEntries(adoptPairs.map((pair) => {
      const match = pair.match(/^([A-Z])=([0-9a-f-]{8,})$/i);
      if (!match) throw new Error(`--adopt expects SLOT=<agent-id>, got ${pair}`);
      return [match[1].toUpperCase(), match[2]];
    })) };

    if (command === 'plan') {
      if (!entries.length) throw new Error('plan needs at least one repository');
      const plans = await runner.runPlans(entries, { allowFork, adopt });
      const hash = planHash(plans, config);
      if (plans.some((p) => p.ops.length)) {
        const stored = storeAuthorization(PLAN_DIR, createAuthorization(plans, config, { entries, allowFork, adopt }), config);
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
          runPlans: (list, options) => runner.runPlans(list, options),
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

    if (['status', 'switch', 'workers', 'checkpoint'].includes(command)) {
      if (entries.length !== 1) throw new Error(`${command} needs exactly one repository`);
      const [discovery] = await runner.discoverAll(entries);
      if (command === 'status') {
        const status = steerStatus(discovery);
        return console.log(values.json ? JSON.stringify(status, null, 2) : formatStatus(status));
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
      const paseo = await readPaseoState(client);
      const rows = discovery.workers.map((worker) => {
        const ws = paseo.workspaces.find((w) => w.id === worker.workspaceId);
        return { id: worker.id, title: worker.title, ...assessWorker(worker, { ...paseo, gitState: ws ? readGitState(git, ws.workspaceDirectory) : null }) };
      });
      console.log('Preview only. Background work and terminals are checked per agent by `retire <id>`.');
      return console.log(JSON.stringify(rows, null, 2));
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
    throw new Error(`Unknown command ${command}\n${USAGE}`);
  } finally {
    await client.close().catch(() => {});
  }
}

function formatStatus(status) {
  const lines = [`${status.repo} · workspace ${status.workspace?.id ?? '(none)'} · active Steer ${status.state?.activeSteer ?? '-'} (epoch ${status.state?.epoch ?? '-'})`];
  const cp = status.checkpoint;
  if (cp?.task) {
    const stale = cp.epoch !== status.state?.epoch ? ` · from epoch ${cp.epoch}, older than the current one` : '';
    lines.push(`  checkpoint ${cp.updatedAt}${stale}`, `    task: ${cp.task}`);
    if (cp.next) lines.push(`    next: ${cp.next}`);
  } else {
    lines.push('  checkpoint: none');
  }
  for (const s of status.steers) lines.push(`  Steer ${s.slot}  ${s.id}  ${s.provider}/${s.model}  ${s.status}${s.parent ? `  PARENT ${s.parent}` : ''}`);
  for (const w of status.workers) lines.push(`  worker ${w.id} "${w.title}" ${w.provider}/${w.model} ${w.status} ← Steer ${w.parentSlot ?? '?'}`);
  return lines.join('\n');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
