#!/usr/bin/env node
// Paseo Workspace Factory — thin RPC client of the running Paseo plugin.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { connectPluginRpc } from '../plugin/server/core/paseo.mjs';
import { FACTORY_PLUGIN_ID } from '../plugin/server/core/findings.mjs';

const USAGE = `Usage: paseo-factory <command> [options]
  status [scope] [--json]
  resume [scope] [--agent <id>] [--json]   cold-start brief: task, next step, git, workers
  resume [scope] --agent <worker> --apply [--json]   continue an interrupted worker via the plugin
  checkpoint [scope] --task <text> [--test <text>]... [--blocker <text>]... [--next <text>]
  checkpoint [scope] --from-agent <steer-id> [--next <text>]   take the CHECKPOINT block of its last answer
  switch [scope] --to <slot> [--apply] [--no-send] [--wait] [--notify-previous] [--language en|de]
  assign <scope> --task <text> [--test <text>]... [--blocker <text>]... [--next <text>] [--report-to <agent-id>] [--expect-epoch <n>] [--apply] [--no-send] [--json]   (report-to defaults to the calling agent)
  workers [scope] [--prune] [--apply] [--json]   print the worker register (task, state, resumes); --prune removes entries whose agent is gone
  worker pick [scope] [--failed <profile> --reason <text>] [--json]   chosen worker profile plus paseo run flags
  worker start [scope] --task <text> [--title <title>] [--apply] [--json]   start a worker from the active steer
  worker list [scope] [--json]         worker priority with availability; → marks what worker pick returns
  help

Requires the running workspace-factory Paseo plugin. Setup and management commands (plan, apply, fresh, steer, model, models, scopes, cleanup, drain) live in /factory in the Paseo composer.`;

const REMOVED_COMMANDS = new Set(['plan', 'apply', 'fresh', 'steer', 'model', 'models', 'scopes', 'cleanup', 'drain']);

const BOOL = { type: 'boolean' };
const STR = { type: 'string' };
const OPTIONS = {
  json: BOOL, help: { type: 'boolean', short: 'h' }, to: STR, apply: BOOL, 'no-send': BOOL,
  wait: BOOL, 'notify-previous': BOOL, language: STR, task: STR,
  test: { type: 'string', multiple: true }, blocker: { type: 'string', multiple: true }, next: STR,
  'from-agent': STR, 'from-steer': STR, 'report-to': STR, 'expect-epoch': STR,
  agent: STR, prune: BOOL, title: STR, failed: STR, reason: STR,
};

function omit(obj, keys) {
  const copy = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
}

function need(res, method, field = 'text') {
  if (res?.[field] === undefined) {
    throw new Error(`Workspace Factory plugin (workspace-factory) is older than this CLI (missing ${method} ${field}); reload it with \`paseo plugin reload workspace-factory\`.`);
  }
  return res[field];
}

function noteAlias(res, scopeArg, err) {
  const scope = res?.scopeInfo ?? (res?.scope && typeof res.scope === 'object' ? res.scope : null);
  if (scopeArg && res?.deprecatedAlias && scope?.id) {
    err(`Note: ${JSON.stringify(scopeArg)} is a legacy alias for scope ${JSON.stringify(scope.id)} (${scope.kind}); prefer the scope id.`);
  }
}

function formatPluginRpcError(error, method) {
  const msg = error instanceof Error ? error.message : String(error);
  if (/Plugin is not available|Plugin service is unavailable/i.test(msg)) {
    return new Error('Workspace Factory plugin (workspace-factory) is not running; enable or install it in Paseo Settings -> Plugins (or run `paseo plugin ls workspace-factory`).');
  }
  if (/does not contribute RPC/i.test(msg)) {
    return new Error(`Workspace Factory plugin (workspace-factory) is older than this CLI (missing ${method}); reload it with \`paseo plugin reload workspace-factory\`.`);
  }
  return error instanceof Error ? error : new Error(msg);
}

async function openRpc(connectRpc) {
  let rpc;
  try {
    rpc = await connectRpc();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Workspace Factory plugin is not reachable (${msg}); start Paseo and ensure workspace-factory is running (\`paseo plugin ls workspace-factory\`).`);
  }
  return {
    async call(method, input) {
      try {
        return await rpc.invokePluginRpc(FACTORY_PLUGIN_ID, method, input);
      } catch (error) {
        throw formatPluginRpcError(error, method);
      }
    },
    close: () => rpc?.close?.().catch(() => {}),
  };
}

function targetInput(scope, env) {
  if (scope) return { repo: scope };
  if (env.PASEO_WORKSPACE_ID) return { workspaceId: env.PASEO_WORKSPACE_ID };
  return {};
}

function oneScope(command, args) {
  if (args.length > 1) throw new Error(`${command} takes at most one scope, got ${args.length}`);
  return args[0] ?? null;
}

export async function runCli(argv = process.argv.slice(2), { connectRpc = connectPluginRpc, env = process.env,
  cwd = process.cwd(), out = console.log, err = console.error,
  setExitCode = (code) => { process.exitCode = code; } } = {}) {
  if (REMOVED_COMMANDS.has(argv[0])) {
    throw new Error(`CLI command "${argv[0]}" was removed; use \`/factory ${argv[0]}\` in the Paseo composer or the Factory panel. Run \`paseo-factory --help\` for CLI commands.`);
  }
  if (argv[0] === 'worker' && (argv[1] === 'set' || argv[1] === 'rm')) {
    throw new Error(`CLI command "worker ${argv[1]}" was removed; use \`/factory worker ${argv[1]}\` in the Paseo composer or the Factory settings.`);
  }
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  const [command, ...args] = positionals;
  if (!command || command === 'help' || values.help) return out(USAGE);
  if (values.prune && command !== 'workers') throw new Error('--prune is only accepted with workers');

  if (command === 'worker') {
    const [sub, ...rest] = args;
    if (sub === 'set' || sub === 'rm') {
      throw new Error(`CLI command "worker ${sub}" was removed; use \`/factory worker ${sub}\` in the Paseo composer or the Factory settings.`);
    }
    if (!['pick', 'list', 'start'].includes(sub)) {
      throw new Error(`Unknown worker command ${sub ?? '(none)'}; use \`paseo-factory worker pick|list|start\`, or \`/factory worker\` in the Paseo composer.`);
    }
    if (rest.length > 1) throw new Error(`worker ${sub} takes at most one scope`);
    if (sub !== 'pick' && values.failed !== undefined) throw new Error('--failed is only accepted with worker pick');
    if (values.failed !== undefined && !values.reason) throw new Error('worker pick --failed needs --reason <text>');
    if (values.reason !== undefined && values.failed === undefined) throw new Error('worker pick --reason needs --failed <profile>');
    if (sub === 'start') {
      if (!values.task?.trim()) throw new Error('worker start needs --task <text>');
      if (!env.PASEO_AGENT_ID) throw new Error('Run worker start from the active steer');
    }
    const client = await openRpc(connectRpc);
    try {
      const base = {
        ...targetInput(rest[0] ?? null, env),
        ...(env.PASEO_AGENT_ID ? { agentId: env.PASEO_AGENT_ID } : {}),
        ...(cwd ? { cwd } : {}),
      };
      const res = sub === 'pick'
        ? await client.call('factory.worker.pick', { ...base, ...(values.failed !== undefined ? { failed: values.failed, reason: values.reason } : {}) })
        : sub === 'list'
          ? await client.call('factory.worker.list', base)
          : await client.call('factory.worker.start', {
            ...base, callerId: env.PASEO_AGENT_ID, task: values.task,
            ...(values.title ? { title: values.title } : {}), ...(values.apply ? { apply: true } : {}),
          });
      return out(values.json ? JSON.stringify(omit(res, ['text']), null, 2) : need(res, `factory.worker.${sub}`));
    } finally {
      await client.close();
    }
  }

  if (!['status', 'resume', 'checkpoint', 'workers', 'switch', 'assign'].includes(command)) {
    throw new Error(`Unknown command "${command}"; use \`/factory\` in the Paseo composer for management commands or \`paseo-factory --help\` for CLI commands.`);
  }

  const scope = oneScope(command, args);
  const agentId = env.PASEO_AGENT_ID ?? null;
  const base = targetInput(scope, env);

  if (command === 'switch') {
    if (!values.to) throw new Error('switch needs --to <slot>');
    if (values.language && !['en', 'de'].includes(values.language)) throw new Error('--language must be en or de');
  } else if (command === 'checkpoint') {
    if (values['from-agent'] && values.task) throw new Error('use either --task or --from-agent');
    if (!values.task && !values['from-agent'] && !values['from-steer']) throw new Error('checkpoint needs --task or --from-agent');
  } else if (command === 'assign') {
    if (!values.task) throw new Error('assign needs --task <text>');
    if (values['expect-epoch'] !== undefined && !Number.isInteger(Number.parseInt(values['expect-epoch'], 10))) {
      throw new Error('--expect-epoch needs an integer epoch from the preview');
    }
  }

  const client = await openRpc(connectRpc);
  try {
    if (command === 'status') {
      const res = await client.call('factory.status', { ...base, ...(!scope && agentId ? { agentId } : {}) });
      noteAlias(res, scope, err);
      return out(values.json ? JSON.stringify(omit(res, ['scope', 'deprecatedAlias', 'text']), null, 2) : need(res, 'factory.status'));
    }
    if (command === 'workers') {
      const res = await client.call('factory.workers', {
        ...base, ...(!scope && agentId ? { agentId } : {}),
        ...(values.prune ? { prune: true } : {}), ...(values.apply ? { apply: true } : {}),
      });
      noteAlias(res, scope, err);
      if (values.json) {
        const payload = values.prune
          ? (values.apply ? { scope: res.scope, epoch: res.epoch, removed: res.removed, applied: true } : { scope: res.scope, epoch: res.epoch, stale: res.stale, applied: false })
          : { scope: res.scope, epoch: res.epoch, workers: res.workers };
        return out(JSON.stringify(payload, null, 2));
      }
      return out(need(res, 'factory.workers'));
    }
    if (command === 'resume') {
      const targetAgent = values.agent ?? agentId ?? null;
      if (values.apply) {
        const status = await client.call('factory.status', { ...base, ...(!scope && targetAgent ? { agentId: targetAgent } : {}) });
        noteAlias(status, scope, err);
        if (!values.agent || !(status.workers ?? []).some((w) => w.id === values.agent)) {
          throw new Error('resume --apply needs --agent <interrupted worker id>');
        }
        const applied = await client.call('factory.resume.apply', { workspaceId: status.workspace.id, agentId: values.agent });
        out(values.json ? JSON.stringify(applied, null, 2) : need(applied, 'factory.resume.apply', 'detail'));
        if (applied.status === 'blocked') setExitCode(1);
        return;
      }
      const res = await client.call('factory.resume', { ...base, ...(targetAgent ? { agentId: targetAgent } : {}) });
      noteAlias(res, scope, err);
      if (values.json) {
        return out(JSON.stringify({
          scope: res.scope, kind: res.kind ?? null, epoch: res.epoch ?? null, agentId: res.agentId ?? null, brief: res.brief,
          openWorkers: res.openWorkers ?? [], interrupted: res.interrupted ?? null,
          ...(res.restartInterrupted?.length ? { restartInterrupted: res.restartInterrupted } : {}),
        }, null, 2));
      }
      return out(need(res, 'factory.resume', 'brief'));
    }
    if (command === 'checkpoint') {
      const payload = {
        ...base,
        ...(values.task ? { task: values.task } : {}),
        ...(values['from-agent'] ? { fromAgent: values['from-agent'] } : {}),
        ...(values['from-steer'] ? { fromSteer: values['from-steer'] } : {}),
        tests: values.test ?? [],
        blockers: values.blocker ?? [],
        ...(values.next ? { next: values.next } : {}),
      };
      const preview = await client.call('factory.checkpoint.preview', payload);
      noteAlias(preview, scope, err);
      const written = await client.call('factory.checkpoint', { ...payload, fingerprint: preview.fingerprint, ...(agentId ? { callerId: agentId } : {}) });
      return out(JSON.stringify(need(written, 'factory.checkpoint', 'checkpoint'), null, 2));
    }
    if (command === 'switch') {
      const common = { ...base, to: values.to, ...(agentId ? { callerId: agentId } : {}), ...(values.language ? { language: values.language } : {}) };
      const preview = await client.call('factory.switch.preview', common);
      noteAlias(preview, scope, err);
      const result = values.apply
        ? await client.call('factory.switch', {
          ...common, fingerprint: preview.fingerprint, deliver: values['no-send'] ? 'none' : 'send',
          notifyPrevious: Boolean(values['notify-previous']), ...(values.wait ? { wait: true } : {}),
        })
        : preview;
      need(result, 'factory.switch', 'packet');
      out(`${result.applied ? 'Switched' : 'Dry-run'}: Steer ${result.from} → ${result.to} (epoch ${result.epoch}) · handoff ${result.packetChars} characters, built without a model call${result.checkpoint ? '' : ' · NO task checkpoint'}${result.delivered ? ' · delivered' : ''}${result.deliveryPending ? ' · brief queued pending context renewal' : ''}${result.previousNotified ? ' · previous steer notified' : ''}${result.previousNoticeDetail ? ` · previous steer: ${result.previousNoticeDetail}` : ''}${result.deliveryError ? ` · delivery failed: ${result.deliveryError}` : ''}${result.renameError ? ` · title rename failed: ${result.renameError}` : ''}\n---\n${result.packet}`);
      if (result.reply !== null && result.reply !== undefined) out(`--- reply of Steer ${result.to}\n${result.reply ?? '(no answer text)'}`);
      return;
    }
    const expectEpoch = values['expect-epoch'] !== undefined ? Number.parseInt(values['expect-epoch'], 10) : undefined;
    const assignInput = {
      ...base, task: values.task, tests: values.test ?? [], blockers: values.blocker ?? [],
      ...(values.next ? { next: values.next } : {}), ...(values['report-to'] ? { reportTo: values['report-to'] } : {}),
      ...(agentId ? { callerId: agentId } : {}), ...(expectEpoch !== undefined ? { expectEpoch } : {}),
    };
    const preview = await client.call('factory.assign.preview', assignInput);
    noteAlias(preview, scope, err);
    const result = values.apply
      ? await client.call('factory.assign', { ...assignInput, fingerprint: preview.fingerprint, send: !values['no-send'] })
      : preview;
    if (!values.json) need(result, 'factory.assign', 'packet');
    if (values.json) return out(JSON.stringify(omit(result, ['fingerprint', 'deprecatedAlias', 'scopeInfo']), null, 2));
    out(`${result.applied ? 'Assigned' : 'Dry-run'}: ${result.scope} epoch ${result.epoch} · Steer ${result.slot} ${result.steerId}${result.domain ? ` · domain ${result.domain}` : ''}${(result.domainChildren ?? []).length ? ` · domain of ${result.domainChildren.length} (${result.domainChildren.join(', ')})` : ''}${result.previous ? '' : ' · NO previous checkpoint'}${result.delivered ? ' · delivered' : ''}${result.deliveryError ? ` · delivery failed: ${result.deliveryError}` : ''}`);
    if (result.previous) out(`Replaces task: ${result.previous}`);
    out(`---\n${result.packet}`);
    if (!result.applied) out(`---\nNothing written. Apply: paseo-factory assign ${JSON.stringify(scope ?? result.scope)} --task ${JSON.stringify(values.task)} --apply`);
  } finally {
    await client.close();
  }
}

const invokedAsMain = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
