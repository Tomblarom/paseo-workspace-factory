import type { RpcOutput } from "@getpaseo/plugin";
import { factoryWorkspaceResources, resourceWorkerExclusion } from "../shared/factory.js";
import { isQuotaSampleStale } from "../shared/defaults.mjs";
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

function stampMs(value: unknown): number | null {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function shapeWorkspaceResources({
  workspaceId, config, agents, zerosub, snapshot, quotaSampledAt, quotaSampleMinutes,
  nowMs, repoPublic, selectedIndex, selectedAccount, exclusions,
}: {
  workspaceId: string;
  config: any;
  agents: any[];
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
  function window(alias: string, pct: unknown, sampledAt: number | null, reset: unknown): ResourceWindow {
    const resetMs = stampMs(reset);
    const expired = resetMs !== null && resetMs <= nowMs;
    const usedPct = typeof pct === "number" && Number.isFinite(pct) ? pct : null;
    const state = usedPct === null ? "unavailable"
      : expired ? "stale"
      : sampledAt === null ? "unavailable"
      : isQuotaSampleStale(sampledAt, nowMs, quotaSampleMinutes) ? "stale"
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
    const alias = `Quota pool ${pools.size + 1}`;
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
    const poolAlias = provider ? addPool(provider, profilePool(configured)) : null;
    for (const account of familyAccounts(zerosub, provider)) addAccount(account, model);
    return { profile, provider: provider || null, model, poolAlias };
  });

  // Aliases belong to this snapshot. ZeroSub display labels can hold personal
  // data, and pool keys and window IDs can carry account identifiers.
  const accountAliases = new Map<string, string>();
  const accounts = [...relevantAccounts.values()]
    .sort((a, b) => a.account.id.localeCompare(b.account.id))
    .map(({ account, models }, index) => {
      const alias = `Account ${index + 1}`;
      accountAliases.set(account.id, alias);
      const sampledAt = stampMs(account.sampledAt);
      const windows: ResourceWindow[] = (account.windows ?? [])
        .filter((item: any) => [...models].some((model) => windowAppliesToModel(item, model)))
        .map((item: any, index: number) => window(`Window ${index + 1}`, item.usedPct, sampledAt, item.resetsAt));
      if (windows.length === 0) {
        const pct = account.windows?.length ? null : account.maxUsedPct;
        windows.push(window("Reported usage", pct, sampledAt, null));
      }
      const limitedUntil = activeLimit(account.limitedUntil);
      return { provider: account.family, alias, limited: account.exhausted === true || limitedUntil !== null, limitedUntil, windows };
    });
  const accountAlias = selectedAccount ? accountAliases.get(selectedAccount) ?? null : null;

  return {
    workspaceId,
    warnPct: config.quota?.warnPct ?? QUOTA_DEFAULTS.warnPct,
    exhaustedPct: config.quota?.exhaustedPct ?? QUOTA_DEFAULTS.exhaustedPct,
    pools: [...pools.values()].map(({ provider, pool, alias }) => {
      const entry = quotaEntry(snapshot, pool);
      const sampledAt = !entry ? null : entry.sampledAt === undefined ? quotaSampledAt : stampMs(entry.sampledAt);
      const limitedUntil = activeLimit(entry?.limitUntil ?? entry?.limitedUntil);
      return { provider, alias, limited: entry?.exhausted === true || limitedUntil !== null, limitedUntil, windows: [
        window("Session", quotaPct(entry), sampledAt, entry?.resetsAt ?? entry?.resetAt),
        window("Weekly", entry?.weeklyPct ?? entry?.weeklyUsedPct, sampledAt, entry?.weeklyResetAt),
      ] };
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
