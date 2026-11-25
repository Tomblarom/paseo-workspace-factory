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

function usedTokensOf(agent: any): unknown {
  const snapshot = agent?.lastUsage ?? agent?.LastUsage ?? null;
  return snapshot?.contextWindowUsedTokens ?? snapshot?.ContextWindowUsedTokens ?? null;
}

/** Cache timing and retained context from the same snapshot across Factory paths. */
export function agentContextInputs(
  agent: any,
  entry: Record<string, unknown> | null,
  settings: CleanupSettings,
  routes: ZerosubState,
  nowMs: number,
) {
  const pendingDelivery = asRecord(entry?.pendingWakeBrief);
  const deliveryPhase = pendingDelivery?.phase ??
    (pendingDelivery ? entry?.pendingAction ? "renewing" : entry?.actionVerified === true ? "ready" : "blocked" : null);
  const pendingOperation = entry?.pendingAction != null ||
    deliveryPhase === "renewing" || deliveryPhase === "ready" || deliveryPhase === "sent";
  const resumeFallback = deliveryPhase === "blocked"
    ? typeof pendingDelivery?.lastError === "string" ? pendingDelivery.lastError : "Context renewal needs attention."
    : null;
  const lastTurnEndedAt =
    typeof entry?.lastTurnEndedAt === "string" ? (entry.lastTurnEndedAt as string) : null;
  const lastEnd = stampMs(lastTurnEndedAt);
  const clearedAt = stampMs(asRecord(entry?.cleared)?.at);
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
  return {
    nowMs, agentId: agent.id, provider, model, lastTurnEndedAt, cleanedAfter,
    cacheTtl: cacheTtlForAgent(agent, routes),
    cacheStartAt: typeof entry?.cacheStartAt === "string" ? entry.cacheStartAt : null,
    baselineValid, prefixBreakRetained,
    liveUsedTokens: cleanedAfter ? null : usedTokensOf(agent),
    storedTokens, storedSameSession: baselineValid,
    cleanupProfile: settings.profile, minContextTokens: settings.minContextTokens,
    liveThinking, liveSpeed, liveSessionId, baseline,
    pendingOperation, resumeFallback,
  };
}
