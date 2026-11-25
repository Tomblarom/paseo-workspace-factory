export type AttentionReason = "daemon-restart" | "limit" | "failed" | "cold";

export type ContextAction = "continue" | "refresh" | "unavailable";

interface ContextAttention {
  reason?: AttentionReason;
  idleMinutes: number;
  contextTokens: number;
  freshHint: string | null;
  slot: string | null;
}

export function contextActionFor(
  attention: ContextAttention | null,
  { ttlMinutes, minContextTokens }: { ttlMinutes: number; minContextTokens: number },
): ContextAction {
  if (!attention) return "continue";
  const { reason, idleMinutes, contextTokens, freshHint, slot } = attention;
  const refresh =
    !reason || reason === "cold" || reason === "daemon-restart" ||
    idleMinutes >= ttlMinutes || contextTokens >= minContextTokens || Boolean(freshHint);
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
