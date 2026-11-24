import { execFileSync } from "node:child_process";
import { parseUsageJson } from "./factory/quota.js";
import { paseoBinary } from "./factory/paseo.js";

export interface TurnUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

let quotaSnapshot: Record<string, any> | null = null;
let lastSampleAt = 0;

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
}

export function sampleQuota(
  run: (binary: string, args: string[]) => string = (binary, args) =>
    execFileSync(binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    }) as string,
  log: (message: string) => void = console.log,
): Record<string, any> | null {
  try {
    const snapshot = parseUsageJson(run(paseoBinary(), ["usage", "--json"]));
    quotaSnapshot = snapshot;
    lastSampleAt = Date.now();
    return snapshot;
  } catch (error) {
    log(`[factory] quota sample failed (${error instanceof Error ? error.message : String(error)})`);
    return quotaSnapshot;
  }
}

export function startQuotaTimer({
  getSettings,
  intervalMs = 60_000,
  run,
  log = console.log,
}: {
  getSettings: () => Promise<any>;
  intervalMs?: number;
  run?: (binary: string, args: string[]) => string;
  log?: (message: string) => void;
}): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    void (async () => {
      try {
        const settings = await getSettings();
        const configured = Number(settings?.quotaSampleMinutes);
        const minutes = Number.isFinite(configured) ? Math.max(10, configured) : 10;
        if (Date.now() - lastSampleAt < minutes * 60_000) return;
        sampleQuota(run, log);
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
  cacheRead: ["cacheRead", "cache_read", "cacheReadInputTokens", "cache_read_input_tokens"],
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
