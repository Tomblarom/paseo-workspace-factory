// factory.quota: read-only quota visibility. Shapes the sampled `paseo usage`
// snapshot per pool (state from the effective quota thresholds) and maps each
// steer slot and worker priority entry to its quota pool.
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { factoryQuota } from "../shared/factory.js";
import type { ConfigLoader } from "./config.js";
import { QUOTA_DEFAULTS, accountExhausted, earliestResetOf, freshMaxUsedPct, profilePool, quotaPct } from "./core/quota.mjs";
import { getQuotaSampledAt, getQuotaSnapshot } from "./quota.js";
import { resolveZerosub, type ZerosubSource } from "./zerosub-runtime.js";

export type QuotaState = "ok" | "warn" | "exhausted";

export type QuotaPoolView = {
  pool: string;
  sessionPct: number | null;
  weeklyPct?: number | null;
  resetAt?: string | null;
  state: QuotaState;
  sampledAt: string | null;
};

export type ZeroSubAccountView = {
  account: string;
  label?: string;
  family: string;
  usedPct: number | null;
  resetsAt: string | null;
  state: QuotaState | "unknown";
};

export type QuotaView = {
  sampledAt: string | null;
  warnPct: number;
  exhaustedPct: number;
  pools: QuotaPoolView[];
  steers: { slot: string; profile: string; pool: string; advisor: boolean }[];
  workers: { position: number; profile: string; pool: string }[];
  /** ZeroSub accounts with the same warn/exhausted states; empty without ZeroSub. */
  accounts: ZeroSubAccountView[];
};

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function snapshotEntries(snapshot: Record<string, any> | null): Record<string, any> {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
  const pools = (snapshot as Record<string, any>).pools;
  if (pools && typeof pools === "object" && !Array.isArray(pools)) return pools as Record<string, any>;
  return snapshot;
}

/** Explicit limit stamps only; an ordinary reset time never marks exhaustion. */
function limitStamp(entry: any): string | null {
  const raw = entry?.limitUntil ?? entry?.limitedUntil ?? null;
  return typeof raw === "string" && raw ? raw : null;
}

/** Display stamp: the binding explicit limit first, else the ordinary reset. */
function resetStamp(entry: any): string | null {
  const raw = limitStamp(entry) ?? entry?.resetAt ?? entry?.resetsAt ?? null;
  return typeof raw === "string" && raw ? raw : null;
}

/** Limited pool statuses, mirroring the ZeroSub normalizer's limit set. */
const LIMITED_POOL_STATUSES: ReadonlySet<string> = new Set(["limited", "exhausted", "suspended", "blocked"]);

function limitedByStatus(entry: any): boolean {
  if (entry?.exhausted === true) return true;
  const status = entry?.status;
  return typeof status === "string" && LIMITED_POOL_STATUSES.has(status.trim().toLowerCase());
}

function weeklyNumber(entry: any): number | null {
  return finiteNumber(entry?.weeklyPct ?? entry?.weeklyUsedPct);
}

function classify(
  entry: any,
  sessionPct: number | null,
  weeklyPct: number | null,
  warnPct: number,
  exhaustedPct: number,
  nowMs: number,
): QuotaState {
  if (limitedByStatus(entry)) return "exhausted";
  const limit = limitStamp(entry);
  const limitMs = limit ? Date.parse(limit) : NaN;
  if (Number.isFinite(limitMs) && limitMs > nowMs) return "exhausted";
  const worst = Math.max(sessionPct ?? -1, weeklyPct ?? -1);
  if (worst >= exhaustedPct) return "exhausted";
  if (worst >= warnPct) return "warn";
  return "ok";
}

/**
 * Pure shaping of the RPC payload, so tests can pass a fake snapshot and
 * config. Unknown pools (no snapshot entry) are not listed; slots and workers
 * are always mapped from the config, even before the first sample.
 */
export function shapeQuotaView(args: {
  snapshot: Record<string, any> | null;
  sampledAt: string | null;
  config: any;
  nowMs?: number;
  zerosub?: { accounts?: any[] } | null;
}): QuotaView {
  const nowMs = typeof args.nowMs === "number" ? args.nowMs : Date.now();
  const warnPct = finiteNumber(args.config?.quota?.warnPct) ?? QUOTA_DEFAULTS.warnPct;
  const exhaustedPct = finiteNumber(args.config?.quota?.exhaustedPct) ?? QUOTA_DEFAULTS.exhaustedPct;
  const accounts: ZeroSubAccountView[] = (Array.isArray(args.zerosub?.accounts) ? args.zerosub.accounts : [])
    .filter((account): account is Record<string, any> => !!account && typeof account.id === "string" && !!account.id)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((account) => {
      const usedPct = freshMaxUsedPct(account, nowMs);
      return {
        account: account.id,
        ...(account.label ? { label: account.label } : {}),
        family: typeof account.family === "string" ? account.family : "",
        usedPct,
        resetsAt: earliestResetOf([account], { now: nowMs }),
        state: accountExhausted(account, { exhaustedPct, now: nowMs })
          ? "exhausted"
          : usedPct === null ? "unknown" : usedPct >= warnPct ? "warn" : "ok",
      };
    });
  const pools: QuotaPoolView[] = Object.entries(snapshotEntries(args.snapshot))
    .filter((entry): entry is [string, any] => typeof entry[0] === "string" && !!entry[0])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pool, entry]) => {
      const sessionPct = quotaPct(entry);
      const weeklyPct = weeklyNumber(entry);
      const resetAt = resetStamp(entry);
      return {
        pool,
        sessionPct,
        weeklyPct,
        resetAt,
        state: classify(entry, sessionPct, weeklyPct, warnPct, exhaustedPct, nowMs),
        sampledAt: args.sampledAt,
      };
    });
  const profiles = args.config?.profiles ?? {};
  const slots = args.config?.steers?.slots ?? {};
  const steers = Object.entries(slots)
    .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slot, profile]) => ({
      slot,
      profile,
      pool: profilePool(profiles[profile]) ?? "",
      advisor: profiles[profile]?.advisor === true,
    }));
  const priority: string[] = Array.isArray(args.config?.workers?.priority)
    ? args.config.workers.priority
    : typeof args.config?.workers?.defaultProfile === "string" && args.config.workers.defaultProfile
      ? [args.config.workers.defaultProfile]
      : [];
  const workers = priority
    .filter((name): name is string => typeof name === "string" && !!name)
    .map((profile, index) => ({
      position: index + 1,
      profile,
      pool: profilePool(profiles[profile]) ?? "",
    }));
  return { sampledAt: args.sampledAt, warnPct, exhaustedPct, pools, steers, workers, accounts };
}

export async function getQuota(
  _input: RpcInput<typeof factoryQuota>,
  _ctx: PluginHandlerContext,
  loader: ConfigLoader,
  opts: ZerosubSource = {},
): Promise<QuotaView> {
  const config = await loader.loadEffectiveConfig();
  const at = getQuotaSampledAt();
  return shapeQuotaView({
    snapshot: getQuotaSnapshot(),
    sampledAt: at === null ? null : new Date(at).toISOString(),
    config,
    zerosub: await resolveZerosub(opts),
  });
}
