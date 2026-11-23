import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import {
  factoryApply,
  factoryCheckpoint,
  factoryCheckpointPreview,
  factoryCleanup,
  factoryPlan,
  factoryResume,
  factoryScopes,
  factoryScopesCandidates,
  factoryStatus,
  factorySwitch,
  factorySwitchPreview,
} from "../shared/factory.js";
import {
  getFactoryResult,
  setFactoryResult,
  subscribeFactoryResult,
  type CheckpointPreviewInputs,
  type FactoryPanelResult,
} from "./factory-store.js";

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

export function FactoryPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const callStatus = useRpc(factoryStatus);
  const callPlan = useRpc(factoryPlan);
  const callApply = useRpc(factoryApply);
  const callCheckpoint = useRpc(factoryCheckpoint);
  const callSwitch = useRpc(factorySwitch);
  const callScopes = useRpc(factoryScopes);
  const callScopeCandidates = useRpc(factoryScopesCandidates);
  const callCleanup = useRpc(factoryCleanup);
  const callResume = useRpc(factoryResume);
  const [repo, setRepo] = useState("");
  const [result, setResult] = useState<FactoryPanelResult | null>(() => getFactoryResult());
  useEffect(() => subscribeFactoryResult(() => setResult(getFactoryResult())), []);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: layout.compact ? 8 : 12,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24 },
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
      row: { flexDirection: "row" as const, gap: 8 },
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
      hint: { color: theme.colors.foregroundMuted, fontSize: 13 },
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
    mutationFn: async (target: string) =>
      target ? callPlan({ repos: [target] }) : callPlan({ workspaceId }),
    onSuccess: (plan, target) =>
      setFactoryResult({
        kind: "plan",
        repos: target ? [target] : [],
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
    onSuccess: (applied) =>
      setFactoryResult({ kind: "applied", at: new Date().toISOString(), applied }),
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
    onSuccess: (written, vars) =>
      setFactoryResult({
        kind: "checkpointWritten",
        repo: vars.repo ?? "(current workspace)",
        at: new Date().toISOString(),
        written,
      }),
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
  const busy =
    statusMutation.isPending ||
    planMutation.isPending ||
    applyMutation.isPending ||
    checkpointMutation.isPending ||
    switchMutation.isPending ||
    scopesMutation.isPending ||
    scopeCandidatesMutation.isPending ||
    cleanupMutation.isPending ||
    resumeMutation.isPending;

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

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ gap: styles.screen.gap }}>
      <Text style={styles.title}>Factory</Text>
      <Text style={styles.label}>Scope address (id, wks_…, path, or legacy local/folder); empty uses this workspace</Text>
      <TextInput
        style={styles.input}
        value={repo}
        onChangeText={setRepo}
        placeholder="scope, empty for this workspace"
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
          onPress={() => planMutation.mutate(repo.trim())}
        >
          <Text style={styles.buttonText}>Plan</Text>
        </Pressable>
      </View>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="List live scopes"
          style={styles.button}
          disabled={busy}
          onPress={() => scopesMutation.mutate()}
        >
          <Text style={styles.buttonText}>Scopes</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="List adoption candidates"
          style={styles.button}
          disabled={busy}
          onPress={() => scopeCandidatesMutation.mutate()}
        >
          <Text style={styles.buttonText}>Candidates</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show cleanup report"
          style={styles.button}
          disabled={busy}
          onPress={() => cleanupMutation.mutate()}
        >
          <Text style={styles.buttonText}>Cleanup</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show resume brief"
          style={styles.button}
          disabled={busy}
          onPress={() => resumeMutation.mutate(repo.trim())}
        >
          <Text style={styles.buttonText}>Resume</Text>
        </Pressable>
      </View>
      {busy ? <Text style={styles.label}>Working…</Text> : null}
      <ResultView
        result={result}
        styles={styles}
        actions={{
          busy,
          apply: (hash: string) => applyMutation.mutate(hash),
          confirmCheckpoint,
          confirmSwitch,
        }}
      />
      <Text style={styles.hint}>
        Recommended tab order is read only: Steers A to Z first, then workers. Paseo owns tab
        order, so arrange tabs manually. This plugin never moves tabs.
      </Text>
    </ScrollView>
  );
}

type Styles = {
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

interface PanelActions {
  busy: boolean;
  apply: (hash: string) => void;
  confirmCheckpoint: () => void;
  confirmSwitch: () => void;
}

function ResultView({
  result,
  styles,
  actions,
}: {
  result: FactoryPanelResult | null;
  styles: Styles;
  actions: PanelActions;
}) {
  if (!result) {
    return <Text style={styles.label}>No result yet. Run /factory status or /factory plan.</Text>;
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
  if (result.kind === "resume") {
    return <ResumeView repo={result.repo} at={result.at} resume={result.resume} styles={styles} />;
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
  const expected = (field(status, "expectedProfiles") ?? {}) as Record<
    string,
    { profile?: unknown; provider?: unknown; model?: unknown }
  >;
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
        {repo} · active Steer {text(state?.activeSteer)} (epoch {text(state?.epoch)})
      </Text>
      {scope.id ? (
        <Text style={styles.label}>
          Scope {text(scope.id)} [{text(scope.kind)}]
          {deprecatedAlias ? " · legacy local/ alias, prefer the scope id" : ""}
        </Text>
      ) : null}
      <Text style={styles.label}>{at}</Text>
      {checkpoint?.task ? (
        <Text style={styles.body}>Checkpoint: {text(checkpoint.task)}</Text>
      ) : (
        <Text style={styles.label}>Checkpoint: none</Text>
      )}
      {steers.map((s) => {
        const want = expected[s.slot];
        const drifts =
          want && (text(s.provider) !== text(want.provider) || text(s.model) !== text(want.model));
        return (
          <Text key={String(s.id)} style={drifts ? styles.conflict : styles.body}>
            Steer {text(s.slot)} {text(s.id)} {text(s.provider)}/{text(s.model)} {text(s.status)}
            {s.parent ? " PARENT" : ""}
            {drifts ? ` (profile ${text(want?.profile)} says ${text(want?.provider)}/${text(want?.model)})` : ""}
          </Text>
        );
      })}
      {workers.map((w) => (
        <Text key={String(w.id)} style={styles.body}>
          worker {text(field(w, "title") ?? w.id)} {text(field(w, "provider"))}/
          {text(field(w, "model"))} {text(field(w, "status"))}
        </Text>
      ))}
      <Text style={styles.label}>Recommended order: {order.join(", ") || "none"}</Text>
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
      <Text style={styles.body}>Live scopes ({scopes.rows.length})</Text>
      <Text style={styles.label}>{at}</Text>
      {scopes.rows.length === 0 ? <Text style={styles.label}>No live scopes.</Text> : null}
      {scopes.rows.map((row) => {
        const active = asRecord(field(row, "active"));
        const checkpoint = asRecord(field(row, "checkpoint"));
        const usage = asRecord(field(row, "usage"));
        const escalations = asList(checkpoint.escalations);
        return (
          <Text key={String(row.workspaceId)} style={styles.body}>
            {text(row.id)} [{text(row.kind)}] · steer {text(active.slot)}/{text(active.model)} ·
            epoch {text(field(row, "epoch"))} · cp {formatAge(checkpoint.ageMs)} ·
            next: {checkpoint.next ? text(checkpoint.next) : "-"} ·
            hub: {escalations.length ? escalations.map(text).join("; ") : "-"} ·
            ctx {usage.usedTokens !== undefined ? `${text(usage.usedTokens)}/${text(usage.maxTokens)}` : "n/a"}
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
      <Text style={styles.body}>Adoption candidates ({candidates.rows.length})</Text>
      <Text style={styles.label}>{at}</Text>
      {candidates.rows.length === 0 ? <Text style={styles.label}>No adoption candidates.</Text> : null}
      {candidates.rows.map((row) => (
        <Text key={String(row.workspaceId)} style={styles.body}>
          {text(row.workspaceId)} {text(row.title)} · {text(row.directory)} ·
          project {text(row.projectKind)} · worktree {row.worktree ? "yes" : "no"} ·
          agents {row.agents.length} · plan: {text(row.suggestedPlan)}
        </Text>
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
        <Text style={styles.label}>No cleanup candidates.</Text>
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
      {inputs.fromAgent ? (
        <Text style={styles.label}>Parsed from the last answer of {inputs.fromAgent}.</Text>
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
        {result.delivered ? "Handoff delivered." : "Handoff not delivered."}
        {field(result, "deliveryError") ? ` ${text(field(result, "deliveryError"))}` : ""}
      </Text>
    </View>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
