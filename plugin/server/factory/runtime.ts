// @ts-nocheck
// GENERATED from src/runtime.mjs by npm run plugin:sync. Do not edit.
// Host-specific settings. Precedence: environment variable > `runtime` section of
// the config file > defaults (XDG locations, local Paseo daemon, `paseo` on PATH).
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const env = (name) => (process.env[name] && process.env[name].trim()) || undefined;
const expand = (path) => (path?.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

function defaults() {
  const state = env('XDG_STATE_HOME') ?? join(homedir(), '.local', 'state');
  return {
    stateDir: join(state, 'paseo-workspace-factory'),
    paseo: { url: 'ws://127.0.0.1:6767/ws', bin: 'paseo', passwordFile: null },
  };
}

let current = null;

/** Applies the config's `runtime` section and environment overrides. */
export function configureRuntime(config = {}) {
  const base = defaults();
  const file = config.runtime ?? {};
  const stateDir = resolve(expand(env('PASEO_FACTORY_STATE_DIR') ?? file.stateDir ?? base.stateDir));
  current = {
    stateDir,
    lockDir: join(stateDir, 'locks'),
    planDir: join(stateDir, 'plans'),
    journalDir: stateDir,
    integrationDir: join(stateDir, 'integration'),
    scratchDir: join(stateDir, 'scratch'),
    paseo: {
      url: env('PASEO_WS_URL') ?? file.paseo?.url ?? base.paseo.url,
      bin: env('PASEO_FACTORY_PASEO_BIN') ?? expand(file.paseo?.bin) ?? base.paseo.bin,
      passwordFile: expand(env('PASEO_PASSWORD_FILE') ?? file.paseo?.passwordFile ?? null),
    },
    handoffLanguage: file.handoffLanguage ?? config.handoffLanguage ?? 'en',
  };
  return current;
}

export function runtime() {
  return current ?? configureRuntime();
}

/** `host:port` of the daemon URL, for CLI calls (`paseo --host`). */
export function daemonHost(url = runtime().paseo.url) {
  return new URL(url).host;
}
