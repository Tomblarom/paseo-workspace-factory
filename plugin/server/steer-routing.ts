import { planRoutes } from "./core/routing.mjs";
import { privacyAdmission, quotaAdmission, readAdmissionSnapshot, readPrivacyScopes, type AdmissionDeps, type AdmissionSnapshot } from "./steer-admission.js";
import { collectSteerStates, type SteerFeedRow } from "./steer-feed.js";
import { isClaudeProvider, mayResumeClear, type CleanupSettings, type ResumeClearSettings } from "../shared/idle-cleanup.js";

export interface RoutingDeps extends AdmissionDeps {
  getCleanupSettings?: () => Promise<CleanupSettings | null>;
  getResumeSettings?: () => Promise<ResumeClearSettings | null>;
  keepChatHistory?: () => Promise<boolean>;
}

export interface RoutingSnapshot extends AdmissionSnapshot {
  cleanup: CleanupSettings | null;
  resume: ResumeClearSettings | null;
  keepChatHistory: boolean;
  privacyScopes: Record<string, boolean | null>;
  privacyDecisions: Record<string, ReturnType<typeof privacyAdmission>>;
}

export interface RoutingIntent {
  mode: "automatic" | "explicit";
  agentId?: string;
  provider?: string;
  model?: string;
}

/** Capture once per decision. A snapshot is never reused as effect-time authority. */
export async function readRoutingSnapshot(deps: RoutingDeps, workspaces?: any[], agents: any[] = [], knownAgents = agents): Promise<RoutingSnapshot> {
  const [admission, cleanup, resume, keepChatHistory] = await Promise.all([
    readAdmissionSnapshot(deps, workspaces), deps.getCleanupSettings?.() ?? null,
    deps.getResumeSettings?.() ?? null, deps.keepChatHistory?.() ?? false,
  ]);
  const privacyScopes = await readPrivacyScopes(deps, admission.config, admission.workspaces, agents);
  const privacyDecisions = Object.fromEntries(agents.map((agent) => [agent.id,
    privacyAdmission(agent, admission.config, privacyScopes[agent.workspaceId] ?? null, knownAgents)]));
  return structuredClone({ ...admission, cleanup, resume, keepChatHistory, privacyScopes, privacyDecisions });
}

export function routingProjection(state: any, snapshot: RoutingSnapshot) {
  return collectSteerStates(state, { settings: snapshot.cleanup, config: snapshot.config,
    zerosub: snapshot.zerosub, nowMs: snapshot.nowMs,
    quotaSnapshot: snapshot.quota, poolSampledAtMs: snapshot.quotaSampledAt });
}

/** The same preparation for explicit activation, delivery and automatic takeover. */
export function decideSteerDelivery({
  warmth, large, provider, manual, recovery, retry, settings, keepChatHistory,
}: {
  warmth?: string; large?: boolean; provider?: string; manual?: boolean; recovery?: boolean; retry?: boolean;
  settings: ResumeClearSettings | null; keepChatHistory: boolean;
}): "send" | "clear" | "rewind" {
  if (keepChatHistory && !manual) return "send";
  const mode = isClaudeProvider(provider) && !keepChatHistory && mayResumeClear(provider, settings)
    ? "clear" : "rewind";
  if (large || warmth === "cold" || retry || (manual && mode === "rewind")) return mode;
  if (warmth === "warm" || warmth === "cooling") return "send";
  return manual || recovery ? mode : "send";
}

/** Caller establishes membership and permission before admission. */
export function steerRouteCandidate(args: {
  agent: any; entry: any; entries?: Record<string, any>; row?: SteerFeedRow;
  snapshot: RoutingSnapshot; kind?: "continue" | "handover"; manual?: boolean;
  admission?: ReturnType<typeof quotaAdmission>;
  retry?: boolean; eligible?: boolean; reason?: string; preferenceRank?: number;
}) {
  const { agent, entry, entries, row, snapshot } = args;
  const admission = args.admission ?? quotaAdmission(agent, entry, snapshot, entries);
  const privacy = snapshot.privacyDecisions?.[agent.id] ?? privacyAdmission(agent, snapshot.config, snapshot.privacyScopes?.[agent.workspaceId] ?? null);
  const preparation = decideSteerDelivery({ warmth: row?.warmth, large: row?.large,
    provider: String(agent.provider ?? "").trim().toLowerCase(), manual: args.manual,
    recovery: !!entry?.needsResume, retry: args.retry, settings: snapshot.resume,
    keepChatHistory: snapshot.keepChatHistory });
  const kind = args.kind === "handover" ? "handover" : preparation === "send" ? "continue" : "renewal";
  const priorities = snapshot.config?.steers?.priority;
  const preferred = Array.isArray(priorities) ? priorities.findIndex((name: string) => {
    const preset = snapshot.config?.profiles?.[name];
    return preset?.provider === agent.provider && preset?.model === agent.model &&
      (!preset.thinking || preset.thinking === (agent.effectiveThinkingOptionId ?? agent.thinkingOptionId)) &&
      (!preset.mode || preset.mode === agent.effectiveModeId || preset.mode === agent.modeId);
  }) : -1;
  return {
    id: `${kind}:${agent.id}`, kind, agentId: agent.id, provider: agent.provider, model: agent.model,
    eligible: args.eligible !== false && privacy.allowed && admission.allowed,
    reason: args.eligible === false ? args.reason ?? "target ineligible" : privacy.reason ?? admission.reason ?? "eligible",
    preparation, admission, privacy, confidence: "estimated",
    // No measured cross-route cache/input or latency costs yet. Keep them
    // unknown; TTL alone cannot prove cached input or task-relevant context.
    evidence: { uncachedInputTokens: null, latencyMs: null,
      preparationTurns: preparation === "send" ? 0 : 1,
      preferenceRank: Array.isArray(priorities) ? preferred >= 0 ? preferred : null : args.preferenceRank ?? null },
  };
}

export function planSteerRoutes(snapshot: RoutingSnapshot, candidates: any[], options: {
  intent?: RoutingIntent;
  observation?: any; due?: boolean;
} = {}) {
  return (planRoutes as any)({ due: options.due ?? true,
    strategy: snapshot.config?.routing?.strategy ?? "efficiency", candidates,
    intent: options.intent ?? { mode: "automatic" }, observation: options.observation });
}
