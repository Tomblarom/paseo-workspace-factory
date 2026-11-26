import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { factoryWorkspaceResources } from "../shared/factory.js";
import type { FactoryResultStyles } from "./factory-panel.js";

type Resources = RpcOutput<typeof factoryWorkspaceResources>;
type Candidate = Resources["workerSelection"]["candidates"][number];
type Exclusion = Extract<Candidate["decision"], { state: "excluded" }>["reason"];

const exclusionLabels: Record<Exclusion, string> = {
  "unknown-profile": "Unknown profile",
  "recent-failure": "Recent profile failure",
  "accounts-exhausted": "All eligible accounts are exhausted",
  "pool-exhausted": "Quota pool exhausted",
  "role-mismatch": "Profile is reserved for another role",
  "scope-requires-public": "Profile requires a verified public scope",
  "profile-in-use": "Profile is already in use",
  "catalog-rejected": "Provider catalog rejected this configuration",
};

interface Props extends Pick<PluginWorkspacePanelProps, "workspaceId" | "layout" | "host"> {
  offline: boolean;
  styles: FactoryResultStyles;
}

export function FactoryWorkspaceResources({ workspaceId, layout, host, offline, styles }: Props) {
  const callResources = useRpc(factoryWorkspaceResources);
  const resources = useQuery({
    queryKey: ["workspace-factory", "resources", host.id, workspaceId],
    queryFn: async () => {
      const result = await callResources({ workspaceId });
      if (result.workspaceId !== workspaceId) throw new Error("Factory returned resources for a different workspace.");
      return result;
    },
    enabled: !offline,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  const data = resources.data;
  const selection = data?.workerSelection;
  const sectionHeading = [styles.body, { fontSize: layout.compact ? 18 : 21, fontWeight: "600" as const }];
  const detailHeading = [styles.body, { fontWeight: "600" as const }];
  const row = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "baseline" as const };

  return (
    <>
      <View style={[row, { justifyContent: "space-between" }]}>
        <Text accessibilityRole="header" style={sectionHeading}>Workspace Resources</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh workspace resources" disabled={offline || resources.isFetching}
          onPress={() => { void resources.refetch(); }} style={{ minHeight: 36, justifyContent: "center" }}>
          <Text style={resources.isFetching ? styles.label : [styles.body, { textDecorationLine: "underline" }]}>
            {resources.isFetching ? "Checking…" : "Refresh"}
          </Text>
        </Pressable>
      </View>
      {offline || resources.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {offline ? data ? "Host disconnected. Showing the last resources snapshot." : "Host disconnected. Resources unavailable."
            : data ? "Resources could not be refreshed. Showing the last snapshot." : "Workspace resources could not be loaded."}
        </Text>
      ) : null}
      {!offline && !data && resources.isPending ? <Text style={styles.label}>Loading workspace resources…</Text> : null}
      {data && selection ? (
        <>
          <Text accessibilityRole="header" style={detailHeading}>Worker selection</Text>
          <Text style={styles.label}>Scope visibility · {selection.scopeVisibility}</Text>
          {selection.candidates.length === 0 ? <Text style={styles.label}>No worker profiles configured.</Text> : null}
          {selection.candidates.map(({ profile, provider, model, poolAlias, decision }, index) => (
            <View key={`${profile}-${index}`} style={styles.card}>
              <Text style={detailHeading}>{profile}</Text>
              {provider && model ? <Text style={styles.label}>{provider} / {model}{poolAlias ? ` · ${poolAlias}` : ""}</Text> : null}
              {decision.state === "selected" ? (
                <Text style={styles.ok}>Selected{decision.accountAlias ? ` · ${decision.accountAlias}` : ""}</Text>
              ) : decision.state === "excluded" ? (
                <Text style={styles.conflict}>Excluded · {exclusionLabels[decision.reason]}</Text>
              ) : <Text style={styles.label}>Unevaluated alternative</Text>}
            </View>
          ))}
          <Text accessibilityRole="header" style={detailHeading}>Provider quota</Text>
          {data.pools.length === 0 ? <Text style={styles.label}>No provider quota pools reported.</Text> : null}
          <QuotaCards entries={data.pools} resources={data} styles={styles} />
          <Text accessibilityRole="header" style={detailHeading}>ZeroSub accounts</Text>
          {data.zeroSubState === "unavailable" ? <Text style={styles.label}>ZeroSub state unavailable.</Text>
            : data.accounts.length === 0 ? <Text style={styles.label}>No matching accounts.</Text> : null}
          <QuotaCards entries={data.accounts} resources={data} styles={styles} />
        </>
      ) : null}
    </>
  );
}

function QuotaCards({ entries, resources, styles }: {
  entries: Resources["pools"];
  resources: Pick<Resources, "warnPct" | "exhaustedPct">;
  styles: FactoryResultStyles;
}) {
  return entries.map(({ alias, provider, limited, limitedUntil, windows }) => (
    <View key={alias} style={[styles.card, { gap: 8 }]}>
      <Text style={[styles.body, { fontWeight: "600" }]}>{provider} · {alias}</Text>
      {limited ? <Text style={styles.conflict}>Limited{limitedUntil ? ` until ${new Date(limitedUntil).toLocaleString()}` : " · end time unknown"}</Text> : null}
      {windows.map(({ alias: name, state, usedPct, sampledAt, resetsAt }) => {
        const level = usedPct === null ? null : usedPct >= resources.exhaustedPct ? "Exhausted"
          : usedPct >= resources.warnPct ? "Near limit" : null;
        const usage = usedPct === null ? state === "stale" ? "Stale sample" : "Usage unavailable"
          : `${usedPct.toLocaleString(undefined, { maximumFractionDigits: 1 })}% used`;
        return (
          <View key={name} style={{ gap: 3 }}>
            <Text style={level || state === "stale" ? styles.conflict : styles.body}>{name} · {usage}{level ? ` · ${level}` : ""}</Text>
            <Text style={styles.label}>{sampledAt ? `Sampled ${new Date(sampledAt).toLocaleString()}` : "Sample time unknown"}</Text>
            <Text style={styles.label}>{resetsAt ? `Resets ${new Date(resetsAt).toLocaleString()}` : "Reset time unknown"}</Text>
          </View>
        );
      })}
    </View>
  ));
}
