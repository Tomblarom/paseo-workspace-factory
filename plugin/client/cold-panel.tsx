import type {
  PluginAgentPanelProps,
  PluginHostProps,
} from "@getpaseo/plugin/client";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useAgent, useSubscription } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { CacheWarmth } from "../shared/cache-profiles.js";
import { attentionStatus, contextActionFor, type AttentionReason } from "../shared/context-continuation.js";
import { factoryCold } from "../shared/factory.js";
import { ColdActions } from "./cold-actions.js";

const NO_INPUT = {};

interface AttentionRow {
  workspaceId: string;
  agentId: string;
  contextTokens: number;
  idleMinutes: number;
  warmth?: CacheWarmth;
  large?: boolean;
  hasHistory: boolean;
  reason?: AttentionReason;
  freshHint: string | null;
  slot: string | null;
}

function isAttentionReason(value: unknown): value is AttentionReason {
  return value === "daemon-restart" || value === "limit" || value === "failed" || value === "cold";
}

/**
 * Reads the attention feed: rows come from `attention` when present, else
 * from `cold` (the server sends both).
 */
export function attentionRowsOf(event: unknown): AttentionRow[] {
  const record = event as { attention?: unknown; cold?: unknown } | null;
  const list = Array.isArray(record?.attention)
    ? (record.attention as unknown[])
    : Array.isArray(record?.cold)
      ? (record.cold as unknown[])
      : [];
  const rows: AttentionRow[] = [];
  for (const entry of list) {
    const row = entry as Record<string, unknown> | null;
    if (typeof row?.agentId !== "string" || typeof row?.workspaceId !== "string") continue;
    rows.push({
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      contextTokens: typeof row.contextTokens === "number" ? row.contextTokens : 0,
      idleMinutes: typeof row.idleMinutes === "number" ? row.idleMinutes : 0,
      ...(row.warmth === "warm" || row.warmth === "cooling" || row.warmth === "cold" || row.warmth === "unknown" ? { warmth: row.warmth } : {}),
      ...(typeof row.large === "boolean" ? { large: row.large } : {}),
      hasHistory: row.hasHistory === true,
      ...(isAttentionReason(row.reason) ? { reason: row.reason } : {}),
      freshHint:
        typeof row.freshHint === "string" && row.freshHint.trim() !== "" ? row.freshHint : null,
      slot: typeof row.slot === "string" && /^[A-Z]$/i.test(row.slot) ? row.slot : null,
    });
  }
  return rows;
}

/** Follows the server's cold list and picks the row for one agent. */
function useColdSelf(agentId: string): AttentionRow | null | undefined {
  const [self, setSelf] = useState<AttentionRow | null>();
  const onEvent = useCallback((event: unknown) => {
    setSelf(attentionRowsOf(event).find((row) => row.agentId === agentId) ?? null);
  }, [agentId]);
  useSubscription(factoryCold, NO_INPUT, onEvent);
  return self;
}

function useColdStyles(theme: PluginHostProps["theme"], compact: boolean) {
  return useMemo(
    () => ({
      screen: { padding: 8, gap: 6 },
      title: { color: theme.colors.foreground, fontSize: compact ? 15 : 16 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [theme, compact],
  );
}

function ColdBody({
  agentId,
  workspaceId,
  theme,
  compact,
  close,
}: {
  agentId: string;
  workspaceId: string;
  theme: PluginHostProps["theme"];
  compact: boolean;
  close?: () => void;
}) {
  const styles = useColdStyles(theme, compact);
  const self = useColdSelf(agentId);
  const agent = useAgent(agentId, ({ status }) => ({ status }));
  if (self === undefined) {
    return (
      <View style={styles.screen}>
        <Text style={styles.muted}>Checking chat…</Text>
      </View>
    );
  }
  const action = contextActionFor(self);
  return (
    <View style={styles.screen}>
      {self ? <Text style={styles.title}>{attentionStatus(self)}</Text> : null}
      {self?.reason === "limit" ? (
        <Text style={styles.muted}>
          Wait until your usage limit resets.
        </Text>
      ) : null}
      <ColdActions
        agentId={agentId}
        workspaceId={self?.workspaceId ?? workspaceId}
        action={action}
        slot={self?.slot}
        hasHistory={self?.hasHistory}
        running={agent?.status === "running" || agent?.status === "initializing"}
        theme={theme}
        close={close}
      />
    </View>
  );
}

/** Per-agent panel; shows the cold hint only for its own cold agent. */
export function FactoryColdPanel({ agentId, workspaceId, theme, layout }: PluginAgentPanelProps) {
  return (
    <ScrollView>
      <ColdBody key={agentId} agentId={agentId} workspaceId={workspaceId} theme={theme} compact={layout.compact} />
    </ScrollView>
  );
}

/** Composer pill popover content; the pill itself is managed by the entry. */
export function FactoryColdPillContent(props: PluginButtonContentProps) {
  if (props.context !== "agent") return null;
  return (
    <ColdBody
      key={props.agentId}
      agentId={props.agentId}
      workspaceId={props.workspaceId}
      theme={props.theme}
      compact={props.layout.compact}
      close={props.close}
    />
  );
}
