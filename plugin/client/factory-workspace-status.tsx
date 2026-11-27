import type { RpcInput } from "@getpaseo/plugin";
import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { CACHE_CHECK_INTERVAL_MS } from "../shared/cache-profiles.js";
import { factoryFresh, factoryFreshPreview, factoryResume, factoryResumeApply, factoryStatus, type factoryPlan } from "../shared/factory.js";
import { resumeFingerprint } from "../shared/preview.js";
import { factorySteerMenuSettings } from "../shared/settings.js";
import { ActivateSteer } from "./activate-steer.js";
import type { FactoryResultStyles } from "./factory-panel.js";
import {
  enrollmentPlan,
  label,
  pendingWorkspaceWork,
  record,
  steerActionEligibility,
  steerConditions,
  steerModelName,
  steerName,
  workspaceSteers,
  type FactorySteerFeed,
  type WorkspaceStatus,
} from "./factory-workspace-state.js";
import { describeSteerMenu, handoffTargets, isExpiredPreviewError, normalizeInitializeNewSteer, quotaConfirmationText, resetQuotaConfirmationText, steerQuotaConfirmation, type HandoffTarget } from "./steer-menu.js";
import { FactorySteerOperation } from "./factory-steer-operation.js";
import type { SteerPillRow } from "./steer-pill.js";

type Theme = PluginWorkspacePanelProps["theme"];
type Tone = "foreground" | "statusSuccess" | "statusWarning" | "statusDanger" | "foregroundMuted";
type Surface = "Steers" | "Resources" | "Activity";
type Operation =
  | { kind: "create" }
  | { kind: "reset" | "resume" | "staged"; steer: SteerPillRow }
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
  openView: (view: Surface, steerAgentId?: string) => void;
  focusedSteerId: string | null;
  focusContent: (element: View) => void;
}

const inline = { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 } as const;
const between = { ...inline, justifyContent: "space-between" } as const;
const heading = { fontSize: 14, fontWeight: "600" } as const;

function Action({ theme, icon, title, name, hint, disabled, emphasized, onPress }: {
  theme: Theme;
  icon: string;
  title: string;
  name?: string;
  hint?: string;
  disabled?: boolean;
  emphasized?: boolean;
  onPress: () => void;
}) {
  const color = disabled ? theme.colors.foregroundMuted : emphasized ? theme.colors.accentForeground : theme.colors.foreground;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={name ?? title} accessibilityHint={hint}
      accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, minHeight: 38,
        paddingHorizontal: 9, borderRadius: 7, opacity: disabled ? 0.7 : 1,
        backgroundColor: emphasized && !disabled ? theme.colors.accent : pressed || emphasized ? theme.colors.surface2 : "transparent",
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
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0, flexShrink: 1 }}>
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

function AttentionLink({ theme, detail, icon, onPress }: {
  theme: Theme;
  detail: string;
  icon: string;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36,
        paddingHorizontal: 6, borderRadius: 6, backgroundColor: pressed ? theme.colors.surface2 : "transparent" })}>
      <Icon name={icon} size={15} color={theme.colors.statusWarning} />
      <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 13 }}>{detail}</Text>
      <Icon name="ChevronRight" size={15} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

function ResetOrResumeSteer({ kind, steer, liveSteer, workspaceId, host, theme, styles, reviewStaged }: {
  kind: "reset" | "resume";
  steer: SteerPillRow;
  liveSteer: SteerPillRow | undefined;
  workspaceId: string;
  host: Props["host"];
  theme: Theme;
  styles: FactoryResultStyles;
  reviewStaged: (agentId: string) => void;
}) {
  const { agentId, slot } = steer;
  const callFreshPreview = useRpc(factoryFreshPreview);
  const callFresh = useRpc(factoryFresh);
  const callResume = useRpc(factoryResume);
  const callResumeApply = useRpc(factoryResumeApply);
  const callStatus = useRpc(factoryStatus);
  const menuSettings = useSettings(factorySteerMenuSettings);
  const [renewedPreview, setRenewedPreview] = useState(false);
  const applying = useRef(false);
  const blocked = liveSteer ? steerActionEligibility(liveSteer)[kind] : "This steer is no longer available.";
  const quota = liveSteer ? steerQuotaConfirmation(liveSteer) : null;
  const resetQuota = quota ?? "available";
  const preview = useQuery({
    queryKey: ["workspace-factory", "steer-action", host.id, workspaceId, agentId, kind, resetQuota],
    queryFn: async () => {
      if (blocked || !liveSteer || !slot) throw new Error(blocked ?? "Steer slot is unavailable.");
      if (kind === "reset") {
        const details = await callFreshPreview({ workspaceId, slot, resetQuota });
        if (details.workspaceId !== workspaceId || details.from !== agentId || details.slot !== slot) {
          throw new Error("The steer changed. Open Reset Steer again for the current holder.");
        }
        if (details.refreshMode !== "rewind") {
          throw new Error("Factory could not verify how the reset would change this tab.");
        }
        return { kind, details } as const;
      }
      const status = await callStatus({ workspaceId });
      const state = record(status.state);
      const checkpoint = record(status.checkpoint);
      const target = status.steers.find(({ id }) => id === agentId);
      if (record(status.workspace)?.id !== workspaceId || !target || target.status !== liveSteer.liveStatus) {
        throw new Error("The steer changed. Open Resume work again for the current holder.");
      }
      const details = await callResume({ workspaceId, agentId });
      if (details.agentId !== agentId || details.epoch !== state?.epoch) {
        throw new Error("The controller changed. Open Resume work again to review the current state.");
      }
      const stamp = checkpoint?.capturedAt ?? checkpoint?.updatedAt;
      const fingerprint = resumeFingerprint({ agentId, status: liveSteer.liveStatus, sessionId: liveSteer.sessionId,
        checkpointAt: typeof stamp === "string" ? stamp : null });
      return { kind, details, fingerprint } as const;
    },
    enabled: !blocked,
    retry: false,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const confirmation = useMutation({
    mutationFn: async () => {
      if (blocked || !preview.data || preview.isFetching) throw new Error(blocked ?? "Review the current preview first.");
      if (preview.data.kind === "resume") {
        const result = await callResumeApply({ workspaceId, agentId, fingerprint: preview.data.fingerprint, takeover: false });
        return { tone: result.status === "blocked" ? "statusDanger" : result.status === "pending" ? "statusWarning" : "statusSuccess",
          detail: result.detail, stagedTo: null } as const;
      }
      const { details } = preview.data;
      const initialize = normalizeInitializeNewSteer(menuSettings.status === "ready" ? menuSettings.values.initializeNewSteer : undefined);
      const result = await callFresh({ workspaceId, slot: details.slot, fingerprint: details.fingerprint,
        resetQuota, deliver: !quota && initialize === "send" ? "send" : "stage" });
      const error = label(result.deliveryError) ?? label(result.stagingError);
      if (!result.applied && result.idempotent !== true) throw new Error(error ?? "Factory could not confirm the reset.");
      const completed = result.idempotent ? "This reset was already applied." : "Steer reset.";
      return { tone: error ? "statusWarning" : "statusSuccess", stagedTo: result.staged ? result.stagedTo : null,
        detail: `${completed}${error ? ` ${error}` : result.staged ? " The continuation brief is staged."
          : result.delivered ? " The continuation brief was sent." : ""}` } as const;
    },
    onError: (error) => {
      if (!isExpiredPreviewError(error)) return;
      setRenewedPreview(true);
      void preview.refetch();
    },
    onSettled: () => { applying.current = false; },
  });
  const details = preview.data;
  const result = confirmation.data;
  const stagedTo = result?.stagedTo;
  const error = preview.error ?? (confirmation.error && !isExpiredPreviewError(confirmation.error) ? confirmation.error : null);
  return (
    <View style={{ gap: 8, padding: 8 }}>
      {result ? (
        <>
          <Signal theme={theme} icon={result.tone === "statusSuccess" ? "CircleCheck" : "CircleAlert"} tone={result.tone}>{result.detail}</Signal>
          {stagedTo ? <Action theme={theme} icon="ArrowRight" title="View steer" onPress={() => reviewStaged(stagedTo)} /> : null}
        </>
      ) : (
        <>
          {blocked ? <Text style={styles.conflict}>{blocked}</Text> : null}
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error.message}</Text> : null}
          {preview.isFetching ? <Text style={styles.label}>Preparing preview…</Text> : null}
          {renewedPreview && !preview.isFetching && !preview.error ? <Text style={styles.conflict}>The preview expired. Review the new preview.</Text> : null}
          {details?.kind === "reset" ? (
            <>
              {quota ? <Text style={styles.conflict}>{resetQuotaConfirmationText(quota, liveSteer)}</Text> : null}
              <Text style={styles.body}>This rewinds the conversation and removes later messages from this tab.</Text>
              <Text style={styles.label}>{details.details.packetChars.toLocaleString()} characters in the continuation brief
                {details.details.checkpoint ? " · includes checkpoint" : ""}</Text>
              {details.details.warnings?.map((warning) => <Text key={warning} style={styles.conflict}>{warning}</Text>)}
            </>
          ) : details?.kind === "resume" ? (
            <>
              <Text style={styles.body}>{steer.detail || "Recovery pending"}</Text>
              <Text style={styles.label}>Factory may renew the context before continuing.</Text>
              <Text style={styles.label}>{details.details.brief.slice(0, 400)}</Text>
            </>
          ) : null}
          {details && !error ? <Action theme={theme} icon={kind === "reset" ? "ListRestart" : "RotateCcw"}
            title={confirmation.isPending ? "Applying…" : kind === "reset" ? "Confirm reset" : "Confirm resume"}
            emphasized disabled={Boolean(blocked) || preview.isFetching || confirmation.isPending} onPress={() => {
              if (applying.current) return;
              applying.current = true;
              confirmation.mutate();
            }} /> : null}
        </>
      )}
    </View>
  );
}

export function FactoryWorkspaceStatus({
  view, workspaceId, layout, host, navigation, theme, feed, composers, styles, status,
  statusError, statusFetching, offline, refresh, setup, setupBusy, openView, focusedSteerId, focusContent,
}: Props) {
  const observation = useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
  const [expired, setExpired] = useState<typeof observation | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const focusedRow = useRef<View>(null);
  const checkpointDetails = useRef<View>(null);
  const paseo = usePaseo();
  const activationSteer = operation?.kind === "activate" ? operation.steer : undefined;
  const activationQuota = activationSteer ? steerQuotaConfirmation(activationSteer) : null;
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
  const controllerText = ambiguous ? "Membership unresolved"
    : advisorAssigned ? "Advisor assigned"
      : stale || !observation.rows || !status ? "Controller unknown" : assignedSlot ? `Steer ${assignedSlot} unavailable` : "Unassigned";
  const hasFocusedRow = view === "Steers" && steers.some(({ agentId }) => agentId === focusedSteerId);
  useEffect(() => {
    if (hasFocusedRow && focusedRow.current) focusContent(focusedRow.current);
  }, [focusedSteerId, hasFocusedRow, focusContent]);

  const steerLabels = ({ provider, model }: Pick<SteerPillRow, "provider" | "model">) => {
    const entry = catalog.data?.entries.find((candidate) => candidate.provider === provider);
    return { modelName: steerModelName(model, entry?.models), providerName: entry?.label || provider || "Provider unknown" };
  };
  const sectionHeading = { ...styles.body, fontSize: layout.compact ? 20 : 23, fontWeight: "600" as const };
  const card = { ...styles.card, gap: 8, padding: layout.compact ? 10 : 12 };
  const divider = { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 5 };
  const openAgent = navigation && ((steer: SteerPillRow) => navigation.openAgent({ agentId: steer.agentId, serverId: host.id }));
  const assignedCount = observation.rows ? steers.length : null;
  const targets = controller ? handoffTargets(steers, controller.agentId)
    .filter((target) => target.agentId !== controller.agentId) : [];
  const hasHandoverTarget = targets.some(({ eligible }) => eligible);
  const currentOperation = operation && !stale ? operation : null;
  const closeOperation = () => setOperation(null);

  function steerRow(steer: SteerPillRow, overview = false) {
    const name = steerName(steer);
    const { modelName, providerName } = steerLabels(steer);
    const controls = describeSteerMenu(steer, steers);
    const activation = controls.find((item) => item.kind === "activate");
    const epoch = activation?.activationEpoch;
    const controlsHere = steer === controller;
    const focused = !overview && steer.agentId === focusedSteerId;
    const role = steer.advisor ? "Advisor"
      : controlsHere ? stale ? "Last known controller" : overview ? "Controlling steer" : "Controlling"
        : steer.detail === "Membership ambiguous" || steer.active ? "Role unresolved" : "Standby";
    const { runtime, context, cache, quota, attention } = steerConditions(steer);
    const eligibility = steerActionEligibility(steer);
    const runtimeSignal = (
      <Signal theme={theme} icon={runtime === "Running" ? "Activity" : "Circle"}
        tone={runtime === "Error" ? "statusDanger" : runtime === "Running" ? "foreground" : "foregroundMuted"}>
        {runtime === "Unknown" ? "Runtime unknown" : runtime}
      </Signal>
    );
    const contextSignals = [
      { label: "Context", icon: "Layers", value: context, tone: steer.large ? "statusWarning" : "foregroundMuted" },
      { label: "Cache", icon: steer.warmth === "warm" ? "Flame" : steer.warmth === "cold" ? "Snowflake" : "Thermometer",
        value: cache, tone: steer.warmth === "warm" ? "statusSuccess" : steer.warmth === "cooling" ? "statusWarning" : "foregroundMuted" },
      { label: "Quota", icon: "Gauge", value: quota, tone: steer.limited ? "statusDanger" : steer.awaitingUpdate ? "statusWarning" : "foregroundMuted" },
    ] as const;
    return (
      <View key={steer.agentId}
        style={[card, controlsHere && { borderLeftWidth: 3, borderLeftColor: stale ? theme.colors.border : theme.colors.accent },
          focused && { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 }]}>
        <View style={[between, { alignItems: "flex-start" }]}>
          <View ref={focused ? focusedRow : undefined} collapsable={!focused}
            accessible={focused && layout.platform !== "web" ? true : undefined}
            accessibilityLabel={focused ? `${name}, ${modelName}, ${role}` : undefined}
            {...(focused && layout.platform === "web" ? { tabIndex: -1 as const } : {})}
            style={{ flex: 1, minWidth: 155, flexDirection: "row", alignItems: "center", gap: 9 }}>
            <View style={{ minWidth: overview ? 44 : 34, minHeight: overview ? 44 : 34, paddingHorizontal: 5,
              borderRadius: 8, alignItems: "center", justifyContent: "center",
              backgroundColor: controlsHere && !stale ? theme.colors.accent : theme.colors.surface2 }}>
              <Text style={{ color: controlsHere && !stale ? theme.colors.accentForeground : theme.colors.foreground,
                fontSize: overview ? 18 : 15, fontWeight: "700" }}>{steer.slot ?? "?"}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text accessibilityRole="header" accessibilityLabel={steer.model ? `${modelName}, model ID ${steer.model}` : undefined}
                style={[styles.body, { fontSize: overview ? 18 : 15, fontWeight: "600" }]}>{modelName}</Text>
              <Text style={styles.label}>{providerName}</Text>
            </View>
          </View>
          <View style={{ gap: 4 }}>
            <Signal theme={theme} icon={controlsHere ? "CircleDot" : steer.advisor ? "MessagesSquare" : "Circle"}
              tone={controlsHere && !stale ? "foreground" : "foregroundMuted"}>{role}</Signal>
            {overview ? runtimeSignal : null}
          </View>
        </View>
        <View style={overview ? { ...divider, flexDirection: "row", gap: 8 } : [inline, { columnGap: 16, rowGap: 5 }]}>
          {overview ? null : runtimeSignal}
          {contextSignals.map(({ label: name, icon, value, tone }) => {
            const signal = <Signal key={name} theme={theme} icon={icon} tone={tone}>
              {overview && value === `${name} unknown` ? "Unknown" : value}
            </Signal>;
            return overview ? (
              <View key={name} style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Text style={styles.label}>{name}</Text>
                {signal}
              </View>
            ) : signal;
          })}
        </View>
        {attention && !overview ? <Signal theme={theme} icon="CircleAlert" tone="statusWarning">{attention}</Signal> : null}
        <View style={[inline, divider, { gap: 2 }]}>
          {openAgent ? <Action theme={theme} icon="ArrowUpRight" title="Open" name={`Open ${name}`} emphasized={overview}
            onPress={() => openAgent(steer)} /> : null}
          <Action theme={theme} icon="ListRestart" title="Reset Steer" name={`Reset ${name}`} disabled={stale || !!eligibility.reset}
              hint={eligibility.reset ?? undefined} onPress={() => setOperation({ kind: "reset", steer })} />
          {steer.state === "needs-resume" ? (
            <Action theme={theme} icon="RotateCcw" title="Resume work" name={`Resume pending work in ${name}`}
              disabled={stale || !!eligibility.resume} hint={eligibility.resume ?? undefined} onPress={() => setOperation({ kind: "resume", steer })} />
          ) : null}
          {steer.stagedBrief && !overview ? (
            <Action theme={theme} icon="Send" title="Review brief" name={`Review staged brief for ${name}`}
              disabled={stale} onPress={() => setOperation({ kind: "staged", steer })} />
          ) : null}
          {controlsHere ? (
            <Action theme={theme} icon="ArrowRightLeft" title="Handover" name={`Hand over from ${name}`}
              disabled={stale || !hasHandoverTarget} hint={hasHandoverTarget ? undefined : "No eligible standby"}
              onPress={() => setOperation({ kind: "handover", steer })} />
          ) : epoch !== undefined && !steer.active ? (
            <Action theme={theme} icon="Play" title="Activate" name={`Activate ${name}`}
              disabled={stale || activation?.disabled}
              hint={activation?.disabled ? activation.title : undefined}
              onPress={() => setOperation({ kind: "activate", steer, epoch,
                alternatives: activation?.activationAlternatives })} />
          ) : null}
        </View>
      </View>
    );
  }

  const hasAttention = blockers.length > 0 || pending.steerItems.length > 0 || pending.workerItems.length > 0;
  const metrics = [
    { label: "Steers", value: assignedCount, icon: "Compass", view: "Steers" },
    { label: "Workers", value: pending.workerCount, icon: "Users", view: "Activity" },
    { label: "Pending operations", value: observation.rows ? pending.operationCount : null, icon: "ListTodo", view: "Activity" },
  ] as const;

  return (
    <>
      {view === "Overview" ? (
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
              {offline || statusError || stale ? (
                <Text accessibilityRole="alert" style={styles.conflict}>
                  {offline ? "Host disconnected. Showing the last available state."
                    : statusError ? status ? "Workspace status could not be refreshed. Showing the last snapshot." : "Workspace status could not be loaded."
                      : "Live steer updates unavailable. Showing the last observation."}
                </Text>
              ) : null}
              {controller ? steerRow(controller, true) : (
                <View style={[card, between]}>
                  <Signal theme={theme} icon="CircleHelp">{controllerText}</Signal>
                  <Action theme={theme} icon="ArrowRight" title="View steers" onPress={() => openView("Steers")} />
                </View>
              )}
              <View style={{ flexDirection: "row", gap: 6 }}>
                {metrics.map((metric) => (
                  <Pressable key={metric.label} accessibilityRole="button"
                    accessibilityLabel={`${metric.label}, ${metric.value ?? "unknown"}`}
                    accessibilityHint={`Opens ${metric.view}`} onPress={() => openView(metric.view)}
                    style={({ pressed }) => [card, { flex: 1, minWidth: 0, gap: 2, paddingVertical: 7, paddingHorizontal: 8,
                      backgroundColor: pressed ? theme.colors.surface2 : card.backgroundColor }]}>
                    <View style={[inline, { gap: 5 }]}>
                      <Icon name={metric.icon} size={14} color={theme.colors.foregroundMuted} />
                      <Text style={[metric.value === null ? styles.label : styles.body, { fontSize: 16, fontWeight: "600" }]}>
                        {metric.value ?? "Unknown"}
                      </Text>
                    </View>
                    <Text style={styles.label}>{metric.label}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={card}>
                <CardHeading theme={theme} icon="ListTodo">Current work</CardHeading>
                <Text style={[styles.body, { fontSize: layout.compact ? 15 : 17, lineHeight: 23 }]}>
                  {task ?? (status ? "No checkpoint recorded." : statusFetching ? "Loading workspace status…" : "Current work unavailable.")}
                </Text>
                {next ? <Text style={styles.label}>Next · {next}</Text> : null}
                {pending.workerRunning ? (
                  <Signal theme={theme} icon="Activity" tone="foreground">Workers in progress ({pending.workerRunning})</Signal>
                ) : null}
                {checkpoint ? (
                  <View ref={checkpointDetails} collapsable={false} accessible={layout.platform !== "web"}
                    {...(layout.platform === "web" ? { tabIndex: -1 as const } : {})} style={[divider, { gap: 5 }]}>
                    <Text style={styles.label}>{checkpointConfidence}</Text>
                    {tests.map((test, index) => <Signal key={index} theme={theme} icon="ListChecks">{test}</Signal>)}
                    {blockers.map((blocker, index) => (
                      <Signal key={index} theme={theme} icon="CircleAlert" tone="statusWarning">{blocker}</Signal>
                    ))}
                  </View>
                ) : null}
              </View>
              <View style={[card, { gap: 3 }]}>
                <CardHeading theme={theme} icon="Bell">Attention</CardHeading>
                {blockers.length ? (
                  <AttentionLink theme={theme} icon="ClipboardList" detail={`Checkpoint blockers (${blockers.length})`}
                    onPress={() => {
                      if (checkpointDetails.current) focusContent(checkpointDetails.current);
                    }} />
                ) : null}
                {pending.steerItems.map(({ kind, detail, steer }) => (
                  <AttentionLink key={`${steer.agentId}-${kind}`} theme={theme}
                    icon={kind === "permission" ? "ShieldAlert" : kind === "brief" ? "Send" : kind === "recovery" ? "RotateCcw" : "CircleAlert"}
                    detail={`${steerName(steer)} · ${detail}`}
                    onPress={() => {
                      if (kind === "permission" && openAgent && !offline) openAgent(steer);
                      else openView("Steers", steer.agentId);
                    }} />
                ))}
                {pending.workerItems.map((item) => (
                  <AttentionLink key={item} theme={theme} icon="Activity" detail={item} onPress={() => openView("Activity")} />
                ))}
                {!hasAttention ? (
                  <Text style={styles.label}>{status && !stale && !statusError && observation.rows ? "Nothing awaiting attention" : "Attention status unavailable"}</Text>
                ) : null}
              </View>
            </>
          )}
        </>
      ) : (
        <>
          <View style={between}>
            <View style={inline}>
              <Text accessibilityRole="header" style={sectionHeading}>Steers</Text>
              {assignedCount !== null ? <Text style={styles.label}>{assignedCount} assigned</Text> : null}
            </View>
            <Action theme={theme} icon="Plus" title="Create Steer" emphasized
              disabled={stale || !status}
              hint={setupPlan ? "Set up Factory in Overview" : undefined} onPress={() => setOperation({ kind: "create" })} />
          </View>
          {stale ? <Text accessibilityRole="alert" style={styles.conflict}>
            {offline ? steers.length ? "Host disconnected. Showing the last steer snapshot." : "Host disconnected. Steers unavailable."
              : steers.length ? "Live steer updates unavailable. Showing the last observation." : "Live steer status unavailable."}
          </Text> : null}
          {!observation.rows && !stale ? <Text style={styles.label}>Waiting for live steer status…</Text> : null}
          {observation.rows && !steers.length && !stale ? (
            <Text style={styles.label}>{setupPlan ? "No enrolled steers." : "No live steers in this workspace."}</Text>
          ) : null}
          {focusedSteerId && observation.rows && !hasFocusedRow ? (
            <Text accessibilityRole="alert" style={styles.conflict}>This steer is no longer in the workspace.</Text>
          ) : null}
          <View style={{ gap: 7 }}>
            {[...steers].sort((first, second) =>
              Number(second === controller) - Number(first === controller) ||
              (first.slot ?? "").localeCompare(second.slot ?? "")).map((steer) => steerRow(steer))}
          </View>
        </>
      )}
      {currentOperation ? (
        <Modal open title={currentOperation.kind === "create" ? "Create Steer" : currentOperation.kind === "handover" ? "Hand over control"
          : `${{ activate: "Activate", reset: "Reset", resume: "Resume work in", staged: "Review brief for" }[currentOperation.kind]} ${steerName(currentOperation.steer)}`}
          onOpenChange={(open) => { if (!open) closeOperation(); }}>
          <Modal.Content contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingBottom: 12 }}>
            {currentOperation.kind === "activate" ? (
              <ActivateSteer workspaceId={workspaceId} agentId={currentOperation.steer.agentId}
                theme={theme} close={closeOperation} epoch={currentOperation.epoch} alternatives={currentOperation.alternatives}
                quota={activationQuota ? { condition: activationQuota, text: quotaConfirmationText(activationQuota, activationSteer) } : undefined} />
            ) : currentOperation.kind === "reset" || currentOperation.kind === "resume" ? (
              <ResetOrResumeSteer kind={currentOperation.kind} steer={currentOperation.steer}
                liveSteer={steers.find(({ agentId }) => agentId === currentOperation.steer.agentId)}
                workspaceId={workspaceId} host={host} theme={theme} styles={styles} reviewStaged={(agentId) => {
                  closeOperation();
                  openView("Steers", agentId);
                }} />
            ) : currentOperation.kind === "handover" && !currentOperation.target ? (
              <View style={{ gap: 8, padding: 8 }}>
                <Text style={styles.label}>Choose the steer that will take over the current work.</Text>
                {targets.map((target) => (
                  <Action key={target.agentId} theme={theme} icon={target.context.icon}
                    title={`Steer ${target.slot} · ${steerLabels(target).modelName} · ${target.context.state}`}
                    hint={target.reason ?? (target.needsRecovery ? "Recovery needed" : undefined)}
                    disabled={controller?.agentId !== currentOperation.steer.agentId || !target.eligible}
                    onPress={() => setOperation({ ...currentOperation, target })} />
                ))}
              </View>
            ) : (
              <FactorySteerOperation workspaceId={workspaceId}
                agentId={currentOperation.kind === "create" ? controller?.agentId ?? "" : currentOperation.steer.agentId}
                theme={theme} compact={layout.compact} close={closeOperation} composers={composers}
                initialAction={currentOperation.kind === "create" ? "create" : currentOperation.kind === "handover" ? "handover" : "staged"}
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
