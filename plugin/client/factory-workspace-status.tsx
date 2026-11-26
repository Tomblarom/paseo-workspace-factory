import type { RpcInput } from "@getpaseo/plugin";
import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { CACHE_CHECK_INTERVAL_MS } from "../shared/cache-profiles.js";
import type { factoryPlan } from "../shared/factory.js";
import { ActivateSteer } from "./activate-steer.js";
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
import { describeSteerMenu, handoffTargets, type HandoffTarget } from "./steer-menu.js";
import { SteerMenu } from "./steer-menu-content.js";
import type { SteerPillRow } from "./steer-pill.js";

type Theme = PluginWorkspacePanelProps["theme"];
type Tone = "accent" | "statusSuccess" | "statusWarning" | "statusDanger" | "foregroundMuted";
type Surface = "Steers" | "Resources" | "Activity";
type Operation =
  | { kind: "reset"; steer: SteerPillRow }
  | { kind: "activate"; steer: SteerPillRow; epoch: number; alternatives?: { agentId: string; slot: string }[] }
  | { kind: "handover"; steer: SteerPillRow; target?: HandoffTarget };

interface Props extends Pick<PluginWorkspacePanelProps, "workspaceId" | "layout" | "host" | "navigation" | "theme"> {
  view: "Overview" | "Steers";
  feed: FactorySteerFeed;
  composers: PluginClientContext["composers"];
  styles: FactoryResultStyles;
  status: WorkspaceStatus | undefined;
  statusError: Error | null;
  statusFetching: boolean;
  offline: boolean;
  refresh: () => void;
  setup: (plan: RpcInput<typeof factoryPlan>) => void;
  setupBusy: boolean;
  openView: (view: Surface) => void;
}

const inline = { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 } as const;
const between = { ...inline, justifyContent: "space-between" } as const;
const heading = { fontSize: 14, fontWeight: "600" } as const;

function Action({ theme, icon, title, name, hint, disabled, onPress }: {
  theme: Theme;
  icon: string;
  title: string;
  name?: string;
  hint?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const color = disabled ? theme.colors.foregroundMuted : theme.colors.foreground;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={name ?? title} accessibilityHint={hint}
      disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, minHeight: 38,
        paddingHorizontal: 9, borderRadius: 7, opacity: disabled ? 0.7 : 1,
        backgroundColor: pressed ? theme.colors.surface2 : "transparent",
      })}>
      <Icon name={icon} size={15} color={color} />
      <Text style={{ color, fontSize: 13, fontWeight: "500" }}>{title}</Text>
    </Pressable>
  );
}

function Signal({ theme, icon, children, tone = "foregroundMuted" }: {
  theme: Theme;
  icon: string;
  tone?: Tone;
  children: ReactNode;
}) {
  const color = theme.colors[tone];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <Icon name={icon} size={14} color={color} />
      <Text style={{ color, fontSize: 12, flexShrink: 1 }}>{children}</Text>
    </View>
  );
}

function CardHeading({ theme, icon, children }: { theme: Theme; icon: string; children: ReactNode }) {
  return (
    <View style={inline}>
      <Icon name={icon} color={theme.colors.foregroundMuted} size={16} />
      <Text accessibilityRole="header" style={{ ...heading, color: theme.colors.foreground }}>{children}</Text>
    </View>
  );
}

export function FactoryWorkspaceStatus({
  view, workspaceId, layout, host, navigation, theme, feed, composers, styles, status,
  statusError, statusFetching, offline, refresh, setup, setupBusy, openView,
}: Props) {
  const observation = useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
  const [expired, setExpired] = useState<typeof observation | null>(null);
  const [showCheckpoint, setShowCheckpoint] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const paseo = usePaseo();
  const catalog = useQuery({
    queryKey: ["workspace-factory", "provider-labels", host.id],
    queryFn: () => paseo.providers.snapshot(),
    enabled: !offline,
    staleTime: 5 * 60_000,
    retry: false,
  });
  useEffect(() => {
    if (observation.disconnected) return;
    const deadline = observation.receivedAt + 2 * CACHE_CHECK_INTERVAL_MS;
    const timer = setTimeout(() => setExpired(observation), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [observation]);
  const stale = offline || observation.disconnected || expired === observation;
  useEffect(() => {
    if (stale) setOperation(null);
  }, [stale]);
  const setupPlan = enrollmentPlan(statusError, workspaceId);
  const state = record(status?.state);
  const checkpoint = record(status?.checkpoint);
  const task = label(checkpoint?.task);
  const next = label(checkpoint?.next);
  const tests = (Array.isArray(checkpoint?.tests) ? checkpoint.tests : []).map(label).filter(Boolean);
  const blockers = (Array.isArray(checkpoint?.blockers) ? checkpoint.blockers : []).map(label).filter(Boolean);
  const checkpointConfidence = checkpoint?.interrupted ? "Interrupted checkpoint"
    : typeof checkpoint?.epoch !== "number" || typeof state?.epoch !== "number" ? "Checkpoint freshness unknown"
      : checkpoint.epoch === state.epoch ? "Current checkpoint" : "Checkpoint from an earlier controller";

  const assignedSlot = label(state?.activeSteer);
  const { steers, controller, ambiguous, advisorAssigned } = workspaceSteers(observation.rows, workspaceId, assignedSlot);
  const pending = pendingWorkspaceWork(status, steers);
  const workerProgress = pending.find((item) => item.startsWith("Workers in progress"));
  const attention = pending.filter((item) => item !== workerProgress);
  const controllerText = controller ? steerName(controller) : ambiguous ? "Membership unresolved"
    : advisorAssigned ? "Advisor assigned" : state?.retired === true ? "Scope retired"
      : stale || !observation.rows ? "Controller unknown" : assignedSlot ? `Steer ${assignedSlot} unavailable` : "Unassigned";

  const modelName = ({ provider, model }: SteerPillRow) => {
    const entry = catalog.data?.entries.find((candidate) => candidate.provider === provider);
    const display = entry?.models?.find((candidate) => candidate.id === model || model && candidate.aliases?.includes(model));
    return display?.label || model || entry?.label || provider || "Model unknown";
  };
  const sectionHeading = { ...styles.body, fontSize: layout.compact ? 20 : 23, fontWeight: "600" as const };
  const card = { ...styles.card, gap: 9, padding: layout.compact ? 12 : 14 };
  const summaryCard = { ...card, minWidth: 0, flexBasis: layout.compact ? 145 : 205, flexGrow: 1 };
  const openAgent = navigation && ((steer: SteerPillRow) => navigation.openAgent({ agentId: steer.agentId, serverId: host.id }));
  const controllerQuota = controller?.quotaRows.filter((window) => !window.stale && window.usedPct !== null) ?? [];
  const mostUsed = controllerQuota.length ? Math.max(...controllerQuota.map(({ usedPct }) => usedPct ?? 0)) : null;
  const quotaLabel = controller?.limited ? "Quota limited"
    : stale || controller?.awaitingUpdate || controller?.quotaRows.some(({ stale: old }) => old) ? "Awaiting usage update"
      : mostUsed === null ? "Usage unavailable" : `${Math.round(mostUsed)}% used · highest window`;
  const currentOperation = operation && !stale ? operation : null;
  const closeOperation = () => setOperation(null);

  if (view === "Overview") return (
    <>
      <View style={between}>
        <Text accessibilityRole="header" style={sectionHeading}>Workspace overview</Text>
        <Action theme={theme} icon="RefreshCw" title={statusFetching ? "Checking…" : "Refresh"} name="Refresh workspace status"
          disabled={offline || statusFetching} onPress={refresh} />
      </View>
      {setupPlan ? (
        <View style={card}>
          <CardHeading theme={theme} icon="Factory">Set up this workspace</CardHeading>
          <Text style={styles.label}>Connect this workspace to Factory to coordinate its steers and workers.</Text>
          <Action theme={theme} icon="Plus" title="Set up Factory" disabled={setupBusy || offline} onPress={() => setup(setupPlan)} />
        </View>
      ) : (
        <>
          {offline || statusError ? (
            <Text accessibilityRole="alert" style={styles.conflict}>
              {offline ? "Host disconnected. Showing the last available state."
                : status ? "Workspace status could not be refreshed. Showing the last snapshot." : "Workspace status could not be loaded."}
            </Text>
          ) : null}
          <View style={[inline, { alignItems: "stretch", gap: 10 }]}>
            <View style={summaryCard}>
              <CardHeading theme={theme} icon="Compass">Control</CardHeading>
              <Signal theme={theme} icon={controller ? "CircleDot" : "CircleHelp"} tone={controller && !stale ? "accent" : "foregroundMuted"}>
                {stale && controller ? `Last known · ${controllerText}` : controllerText}
              </Signal>
              {controller ? <Text style={styles.body}>{modelName(controller)}</Text> : null}
              <Action theme={theme} icon={controller && openAgent ? "ArrowUpRight" : "ArrowRight"}
                title={controller && openAgent ? "Open controller" : "View steers"}
                onPress={() => controller && openAgent ? openAgent(controller) : openView("Steers")} />
            </View>
            <View style={summaryCard}>
              <CardHeading theme={theme} icon="Gauge">Resources</CardHeading>
              <Signal theme={theme} icon={controller?.limited ? "TriangleAlert" : "Gauge"}
                tone={controller?.limited ? "statusWarning" : "foregroundMuted"}>{quotaLabel}</Signal>
              <Action theme={theme} icon="ArrowRight" title="View resources" onPress={() => openView("Resources")} />
            </View>
            <View style={[summaryCard, layout.compact && { flexBasis: "100%" }]}>
              <CardHeading theme={theme} icon="Bell">Attention</CardHeading>
              {blockers.map((blocker, index) => <Signal key={index} theme={theme} icon="CircleAlert" tone="statusWarning">{blocker}</Signal>)}
              {attention.map((item) => <Signal key={item} theme={theme} icon="CircleAlert" tone="statusWarning">{item}</Signal>)}
              {blockers.length === 0 && attention.length === 0 ? (
                <Text style={styles.label}>{status && !stale && !statusError && observation.rows ? "Nothing awaiting attention" : "Attention status unavailable"}</Text>
              ) : null}
              <Action theme={theme} icon="ArrowRight" title="View activity" onPress={() => openView("Activity")} />
            </View>
          </View>
          <View style={card}>
            <View style={between}>
              <CardHeading theme={theme} icon="ListTodo">Current work</CardHeading>
              {checkpoint ? (
                <Pressable accessibilityRole="button" aria-expanded={showCheckpoint} onPress={() => setShowCheckpoint(!showCheckpoint)}
                  style={{ ...inline, minHeight: 38, paddingHorizontal: 6 }}>
                  <Text style={styles.label}>Checkpoint details</Text>
                  <Icon name={showCheckpoint ? "ChevronUp" : "ChevronDown"} color={theme.colors.foregroundMuted} size={15} />
                </Pressable>
              ) : null}
            </View>
            <Text style={[styles.body, { fontSize: layout.compact ? 15 : 17, lineHeight: 24 }]}>
              {task ?? (status ? "No checkpoint recorded." : statusFetching ? "Loading workspace status…" : "Current work unavailable.")}
            </Text>
            {workerProgress ? <Signal theme={theme} icon="Activity" tone="accent">{workerProgress}</Signal> : null}
            {next ? <Text style={styles.label}>Next · {next}</Text> : null}
            {checkpoint && showCheckpoint ? (
              <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8, gap: 5 }}>
                <Text style={styles.label}>{checkpointConfidence}</Text>
                {tests.length ? <Text style={styles.body}>{tests.join("\n")}</Text> : null}
              </View>
            ) : null}
          </View>
        </>
      )}
    </>
  );

  const rows = [...steers].sort((first, second) =>
    Number(second === controller) - Number(first === controller) ||
    Number(first.state === "retired") - Number(second.state === "retired") ||
    (first.slot ?? "").localeCompare(second.slot ?? ""));
  const targets = controller ? handoffTargets(steers, controller.agentId)
    .filter((target) => target.agentId !== controller.agentId && target.state !== "retired") : [];
  const operationTargets = targets.filter((target) => target.eligible);

  return (
    <>
      <View style={between}>
        <Text accessibilityRole="header" style={sectionHeading}>Steers</Text>
        {steers.length ? <Text style={styles.label}>{steers.filter(({ state }) => state !== "retired").length} assigned</Text> : null}
      </View>
      {stale ? <Text accessibilityRole="alert" style={styles.conflict}>
        {steers.length ? "Live steer updates unavailable. Showing the last observation." : "Live steer status unavailable."}
      </Text> : null}
      {!observation.rows && !stale ? <Text style={styles.label}>Waiting for live steer status…</Text> : null}
      {observation.rows && !steers.length && !stale ? <Text style={styles.label}>{setupPlan ? "No enrolled steers." : "No live steers in this workspace."}</Text> : null}
      <View style={{ gap: 7 }}>
        {rows.map((steer) => {
          const name = steerName(steer);
          const controls = describeSteerMenu(steer, steers, { keepChatHistory: false, observedChanged: false, revertAllowed: false });
          const reset = controls.find((item) => item.kind === "item" && item.id === "refresh");
          const activation = controls.find((item) => item.kind === "item" && item.id === "activate");
          const epoch = activation?.kind === "item" ? activation.activationEpoch : undefined;
          const alternatives = activation?.kind === "item" ? activation.activationAlternatives : undefined;
          const retired = steer.state === "retired";
          const controlsHere = steer === controller;
          const role = retired ? "Retired" : steer.advisor ? "Advisor" : controlsHere ? "Controlling"
            : steer.detail === "Membership ambiguous" || steer.active ? "Role unresolved" : "Standby";
          const { runtime, context, quota, attention } = steerConditions(steer);
          return (
            <View key={steer.agentId} style={[card, controlsHere && { borderLeftWidth: 3, borderLeftColor: stale ? theme.colors.border : theme.colors.accent }]}>
              <View style={between}>
                <View style={[inline, { flex: 1, minWidth: 150 }]}>
                  <Text accessibilityRole="header" style={[styles.body, { fontWeight: "600" }]}>{name}</Text>
                  <Signal theme={theme} icon={controlsHere ? "CircleDot" : steer.advisor ? "MessagesSquare" : "Circle"}
                    tone={controlsHere && !stale ? "accent" : "foregroundMuted"}>{role}</Signal>
                  <Text style={styles.label}>{modelName(steer)}</Text>
                </View>
                <View style={[inline, { gap: 2 }]}>
                  {openAgent ? <Action theme={theme} icon="ArrowUpRight" title="Open" name={`Open ${name}`} onPress={() => openAgent(steer)} /> : null}
                  {retired ? null : (
                    <Action theme={theme} icon="ListRestart" title={steer.state === "needs-resume" ? "Resume" : "Reset"}
                      name={`${steer.state === "needs-resume" ? "Resume" : "Reset"} ${name}`}
                      hint={reset?.kind === "item" && reset.disabled ? reset.title : undefined}
                      disabled={stale || reset?.kind !== "item" || reset.disabled || reset.action !== "refresh"}
                      onPress={() => setOperation({ kind: "reset", steer })} />
                  )}
                  {controlsHere ? (
                    <Action theme={theme} icon="ArrowRightLeft" title="Handover" name={`Hand over from ${name}`}
                      disabled={stale || operationTargets.length === 0}
                      hint={operationTargets.length ? undefined : "No eligible standby"}
                      onPress={() => setOperation({ kind: "handover", steer })} />
                  ) : epoch !== undefined && !steer.active ? (
                    <Action theme={theme} icon="Play" title="Activate" name={`Activate ${name}`}
                      disabled={stale || activation?.kind !== "item" || activation.disabled}
                      hint={activation?.kind === "item" && activation.disabled ? activation.title : undefined}
                      onPress={() => setOperation({ kind: "activate", steer, epoch, alternatives })} />
                  ) : null}
                </View>
              </View>
              <View style={[inline, { columnGap: 14, rowGap: 6 }]}>
                <Signal theme={theme} icon={runtime === "Running" ? "Activity" : "Circle"}
                  tone={runtime === "Error" ? "statusDanger" : runtime === "Running" ? "accent" : "foregroundMuted"}>{runtime}</Signal>
                <Signal theme={theme} icon={steer.warmth === "warm" ? "Flame" : steer.warmth === "cold" ? "Snowflake" : "Thermometer"}
                  tone={steer.warmth === "warm" ? "statusSuccess" : steer.warmth === "cooling" ? "statusWarning" : "foregroundMuted"}>{context}</Signal>
                <Signal theme={theme} icon="Gauge" tone={steer.limited ? "statusDanger" : steer.awaitingUpdate ? "statusWarning" : "foregroundMuted"}>
                  {quota === "Unknown" ? "Quota unknown" : quota}
                </Signal>
                {attention ? <Signal theme={theme} icon="CircleAlert" tone="statusWarning">{attention}</Signal> : null}
              </View>
            </View>
          );
        })}
      </View>
      {currentOperation ? (
        <Modal open title={currentOperation.kind === "handover" ? "Hand over control" : currentOperation.kind === "activate"
          ? `Activate ${steerName(currentOperation.steer)}` : `${currentOperation.steer.state === "needs-resume" ? "Resume" : "Reset"} ${steerName(currentOperation.steer)}`}
          onOpenChange={(open) => { if (!open) closeOperation(); }}>
          <Modal.Content contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingBottom: 12 }}>
            {currentOperation.kind === "activate" ? (
              <ActivateSteer workspaceId={workspaceId} agentId={currentOperation.steer.agentId}
                theme={theme} close={closeOperation} epoch={currentOperation.epoch} alternatives={currentOperation.alternatives} />
            ) : currentOperation.kind === "handover" && !currentOperation.target ? (
              <View style={{ gap: 8, padding: 8 }}>
                <Text style={styles.label}>Choose the steer that will take over the current work.</Text>
                {targets.map((target) => (
                  <Action key={target.agentId} theme={theme} icon="ArrowRight"
                    title={`Steer ${target.slot}${target.needsRecovery ? " · recovery needed" : target.reason ? ` · ${target.reason}` : ""}`}
                    disabled={!target.eligible} onPress={() => setOperation({ ...currentOperation, target })} />
                ))}
              </View>
            ) : (
              <SteerMenu workspaceId={workspaceId} agentId={currentOperation.steer.agentId}
                theme={theme} compact={layout.compact} close={closeOperation} composers={composers}
                initialAction={currentOperation.kind === "handover" ? "handover" : "refresh"}
                expectedControllerId={currentOperation.kind === "handover" ? currentOperation.steer.agentId : undefined}
                initialSlot={currentOperation.kind === "handover" ? currentOperation.target?.slot : undefined}
                initialAgentId={currentOperation.kind === "handover" ? currentOperation.target?.agentId : undefined} />
            )}
          </Modal.Content>
        </Modal>
      ) : null}
    </>
  );
}
