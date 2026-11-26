import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useHosts, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import {
  factoryApply,
  factoryAssign,
  factoryAssignPreview,
  factoryCheckpoint,
  factoryCheckpointPreview,
  factoryCleanup,
  factoryFresh,
  factoryFreshPreview,
  factoryPlan,
  factoryQuota,
  factoryResume,
  factoryResumeApply,
  factoryScopes,
  factoryScopesCandidates,
  factoryStatus,
  factorySteerAdd,
  factorySteerAddPreview,
  factorySwitch,
  factorySwitchPreview,
} from "../shared/factory.js";
import { factoryHelp } from "../shared/factory-args.js";
import type {
  AssignPreviewInputs,
  CheckpointPreviewInputs,
  FactoryPanelResult,
  FactoryResultStore,
  SteerAddPreviewInputs,
} from "./factory-store.js";
import { record, type FactorySteerFeed } from "./factory-workspace-state.js";
import { FactoryWorkspaceActivity } from "./factory-workspace-activity.js";
import { FactoryWorkspaceResources } from "./factory-workspace-resources.js";
import { FactoryWorkspaceStatus } from "./factory-workspace-status.js";

const factoryViews = [
  { name: "Overview", icon: "LayoutDashboard" },
  { name: "Steers", icon: "Compass" },
  { name: "Resources", icon: "Gauge" },
  { name: "Activity", icon: "Activity" },
] as const;
type FactoryView = typeof factoryViews[number]["name"] | "Diagnostics";

function text(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value === "" ? "-" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function field(record: unknown, key: string): unknown {
  if (typeof record === "object" && record !== null && key in record) {
    return (record as Record<string, unknown>)[key];
  }
  return undefined;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function formatAge(ageMs: unknown): string {
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs)) return "none";
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function FactoryPanel(props: PluginWorkspacePanelProps & {
  steerFeed: FactorySteerFeed;
  results: FactoryResultStore;
  composers: PluginClientContext["composers"];
}) {
  const { theme, layout, workspaceId, host, steerFeed, results } = props;
  const connection = useHosts().find(({ serverId }) => serverId === host.id)?.status;
  const offline = connection !== undefined && connection !== "online";
  const callStatus = useRpc(factoryStatus);
  const callPlan = useRpc(factoryPlan);
  const callApply = useRpc(factoryApply);
  const callCheckpoint = useRpc(factoryCheckpoint);
  const callSwitch = useRpc(factorySwitch);
  const callScopes = useRpc(factoryScopes);
  const callScopeCandidates = useRpc(factoryScopesCandidates);
  const callCleanup = useRpc(factoryCleanup);
  const callResume = useRpc(factoryResume);
  const callResumeApply = useRpc(factoryResumeApply);
  const callFresh = useRpc(factoryFresh);
  const callAssign = useRpc(factoryAssign);
  const callQuota = useRpc(factoryQuota);
  const callSteerAdd = useRpc(factorySteerAdd);
  const [repo, setRepo] = useState("");
  const result = useSyncExternalStore(results.subscribe, results.getResult, results.getResult);
  const [view, setView] = useState<FactoryView>(() => {
    const needsReview = result?.kind.endsWith("Preview") ||
      (result?.kind === "plan" && result.plan.plans.some((plan) => plan.ops.length > 0));
    return needsReview ? "Diagnostics" : "Overview";
  });
  const setFactoryResult = results.setResult;
  const lastResult = useRef(result);
  const scroll = useRef<ScrollView>(null);
  const tabHandles = useRef<Partial<Record<FactoryView, View | null>>>({});
  useEffect(() => {
    if (result && result !== lastResult.current) setView("Diagnostics");
    lastResult.current = result;
  }, [result]);
  useEffect(() => { scroll.current?.scrollTo({ y: 0, animated: false }); }, [view, result]);

  const workspaceStatus = useQuery({
    queryKey: ["workspace-factory", "status", host.id, workspaceId],
    queryFn: async () => {
      const status = await callStatus({ workspaceId });
      if (record(status.workspace)?.id !== workspaceId) throw new Error("Factory returned status for a different workspace.");
      return status;
    },
    enabled: !offline,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        gap: layout.compact ? 8 : 12,
        backgroundColor: theme.colors.surface0,
      },
      dashboard: {
        alignSelf: "center" as const,
        width: "100%" as const,
        maxWidth: 1100,
        padding: layout.compact ? 12 : 22,
        gap: layout.compact ? 10 : 14,
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      navigation: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: layout.compact ? 2 : 10,
        borderBottomColor: theme.colors.border,
        borderBottomWidth: 1,
      },
      viewButton: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        paddingHorizontal: layout.compact ? 7 : 12,
        minHeight: 42,
        gap: 6,
        borderBottomWidth: 2,
        borderBottomColor: "transparent",
      },
      selectedView: { borderBottomColor: theme.colors.accent },
      viewLabel: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "500" as const },
      selectedViewLabel: { color: theme.colors.foreground, fontWeight: "600" as const },
      label: { color: theme.colors.foregroundMuted, fontSize: 13 },
      body: { color: theme.colors.foreground, fontSize: 14 },
      hash: { color: theme.colors.foreground, fontSize: 14 },
      error: { color: theme.colors.statusDanger, fontSize: 14 },
      conflict: { color: theme.colors.statusWarning, fontSize: 14 },
      ok: { color: theme.colors.statusSuccess, fontSize: 14 },
      input: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        fontSize: 14,
      },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      button: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontSize: 14 },
      card: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 12,
        gap: 4,
      },
    }),
    [theme, layout.compact],
  );

  const fail = (error: unknown) =>
    setFactoryResult({
      kind: "error",
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
  const statusMutation = useMutation({
    mutationFn: async (target: string) =>
      target ? callStatus({ repo: target }) : callStatus({ workspaceId }),
    onSuccess: (status, target) =>
      setFactoryResult({
        kind: "status",
        repo: target || "(current workspace)",
        at: new Date().toISOString(),
        status,
      }),
    onError: fail,
  });
  const planMutation = useMutation({
    mutationFn: (input: RpcInput<typeof factoryPlan>) => callPlan(input),
    onSuccess: (plan, input) =>
      setFactoryResult({
        kind: "plan",
        repos: [...(input.repos ?? []), ...(input.local ?? [])],
        at: new Date().toISOString(),
        plan,
      }),
    onError: fail,
  });
  const scopesMutation = useMutation({
    mutationFn: async () => callScopes({}),
    onSuccess: (scopes) => setFactoryResult({ kind: "scopes", at: new Date().toISOString(), scopes }),
    onError: fail,
  });
  const scopeCandidatesMutation = useMutation({
    mutationFn: async () => callScopeCandidates({}),
    onSuccess: (candidates) =>
      setFactoryResult({ kind: "scopeCandidates", at: new Date().toISOString(), candidates }),
    onError: fail,
  });
  const cleanupMutation = useMutation({
    mutationFn: async () => callCleanup({}),
    onSuccess: (cleanup) =>
      setFactoryResult({ kind: "cleanup", at: new Date().toISOString(), cleanup }),
    onError: fail,
  });
  const resumeMutation = useMutation({
    mutationFn: async (target: string) =>
      target ? callResume({ repo: target }) : callResume({ workspaceId }),
    onSuccess: (resume, target) =>
      setFactoryResult({
        kind: "resume",
        repo: target || "(current workspace)",
        at: new Date().toISOString(),
        resume,
      }),
    onError: fail,
  });
  const applyMutation = useMutation({
    mutationFn: async (hash: string) => callApply({ hash }),
    onSuccess: (applied) => {
      setFactoryResult({ kind: "applied", at: new Date().toISOString(), applied });
      void workspaceStatus.refetch();
    },
    onError: fail,
  });
  const checkpointMutation = useMutation({
    mutationFn: async (vars: {
      repo?: string;
      workspaceId: string;
      fingerprint: string;
      inputs: CheckpointPreviewInputs;
    }) =>
      callCheckpoint({
        ...(vars.repo ? { repo: vars.repo } : { workspaceId: vars.workspaceId }),
        fingerprint: vars.fingerprint,
        ...vars.inputs,
      }),
    onSuccess: (written, vars) => {
      setFactoryResult({
        kind: "checkpointWritten",
        repo: vars.repo ?? "(current workspace)",
        at: new Date().toISOString(),
        written,
      });
      if (!vars.repo) void workspaceStatus.refetch();
    },
    onError: fail,
  });
  const switchMutation = useMutation({
    mutationFn: async (vars: { repo?: string; workspaceId: string; to: string; fingerprint: string }) =>
      vars.repo
        ? callSwitch({ repo: vars.repo, to: vars.to, fingerprint: vars.fingerprint })
        : callSwitch({ workspaceId: vars.workspaceId, to: vars.to, fingerprint: vars.fingerprint }),
    onSuccess: (switched, vars) =>
      setFactoryResult({
        kind: "switched",
        repo: vars.repo ?? "(current workspace)",
        at: new Date().toISOString(),
        result: switched,
      }),
    onError: fail,
  });
  const resumeApplyMutation = useMutation({
    mutationFn: async (vars: { workspaceId: string; agentId: string }) =>
      callResumeApply({ workspaceId: vars.workspaceId, agentId: vars.agentId, takeover: true }),
    onSuccess: (applied, vars) =>
      setFactoryResult({
        kind: "resumeApplied",
        workspaceId: vars.workspaceId,
        agentId: vars.agentId,
        at: new Date().toISOString(),
        applied,
      }),
    onError: fail,
  });
  const freshMutation = useMutation({
    mutationFn: async (vars: { repo?: string; workspaceId: string; slot?: string; fingerprint: string }) =>
      vars.repo
        ? callFresh({ repo: vars.repo, slot: vars.slot, fingerprint: vars.fingerprint })
        : callFresh({ workspaceId: vars.workspaceId, slot: vars.slot, fingerprint: vars.fingerprint }),
    onSuccess: (fresh) =>
      setFactoryResult({
        kind: "info",
        at: new Date().toISOString(),
        text: [
          `Fresh Steer ${text(field(fresh, "slot"))} is active (epoch ${text(field(fresh, "epoch"))}).`,
          `The old agent (${text(field(fresh, "from"))}) keeps its tab; archive it in Paseo when done.`,
        ].join("\n"),
      }),
    onError: fail,
  });
  const assignMutation = useMutation({
    mutationFn: async (vars: {
      repo?: string;
      workspaceId: string;
      fingerprint: string;
      inputs: AssignPreviewInputs;
    }) =>
      callAssign({
        ...(vars.repo ? { repo: vars.repo } : { workspaceId: vars.workspaceId }),
        fingerprint: vars.fingerprint,
        ...vars.inputs,
      }),
    onSuccess: (assigned) =>
      setFactoryResult({
        kind: "info",
        at: new Date().toISOString(),
        text: [
          `Assigned ${text(field(assigned, "scope"))} epoch ${text(field(assigned, "epoch"))} · Steer ${text(field(assigned, "slot"))} ${text(field(assigned, "steerId"))}.`,
          field(assigned, "delivered") ? "Delivered." : "Not delivered.",
          field(assigned, "deliveryError") ? text(field(assigned, "deliveryError")) : "",
        ]
          .filter(Boolean)
          .join(" "),
      }),
    onError: fail,
  });
  const quotaMutation = useMutation({
    mutationFn: async () => callQuota({}),
    onSuccess: (quota) =>
      setFactoryResult({ kind: "quota", at: new Date().toISOString(), quota }),
    onError: fail,
  });
  const steerAddMutation = useMutation({
    mutationFn: async (vars: {
      repo?: string;
      workspaceId: string;
      fingerprint: string;
      inputs: SteerAddPreviewInputs;
      revision: string;
    }) => {
      return callSteerAdd({ ...vars.inputs, workspaceId: vars.workspaceId, fingerprint: vars.fingerprint, revision: vars.revision });
    },
    onSuccess: (added, vars) =>
      setFactoryResult({
        kind: "steerAdded",
        repo: vars.repo ?? "(current workspace)",
        at: new Date().toISOString(),
        added,
      }),
    onError: fail,
  });
  const busy =
    statusMutation.isPending ||
    quotaMutation.isPending ||
    planMutation.isPending ||
    applyMutation.isPending ||
    checkpointMutation.isPending ||
    switchMutation.isPending ||
    scopesMutation.isPending ||
    scopeCandidatesMutation.isPending ||
    cleanupMutation.isPending ||
    resumeMutation.isPending ||
    resumeApplyMutation.isPending ||
    freshMutation.isPending ||
    assignMutation.isPending ||
    steerAddMutation.isPending;

  const confirmCheckpoint = () => {
    if (result?.kind !== "checkpointPreview") return;
    checkpointMutation.mutate({
      repo: result.repo,
      workspaceId: result.workspaceId,
      fingerprint: result.preview.fingerprint,
      inputs: result.inputs,
    });
  };
  const confirmSwitch = () => {
    if (result?.kind !== "switchPreview") return;
    switchMutation.mutate({
      repo: result.repo,
      workspaceId: result.workspaceId,
      to: result.to,
      fingerprint: result.preview.fingerprint,
    });
  };
  const confirmResume = () => {
    if (result?.kind !== "resumePreview") return;
    resumeApplyMutation.mutate({ workspaceId: result.workspaceId, agentId: result.agentId });
  };
  const confirmFresh = () => {
    if (result?.kind !== "freshPreview") return;
    freshMutation.mutate({
      slot: result.preview.slot,
      repo: result.repo,
      workspaceId: result.workspaceId,
      fingerprint: result.preview.fingerprint,
    });
  };
  const confirmAssign = () => {
    if (result?.kind !== "assignPreview") return;
    assignMutation.mutate({
      repo: result.repo,
      workspaceId: result.workspaceId,
      fingerprint: result.preview.fingerprint,
      inputs: result.inputs,
    });
  };
  const confirmSteerAdd = () => {
    if (result?.kind !== "steerAddPreview") return;
    if (!result.preview.fingerprint) return;
    steerAddMutation.mutate({
      repo: result.repo,
      workspaceId: result.workspaceId,
      fingerprint: result.preview.fingerprint,
      revision: result.preview.revision,
      inputs: { ...result.inputs, slot: result.preview.slot },
    });
  };

  const tools = view === "Diagnostics" ? (
    <>
      {busy ? <Text style={styles.label}>Working…</Text> : null}
      {result ? (
        <ResultView
          result={result}
          styles={styles}
          actions={{
            busy,
            apply: (hash: string) => applyMutation.mutate(hash),
            confirmCheckpoint,
            confirmSwitch,
            confirmResume,
            confirmFresh,
            confirmAssign,
            confirmSteerAdd,
          }}
        />
      ) : null}
      <Text accessibilityRole="header" style={styles.body}>Commands</Text>
      <Text style={styles.label}>
        Project (optional): owner/repo, scope id, workspace id (wks_…) or folder path. Leave empty for
        this workspace.
      </Text>
      <TextInput
        style={styles.input}
        value={repo}
        onChangeText={setRepo}
        placeholder="empty = this workspace"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show factory status"
          style={styles.button}
          disabled={busy}
          onPress={() => statusMutation.mutate(repo.trim())}
        >
          <Text style={styles.buttonText}>Status</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Plan factory changes"
          style={styles.button}
          disabled={busy}
          onPress={() => planMutation.mutate(repo.trim() ? { repos: [repo.trim()] } : { workspaceId })}
        >
          <Text style={styles.buttonText}>Plan</Text>
        </Pressable>
      </View>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="List managed projects"
          style={styles.button}
          disabled={busy}
          onPress={() => scopesMutation.mutate()}
        >
          <Text style={styles.buttonText}>Scopes</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="List workspaces the factory could take over"
          style={styles.button}
          disabled={busy}
          onPress={() => scopeCandidatesMutation.mutate()}
        >
          <Text style={styles.buttonText}>Candidates</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show leftovers to tidy up (read only)"
          style={styles.button}
          disabled={busy}
          onPress={() => cleanupMutation.mutate()}
        >
          <Text style={styles.buttonText}>Cleanup</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show a short report to continue after a break"
          style={styles.button}
          disabled={busy}
          onPress={() => resumeMutation.mutate(repo.trim())}
        >
          <Text style={styles.buttonText}>Resume</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show provider quota pools"
          style={styles.button}
          disabled={busy}
          onPress={() => quotaMutation.mutate()}
        >
          <Text style={styles.buttonText}>Quota</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show the /factory commands with examples"
          style={styles.button}
          disabled={busy}
          onPress={() =>
            setFactoryResult({ kind: "info", at: new Date().toISOString(), text: factoryHelp() })
          }
        >
          <Text style={styles.buttonText}>Help</Text>
        </Pressable>
      </View>
    </>
  ) : null;

  return (
    <ScrollView ref={scroll} style={styles.screen}>
      <View testID="factory-dashboard" style={styles.dashboard}>
      <View style={styles.header}>
        <View style={styles.row}>
          <Icon name="Factory" size={18} color={theme.colors.foregroundMuted} />
          <Text style={[styles.body, { fontWeight: "600" }]}>Workspace Factory</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Diagnostics" aria-expanded={view === "Diagnostics"}
          style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 38,
            borderRadius: 6, paddingHorizontal: 8 }, (pressed || view === "Diagnostics") && { backgroundColor: theme.colors.surface2 }]}
          onPress={() => setView(view === "Diagnostics" ? "Overview" : "Diagnostics")}>
          <Icon name="Terminal" size={15} color={theme.colors.foregroundMuted} />
          {!layout.compact ? <Text style={styles.label}>Diagnostics</Text> : null}
        </Pressable>
      </View>
      <View accessibilityRole="tablist" style={styles.navigation}>
        {factoryViews.map(({ name, icon }, index) => (
          <Pressable
            key={name}
            ref={(handle) => { tabHandles.current[name] = handle; }}
            accessibilityRole="tab"
            aria-selected={view === name}
            {...(layout.platform === "web" ? {
              tabIndex: view === name || (view === "Diagnostics" && index === 0) ? 0 : -1,
              onKeyDown: (event: { key: string; preventDefault(): void }) => {
                const next = event.key === "Home" ? 0 : event.key === "End" ? factoryViews.length - 1
                  : event.key === "ArrowLeft" ? (index + factoryViews.length - 1) % factoryViews.length
                    : event.key === "ArrowRight" ? (index + 1) % factoryViews.length : null;
                if (next === null) return;
                event.preventDefault();
                const target = factoryViews[next].name;
                setView(target);
                tabHandles.current[target]?.focus();
              },
            } : {})}
            style={({ pressed }) => [styles.viewButton, view === name && styles.selectedView,
              pressed && { backgroundColor: theme.colors.surface1 }]}
            onPress={() => setView(name)}
          >
            {!layout.compact ? <Icon name={icon} size={15} color={view === name ? theme.colors.accent : theme.colors.foregroundMuted} /> : null}
            <Text style={[styles.viewLabel, view === name && styles.selectedViewLabel]}>{name}</Text>
          </Pressable>
        ))}
      </View>
      {view === "Resources" ? (
        <FactoryWorkspaceResources workspaceId={workspaceId} layout={layout} host={host} offline={offline} styles={styles} />
      ) : view === "Activity" ? (
        <FactoryWorkspaceActivity workspaceId={workspaceId} layout={layout} host={host} offline={offline} styles={styles} />
      ) : view !== "Diagnostics" ? (
        <FactoryWorkspaceStatus
          view={view}
          workspaceId={workspaceId}
          layout={layout}
          host={host}
          theme={theme}
          navigation={props.navigation}
          feed={steerFeed}
          composers={props.composers}
          styles={styles}
          status={workspaceStatus.data}
          statusError={workspaceStatus.error}
          statusFetching={workspaceStatus.isFetching}
          offline={offline}
          refresh={() => { void workspaceStatus.refetch(); }}
          setup={planMutation.mutate}
          setupBusy={busy}
          openView={setView}
        />
      ) : tools}
      </View>
    </ScrollView>
  );
}

export type FactoryResultStyles = {
  label: TextStyle;
  body: TextStyle;
  hash: TextStyle;
  error: TextStyle;
  conflict: TextStyle;
  ok: TextStyle;
  card: ViewStyle;
  button: ViewStyle;
  buttonText: TextStyle;
};

export interface FactoryResultActions {
  busy: boolean;
  apply: (hash: string) => void;
  confirmCheckpoint: () => void;
  confirmSwitch: () => void;
  confirmResume: () => void;
  confirmFresh: () => void;
  confirmAssign: () => void;
  confirmSteerAdd: () => void;
}

type Styles = FactoryResultStyles;
type PanelActions = FactoryResultActions;

export function ResultView({
  result,
  styles,
  actions,
}: {
  result: FactoryPanelResult | null;
  styles: Styles;
  actions: PanelActions;
}) {
  if (!result) {
    return <Text style={styles.label}>
        Nothing to show yet. Tap Status to see who is in charge, or Help for the commands. In a
        steer chat, type /factory help.
      </Text>;
  }
  if (result.kind === "error") {
    return <Text style={styles.error}>{result.message}</Text>;
  }
  if (result.kind === "info") {
    return <Text style={styles.body}>{result.text}</Text>;
  }
  if (result.kind === "status") {
    return <StatusView repo={result.repo} at={result.at} status={result.status} styles={styles} />;
  }
  if (result.kind === "scopes") {
    return <ScopesView at={result.at} scopes={result.scopes} styles={styles} />;
  }
  if (result.kind === "scopeCandidates") {
    return <ScopeCandidatesView at={result.at} candidates={result.candidates} styles={styles} />;
  }
  if (result.kind === "cleanup") {
    return <CleanupView at={result.at} cleanup={result.cleanup} styles={styles} />;
  }
  if (result.kind === "quota") {
    return <QuotaView at={result.at} quota={result.quota} styles={styles} />;
  }
  if (result.kind === "plan") {
    return <PlanView at={result.at} plan={result.plan} styles={styles} actions={actions} />;
  }
  if (result.kind === "applied") {
    return <AppliedView at={result.at} applied={result.applied} styles={styles} />;
  }
  if (result.kind === "checkpointPreview") {
    return (
      <CheckpointPreviewView
        repo={result.repo}
        at={result.at}
        inputs={result.inputs}
        preview={result.preview}
        styles={styles}
        actions={actions}
      />
    );
  }
  if (result.kind === "checkpointWritten") {
    return (
      <CheckpointWrittenView repo={result.repo} written={result.written} styles={styles} />
    );
  }
  if (result.kind === "switchPreview") {
    return (
      <SwitchPreviewView
        preview={result.preview}
        requestedApply={result.requestedApply}
        styles={styles}
        actions={actions}
      />
    );
  }
  if (result.kind === "freshPreview") {
    return <FreshPreviewView at={result.at} preview={result.preview} styles={styles} actions={actions} />;
  }
  if (result.kind === "assignPreview") {
    return <AssignPreviewView at={result.at} preview={result.preview} styles={styles} actions={actions} />;
  }
  if (result.kind === "steerAddPreview") {
    return <SteerAddPreviewView at={result.at} preview={result.preview} styles={styles} actions={actions} />;
  }
  if (result.kind === "steerAdded") {
    return <SteerAddedView at={result.at} added={result.added} styles={styles} />;
  }
  if (result.kind === "resume") {
    return <ResumeView repo={result.repo} at={result.at} resume={result.resume} styles={styles} />;
  }
  if (result.kind === "resumePreview") {
    return (
      <ResumePreviewView
        workspaceId={result.workspaceId}
        agentId={result.agentId}
        at={result.at}
        styles={styles}
        actions={actions}
      />
    );
  }
  if (result.kind === "resumeApplied") {
    return (
      <ResumeAppliedView
        agentId={result.agentId}
        at={result.at}
        applied={result.applied}
        styles={styles}
      />
    );
  }
  return <SwitchedView at={result.at} result={result.result} styles={styles} />;
}

function ResumeView({
  repo,
  at,
  resume,
  styles,
}: {
  repo: string;
  at: string;
  resume: RpcOutput<typeof factoryResume>;
  styles: Styles;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.body}>
        Resume brief for {text(field(resume, "scope") ?? repo)} · epoch{" "}
        {text(field(resume, "epoch") ?? "?")}
      </Text>
      <Text style={styles.label}>{at}</Text>
      <Text style={styles.body}>{resume.brief}</Text>
    </View>
  );
}

function ResumePreviewView({
  agentId,
  at,
  styles,
  actions,
}: {
  workspaceId: string;
  agentId: string;
  at: string;
  styles: Styles;
  actions: PanelActions;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.body}>Resume preview for agent {agentId}</Text>
      <Text style={styles.label}>{at}</Text>
      <Text style={styles.body}>
        Confirming saves a checkpoint, clears that agent&apos;s context and sends the resume brief
        into its fresh timeline. The old history stays reachable via the saved session. When the
        steer is not the active one, it also takes over coordination.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Confirm resume for ${agentId}`}
        style={styles.button}
        disabled={actions.busy}
        onPress={actions.confirmResume}
      >
        <Text style={styles.buttonText}>Confirm resume</Text>
      </Pressable>
    </View>
  );
}

function ResumeAppliedView({
  agentId,
  at,
  applied,
  styles,
}: {
  agentId: string;
  at: string;
  applied: RpcOutput<typeof factoryResumeApply>;
  styles: Styles;
}) {
  const detail = typeof applied.detail === "string" ? applied.detail : null;
  const tookOver = (applied as { tookOver?: { from: string; to: string; epoch: number } | null }).tookOver ?? null;
  return (
    <View style={styles.card}>
      <Text style={styles.ok}>Resume started for {text(applied.agentId ?? agentId)}.</Text>
      <Text style={styles.label}>{at}</Text>
      {tookOver ? (
        <Text style={styles.body}>
          Steer {tookOver.to} is now in charge (was {tookOver.from}, round {tookOver.epoch}).
        </Text>
      ) : null}
      <Text style={styles.body}>
        {detail ?? "The context is cleared first; the resume brief arrives in the timeline after."}
      </Text>
    </View>
  );
}

function StatusView({
  repo,
  at,
  status,
  styles,
}: {
  repo: string;
  at: string;
  status: RpcOutput<typeof factoryStatus>;
  styles: Styles;
}) {
  const state = (status.state ?? null) as Record<string, unknown> | null;
  const checkpoint = (status.checkpoint ?? null) as Record<string, unknown> | null;
  const scope = asRecord(field(status, "scope"));
  const deprecatedAlias = field(status, "deprecatedAlias") === true;
  const steers = [...status.steers].sort((a, b) => a.slot.localeCompare(b.slot));
  const workers = [...status.workers].sort((a, b) =>
    text(field(a, "title") ?? a.id).localeCompare(text(field(b, "title") ?? b.id)),
  );
  const order = [
    ...steers.map((s) => `Steer ${text(s.slot)}`),
    ...workers.map((w) => `worker ${text(w.title ?? w.id)}`),
  ];
  return (
    <View style={styles.card}>
      <Text style={styles.body}>
        {repo} · Steer {text(state?.activeSteer)} is in charge (round {text(state?.epoch)})
      </Text>
      {scope.id ? (
        <Text style={styles.label}>
          Scope {text(scope.id)} [{text(scope.kind)}]
          {deprecatedAlias ? " · old local/ name; use the scope id next time" : ""}
        </Text>
      ) : null}
      <Text style={styles.label}>{at}</Text>
      {checkpoint?.task ? (
        <Text style={styles.body}>Current task: {text(checkpoint.task)}</Text>
      ) : (
        <Text style={styles.label}>
          No checkpoint yet: ask the active steer to end its answer with a CHECKPOINT block, then
          /factory checkpoint --from-steer &lt;slot&gt;.
        </Text>
      )}
      {steers.map((s) => (
        <Text key={String(s.id)} style={styles.body}>
          Steer {text(s.slot)} {text(s.id)} {text(s.provider)}/{text(s.model)} {text(s.status)}
          {s.parent ? ` (parent ${text(s.parent)}; steers should be top-level)` : ""}
        </Text>
      ))}
      {workers.map((w) => (
        <Text key={String(w.id)} style={styles.body}>
          worker {text(field(w, "title") ?? w.id)} {text(field(w, "provider"))}/
          {text(field(w, "model"))} {text(field(w, "status"))}
        </Text>
      ))}
      <Text style={styles.label}>Suggested tab order: {order.join(", ") || "none"}</Text>
    </View>
  );
}

function ScopesView({
  at,
  scopes,
  styles,
}: {
  at: string;
  scopes: RpcOutput<typeof factoryScopes>;
  styles: Styles;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.body}>Managed projects ({scopes.rows.length})</Text>
      <Text style={styles.label}>{at}</Text>
      {scopes.rows.length === 0 ? <Text style={styles.label}>
          No managed projects yet. Set one up with /factory plan owner/repo, or tap Candidates to see
          existing workspaces you can take over.
        </Text> : null}
      {scopes.rows.map((row) => {
        const active = asRecord(field(row, "active"));
        const checkpoint = asRecord(field(row, "checkpoint"));
        const usage = asRecord(field(row, "usage"));
        const escalations = asList(checkpoint.escalations);
        return (
          <Text key={String(row.workspaceId)} style={styles.body}>
            {text(row.id)} [{text(row.kind)}] · Steer {text(active.slot)} ({text(active.model)}) in
            charge · round {text(field(row, "epoch"))} · checkpoint age {formatAge(checkpoint.ageMs)} ·
            next: {checkpoint.next ? text(checkpoint.next) : "-"} ·
            needs hub: {escalations.length ? escalations.map(text).join("; ") : "-"} ·
            context {usage.usedTokens !== undefined ? `${text(usage.usedTokens)}/${text(usage.maxTokens)}` : "unknown"}
          </Text>
        );
      })}
    </View>
  );
}

function ScopeCandidatesView({
  at,
  candidates,
  styles,
}: {
  at: string;
  candidates: RpcOutput<typeof factoryScopesCandidates>;
  styles: Styles;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.body}>Workspaces the factory could take over ({candidates.rows.length})</Text>
      <Text style={styles.label}>{at}</Text>
      {candidates.rows.length === 0 ? <Text style={styles.label}>None: every workspace is already managed.</Text> : null}
      {candidates.rows.map((row) => (
        <View key={String(row.workspaceId)}>
          <Text style={styles.body}>
            {text(row.workspaceId)} {text(row.title)} · {text(row.directory)} ·
            project {text(row.projectKind)} · worktree {row.worktree ? "yes" : "no"} ·
            agents {row.agents.length} · plan: {text(row.suggestedPlan)}
          </Text>
          {row.agents.map((agent, i) => {
            const a = asRecord(agent);
            const parentId = field(a, "parentId");
            const legacyParent = field(a, "parent") === true;
            return (
              <Text key={String(field(a, "id") ?? i)} style={styles.label}>
                {text(field(a, "id"))} &quot;{text(field(a, "title") ?? field(a, "id"))}&quot; (
                {text(field(a, "provider"))}/{text(field(a, "model"))},{" "}
                {text(field(a, "status"))})
                {typeof parentId === "string" && parentId
                  ? ` parent ${parentId}`
                  : legacyParent
                    ? " parent"
                    : ""}
              </Text>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function CleanupView({
  at,
  cleanup,
  styles,
}: {
  at: string;
  cleanup: RpcOutput<typeof factoryCleanup>;
  styles: Styles;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.body}>Cleanup report ({cleanup.candidates.length}) · read only</Text>
      <Text style={styles.label}>{at}</Text>
      {cleanup.candidates.length === 0 ? (
        <Text style={styles.label}>Nothing to tidy up.</Text>
      ) : null}
      {cleanup.candidates.map((candidate, i) => {
        const loss = asRecord(candidate.loss);
        return (
          <Text key={`${text(candidate.kind)}-${text(candidate.id)}-${i}`} style={styles.body}>
            {text(candidate.kind)} {text(candidate.id)}
            {candidate.title ? ` "${text(candidate.title)}"` : ""} · {text(candidate.detail)} ·
            agents {text(loss.agents)} ({text(loss.running)} running) ·
            worktree {loss.worktree ? "yes" : "no"} · → {text(candidate.action)}
          </Text>
        );
      })}
    </View>
  );
}

function QuotaView({
  at,
  quota,
  styles,
}: {
  at: string;
  quota: RpcOutput<typeof factoryQuota>;
  styles: Styles;
}) {
  const pools = [...quota.pools].sort((a, b) => a.pool.localeCompare(b.pool));
  const stateStyle = (state: string) =>
    state === "exhausted" ? styles.error : state === "warn" ? styles.conflict : styles.body;
  const pctText = (value: number | null | undefined) =>
    typeof value === "number" ? `${value}%` : "-";
  return (
    <View style={styles.card}>
      <Text style={styles.body}>
        Quota (warn at {text(quota.warnPct)}%, exhausted at {text(quota.exhaustedPct)}%)
      </Text>
      <Text style={styles.label}>
        {at} · sampled {quota.sampledAt ? text(quota.sampledAt) : "never"}
      </Text>
      {pools.length === 0 && !quota.accounts?.length ? (
        <Text style={styles.label}>
          No quota sample yet. The plugin samples in the background; try again in a minute.
        </Text>
      ) : null}
      {pools.map((pool) => (
        <Text key={pool.pool} style={stateStyle(pool.state)}>
          {text(pool.pool)} · session {pctText(pool.sessionPct)}
          {typeof pool.weeklyPct === "number" ? ` · week ${pctText(pool.weeklyPct)}` : ""}
          {pool.resetAt ? ` · resets ${text(pool.resetAt)}` : ""} · {text(pool.state)}
        </Text>
      ))}
      {quota.accounts?.map((account) => (
        <Text key={account.account} style={stateStyle(account.state)}>
          {account.family} · {account.label || account.account} · {account.usedPct === null ? "Usage unavailable" : `${pctText(account.usedPct)} used`}
          {account.state === "warn" || account.state === "exhausted" ? ` · ${account.state}` : ""}
          {account.resetsAt ? ` · resets ${account.resetsAt}` : ""}
        </Text>
      ))}
      {quota.steers.map((steer) => (
        <Text key={`steer-${steer.slot}`} style={styles.label}>
          Steer {text(steer.slot)} ({text(steer.profile)} → {text(steer.pool) || "?"})
          {steer.advisor ? " · advisor" : ""}
        </Text>
      ))}
      {quota.workers.map((worker) => (
        <Text key={`worker-${worker.position}`} style={styles.label}>
          Worker {text(worker.position)}. {text(worker.profile)} → {text(worker.pool) || "?"}
        </Text>
      ))}
    </View>
  );
}

function PlanView({
  at,
  plan,
  styles,
  actions,
}: {
  at: string;
  plan: RpcOutput<typeof factoryPlan>;
  styles: Styles;
  actions: PanelActions;
}) {
  const writes = plan.plans.reduce((sum, p) => sum + asList(p.ops).length, 0);
  return (
    <View style={styles.card}>
      <Text style={styles.hash}>
        Plan hash {plan.hash} · {writes} write operation(s) · dry-run, nothing changed
      </Text>
      <Text style={styles.label}>{at}</Text>
      {plan.plans.map((p) => (
        <View key={String(p.repo)}>
          <Text style={p.status === "conflict" ? styles.conflict : styles.body}>
            {text(p.repo)} [{text(p.status)}]
          </Text>
          {asList(p.ops).map((op, i) => (
            <Text key={i} style={styles.body}>
              + {text(field(op, "key"))} {text(field(op, "summary"))}
            </Text>
          ))}
          {asList(p.conflicts).map((c, i) => (
            <Text key={i} style={styles.conflict}>
              ! {text(field(c, "key"))} {text(field(c, "reason"))}
            </Text>
          ))}
          {asList(p.notes).map((n, i) => (
            <Text key={i} style={styles.label}>
              · {text(n)}
            </Text>
          ))}
        </View>
      ))}
      {writes > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Apply plan ${plan.hash}`}
          style={styles.button}
          disabled={actions.busy}
          onPress={() => actions.apply(plan.hash)}
        >
          <Text style={styles.buttonText}>Apply {plan.hash}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function AppliedView({
  at,
  applied,
  styles,
}: {
  at: string;
  applied: RpcOutput<typeof factoryApply>;
  styles: Styles;
}) {
  const report = asList(applied.report);
  return (
    <View style={styles.card}>
      <Text style={styles.hash}>Applied {applied.hash}</Text>
      <Text style={styles.label}>{at}</Text>
      {report.map((row, i) => (
        <Text
          key={i}
          style={field(row, "status") === "failed" ? styles.conflict : styles.body}
        >
          {text(field(row, "repo"))}: {text(field(row, "status"))}
          {field(row, "error") ? ` ${text(field(row, "error"))}` : ""}
          {` (${asList(field(row, "executed")).length} executed)`}
        </Text>
      ))}
    </View>
  );
}

function CheckpointPreviewView({
  repo,
  at,
  inputs,
  preview,
  styles,
  actions,
}: {
  repo?: string;
  at: string;
  inputs: CheckpointPreviewInputs;
  preview: RpcOutput<typeof factoryCheckpointPreview>;
  styles: Styles;
  actions: PanelActions;
}) {
  const fields = preview.fields;
  const scope = asRecord(field(preview, "scope"));
  return (
    <View style={styles.card}>
      <Text style={styles.body}>
        Checkpoint preview for {repo ?? "(current workspace)"} (epoch {text(preview.epoch)})
      </Text>
      {scope.id ? (
        <Text style={styles.label}>
          Scope {text(scope.id)} [{text(scope.kind)}]
          {field(preview, "deprecatedAlias") === true ? " · legacy local/ alias, prefer the scope id" : ""}
        </Text>
      ) : null}
      <Text style={styles.label}>{at}</Text>
      {inputs.fromAgent || inputs.fromSteer ? (
        <Text style={styles.label}>
          Parsed from the last answer of {inputs.fromSteer ? `Steer ${inputs.fromSteer}` : inputs.fromAgent}.
        </Text>
      ) : null}
      <Text style={styles.body}>Task: {fields.task}</Text>
      <Text style={styles.body}>
        Tests: {fields.tests.length ? fields.tests.join("; ") : "none recorded"}
      </Text>
      <Text style={styles.body}>
        Blockers: {fields.blockers.length ? fields.blockers.join("; ") : "none recorded"}
      </Text>
      <Text style={styles.body}>Next: {fields.next ?? "not recorded"}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Confirm checkpoint"
        style={styles.button}
        disabled={actions.busy}
        onPress={actions.confirmCheckpoint}
      >
        <Text style={styles.buttonText}>Confirm checkpoint</Text>
      </Pressable>
    </View>
  );
}

function CheckpointWrittenView({
  repo,
  written,
  styles,
}: {
  repo: string;
  written: RpcOutput<typeof factoryCheckpoint>;
  styles: Styles;
}) {
  const checkpoint = asRecord(written.checkpoint);
  return (
    <View style={styles.card}>
      <Text style={styles.ok}>Checkpoint written for {repo}.</Text>
      <Text style={styles.body}>Task: {text(checkpoint.task)}</Text>
      {checkpoint.next ? <Text style={styles.body}>Next: {text(checkpoint.next)}</Text> : null}
    </View>
  );
}

function SwitchPreviewView({
  preview,
  requestedApply,
  styles,
  actions,
}: {
  preview: RpcOutput<typeof factorySwitchPreview>;
  requestedApply: boolean;
  styles: Styles;
  actions: PanelActions;
}) {
  const scope = asRecord(field(preview, "scope"));
  return (
    <View style={styles.card}>
      <Text style={styles.body}>
        Switch preview: Steer {preview.from} to {preview.to} (epoch {preview.epoch})
      </Text>
      {scope.id ? (
        <Text style={styles.label}>
          Scope {text(scope.id)} [{text(scope.kind)}]
          {field(preview, "deprecatedAlias") === true ? " · legacy local/ alias, prefer the scope id" : ""}
        </Text>
      ) : null}
      {requestedApply ? (
        <Text style={styles.label}>You asked for --apply: review and confirm below.</Text>
      ) : null}
      {!preview.checkpoint ? (
        <Text style={styles.conflict}>NO task checkpoint. Confirm it with the user first.</Text>
      ) : null}
      <Text style={styles.body}>{preview.packet}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Switch to Steer ${preview.to}`}
        style={styles.button}
        disabled={actions.busy}
        onPress={actions.confirmSwitch}
      >
        <Text style={styles.buttonText}>Switch and deliver</Text>
      </Pressable>
    </View>
  );
}

function SwitchedView({
  at,
  result,
  styles,
}: {
  at: string;
  result: RpcOutput<typeof factorySwitch>;
  styles: Styles;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.ok}>
        {result.applied ? "Switched" : "Dry-run"}: Steer {result.from} to {result.to} (epoch{" "}
        {result.epoch})
      </Text>
      <Text style={styles.label}>{at}</Text>
      <Text style={styles.body}>
        {result.delivered ? "Handoff delivered." : result.deliveryPending ? "Handoff queued pending context renewal." : "Handoff not delivered."}
        {field(result, "deliveryError") ? ` ${text(field(result, "deliveryError"))}` : ""}
      </Text>
    </View>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function FreshPreviewView({
  at,
  preview,
  styles,
  actions,
}: {
  at: string;
  preview: RpcOutput<typeof factoryFreshPreview>;
  styles: Styles;
  actions: PanelActions;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.body}>
        Fresh preview: new agent for Steer {preview.slot} (epoch {preview.epoch}) · profile{" "}
        {text(preview.profile)} ({text(preview.provider)}/{text(preview.model)})
      </Text>
      <Text style={styles.label}>{at}</Text>
      {!preview.checkpoint ? (
        <Text style={styles.conflict}>NO task checkpoint. Confirm it with the user first.</Text>
      ) : null}
      <Text style={styles.body}>{preview.packet}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Confirm fresh Steer ${preview.slot}`}
        style={styles.button}
        disabled={actions.busy}
        onPress={actions.confirmFresh}
      >
        <Text style={styles.buttonText}>Fresh and deliver</Text>
      </Pressable>
    </View>
  );
}

function AssignPreviewView({
  at,
  preview,
  styles,
  actions,
}: {
  at: string;
  preview: RpcOutput<typeof factoryAssignPreview>;
  styles: Styles;
  actions: PanelActions;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.body}>
        Assign preview for {text(preview.scope)} (epoch {preview.epoch}): Steer {preview.slot} (
        {text(preview.steerId)})
      </Text>
      <Text style={styles.label}>{at}</Text>
      {preview.previous ? (
        <Text style={styles.label}>Replaces task: {preview.previous}</Text>
      ) : (
        <Text style={styles.label}>No previous checkpoint.</Text>
      )}
      <Text style={styles.body}>{preview.packet}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Confirm assign to Steer ${preview.slot}`}
        style={styles.button}
        disabled={actions.busy}
        onPress={actions.confirmAssign}
      >
        <Text style={styles.buttonText}>Assign and deliver</Text>
      </Pressable>
    </View>
  );
}

function SteerAddPreviewView({
  at,
  preview,
  styles,
  actions,
}: {
  at: string;
  preview: RpcOutput<typeof factorySteerAddPreview>;
  styles: Styles;
  actions: PanelActions;
}) {
  const blocked = !preview.fingerprint;
  return (
    <View style={styles.card}>
      <Text style={styles.body}>
        Steer-add preview for {text(preview.scope)}: Steer {preview.slot}
        {preview.profile ? ` · profile ${text(preview.profile)} (${text(preview.provider)}/${text(preview.model)})` : " · blocked"}
        {preview.advisor ? " · advisor, never active" : ""}
      </Text>
      <Text style={styles.label}>{at}</Text>
      <Text style={styles.body}>{preview.text}</Text>
      {blocked ? (
        <Text style={styles.label}>
          Nothing to confirm: resolve the blockers above and preview again.
        </Text>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Confirm adding Steer ${preview.slot}`}
          style={styles.button}
          disabled={actions.busy}
          onPress={actions.confirmSteerAdd}
        >
          <Text style={styles.buttonText}>Create steer</Text>
        </Pressable>
      )}
    </View>
  );
}

function SteerAddedView({
  at,
  added,
  styles,
}: {
  at: string;
  added: RpcOutput<typeof factorySteerAdd>;
  styles: Styles;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.ok}>
        Steer {text(added.slot)} is live ({text(added.agentId)})
        {added.reused ? " · reused after receipt" : ""}.
      </Text>
      <Text style={styles.label}>{at}</Text>
      <Text style={styles.body}>{added.text}</Text>
    </View>
  );
}
