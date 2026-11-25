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
  if (reason === "daemon-restart") return "Paseo wurde neu gestartet";
  if (reason === "limit") return "Nutzungslimit erreicht";
  if (reason === "failed") return "Letzte Antwort fehlgeschlagen";
  if (freshHint) return "Auffrischen empfohlen";
  const idle = idleMinutes < 60 ? `${idleMinutes} min` : `${Math.floor(idleMinutes / 60)} h`;
  return `Kontext kalt · seit ${idle} inaktiv`;
}
