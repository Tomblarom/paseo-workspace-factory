import { planRoutes } from "./core/routing.mjs";
import { reserveManagedSteerCreation } from "./core/managed-steer.mjs";
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

interface RouteEvidence {
  uncachedInputTokens: number | null;
  preparationTurns: number | null;
  latencyMs: number | null;
  preferenceRank: number | null;
}

export function noSuitableSteerPolicy(config: RoutingSnapshot["config"]): "create" | "offer" | "wait" {
  const policy = config?.routing?.noSuitableSteer;
  return policy === "create" || policy === "offer" ? policy : "wait";
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
  snapshot: RoutingSnapshot; kind?: "continue" | "handover" | "move" | "renewal"; manual?: boolean;
  admission?: ReturnType<typeof quotaAdmission>;
  move?: { supported: boolean; eligible: boolean; admission: ReturnType<typeof quotaAdmission> };
  renewal?: { supported: boolean; eligible: boolean; preparation: "clear" | "rewind" };
  retry?: boolean; eligible?: boolean; reason?: string; preferenceRank?: number;
  evidence?: Partial<RouteEvidence>; confidence?: "observed" | "estimated" | "unknown";
}) {
  const { agent, entry, entries, row, snapshot } = args;
  const kind = args.kind ?? "continue";
  const admission = (kind === "move" ? args.move?.admission : args.admission) ?? quotaAdmission(agent, entry, snapshot, entries);
  const privacy = snapshot.privacyDecisions?.[agent.id] ?? privacyAdmission(agent, snapshot.config, snapshot.privacyScopes?.[agent.workspaceId] ?? null);
  const delivery = decideSteerDelivery({ warmth: row?.warmth, large: row?.large,
    provider: String(agent.provider ?? "").trim().toLowerCase(), manual: args.manual,
    recovery: !!entry?.needsResume, retry: args.retry, settings: snapshot.resume,
    keepChatHistory: snapshot.keepChatHistory });
  const preparation = kind === "move" ? "send" : kind === "renewal" ? args.renewal?.preparation ?? delivery : delivery;
  const native = kind === "move" ? args.move : kind === "renewal" ? args.renewal : null;
  let nativeReason = null;
  if (kind === "move" || kind === "renewal") {
    const prepared = kind === "move" ? args.move?.admission?.accountId : args.renewal?.preparation;
    if (native?.supported !== true) nativeReason = `native ${kind} unavailable`;
    else if (native.eligible !== true || !prepared) nativeReason = `native ${kind} ineligible`;
  }
  const priorities = snapshot.config?.steers?.priority;
  const preferred = Array.isArray(priorities) ? priorities.findIndex((name: string) => {
    const preset = snapshot.config?.profiles?.[name];
    return preset?.provider === agent.provider && preset?.model === agent.model &&
      (!preset.thinking || preset.thinking === (agent.effectiveThinkingOptionId ?? agent.thinkingOptionId)) &&
      (!preset.mode || preset.mode === agent.effectiveModeId || preset.mode === agent.modeId);
  }) : -1;
  return {
    id: kind === "move" ? `move:${agent.id}:${args.move?.admission?.accountId ?? "unknown"}` : `${kind}:${agent.id}`,
    kind, agentId: agent.id, provider: agent.provider, model: agent.model,
    eligible: args.eligible !== false && !nativeReason && privacy.allowed && admission.allowed,
    reason: args.eligible === false ? args.reason ?? "target ineligible" : nativeReason ?? privacy.reason ?? admission.reason ?? "eligible",
    preparation, admission, privacy, confidence: args.confidence ?? "estimated",
    // TTL alone cannot prove cached input or task-relevant context.
    evidence: { uncachedInputTokens: null, latencyMs: null,
      preparationTurns: kind === "move" ? null : preparation === "send" ? 0 : 1,
      preferenceRank: Array.isArray(priorities) ? preferred >= 0 ? preferred : null : args.preferenceRank ?? null,
      ...args.evidence },
  };
}

export interface ManagedCreation {
  idempotencyKey: string;
  request: { workspaceId: string; title: string; config: any; labels: Record<string, string>; metadata: Record<string, unknown> };
  expected: { provider: string; model: string };
  cycleKey: string;
  phase: "pending" | "failed" | "completed";
  generation: number;
  attempts: number;
  backoffUntil: number | null;
  exhausted: boolean;
}

interface ManagedCreationInput {
  state: ManagedCreation | null;
  cycleKey: string;
  now: number;
  steers: any[];
  eligibleLiveSteerIds: string[];
  create: {
    keyScope: string; repo: string; scopeId: string; slot: string; workspaceId: string;
    profile: { provider: string; model: string }; keyParts: string[]; metadata: Record<string, unknown>;
  };
}

type ManagedCreationDecision =
  | { action: "create" | "reconcile"; state: ManagedCreation }
  | { action: "wait"; reason: string; state: ManagedCreation | null }
  | { action: "reuse"; agentId: string; state: ManagedCreation | null };

/** A create route carries the exact P3 reservation an executor must persist before dispatch. */
export function managedSteerRouteCandidate(
  snapshot: RoutingSnapshot,
  input: ManagedCreationInput,
  preferenceRank: number | null = null,
) {
  if (noSuitableSteerPolicy(snapshot.config) !== "create") return null;
  const reserve = reserveManagedSteerCreation as unknown as (args: ManagedCreationInput & { config: any }) => ManagedCreationDecision;
  const decision = reserve({ ...input, config: snapshot.config });
  const candidate = decision.action === "create" ? {
    id: decision.state.idempotencyKey, kind: "create", eligible: true, reason: "managed steer creation available",
    provider: decision.state.expected.provider, model: decision.state.expected.model,
    confidence: "estimated", evidence: { uncachedInputTokens: null, latencyMs: null, preparationTurns: 1, preferenceRank },
  } : null;
  return { decision, candidate };
}

export function planSteerRoutes(snapshot: RoutingSnapshot, candidates: any[], options: {
  intent?: RoutingIntent;
  observation?: any; due?: boolean;
} = {}) {
  return (planRoutes as any)({ due: options.due ?? true,
    strategy: snapshot.config?.routing?.strategy ?? "efficiency", candidates,
    intent: options.intent ?? { mode: "automatic" }, observation: options.observation });
}
