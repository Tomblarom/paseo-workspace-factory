import type { CacheWarmth } from "./cache-profiles.js";

export type AttentionReason = "daemon-restart" | "limit" | "failed" | "cold";

export type ContextAction = "continue" | "refresh" | "unavailable";

interface ContextAttention {
  reason?: AttentionReason;
  warmth?: CacheWarmth;
  large?: boolean;
  freshHint: string | null;
  slot: string | null;
}

export function contextActionFor(attention: ContextAttention | null): ContextAction {
  if (!attention) return "continue";
  const { reason, warmth, large, freshHint, slot } = attention;
  const refresh =
    !reason || reason === "cold" || reason === "daemon-restart" ||
    warmth === "cold" || warmth === "unknown" || large === true || Boolean(freshHint);
  if (!refresh) return "continue";
  return slot ? "refresh" : "unavailable";
}

export function attentionStatus({
  reason,
  freshHint,
  idleMinutes,
}: {
  reason?: AttentionReason;
  freshHint: string | null;
  idleMinutes: number;
}): string {
  if (reason === "daemon-restart") return "Paseo restarted";
  if (reason === "limit") return "Usage limit reached";
  if (reason === "failed") return "Last reply failed";
  if (freshHint) return "Chat refresh recommended";
  const idle = idleMinutes < 60 ? `${idleMinutes} min` : `${Math.floor(idleMinutes / 60)} h`;
  return `Idle chat · ${idle}`;
}
