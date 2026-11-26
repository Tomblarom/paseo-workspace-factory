import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { factoryWorkspaceActivity } from "../shared/workspace-activity.js";
import type { FactoryResultStyles } from "./factory-panel.js";

type ActivityEvent = RpcOutput<typeof factoryWorkspaceActivity>["events"][number];

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

const observedTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function participants({ kind, from, participant }: ActivityEvent) {
  if (kind === "takeover-request") {
    return [from && `Holder ${from}`, participant && `Target ${participant}`].filter(Boolean).join(" · ");
  }
  if (kind === "assignment") {
    return from ? `Requested by ${from}` : participant ? `Report to ${participant}` : "";
  }
  if (!from || from === participant) return participant;
  return participant ? `${from} → ${participant}` : `From ${from}`;
}

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
      return [{ index, kind: event.group.kind, steps }];
    }
    return [{ index, kind: event.kind, steps: [event] }];
  });
}

const timeline = StyleSheet.create({
  header: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" },
  refresh: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, borderRadius: 6 },
  row: { flexDirection: "row", gap: 10 },
  rail: { width: 22, alignItems: "center" },
  stem: { flex: 1, width: StyleSheet.hairlineWidth, marginTop: 4 },
  content: { flex: 1, minWidth: 0, gap: 4 },
  title: { fontWeight: "600" },
  step: { gap: 2 },
  relatedStep: { borderLeftWidth: StyleSheet.hairlineWidth, paddingLeft: 8 },
});

interface Props extends Pick<PluginWorkspacePanelProps, "workspaceId" | "layout" | "host"> {
  offline: boolean;
  styles: FactoryResultStyles;
}

export function FactoryWorkspaceActivity({ workspaceId, layout, host, offline, styles }: Props) {
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
  const rows = timelineRows(events ?? []);
  const refreshDisabled = offline || activity.isFetching;
  const refreshStyle = refreshDisabled ? styles.label : styles.body;

  return (
    <>
      <View style={timeline.header}>
        <Text accessibilityRole="header" style={[styles.body, { fontSize: layout.compact ? 18 : 21, fontWeight: "600" }]}>
          Recent recorded activity
        </Text>
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
      {rows.length ? (
        <View>
          {rows.map(({ index, kind, steps }, rowIndex) => {
            const grouped = steps.length > 1;
            const last = rowIndex === rows.length - 1;
            const attention = steps.some(({ state }) => state === "blocked" || state === "uncertain");
            const iconStyle = attention ? styles.conflict : styles.label;
            const gap = layout.compact ? 10 : 14;
            return (
              <View key={index} style={timeline.row}>
                <View style={timeline.rail} importantForAccessibility="no-hide-descendants">
                  <Icon name={icons[kind]} size={16} color={String(iconStyle.color)} />
                  {!last ? <View style={[timeline.stem, { backgroundColor: styles.card.borderColor }]} /> : null}
                </View>
                <View style={[timeline.content, { paddingBottom: last ? 0 : gap }]}>
                  <Text style={[styles.body, timeline.title]}>{titles[kind]}</Text>
                  {steps.map((event, stepIndex) => {
                    const resultStyle = event.state === "blocked" || event.state === "uncertain" ? styles.conflict : styles.body;
                    const time = event.observedAt ? observedTime.format(new Date(event.observedAt)) : "Time unknown";
                    const metadata = [participants(event), time].filter(Boolean).join(" · ");
                    return (
                      <View key={stepIndex} style={[timeline.step, grouped && timeline.relatedStep, { borderColor: styles.card.borderColor }]}>
                        <Text style={styles.label}>{metadata}</Text>
                        {event.cause ? <Text style={styles.label}>{causes[event.cause]}</Text> : null}
                        {event.renewal ? (
                          <Text style={styles.label}>{event.renewal === "clear" ? "Clear selected before dispatch" : "Rewind selected before dispatch"}</Text>
                        ) : null}
                        <Text style={resultStyle}>{descriptions[event.reason]}</Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </>
  );
}
