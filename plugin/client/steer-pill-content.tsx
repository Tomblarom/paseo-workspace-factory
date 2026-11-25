import type {
  PluginButtonContentProps,
  PluginHostProps,
} from "@getpaseo/plugin/client";
import { useAgent, useComposers, useSubscription } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { factorySteers } from "../shared/factory.js";
import { STEER_STATE_LABELS } from "../shared/steer-state.js";
import { ResultView, type FactoryResultStyles } from "./factory-panel.js";
import { getFactoryResult, subscribeFactoryResult } from "./factory-store.js";
import { READONLY_FACTORY_RESULT_ACTIONS } from "./result-pill.js";
import { SteerMenu } from "./steer-menu-content.js";
import { getSteerResult, registerSteerHost, subscribeSteerResult } from "./steer-results.js";
import {
  describeRoute,
  formatContextTokens,
  formatQuotaRow,
  nextTickDelayMs,
  speedOfOptions,
  steerHeaderTitle,
  steerRowsOf,
  steerStateColor,
  STEER_PRIMARY_ACTION_LABELS,
  type SteerPillRow,
} from "./steer-pill.js";

const NO_INPUT = {};

function useSteerSelf(agentId: string): SteerPillRow[] | null {
  const [rows, setRows] = useState<SteerPillRow[] | null>(null);
  const onEvent = useCallback((event: unknown) => {
    setRows(steerRowsOf(event));
  }, []);
  useSubscription(factorySteers, NO_INPUT, onEvent);
  return rows;
}

function useSteerStyles(theme: PluginHostProps["theme"], compact: boolean) {
  return useMemo(
    () => ({
      box: { padding: compact ? 12 : 16, gap: 8, minWidth: 280 },
      title: { color: theme.colors.foreground, fontSize: compact ? 15 : 16 },
      body: { color: theme.colors.foreground, fontSize: 14 },
      label: { color: theme.colors.foregroundMuted, fontSize: 13 },
      section: { color: theme.colors.foreground, fontSize: 14 },
      button: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontSize: 14, textAlign: "center" as const },
    }),
    [theme, compact],
  );
}

function SteerBody({
  hostId,
  agentId,
  workspaceId,
  theme,
  compact,
  close,
}: {
  hostId: string;
  agentId: string;
  workspaceId: string;
  theme: PluginHostProps["theme"];
  compact: boolean;
  close: () => void;
}) {
  const styles = useSteerStyles(theme, compact);
  const rows = useSteerSelf(agentId);
  const self = rows?.find((row) => row.agentId === agentId) ?? null;
  const agent = useAgent(agentId, ({ provider, model, thinkingOptionId, status }) => ({
    provider,
    model,
    thinkingOptionId,
    status,
  }));
  const [composer] = useComposers({ agentId });
  // Local countdown clock. It lives in its own state so quota ticks never
  // touch an open confirmation (step 3 keeps previews in separate state).
  const [nowMs, setNowMs] = useState(() => Date.now());
  const nextBoundaryAt = self?.nextBoundaryAt ?? null;
  useEffect(() => {
    const delay = nextTickDelayMs(nextBoundaryAt, Date.now());
    const timer = setTimeout(() => setNowMs(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [nextBoundaryAt, nowMs]);
  useEffect(() => {
    registerSteerHost(hostId);
  }, [hostId]);
  const [result, setResult] = useState(() => getFactoryResult());
  useEffect(() => subscribeFactoryResult(() => setResult(getFactoryResult())), []);
  // This tab's own result wins; without one the last global /factory result shows.
  const [ownResult, setOwnResult] = useState(() => getSteerResult(hostId, agentId));
  useEffect(
    () => subscribeSteerResult(hostId, agentId, () => setOwnResult(getSteerResult(hostId, agentId))),
    [hostId, agentId],
  );
  const shown = ownResult ?? result;
  const resultStyles = useMemo<FactoryResultStyles>(
    () => ({
      label: styles.label,
      body: styles.body,
      hash: styles.body,
      error: { color: theme.colors.statusDanger, fontSize: 14 },
      conflict: { color: theme.colors.statusWarning, fontSize: 14 },
      ok: { color: theme.colors.statusSuccess, fontSize: 14 },
      card: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 12,
        gap: 4,
      },
      button: styles.button,
      buttonText: styles.buttonText,
    }),
    [styles, theme],
  );

  if (rows === null) {
    return (
      <View style={styles.box}>
        <Text style={styles.label}>Loading steer status…</Text>
      </View>
    );
  }
  if (!self) {
    return (
      <View style={styles.box}>
        <Text style={styles.label}>Steer status unavailable.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close steer menu"
          style={styles.button}
          onPress={close}
        >
          <Text style={styles.buttonText}>Close</Text>
        </Pressable>
      </View>
    );
  }
  const stateLabel = STEER_STATE_LABELS[self.state] ?? "Unknown";
  const route = describeRoute({
    provider: agent?.provider ?? self.provider,
    model: agent?.model ?? self.model,
    thinking: agent?.thinkingOptionId ?? composer?.agent.thinking ?? null,
    speed: speedOfOptions(composer?.agent.options),
  });
  return (
    <ScrollView>
      <View style={styles.box}>
        <Text accessibilityRole="header" style={styles.title}>
          {steerHeaderTitle(self)}
        </Text>
        <Text style={{ color: steerStateColor(theme, self.state, self.large), fontSize: 14 }}>
          {stateLabel} · {self.detail}
        </Text>
        {route ? <Text style={styles.body}>{route}</Text> : null}
        <Text style={styles.body}>{formatContextTokens(self.tokens)}</Text>
        <Text style={styles.body}>Cache {self.warmth}</Text>
        {self.headerFacts.map((fact) => (
          <Text key={fact} style={styles.label}>
            {fact}
          </Text>
        ))}
        <Text style={styles.section}>Quota</Text>
        {self.awaitingUpdate ? <Text style={styles.label}>Awaiting quota update</Text> : null}
        {self.quotaRows.length === 0 && !self.limited ? (
          <Text style={styles.label}>No quota data</Text>
        ) : null}
        {self.quotaRows.map((quota) => (
          <Text key={`${quota.scope}:${quota.id}`} style={styles.body}>
            {formatQuotaRow(quota, nowMs)}
          </Text>
        ))}
        {self.limited && self.resetUnknown ? (
          <Text style={styles.label}>Reset unknown</Text>
        ) : null}
        {self.successor ? (
          <Text style={styles.label}>Continues in {self.successor}</Text>
        ) : null}
        <Text style={styles.label}>
          Next step: {STEER_PRIMARY_ACTION_LABELS[self.primaryAction]}
        </Text>
        <SteerMenu
          hostId={hostId}
          agentId={agentId}
          workspaceId={workspaceId}
          rows={rows}
          self={self}
          theme={theme}
          compact={compact}
          nowMs={nowMs}
          close={close}
        />
        <Text style={styles.section}>
          {ownResult ? "Last result for this steer" : "Last /factory result"}
        </Text>
        <ResultView result={shown} styles={resultStyles} actions={READONLY_FACTORY_RESULT_ACTIONS} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close steer menu"
          style={styles.button}
          onPress={close}
        >
          <Text style={styles.buttonText}>Close</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

/** Persistent steer pill popover; the pill itself is managed by the entry. */
export function FactorySteerPillContent(props: PluginButtonContentProps) {
  if (props.context !== "agent") return null;
  return (
    <SteerBody
      key={props.agentId}
      hostId={props.host.id}
      agentId={props.agentId}
      workspaceId={props.workspaceId}
      theme={props.theme}
      compact={props.layout.compact}
      close={props.close}
    />
  );
}
