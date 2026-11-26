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

interface Props extends Pick<PluginWorkspacePanelProps, "workspaceId" | "layout" | "host" | "navigation"> {
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
  workspaceId, layout, host, navigation, feed, styles, status, statusUpdatedAt,
  statusError, statusFetching, refresh, setup, setupBusy,
}: Props) {
  const observation = useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
  const [expired, setExpired] = useState<typeof observation | null>(null);
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
  const checkpointFields = (["tests", "blockers"] as const).map((field) => ({
    field,
    value: (Array.isArray(checkpoint?.[field]) ? checkpoint[field] : []).map(label).filter(Boolean).join("\n"),
  }));
  const checkpointsComparable = typeof checkpoint?.epoch === "number" && typeof state?.epoch === "number";
  const checkpointConfidence = checkpoint?.interrupted ? "Interrupted checkpoint" : !checkpointsComparable
    ? "Checkpoint freshness unknown" : checkpoint.epoch === state.epoch ? "Current checkpoint" : "Checkpoint from an earlier controller";

  const assignedSlot = label(state?.activeSteer);
  const { steers, controller, ambiguous, advisorAssigned } = workspaceSteers(observation.rows, workspaceId, assignedSlot);
  const pending = pendingWorkspaceWork(status, steers);
  const controllerText = controller ? steerName(controller) : ambiguous ? "Steer membership is ambiguous"
    : advisorAssigned ? "Assigned steer is an advisor" : state?.retired === true ? "Factory scope is retired"
      : stale || !observation.rows ? "Unknown" : assignedSlot ? `No live controller for Steer ${assignedSlot}` : "None reported";
  const sectionHeading = { ...styles.body, fontSize: layout.compact ? 15 : 17, fontWeight: "600" as const };
  const actionText = { ...styles.body, textDecorationLine: "underline" as const };
  const rowHeader = { flexDirection: "row" as const, flexWrap: "wrap" as const, columnGap: 12, alignItems: "baseline" as const };

  return (
    <>
      <View style={styles.card}>
        <View style={rowHeader}>
          <Text accessibilityRole="header" style={sectionHeading}>Workspace Overview</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Refresh workspace status" disabled={statusFetching} onPress={refresh}>
            <Text style={statusFetching ? styles.label : actionText}>{statusFetching ? "Checking…" : "Refresh"}</Text>
          </Pressable>
        </View>
        {setupPlan ? (
          <>
            <Text style={styles.label}>Factory is not set up in this workspace.</Text>
            <Pressable accessibilityRole="button" style={styles.button} disabled={setupBusy} onPress={() => setup(setupPlan)}>
              <Text style={styles.buttonText}>Set up Factory here</Text>
            </Pressable>
          </>
        ) : (
          <>
            {statusError ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {status ? "Workspace status could not be refreshed. Showing the last snapshot." : "Workspace status could not be loaded."}
              </Text>
            ) : null}
            <Text style={styles.body}>{stale && observation.rows ? "Last known controlling steer" : "Controlling steer"} · {controllerText}</Text>
            {status ? (
              <>
                {task ? (
                  <>
                    <Text style={styles.label}>{checkpointConfidence}</Text>
                    <Text style={styles.body}>Task · {task}</Text>
                    {next ? <Text style={styles.body}>Next · {next}</Text> : null}
                    {checkpointFields.filter(({ value }) => value).map(({ field, value }) => (
                      <Text key={field} style={styles.label}>{field === "tests" ? "Tests" : "Blockers"} · {value}</Text>
                    ))}
                  </>
                ) : <Text style={styles.label}>No checkpoint recorded.</Text>}
                <Text style={styles.label}>Workspace status checked {new Date(statusUpdatedAt).toLocaleString()}</Text>
              </>
            ) : null}
            <Text style={styles.body}>Pending work</Text>
            <Text style={styles.label}>
              {pending.length ? pending.join(" · ") : !status && statusFetching ? "Checking pending work…"
                : status && observation.rows && !stale && !statusError ? "No pending work reported."
                  : "Pending work status unavailable."}
            </Text>
          </>
        )}
      </View>
      <View style={styles.card}>
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
                <View key={steer.agentId} style={{ paddingVertical: 4, gap: 2 }}>
                  <View style={rowHeader}>
                    <Text style={styles.body}>{name} · {role}</Text>
                    {navigation ? (
                      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${name} tab`}
                        onPress={() => navigation.openAgent({ agentId: steer.agentId, serverId: host.id })}>
                        <Text style={actionText}>Open tab</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <Text style={styles.label}>{steer.provider ?? "Provider unknown"} · {steer.model ?? "Model unknown"} · {conditions.runtime}</Text>
                  <Text style={styles.label}>Context · {conditions.context}</Text>
                  <Text style={steer.limited ? styles.conflict : styles.label}>Quota · {conditions.quota}</Text>
                  {conditions.attention ? <Text style={styles.conflict}>{conditions.attention}</Text> : null}
                </View>
              );
            })}
          </>
        )}
      </View>
    </>
  );
}
