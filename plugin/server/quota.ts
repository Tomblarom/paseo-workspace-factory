import { execFile } from "node:child_process";
import { QUOTA_SAMPLE_MINUTES } from "../shared/defaults.mjs";
import { parseUsageJson } from "./core/quota.mjs";
import { paseoBinary } from "./core/paseo.mjs";

/**
 * Per-turn token counters in provider-native meaning: `input` is the reported
 * input total as the route bills it, `cacheRead` the cache-read portion of it,
 * `cacheWrite` a separately billed write bucket (Claude only; Paseo exposes no
 * write field so Paseo-shaped payloads report 0). Uncached input is
 * `input - cacheRead` on Codex/OpenAI routes (cached tokens are included in
 * `input`) and `input` on Claude routes (they are not); see
 * `uncachedInputTokens`. Counters are stored raw, never pre-subtracted, so
 * accumulation cannot double count.
 */
export interface TurnUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** Quota subprocess budget; a timeout keeps the last sample (fail soft). */
export const QUOTA_SAMPLE_TIMEOUT_MS = 15_000;

let quotaSnapshot: Record<string, any> | null = null;
let lastSampleAt = 0;
/** Single in-flight sample: concurrent callers share one subprocess run. */
let inFlight: Promise<Record<string, any> | null> | null = null;

export function getQuotaSnapshot(): Record<string, any> | null {
  return quotaSnapshot;
}

/** Epoch milliseconds of the last successful sample, or null when never sampled. */
export function getQuotaSampledAt(): number | null {
  return lastSampleAt > 0 ? lastSampleAt : null;
}

export function resetQuotaForTests(): void {
  quotaSnapshot = null;
  lastSampleAt = 0;
  inFlight = null;
}

/** Runner for one `paseo usage --json` call; tests inject a fake. May be sync. */
export type QuotaRun = (binary: string, args: string[]) => string | Promise<string>;

function defaultRun(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { encoding: "utf8", timeout: QUOTA_SAMPLE_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout as string);
    });
  });
}

/**
 * One async quota sample from `paseo usage --json` (kept as the source: the
 * public providers.listUsage() is a lossy legacy projection on 0.17.4).
 * Never blocks the event loop; concurrent callers share a single in-flight
 * run; failures keep the last sample and log once. Consumers flag staleness
 * from the read time (see isQuotaSampleStale).
 */
export function sampleQuotaAsync(
  run: QuotaRun = defaultRun,
  log: (message: string) => void = console.log,
): Promise<Record<string, any> | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const snapshot = parseUsageJson(await run(paseoBinary(), ["usage", "--json"]));
      quotaSnapshot = snapshot;
      lastSampleAt = Date.now();
      return snapshot;
    } catch (error) {
      log(`[factory] quota sample failed (${error instanceof Error ? error.message : String(error)})`);
      return quotaSnapshot;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function startQuotaTimer({
  getSettings,
  intervalMs = 60_000,
  run,
  log = console.log,
}: {
  getSettings: () => Promise<any>;
  intervalMs?: number;
  run?: QuotaRun;
  log?: (message: string) => void;
}): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    void (async () => {
      try {
        const settings = await getSettings();
        const configured = Number(settings?.quotaSampleMinutes);
        const minutes = Number.isFinite(configured)
          ? Math.max(QUOTA_SAMPLE_MINUTES, configured)
          : QUOTA_SAMPLE_MINUTES;
        if (Date.now() - lastSampleAt < minutes * 60_000) return;
        await sampleQuotaAsync(run, log);
      } catch (error) {
        log(`[factory] quota timer failed (${error instanceof Error ? error.message : String(error)})`);
      }
    })();
  }, intervalMs);
  if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

const USAGE_KEYS: Record<keyof TurnUsage, string[]> = {
  input: ["input", "inputTokens", "input_tokens"],
  cacheWrite: ["cacheWrite", "cache_write", "cacheCreationInputTokens", "cache_creation_input_tokens"],
  cacheRead: [
    "cacheRead",
    "cache_read",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
    // Paseo ProviderUsage (plugin types + agent.lastUsage snapshot).
    "cachedInputTokens",
    "cached_input_tokens",
  ],
  output: ["output", "outputTokens", "output_tokens"],
};

function numberAt(value: any, keys: string[]): number {
  for (const key of keys) {
    const number = Number(value?.[key]);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return 0;
}

export function extractTurnUsage(payload: any, agent: any = null): TurnUsage | null {
  const candidates = [
    payload?.outcome?.usage,
    payload?.outcome?.providerUsage,
    payload?.outcome?.result?.usage,
    payload?.usage,
    agent?.lastUsage,
    agent?.usage,
  ];
  const source = candidates.find((candidate) => candidate && typeof candidate === "object") ?? null;
  if (!source) return null;
  const usage = {
    input: numberAt(source, USAGE_KEYS.input),
    cacheWrite: numberAt(source, USAGE_KEYS.cacheWrite),
    cacheRead: numberAt(source, USAGE_KEYS.cacheRead),
    output: numberAt(source, USAGE_KEYS.output),
  };
  return Object.values(usage).some((value) => value > 0) ? usage : null;
}

/**
 * Routes whose reported `input` already includes cached tokens. Every other
 * route (Claude included) reports cached tokens separately from `input`.
 */
const INCLUSIVE_INPUT_ROUTES = new Set(["codex", "openai"]);

/**
 * Uncached input tokens for one turn or cumulative total: `input - cacheRead`
 * on Codex/OpenAI routes, `input` elsewhere. Clamped at 0 so a skewed
 * snapshot can never price negative input. Pass the agent/provider route
 * (e.g. `agent.provider`); unknown routes keep `input` unchanged.
 */
export function uncachedInputTokens(
  usage: TurnUsage | null | undefined,
  route: string | null | undefined,
): number {
  const input = Number(usage?.input) || 0;
  if (!INCLUSIVE_INPUT_ROUTES.has(String(route ?? "").toLowerCase())) return input;
  return Math.max(0, input - (Number(usage?.cacheRead) || 0));
}

export function mergeTurnUsage(previous: any, turn: TurnUsage | null): any {
  if (!turn) return previous ?? null;
  const old = previous && typeof previous === "object" ? previous : {};
  const cumulative = {
    input: Math.min((Number(old.cumulative?.input) || 0) + turn.input, Number.MAX_SAFE_INTEGER),
    cacheWrite: Math.min((Number(old.cumulative?.cacheWrite) || 0) + turn.cacheWrite, Number.MAX_SAFE_INTEGER),
    cacheRead: Math.min((Number(old.cumulative?.cacheRead) || 0) + turn.cacheRead, Number.MAX_SAFE_INTEGER),
    output: Math.min((Number(old.cumulative?.output) || 0) + turn.output, Number.MAX_SAFE_INTEGER),
  };
  return { cumulative, lastTurn: turn };
}
