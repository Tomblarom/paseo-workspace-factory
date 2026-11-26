import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { isQuotaSampleStale } from "../shared/defaults.mjs";
import { factoryWorkspaceResources } from "../shared/factory.js";
import { modelDisplayName } from "../shared/model-label.js";
import type { FactoryResultStyles } from "./factory-panel.js";

type Resources = RpcOutput<typeof factoryWorkspaceResources>;
type Candidate = Resources["workerSelection"]["candidates"][number];
type Exclusion = Extract<Candidate["decision"], { state: "excluded" }>["reason"];
type QuotaEntry = Resources["pools"][number];
type QuotaWindow = QuotaEntry["windows"][number];
type QuotaThresholds = Pick<Resources, "warnPct" | "exhaustedPct" | "quotaSampleMinutes">;
type ResourceStyles = FactoryResultStyles & { label: { color: string }; ok: { color: string } };
type QuotaView = { styles: ResourceStyles; thresholds: QuotaThresholds; now: number };

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
  quotaRow: { gap: 6, paddingVertical: 4 },
  heading: { fontSize: 15, fontWeight: "600" },
  strong: { fontWeight: "600" },
  small: { fontSize: 12 },
  number: { fontVariant: ["tabular-nums"] },
  refresh: { flexDirection: "row", gap: 6, alignItems: "center", minHeight: 44, paddingHorizontal: 8, borderRadius: 6 },
  control: { borderWidth: 1, borderColor: "transparent" },
  columnRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  accountColumn: { width: 148 },
  windowColumn: { flex: 1, minWidth: 0 },
  accountButton: { flexDirection: "row", alignItems: "center", gap: 5, paddingRight: 5, minHeight: 36, borderRadius: 5 },
  meter: { height: 5, borderRadius: 3, overflow: "hidden", marginTop: 2 },
  expanded: { gap: 6, padding: 8, borderRadius: 5, marginBottom: 4 },
  candidate: { gap: 2, paddingVertical: 8 },
  metric: { minWidth: 130, flexGrow: 1, gap: 2 },
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
  const [refreshFocused, setRefreshFocused] = useState(false);
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
          onFocus={() => setRefreshFocused(true)}
          onBlur={() => setRefreshFocused(false)}
          onPress={() => { void resources.refetch(); }}
          style={({ pressed }) => [details.refresh, details.control, {
            backgroundColor: pressed ? styles.card.backgroundColor : undefined,
            borderColor: refreshFocused && !refreshDisabled ? styles.button.backgroundColor : "transparent",
          }]}
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
          {data.steerRouting ? <SteerRouting decision={data.steerRouting} styles={styles} /> : null}
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
  const [width, setWidth] = useState(0);
  const view = { now: Date.now(), styles, thresholds: data };
  const groups = new Map<string, { label: string; pools: QuotaEntry[]; accounts: QuotaEntry[] }>();
  for (const key of ["pools", "accounts"] as const) {
    for (const entry of data[key]) {
      let group = groups.get(entry.provider);
      if (!group) {
        group = { label: entry.providerLabel, pools: [], accounts: [] };
        groups.set(entry.provider, group);
      }
      group[key].push(entry);
    }
  }
  const divider = { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: styles.card.borderColor };

  return (
    <View style={{ gap: 8 }} onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}>
      {groups.size === 0 ? <Text style={styles.label}>No provider quota pools reported.</Text> : null}
      {[...groups].map(([provider, { label, pools, accounts }]) => {
        const columns = [...new Set(accounts.flatMap(({ windows }) => windows.map(({ alias }) => alias)))];
        const tabular = columns.length > 0 && width >= 176 + 112 * columns.length;
        return (
          <View key={provider} style={[styles.card, details.group]}>
            <Text accessibilityRole="header" style={[styles.body, details.heading, { paddingVertical: 8 }]}>{label}</Text>
            {tabular ? (
              <View style={[details.columnRow, { paddingBottom: 6 }]}>
                <Text style={[styles.label, details.small, details.accountColumn]}>Account</Text>
                {columns.map((name) => (
                  <Text key={name} style={[styles.label, details.small, details.windowColumn]}>{name}</Text>
                ))}
              </View>
            ) : null}
            {accounts.map((entry) => (
              <View key={entry.alias} style={divider}>
                <QuotaRow entry={entry} columns={tabular ? columns : null} view={view} />
              </View>
            ))}
            {pools.map((entry) => (
              <View key={entry.alias} style={divider}>
                <QuotaRow entry={entry} columns={null} view={view} />
              </View>
            ))}
          </View>
        );
      })}
      {data.zeroSubState === "unavailable" ? <Text style={styles.label}>ZeroSub account data unavailable.</Text>
        : data.accounts.length === 0 ? <Text style={styles.label}>No matching ZeroSub accounts.</Text> : null}
    </View>
  );
}

function emptyQuota({ quotaKind }: QuotaEntry) {
  if (quotaKind === "api") return "API access · No subscription quota";
  if (quotaKind === "subscription") return "Subscription quota unavailable";
  if (quotaKind === "reported") return "No applicable quota windows";
  return "Quota type and usage unknown";
}

function QuotaRow({ entry, columns, view }: { entry: QuotaEntry; columns: string[] | null; view: QuotaView }) {
  const { styles, now } = view;
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const canExpand = entry.windows.length > 0 || entry.sampledAt !== null;
  const title = <Text style={[styles.body, details.strong, { flexShrink: 1 }]}>{entry.alias}</Text>;
  const windowLookup = new Map(entry.windows.map((window) => [window.alias, window]));

  return (
    <View style={details.quotaRow}>
      <View style={columns ? details.columnRow : details.section}>
        <View style={columns ? details.accountColumn : [details.row, details.split]}>
          {canExpand ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`${entry.alias} quota details`}
              accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}
              onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
              style={({ pressed }) => [details.accountButton, details.control, {
                borderColor: focused ? styles.button.backgroundColor : "transparent",
                opacity: pressed ? 0.7 : 1,
              }]}>
              <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={styles.label.color} />
              {title}
            </Pressable>
          ) : title}
          {entry.limited ? <LimitNote until={entry.limitedUntil} now={now} styles={styles} /> : null}
        </View>
        {entry.windows.length === 0 ? (
          <Text style={[styles.label, details.small, columns && details.windowColumn]}>{emptyQuota(entry)}</Text>
        ) : columns ? columns.map((name) => (
          <View key={name} style={details.windowColumn}>
            <QuotaMeter window={windowLookup.get(name)} label={name} showLabel={false} view={view} />
          </View>
        )) : entry.windows.map((window) => (
          <QuotaMeter key={window.alias} window={window} label={window.alias} showLabel view={view} />
        ))}
      </View>
      {expanded && canExpand ? (
        <View style={[details.expanded, { borderWidth: StyleSheet.hairlineWidth, borderColor: styles.card.borderColor }]}>
          {entry.windows.length > 0 ? entry.windows.map((window) => (
            <QuotaTiming key={window.alias} window={window} view={view} />
          )) : entry.sampledAt ? (
            <Text style={[styles.label, details.small]}>Sampled {time.format(new Date(entry.sampledAt))}</Text>
          ) : null}
        </View>
      ) : null}
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

function windowState(window: QuotaWindow, { now, thresholds }: QuotaView) {
  const resetPassed = window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
  const stale = window.state === "stale" || (window.state === "available" && (
    resetPassed || isQuotaSampleStale(window.sampledAt ? Date.parse(window.sampledAt) : null, now, thresholds.quotaSampleMinutes)
  ));
  return { state: stale ? "stale" : window.state, resetPassed } as const;
}

function QuotaMeter({ window, label, showLabel, view }: {
  window: QuotaWindow | undefined;
  label: string;
  showLabel: boolean;
  view: QuotaView;
}) {
  const { styles, thresholds } = view;
  const state = window ? windowState(window, view).state : null;
  const used = state === "available" ? window?.usedPct ?? null : null;
  const danger = used !== null && used >= Math.min(100, thresholds.exhaustedPct);
  const warning = used !== null && used >= thresholds.warnPct;
  const level = used === null ? null : used >= 100 ? "Exhausted"
    : danger ? "Threshold reached" : warning ? "Near limit" : null;
  const tone = used === null ? state === "stale" ? styles.conflict : styles.label
    : danger ? styles.error : warning ? styles.conflict : styles.ok;
  const usage = used === null ? state === "stale" ? "Stale sample" : window ? "Usage unavailable" : "Not reported"
    : `${percent.format(used / 100)} used`;
  const status = [usage, level].filter(Boolean).join(" · ");

  return (
    <View accessible accessibilityLabel={`${label}, ${status}`}>
      <View style={[details.row, details.split]}>
        {showLabel ? <Text style={[styles.body, details.small]}>{label}</Text> : null}
        <Text style={[tone, details.small, details.strong, details.number]}>{status}</Text>
      </View>
      {used !== null ? (
        <View aria-hidden style={[details.meter, { backgroundColor: styles.card.borderColor }]}>
          <View style={{ width: `${Math.min(100, used)}%`, height: "100%", backgroundColor: tone.color }} />
        </View>
      ) : null}
    </View>
  );
}

function QuotaTiming({ window, view }: { window: QuotaWindow; view: QuotaView }) {
  const { styles } = view;
  const { state, resetPassed } = windowState(window, view);
  const freshness = state === "available" ? "Fresh sample" : state === "stale" ? "Stale sample" : "Usage unavailable";
  const reset = window.resetsAt ? `${resetPassed ? "Reset time passed" : "Resets"} ${time.format(new Date(window.resetsAt))}`
    : "Reset time unknown";
  const sampled = window.sampledAt ? `Sampled ${time.format(new Date(window.sampledAt))}` : "Sample time unknown";
  const remaining = state === "available" && window.usedPct !== null
    ? ` · ${percent.format(Math.max(0, 100 - window.usedPct) / 100)} left` : "";

  return (
    <View style={{ gap: 2 }}>
      <View style={[details.row, details.split]}>
        <Text style={[styles.body, details.small, details.strong]}>{window.alias}</Text>
        <Text style={[state === "stale" ? styles.conflict : styles.label, details.small]}>{freshness}{remaining}</Text>
      </View>
      <Text style={[styles.label, details.small]}>{reset} · {sampled}</Text>
    </View>
  );
}

function WorkerSelection({ selection, styles }: { selection: Resources["workerSelection"]; styles: ResourceStyles }) {
  const selected = selection.candidates.find(({ decision }) => decision.state === "selected");
  return (
    <View style={details.section}>
      <View style={[details.row, details.split]}>
        <Text accessibilityRole="header" style={[styles.body, details.heading]}>Worker selection</Text>
        <Text style={[styles.label, details.small]}>Worker priority · Scope {selection.scopeVisibility}</Text>
      </View>
      {selection.candidates.length === 0 ? <Text style={styles.label}>No worker profiles configured.</Text> : (
        <View style={[styles.card, details.group]}>
          {!selected ? <Text style={[styles.conflict, details.candidate]}>No eligible worker profile.</Text> : null}
          {selection.candidates.map(({ profile, provider, providerLabel, model, modelLabel, decision }, index) => {
            const picked = decision.state === "selected";
            const excluded = decision.state === "excluded";
            const modelName = modelDisplayName(model, modelLabel);
            const description = [providerLabel ?? provider, modelName && profile !== modelName ? profile : null].filter(Boolean).join(" · ");
            return (
              <View key={`${profile}:${index}`} style={[details.candidate, index > 0 && {
                borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: styles.card.borderColor,
              }]}>
                <View style={[details.row, details.split]}>
                  <View style={[details.row, details.grow]}>
                    {picked ? <Icon name="CircleCheck" size={14} color={styles.ok.color} /> : null}
                    <Text accessibilityHint={model ? `Model ID ${model}` : undefined}
                      style={[styles.body, details.strong, { flexShrink: 1 }]}>{modelName ?? profile}</Text>
                  </View>
                  <Text style={[picked ? styles.ok : excluded ? styles.conflict : styles.label, details.small, details.strong]}>
                    {picked ? "Selected" : excluded ? "Excluded" : "Not evaluated"}
                  </Text>
                </View>
                {description ? <Text style={[styles.label, details.small]}>{description}</Text> : null}
                {picked ? (
                  <>
                    <Text style={[styles.body, details.small]}>First eligible profile in worker priority order. Provider ready and configuration passed catalog checks.</Text>
                    <Text style={[styles.label, details.small]}>{workerQuotaEvidence(decision.accountAlias, selection.accountEvidence)}</Text>
                  </>
                ) : excluded ? <Text style={[styles.label, details.small]}>{exclusionLabels[decision.reason]}</Text> : null}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

function workerQuotaEvidence(alias: string | null, evidence: Resources["workerSelection"]["accountEvidence"]) {
  if (!alias || !evidence) return "Selection had no ZeroSub account evidence.";
  const candidate = `ZeroSub quota candidate · ${alias}`;
  if (evidence.usedPct !== null) {
    const freshness = evidence.state === "stale" ? " · Stale sample"
      : evidence.state === "unavailable" ? " · Sample time unknown" : "";
    return `${candidate} · ${percent.format(evidence.usedPct / 100)} peak used in account ranking${freshness}`;
  }
  return evidence.quotaKind === "api" ? `${candidate} · API access` : `${candidate} · Usage unavailable`;
}

type Route = NonNullable<Resources["steerRouting"]>;

const routeReasons: Record<NonNullable<Route["reason"]>, string> = {
  "only eligible route": "Only eligible route",
  "equal evidence; retained candidate order": "Equal evidence · Candidate order decided",
  "selected by uncachedInputTokens": "Selected by uncached input tokens",
  "selected by preparationTurns": "Selected by preparation turns",
  "selected by latencyMs": "Selected by latency",
  "selected by preferenceRank": "Selected by preference rank",
};
const routeStrategy: Record<Route["strategy"], string> = {
  efficiency: "Efficiency", balanced: "Balanced", preference: "Preference",
};
const routeKind: Record<Route["kind"], string> = {
  continue: "Continue", move: "Move", handover: "Handover", renewal: "Renewal", create: "Create",
};
const preparation: Record<Route["preparation"], string> = {
  send: "Send brief", rewind: "Rewind context", clear: "Clear context",
};
const confidence: Record<Route["confidence"], string> = {
  estimated: "Estimated evidence", observed: "Observed evidence", unknown: "Evidence confidence unknown",
};
const number = new Intl.NumberFormat();

function SteerRouting({ decision, styles }: { decision: Route; styles: ResourceStyles }) {
  const { evidence } = decision;
  const metrics = [
    { label: "Uncached input tokens", value: evidence.uncachedInputTokens },
    { label: "Preparation turns", value: evidence.preparationTurns },
    { label: "Latency", value: evidence.latencyMs, unit: " ms" },
    { label: "Preference rank", value: evidence.preferenceRank === null ? null : evidence.preferenceRank + 1 },
  ];
  const context = [
    decision.queuedAt && `Queued ${time.format(new Date(decision.queuedAt))}`,
    decision.epoch !== null && `Epoch ${decision.epoch}`,
    decision.accountAlias,
    confidence[decision.confidence],
  ].filter(Boolean).join(" · ");
  return (
    <View style={details.section}>
      <View style={[details.row, details.split]}>
        <Text accessibilityRole="header" style={[styles.body, details.heading]}>Last steer routing</Text>
        <Text style={[styles.label, details.small]}>{routeStrategy[decision.strategy]} · {decision.intent}</Text>
      </View>
      <View style={[styles.card, details.section]}>
        <View style={details.row}>
          <Icon name="Route" size={15} color={styles.label.color} />
          <Text style={[styles.body, details.strong, details.grow]}>{routeKind[decision.kind]} · {preparation[decision.preparation]}</Text>
        </View>
        <Text style={[styles.body, details.small]}>{decision.reason ? routeReasons[decision.reason] : "Selection reason unknown"}</Text>
        <View style={[details.row, { alignItems: "flex-start" }]}>
          {metrics.map(({ label, value, unit }) => (
            <View key={label} style={details.metric}>
              <Text style={[styles.label, details.small]}>{label}</Text>
              <Text style={[styles.body, details.small, details.strong, details.number]}>
                {value === null ? "Unknown" : `${number.format(value)}${unit ?? ""}`}
              </Text>
            </View>
          ))}
        </View>
        <Text style={[styles.label, details.small]}>{context}</Text>
      </View>
    </View>
  );
}
