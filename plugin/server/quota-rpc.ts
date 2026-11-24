// factory.quota: read-only quota visibility. Shapes the sampled `paseo usage`
// snapshot per pool (state from the effective quota thresholds) and maps each
// steer slot and worker priority entry to its quota pool.
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { factoryQuota } from "../shared/factory.js";
import type { ConfigLoader } from "./config.js";
import { QUOTA_DEFAULTS, profilePool, quotaPct } from "./factory/quota.js";
import { getQuotaSampledAt, getQuotaSnapshot } from "./quota.js";

export type QuotaState = "ok" | "warn" | "exhausted";

export type QuotaPoolView = {
  pool: string;
  sessionPct: number | null;
  weeklyPct?: number | null;
  resetAt?: string | null;
  state: QuotaState;
  sampledAt: string | null;
};

export type QuotaView = {
  sampledAt: string | null;
  warnPct: number;
  exhaustedPct: number;
  pools: QuotaPoolView[];
  steers: { slot: string; profile: string; pool: string; advisor: boolean }[];
  workers: { position: number; profile: string; pool: string }[];
};

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function snapshotEntries(snapshot: Record<string, any> | null): Record<string, any> {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
  const pools = (snapshot as Record<string, any>).pools;
  if (pools && typeof pools === "object" && !Array.isArray(pools)) return pools as Record<string, any>;
  return snapshot;
}

function resetStamp(entry: any): string | null {
  const raw = entry?.resetAt ?? entry?.limitUntil ?? entry?.resetsAt ?? null;
  return typeof raw === "string" && raw ? raw : null;
}

function weeklyNumber(entry: any): number | null {
  return finiteNumber(entry?.weeklyPct ?? entry?.weeklyUsedPct);
}

function classify(
  sessionPct: number | null,
  weeklyPct: number | null,
  resetAt: string | null,
  warnPct: number,
  exhaustedPct: number,
  nowMs: number,
): QuotaState {
  const resetMs = resetAt ? Date.parse(resetAt) : NaN;
  if (Number.isFinite(resetMs) && resetMs > nowMs) return "exhausted";
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
}): QuotaView {
  const nowMs = typeof args.nowMs === "number" ? args.nowMs : Date.now();
  const warnPct = finiteNumber(args.config?.quota?.warnPct) ?? QUOTA_DEFAULTS.warnPct;
  const exhaustedPct = finiteNumber(args.config?.quota?.exhaustedPct) ?? QUOTA_DEFAULTS.exhaustedPct;
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
        state: classify(sessionPct, weeklyPct, resetAt, warnPct, exhaustedPct, nowMs),
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
  return { sampledAt: args.sampledAt, warnPct, exhaustedPct, pools, steers, workers };
}

export async function getQuota(
  _input: RpcInput<typeof factoryQuota>,
  _ctx: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<QuotaView> {
  const config = await loader.loadEffectiveConfig();
  const at = getQuotaSampledAt();
  return shapeQuotaView({
    snapshot: getQuotaSnapshot(),
    sampledAt: at === null ? null : new Date(at).toISOString(),
    config,
  });
}
