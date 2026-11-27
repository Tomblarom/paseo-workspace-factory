import { accountForAgent, earliestResetOf, freshMaxUsedPct, liveAgentPool, QUOTA_DEFAULTS, quotaEntry, quotaExhausted, quotaPct } from "./core/quota.mjs";
import { AGENTS_KEY } from "./core/agent-state.mjs";
import { unsettledAccountMove } from "./core/steer-action.mjs";
import { LABEL, METADATA_KEY, readPaseoAgents, readPaseoWorkspaces } from "./core/paseo.mjs";
import { advisorBriefAdmission, isAdvisorSteer, providerIsSensitive, steerPrivacyAdmission } from "./core/config.mjs";
import { continuationOrigin, continuedFromId, resolveFactoryLabels } from "./core/zerosub.mjs";
import { discoveredRepoPublic, steerTitleSlot } from "./core/discovery.mjs";
import { createGh, getRepo, parseRepoInput } from "./core/github.mjs";
import type { QuotaConfirmation } from "../shared/factory.js";
import { getQuotaSampledAt, getQuotaSnapshot } from "./quota.js";
import { resolveZerosub, type ZerosubSource } from "./zerosub-runtime.js";

export interface AdmissionDeps extends ZerosubSource {
  getConfig?: () => Promise<any>;
  now?: () => string;
  paseo?: any;
  getScopePublic?: (workspace: any) => Promise<boolean | null>;
  gh?: (args: string[]) => string;
}

/** Every current brief producer includes unverified data. Text and route hints cannot authorize an exception. */
export function privacyAdmission(agent: any, config: any, repoPublic: boolean | null, knownAgents: any[] = []) {
  const target = privacyTarget(agent, config, knownAgents);
  if (agent && !target) return { allowed: false, reason: "continuation role is unknown; inspect the target before delivery" };
  return steerPrivacyAdmission(config, target, repoPublic);
}

export async function scopePublic(workspace: any, deps: AdmissionDeps): Promise<boolean | null> {
  if (deps.getScopePublic) return deps.getScopePublic(workspace);
  const scope = workspace?.metadata?.[METADATA_KEY]?.scope;
  if (scope?.kind !== "github" || typeof scope.locator !== "string") return null;
  try {
    const name = parseRepoInput(scope.locator).fullName;
    if (typeof scope.id !== "string" || scope.id.toLowerCase() !== name.toLowerCase()) return null;
    const repo = getRepo(deps.gh ?? createGh(), name);
    if (repo.fullName?.toLowerCase() !== name.toLowerCase()) return null;
    return discoveredRepoPublic({ github: { fork: { repo } } });
  } catch {
    return null;
  }
}

function privacyTarget(agent: any, config: any, agents: any[]) {
  const slot = agent?.labels?.[LABEL.slot] ?? steerTitleSlot(agent?.title);
  if (slot && !agent?.labels?.[LABEL.slot]) agent = { ...agent, labels: { ...agent.labels, [LABEL.slot]: slot } };
  if (!continuedFromId(agent)) return agent;
  const origin = continuationOrigin(agent, agents);
  if (!origin) return null;
  const originSlot = origin.labels?.[LABEL.slot] ?? steerTitleSlot(origin.title);
  return { ...agent, labels: resolveFactoryLabels(agent, agents),
    advisor: agent.advisor === true || !advisorBriefAdmission(config, { ...origin,
      labels: { ...origin.labels, [LABEL.slot]: originSlot },
    }).allowed };
}

export async function readPrivacyAdmission(agent: any, deps: AdmissionDeps, workspaceId?: string) {
  const config = await (deps.getConfig?.() ?? null);
  const knownAgents = deps.paseo && continuedFromId(agent) ? await readPaseoAgents(deps.paseo) : [];
  if (!providerIsSensitive(config, agent?.provider)) return privacyAdmission(agent, config, null, knownAgents);
  const workspace = deps.paseo && (workspaceId ?? agent?.workspaceId)
    ? await deps.paseo.workspaces.ref(workspaceId ?? agent.workspaceId).refresh() : null;
  return privacyAdmission(agent, config, await scopePublic(workspace, deps), knownAgents);
}

export async function readPrivacyScopes(deps: AdmissionDeps, config: any, workspaces: any[], agents: any[]) {
  const ids = new Set(agents.filter((agent) => providerIsSensitive(config, agent?.provider))
    .map((agent) => agent.workspaceId).filter(Boolean));
  const pairs = await Promise.all([...ids].map(async (id) => {
    const workspace = workspaces.find((item) => item.id === id);
    return [id, workspace ? await scopePublic(workspace, deps) : null] as const;
  }));
  return Object.fromEntries(pairs) as Record<string, boolean | null>;
}

export interface AdmissionSnapshot {
  config: any;
  zerosub: any;
  nowMs: number;
  quota: any;
  quotaSampledAt: number | null;
  workspaces: any[];
}

/** One observation for all alternatives; effect-time checks take a new one. */
export async function readAdmissionSnapshot(deps: AdmissionDeps, workspaces?: any[]): Promise<AdmissionSnapshot> {
  const [config, zerosub] = await Promise.all([
    deps.getConfig?.() ?? null, resolveZerosub(deps),
  ]);
  const observedWorkspaces = workspaces ?? (deps.paseo && Object.keys(zerosub?.agentAccount ?? {}).length
    ? await readPaseoWorkspaces(deps.paseo) : []);
  return structuredClone({ config, zerosub, workspaces: observedWorkspaces,
    nowMs: deps.now ? Date.parse(deps.now()) : Date.now(),
    quota: getQuotaSnapshot(), quotaSampledAt: getQuotaSampledAt() });
}

/** Quota is fail-soft when unknown, except for an unresolved provider limit. */
export function quotaAdmission(agent: any, entry: any, observed: AdmissionSnapshot, entries: Record<string, any> = {}) {
  const { config, zerosub, nowMs: now, workspaces } = observed;
  const threshold = config?.quota?.exhaustedPct ?? QUOTA_DEFAULTS.exhaustedPct;
  const accountId = zerosub?.agentAccount?.[agent.id] ?? null;
  const account = accountForAgent(zerosub, agent.id);
  const provider = String(agent.provider ?? "").toLowerCase();
  const model = agent.model ?? null;
  const pool = liveAgentPool(agent, config);
  if (unsettledAccountMove(entry?.action)) {
    return { allowed: false, pendingMove: true, confirmation: null, reason: "account move needs reconciliation",
      pool, accountId: entry.action.accountMove.fromAccountId ?? null, resetAt: null };
  }
  const pendingRuntimeAccount = zerosub?.pending?.[agent.id];
  if (pendingRuntimeAccount) {
    // ZeroSub's accountId is the destination during a move. The live session
    // still uses pendingAccountId until the reload lands.
    return {
      allowed: false, pendingMove: true, confirmation: null, reason: "account move pending",
      pool, accountId: pendingRuntimeAccount, resetAt: null,
    };
  }
  const poolSampledAt = observed.quotaSampledAt;
  const snapshot = poolSampledAt !== null && now >= poolSampledAt && now - poolSampledAt <= 30 * 60_000
    ? observed.quota : null;
  const accountSampledAt = Date.parse(account?.sampledAt ?? "");
  const freshAccount = Number.isFinite(accountSampledAt) && now >= accountSampledAt && now - accountSampledAt <= 30 * 60_000;
  const accountPct = freshAccount ? freshMaxUsedPct(account, now, model) : null;
  const limitedUntil = Date.parse(account?.limitedUntil ?? "");
  const explicitlyLimited = account?.exhausted === true && (!Number.isFinite(limitedUntil) || limitedUntil > now ||
    ["limited", "exhausted", "suspended", "blocked"].includes(String(account?.status ?? "").toLowerCase()));
  // The host usage pool can describe another account on this provider. A bound
  // API account may never publish subscription windows. Unknown stays unknown.
  const exhausted = accountId
    ? (explicitlyLimited || limitedUntil > now || (accountPct !== null && accountPct >= threshold))
    : quotaExhausted(snapshot, pool, threshold, now);
  const ownLimit = entry?.quotaLimit ?? (entry?.needsResume?.reason === "limit" ? entry.needsResume : null);
  const limits = [
    ...(ownLimit ? [ownLimit] : []),
    ...(accountId ? Object.values(entries).map((other: any) => other?.quotaLimit)
      .filter((limit) => limit && limit !== ownLimit && limit.accountId === accountId) : []),
    ...(accountId ? workspaces.flatMap((workspace: any) => Object.values(workspace?.metadata?.[AGENTS_KEY] ?? {}))
      .map((other: any) => other?.quotaLimit)
      .filter((limit: any) => limit?.accountId === accountId && limit?.provider && limit?.model) : []),
  ];
  const hardLimit = limits.some((limit) => {
    let applies = true;
    if (limit.provider && String(limit.provider).toLowerCase() !== provider) applies = false;
    if (limit.model && limit.model !== model) applies = false;
    if (limit.accountId && accountId && limit.accountId !== accountId) applies = false;
    const failedAt = Date.parse(limit.at ?? "");
    const resetAt = Date.parse(limit.resetAt ?? "");
    if (Number.isFinite(resetAt) && resetAt > failedAt && resetAt <= now) applies = false;
    const sampledAt = accountId ? accountSampledAt : poolSampledAt;
    const healthy = limit.accountId
      ? accountId === limit.accountId && accountPct !== null && !exhausted
      : accountId ? !exhausted && accountPct !== null : !!quotaEntry(snapshot, pool) && !exhausted;
    if (healthy && sampledAt && Number.isFinite(failedAt) && sampledAt > failedAt) applies = false;
    return applies;
  });
  const poolEntry = quotaEntry(snapshot, pool);
  const known = accountId ? accountPct !== null : quotaPct(poolEntry) !== null ||
    Number.isFinite(poolEntry?.weeklyPct) || poolEntry?.unlimited === true;
  const confirmation: QuotaConfirmation | null = exhausted || hardLimit ? "depleted" : known ? null : "unknown";
  return {
    confirmation,
    allowed: !exhausted && !hardLimit,
    pendingMove: false,
    reason: hardLimit ? "provider limit" : exhausted ? "quota exhausted" : null,
    pool, accountId,
    resetAt: earliestResetOf(account ? [account] : [], { now, model }),
  };
}

/** Activation needs consent for the currently observed quota condition. */
export function activationQuotaAdmission(admission: ReturnType<typeof quotaAdmission>, confirmed?: QuotaConfirmation) {
  if (admission.pendingMove || !admission.confirmation) return admission;
  if (admission.confirmation === confirmed) return { ...admission, allowed: true, reason: null };
  return { ...admission, allowed: false, reason: admission.reason ?? "quota is unknown and needs confirmation" };
}

/** Standalone effect-time admission deliberately never reuses a planning snapshot. */
export async function steerQuotaAdmission(agent: any, entry: any, deps: AdmissionDeps, entries: Record<string, any> = {}) {
  return quotaAdmission(agent, entry, await readAdmissionSnapshot(deps), entries);
}

/** A move needs account-specific fresh evidence, not the fail-soft pool fallback. */
export function movedAccountAdmission(agent: any, entry: any, observed: AdmissionSnapshot, entries: Record<string, any> = {}) {
  const move = entry?.action?.accountMove;
  const accountId = observed.zerosub?.agentAccount?.[agent.id];
  if (!move || !accountId || observed.zerosub?.pending?.[agent.id] ||
      agent.archivedAt || agent.background === true || !["idle", "error"].includes(agent.status) ||
      agent.activeTurn || agent.pendingPermissions?.length ||
      agent.provider !== move.provider || agent.model !== move.model ||
      agent.persistence?.sessionId !== move.sessionId) return { status: "pending" as const };
  const account = accountForAgent(observed.zerosub, agent.id);
  if (!account || String(account.family ?? "").toLowerCase() !== String(agent.provider ?? "").toLowerCase()) {
    return { status: "pending" as const };
  }
  if (isAdvisorSteer(observed.config, agent.labels, agent.metadata)) return { status: "replan" as const };
  const sampledAt = Date.parse(account.sampledAt ?? "");
  const fresh = Number.isFinite(sampledAt) && observed.nowMs >= sampledAt && observed.nowMs - sampledAt <= 30 * 60_000;
  const pct = fresh ? freshMaxUsedPct(account, observed.nowMs, agent.model) : null;
  if (pct === null) return { status: "pending" as const };
  const effectiveEntry = { ...entry, action: { ...entry.action, accountMove: { ...move, phase: "settled" } } };
  const admission = quotaAdmission(agent, effectiveEntry, observed, entries);
  if (!admission.allowed) return { status: "replan" as const, admission };
  return { status: "ready" as const, admission, accountId };
}
