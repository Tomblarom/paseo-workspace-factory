import { readSteerAction, readCleanupAction, unsettledAccountMove } from "./core/steer-action.mjs";
import { actionFact } from "./core/action-facts.mjs";
import { openTurnOf } from "../shared/auto-checkpoint.js";
import { cacheTtlForAgent } from "../shared/cache-profiles.js";
import { type CleanupSettings } from "../shared/idle-cleanup.js";
import { normalizeModel, normalizeProvider, normalizeThinking, speedOfLiveOptions, tupleFromLive, tuplesEqual } from "../shared/steer-settings.js";
import { type ZerosubState } from "./zerosub-runtime.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function stampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function contextUsageOf(agent: any) {
  const snapshot = agent?.lastUsage ?? agent?.LastUsage ?? null;
  return {
    used: snapshot?.contextWindowUsedTokens ?? snapshot?.ContextWindowUsedTokens ?? null,
    max: snapshot?.contextWindowMaxTokens ?? snapshot?.ContextWindowMaxTokens ?? null,
  };
}

/** Snapshot checks complement turn hooks, which run asynchronously. */
export function hasActiveAgentWork(agent: any, entry?: any): boolean {
  return Boolean(unsettledAccountMove(readSteerAction(entry)) || agent?.activeTurn || agent?.status === "running" || agent?.status === "initializing" ||
    agent?.pendingPermissions?.length || (agent?.status !== "closed" && openTurnOf(entry)));
}

export class AgentBusyError extends Error {}

/** Cache timing and retained context from the same snapshot across Factory paths. */
export function agentContextInputs(
  agent: any,
  entry: Record<string, unknown> | null,
  settings: CleanupSettings,
  routes: ZerosubState,
  nowMs: number,
  providers: any[] = [],
) {
  const pendingDelivery = asRecord(readSteerAction(entry));
  const deliveryPhase = pendingDelivery?.phase ??
    (pendingDelivery ? readCleanupAction(entry) ? "renewing" : actionFact(entry, "actionVerified") === true ? "ready" : "blocked" : null);
  const cleanup = readCleanupAction(entry);
  const pendingMove = unsettledAccountMove(pendingDelivery);
  const pendingOperation = pendingMove || cleanup != null ||
    deliveryPhase === "renewing" || deliveryPhase === "rewinding" || deliveryPhase === "ready" || deliveryPhase === "sent" || deliveryPhase === "uncertain" || deliveryPhase === "reserved";
  const uncertainCleanup = deliveryPhase === "renewing" && asRecord(cleanup)?.uncertain === true;
  const resumeFallback = pendingMove ? "Account move is awaiting confirmation." : deliveryPhase === "blocked" || deliveryPhase === "uncertain" || deliveryPhase === "rewinding" || uncertainCleanup
    ? typeof pendingDelivery?.lastError === "string" ? pendingDelivery.lastError
    : typeof asRecord(cleanup)?.error === "string" ? `Cleanup outcome is uncertain (${asRecord(cleanup)?.error}). Inspect the agent before recovery.`
    : "Context renewal needs attention."
    : null;
  const lastTurnEndedAt =
    typeof entry?.lastTurnEndedAt === "string" ? (entry.lastTurnEndedAt as string) : null;
  const lastEnd = stampMs(lastTurnEndedAt);
  const clearedAt = stampMs(asRecord(actionFact(entry, "cleared"))?.at);
  const cleanedAfter = clearedAt !== null && (lastEnd === null || clearedAt >= lastEnd);
  const baselineValid = lastEnd !== null && !cleanedAfter && !pendingOperation;
  const provider = typeof agent.provider === "string" && agent.provider ? agent.provider : null;
  const model = typeof agent.model === "string" && agent.model ? agent.model : null;
  // Step-4 live tuple and turn-end baseline for prefix-break detection and
  // the observed-change warning. Without a stored baseline the projection
  // keeps its v1 behavior (prefix break stays false).
  const liveThinkingRaw = typeof agent.effectiveThinkingOptionId === "string"
    ? agent.effectiveThinkingOptionId
    : (typeof agent.thinkingOptionId === "string" ? agent.thinkingOptionId : null);
  const liveThinking = normalizeThinking(liveThinkingRaw);
  const liveSpeed = speedOfLiveOptions(provider, model, agent.options ?? null);
  const liveSessionId = typeof agent?.persistence?.sessionId === "string" && agent.persistence.sessionId
    ? agent.persistence.sessionId
    : null;
  const liveTuple = tupleFromLive({ provider, model, thinking: liveThinking, speed: liveSpeed });
  const baselineRaw = asRecord(entry?.settingsBaseline);
  const baselineSession = typeof baselineRaw?.sessionId === "string" && baselineRaw.sessionId
    ? baselineRaw.sessionId
    : null;
  const baseline = baselineRaw && baselineSession
    ? {
      provider: normalizeProvider(baselineRaw.provider),
      model: normalizeModel(baselineRaw.model),
      thinking: normalizeThinking(baselineRaw.thinking),
      speed: typeof baselineRaw.speed === "string" && baselineRaw.speed.trim()
        ? baselineRaw.speed.trim().toLowerCase()
        : null,
      sessionId: baselineSession,
    }
    : null;
  const comparable = !cleanedAfter && baseline !== null && liveSessionId !== null && baseline.sessionId === liveSessionId;
  const prefixBreakRetained = comparable && baseline !== null && !tuplesEqual(liveTuple, {
    provider: baseline.provider,
    model: baseline.model,
    thinking: baseline.thinking,
    speed: baseline.speed,
  });
  const storedTokens = entry?.contextTokens;
  const usage = contextUsageOf(agent);
  const catalogModel = providers.find((item) => item.provider === provider)?.models?.find((item: any) =>
    item.id === model || item.aliases?.includes(model));
  return {
    nowMs, agentId: agent.id, provider, model, lastTurnEndedAt, cleanedAfter,
    cacheTtl: cacheTtlForAgent(agent, routes),
    cacheStartAt: typeof entry?.cacheStartAt === "string" ? entry.cacheStartAt : null,
    baselineValid, prefixBreakRetained,
    liveUsedTokens: cleanedAfter ? null : usage.used,
    contextWindowMaxTokens: usage.max ?? catalogModel?.contextWindowMaxTokens,
    storedTokens, storedSameSession: baselineValid,
    cleanupProfile: settings.profile, minContextTokens: settings.minContextTokens,
    liveThinking, liveSpeed, liveSessionId, baseline,
    pendingOperation, resumeFallback,
  };
}
