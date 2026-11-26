import type { RpcInput } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { CACHE_CHECK_INTERVAL_MS } from "../shared/cache-profiles.js";
import type { factoryPlan } from "../shared/factory.js";
import type { FactoryResultStyles } from "./factory-panel.js";
import {
  enrollmentPlan,
  label,
  pendingWorkspaceWork,
  record,
  steerConditions,
  steerName,
  workspaceSteers,
  type FactorySteerFeed,
  type WorkspaceStatus,
} from "./factory-workspace-state.js";

interface Props extends Pick<PluginWorkspacePanelProps, "workspaceId" | "layout" | "host" | "navigation" | "theme"> {
  view: "Overview" | "Steers";
  feed: FactorySteerFeed;
  styles: FactoryResultStyles;
  status: WorkspaceStatus | undefined;
  statusUpdatedAt: number;
  statusError: Error | null;
  statusFetching: boolean;
  refresh: () => void;
  setup: (plan: RpcInput<typeof factoryPlan>) => void;
  setupBusy: boolean;
}

export function FactoryWorkspaceStatus({
  view, workspaceId, layout, host, navigation, theme, feed, styles, status, statusUpdatedAt,
  statusError, statusFetching, refresh, setup, setupBusy,
}: Props) {
  const observation = useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
  const [expired, setExpired] = useState<typeof observation | null>(null);
  const [showTests, setShowTests] = useState(false);
  useEffect(() => {
    if (observation.disconnected) return;
    const deadline = observation.receivedAt + 2 * CACHE_CHECK_INTERVAL_MS;
    const timer = setTimeout(() => setExpired(observation), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [observation]);
  const stale = observation.disconnected || expired === observation;
  const setupPlan = enrollmentPlan(statusError, workspaceId);
  const state = record(status?.state);
  const checkpoint = record(status?.checkpoint);
  const task = label(checkpoint?.task);
  const next = label(checkpoint?.next);
  const tests = (Array.isArray(checkpoint?.tests) ? checkpoint.tests : []).map(label).filter(Boolean);
  const blockers = (Array.isArray(checkpoint?.blockers) ? checkpoint.blockers : []).map(label).filter(Boolean);
  const checkpointsComparable = typeof checkpoint?.epoch === "number" && typeof state?.epoch === "number";
  const checkpointConfidence = checkpoint?.interrupted ? "Interrupted checkpoint" : !checkpointsComparable
    ? "Checkpoint freshness unknown" : checkpoint.epoch === state.epoch ? "Current checkpoint" : "Checkpoint from an earlier controller";

  const assignedSlot = label(state?.activeSteer);
  const { steers, controller, ambiguous, advisorAssigned } = workspaceSteers(observation.rows, workspaceId, assignedSlot);
  const pending = pendingWorkspaceWork(status, steers);
  const controllerText = controller ? steerName(controller) : ambiguous ? "Steer membership is ambiguous"
    : advisorAssigned ? "Assigned steer is an advisor" : state?.retired === true ? "Factory scope is retired"
      : stale || !observation.rows ? "Unknown" : assignedSlot ? `No live controller for Steer ${assignedSlot}` : "None reported";
  const sectionHeading = { ...styles.body, fontSize: layout.compact ? 18 : 21, fontWeight: "600" as const };
  const detailHeading = { ...styles.body, fontWeight: "600" as const };
  const taskText = { ...styles.body, fontSize: layout.compact ? 18 : 22, lineHeight: layout.compact ? 25 : 31 };
  const actionText = { ...styles.body, textDecorationLine: "underline" as const };
  const rowHeader = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const };
  const card = { ...styles.card, gap: 12, padding: layout.compact ? 14 : 18 };
  const supportingCards = layout.compact ? { gap: 8 } : { ...rowHeader, alignItems: "stretch" as const, gap: 12 };
  const supportingCard = layout.compact ? card : { ...card, flexGrow: 1, flexBasis: 260, minWidth: 0 };
  const action = { alignSelf: "flex-start" as const, minHeight: 36, justifyContent: "center" as const };
  const divider = { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 12, gap: 6 };

  if (view === "Overview") return (
    <>
      <View style={[rowHeader, { justifyContent: "space-between" }]}>
        <Text accessibilityRole="header" style={sectionHeading}>Workspace Overview</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh workspace status" disabled={statusFetching} onPress={refresh} style={action}>
          <Text style={statusFetching ? styles.label : actionText}>{statusFetching ? "Checking…" : "Refresh"}</Text>
        </Pressable>
      </View>
      {setupPlan ? (
        <View style={card}>
          <Text style={styles.label}>Factory is not set up in this workspace.</Text>
          <Pressable accessibilityRole="button" style={[styles.button, action]} disabled={setupBusy} onPress={() => setup(setupPlan)}>
            <Text style={styles.buttonText}>Set up Factory here</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {statusError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {status ? "Workspace status could not be refreshed. Showing the last snapshot." : "Workspace status could not be loaded."}
            </Text>
          ) : null}
          <View style={card}>
            <View style={{ gap: 5 }}>
              <Text accessibilityRole="header" style={detailHeading}>Current task</Text>
              {task ? <Text style={taskText}>{task}</Text> : (
                <Text style={styles.label}>{status ? "No checkpoint recorded." : statusFetching ? "Loading workspace status…" : "Current task unavailable."}</Text>
              )}
            </View>
            {next ? (
              <View style={divider}>
                <Text style={detailHeading}>Next step</Text>
                <Text style={styles.body}>{next}</Text>
              </View>
            ) : null}
            {task ? (
              <View style={rowHeader}>
                <Text style={styles.label}>{checkpointConfidence}</Text>
                {tests.length ? (
                  <Pressable accessibilityRole="button" aria-expanded={showTests} onPress={() => setShowTests((shown) => !shown)} style={action}>
                    <Text style={actionText}>{showTests ? "Hide tests" : "Show tests"}</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {showTests && tests.length ? <Text style={styles.label}>{tests.join("\n")}</Text> : null}
          </View>
          <View style={supportingCards}>
            <View style={supportingCard}>
              <Text accessibilityRole="header" style={detailHeading}>{stale && observation.rows ? "Last known controlling steer" : "Controlling steer"}</Text>
              <Text style={taskText}>{controllerText}</Text>
              {controller && navigation ? (
                <Pressable accessibilityRole="button" onPress={() => navigation.openAgent({ agentId: controller.agentId, serverId: host.id })} style={action}>
                  <Text style={actionText}>Open {controllerText}</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={supportingCard}>
              <Text accessibilityRole="header" style={detailHeading}>Pending work</Text>
              {blockers.length ? (
                <View style={{ gap: 4 }}>
                  <Text style={styles.conflict}>Blockers</Text>
                  <Text style={styles.body}>{blockers.join("\n")}</Text>
                </View>
              ) : null}
              {pending.length ? pending.map((item) => <Text key={item} style={styles.body}>{item}</Text>) : (
                <Text style={styles.label}>
                  {!status && statusFetching ? "Checking pending work…"
                    : status && observation.rows && !stale && !statusError ? "No pending work reported."
                      : "Pending work status unavailable."}
                </Text>
              )}
            </View>
          </View>
          {status ? <Text style={styles.label}>Workspace status checked {new Date(statusUpdatedAt).toLocaleString()}</Text> : null}
        </>
      )}
    </>
  );

  return (
    <>
      <Text accessibilityRole="header" style={sectionHeading}>Steers</Text>
      {setupPlan ? <Text style={styles.label}>No enrolled steers.</Text> : (
        <>
          {stale ? (
            <Text accessibilityRole="alert" style={styles.conflict}>
              {steers.length ? "Live steer updates unavailable. Showing the last observation." : "Live steer status unavailable."}
            </Text>
          ) : null}
          {!observation.rows && !stale ? <Text style={styles.label}>Waiting for live steer status…</Text> : null}
          {observation.rows && !steers.length && !stale ? <Text style={styles.label}>No live steers in this workspace.</Text> : null}
          {steers.map((steer) => {
            const name = steerName(steer);
            const role = steer.state === "retired" ? "Retired" : steer.advisor ? "Advisor"
              : steer === controller ? "Controlling" : steer.detail === "Membership ambiguous" || steer.active ? "Role unresolved" : "Standby";
            const conditions = steerConditions(steer);
            return (
              <View key={steer.agentId} style={card}>
                <View style={[rowHeader, { justifyContent: "space-between" }]}>
                  <View style={rowHeader}>
                    <Text accessibilityRole="header" style={detailHeading}>{name}</Text>
                    <Text style={steer === controller ? styles.ok : styles.label}>{role}</Text>
                  </View>
                  {navigation ? (
                    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${name} tab`}
                      style={action} onPress={() => navigation.openAgent({ agentId: steer.agentId, serverId: host.id })}>
                      <Text style={actionText}>Open tab</Text>
                    </Pressable>
                  ) : null}
                </View>
                <Text style={styles.body}>{steer.model ?? "Model unknown"} · {steer.provider ?? "Provider unknown"}</Text>
                {conditions.attention ? <Text style={styles.conflict}>{conditions.attention}</Text> : null}
                <View style={divider}>
                  <Text style={styles.label}>{conditions.runtime}</Text>
                  <Text style={styles.label}>{conditions.context}</Text>
                  <Text style={steer.limited ? styles.conflict : styles.label}>Quota · {conditions.quota}</Text>
                </View>
              </View>
            );
          })}
        </>
      )}
    </>
  );
}
