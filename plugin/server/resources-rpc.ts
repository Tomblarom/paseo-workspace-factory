import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { factoryWorkspaceResources, resourceWorkerExclusion } from "../shared/factory.js";
import { isQuotaSampleStale, QUOTA_SAMPLE_MINUTES } from "../shared/defaults.mjs";
import { workerPriority } from "./core/config.mjs";
import { LABEL, parentOf } from "./core/paseo.mjs";
import {
  familyAccounts, liveAgentPool, profileFamily, profilePool,
  QUOTA_DEFAULTS, quotaEntry, quotaPct, windowAppliesToModel,
} from "./core/quota.mjs";
import { resolveFactoryLabels } from "./core/zerosub.mjs";
import type { ZerosubState } from "./zerosub-runtime.js";

export type WorkspaceResources = RpcOutput<typeof factoryWorkspaceResources>;
type ResourceWindow = WorkspaceResources["pools"][number]["windows"][number];
type ProviderCatalog = Awaited<ReturnType<PluginHandlerContext["paseo"]["providers"]["snapshot"]>>["entries"];

// ZeroSub's normalized windows keep the ID, which can also be provider-supplied.
const windowAliases = new Map([
  ["5h", "5-hour"], ["five_hour", "5-hour"],
  ["weekly", "Weekly"], ["seven_day", "Weekly"],
  ["seven_day_opus", "Opus weekly"], ["seven_day_sonnet", "Sonnet weekly"],
  ["weekly_fable", "Fable weekly"],
  ["primary", "Primary"], ["secondary", "Secondary"],
]);

function catalogLabel(value: unknown): string | null {
  const label = typeof value === "string" ? value.trim() : "";
  // Catalog names are display text. Paths, handles and control characters stay out.
  return /^[\p{L}\p{N}][\p{L}\p{N} .,_+()'&·–—-]{0,79}$/u.test(label) ? label : null;
}

function stampMs(value: unknown): number | null {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function shapeWorkspaceResources({
  workspaceId, config, agents, providers = [], zerosub, snapshot, quotaSampledAt, quotaSampleMinutes,
  nowMs, repoPublic, selectedIndex, selectedAccount, exclusions,
}: {
  workspaceId: string;
  config: any;
  agents: any[];
  providers?: ProviderCatalog;
  zerosub: ZerosubState;
  snapshot: Record<string, any> | null;
  quotaSampledAt: number | null;
  quotaSampleMinutes?: number;
  nowMs: number;
  repoPublic: boolean | null;
  selectedIndex: number | null;
  selectedAccount: string | null;
  exclusions: ReadonlyMap<number, string>;
}): WorkspaceResources {
  const sampleMinutes = typeof quotaSampleMinutes === "number" && Number.isFinite(quotaSampleMinutes) && quotaSampleMinutes > 0
    ? quotaSampleMinutes : QUOTA_SAMPLE_MINUTES;
  const catalog = new Map(providers.map((entry) => [entry.provider.toLowerCase(), entry]));
  const providerLabel = (provider: string) => catalogLabel(catalog.get(provider)?.label)
    ?? provider.charAt(0).toUpperCase() + provider.slice(1);

  function window(alias: string, pct: unknown, sampledAt: number | null, reset: unknown): ResourceWindow {
    const resetMs = stampMs(reset);
    const expired = resetMs !== null && resetMs <= nowMs;
    const usedPct = typeof pct === "number" && Number.isFinite(pct) && pct >= 0 ? pct : null;
    const state = usedPct === null ? "unavailable"
      : expired ? "stale"
      : sampledAt === null ? "unavailable"
      : isQuotaSampleStale(sampledAt, nowMs, sampleMinutes) ? "stale"
      : "available";
    return { alias, usedPct: state === "available" ? usedPct : null,
      sampledAt: iso(sampledAt), resetsAt: iso(resetMs), state };
  }

  function activeLimit(value: unknown): string | null {
    const until = stampMs(value);
    return until !== null && until > nowMs ? iso(until) : null;
  }

  const pools = new Map<string, { provider: string; pool: string; alias: string }>();
  const relevantAccounts = new Map<string, { account: any; models: Set<string | null> }>();
  function addPool(provider: string, pool: string): string {
    const key = JSON.stringify([provider, pool]);
    const existing = pools.get(key);
    if (existing) return existing.alias;
    const alias = pool === provider ? "Provider pool" : `Quota pool ${pools.size + 1}`;
    pools.set(key, { provider, pool, alias });
    return alias;
  }
  function addAccount(account: any, model: string | null) {
    let entry = relevantAccounts.get(account.id);
    if (!entry) {
      entry = { account, models: new Set() };
      relevantAccounts.set(account.id, entry);
    }
    entry.models.add(model);
  }

  const ownAgents = agents.filter((agent) => agent.workspaceId === workspaceId);
  for (const agent of ownAgents) {
    if (agent.archivedAt) continue;
    const role = resolveFactoryLabels(agent, ownAgents)?.[LABEL.role];
    if (role !== "worker" && (role !== "steer" || parentOf(agent))) continue;
    const provider = profileFamily(agent);
    if (!provider) continue;
    addPool(provider, liveAgentPool(agent, config));
    const accountIds = [zerosub?.agentAccount?.[agent.id], zerosub?.pending?.[agent.id]];
    for (const account of familyAccounts(zerosub, provider)) {
      if (accountIds.includes(account.id)) addAccount(account, agent.model);
    }
  }

  const candidates = workerPriority(config).map((profile: string) => {
    const configured = config.profiles?.[profile];
    const provider = profileFamily(configured);
    const model = configured?.model ?? null;
    const modelLabel = catalogLabel(catalog.get(provider)?.models?.find(({ id }) => id === model)?.label);
    const poolAlias = provider ? addPool(provider, profilePool(configured)) : null;
    for (const account of familyAccounts(zerosub, provider)) addAccount(account, model);
    return {
      profile, provider: provider || null, providerLabel: provider ? providerLabel(provider) : null,
      model, modelLabel, poolAlias,
    };
  });

  // Aliases belong to this snapshot. ZeroSub display labels can hold personal
  // data, and pool keys and window IDs can carry account identifiers.
  const accountAliases = new Map<string, string>();
  const accounts = [...relevantAccounts.values()]
    .sort((a, b) => a.account.id.localeCompare(b.account.id))
    .map(({ account, models }, index) => {
      const kind = account.auth === "subscription" ? "Subscription" : account.auth === "api" ? "API account" : "Account";
      const alias = `${kind} ${index + 1}`;
      accountAliases.set(account.id, alias);
      const sampledAt = stampMs(account.sampledAt);
      const windows: ResourceWindow[] = (account.windows ?? [])
        .filter((item: any) => [...models].some((model) => windowAppliesToModel(item, model)))
        .map((item: any, index: number) => window(
          windowAliases.get(item.id) ?? `Window ${index + 1}`, item.usedPct, sampledAt, item.resetsAt,
        ));
      if (windows.length === 0) {
        const pct = account.windows?.length ? null : account.maxUsedPct;
        windows.push(window("Reported usage", pct, sampledAt, null));
      }
      const limitedUntil = activeLimit(account.limitedUntil);
      const provider = account.family.toLowerCase();
      return {
        provider, providerLabel: providerLabel(provider), alias, windows, limitedUntil,
        limited: account.exhausted === true || limitedUntil !== null,
      };
    });
  const accountAlias = selectedAccount ? accountAliases.get(selectedAccount) ?? null : null;

  return {
    workspaceId,
    warnPct: config.quota?.warnPct ?? QUOTA_DEFAULTS.warnPct,
    exhaustedPct: config.quota?.exhaustedPct ?? QUOTA_DEFAULTS.exhaustedPct,
    quotaSampleMinutes: sampleMinutes,
    pools: [...pools.values()].map(({ provider, pool, alias }) => {
      const entry = quotaEntry(snapshot, pool);
      const sampledAt = !entry ? null : entry.sampledAt === undefined ? quotaSampledAt : stampMs(entry.sampledAt);
      const limitedUntil = activeLimit(entry?.limitUntil ?? entry?.limitedUntil);
      return {
        provider, providerLabel: providerLabel(provider), alias, limitedUntil,
        limited: entry?.exhausted === true || limitedUntil !== null,
        windows: [
          window("Session", quotaPct(entry), sampledAt, entry?.resetsAt ?? entry?.resetAt),
          window("Weekly", entry?.weeklyPct ?? entry?.weeklyUsedPct, sampledAt, entry?.weeklyResetAt),
        ],
      };
    }),
    accounts,
    zeroSubState: zerosub === null ? "unavailable" : "available",
    workerSelection: {
      scopeVisibility: repoPublic === null ? "unknown" : repoPublic ? "public" : "private",
      candidates: candidates.map((candidate: typeof candidates[number], index: number) => {
        const reason = exclusions.get(index);
        if (reason) return { ...candidate, decision: { state: "excluded", reason: resourceWorkerExclusion.parse(reason) } };
        if (index === selectedIndex) return { ...candidate, decision: { state: "selected", accountAlias } };
        return { ...candidate, decision: { state: "unevaluated" } };
      }),
    },
  };
}
