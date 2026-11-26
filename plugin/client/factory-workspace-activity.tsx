import type { RpcOutput } from "@getpaseo/plugin";
import { useAgents, useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { factoryWorkspaceActivity } from "../shared/workspace-activity.js";
import type { FactoryResultStyles } from "./factory-panel.js";

type ActivityEvent = RpcOutput<typeof factoryWorkspaceActivity>["events"][number];
const filters = ["All", "Control", "Recovery", "Delivery", "Agents"] as const;
type Filter = (typeof filters)[number];

const eventFilters: Record<ActivityEvent["kind"], Exclude<Filter, "All">> = {
  "holder-change": "Control",
  "takeover-request": "Control",
  recovery: "Recovery",
  renewal: "Recovery",
  delivery: "Delivery",
  assignment: "Delivery",
  creation: "Agents",
  "worker-wake": "Agents",
};

const titles: Record<ActivityEvent["kind"], string> = {
  "holder-change": "Control changed",
  creation: "Agent creation",
  renewal: "Context renewal",
  recovery: "Recovery",
  delivery: "Brief delivery",
  "takeover-request": "Takeover request",
  assignment: "Assignment",
  "worker-wake": "Worker update",
};

const icons: Record<ActivityEvent["kind"], string> = {
  "holder-change": "ArrowRightLeft",
  creation: "UserPlus",
  renewal: "History",
  recovery: "RotateCcw",
  delivery: "Send",
  "takeover-request": "GitBranch",
  assignment: "ClipboardList",
  "worker-wake": "Bell",
};

const descriptions: Record<ActivityEvent["reason"], string> = {
  "slot-changed": "Control moved to another slot.",
  "holder-replaced": "A replacement agent took control.",
  "steer-created": "Steer agent created.",
  "worker-created": "Worker agent created.",
  "context-cleared": "Context cleared.",
  "context-compacted": "Context compacted.",
  "context-rewound": "Context rewound.",
  "renewal-unconfirmed": "Renewal could not be confirmed.",
  "clear-reserved": "Context clear reserved.",
  "clear-attempt-unconfirmed": "Context clear attempt unconfirmed.",
  "daemon-restart": "Recovery needed after a daemon restart.",
  "provider-limit": "Recovery needed after a provider limit.",
  "turn-failed": "Recovery needed after a failed turn.",
  "brief-staged": "Brief staged in the composer queue.",
  "delivery-queued": "Brief queued for delivery.",
  "waiting-for-renewal": "Delivery is waiting for context renewal.",
  "delivery-unconfirmed": "Dispatch attempt recorded. Outcome unconfirmed.",
  "delivery-blocked": "Delivery blocked.",
  "delivery-blocked-after-attempt": "Further dispatch blocked. Prior attempt unconfirmed.",
  "dispatch-acknowledged": "Paseo acknowledged the dispatch.",
  "takeover-recorded": "Takeover request recorded in the checkpoint.",
  "assignment-recorded": "Assignment recorded.",
  "assignment-report-delivered": "Assignment report delivered.",
  "worker-completed": "Completion update queued.",
  "worker-partial": "Partial result update queued.",
  "worker-blocked": "Blocker update queued.",
  "worker-interrupted": "Interruption update queued.",
  "worker-stale": "Stale worker update queued.",
  "worker-update": "Worker update queued.",
  "wake-recorded": "Worker update recorded.",
};

const causes: Record<NonNullable<ActivityEvent["cause"]>, string> = {
  "no-answer": "The answer window expired.",
  "no-holder": "The active slot had no live holder.",
  "provider-limit": "The active Steer hit a provider limit.",
  "quota-exhausted": "The active Steer's quota was exhausted.",
  "advisor-holder": "The active Steer was flagged as an advisor.",
  privacy: "The active Steer was ineligible under the brief privacy rules.",
};

const observedDay = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const observedTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const dayOf = (observedAt: string | null) => observedAt ? observedDay.format(new Date(observedAt)) : null;

function timelineRows(events: readonly ActivityEvent[]) {
  const groups = new Map<number, ActivityEvent[]>();
  return events.flatMap((event, index) => {
    if (event.group) {
      const group = groups.get(event.group.index);
      if (group) {
        group.push(event);
        return [];
      }
      const steps = [event];
      groups.set(event.group.index, steps);
      return [{ index, kind: event.group.kind, steps, grouped: true }];
    }
    return [{ index, kind: event.kind, steps: [event], grouped: false }];
  });
}

const timeline = StyleSheet.create({
  header: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" },
  refresh: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, borderRadius: 6 },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  filter: { minHeight: 36, justifyContent: "center", paddingHorizontal: 9, borderWidth: 1, borderRadius: 18 },
  day: { marginTop: 12, marginBottom: 8, fontWeight: "600" },
  row: { flexDirection: "row", gap: 8 },
  rail: { width: 24, alignItems: "center" },
  marker: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  stem: { flex: 1, width: StyleSheet.hairlineWidth, marginVertical: 3 },
  content: { flex: 1, minWidth: 0, gap: 3 },
  line: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 },
  lineText: { flex: 1, minWidth: 0 },
  title: { fontWeight: "600" },
  time: { textAlign: "right", fontSize: 12, fontVariant: ["tabular-nums"] },
  details: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 2 },
  description: { flexShrink: 1 },
  participants: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, maxWidth: "100%" },
  agent: { minHeight: 28, flexDirection: "row", alignItems: "center", gap: 3, borderRadius: 4, paddingHorizontal: 3 },
  agentLabel: { textDecorationLine: "underline" },
  operation: { borderLeftWidth: 2, paddingLeft: 8, gap: 6 },
  step: { gap: 2 },
});

interface Props extends Pick<PluginWorkspacePanelProps, "workspaceId" | "layout" | "host" | "navigation"> {
  offline: boolean;
  styles: FactoryResultStyles;
}

interface ParticipantProps {
  liveAgentIds: ReadonlySet<string>;
  openAgent?: (agentId: string) => void;
  offline: boolean;
  styles: FactoryResultStyles;
}

function Participant({ agentId, label, liveAgentIds, openAgent, offline, styles }: ParticipantProps & {
  agentId?: string;
  label: string;
}) {
  if (!agentId || !openAgent || !liveAgentIds.has(agentId)) return <Text style={styles.label}>{label}</Text>;
  const labelStyle = offline ? styles.label : styles.body;

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Opens the agent tab"
      disabled={offline} accessibilityState={{ disabled: offline }}
      onPress={() => openAgent(agentId)}
      style={({ pressed }) => [timeline.agent, pressed && { backgroundColor: styles.card.backgroundColor }]}>
      <Text style={[styles.label, { color: labelStyle.color }, timeline.agentLabel]}>{label}</Text>
      <Icon name="ArrowUpRight" size={12} color={String(labelStyle.color)} />
    </Pressable>
  );
}

function Participants({ event, ...props }: ParticipantProps & { event: ActivityEvent }) {
  const { kind, fromAgentId, participantAgentId } = event;
  let from = event.from ?? (fromAgentId ? "Agent" : undefined);
  let participant = event.participant ?? (participantAgentId ? "Agent" : undefined);
  if (!from && !participant) return null;
  if (kind === "takeover-request") {
    if (from) from = `Holder ${from}`;
    if (participant) participant = `Target ${participant}`;
  } else if (kind === "assignment") {
    if (from) from = `Requested by ${from}`;
    if (participant) participant = `Report to ${participant}`;
  } else if (from && from === participant) {
    if (fromAgentId === participantAgentId) from = undefined;
    else from = `Previous ${from}`;
  } else if (from && !participant) {
    from = `From ${from}`;
  }

  return (
    <View style={timeline.participants}>
      {from ? <Participant {...props} agentId={fromAgentId} label={from} /> : null}
      {from && participant ? <Text style={props.styles.label}>{kind === "takeover-request" ? "·" : "→"}</Text> : null}
      {participant ? <Participant {...props} agentId={participantAgentId} label={participant} /> : null}
    </View>
  );
}

function EventTime({ timestamp, rowDay, styles }: {
  timestamp: ActivityEvent["observedAt"];
  rowDay: string | null;
  styles: FactoryResultStyles;
}) {
  const eventDay = dayOf(timestamp);
  const time = timestamp ? observedTime.format(new Date(timestamp)) : "Time unknown";
  const showDate = eventDay !== null && eventDay !== rowDay;
  return (
    <Text style={[styles.label, timeline.time]}>{showDate ? `${eventDay}\n${time}` : time}</Text>
  );
}

export function FactoryWorkspaceActivity({ workspaceId, layout, host, offline, navigation, styles }: Props) {
  const [filter, setFilter] = useState<Filter>("All");
  const callActivity = useRpc(factoryWorkspaceActivity);
  const activity = useQuery({
    queryKey: ["workspace-factory", "activity", host.id, workspaceId],
    queryFn: async () => {
      const result = await callActivity({ workspaceId });
      if (result.workspaceId !== workspaceId) throw new Error("Factory returned activity for a different workspace.");
      return result;
    },
    enabled: !offline,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  const events = activity.data?.events;
  const visible = (events ?? []).filter(({ kind }) => filter === "All" || eventFilters[kind] === filter);
  // Keep an operation together under its newest visible step's date.
  const rows = timelineRows(visible).map((row) => ({ ...row, day: dayOf(row.steps[0].observedAt) }));
  const liveAgents = useAgents({
    hosts: [host.id],
    where: (agent) => agent.workspaceId === workspaceId && !agent.background,
  });
  const participantProps = {
    liveAgentIds: new Set(liveAgents.map(({ id }) => id)),
    openAgent: navigation && ((agentId: string) => navigation.openAgent({ agentId, serverId: host.id })),
    offline,
    styles,
  };
  const refreshDisabled = offline || activity.isFetching;
  const refreshStyle = refreshDisabled ? styles.label : styles.body;

  return (
    <>
      <View style={timeline.header}>
        <Text accessibilityRole="header" style={[styles.body, timeline.title, { fontSize: layout.compact ? 18 : 21 }]}>Recent activity</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh workspace activity" disabled={refreshDisabled}
          accessibilityState={{ disabled: refreshDisabled, busy: activity.isFetching }}
          onPress={() => { void activity.refetch(); }}
          style={({ pressed }) => [timeline.refresh, pressed && { backgroundColor: styles.card.backgroundColor }]}>
          <Icon name="RefreshCw" size={14} color={String(refreshStyle.color)} />
          <Text style={refreshStyle}>
            {activity.isFetching ? "Checking…" : "Refresh"}
          </Text>
        </Pressable>
      </View>
      {offline || activity.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {offline ? events ? "Host disconnected. Showing the last activity snapshot." : "Host disconnected. Activity unavailable."
            : events ? "Activity could not be refreshed. Showing the last snapshot." : "Workspace activity could not be loaded."}
        </Text>
      ) : null}
      {!offline && !events && activity.isPending ? <Text style={styles.label}>Loading workspace activity…</Text> : null}
      {events?.length === 0 ? <Text style={styles.label}>No activity recorded.</Text> : null}
      {events?.length ? (
        <View style={timeline.filters} accessibilityLabel="Activity filters">
          {filters.map((name) => {
            const selected = name === filter;
            return (
              <Pressable key={name} accessibilityRole="button" accessibilityState={{ selected }}
                onPress={() => setFilter(name)}
                style={({ pressed }) => [timeline.filter, {
                  borderColor: selected || pressed ? styles.button.backgroundColor : styles.card.borderColor,
                  backgroundColor: selected ? styles.button.backgroundColor : styles.card.backgroundColor,
                }]}>
                <Text style={selected ? [styles.buttonText, timeline.title, { fontSize: 13 }] : styles.label}>{name}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {events?.length && !rows.length ? <Text style={styles.label}>No matching recorded activity.</Text> : null}
      {rows.length > 0 ? (
        <View>
          {rows.map(({ index, kind, steps, day, grouped }, rowIndex) => {
            const startsDay = rowIndex === 0 || rows[rowIndex - 1].day !== day;
            const endsDay = rowIndex === rows.length - 1 || rows[rowIndex + 1].day !== day;
            const attention = steps.some(({ state }) => state === "blocked" || state === "uncertain");
            const confirmed = steps.some(({ state }) => state === "confirmed" || state === "delivered");
            const iconStyle = attention ? styles.conflict : confirmed ? styles.ok : styles.label;
            return (
              <View key={index}>
                {startsDay ? <Text accessibilityRole="header" style={[styles.label, timeline.day]}>{day ?? "Date unknown"}</Text> : null}
                <View style={timeline.row}>
                  <View style={timeline.rail} importantForAccessibility="no-hide-descendants">
                    <View style={[timeline.marker, { backgroundColor: styles.card.backgroundColor }]}>
                      <Icon name={icons[kind]} size={14} color={String(iconStyle.color)} />
                    </View>
                    {!endsDay ? <View style={[timeline.stem, { backgroundColor: styles.card.borderColor }]} /> : null}
                  </View>
                  <View style={[timeline.content, { paddingBottom: endsDay ? 0 : layout.compact ? 8 : 10 }]}>
                    <View style={timeline.line}>
                      <Text style={[styles.body, timeline.title, timeline.lineText]}>{titles[kind]}</Text>
                      {!grouped ? <EventTime timestamp={steps[0].observedAt} rowDay={day} styles={styles} /> : null}
                    </View>
                    <View style={grouped && [timeline.operation, { borderColor: styles.card.borderColor }]}>
                      {steps.map((event, stepIndex) => {
                        const resultStyle = event.state === "blocked" || event.state === "uncertain" ? styles.conflict : styles.label;
                        return (
                          <View key={stepIndex} style={timeline.step}>
                            {grouped ? (
                              <View style={timeline.line}>
                                <Text style={[resultStyle, timeline.lineText]}>{descriptions[event.reason]}</Text>
                                <EventTime timestamp={event.observedAt} rowDay={day} styles={styles} />
                              </View>
                            ) : null}
                            <View style={timeline.details}>
                              <Participants event={event} {...participantProps} />
                              {!grouped ? <Text style={[resultStyle, timeline.description]}>{descriptions[event.reason]}</Text> : null}
                            </View>
                            {event.cause ? <Text style={styles.label}>{causes[event.cause]}</Text> : null}
                            {event.renewal ? (
                              <Text style={styles.label}>{event.renewal === "clear" ? "Clear selected before dispatch" : "Rewind selected before dispatch"}</Text>
                            ) : null}
                          </View>
                        );
                      })}
                    </View>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </>
  );
}
