import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { isQuotaSampleStale } from "../shared/defaults.mjs";
import { factoryWorkspaceResources } from "../shared/factory.js";
import type { FactoryResultStyles } from "./factory-panel.js";

type Resources = RpcOutput<typeof factoryWorkspaceResources>;
type Candidate = Resources["workerSelection"]["candidates"][number];
type Exclusion = Extract<Candidate["decision"], { state: "excluded" }>["reason"];
type QuotaEntry = Resources["pools"][number];
type QuotaWindow = QuotaEntry["windows"][number];
type QuotaThresholds = Pick<Resources, "warnPct" | "exhaustedPct" | "quotaSampleMinutes">;
type ResourceStyles = FactoryResultStyles & { label: { color: string } };

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

const details = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10, rowGap: 3 },
  split: { justifyContent: "space-between" },
  grow: { flexGrow: 1, flexShrink: 1 },
  section: { gap: 6 },
  group: { gap: 0, paddingVertical: 0 },
  quotaRow: { gap: 7, paddingVertical: 9 },
  heading: { fontSize: 15, fontWeight: "600" },
  strong: { fontWeight: "600" },
  small: { fontSize: 12 },
  refresh: { flexDirection: "row", gap: 6, alignItems: "center", minHeight: 44, paddingHorizontal: 8, borderRadius: 6 },
  meter: { height: 5, borderRadius: 3, overflow: "hidden" },
  candidate: { gap: 2, paddingVertical: 8 },
});

const time = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});
const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });

interface Props extends Pick<PluginWorkspacePanelProps, "workspaceId" | "layout" | "host"> {
  offline: boolean;
  styles: ResourceStyles;
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
  const busy = resources.isFetching;
  const refreshDisabled = offline || busy;

  return (
    <>
      <View style={[details.row, details.split]}>
        <Text accessibilityRole="header" style={[styles.body, details.strong, { fontSize: layout.compact ? 18 : 21 }]}>
          Workspace Resources
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh workspace resources"
          accessibilityState={{ disabled: refreshDisabled, busy }}
          disabled={refreshDisabled}
          onPress={() => { void resources.refetch(); }}
          style={({ pressed }) => [details.refresh, { backgroundColor: pressed ? styles.card.backgroundColor : undefined }]}
        >
          <Icon name="RefreshCw" size={14} color={styles.label.color} />
          <Text style={refreshDisabled ? styles.label : styles.body}>{busy ? "Checking…" : "Refresh"}</Text>
        </Pressable>
      </View>
      {offline || resources.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {offline ? data ? "Host disconnected. Showing the last resources snapshot." : "Host disconnected. Resources unavailable."
            : data ? "Resources could not be refreshed. Showing the last snapshot." : "Workspace resources could not be loaded."}
        </Text>
      ) : null}
      {!offline && !data && resources.isPending ? <Text style={styles.label}>Loading workspace resources…</Text> : null}
      {data ? (
        <View style={{ gap: layout.compact ? 14 : 18 }}>
          <ResourcesQuota data={data} styles={styles} />
          <WorkerSelection selection={data.workerSelection} styles={styles} />
        </View>
      ) : null}
    </>
  );
}

function ResourcesQuota({ data, styles }: { data: Resources; styles: ResourceStyles }) {
  const [, setClock] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const now = Date.now();
  const groups = new Map<string, { label: string; rows: { entry: QuotaEntry; isAccount: boolean }[] }>();
  for (const [entries, isAccount] of [[data.pools, false], [data.accounts, true]] as const) {
    for (const entry of entries) {
      let group = groups.get(entry.provider);
      if (!group) {
        group = { label: entry.providerLabel ?? entry.provider, rows: [] };
        groups.set(entry.provider, group);
      }
      group.rows.push({ entry, isAccount });
    }
  }
  const divider = { borderTopWidth: 1, borderTopColor: styles.card.borderColor };

  return (
    <View style={{ gap: 9 }}>
      <Text accessibilityRole="header" style={[styles.body, details.heading]}>Quota</Text>
      {groups.size === 0 ? <Text style={styles.label}>No provider quota pools reported.</Text> : null}
      {[...groups].map(([provider, { label, rows }]) => (
        <View key={provider} style={[styles.card, details.group]}>
          <Text accessibilityRole="header" style={[styles.body, details.strong, { paddingVertical: 8 }]}>{label}</Text>
          {rows.map(({ entry, isAccount }) => (
            <View key={`${isAccount ? "account" : "pool"}:${entry.alias}`} style={[details.quotaRow, divider]}>
              <View style={[details.row, details.split]}>
                <View style={[details.row, details.grow]}>
                  <Icon name={isAccount ? "CircleUserRound" : "Gauge"} size={14} color={styles.label.color} />
                  <Text style={[styles.body, details.strong]}>{entry.alias}</Text>
                </View>
                {entry.limited ? <LimitNote until={entry.limitedUntil} now={now} styles={styles} /> : null}
              </View>
              {entry.windows.map((window, index) => (
                <QuotaMeter key={`${window.alias}:${index}`} window={window} thresholds={data} now={now} styles={styles} />
              ))}
            </View>
          ))}
        </View>
      ))}
      {data.zeroSubState === "unavailable" ? <Text style={styles.label}>ZeroSub account data unavailable.</Text>
        : data.accounts.length === 0 ? <Text style={styles.label}>No matching ZeroSub accounts.</Text> : null}
    </View>
  );
}

function LimitNote({ until, now, styles }: { until: string | null; now: number; styles: FactoryResultStyles }) {
  if (!until) return <Text style={[styles.error, details.small]}>Limit reported · end time unknown</Text>;
  const ended = Date.parse(until) <= now;
  return (
    <Text style={[ended ? styles.label : styles.error, details.small]}>
      {ended ? "Reported limit ended" : "Limited until"} {time.format(new Date(until))}
    </Text>
  );
}

function QuotaMeter({ window, thresholds, now, styles }: {
  window: QuotaWindow;
  thresholds: QuotaThresholds;
  now: number;
  styles: FactoryResultStyles;
}) {
  const resetPassed = window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
  const stale = window.state === "stale" || (window.state === "available" && (
    resetPassed || isQuotaSampleStale(window.sampledAt ? Date.parse(window.sampledAt) : null, now, thresholds.quotaSampleMinutes)
  ));
  const used = stale ? null : window.usedPct;
  const fill = used === null ? 0 : Math.min(100, used);
  const level = used === null ? null : used >= 100 ? "Exhausted"
    : used >= thresholds.exhaustedPct ? "Factory threshold reached" : used >= thresholds.warnPct ? "Near limit" : null;
  const tone = used === null ? stale ? styles.conflict : styles.label
    : used >= Math.min(100, thresholds.exhaustedPct) ? styles.error : used >= thresholds.warnPct ? styles.conflict : styles.ok;
  const usage = used === null ? stale ? "Stale sample" : "Usage unavailable"
    : `${percent.format(used / 100)} used · ${percent.format((100 - fill) / 100)} left`;
  const timing = [
    window.resetsAt ? `${resetPassed ? "Reset time passed" : "Resets"} ${time.format(new Date(window.resetsAt))}`
      : used !== null || stale ? "Reset time unknown" : null,
    window.sampledAt && window.state !== "unavailable" ? `Sampled ${time.format(new Date(window.sampledAt))}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <View style={{ gap: 3 }}>
      <View style={[details.row, details.split]}>
        <Text style={[styles.body, details.small]}>{window.alias}</Text>
        <Text style={[tone, details.small, details.strong]}>{usage}{level ? ` · ${level}` : ""}</Text>
      </View>
      {used !== null ? (
        <View aria-hidden style={[details.meter, { backgroundColor: styles.card.borderColor }]}>
          <View style={{ width: `${fill}%`, height: "100%", backgroundColor: tone.color }} />
        </View>
      ) : null}
      {timing ? <Text style={[styles.label, details.small]}>{timing}</Text> : null}
    </View>
  );
}

function WorkerSelection({ selection, styles }: { selection: Resources["workerSelection"]; styles: FactoryResultStyles }) {
  return (
    <View style={details.section}>
      <View style={[details.row, details.split]}>
        <Text accessibilityRole="header" style={[styles.body, details.heading]}>Worker selection</Text>
        <Text style={[styles.label, details.small]}>Scope visibility · {selection.scopeVisibility}</Text>
      </View>
      {selection.candidates.length === 0 ? <Text style={styles.label}>No worker profiles configured.</Text> : (
        <View style={[styles.card, details.group]}>
          {selection.candidates.map(({ profile, provider, providerLabel, model, modelLabel, poolAlias, decision }, index) => {
            const selected = decision.state === "selected";
            const excluded = decision.state === "excluded";
            const account = selected ? decision.accountAlias ?? poolAlias : poolAlias;
            const description = [providerLabel ?? provider, modelLabel ?? model, account].filter(Boolean).join(" · ");
            return (
              <View key={`${profile}:${index}`} style={[details.candidate, index > 0 && { borderTopWidth: 1, borderTopColor: styles.card.borderColor }]}>
                <View style={[details.row, details.split]}>
                  <Text style={[styles.body, details.strong, details.grow]}>{profile}</Text>
                  <Text style={[selected ? styles.ok : excluded ? styles.conflict : styles.label, details.small, details.strong]}>
                    {selected ? "Selected" : excluded ? "Excluded" : "Unevaluated alternative"}
                  </Text>
                </View>
                {description ? <Text style={[styles.label, details.small]}>{description}</Text> : null}
                {excluded ? <Text style={[styles.label, details.small]}>{exclusionLabels[decision.reason]}</Text> : null}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}
