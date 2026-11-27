import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { factoryWorkspaceResources, resourceSteerRouting, resourceWorkerExclusion } from "../shared/factory.js";
import { isQuotaSampleStale, QUOTA_SAMPLE_MINUTES } from "../shared/defaults.mjs";
import { AGENTS_KEY } from "./core/agent-state.mjs";
import { workerPriority } from "./core/config.mjs";
import { LABEL, parentOf } from "./core/paseo.mjs";
import {
  familyAccounts, freshMaxUsedPct, liveAgentPool, profileFamily, profilePool,
  QUOTA_DEFAULTS, quotaEntry, quotaPct, windowAppliesToModel,
} from "./core/quota.mjs";
import { readSteerAction } from "./core/steer-action.mjs";
import { resolveFactoryLabels } from "./core/zerosub.mjs";
import { zerosubAccountAliases, type ZerosubState } from "./zerosub-runtime.js";

export type WorkspaceResources = RpcOutput<typeof factoryWorkspaceResources>;
type ResourceWindow = WorkspaceResources["pools"][number]["windows"][number];
type ReportedWindow = { alias: string; usedPct: unknown; resetsAt?: unknown };
type QuotaKind = WorkspaceResources["accounts"][number]["quotaKind"];
type ProviderCatalog = Awaited<ReturnType<PluginHandlerContext["paseo"]["providers"]["snapshot"]>>["entries"];

// ZeroSub's normalized windows keep the ID, which can also be provider-supplied.
const windowAliases = new Map([
  ["5h", "5-hour"], ["5-hour", "5-hour"], ["five-hour", "5-hour"], ["five_hour", "5-hour"],
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

function quotaWindow(alias: string, pct: unknown, sampledAt: number | null, reset: unknown,
  now: number, sampleMinutes = QUOTA_SAMPLE_MINUTES): ResourceWindow {
  const resetMs = stampMs(reset);
  const usedPct = typeof pct === "number" && Number.isFinite(pct) && pct >= 0 ? pct : null;
  const state = usedPct === null ? "unavailable"
    : resetMs !== null && resetMs <= now ? "stale"
    : sampledAt === null || sampledAt > now ? "unavailable"
    : isQuotaSampleStale(sampledAt, now, sampleMinutes) ? "stale" : "available";
  return { alias, usedPct: state === "available" ? usedPct : null,
    sampledAt: iso(sampledAt), resetsAt: iso(resetMs), state };
}

function poolWindows(entry: any): ReportedWindow[] {
  if (!entry) return [];
  return [
    ...(entry.sessionWindow === "weekly" ? [] : [{
      alias: entry.sessionWindow === "5-hour" ? "5-hour" : entry.sessionWindow === "session" ? "Session" : "Reported usage",
      usedPct: quotaPct(entry), resetsAt: entry.resetsAt ?? entry.resetAt,
    }]),
    { alias: "Weekly", usedPct: entry.weeklyPct ?? entry.weeklyUsedPct, resetsAt: entry.weeklyResetAt },
  ].filter(({ usedPct, resetsAt }) => Number.isFinite(usedPct) || stampMs(resetsAt) !== null);
}

export function formatSteerQuota(agent: { id: string; provider?: string; model?: string | null }, {
  config, zerosub, accountAliases, snapshot, quotaSampledAt, now, quotaSampleMinutes,
}: {
  config: any;
  zerosub: ZerosubState;
  accountAliases: ReadonlyMap<string, string>;
  snapshot: Record<string, any> | null;
  quotaSampledAt: number | null;
  now: number;
  quotaSampleMinutes?: number;
}): string {
  const pending = zerosub?.pending?.[agent.id];
  const accountId = pending ?? zerosub?.agentAccount?.[agent.id];
  const account = familyAccounts(zerosub, profileFamily(agent)).find(({ id }: { id: string }) => id === accountId);
  const pool = accountId ? null : quotaEntry(snapshot, liveAgentPool(agent, config));
  const sampledAt = pool && pool.sampledAt === undefined ? quotaSampledAt : stampMs(account?.sampledAt ?? pool?.sampledAt);
  const name = accountId ? accountAliases.get(accountId) ?? "Linked account" : "Provider pool";
  const label = pending ? `${name} (move pending)` : name;
  if (sampledAt === null || sampledAt > now) return `${label} · usage unknown`;
  if (isQuotaSampleStale(sampledAt, now, quotaSampleMinutes)) return `${label} · usage sample stale`;
  const windows: ReportedWindow[] = accountId
    ? account?.windows?.length
      ? account.windows.filter((window: any) => windowAppliesToModel(window, agent.model))
        .map((window: any, index: number) => ({ ...window, alias: windowAliases.get(window.id) ?? `Window ${index + 1}` }))
      : [{ alias: "Reported usage", usedPct: account?.maxUsedPct }]
    : poolWindows(pool);
  const used = windows
    .map(({ alias, usedPct, resetsAt }) => quotaWindow(alias, usedPct, sampledAt, resetsAt, now, quotaSampleMinutes))
    .flatMap(({ alias, usedPct }) => usedPct === null ? [] : [`${alias} ${Number(usedPct.toFixed(1))}% used`]);
  return `${label} · ${used.length ? used.join(", ") : "usage unknown"}`;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function retainedSteerRouting(
  metadata: Record<string, unknown> | null,
  accountAliases: ReadonlyMap<string, string>,
): WorkspaceResources["steerRouting"] {
  const entries = metadata?.[AGENTS_KEY];
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return null;
  let latest: WorkspaceResources["steerRouting"] = null;
  let latestMs = -Infinity;
  for (const entry of Object.values(entries)) {
    const action = readSteerAction(entry);
    const route = action?.routing;
    if (!route) continue;
    const queuedAt = stampMs(action.queuedAt);
    if (latest && (queuedAt ?? -Infinity) <= latestMs) continue;
    const reason = resourceSteerRouting.shape.reason.safeParse(route.reason);
    const epoch = resourceSteerRouting.shape.epoch.safeParse(route.observation?.epoch);
    const evidence = route.evidence;
    const parsed = resourceSteerRouting.safeParse({
      queuedAt: iso(queuedAt),
      intent: route.intent?.mode,
      strategy: route.strategy,
      reason: reason.success ? reason.data : null,
      kind: route.kind,
      preparation: route.preparation,
      confidence: route.confidence ?? "unknown",
      evidence: {
        uncachedInputTokens: evidence?.uncachedInputTokens ?? null,
        preparationTurns: evidence?.preparationTurns ?? null,
        latencyMs: evidence?.latencyMs ?? null,
        preferenceRank: evidence?.preferenceRank ?? null,
      },
      epoch: epoch.success ? epoch.data : null,
      accountAlias: accountAliases.get(route.observation?.accountId) ?? null,
    });
    if (parsed.success) {
      latest = parsed.data;
      latestMs = queuedAt ?? -Infinity;
    }
  }
  return latest;
}

export function shapeWorkspaceResources({
  workspaceId, workspaceMetadata = null, config, agents, providers = [], zerosub, snapshot, quotaSampledAt, quotaSampleMinutes,
  nowMs, repoPublic, selectedIndex, selectedAccount, exclusions,
}: {
  workspaceId: string;
  workspaceMetadata?: Record<string, unknown> | null;
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
    return quotaWindow(alias, pct, sampledAt, reset, nowMs, sampleMinutes);
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
      if (accountIds.includes(account.id)) addAccount(account, agent.model ?? null);
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
  const hostAliases = zerosubAccountAliases(zerosub);
  const accountAliases = new Map<string, string>();
  const unknownWindowsByProvider = new Map<string, Map<string, string>>();
  const accounts = [...relevantAccounts.values()]
    .sort((a, b) => a.account.id.localeCompare(b.account.id))
    .map(({ account, models }) => {
      const alias = hostAliases.get(account.id)!;
      accountAliases.set(account.id, alias);
      const sampledAt = stampMs(account.sampledAt);
      const provider = account.family.toLowerCase();
      const unknownWindows = unknownWindowsByProvider.get(provider) ?? new Map<string, string>();
      unknownWindowsByProvider.set(provider, unknownWindows);
      const aliasCount = new Map<string, number>();
      const applicableModels = [...models];
      const windows = (account.windows ?? [])
        .filter((item: any) => applicableModels.some((model) => windowAppliesToModel(item, model)))
        .map((item: any) => {
          let name = windowAliases.get(item.id) ?? unknownWindows.get(item.id);
          if (!name) {
            name = `Window ${unknownWindows.size + 1}`;
            unknownWindows.set(item.id, name);
          }
          const count = (aliasCount.get(name) ?? 0) + 1;
          aliasCount.set(name, count);
          return window(count === 1 ? name : `${name} (${count})`, item.usedPct, sampledAt, item.resetsAt);
        });
      if (!account.windows?.length && Number.isFinite(account.maxUsedPct)) {
        windows.push(window("Reported usage", account.maxUsedPct, sampledAt, null));
      }
      const quotaKind: QuotaKind = account.auth === "api" || account.auth === "subscription" ? account.auth
        : account.windows?.length || windows.length ? "reported" : "unknown";
      const limitedUntil = activeLimit(account.limitedUntil);
      return {
        provider, providerLabel: providerLabel(provider), alias, windows, limitedUntil, quotaKind, sampledAt: iso(sampledAt),
        limited: account.exhausted === true || limitedUntil !== null,
      };
    });
  const accountAlias = selectedAccount ? accountAliases.get(selectedAccount) ?? null : null;
  const pickedAccount = selectedAccount ? relevantAccounts.get(selectedAccount)?.account : null;
  const pickedModel = selectedIndex === null ? null : candidates[selectedIndex]?.model ?? null;
  // The account rank uses the retained peak with unexpired resets. Its age
  // affects presentation, while the worker picker can still rank by it.
  const peakUsedPct = freshMaxUsedPct(pickedAccount, nowMs, pickedModel);
  const peak = pickedAccount && window("Reported usage", peakUsedPct, stampMs(pickedAccount.sampledAt), null);
  const pickedQuota = accounts.find(({ alias }) => alias === accountAlias);

  return {
    workspaceId,
    warnPct: config.quota?.warnPct ?? QUOTA_DEFAULTS.warnPct,
    exhaustedPct: config.quota?.exhaustedPct ?? QUOTA_DEFAULTS.exhaustedPct,
    quotaSampleMinutes: sampleMinutes,
    pools: [...pools.values()].map(({ provider, pool, alias }) => {
      const entry = quotaEntry(snapshot, pool);
      const sampledAt = !entry ? null : entry.sampledAt === undefined ? quotaSampledAt : stampMs(entry.sampledAt);
      const limitedUntil = activeLimit(entry?.limitUntil ?? entry?.limitedUntil);
      const windows = poolWindows(entry).map(({ alias, usedPct, resetsAt }) => window(alias, usedPct, sampledAt, resetsAt));
      return {
        provider, providerLabel: providerLabel(provider), alias, limitedUntil,
        sampledAt: iso(sampledAt), quotaKind: windows.length > 0 ? "reported" : "unknown",
        limited: entry?.exhausted === true || limitedUntil !== null,
        windows,
      };
    }),
    accounts,
    zeroSubState: zerosub === null ? "unavailable" : "available",
    workerSelection: {
      scopeVisibility: repoPublic === null ? "unknown" : repoPublic ? "public" : "private",
      accountEvidence: peak && pickedQuota
        ? { state: peak.state, usedPct: peakUsedPct !== null && peakUsedPct >= 0 ? peakUsedPct : null, quotaKind: pickedQuota.quotaKind }
        : null,
      candidates: candidates.map((candidate: typeof candidates[number], index: number) => {
        const reason = exclusions.get(index);
        if (reason) return { ...candidate, decision: { state: "excluded", reason: resourceWorkerExclusion.parse(reason) } };
        if (index === selectedIndex) return { ...candidate, decision: { state: "selected", accountAlias } };
        return { ...candidate, decision: { state: "unevaluated" } };
      }),
    },
    steerRouting: retainedSteerRouting(workspaceMetadata, accountAliases),
  };
}
